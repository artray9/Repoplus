/**
 * Ежедневная синхронизация данных всех активных клиентов
 */
const { query }              = require('../db');
const { syncClientFacebook } = require('../services/facebook');
const { syncClientAmoCRM }   = require('../services/amocrm');

async function dailySync() {
  const clientsRes = await query('SELECT * FROM clients WHERE active = true');
  const clients    = clientsRes.rows;

  console.log('[SYNC] Starting sync for ' + clients.length + ' clients');
  var errors = [];

  for (var i = 0; i < clients.length; i++) {
    var client = clients[i];

    try { await syncClientFacebook(client); }
    catch (e) {
      console.error('[SYNC] FB error for ' + client.name + ':', e.message);
      errors.push({ client: client.name, source: 'facebook', error: e.message });
    }

    try { await syncClientAmoCRM(client); }
    catch (e) {
      console.error('[SYNC] AMO error for ' + client.name + ':', e.message);
      errors.push({ client: client.name, source: 'amocrm', error: e.message });
    }

    await new Promise(function(r) { setTimeout(r, 500); });
  }

  if (errors.length) {
    console.error('[SYNC] Errors:', JSON.stringify(errors));
  }

  console.log('[SYNC] Done. ' + errors.length + ' errors.');
  return { synced: clients.length, errors: errors };
}

module.exports = { dailySync: dailySync };
