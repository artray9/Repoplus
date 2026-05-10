/**
 * /api/users — управление пользователями (admin only)
 * Включает: список, создание, редактирование, удаление,
 * а также назначение доступа пользователя к клиентам (campaign access)
 */
const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/users — список всех пользователей (admin only)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT u.id, u.email, u.name, u.role, u.created_at,
        COALESCE(
          json_agg(
            json_build_object('client_id', ca.client_id, 'client_name', c.name)
          ) FILTER (WHERE ca.client_id IS NOT NULL),
          '[]'
        ) AS client_access
      FROM users u
      LEFT JOIN client_access ca ON ca.user_id = u.id
      LEFT JOIN clients c ON c.id = ca.client_id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    console.error('[USERS GET]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/users — создать пользователя (admin only)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { email, password, name, role = 'viewer' } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }
    const validRoles = ['admin', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Роль должна быть: admin или viewer' });
    }
    const hash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (email, password, name, role)
       VALUES ($1,$2,$3,$4)
       RETURNING id, email, name, role, created_at`,
      [email, hash, name || email, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email уже занят' });
    console.error('[USERS POST]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /api/users/:id — обновить (имя, роль, пароль)
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, role, password } = req.body;
    const updates = [];
    const params  = [];

    if (name) { params.push(name); updates.push(`name=$${params.length}`); }
    if (role) {
      const validRoles = ['admin', 'viewer', 'pending'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: 'Недопустимая роль' });
      }
      params.push(role); updates.push(`role=$${params.length}`);
    }
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      params.push(hash); updates.push(`password=$${params.length}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'Нечего обновлять' });

    params.push(req.params.id);
    const result = await query(
      `UPDATE users SET ${updates.join(',')} WHERE id=$${params.length}
       RETURNING id, email, name, role`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('[USERS PATCH]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /api/users/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    // Нельзя удалить самого себя
    if (req.params.id === req.user.userId) {
      return res.status(400).json({ error: 'Нельзя удалить себя' });
    }
    await query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[USERS DELETE]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Доступ пользователя к клиентам ──────────────────────────────

// GET /api/users/:id/access — список клиентов с доступом у пользователя
router.get('/:id/access', requireAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT ca.client_id, c.name AS client_name
       FROM client_access ca
       JOIN clients c ON c.id = ca.client_id
       WHERE ca.user_id = $1`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/users/:id/access — выдать доступ к клиенту
router.post('/:id/access', requireAdmin, async (req, res) => {
  try {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id обязателен' });
    await query(
      `INSERT INTO client_access (user_id, client_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, client_id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[USERS ACCESS POST]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /api/users/:id/access/:clientId — отозвать доступ
router.delete('/:id/access/:clientId', requireAdmin, async (req, res) => {
  try {
    await query(
      'DELETE FROM client_access WHERE user_id=$1 AND client_id=$2',
      [req.params.id, req.params.clientId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[USERS ACCESS DELETE]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
