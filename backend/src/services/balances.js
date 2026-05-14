/**
 * Сервис балансов рекламных кабинетов.
 *
 * Facebook Marketing API возвращает суммы в МИНОРНЫХ единицах (центах).
 * Делим на 100 для большинства валют. Исключения (JPY, KRW, VND) — без деления.
 *
 * Также вытягиваем next_bill_date, amount_spent, min_payment_amount —
 * чтобы показывать пользователю реальный billing-state, а не загадочные числа.
 */
const axios   = require('axios');
const { query } = require('../db');

const FB_BASE = 'https://graph.facebook.com/v20.0';
const TT_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

// Порог низкого баланса (USD), ниже которого — алерт
const LOW_BALANCE_THRESHOLD = parseFloat(process.env.LOW_BALANCE_THRESHOLD || '100');

// Валюты без минорных единиц (для FB сумм НЕ делим на 100)
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'XAF', 'XOF', 'BIF', 'DJF', 'GNF', 'KMF', 'RWF']);

function fromMinorUnits(value, currency) {
  const v = parseFloat(value) || 0;
  if (!currency || ZERO_DECIMAL_CURRENCIES.has(String(currency).toUpperCase())) return v;
  return v / 100;
}

async function getFacebookBalance(adAccountId, accessToken) {
  const accountId = adAccountId.startsWith('act_') ? adAccountId : ('act_' + adAccountId);
  const resp = await axios.get(`${FB_BASE}/${accountId}`, {
    params: {
      fields: [
        'balance',
        'currency',
        'spend_cap',
        'amount_spent',
        'account_status',
        'next_bill_date',
        'min_daily_budget',
        'funding_source_details',
      ].join(','),
      access_token: accessToken,
    },
  });
  const d = resp.data;
  if (d.error) throw new Error('FB Balance API: ' + d.error.message);

  const currency = d.currency || 'USD';
  return {
    balance:        fromMinorUnits(d.balance, currency),
    currency,
    spend_cap:      d.spend_cap && d.spend_cap !== '0' ? fromMinorUnits(d.spend_cap, currency) : null,
    amount_spent:   fromMinorUnits(d.amount_spent, currency),
    next_bill_date: d.next_bill_date || null,
    funding_source: d.funding_source_details ? (d.funding_source_details.display_string || '') : '',
    account_status: d.account_status || 0,
  };
}

async function getTikTokBalance(advertiserId, accessToken) {
  // /advertiser/info/ требует Ads Management scope. Если не доступен — возвращаем nulls,
  // фронт покажет "n/a" (баланс), но клиент будет создан и метрики тянуться.
  try {
    const resp = await axios.get(`${TT_BASE}/advertiser/info/`, {
      headers: { 'Access-Token': accessToken },
      params:  { advertiser_ids: JSON.stringify([String(advertiserId)]) },
    });
    if (resp.data && resp.data.code === 0) {
      const info = (resp.data.data && resp.data.data.list && resp.data.data.list[0]) || {};
      return {
        balance:   parseFloat(info.balance)  || 0,
        currency:  info.currency             || 'USD',
        spend_cap: null,
      };
    }
    console.warn('[TT BAL]', resp.data && resp.data.message);
  } catch(e) {
    console.warn('[TT BAL]', (e.response && e.response.data && e.response.data.message) || e.message);
  }
  // Fallback: no balance info available (no scope)
  return { balance: 0, currency: 'USD', spend_cap: null, scope_error: true };
}

async function syncClientBalances(client) {
  const results = [];
  let sendBudgetAlert;
  try { ({ sendBudgetAlert } = require('./telegram')); }
  catch(e) { sendBudgetAlert = null; }

  // ── Facebook ─────────────────────────────────────────────────
  if (client.fb_account_id) {
    try {
      const tokenRes = await query(
        'SELECT access_token FROM integration_tokens WHERE client_id=$1 AND source=$2',
        [client.id, 'facebook']
      );
      if (tokenRes.rows.length) {
        const bal = await getFacebookBalance(client.fb_account_id, tokenRes.rows[0].access_token);
        const extra = {
          funding_source: bal.funding_source || null,
          account_status: bal.account_status || 0,
        };
        await query(
          `INSERT INTO account_balances
             (client_id, source, balance, currency, spend_cap, amount_spent, next_bill_date, extra, fetched_at)
           VALUES ($1,'facebook',$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (client_id, source) DO UPDATE SET
             balance=$2, currency=$3, spend_cap=$4, amount_spent=$5,
             next_bill_date=$6, extra=$7, fetched_at=NOW()`,
          [client.id, bal.balance, bal.currency, bal.spend_cap, bal.amount_spent, bal.next_bill_date, JSON.stringify(extra)]
        );
        results.push({ source: 'facebook', balance: bal.balance, currency: bal.currency });
        console.log(`[BAL] ${client.name} FB: ${bal.balance} ${bal.currency} (cap=${bal.spend_cap} spent=${bal.amount_spent})`);

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
        if (!bal.scope_error) {
          await query(
            `INSERT INTO account_balances
               (client_id, source, balance, currency, spend_cap, fetched_at)
             VALUES ($1,'tiktok',$2,$3,$4,NOW())
             ON CONFLICT (client_id, source) DO UPDATE SET
               balance=$2, currency=$3, spend_cap=$4, fetched_at=NOW()`,
            [client.id, bal.balance, bal.currency, bal.spend_cap]
          );
          results.push({ source: 'tiktok', balance: bal.balance, currency: bal.currency });
          console.log(`[BAL] ${client.name} TT: ${bal.balance} ${bal.currency}`);

          if (sendBudgetAlert && bal.balance < LOW_BALANCE_THRESHOLD) {
            sendBudgetAlert(client.name, 'TikTok', bal.balance, bal.currency)
              .catch(e => console.error('[BAL] TG alert TT:', e.message));
          }
        } else {
          console.log(`[BAL] ${client.name} TT: scope error, skipping`);
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
