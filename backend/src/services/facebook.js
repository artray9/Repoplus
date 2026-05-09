/**
 * Facebook Marketing API v20.0 — сервис выгрузки
 *
 * Разграничение метрик:
 *   clicks           = inline_link_clicks  (реальные переходы на сайт / в LP)
 *   ctr              = inline_link_click_ctr (CTR по ссылке, не по всем кликам)
 *   leads            = сумма action_type-ов связанных с лидами/заявками
 *   conversions      = покупки + регистрации (отдельно от лидов)
 *   all_clicks       = clicks (все клики, включая реакции) — для аналитики
 */
const axios  = require('axios');
const { query } = require('../db');

const FB_API_VER = 'v20.0';
const FB_BASE    = `https://graph.facebook.com/${FB_API_VER}`;

// Поля кампании — разделяем трафик и лиды
const CAMPAIGN_FIELDS = [
  'campaign_id',
  'campaign_name',
  'date_start',
  'date_stop',
  'spend',
  'impressions',
  'reach',
  'frequency',
  // Реальные переходы на сайт (link clicks)
  'inline_link_clicks',
  'inline_link_click_ctr',
  // Все клики (включая реакции/комменты) — для справки
  'clicks',
  'ctr',
  // CPM и CPC
  'cpm',
  'cost_per_inline_link_click',
  // Конверсионные действия
  'actions',
  'action_values',
  'cost_per_action_type',
].join(',');

// Action types, которые считаем ЛИДАМИ (заявка/обращение)
const LEAD_ACTION_TYPES = new Set([
  'lead',
  'leadgen_grouped',
  'onsite_conversion.lead_grouped',
  'onsite_conversion.messaging_conversation_started_7d',
  'contact',
  'schedule',
  'submit_application',
  'start_trial',
  'subscribe',
  'find_location',
]);

// Action types, которые считаем ПОКУПКАМИ/конверсиями (отдельно от лидов)
const PURCHASE_ACTION_TYPES = new Set([
  'purchase',
  'omni_purchase',
  'offsite_conversion.fb_pixel_purchase',
  'complete_registration',
  'offsite_conversion.fb_pixel_complete_registration',
]);

function sumActions(actions, typeSet) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((sum, a) => {
    if (typeSet.has(a.action_type)) return sum + (parseInt(a.value, 10) || 0);
    return sum;
  }, 0);
}

function getActionValue(actions, typeSet) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((sum, a) => {
    if (typeSet.has(a.action_type)) return sum + (parseFloat(a.value) || 0);
    return sum;
  }, 0);
}

async function fetchCampaignInsights(accountId, accessToken, dateFrom, dateTo) {
  const url = `${FB_BASE}/act_${accountId}/insights`;
  const params = {
    access_token:   accessToken,
    fields:         CAMPAIGN_FIELDS,
    level:          'campaign',
    time_range:     JSON.stringify({ since: dateFrom, until: dateTo }),
    time_increment: 1,
    limit:          500,
  };

  const rows = [];
  let nextUrl = null;

  do {
    const resp = nextUrl
      ? await axios.get(nextUrl)
      : await axios.get(url, { params });

    const data = resp.data;
    if (data.error) throw new Error('FB API: ' + data.error.message);

    (data.data || []).forEach(row => {
      // ── Трафик ──────────────────────────────────────────────
      // inline_link_clicks = реальные клики по ссылке (переходы на сайт)
      // clicks             = все клики (включая лайки, комменты и т.д.) — НЕ используем как трафик
      const linkClicks = parseInt(row.inline_link_clicks, 10) || 0;
      const allClicks  = parseInt(row.clicks, 10) || 0;
      const linkCtr    = parseFloat(row.inline_link_click_ctr) || 0; // %
      const cpm        = parseFloat(row.cpm) || 0;
      const cpc        = parseFloat(row.cost_per_inline_link_click) || 0;

      // ── Лиды (заявки/обращения) ──────────────────────────────
      const leads       = sumActions(row.actions, LEAD_ACTION_TYPES);

      // ── Покупки/конверсии (отдельно) ─────────────────────────
      const conversions = sumActions(row.actions, PURCHASE_ACTION_TYPES);

      // ── Reach & Frequency ────────────────────────────────────
      const reach     = parseInt(row.reach, 10)     || 0;
      const frequency = parseFloat(row.frequency)   || 0;
      const spend     = parseFloat(row.spend)        || 0;
      const impr      = parseInt(row.impressions, 10) || 0;

      rows.push({
        campaign_id:   row.campaign_id,
        campaign_name: row.campaign_name,
        date:          row.date_start,
        impressions:   impr,
        reach,
        frequency,
        clicks:        linkClicks,   // ← реальные переходы на сайт
        all_clicks:    allClicks,    // ← все клики (для справки)
        spend,
        ctr:           linkCtr,      // ← CTR по ссылке (inline_link_click_ctr)
        cpm,
        cpc,
        leads,                       // ← лиды/заявки
        conversions,                 // ← покупки/регистрации
      });
    });

    nextUrl = (data.paging && data.paging.next) || null;
  } while (nextUrl);

  return rows;
}

