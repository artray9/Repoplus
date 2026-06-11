/**
 * Разовая дошифровка существующих plaintext-токенов в БД.
 *
 * Запуск (с заданными DATABASE_URL и TOKEN_ENC_KEY):
 *   node src/db/encrypt-existing.js
 *
 * Идемпотентно: уже зашифрованные значения (префикс enc:v1:) пропускаются,
 * поэтому повторный запуск безопасен.
 */
require('dotenv').config();
const { query, pool } = require('./index');
const { encrypt, isEncrypted } = require('../lib/crypto');

async function backfillTable(table, cols) {
  const res = await query(`SELECT id, ${cols.join(', ')} FROM ${table}`);
  let updated = 0;
  for (const row of res.rows) {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const c of cols) {
      if (row[c] != null && !isEncrypted(row[c])) {
        sets.push(`${c}=$${i++}`);
        vals.push(encrypt(row[c]));
      }
    }
    if (sets.length) {
      vals.push(row.id);
      await query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id=$${i}`, vals);
      updated++;
    }
  }
  console.log(`[BACKFILL] ${table}: зашифровано строк ${updated}/${res.rows.length}`);
}

(async () => {
  if (!process.env.TOKEN_ENC_KEY) {
    console.error('[BACKFILL] TOKEN_ENC_KEY не задан — нечего шифровать. Прерываю.');
    process.exit(1);
  }
  try {
    await backfillTable('integration_tokens', ['access_token', 'refresh_token']);
    await backfillTable('user_oauth_tokens',  ['access_token', 'refresh_token']);
    await backfillTable('api_keys',           ['access_token']);
    console.log('[BACKFILL] Готово.');
  } catch (e) {
    console.error('[BACKFILL] Ошибка:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
