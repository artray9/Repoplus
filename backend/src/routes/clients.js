const express  = require('express');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase();

function isSuperAdmin(email) {
  if (!SUPER_ADMIN_EMAIL) return false;
  return SUPER_ADMIN_EMAIL.split(',').map(e => e.trim()).includes((email || '').toLowerCase());
}

const TOKEN_EXISTS = (source) =>
  `EXISTS(SELECT 1 FROM integration_tokens it WHERE it.client_id=c.id AND it.source='${source}') AS has_${source}_token`;

// GET /api/clients
router.get('/', async (req, res) => {
  try {
    const role      = req.user.role;
    const userId    = req.user.userId;
    const userEmail = req.user.email;
    const superAdmin = isSuperAdmin(userEmail) || role === 'superadmin';

    let sql, params;

    if (superAdmin) {
      // Суперадмин видит всех
      sql = `SELECT c.*, ${TOKEN_EXISTS('facebook')}, ${TOKEN_EXISTS('tiktok')}, ${TOKEN_EXISTS('google')}
             FROM clients c ORDER BY c.name`;
      params = [];
    } else if (role === 'admin') {
      // Обычный admin видит только своих клиентов (owner_id = his id)
      sql = `SELECT c.*, ${TOKEN_EXISTS('facebook')}, ${TOKEN_EXISTS('tiktok')}, ${TOKEN_EXISTS('google')}
             FROM clients c
             WHERE c.owner_id = $1 OR c.owner_id IS NULL
             ORDER BY c.name`;
      params = [userId];
    } else {
      // Viewer видит только клиентов через client_access
      sql = `SELECT c.*, ${TOKEN_EXISTS('facebook')}, ${TOKEN_EXISTS('tiktok')}, ${TOKEN_EXISTS('google')}
             FROM clients c
             JOIN client_access ca ON ca.client_id = c.id AND ca.user_id = $1
             ORDER BY c.name`;
      params = [userId];
    }

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) {
    console.error('[CLIENTS GET]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/clients
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, fb_account_id, google_account_id, tt_account_id, amo_subdomain, google_manager_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Имя обязательно' });
    const result = await query(
      `INSERT INTO clients (name, fb_account_id, google_account_id, tt_account_id, amo_subdomain, google_manager_id, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, fb_account_id || null, google_account_id || null, tt_account_id || null,
       amo_subdomain || null, google_manager_id || null, req.user.userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('[CLIENTS POST]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /api/clients/:id
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, fb_account_id, google_account_id, tt_account_id, amo_subdomain, active, google_manager_id } = req.body;
    const result = await query(
      `UPDATE clients SET
        name              = COALESCE($1, name),
        fb_account_id     = COALESCE($2, fb_account_id),
        google_account_id = COALESCE($3, google_account_id),
        tt_account_id     = COALESCE($4, tt_account_id),
        amo_subdomain     = COALESCE($5, amo_subdomain),
        active            = COALESCE($6, active),
        google_manager_id = COALESCE($7, google_manager_id)
       WHERE id = $8 RETURNING *`,
      [name, fb_account_id, google_account_id, tt_account_id, amo_subdomain, active, google_manager_id, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Клиент не найден' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('[CLIENTS PATCH]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /api/clients/:id
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