async function syncClientFacebook(client, dateFrom, dateTo) {
  if (!client.fb_account_id) return 0;

  const tokenRes = await query(
    'SELECT access_token FROM integration_tokens WHERE client_id = $1 AND source = $2',
    [client.id, 'facebook']
  );
  if (!tokenRes.rows.length) {
    console.warn('[FB] No token for client ' + client.name);
    return 0;
  }

  const token = tokenRes.rows[0].access_token;

  if (!dateFrom || !dateTo) {
    const today = new Date();
    const from  = new Date(today);
    from.setDate(today.getDate() - 2);
    dateFrom = from.toISOString().slice(0, 10);
    dateTo   = today.toISOString().slice(0, 10);
  }

  console.log(`[FB] Syncing ${client.name} (act_${client.fb_account_id}) ${dateFrom}–${dateTo}`);
  const rows = await fetchCampaignInsights(client.fb_account_id, token, dateFrom, dateTo);

  let upserted = 0;
  for (const r of rows) {
    const cpl = r.leads > 0 ? r.spend / r.leads : 0;
    await query(
      `INSERT INTO ad_metrics
         (client_id, source, date, campaign_id, campaign_name,
          impressions, clicks, spend, leads, conversions, ctr, cpm, cpl)
       VALUES ($1,'facebook',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (client_id, source, date, campaign_id) DO UPDATE SET
         impressions=$5,
         clicks=$6,
         spend=$7,
         leads=$8,
         conversions=$9,
         ctr=$10,
         cpm=$11,
         cpl=CASE WHEN $8::numeric > 0 THEN $7::numeric / $8::numeric ELSE 0 END`,
      [client.id, r.date, r.campaign_id, r.campaign_name,
       r.impressions, r.clicks, r.spend, r.leads, r.conversions,
       r.ctr, r.cpm, cpl]
    );
    upserted++;
  }

  console.log(`[FB] ${client.name}: ${upserted} rows upserted (${rows.filter(r=>r.leads>0).length} with leads)`);
  return upserted;
}

async function checkTokenExpiry(accessToken) {
  try {
    const resp = await axios.get(`${FB_BASE}/debug_token`, {
      params: { input_token: accessToken, access_token: accessToken },
    });
    const data = resp.data && resp.data.data;
    if (!data) return null;
    return {
      isValid:   data.is_valid,
      expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : null,
      daysLeft:  data.expires_at
        ? Math.round((new Date(data.expires_at * 1000) - new Date()) / 86400000)
        : null,
    };
  } catch(e) {
    console.error('[FB] checkTokenExpiry:', e.message);
    return null;
  }
}

module.exports = { syncClientFacebook, fetchCampaignInsights, checkTokenExpiry };
