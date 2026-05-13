/**
 * /api/sources — листинг доступных рекламных кабинетов
 * после OAuth discovery (когда токен лежит в user_oauth_tokens).
 *
 * GET /api/sources/{facebook|google|tiktok}/accounts
 *   → [{ id, name, currency, status, already_connected: bool, existing_client_id }]
 */
const express = require('express');
const axios   = require('axios');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

async function getUserToken(userId, source) {
  const r = await query(
    'SELECT * FROM user_oauth_tokens WHERE user_id=$1 AND source=$2',
    [userId, source]
  );
  return r.rows[0] || null;
}

async function getExistingMap(userId, source, fieldName) {
  // Возвращает Map: ad_account_id → existing client_id (только для МОИХ клиентов)
  const r = await query(
    `SELECT id, ${fieldName} AS acc FROM clients WHERE owner_id=$1 AND ${fieldName} IS NOT NULL`,
    [userId]
  );
  const map = new Map();
  for (const row of r.rows) {
    if (row.acc) map.set(String(row.acc).replace(/-/g,'').replace(/^act_/, ''), row.id);
  }
  return map;
}

// ════════════════════ FACEBOOK ════════════════════
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
    const existing = await getExistingMap(req.user.userId, 'facebook', 'fb_account_id');
    const statusLabels = {
      1: 'Active', 2: 'Disabled', 3: 'Unsettled', 7: 'Pending Risk Review',
      8: 'Pending Settlement', 9: 'In Grace Period', 100: 'Pending Closure',
      101: 'Closed', 201: 'Any Active', 202: 'Any Closed',
    };
    const accounts = (r.data?.data || []).map(a => {
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
    console.error('[SOURCES FB]', e.response?.data || e.message);
    res.status(500).json({ error: 'Ошибка получения списка FB-кабинетов: ' + (e.response?.data?.error?.message || e.message) });
  }
});

// ════════════════════ GOOGLE ════════════════════
router.get('/google/accounts', requireAdmin, async (req, res) => {
  try {
    const tok = await getUserToken(req.user.userId, 'google');
    if (!tok || !tok.refresh_token) {
      return res.status(400).json({ error: 'Google не подключён. Нажмите «Подключить Google».' });
    }
    // Refresh access_token каждый раз
    const tr = await axios.post('https://oauth2.googleapis.com/token', {
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: tok.refresh_token,
      grant_type:    'refresh_token',
    });
    const accessToken = tr.data.access_token;
    const devToken    = process.env.GOOGLE_DEVELOPER_TOKEN || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';

    // 1) listAccessibleCustomers
    const listResp = await axios.get(
      'https://googleads.googleapis.com/v16/customers:listAccessibleCustomers',
      { headers: { Authorization: 'Bearer ' + accessToken, 'developer-token': devToken } }
    );
    const resourceNames = listResp.data.resourceNames || [];

    // 2) Для каждого — пытаемся получить descriptive_name и currency
    const existing = await getExistingMap(req.user.userId, 'google', 'google_account_id');
    const accounts = [];
    for (const rn of resourceNames) {
      const custId = rn.replace('customers/', '');
      let info = { name: 'Customer ' + custId, currency: '', manager: false };
      try {
        const cr = await axios.post(
          'https://googleads.googleapis.com/v16/customers/' + custId + '/googleAds:search',
          { query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1' },
          { headers: {
              Authorization:       'Bearer ' + accessToken,
              'developer-token':   devToken,
              'login-customer-id': custId,
              'Content-Type':      'application/json',
            }
          }
        );
        const c = cr.data.results?.[0]?.customer;
        if (c) {
          info.name     = c.descriptiveName || ('Customer ' + custId);
          info.currency = c.currencyCode || '';
          info.manager  = !!c.manager;
        }
      } catch(e) {
        // permission denied / not direct → пробуем дальше
      }
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
    res.json({ source: 'google', accounts });
  } catch(e) {
    console.error('[SOURCES GOOGLE]', e.response?.data || e.message);
    res.status(500).json({ error: 'Ошибка получения списка Google-кабинетов: ' + (e.response?.data?.error?.message || e.message) });
  }
});

// ════════════════════ TIKTOK ════════════════════
router.get('/tiktok/accounts', requireAdmin, async (req, res) => {
  try {
    const tok = await getUserToken(req.user.userId, 'tiktok');
    if (!tok) return res.status(400).json({ error: 'TikTok не подключён. Нажмите «Подключить TikTok».' });

    let ids = [];
    try { ids = (tok.extra && JSON.parse(typeof tok.extra === 'string' ? tok.extra : JSON.stringify(tok.extra))).advertiser_ids || []; }
    catch { ids = []; }

    if (!ids.length) {
      return res.status(400).json({ error: 'TikTok вернул пустой список кабинетов. Переподключите.' });
    }

    const info = await axios.get('https://business-api.tiktok.com/open_api/v1.3/advertiser/info/', {
      headers: { 'Access-Token': tok.access_token },
      params:  { advertiser_ids: JSON.stringify(ids.map(String)) },
    });
    if (info.data?.code !== 0) throw new Error(info.data?.message || 'TikTok API error');

    const existing = await getExistingMap(req.user.userId, 'tiktok', 'tt_account_id');
    const accounts = (info.data.data?.list || []).map(a => ({
      id:                 String(a.advertiser_id || a.id),
      name:               a.name || a.company_name || ('Advertiser ' + a.advertiser_id),
      currency:           a.currency || '',
      status:             a.status === 'STATUS_ENABLE' ? 'Active' : (a.status || ''),
      timezone:           a.timezone || '',
      already_connected:  existing.has(String(a.advertiser_id || a.id)),
      existing_client_id: existing.get(String(a.advertiser_id || a.id)) || null,
    }));
    res.json({ source: 'tiktok', accounts });
  } catch(e) {
    console.error('[SOURCES TT]', e.response?.data || e.message);
    res.status(500).json({ error: 'Ошибка получения списка TT-кабинетов: ' + (e.response?.data?.message || e.message) });
  }
});

// GET /api/sources/status — какие источники подключены у юзера (для UI)
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
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
