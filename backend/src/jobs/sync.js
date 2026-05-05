/**
 * Ежедневная синхронизация данных всех активных клиентов
 * Запускается по cron из index.js
 */
const { query }               = require('../db');
const { syncClientFacebook }  = require('../services/facebook');
const { syncClientAmoCRM }    = require('../services/amocrm');
// TODO: добавить google.js и tiktok.js
// const { syncClientGoogle }  = require('../services/google');
// const { syncClientTikTok }  = require('../services/tiktok');

async function dailySync() {
  const clientsRes = await query('SELECT * FROM clients WHERE active = true');
  const clients    = clientsRes.rows;

  console.log(`[SYNC] Starting sync for ${clients.length} clients`);
  const errors = [];

  for (const client of clients) {
    // Facebook
    try { await syncClientFacebook(client); }
    catch (e) { errors.push({ client: client.name, source: 'facebook', error: e.message }); }

    // amoCRM
    try { await syncClientAmoCRM(client); }
    catch (e) { errors.push({ client: client.name, source: 'amocrm', error: e.message }); }

    // Google Ads
    // try { await syncClientGoogle(client); }
    // catch (e) { errors.push({ client: client.name, source: 'google', error: e.message }); }

    // TikTok
    // try { await syncClientTikTok(client); }
    // catch (e) { errors.push({ client: client.name, source: 'tiktok', error: e.message }); }

    await sleep(500);  // пауза между клиентами
  }

  if (errors.length) {
    console.error('[SYNC] Errors:', JSON.stringify(errors, null, 2));
    // TODO: отправить в Telegram алерт
  }

  console.log(`[SYNC] Done. ${errors.length} errors.`);
  return { synced: clients.length, errors };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { dailySync };
