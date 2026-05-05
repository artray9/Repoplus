const express  = require('express');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/clients — список клиентов
router.get('/', async (req, res) => {
  try {
    const result = req.user.role === 'admin'
      ? await query('SELECT * FROM clients ORDER BY name')
      : await query('SELECT * FROM clients WHERE user_id = $1', [req.user.userId]);
    res.json(result.rows);
  } catch (e) {
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
      [name, fb_account_id, google_account_id, tt_account_id, amo_subdomain]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /api/clients/:id — обновить клиента (admin only)
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, fb_account_id, google_account_id, tt_account_id, amo_subdomain, active } = req.body;
    const result = await query(
      `UPDATE clients SET
        name = COALESCE($1, name),
        fb_account_id = COALESCE($2, fb_account_id),
        google_account_id = COALESCE($3, google_account_id),
        tt_account_id = COALESCE($4, tt_account_id),
        amo_subdomain = COALESCE($5, amo_subdomain),
        active = COALESCE($6, active)
       WHERE id = $7 RETURNING *`,
      [name, fb_account_id, google_account_id, tt_account_id, amo_subdomain, active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Клиент не найден' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /api/clients/:id (admin only)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
