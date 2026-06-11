/**
 * /api/settings — управление API-ключами агентства (multi-tenant)
 *   - superadmin   видит все ключи
 *   - admin        видит только СВОИ ключи (owner_id = userId)
 *   - все админы могут применять ТОЛЬКО свои ключи к СВОИМ клиентам
 */
const express   = require('express');
const { query } = require('../db');
const { encrypt, preview } = require('../lib/crypto');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(requireAdmin);

// Убирает токен из ответа, заменяя его безопасным превью.
function sanitizeKey(row) {
  const { access_token, ...rest } = row;
  return { ...rest, token_preview: preview(access_token) };
}

function ownerFilter(role, userId, paramIdx) {
  // superadmin → нет фильтра; admin → owner_id = userId (или NULL для legacy)
  if (role === 'superadmin') return { sql: '', params: [] };
  return { sql: ' WHERE owner_id = $' + paramIdx, params: [userId] };
}

// GET /api/settings/api-keys
router.get('/api-keys', async (req, res) => {
  try {
    const { role, userId } = req.user;
    let sql, params;
    if (role === 'superadmin') {
      sql = `SELECT id, name, source, expires_at, created_at, updated_at, owner_id,
             access_token
             FROM api_keys ORDER BY source, name`;
      params = [];
    } else {
      sql = `SELECT id, name, source, expires_at, created_at, updated_at, owner_id,
             access_token
             FROM api_keys WHERE owner_id = $1 ORDER BY source, name`;
      params = [userId];
    }
    const result = await query(sql, params);
    res.json(result.rows.map(sanitizeKey));
  } catch (e) {
    console.error('[SETTINGS GET]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/settings/api-keys — добавить ключ (owner_id = текущий юзер)
router.post('/api-keys', async (req, res) => {
  try {
    const { name, source, access_token, expires_at } = req.body;
    if (!name || !source || !access_token) {
      return res.status(400).json({ error: 'name, source и access_token обязательны' });
    }
    const result = await query(
      `INSERT INTO api_keys (name, source, access_token, expires_at, owner_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, name, source, expires_at, created_at, updated_at, owner_id, access_token`,
      [name, source, encrypt(access_token), expires_at || null, req.user.userId]
    );
    res.status(201).json(sanitizeKey(result.rows[0]));
  } catch (e) {
    console.error('[SETTINGS POST]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /api/settings/api-keys/:id
router.delete('/api-keys/:id', async (req, res) => {
  try {
    const { role, userId } = req.user;
    if (role === 'superadmin') {
      await query('DELETE FROM api_keys WHERE id = $1', [req.params.id]);
    } else {
      const r = await query(
        'DELETE FROM api_keys WHERE id = $1 AND owner_id = $2 RETURNING id',
        [req.params.id, userId]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Ключ не найден' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[SETTINGS DELETE]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/settings/apply-key — назначить ключ клиенту
router.post('/apply-key', async (req, res) => {
  try {
    const { api_key_id, client_id } = req.body;
    if (!api_key_id || !client_id) {
      return res.status(400).json({ error: 'api_key_id и client_id обязательны' });
    }
    const { role, userId } = req.user;

    // Проверка: ключ доступен мне?
    const keyRes = role === 'superadmin'
      ? await query('SELECT * FROM api_keys WHERE id = $1', [api_key_id])
      : await query('SELECT * FROM api_keys WHERE id = $1 AND owner_id = $2', [api_key_id, userId]);
    if (!keyRes.rows.length) return res.status(404).json({ error: 'Ключ не найден' });
    const key = keyRes.rows[0];

    // Проверка: клиент мой?
    const cliRes = role === 'superadmin'
      ? await query('SELECT id FROM clients WHERE id = $1', [client_id])
      : await query('SELECT id FROM clients WHERE id = $1 AND owner_id = $2', [client_id, userId]);
    if (!cliRes.rows.length) return res.status(404).json({ error: 'Клиент не найден' });

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
