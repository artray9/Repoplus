const express  = require('express');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/clients — список клиентов с токен-статусами для FB/TT/Google
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';

    // Viewer видит только клиентов к которым ему выдан доступ
    let sql, params;
    if (isAdmin) {
      sql = `
        SELECT c.*,
          EXISTS(SELECT 1 FROM integration_tokens it WHERE it.client_id=c.id AND it.source='facebook') AS has_fb_token,
          EXISTS(SELECT 1 FROM integration_tokens it WHERE it.client_id=c.id AND it.source='tiktok')   AS has_tt_token,
          EXISTS(SELECT 1 FROM integration_tokens it WHERE it.client_id=c.id AND it.source='google')   AS has_google_token
        FROM clients c
        ORDER BY c.name`;
      params = [];
    } else {
      sql = `
        SELECT c.*,
          EXISTS(SELECT 1 FROM integration_tokens it WHERE it.client_id=c.id AND it.source='facebook') AS has_fb_token,
          EXISTS(SELECT 1 FROM integration_tokens it WHERE it.client_id=c.id AND it.source='tiktok')   AS has_tt_token,
          EXISTS(SELECT 1 FROM integration_tokens it WHERE it.client_id=c.id AND it.source='google')   AS has_google_token
        FROM clients c
        JOIN client_access ca ON ca.client_id = c.id AND ca.user_id = $1
        ORDER BY c.name`;
      params = [req.user.userId];
    }

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) {
    console.error('[CLIENTS GET]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/clients — создать клиента (admin only)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, fb_account_id, google_account_id, tt_account_id, amo_subdomain } = req.body;
    if (!name) return res.status(400).json({ error: 'Имя обязательно' });
    const result = await query(
      `INSERT INTO clients (name, fb_account_id, google_account_id, tt_account_id, amo_subdomain)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, fb_account_id || null, google_account_id || null, tt_account_id || null, amo_subdomain || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('[CLIENTS POST]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /api/clients/:id — обновить клиента (admin only)
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, fb_account_id, google_account_id, tt_account_id, amo_subdomain, active } = req.body;
    const result = await query(
      `UPDATE clients SET
        name              = COALESCE($1, name),
        fb_account_id     = COALESCE($2, fb_account_id),
        google_account_id = COALESCE($3, google_account_id),
        tt_account_id     = COALESCE($4, tt_account_id),
        amo_subdomain     = COALESCE($5, amo_subdomain),
        active            = COALESCE($6, active)
       WHERE id = $7 RETURNING *`,
      [name, fb_account_id, google_account_id, tt_account_id, amo_subdomain, active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Клиент не найден' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('[CLIENTS PATCH]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /api/clients/:id (admin only)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[CLIENTS DELETE]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
