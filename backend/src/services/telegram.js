/**
 * Telegram Bot сервис — уведомления и рассылки для Repoplus
 */
const axios = require('axios');
const { query } = require('../db');

const TG_BASE = 'https://api.telegram.org/bot';

function tgApi(token, method, data) {
  return axios.post(`${TG_BASE}${token}/${method}`, data).then(r => r.data);
}

// Отправить сообщение в чат
async function sendMessage(botToken, chatId, text, parseMode = 'HTML') {
  return tgApi(botToken, 'sendMessage', {
    chat_id:    chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  });
}

// Получить имя бота (проверка токена)
async function getBotInfo(botToken) {
  const res = await tgApi(botToken, 'getMe', {});
  if (!res.ok) throw new Error('Невалидный токен бота');
  return res.result;
}

// Получить настройки Telegram из БД
async function getTelegramSettings() {
  const res = await query('SELECT * FROM telegram_settings LIMIT 1');
  return res.rows[0] || null;
}

// Получить всех подписчиков (чат-id + типы уведомлений)
async function getSubscribers(notificationType) {
  const res = await query(
    `SELECT ts.bot_token, sub.chat_id, sub.chat_name
     FROM telegram_subscriptions sub
     JOIN telegram_settings ts ON ts.id = sub.settings_id
     WHERE sub.active = true
       AND ($1 = ANY(sub.notification_types) OR 'all' = ANY(sub.notification_types))`,
    [notificationType]
  );
  return res.rows;
}

// ── Типы уведомлений ─────────────────────────────────────────

// Дневной отчёт — вызывается из cron
async function sendDailyReport(stats) {
  const subs = await getSubscribers('daily_report');
  if (!subs.length) return;

  const text = `📊 <b>Ежедневный отчёт Repoplus</b>\n` +
    `📅 ${new Date().toLocaleDateString('ru')}\n\n` +
    `💸 Расход: <b>$${parseFloat(stats.total_spend || 0).toFixed(2)}</b>\n` +
    `👥 Лиды: <b>${stats.total_leads || 0}</b>\n` +
    `💰 CPL: <b>$${parseFloat(stats.avg_cpl || 0).toFixed(2)}</b>\n` +
    `👁 Показы: <b>${Number(stats.total_imp || 0).toLocaleString('ru')}</b>\n` +
    `🖱 Клики: <b>${Number(stats.total_clicks || 0).toLocaleString('ru')}</b>`;

  for (const sub of subs) {
    try { await sendMessage(sub.bot_token, sub.chat_id, text); }
    catch (e) { console.error('[TG] daily_report send error:', e.message); }
  }
}

// Алерт — кончается бюджет
async function sendBudgetAlert(clientName, source, balance, currency) {
  const subs = await getSubscribers('budget_alert');
  if (!subs.length) return;

  const text = `⚠️ <b>Низкий баланс!</b>\n` +
    `Клиент: <b>${clientName}</b>\n` +
    `Источник: ${source}\n` +
    `Остаток: <b>${parseFloat(balance).toFixed(2)} ${currency}</b>`;

  for (const sub of subs) {
    try { await sendMessage(sub.bot_token, sub.chat_id, text); }
    catch (e) { console.error('[TG] budget_alert send error:', e.message); }
  }
}

// Алерт — высокий CPL
async function sendCplAlert(clientName, campaignName, cpl, source) {
  const subs = await getSubscribers('cpl_alert');
  if (!subs.length) return;

  const text = `🚨 <b>Высокий CPL!</b>\n` +
    `Клиент: <b>${clientName}</b>\n` +
    `Кампания: ${campaignName}\n` +
    `CPL: <b>$${parseFloat(cpl).toFixed(2)}</b> (${source})`;

  for (const sub of subs) {
    try { await sendMessage(sub.bot_token, sub.chat_id, text); }
    catch (e) { console.error('[TG] cpl_alert send error:', e.message); }
  }
}

// Ручная рассылка
async function sendBroadcast(message, notificationTypes) {
  const results = { sent: 0, failed: 0 };
  const cfg = await getTelegramSettings();
  if (!cfg) return results;

  const res = await query(
    `SELECT chat_id FROM telegram_subscriptions WHERE active = true AND settings_id = $1`,
    [cfg.id]
  );

  for (const sub of res.rows) {
    try {
      await sendMessage(cfg.bot_token, sub.chat_id, message);
      results.sent++;
    } catch (e) {
      results.failed++;
      console.error('[TG] broadcast error:', e.message);
    }
  }
  return results;
}

module.exports = {
  sendMessage, getBotInfo, getTelegramSettings,
  sendDailyReport, sendBudgetAlert, sendCplAlert, sendBroadcast,
};
