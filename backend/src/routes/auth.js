const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { query } = require('../db');

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://repoplus.kz';

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });

    const result = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });

    const accessToken = jwt.sign(
      { userId: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    const refreshToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      accessToken, refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
  } catch (e) {
    console.error('/login error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Токен не передан' });
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    const result  = await query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ accessToken });
  } catch (e) {
    res.status(401).json({ error: 'Невалидный refresh token' });
  }
});

// POST /api/auth/register — самостоятельная регистрация агентства
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
    if (password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });

    const hash = await bcrypt.hash(password, 12);
    const displayName = name || company || email;

    const result = await query(
      `INSERT INTO users (email, password, name, role)
       VALUES ($1,$2,$3,'admin') RETURNING id, email, name, role`,
      [email.toLowerCase(), hash, displayName]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email уже занят' });
    console.error('/register error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/auth/invite — создать приглашение (для admin)
router.post('/invite', async (req, res) => {
  try {
    // Проверяем JWT
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (!['admin', 'superadmin'].includes(decoded.role)) {
      return res.status(403).json({ error: 'Только для администратора' });
    }

    const { email, client_id, client_name } = req.body;
    if (!email || !client_id) return res.status(400).json({ error: 'email и client_id обязательны' });

    const token  = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 дней

    await query(
      `INSERT INTO invitations (token, email, client_id, client_name, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO UPDATE SET
         token=$1, client_id=$3, client_name=$4, invited_by=$5, expires_at=$6, used_at=NULL`,
      [token, email.toLowerCase(), client_id, client_name || '', decoded.userId, expires]
    );

    const inviteUrl = `${FRONTEND_URL}/invite.html?token=${token}`;
    res.json({ ok: true, inviteUrl, expiresAt: expires });
  } catch(e) {
    console.error('/invite error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /api/auth/invite/:token — проверить приглашение
router.get('/invite/:token', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM invitations WHERE token=$1 AND used_at IS NULL AND expires_at > NOW()`,
      [req.params.token]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Приглашение не найдено или устарело' });
    const inv = result.rows[0];
    res.json({ email: inv.email, client_name: inv.client_name, client_id: inv.client_id });
  } catch(e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/auth/invite/:token/accept — принять приглашение
router.post('/invite/:token/accept', async (req, res) => {
  try {
    const invRes = await query(
      `SELECT * FROM invitations WHERE token=$1 AND used_at IS NULL AND expires_at > NOW()`,
      [req.params.token]
    );
    if (!invRes.rows.length) return res.status(404).json({ error: 'Приглашение недействительно' });
    const inv = invRes.rows[0];

    const { name, password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });

    const hash = await bcrypt.hash(password, 12);

    // Создаём пользователя или обновляем если уже есть
    let userRes;
    const existing = await query('SELECT * FROM users WHERE email=$1', [inv.email]);
    if (existing.rows.length) {
      userRes = await query(
        `UPDATE users SET password=$1, name=COALESCE($2, name) WHERE email=$3 RETURNING id, email, name, role`,
        [hash, name || null, inv.email]
      );
    } else {
      userRes = await query(
        `INSERT INTO users (email, password, name, role) VALUES ($1,$2,$3,'viewer') RETURNING id, email, name, role`,
        [inv.email, hash, name || inv.email]
      );
    }

    const user = userRes.rows[0];

    // Даём доступ к клиенту
    await query(
      `INSERT INTO client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [user.id, inv.client_id]
    );

    // Помечаем инвайт как использованный
    await query(`UPDATE invitations SET used_at=NOW() WHERE token=$1`, [req.params.token]);

    // Выдаём токены
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    const refreshToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ accessToken, refreshToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch(e) {
    console.error('/invite/accept error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
