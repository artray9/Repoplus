const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query } = require('../db');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });

    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
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
      process.env.JWT_REFRESH_SECRET,
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
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
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

// POST /api/auth/register (только для первого admin — потом закрыть)
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role = 'client', adminSecret } = req.body;
    if (role === 'admin' && adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Нет доступа для создания admin' });
    }
    const hash = await bcrypt.hash(password, 12);
    const result = await query(
      'INSERT INTO users (email, password, name, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role',
      [email, hash, name, role]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email уже занят' });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
