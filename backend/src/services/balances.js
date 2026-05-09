/**
 * Сервис балансов рекламных кабинетов
 * Триггерит budget_alert если остаток < порога
 */
const axios  = require('axios');
const { query } = require('../db');

const FB_BASE = 'https://graph.facebook.com/v20.0';
const TT_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

// Порог низкого баланса (USD), ниже которого — алерт
const LOW_BALANCE_THRESHOLD = parseFloat(process.env.LOW_BALANCE_THRESHOLD || '100');

async function getFacebookBalance(adAccountId, accessToken) {
  const accountId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const resp = await axios.get(`${FB_BASE}/${accountId}`, {
    params: {
      fields:       'balance,currency,spend_cap,amount_spent,account_status',
      access_token: accessToken,
    },
  });
  const d = resp.data;
  if (d.error) throw new Error('FB Balance API: ' + d.error.message);
  return {
    balance:      parseFloat(d.balance)      || 0,
    currency:     d.currency                 || 'USD',
    spend_cap:    parseFloat(d.spend_cap)    || null,
    amount_spent: parseFloat(d.amount_spent) || 0,
  };
}

async function getTikTokBalance(advertiserId, accessToken) {
  const resp = await axios.get(`${TT_BASE}/advertiser/info/`, {
    headers: { 'Access-Token': accessToken },
    params:  { advertiser_ids: JSON.stringify([advertiserId]) },
  });
  const data = resp.data;
  if (data.code !== 0) throw new Error('TikTok Balance: ' + data.message);
  const info = data.data?.list?.[0] || {};
  return {
    balance:   parseFloat(info.balance)  || 0,
    currency:  info.currency             || 'USD',
    spend_cap: null,
  };
}

async function syncClientBalances(client) {
  const results = [];
  // Lazy import to avoid circular deps
  let sendBudgetAlert;
  try {
    ({ sendBudgetAlert } = require('./telegram'));
  } catch(e) { sendBudgetAlert = null; }

  // ── Facebook ─────────────────────────────────────────────────
  if (client.fb_account_id) {
    try {
      const tokenRes = await query(
        'SELECT access_token FROM integration_tokens WHERE client_id=$1 AND source=$2',
        [client.id, 'facebook']
      );
      if (tokenRes.rows.length) {
        const bal = await getFacebookBalance(client.fb_account_id, tokenRes.rows[0].access_token);
        await query(
          `INSERT INTO account_balances (client_id, source, balance, currency, spend_cap, fetched_at)
           VALUES ($1,'facebook',$2,$3,$4,NOW())
           ON CONFLICT (client_id, source)
           DO UPDATE SET balance=$2, currency=$3, spend_cap=$4, fetched_at=NOW()`,
          [client.id, bal.balance, bal.currency, bal.spend_cap]
        );
        results.push({ source: 'facebook', balance: bal.balance, currency: bal.currency });
        console.log(`[BAL] ${client.name} FB: ${bal.balance} ${bal.currency}`);

        // Budget alert
        if (sendBudgetAlert && bal.balance < LOW_BALANCE_THRESHOLD) {
          sendBudgetAlert(client.name, 'Facebook', bal.balance, bal.currency)
            .catch(e => console.error('[BAL] TG alert FB:', e.message));
        }
      }
    } catch (e) {
      console.error(`[BAL] ${client.name} FB error:`, e.message);
    }
  }

  // ── TikTok ───────────────────────────────────────────────────
  if (client.tt_account_id) {
    try {
      const tokenRes = await query(
        'SELECT access_token FROM integration_tokens WHERE client_id=$1 AND source=$2',
        [client.id, 'tiktok']
      );
      if (tokenRes.rows.length) {
        const bal = await getTikTokBalance(client.tt_account_id, tokenRes.rows[0].access_token);
        await query(
          `INSERT INTO account_balances (client_id, source, balance, currency, spend_cap, fetched_at)
           VALUES ($1,'tiktok',$2,$3,$4,NOW())
           ON CONFLICT (client_id, source)
           DO UPDATE SET balance=$2, currency=$3, spend_cap=$4, fetched_at=NOW()`,
          [client.id, bal.balance, bal.currency, bal.spend_cap]
        );
        results.push({ source: 'tiktok', balance: bal.balance, currency: bal.currency });
        console.log(`[BAL] ${client.name} TT: ${bal.balance} ${bal.currency}`);

        if (sendBudgetAlert && bal.balance < LOW_BALANCE_THRESHOLD) {
          sendBudgetAlert(client.name, 'TikTok', bal.balance, bal.currency)
            .catch(e => console.error('[BAL] TG alert TT:', e.message));
        }
      }
    } catch (e) {
      console.error(`[BAL] ${client.name} TT error:`, e.message);
    }
  }

  return results;
}

async function syncAllBalances() {
  const clientsRes = await query('SELECT * FROM clients WHERE active = true');
  for (const client of clientsRes.rows) {
    await syncClientBalances(client);
  }
}

module.exports = { syncAllBalances, syncClientBalances, getFacebookBalance, getTikTokBalance };
