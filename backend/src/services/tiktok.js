/**
 * TikTok Marketing API v1.3 — сервис выгрузки
 */
const axios  = require('axios');
const { query } = require('../db');
const { decrypt } = require('../lib/crypto');

const TT_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

async function fetchTikTokInsights(advertiserId, accessToken, dateFrom, dateTo) {
  const url = `${TT_BASE}/report/integrated/get/`;
  const rows = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const resp = await axios.post(url, {
      advertiser_id:  advertiserId,
      report_type:    'BASIC',
      data_level:     'AUCTION_CAMPAIGN',
      dimensions:     ['campaign_id', 'stat_time_day'],
      metrics:        ['campaign_name', 'spend', 'impressions', 'clicks', 'ctr', 'cpm',
                       'result', 'result_rate', 'cost_per_result'],
      start_date:     dateFrom,
      end_date:       dateTo,
      page_size:      1000,
      page:           page,
    }, {
      headers: { 'Access-Token': accessToken },
    });

    const data = resp.data;
    if (data.code !== 0) throw new Error('TikTok API: ' + data.message);

    const list = data.data?.list || [];
    list.forEach(item => {
      const m = item.metrics   || {};
      const d = item.dimensions || {};
      rows.push({
        campaign_id:   d.campaign_id   || 'unknown',
        campaign_name: m.campaign_name || d.campaign_id || 'Unknown',
        date:          (d.stat_time_day || '').slice(0, 10),
        spend:         parseFloat(m.spend)       || 0,
        impressions:   parseInt(m.impressions)   || 0,
        clicks:        parseInt(m.clicks)        || 0,
        ctr:           parseFloat(m.ctr)         || 0,
        cpm:           parseFloat(m.cpm)         || 0,
        leads:         parseInt(m.result)        || 0,
        conversions:   parseInt(m.result)        || 0,
      });
    });

    const pageInfo = data.data?.page_info || {};
    hasMore = page < Math.ceil((pageInfo.total_number || 0) / 1000);
    page++;
  }
  return rows;
}

async function syncClientTikTok(client, dateFrom, dateTo) {
  if (!client.tt_account_id) return 0;

  const tokenRes = await query(
    'SELECT access_token FROM integration_tokens WHERE client_id=$1 AND source=$2',
    [client.id, 'tiktok']
  );
  if (!tokenRes.rows.length) {
    console.warn('[TT] No token for client ' + client.name);
    return 0;
  }
  const token = decrypt(tokenRes.rows[0].access_token);

  if (!dateFrom || !dateTo) {
    const today = new Date();
    const from  = new Date(today);
    from.setDate(today.getDate() - 2);
    dateFrom = from.toISOString().slice(0, 10);
    dateTo   = today.toISOString().slice(0, 10);
  }

  console.log('[TT] Syncing ' + client.name + ' ' + dateFrom + '-' + dateTo);
  const rows = await fetchTikTokInsights(client.tt_account_id, token, dateFrom, dateTo);

  for (const r of rows) {
    const cpl = r.leads > 0 ? r.spend / r.leads : 0;
    await query(
      `INSERT INTO ad_metrics
        (client_id, source, date, campaign_id, campaign_name, impressions, clicks, spend, leads, conversions, ctr, cpm, cpl)
       VALUES ($1,'tiktok',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (client_id, source, date, campaign_id) DO UPDATE SET
         impressions=$5, clicks=$6, spend=$7, leads=$8, conversions=$9, ctr=$10, cpm=$11,
         cpl=CASE WHEN $8::numeric>0 THEN $7::numeric/$8::numeric ELSE 0 END`,
      [client.id, r.date, r.campaign_id, r.campaign_name,
       r.impressions, r.clicks, r.spend, r.leads, r.conversions, r.ctr, r.cpm, cpl]
    );
  }
  console.log('[TT] ' + client.name + ': ' + rows.length + ' rows upserted');
  return rows.length;
}

async function getTikTokBalance(advertiserId, accessToken) {
  const resp = await axios.get(`${TT_BASE}/advertiser/info/`, {
    headers: { 'Access-Token': accessToken },
    params:  { advertiser_ids: JSON.stringify([advertiserId]) },
  });
  const data = resp.data;
  if (data.code !== 0) throw new Error('TikTok Balance API: ' + data.message);
  const info = data.data?.list?.[0] || {};
  return {
    balance:  parseFloat(info.balance)  || 0,
    currency: info.currency || 'USD',
  };
}

module.exports = { syncClientTikTok, fetchTikTokInsights, getTikTokBalance };
