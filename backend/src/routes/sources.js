/**
 * /api/sources — листинг доступных рекламных кабинетов после OAuth discovery.
 */
const express = require('express');
const axios   = require('axios');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Версии Google Ads API пробуем в порядке: v22 → v21 → v20 → v19 → v18 → v17.
// Первая что вернула 200 — используется.
const GOOGLE_API_VERSIONS = ['v22', 'v21', 'v20', 'v19', 'v18', 'v17'];

async function getUserToken(userId, source) {
  const r = await query(
    'SELECT * FROM user_oauth_tokens WHERE user_id=$1 AND source=$2',
    [userId, source]
  );
  return r.rows[0] || null;
}

async function getExistingMap(userId, fieldName) {
  const r = await query(
    'SELECT id, ' + fieldName + ' AS acc FROM clients WHERE owner_id=$1 AND ' + fieldName + ' IS NOT NULL',
    [userId]
  );
  const map = new Map();
  for (const row of r.rows) {
    if (row.acc) map.set(String(row.acc).replace(/-/g,'').replace(/^act_/, ''), row.id);
  }
  return map;
}

// ── Facebook
router.get('/facebook/accounts', requireAdmin, async (req, res) => {
  try {
    const tok = await getUserToken(req.user.userId, 'facebook');
    if (!tok) return res.status(400).json({ error: 'Facebook не подключён. Нажмите «Подключить Facebook».' });

    const r = await axios.get('https://graph.facebook.com/v20.0/me/adaccounts', {
      params: {
        access_token: tok.access_token,
        fields:       'account_id,name,currency,account_status,timezone_name,business_name',
        limit:        500,
      },
    });
    const existing = await getExistingMap(req.user.userId, 'fb_account_id');
    const statusLabels = {
      1: 'Active', 2: 'Disabled', 3: 'Unsettled', 7: 'Pending Risk Review',
      8: 'Pending Settlement', 9: 'In Grace Period', 100: 'Pending Closure',
      101: 'Closed', 201: 'Any Active', 202: 'Any Closed',
    };
    const accounts = ((r.data && r.data.data) || []).map(a => {
      const accId = String(a.account_id).replace(/^act_/, '');
      return {
        id:                  accId,
        name:                a.name || ('act_' + accId),
        currency:            a.currency || '',
        status:              statusLabels[a.account_status] || ('Status ' + a.account_status),
        business_name:       a.business_name || '',
        timezone:            a.timezone_name || '',
        already_connected:   existing.has(accId),
        existing_client_id:  existing.get(accId) || null,
      };
    });
    res.json({ source: 'facebook', accounts });
  } catch(e) {
    console.error('[SOURCES FB]', (e.response && e.response.data) || e.message);
    res.status(500).json({ error: 'Ошибка получения списка FB-кабинетов: ' +
      ((e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message) });
  }
});

// ── Google: пробуем версии API по очереди
async function googleListAccessible(accessToken, devToken) {
  let lastErr = null;
  for (const ver of GOOGLE_API_VERSIONS) {
    try {
      const r = await axios.get(
        'https://googleads.googleapis.com/' + ver + '/customers:listAccessibleCustomers',
        { headers: { Authorization: 'Bearer ' + accessToken, 'developer-token': devToken } }
      );
      return { version: ver, resourceNames: r.data.resourceNames || [] };
    } catch(e) {
      lastErr = e;
      const code = e.response && e.response.status;
      if (code !== 404 && code !== 400 && code !== 403) throw e;
      console.warn('[GOOGLE] ' + ver + ' returned ' + code + ', trying next');
    }
  }
  throw lastErr || new Error('All Google API versions failed');
}

router.get('/google/accounts', requireAdmin, async (req, res) => {
  try {
    const tok = await getUserToken(req.user.userId, 'google');
    if (!tok || !tok.refresh_token) {
      return res.status(400).json({ error: 'Google не подключён. Нажмите «Подключить Google».' });
    }
    const tr = await axios.post('https://oauth2.googleapis.com/token', {
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: tok.refresh_token,
      grant_type:    'refresh_token',
    });
    const accessToken = tr.data.access_token;
    const devToken    = process.env.GOOGLE_DEVELOPER_TOKEN || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
    if (!devToken) {
      return res.status(500).json({ error: 'GOOGLE_DEVELOPER_TOKEN не задан в env' });
    }

    const { version, resourceNames } = await googleListAccessible(accessToken, devToken);
    console.log('[GOOGLE] using API ' + version + ', accounts: ' + resourceNames.length);

    const existing = await getExistingMap(req.user.userId, 'google_account_id');
    const accounts = [];

    for (const rn of resourceNames) {
      const custId = rn.replace('customers/', '');
      let info = { name: 'Customer ' + custId, currency: '', manager: false };
      try {
        const cr = await axios.post(
          'https://googleads.googleapis.com/' + version + '/customers/' + custId + '/googleAds:search',
          { query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1' },
          { headers: {
              Authorization:       'Bearer ' + accessToken,
              'developer-token':   devToken,
              'login-customer-id': custId,
              'Content-Type':      'application/json',
            }
          }
        );
        const c = cr.data.results && cr.data.results[0] && cr.data.results[0].customer;
        if (c) {
          info.name     = c.descriptiveName || ('Customer ' + custId);
          info.currency = c.currencyCode || '';
          info.manager  = !!c.manager;
        }
      } catch(e) { /* пропускаем имя */ }
      accounts.push({
        id:                 custId,
        name:               info.name,
        currency:           info.currency,
        status:             info.manager ? 'Manager (MCC)' : 'Account',
        is_manager:         info.manager,
        already_connected:  existing.has(custId),
        existing_client_id: existing.get(custId) || null,
      });
    }
    res.json({ source: 'google', accounts, api_version: version });
  } catch(e) {
    const errMsg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message)
      || (e.response && e.response.data && (typeof e.response.data === 'string' ? e.response.data.slice(0, 200) : JSON.stringify(e.response.data).slice(0, 200)))
      || e.message;
    console.error('[SOURCES GOOGLE]', (e.response && e.response.data) || e.message);
    res.status(500).json({ error: 'Ошибка получения списка Google-кабинетов: ' + errMsg });
  }
});

// ── TikTok
router.get('/tiktok/accounts', requireAdmin, async (req, res) => {
  try {
    const tok = await getUserToken(req.user.userId, 'tiktok');
    if (!tok) return res.status(400).json({ error: 'TikTok не подключён. Нажмите «Подключить TikTok».' });

    let savedIds = [];
    try {
      const ex = typeof tok.extra === 'string' ? JSON.parse(tok.extra) : (tok.extra || {});
      savedIds = ex.advertiser_ids || [];
    } catch(e) {}

    const existing = await getExistingMap(req.user.userId, 'tt_account_id');
    let accounts = [];
    let warning = '';

    // /oauth2/advertiser/get/ — обычно НЕ требует extra scope
    try {
      const r = await axios.get('https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/', {
        params: {
          access_token: tok.access_token,
          secret:       process.env.TT_APP_SECRET,
          app_id:       process.env.TT_APP_ID,
        },
      });
      if (r.data && r.data.code === 0) {
        accounts = ((r.data.data && r.data.data.list) || []).map(a => {
          const id = String(a.advertiser_id);
          return {
            id,
            name:               a.advertiser_name || ('TikTok Advertiser ' + id),
            currency:           '',
            status:             '',
            already_connected:  existing.has(id),
            existing_client_id: existing.get(id) || null,
          };
        });
      } else {
        warning = (r.data && r.data.message) || '';
        console.warn('[TT] oauth2/advertiser/get returned:', warning);
      }
    } catch (e) {
      warning = (e.response && e.response.data && e.response.data.message) || e.message;
      console.warn('[TT] oauth2/advertiser/get failed:', warning);
    }

    // Fallback: ID без названий, из OAuth response (всегда работает)
    if (!accounts.length && savedIds.length) {
      accounts = savedIds.map(id => {
        const sid = String(id);
        return {
          id:                 sid,
          name:               'TikTok Advertiser ' + sid,
          currency:           '',
          status:             'no name (нужны permissions в TT App)',
          already_connected:  existing.has(sid),
          existing_client_id: existing.get(sid) || null,
        };
      });
    }

    if (!accounts.length) {
      return res.status(400).json({
        error: 'TikTok вернул пустой список кабинетов. ' +
               (warning ? 'Причина: ' + warning : 'Переподключите источник.')
      });
    }
    res.json({ source: 'tiktok', accounts, warning: warning || undefined });
  } catch(e) {
    console.error('[SOURCES TT]', (e.response && e.response.data) || e.message);
    res.status(500).json({ error: 'Ошибка получения TT-кабинетов: ' +
      ((e.response && e.response.data && e.response.data.message) || e.message) });
  }
});

// ── Status: какие источники подключены
router.get('/status', async (req, res) => {
  try {
    const r = await query(
      'SELECT source, expires_at FROM user_oauth_tokens WHERE user_id=$1',
      [req.user.userId]
    );
    const map = {};
    for (const row of r.rows) map[row.source] = { connected: true, expires_at: row.expires_at };
    res.json(map);
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});


// DELETE /api/sources/:source — отключает источник (удаляет user_oauth_tokens).
// Юзер потом проходит OAuth заново и получает свежий токен с актуальными scope.
router.delete('/:source', async (req, res) => {
  try {
    const { source } = req.params;
    if (!['facebook','google','tiktok'].includes(source)) {
      return res.status(400).json({ error: 'Неизвестный source' });
    }
    await query('DELETE FROM user_oauth_tokens WHERE user_id=$1 AND source=$2',
      [req.user.userId, source]);
    res.json({ ok: true, source });
  } catch(e) {
    res.status(500).json({ error: 'Ошибка отключения: ' + e.message });
  }
});


module.exports = router;
