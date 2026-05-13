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

// Хелпер: клиент принадлежит юзеру (или он superadmin)?
async function ownsClient(user, clientId) {
  if (user.role === 'superadmin') return true;
  const r = await query('SELECT owner_id FROM clients WHERE id = $1', [clientId]);
  if (!r.rows.length) return false;
  return r.rows[0].owner_id === user.userId;
}

// GET /api/clients
router.get('/', async (req, res) => {
  try {
    const role      = req.user.role;
    const userId    = req.user.userId;
    const userEmail = req.user.email;
    const superAdmin = isSuperAdmin(userEmail) || role === 'superadmin';

    let sql, params;

    if (superAdmin) {
      sql = `SELECT c.*, ${TOKEN_EXISTS('facebook')}, ${TOKEN_EXISTS('tiktok')}, ${TOKEN_EXISTS('google')}
             FROM clients c ORDER BY c.name`;
      params = [];
    } else if (role === 'admin') {
      // Multi-tenant: admin видит ТОЛЬКО своих клиентов.
      sql = `SELECT c.*, ${TOKEN_EXISTS('facebook')}, ${TOKEN_EXISTS('tiktok')}, ${TOKEN_EXISTS('google')}
             FROM clients c
             WHERE c.owner_id = $1
             ORDER BY c.name`;
      params = [userId];
    } else {
      // Viewer: только клиенты из client_access
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
    if (!(await ownsClient(req.user, req.params.id))) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }
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
    if (!(await ownsClient(req.user, req.params.id))) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }
    await query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[CLIENTS DELETE]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});


// POST /api/clients/bulk — массовое создание клиентов из выбранных рекламных кабинетов.
// Body: { source: 'facebook'|'google'|'tiktok', accounts: [{ id, name, currency?, manager_id? }, ...] }
// Использует user_oauth_tokens текущего юзера → сохраняет токен в integration_tokens на каждого нового клиента.
router.post('/bulk', requireAdmin, async (req, res) => {
  try {
    const { source, accounts } = req.body || {};
    if (!source || !Array.isArray(accounts) || !accounts.length) {
      return res.status(400).json({ error: 'source и accounts[] обязательны' });
    }
    const VALID = ['facebook', 'google', 'tiktok'];
    if (!VALID.includes(source)) return res.status(400).json({ error: 'Неизвестный source' });

    // Достаём мастер-токен юзера
    const tokRes = await query(
      'SELECT * FROM user_oauth_tokens WHERE user_id=$1 AND source=$2',
      [req.user.userId, source]
    );
    if (!tokRes.rows.length) return res.status(400).json({ error: 'Источник не подключён' });
    const tok = tokRes.rows[0];

    const created = [];
    const skipped = [];
    for (const acc of accounts) {
      const accId = String(acc.id || '').replace(/-/g,'').replace(/^act_/, '');
      if (!accId) { skipped.push({ id: acc.id, reason: 'invalid id' }); continue; }
      const name  = acc.name || ('Account ' + accId);

      // Колонки клиента в зависимости от источника
      const fields = {
        facebook: { col: 'fb_account_id'      },
        google:   { col: 'google_account_id'  },
        tiktok:   { col: 'tt_account_id'      },
      }[source];

      // Проверка дубликата ПО НАЛИЧИЮ ID у этого юзера
      const dup = await query(
        `SELECT id, name FROM clients WHERE owner_id=$1 AND ${fields.col}=$2`,
        [req.user.userId, accId]
      );
      if (dup.rows.length) {
        skipped.push({ id: accId, reason: 'already_connected', existing_client_id: dup.rows[0].id, existing_name: dup.rows[0].name });
        continue;
      }

      // Создаём клиента
      const ins = await query(
        `INSERT INTO clients (name, ${fields.col}, ${source === 'google' ? 'google_manager_id, ' : ''}owner_id)
         VALUES ($1, $2, ${source === 'google' ? '$3, $4' : '$3'}) RETURNING *`,
        source === 'google'
          ? [name, accId, acc.manager_id || null, req.user.userId]
          : [name, accId, req.user.userId]
      );
      const client = ins.rows[0];

      // Сохраняем токен в integration_tokens
      await query(
        `INSERT INTO integration_tokens (client_id, source, access_token, refresh_token, expires_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (client_id, source) DO UPDATE SET
           access_token=$3,
           refresh_token=COALESCE($4, integration_tokens.refresh_token),
           expires_at=$5, updated_at=NOW()`,
        [client.id, source, tok.access_token, tok.refresh_token, tok.expires_at]
      );

      created.push(client);
    }

    res.status(201).json({ created, skipped, source });
  } catch (e) {
    console.error('[CLIENTS BULK]', e.message);
    res.status(500).json({ error: 'Ошибка сервера: ' + e.message });
  }
});


module.exports = router;
module.exports.ownsClient = ownsClient;
