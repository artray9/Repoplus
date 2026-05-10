const express  = require('express');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

/**
 * GET /api/analytics
 * Query params:
 *   client_id  — UUID | 'all'
 *   from       — YYYY-MM-DD
 *   to         — YYYY-MM-DD
 *   source     — 'facebook' | 'google' | 'tiktok' | 'amocrm' | 'all'
 *   group_by   — 'day' | 'week' | 'campaign'  (default: 'day')
 */
router.get('/', async (req, res) => {
  try {
    const { client_id = 'all', from, to, source = 'all', group_by = 'day' } = req.query;
    const user = req.user;

    // Изоляция данных по ролям
    let allowedClientIds = null; // null = все (superadmin)

    if (user.role === 'viewer') {
      // Viewer видит только назначенных клиентов
      const accessRes = await query(
        'SELECT client_id FROM client_access WHERE user_id = $1', [user.userId]
      );
      allowedClientIds = accessRes.rows.map(r => r.client_id);
      if (!allowedClientIds.length) return res.json({ kpi: {}, timeseries: [], campaigns: [] });
    } else if (user.role === 'admin') {
      // Admin видит только своих клиентов
      const ownRes = await query(
        'SELECT id FROM clients WHERE owner_id = $1 OR owner_id IS NULL', [user.userId]
      );
      allowedClientIds = ownRes.rows.map(r => r.id);
      if (!allowedClientIds.length) return res.json({ kpi: {}, timeseries: [], campaigns: [] });
    }
    // superadmin: allowedClientIds = null → без ограничений

    const params = [];
    let where = ['1=1'];

    // Если указан конкретный client_id — проверяем доступ
    if (client_id !== 'all') {
      if (allowedClientIds && !allowedClientIds.includes(client_id)) {
        return res.json({ kpi: {}, timeseries: [], campaigns: [] });
      }
      params.push(client_id);
      where.push(`client_id = $${params.length}`);
    } else if (allowedClientIds) {
      // Фильтр по списку разрешённых клиентов
      params.push(allowedClientIds);
      where.push(`client_id = ANY($${params.length})`);
    }
    if (from) { params.push(from); where.push(`date >= $${params.length}`); }
    if (to)   { params.push(to);   where.push(`date <= $${params.length}`); }
    if (source !== 'all') { params.push(source); where.push(`source = $${params.length}`); }

    const whereStr = where.join(' AND ');

    // KPI summary
    const kpiRes = await query(`
      SELECT
        SUM(spend)       AS total_spend,
        SUM(leads)       AS total_leads,
        SUM(conversions) AS total_conv,
        SUM(impressions) AS total_imp,
        SUM(clicks)      AS total_clicks,
        CASE WHEN SUM(leads) > 0 THEN SUM(spend) / SUM(leads) ELSE 0 END AS avg_cpl,
        AVG(NULLIF(ctr,0)) AS avg_ctr,
        AVG(NULLIF(cpm,0)) AS avg_cpm
      FROM ad_metrics WHERE ${whereStr}
    `, params);

    // Timeseries (grouped by day)
    const tsRes = await query(`
      SELECT
        date,
        source,
        SUM(spend)       AS spend,
        SUM(leads)       AS leads,
        SUM(conversions) AS conversions,
        AVG(NULLIF(ctr,0)) AS avg_ctr
      FROM ad_metrics
      WHERE ${whereStr}
      GROUP BY date, source
      ORDER BY date ASC
    `, params);

    // Campaign breakdown
    const campRes = await query(`
      SELECT
        campaign_id, campaign_name, source,
        SUM(spend)       AS spend,
        SUM(impressions) AS impressions,
        SUM(clicks)      AS clicks,
        SUM(leads)       AS leads,
        SUM(conversions) AS conversions,
        AVG(NULLIF(ctr,0)) AS avg_ctr,
        AVG(NULLIF(cpm,0)) AS avg_cpm,
        CASE WHEN SUM(leads) > 0 THEN SUM(spend)/SUM(leads) ELSE 0 END AS cpl
      FROM ad_metrics
      WHERE ${whereStr}
      GROUP BY campaign_id, campaign_name, source
      ORDER BY spend DESC
      LIMIT 100
    `, params);

    res.json({
      kpi:        kpiRes.rows[0],
      timeseries: tsRes.rows,
      campaigns:  campRes.rows,
    });
  } catch (e) {
    console.error('/analytics error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /api/analytics/balances — балансы рекламных кабинетов
router.get('/balances', async (req, res) => {
  try {
    const user = req.user;
    let whereClause = '1=1';
    const params = [];

    if (user.role === 'viewer') {
      // Viewer видит только назначенных клиентов
      const accessRes = await query(
        'SELECT client_id FROM client_access WHERE user_id=$1', [user.userId]
      );
      const ids = accessRes.rows.map(r => r.client_id);
      if (!ids.length) return res.json([]);
      params.push(ids);
      whereClause = `ab.client_id = ANY($${params.length})`;
    } else if (user.role === 'admin') {
      // Admin видит только своих клиентов (owner_id)
      const ownRes = await query(
        'SELECT id FROM clients WHERE owner_id = $1 OR owner_id IS NULL', [user.userId]
      );
      const ids = ownRes.rows.map(r => r.id);
      if (!ids.length) return res.json([]);
      params.push(ids);
      whereClause = `ab.client_id = ANY($${params.length})`;
    }
    // superadmin: whereClause = '1=1' → видит всё

    const result = await query(`
      SELECT ab.client_id, c.name AS client_name,
             ab.source, ab.balance, ab.currency, ab.spend_cap, ab.fetched_at
      FROM account_balances ab
      JOIN clients c ON c.id = ab.client_id
      WHERE ${whereClause}
      ORDER BY c.name, ab.source
    `, params);

    res.json(result.rows);
  } catch (e) {
    console.error('/analytics/balances error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
