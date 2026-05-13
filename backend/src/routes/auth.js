const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const crypto    = require('crypto');
const axios     = require('axios');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');

const router = express.Router();

const FRONTEND_URL      = process.env.FRONTEND_URL || 'https://repoplus.kz';
const BACKEND_URL       = process.env.BACKEND_URL  || 'https://repoplus-production.up.railway.app';
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase();
// Открытая регистрация: новые юзеры сразу становятся admin своего тенанта.
// Если хотите вернуть pending-flow — поставьте ENV OPEN_SIGNUP=false
const OPEN_SIGNUP = (process.env.OPEN_SIGNUP || 'true').toLowerCase() !== 'false';

// Google login (отдельно от Google Ads OAuth)
const GOOGLE_LOGIN_CLIENT_ID     = process.env.GOOGLE_LOGIN_CLIENT_ID     || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_LOGIN_CLIENT_SECRET = process.env.GOOGLE_LOGIN_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Слишком много попыток входа. Подождите 15 минут.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Слишком много регистраций с этого IP.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function isSuperAdmin(email) {
  if (!SUPER_ADMIN_EMAIL) return false;
  return SUPER_ADMIN_EMAIL.split(',').map(e => e.trim()).includes((email || '').toLowerCase());
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

function pickUserRole() {
  // При открытой регистрации новый юзер — admin своего тенанта.
  // При закрытой — pending, ждёт активации.
  return OPEN_SIGNUP ? 'admin' : 'pending';
}

async function notifyNewUser(displayName, email) {
  const text =
    '🆕 Новая регистрация на Repoplus!\n' +
    '👤 ' + displayName + '\n📧 ' + email;
  let delivered = false;
  try {
    const { sendBroadcast } = require('../services/telegram');
    const r = await sendBroadcast(text).catch(() => null);
    delivered = !!(r && r.sent > 0);
  } catch(e) {}
  if (!delivered) {
    console.warn('=================================================');
    console.warn('[NEW USER] ', displayName, '<' + email + '>');
    console.warn('=================================================');
  }
}

// ── POST /api/auth/login ───────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });

    const result = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
    if (!user.password) {
      return res.status(401).json({ error: 'Этот email привязан к входу через Google — нажмите «Войти через Google»' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });

    if (user.role === 'pending') {
      return res.status(403).json({ error: 'Ваш аккаунт ожидает подтверждения' });
    }

    const { accessToken, refreshToken, role } = signTokens(user);
    res.json({ accessToken, refreshToken, user: { id: user.id, email: user.email, name: user.name, role } });
  } catch (e) {
    console.error('/login error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── POST /api/auth/refresh ─────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Токен не передан' });
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    const result  = await query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    if (user.role === 'pending') return res.status(403).json({ error: 'Аккаунт ожидает подтверждения' });
    const tokens = signTokens(user);
    res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
  } catch (e) {
    res.status(401).json({ error: 'Невалидный refresh token' });
  }
});

// ── POST /api/auth/register ────────────────────────────────────
// При OPEN_SIGNUP=true: создаём юзера-admin и сразу логиним.
// При OPEN_SIGNUP=false: создаём pending, ждём активации.
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
    if (password.length < 8)  return res.status(400).json({ error: 'Пароль минимум 8 символов' });

    const hash = await bcrypt.hash(password, 12);
    const displayName = name || company || email;
    const role = isSuperAdmin(email) ? 'admin' : pickUserRole();

    const ins = await query(
      `INSERT INTO users (email, password, name, role)
       VALUES ($1,$2,$3,$4) RETURNING id, email, name, role`,
      [email.toLowerCase(), hash, displayName, role]
    );
    const user = ins.rows[0];

    notifyNewUser(displayName, email).catch(() => {});

    if (role === 'pending') {
      return res.status(201).json({ user, pending: true });
    }

    // Auto-login для admin
    const { accessToken, refreshToken, role: r } = signTokens(user);
    res.status(201).json({
      accessToken, refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: r },
    });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email уже занят' });
    console.error('/register error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ──────────────────────────────────────────────────────────────
// Sign in with Google (OAuth user login)
// ──────────────────────────────────────────────────────────────

// GET /api/auth/google/init?next=/dashboard.html
router.get('/google/init', (req, res) => {
  if (!GOOGLE_LOGIN_CLIENT_ID) {
    return res.redirect(FRONTEND_URL + '/login.html?error=google_not_configured');
  }
  const next  = req.query.next || '/dashboard.html';
  const state = Buffer.from(JSON.stringify({ next, ts: Date.now() })).toString('base64url');
  const params = new URLSearchParams({
    client_id:     GOOGLE_LOGIN_CLIENT_ID,
    redirect_uri:  BACKEND_URL + '/api/auth/google/callback',
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'online',
    prompt:        'select_account',
    state,
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect(FRONTEND_URL + '/login.html?error=google_denied');

  try {
    // Получаем access_token + id_token
    const tokenResp = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     GOOGLE_LOGIN_CLIENT_ID,
      client_secret: GOOGLE_LOGIN_CLIENT_SECRET,
      redirect_uri:  BACKEND_URL + '/api/auth/google/callback',
      grant_type:    'authorization_code',
    });
    const { access_token, id_token } = tokenResp.data;

    // userinfo
    const userResp = await axios.get('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + access_token },
    });
    const profile = userResp.data;
    const email = (profile.email || '').toLowerCase();
    const name  = profile.name || profile.given_name || email;
    if (!email) throw new Error('No email from Google');
    if (profile.email_verified === false) throw new Error('Google email not verified');

    // Найти или создать юзера
    let user;
    const existing = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      user = existing.rows[0];
      // Если pending — активируем (open signup означает, что любой Google-юзер ok)
      if (user.role === 'pending' && OPEN_SIGNUP) {
        const upd = await query(
          `UPDATE users SET role='admin', name = COALESCE(name, $2) WHERE id = $1 RETURNING *`,
          [user.id, name]
        );
        user = upd.rows[0];
      }
    } else {
      const role = isSuperAdmin(email) ? 'admin' : pickUserRole();
      // password = NULL → юзер сможет логиниться только через Google
      const ins = await query(
        `INSERT INTO users (email, password, name, role)
         VALUES ($1, NULL, $2, $3) RETURNING *`,
        [email, name, role]
      );
      user = ins.rows[0];
      notifyNewUser(name, email).catch(() => {});
    }

    if (user.role === 'pending') {
      return res.redirect(FRONTEND_URL + '/login.html?error=pending_approval');
    }

    const tokens = signTokens(user);
    // Передаём токены через fragment (#) — фронт их подхватит, в логах не светятся.
    const frag = new URLSearchParams({
      access:  tokens.accessToken,
      refresh: tokens.refreshToken,
      uid:     user.id,
      email:   user.email,
      name:    user.name || '',
      role:    tokens.role,
    });
    res.redirect(FRONTEND_URL + '/auth-callback.html#' + frag.toString());
  } catch(e) {
    console.error('[GOOGLE LOGIN]', e.message);
    res.redirect(FRONTEND_URL + '/login.html?error=google_failed');
  }
});

// ──────────────────────────────────────────────────────────────
// Invitations (старый flow для viewer)
// ──────────────────────────────────────────────────────────────

router.post('/invite', async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
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

    const inviteUrl = FRONTEND_URL + '/invite.html?token=' + token;
    res.json({ ok: true, inviteUrl, expiresAt: expires });
  } catch(e) {
    console.error('/invite error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

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
