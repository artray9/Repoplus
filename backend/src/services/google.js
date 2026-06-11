/**
 * Google Ads REST API v22 — выгрузка кампаний.
 *
 * Multi-tenant: login-customer-id берётся ПО КЛИЕНТУ:
 *   - если у клиента есть MCC (clients.google_manager_id) → используем его
 *   - иначе используем customer_id самого кабинета (direct access)
 *
 * Developer token поддерживает оба имени env:
 *   GOOGLE_DEVELOPER_TOKEN или GOOGLE_ADS_DEVELOPER_TOKEN
 */
const axios  = require('axios');
const { query } = require('../db');
const { decrypt } = require('../lib/crypto');

const GOOGLE_ADS_BASE = 'https://googleads.googleapis.com/v22';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function getDeveloperToken() {
  return process.env.GOOGLE_DEVELOPER_TOKEN
      || process.env.GOOGLE_ADS_DEVELOPER_TOKEN
      || '';
}

async function refreshGoogleToken(refreshToken) {
  const resp = await axios.post(TOKEN_URL, {
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });
  return resp.data.access_token;
}

function buildHeaders(accessToken, loginCustomerId) {
  return {
    Authorization:       'Bearer ' + accessToken,
    'developer-token':   getDeveloperToken(),
    'login-customer-id': String(loginCustomerId || '').replace(/-/g, ''),
    'Content-Type':      'application/json',
  };
}

async function fetchGoogleInsights(customerId, loginCustomerId, accessToken, dateFrom, dateTo) {
  const cleanCustId = String(customerId).replace(/-/g, '');
  const cleanLogin  = String(loginCustomerId || customerId).replace(/-/g, '');

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
      `${GOOGLE_ADS_BASE}/customers/${cleanCustId}/googleAds:search`,
      body,
      { headers: buildHeaders(accessToken, cleanLogin) }
    );

    const data = resp.data;
    (data.results || []).forEach(r => {
      const spend = (parseInt(r.metrics?.costMicros) || 0) / 1_000_000;
      const leads = parseFloat(r.metrics?.conversions) || 0;
      const ctrRaw = parseFloat(r.metrics?.ctr) || 0;
      const ctr    = ctrRaw <= 1 ? ctrRaw * 100 : ctrRaw;
      const cpmRaw = parseFloat(r.metrics?.averageCpm) || 0;
      const cpm    = cpmRaw > 1000 ? cpmRaw / 1_000_000 : cpmRaw;
      rows.push({
        campaign_id:   String(r.campaign?.id || 'unknown'),
        campaign_name: r.campaign?.name || 'Unknown',
        date:          r.segments?.date || dateFrom,
        spend,
        impressions:   parseInt(r.metrics?.impressions) || 0,
        clicks:        parseInt(r.metrics?.clicks)      || 0,
        ctr, cpm,
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

  const tokenRes = await query(
    'SELECT access_token, refresh_token FROM integration_tokens WHERE client_id=$1 AND source=$2',
    [client.id, 'google']
  );
  if (!tokenRes.rows.length) {
    console.warn('[GOOGLE] No token for client ' + client.name);
    return 0;
  }

  const refresh_token = decrypt(tokenRes.rows[0].refresh_token);
  if (!refresh_token) {
    console.warn('[GOOGLE] No refresh_token for ' + client.name);
    return 0;
  }

  if (!dateFrom || !dateTo) {
    const today = new Date();
    const from  = new Date(today);
    from.setDate(today.getDate() - 2);
    dateFrom = from.toISOString().slice(0, 10);
    dateTo   = today.toISOString().slice(0, 10);
  }

  let accessToken;
  try {
    accessToken = await refreshGoogleToken(refresh_token);
  } catch (e) {
    console.error('[GOOGLE] Token refresh failed for ' + client.name + ':', e.message);
    return 0;
  }

  // MCC-id по клиенту; если нет — direct access (login = customer id)
  const loginCustomerId = client.google_manager_id || client.google_account_id;

  console.log('[GOOGLE] Syncing ' + client.name + ' cust=' + client.google_account_id +
              ' login=' + loginCustomerId + ' ' + dateFrom + '-' + dateTo);

  const rows = await fetchGoogleInsights(
    client.google_account_id, loginCustomerId, accessToken, dateFrom, dateTo
  );

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

async function getGoogleBalance(/* customerId, refreshToken */) {
  // Google Ads API не отдаёт баланс через GAQL — фронт показывает "n/a".
  return { balance: 0, currency: 'USD' };
}

module.exports = { syncClientGoogle, fetchGoogleInsights, getGoogleBalance, refreshGoogleToken };
