/**
 * /api/settings — управление глобальными API-ключами
 */
const express  = require('express');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(requireAdmin);

// GET /api/settings/api-keys — список всех ключей (token скрыт)
router.get('/api-keys', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, source, expires_at, created_at, updated_at,
        LEFT(access_token, 10) || '...' AS token_preview
       FROM api_keys ORDER BY source, name`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('[SETTINGS GET]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/settings/api-keys — добавить/обновить ключ
router.post('/api-keys', async (req, res) => {
  try {
    const { name, source, access_token, expires_at } = req.body;
    if (!name || !source || !access_token) {
      return res.status(400).json({ error: 'name, source и access_token обязательны' });
    }
    const result = await query(
      `INSERT INTO api_keys (name, source, access_token, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, name, source, expires_at, created_at, updated_at,
         LEFT(access_token, 10) || '...' AS token_preview`,
      [name, source, access_token, expires_at || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('[SETTINGS POST]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /api/settings/api-keys/:id
router.delete('/api-keys/:id', async (req, res) => {
  try {
    await query('DELETE FROM api_keys WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[SETTINGS DELETE]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/settings/apply-key — назначить api_key клиенту (копирует токен в integration_tokens)
router.post('/apply-key', async (req, res) => {
  try {
    const { api_key_id, client_id } = req.body;
    if (!api_key_id || !client_id) {
      return res.status(400).json({ error: 'api_key_id и client_id обязательны' });
    }
    const keyRes = await query('SELECT * FROM api_keys WHERE id = $1', [api_key_id]);
    if (!keyRes.rows.length) return res.status(404).json({ error: 'Ключ не найден' });
    const key = keyRes.rows[0];

    await query(
      `INSERT INTO integration_tokens (client_id, source, access_token, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (client_id, source)
       DO UPDATE SET access_token=$3, expires_at=$4, updated_at=NOW()`,
      [client_id, key.source, key.access_token, key.expires_at]
    );
    res.json({ ok: true, source: key.source });
  } catch (e) {
    console.error('[SETTINGS APPLY]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
