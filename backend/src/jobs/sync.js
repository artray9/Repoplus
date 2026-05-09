/**
 * Ежедневная синхронизация данных всех активных клиентов
 * После синхронизации — Telegram уведомления
 */
const { query }              = require('../db');
const { syncClientFacebook } = require('../services/facebook');
const { syncClientAmoCRM }   = require('../services/amocrm');
const { syncClientTikTok }   = require('../services/tiktok');
const { syncClientGoogle }   = require('../services/google');
const { syncClientBalances } = require('../services/balances');
const { sendDailyReport, sendCplAlert } = require('../services/telegram');

// Порог CPL для алерта (можно вынести в env)
const CPL_ALERT_THRESHOLD = parseFloat(process.env.CPL_ALERT_THRESHOLD || '50');

async function dailySync() {
  const clientsRes = await query('SELECT * FROM clients WHERE active = true');
  const clients    = clientsRes.rows;

  console.log(`[SYNC] Starting sync for ${clients.length} clients`);
  const errors = [];

  for (const client of clients) {
    try { await syncClientFacebook(client); }
    catch (e) {
      console.error(`[SYNC] FB error for ${client.name}:`, e.message);
      errors.push({ client: client.name, source: 'facebook', error: e.message });
    }

    try { await syncClientTikTok(client); }
    catch (e) {
      console.error(`[SYNC] TT error for ${client.name}:`, e.message);
      errors.push({ client: client.name, source: 'tiktok', error: e.message });
    }

    try { await syncClientGoogle(client); }
    catch (e) {
      console.error(`[SYNC] GOOGLE error for ${client.name}:`, e.message);
      errors.push({ client: client.name, source: 'google', error: e.message });
    }

    try { await syncClientAmoCRM(client); }
    catch (e) {
      console.error(`[SYNC] AMO error for ${client.name}:`, e.message);
      errors.push({ client: client.name, source: 'amocrm', error: e.message });
    }

    try { await syncClientBalances(client); }
    catch (e) {
      console.error(`[SYNC] BAL error for ${client.name}:`, e.message);
      errors.push({ client: client.name, source: 'balances', error: e.message });
    }

    await new Promise(r => setTimeout(r, 500));
  }

  if (errors.length) console.error('[SYNC] Errors:', JSON.stringify(errors));
  console.log(`[SYNC] Done. ${errors.length} errors.`);

  // ── Post-sync: Telegram уведомления ──────────────────────────
  try {
    // 1. Суммарный KPI за вчера → daily report
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

    if (kpiRes.rows[0] && parseFloat(kpiRes.rows[0].total_spend) > 0) {
      await sendDailyReport(kpiRes.rows[0]).catch(e =>
        console.error('[SYNC] TG daily report:', e.message)
      );
    }

    // 2. CPL алерты по кампаниям за вчера
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

    for (const row of highCplRes.rows) {
      await sendCplAlert(row.client_name, row.campaign_name, row.cpl, row.source)
        .catch(e => console.error('[SYNC] TG cpl alert:', e.message));
    }
  } catch (e) {
    console.error('[SYNC] TG notifications error:', e.message);
  }

  return { synced: clients.length, errors };
}

module.exports = { dailySync };
