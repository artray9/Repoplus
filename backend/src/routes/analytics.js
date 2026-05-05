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

    // Клиенты видят только свои данные
    let clientFilter = client_id;
    if (user.role === 'client') {
      const clientRes = await query('SELECT id FROM clients WHERE user_id = $1', [user.userId]);
      if (!clientRes.rows.length) return res.json({ kpi: {}, timeseries: [], campaigns: [] });
      clientFilter = clientRes.rows[0].id;
    }

    const params = [];
    let where = ['1=1'];

    if (clientFilter !== 'all') {
      params.push(clientFilter);
      where.push(`client_id = $${params.length}`);
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

module.exports = router;
