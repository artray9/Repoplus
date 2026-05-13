/**
 * Ежедневная синхронизация данных всех активных клиентов.
 * После — Telegram отчёт + CPL-алерты.
 */
const { query }              = require('../db');
const { syncClientFacebook } = require('../services/facebook');
const { syncClientAmoCRM }   = require('../services/amocrm');
const { syncClientTikTok }   = require('../services/tiktok');
const { syncClientGoogle }   = require('../services/google');
const { syncClientBalances } = require('../services/balances');
const { sendDailyReport, sendCplAlert } = require('../services/telegram');

const CPL_ALERT_THRESHOLD = parseFloat(process.env.CPL_ALERT_THRESHOLD || '50');

/**
 * @param {string|null} [ownerId]  если задан — синкаем только клиентов этого admin.
 *                                  null/undefined → все активные клиенты (cron).
 */
async function dailySync(ownerId) {
  const clientsRes = ownerId
    ? await query('SELECT * FROM clients WHERE active = true AND owner_id = $1', [ownerId])
    : await query('SELECT * FROM clients WHERE active = true');
  const clients = clientsRes.rows;

  console.log('[SYNC] Starting sync for ' + clients.length + ' clients' + (ownerId ? ' (owner=' + ownerId + ')' : ''));
  const errors = [];

  for (const client of clients) {
    try { await syncClientFacebook(client); }
    catch (e) {
      console.error('[SYNC] FB error for ' + client.name + ':', e.message);
      errors.push({ client: client.name, source: 'facebook', error: e.message });
    }
    try { await syncClientTikTok(client); }
    catch (e) {
      console.error('[SYNC] TT error for ' + client.name + ':', e.message);
      errors.push({ client: client.name, source: 'tiktok', error: e.message });
    }
    try { await syncClientGoogle(client); }
    catch (e) {
      console.error('[SYNC] GOOGLE error for ' + client.name + ':', e.message);
      errors.push({ client: client.name, source: 'google', error: e.message });
    }
    try { await syncClientAmoCRM(client); }
    catch (e) {
      console.error('[SYNC] AMO error for ' + client.name + ':', e.message);
      errors.push({ client: client.name, source: 'amocrm', error: e.message });
    }
    try { await syncClientBalances(client); }
    catch (e) {
      console.error('[SYNC] BAL error for ' + client.name + ':', e.message);
      errors.push({ client: client.name, source: 'balances', error: e.message });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (errors.length) console.error('[SYNC] Errors:', JSON.stringify(errors));
  console.log('[SYNC] Done. ' + errors.length + ' errors.');

  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yDate = yesterday.toISOString().slice(0, 10);

    const kpiRes = await query(`
      SELECT
        SUM(spend)       AS total_spend,
        SUM(leads)       AS total_leads,
        SUM(conversions) AS total_conv,
        SUM(impressions) AS total_imp,
        SUM(clicks)      AS total_clicks,
        CASE WHEN SUM(leads) > 0 THEN SUM(spend)/SUM(leads) ELSE 0 END AS avg_cpl
      FROM ad_metrics WHERE date = $1
    `, [yDate]);

    const row = kpiRes.rows[0];
    const hasData = row && (
      parseFloat(row.total_spend || 0) > 0 ||
      parseInt(row.total_leads || 0)   > 0
    );
    if (hasData) {
      await sendDailyReport(row).catch(e =>
        console.error('[SYNC] TG daily report:', e.message)
      );
    } else {
      console.log('[SYNC] Skip daily report — no data for', yDate);
    }

    const highCplRes = await query(`
      SELECT m.campaign_name, m.source, m.cpl, c.name AS client_name
      FROM ad_metrics m
      JOIN clients c ON c.id = m.client_id
      WHERE m.date = $1
        AND m.cpl > $2
        AND m.leads > 0
      ORDER BY m.cpl DESC
      LIMIT 10
    `, [yDate, CPL_ALERT_THRESHOLD]);

    for (const r of highCplRes.rows) {
      await sendCplAlert(r.client_name, r.campaign_name, r.cpl, r.source)
        .catch(e => console.error('[SYNC] TG cpl alert:', e.message));
    }
  } catch (e) {
    console.error('[SYNC] TG notifications error:', e.message);
  }

  return { synced: clients.length, errors };
}

module.exports = { dailySync };
