/**
 * amoCRM API v4 — сервис выгрузки лидов
 * Access token живёт 24ч → авторефреш через refresh_token
 * Docs: https://www.amocrm.ru/developers/content/crm_platform/leads-api
 */
const axios  = require('axios');
const { query } = require('../db');
const { encrypt, decrypt } = require('../lib/crypto');

// ── OAuth2 helpers ────────────────────────────────────────────

async function exchangeCode(subdomain, clientId, clientSecret, code, redirectUri) {
  const resp = await axios.post(`https://${subdomain}.amocrm.ru/oauth2/access_token`, {
    client_id: clientId, client_secret: clientSecret,
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
  });
  return resp.data; // { access_token, refresh_token, expires_in, ... }
}

async function refreshAccessToken(subdomain, clientId, clientSecret, refreshToken) {
  const resp = await axios.post(`https://${subdomain}.amocrm.ru/oauth2/access_token`, {
    client_id: clientId, client_secret: clientSecret,
    grant_type: 'refresh_token', refresh_token: refreshToken,
  });
  return resp.data; // { access_token, refresh_token, expires_in, ... }
}

/**
 * Получить рабочий access_token для клиента.
 * Если token истёк (или истекает через < 1ч) — обновляем через refresh_token
 * и сохраняем новую пару в БД.
 */
async function getValidToken(clientId) {
  const res = await query(
    `SELECT access_token, refresh_token, expires_at
     FROM integration_tokens
     WHERE client_id = $1 AND source = 'amocrm'`,
    [clientId]
  );
  if (!res.rows.length) return null;

  const row = res.rows[0];
  row.access_token  = decrypt(row.access_token);
  row.refresh_token = decrypt(row.refresh_token);

  // Если нет expires_at или токен живёт > 1ч — используем как есть
  if (!row.expires_at) return row.access_token;
  const expiresAt = new Date(row.expires_at);
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);

  if (expiresAt > oneHourFromNow) return row.access_token; // ещё живой

  // Нужно обновить
  if (!row.refresh_token) {
    console.warn('[AMO] Token expired, no refresh_token available');
    return null;
  }

  console.log('[AMO] Refreshing expired token...');
  try {
    const clientId_amo = process.env.AMO_CLIENT_ID;
    const clientSecret = process.env.AMO_CLIENT_SECRET;
    if (!clientId_amo || !clientSecret) {
      console.warn('[AMO] AMO_CLIENT_ID / AMO_CLIENT_SECRET not set — cannot refresh');
      return row.access_token; // попробуем старый
    }

    // Нужен subdomain — достаём из clients
    const clientRes = await query('SELECT amo_subdomain FROM clients WHERE id = $1', [clientId]);
    const subdomain = clientRes.rows[0]?.amo_subdomain;
    if (!subdomain) return null;

    const newTokens = await refreshAccessToken(subdomain, clientId_amo, clientSecret, row.refresh_token);

    const newExpires = new Date(Date.now() + (newTokens.expires_in || 86400) * 1000);
    await query(
      `UPDATE integration_tokens
       SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW()
       WHERE client_id=$4 AND source='amocrm'`,
      [encrypt(newTokens.access_token), encrypt(newTokens.refresh_token || row.refresh_token), newExpires, clientId]
    );
    console.log('[AMO] Token refreshed, new expires:', newExpires.toISOString());
    return newTokens.access_token;
  } catch(e) {
    console.error('[AMO] Token refresh failed:', e.message);
    return row.access_token; // fallback на старый
  }
}

// ── Выгрузка лидов ───────────────────────────────────────────

async function fetchLeads(subdomain, accessToken, dateFrom, dateTo) {
  const base    = `https://${subdomain}.amocrm.ru/api/v4`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  const fromTs  = Math.floor(new Date(dateFrom).getTime() / 1000);
  const toTs    = Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000);

  const leads = [];
  let page = 1;

  while (true) {
    let resp;
    try {
      resp = await axios.get(`${base}/leads`, {
        headers,
        params: {
          'filter[created_at][from]': fromTs,
          'filter[created_at][to]':   toTs,
          'with': 'contacts,tags',
          page,
          limit: 250,
        }
      });
    } catch(e) {
      // 401 = токен истёк, 204 = нет данных
      if (e.response?.status === 204 || e.response?.status === 401) break;
      throw e;
    }

    if (resp.status === 204) break;
    const items = resp.data?._embedded?.leads || [];
    if (!items.length) break;

    items.forEach(lead => {
      const fields   = lead.custom_fields_values || [];
      const getField = name => fields.find(f => f.field_name === name)?.values?.[0]?.value || null;
      leads.push({
        amo_lead_id:  String(lead.id),
        date:         new Date(lead.created_at * 1000).toISOString().slice(0, 10),
        status:       lead.status_id,
        pipeline:     lead.pipeline_id,
        price:        lead.price || 0,
        utm_source:   getField('utm_source'),
        utm_medium:   getField('utm_medium'),
        utm_campaign: getField('utm_campaign'),
      });
    });

    if (!resp.data?._links?.next) break;
    page++;
    await new Promise(r => setTimeout(r, 200)); // rate limit buffer
  }

  return leads;
}

// ── Синхронизация клиента ─────────────────────────────────────

async function syncClientAmoCRM(client, dateFrom, dateTo) {
  if (!client.amo_subdomain) return 0;

  const token = await getValidToken(client.id);
  if (!token) {
    console.warn(`[AMO] No valid token for ${client.name}`);
    return 0;
  }

  if (!dateFrom || !dateTo) {
    const today = new Date();
    const from  = new Date(today);
    from.setDate(today.getDate() - 2);
    dateFrom = from.toISOString().slice(0, 10);
    dateTo   = today.toISOString().slice(0, 10);
  }

  console.log(`[AMO] Syncing ${client.name} (${client.amo_subdomain}) ${dateFrom}–${dateTo}`);
  const leads = await fetchLeads(client.amo_subdomain, token, dateFrom, dateTo);

  let upserted = 0;
  for (const l of leads) {
    await query(
      `INSERT INTO crm_leads (client_id, amo_lead_id, date, status, pipeline, price, utm_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (client_id, amo_lead_id) DO UPDATE SET
         status=$4, price=$6, utm_source=$7`,
      [client.id, l.amo_lead_id, l.date, l.status, l.pipeline, l.price, l.utm_source]
    );
    upserted++;
  }

  console.log(`[AMO] ${client.name}: ${upserted} leads synced`);
  return upserted;
}

module.exports = { syncClientAmoCRM, fetchLeads, exchangeCode, refreshAccessToken, getValidToken };
