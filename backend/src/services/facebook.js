/**
 * Facebook Marketing API — сервис выгрузки
 * Аналог функций из autorun.gs, но на Node.js с прямым API
 */
const axios = require('axios');
const { query } = require('../db');

const FB_API_VER = 'v20.0';
const FB_BASE    = `https://graph.facebook.com/${FB_API_VER}`;

// Метрики кампаний которые запрашиваем
const CAMPAIGN_FIELDS = [
  'campaign_id', 'campaign_name', 'date_start', 'date_stop',
  'spend', 'impressions', 'clicks', 'ctr', 'cpm',
  'actions', 'action_values',
].join(',');

// Типы результатов лидогенерации (из вашего ANALYTICS скрипта)
const LEAD_RESULT_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'onsite_conversion.messaging_conversation_started_7d'];

/**
 * Вытащить данные кампаний за период для одного аккаунта
 * @param {string} accountId  — FB Ad Account ID (без "act_")
 * @param {string} accessToken
 * @param {string} dateFrom   — YYYY-MM-DD
 * @param {string} dateTo     — YYYY-MM-DD
 */
async function fetchCampaignInsights(accountId, accessToken, dateFrom, dateTo) {
  const url = `${FB_BASE}/act_${accountId}/insights`;
  const params = {
    access_token: accessToken,
    fields: CAMPAIGN_FIELDS,
    level: 'campaign',
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    time_increment: 1,   // по одному дню
    limit: 500,
  };

  const rows = [];
  let nextUrl = null;

  do {
    const resp = nextUrl
      ? await axios.get(nextUrl)
      : await axios.get(url, { params });

    const data = resp.data;
    if (data.error) throw new Error(`FB API: ${data.error.message}`);

    (data.data || []).forEach(row => {
      // Считаем лиды из actions
      let leads = 0;
      (row.actions || []).forEach(a => {
        if (LEAD_RESULT_TYPES.some(t => a.action_type === t || a.action_type.startsWith(t))) {
          leads += parseInt(a.value, 10) || 0;
        }
      });

      rows.push({
        campaign_id:   row.campaign_id,
        campaign_name: row.campaign_name,
        date:          row.date_start,
        impressions:   parseInt(row.impressions, 10) || 0,
        clicks:        parseInt(row.clicks, 10) || 0,
        spend:         parseFloat(row.spend) || 0,
        ctr:           parseFloat(row.ctr) || 0,
        cpm:           parseFloat(row.cpm) || 0,
        leads,
        conversions:   leads,   // для FB лиды = конверсии
      });
    });

    nextUrl = data.paging?.next || null;
  } while (nextUrl);

  return rows;
}

/**
 * Синхронизировать данные клиента за период → записать в БД
 */
async function syncClientFacebook(client) {
  if (!client.fb_account_id) return;

  // Получаем токен из БД
  const tokenRes = await query(
    'SELECT access_token FROM integration_tokens WHERE client_id = $1 AND source = $2',
    [client.id, 'facebook']
  );
  if (!tokenRes.rows.length) {
    console.warn(`[FB] No token for client ${client.name}`);
    return;
  }

  const token  = tokenRes.rows[0].access_token;
  const today  = new Date();
  const from   = new Date(today); from.setDate(today.getDate() - 2);  // вчера + позавчера для надёжности
  const dateFrom = from.toISOString().slice(0, 10);
  const dateTo   = today.toISOString().slice(0, 10);

  console.log(`[FB] Syncing ${client.name} (${client.fb_account_id}) ${dateFrom}–${dateTo}`);
  const rows = await fetchCampaignInsights(client.fb_account_id, token, dateFrom, dateTo);

  for (const r of rows) {
    await query(`
      INSERT INTO ad_metrics
        (client_id, source, date, campaign_id, campaign_name, impressions, clicks, spend, leads, conversions, ctr, cpm, cpl)
      VALUES ($1,'facebook',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (client_id, source, date, campaign_id)
      DO UPDATE SET
        impressions = EXCLUDED.impressions,
        clicks      = EXCLUDED.clicks,
        spend       = EXCLUDED.spend,
        leads       = EXCLUDED.leads,
        conversions = EXCLUDED.conversions,
        ctr         = EXCLUDED.ctr,
        cpm         = EXCLUDED.cpm,
        cpl         = CASE WHEN EXCLUDED.leads > 0 THEN EXCLUDED.spend / EXCLUDED.leads ELSE 0 END
    `, [
      client.id, r.date, r.campaign_id, r.campaign_name,
      r.impressions, r.clicks, r.spend, r.leads, r.conversions, r.ctr, r.cpm,
    ]);
  }

  console.log(`[FB] ${client.name}: ${rows.length} rows upserted`);
}

/**
 * Проверка срока действия токена
 */
async function checkTokenExpiry(accessToken) {
  const resp = await axios.get(`${FB_BASE}/debug_token`, {
    params: { input_token: accessToken, access_token: accessToken }
  });
  const data = resp.data?.data;
  if (!data) return null;
  return {
    isValid:   data.is_valid,
    expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : null,
    daysLeft:  data.expires_at
      ? Math.round((new Date(data.expires_at * 1000) - new Date()) / 86400000)
      : null,
  };
}

module.exports = { syncClientFacebook, fetchCampaignInsights, checkTokenExpiry };
