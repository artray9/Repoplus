/**
 * Google Ads REST API v16 — сервис выгрузки кампаний
 * Использует OAuth2 (refresh_token → access_token)
 */
const axios  = require('axios');
const { query } = require('../db');

const GOOGLE_ADS_BASE = 'https://googleads.googleapis.com/v16';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Обновляем access_token через refresh_token
async function refreshGoogleToken(refreshToken) {
  const resp = await axios.post(TOKEN_URL, {
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });
  return resp.data.access_token;
}

// Выгружаем кампании через GAQL
async function fetchGoogleInsights(customerId, accessToken, dateFrom, dateTo) {
  const cleanId = String(customerId).replace(/-/g, '');
  const gaql = `
    SELECT
      campaign.id,
      campaign.name,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.ctr,
      metrics.average_cpm,
      metrics.conversions
    FROM campaign
    WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date ASC
  `;

  const rows = [];
  let nextPageToken = null;

  do {
    const body = { query: gaql };
    if (nextPageToken) body.pageToken = nextPageToken;

    const resp = await axios.post(
      `${GOOGLE_ADS_BASE}/customers/${cleanId}/googleAds:search`,
      body,
      {
        headers: {
          Authorization:        `Bearer ${accessToken}`,
          'developer-token':    process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
          'login-customer-id':  process.env.GOOGLE_ADS_MANAGER_ID || '',
          'Content-Type':       'application/json',
        },
      }
    );

    const data = resp.data;
    (data.results || []).forEach(r => {
      const spend = (parseInt(r.metrics?.costMicros) || 0) / 1_000_000;
      const leads = parseInt(r.metrics?.conversions) || 0;
      rows.push({
        campaign_id:   String(r.campaign?.id || 'unknown'),
        campaign_name: r.campaign?.name || 'Unknown',
        date:          r.segments?.date || dateFrom,
        spend,
        impressions:   parseInt(r.metrics?.impressions)   || 0,
        clicks:        parseInt(r.metrics?.clicks)        || 0,
        ctr:           parseFloat(r.metrics?.ctr)         || 0,
        cpm:           parseFloat(r.metrics?.averageCpm)  || 0,
        leads,
        conversions:   leads,
      });
    });

    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);

  return rows;
}

async function syncClientGoogle(client, dateFrom, dateTo) {
  if (!client.google_account_id) return 0;

  // Получаем токен из БД
  const tokenRes = await query(
    'SELECT access_token, refresh_token FROM integration_tokens WHERE client_id=$1 AND source=$2',
    [client.id, 'google']
  );
  if (!tokenRes.rows.length) {
    console.warn('[GOOGLE] No token for client ' + client.name);
    return 0;
  }

  const { refresh_token } = tokenRes.rows[0];

  if (!dateFrom || !dateTo) {
    const today = new Date();
    const from  = new Date(today);
    from.setDate(today.getDate() - 2);
    dateFrom = from.toISOString().slice(0, 10);
    dateTo   = today.toISOString().slice(0, 10);
  }

  // Каждый раз обновляем access_token через refresh_token
  let accessToken;
  try {
    accessToken = await refreshGoogleToken(refresh_token);
  } catch (e) {
    console.error('[GOOGLE] Token refresh failed for ' + client.name + ':', e.message);
    return 0;
  }

  console.log('[GOOGLE] Syncing ' + client.name + ' ' + dateFrom + '-' + dateTo);
  const rows = await fetchGoogleInsights(client.google_account_id, accessToken, dateFrom, dateTo);

  for (const r of rows) {
    const cpl = r.leads > 0 ? r.spend / r.leads : 0;
    await query(
      `INSERT INTO ad_metrics
        (client_id, source, date, campaign_id, campaign_name, impressions, clicks, spend, leads, conversions, ctr, cpm, cpl)
       VALUES ($1,'google',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (client_id, source, date, campaign_id) DO UPDATE SET
         impressions=$5, clicks=$6, spend=$7, leads=$8, conversions=$9, ctr=$10, cpm=$11,
         cpl=CASE WHEN $8::numeric>0 THEN $7::numeric/$8::numeric ELSE 0 END`,
      [client.id, r.date, r.campaign_id, r.campaign_name,
       r.impressions, r.clicks, r.spend, r.leads, r.conversions, r.ctr, r.cpm, cpl]
    );
  }
  console.log('[GOOGLE] ' + client.name + ': ' + rows.length + ' rows upserted');
  return rows.length;
}

// Получить баланс Google Ads аккаунта
async function getGoogleBalance(customerId, refreshToken) {
  const accessToken = await refreshGoogleToken(refreshToken);
  const cleanId = String(customerId).replace(/-/g, '');

  const gaql = `
    SELECT customer.id, customer.descriptive_name,
           customer.currency_code
    FROM customer LIMIT 1
  `;

  const resp = await axios.post(
    `${GOOGLE_ADS_BASE}/customers/${cleanId}/googleAds:search`,
    { query: gaql },
    {
      headers: {
        Authorization:       `Bearer ${accessToken}`,
        'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': process.env.GOOGLE_ADS_MANAGER_ID || '',
      },
    }
  );

  const r = resp.data.results?.[0];
  return {
    balance:  0, // Google Ads не возвращает баланс напрямую через GAQL
    currency: r?.customer?.currencyCode || 'USD',
  };
}

module.exports = { syncClientGoogle, fetchGoogleInsights, getGoogleBalance };
