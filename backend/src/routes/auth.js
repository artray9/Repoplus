const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');

const router = express.Router();

const FRONTEND_URL     = process.env.FRONTEND_URL || 'https://repoplus.kz';
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase();

// ── Rate limiters ─────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 10,
  message: { error: 'Слишком много попыток входа. Подождите 15 минут.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 5,
  message: { error: 'Слишком много регистраций с этого IP.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Helpers ───────────────────────────────────────────────────────
function isSuperAdmin(email) {
  if (!SUPER_ADMIN_EMAIL) return false;
  return SUPER_ADMIN_EMAIL.split(',').map(e => e.trim()).includes(email.toLowerCase());
}

function signTokens(user) {
  const role = isSuperAdmin(user.email) ? 'superadmin' : user.role;
  const accessToken = jwt.sign(
    { userId: user.id, role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
  const refreshToken = jwt.sign(
    { userId: user.id },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
  return { accessToken, refreshToken, role };
}

// ── POST /api/auth/login ──────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });

    const result = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });

    if (user.role === 'pending') {
      return res.status(403).json({ error: 'Ваш аккаунт ожидает подтверждения. Мы свяжемся с вами в ближайшее время.' });
    }

    const { accessToken, refreshToken, role } = signTokens(user);
    res.json({ accessToken, refreshToken, user: { id: user.id, email: user.email, name: user.name, role } });
  } catch (e) {
    console.error('/login error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Токен не передан' });
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    const result  = await query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    const { accessToken, role } = signTokens(user);
    res.json({ accessToken });
  } catch (e) {
    res.status(401).json({ error: 'Невалидный refresh token' });
  }
});

// ── POST /api/auth/register ───────────────────────────────────────
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
    if (password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });

    const hash = await bcrypt.hash(password, 12);
    const displayName = name || company || email;

    // Если это superadmin email — сразу admin, иначе pending
    const role = isSuperAdmin(email) ? 'admin' : 'pending';

    const result = await query(
      `INSERT INTO users (email, password, name, role)
       VALUES ($1,$2,$3,$4) RETURNING id, email, name, role`,
      [email.toLowerCase(), hash, displayName, role]
    );

    // Уведомление в Telegram суперадмину
    try {
      const { sendBroadcast } = require('../services/telegram');
      await sendBroadcast(
        `🆕 Новая регистрация на Repoplus!\n👤 ${displayName}\n📧 ${email}\n\nОдобрите в разделе Пользователи → измените роль с pending на admin.`
      ).catch(() => {});
    } catch(e) {}

    res.status(201).json({ user: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email уже занят' });
    console.error('/register error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── POST /api/auth/invite ─────────────────────────────────────────
router.post('/invite', async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (!['admin', 'superadmin'].includes(decoded.role)) {
      return res.status(403).json({ error: 'Только для администратора' });
    }

    const { email, client_id, client_name } = req.body;
    if (!email || !client_id) return res.status(400).json({ error: 'email и client_id обязательны' });

    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

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

// ── GET /api/auth/invite/:token ───────────────────────────────────
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

// ── POST /api/auth/invite/:token/accept ──────────────────────────
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
    await query(`INSERT INTO client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, inv.client_id]);
    await query(`UPDATE invitations SET used_at=NOW() WHERE token=$1`, [req.params.token]);

    const { accessToken, refreshToken } = signTokens(user);
    res.json({ accessToken, refreshToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch(e) {
    console.error('/invite/accept error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
