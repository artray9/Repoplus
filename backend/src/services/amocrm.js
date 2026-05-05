/**
 * amoCRM API — сервис выгрузки лидов
 * Docs: https://www.amocrm.ru/developers/content/crm_platform/leads-api
 */
const axios  = require('axios');
const { query } = require('../db');

/**
 * Получить лиды за период
 * @param {string} subdomain   — например "myagency"
 * @param {string} accessToken
 * @param {string} dateFrom    — YYYY-MM-DD
 * @param {string} dateTo      — YYYY-MM-DD
 */
async function fetchLeads(subdomain, accessToken, dateFrom, dateTo) {
  const base   = `https://${subdomain}.amocrm.ru/api/v4`;
  const headers = { Authorization: `Bearer ${accessToken}` };

  const fromTs = Math.floor(new Date(dateFrom).getTime() / 1000);
  const toTs   = Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000);

  const leads = [];
  let page = 1;

  while (true) {
    const resp = await axios.get(`${base}/leads`, {
      headers,
      params: {
        'filter[created_at][from]': fromTs,
        'filter[created_at][to]':   toTs,
        'with': 'contacts,tags',
        page,
        limit: 250,
      }
    });

    if (resp.status === 204) break;  // нет данных
    const items = resp.data?._embedded?.leads || [];
    if (!items.length) break;

    items.forEach(lead => {
      // Достаём UTM метки из кастомных полей
      const fields = lead.custom_fields_values || [];
      const getField = name => fields.find(f => f.field_name === name)?.values?.[0]?.value || null;

      leads.push({
        amo_lead_id: String(lead.id),
        date:        new Date(lead.created_at * 1000).toISOString().slice(0,10),
        status:      lead.status_id,
        pipeline:    lead.pipeline_id,
        price:       lead.price || 0,
        utm_source:  getField('utm_source'),
        utm_medium:  getField('utm_medium'),
        utm_campaign:getField('utm_campaign'),
      });
    });

    // Проверяем есть ли следующая страница
    const nextLink = resp.data?._links?.next;
    if (!nextLink) break;
    page++;
  }

  return leads;
}

/**
 * Синхронизация лидов клиента → БД
 */
async function syncClientAmoCRM(client) {
  if (!client.amo_subdomain) return;

  const tokenRes = await query(
    'SELECT access_token FROM integration_tokens WHERE client_id = $1 AND source = $2',
    [client.id, 'amocrm']
  );
  if (!tokenRes.rows.length) return;

  const token  = tokenRes.rows[0].access_token;
  const today  = new Date();
  const from   = new Date(today); from.setDate(today.getDate() - 2);
  const dateFrom = from.toISOString().slice(0,10);
  const dateTo   = today.toISOString().slice(0,10);

  console.log(`[AMO] Syncing ${client.name} ${dateFrom}–${dateTo}`);
  const leads = await fetchLeads(client.amo_subdomain, token, dateFrom, dateTo);

  for (const l of leads) {
    await query(`
      INSERT INTO crm_leads (client_id, amo_lead_id, date, status, pipeline, price, utm_source)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING
    `, [client.id, l.amo_lead_id, l.date, l.status, l.pipeline, l.price, l.utm_source]);
  }

  console.log(`[AMO] ${client.name}: ${leads.length} leads upserted`);
}

/**
 * OAuth: обменять code на токен
 */
async function exchangeCode(subdomain, clientId, clientSecret, code, redirectUri) {
  const resp = await axios.post(`https://${subdomain}.amocrm.ru/oauth2/access_token`, {
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'authorization_code',
    code,
    redirect_uri:  redirectUri,
  });
  return resp.data;  // { access_token, refresh_token, expires_in, ... }
}

/**
 * Обновить access token по refresh token
 */
async function refreshAccessToken(subdomain, clientId, clientSecret, refreshToken) {
  const resp = await axios.post(`https://${subdomain}.amocrm.ru/oauth2/access_token`, {
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  });
  return resp.data;
}

module.exports = { syncClientAmoCRM, fetchLeads, exchangeCode, refreshAccessToken };
