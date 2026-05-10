/**
 * /api/telegram — настройки Telegram бота и управление подписчиками
 */
const express = require('express');
const axios   = require('axios');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { getBotInfo, sendMessage, sendBroadcast } = require('../services/telegram');

const router = express.Router();

const BACKEND_URL = process.env.BACKEND_URL || 'https://repoplus-production.up.railway.app';

// ── WEBHOOK (публичный — Telegram сюда POST-ит) ───────────────────
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // отвечаем сразу чтобы Telegram не ретраил

  try {
    const update  = req.body;
    const message = update?.message || update?.channel_post;
    if (!message) return;

    const chatId   = message.chat?.id;
    const chatType = message.chat?.type; // 'private', 'group', 'supergroup', 'channel'
    const text     = message.text || '';
    const from     = message.from;

    if (!chatId) return;

    // Получаем токен бота из БД
    const cfg = await query('SELECT bot_token FROM telegram_settings LIMIT 1');
    if (!cfg.rows.length) return;
    const botToken = cfg.rows[0].bot_token;

    if (text.startsWith('/start') || text.startsWith('/chatid') || text.startsWith('/id')) {
      const isGroup = ['group', 'supergroup', 'channel'].includes(chatType);
      const name    = isGroup
        ? message.chat.title
        : [from?.first_name, from?.last_name].filter(Boolean).join(' ');

      const replyText =
        `📊 <b>Repoplus Analytics</b>\n\n` +
        `${isGroup ? '👥 Группа' : '👤 Личный чат'}: <b>${name}</b>\n` +
        `🆔 <b>Chat ID: <code>${chatId}</code></b>\n\n` +
        `Отправьте этот ID вашему менеджеру в Repoplus для подключения уведомлений.\n\n` +
        `Вы будете получать:\n` +
        `• 📈 Ежедневный отчёт по рекламе\n` +
        `• 🔔 Алерты при высоком CPL\n` +
        `• 💰 Уведомления о низком балансе`;

      await sendMessage(botToken, chatId, replyText);

      // Автоматически добавляем в подписчики если ещё нет
      const settingsCfg = await query('SELECT id FROM telegram_settings LIMIT 1');
      if (settingsCfg.rows.length) {
        await query(
          `INSERT INTO telegram_subscriptions (settings_id, chat_id, chat_name, notification_types)
           VALUES ($1,$2,$3,ARRAY['daily_report'])
           ON CONFLICT (chat_id) DO NOTHING`,
          [settingsCfg.rows[0].id, String(chatId), name]
        ).catch(() => {});
      }
    }
  } catch(e) {
    console.error('[TG WEBHOOK]', e.message);
  }
});

// ── Применяем авторизацию для остальных роутов ────────────────────
router.use(authMiddleware);

// GET /api/telegram/settings
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT id, bot_username, bot_token_preview, webhook_url, created_at,
             (SELECT COUNT(*) FROM telegram_subscriptions WHERE settings_id = ts.id AND active=true) AS subscriber_count
      FROM telegram_settings ts LIMIT 1
    `);
    res.json(result.rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/telegram/settings — сохранить токен и установить webhook
router.post('/settings', requireAdmin, async (req, res) => {
  try {
    const { bot_token } = req.body;
    if (!bot_token) return res.status(400).json({ error: 'bot_token обязателен' });

    let botInfo;
    try { botInfo = await getBotInfo(bot_token); }
    catch (e) { return res.status(400).json({ error: 'Невалидный токен: ' + e.message }); }

    const preview    = bot_token.slice(0, 10) + '...' + bot_token.slice(-5);
    const webhookUrl = `${BACKEND_URL}/api/telegram/webhook`;

    // Регистрируем webhook в Telegram
    try {
      await axios.post(`https://api.telegram.org/bot${bot_token}/setWebhook`, {
        url:             webhookUrl,
        allowed_updates: ['message', 'channel_post'],
      });
      console.log('[TG] Webhook set:', webhookUrl);
    } catch(e) {
      console.error('[TG] setWebhook failed:', e.message);
    }

    const existing = await query('SELECT id FROM telegram_settings LIMIT 1');
    if (existing.rows.length) {
      await query(
        `UPDATE telegram_settings SET bot_token=$1, bot_token_preview=$2, bot_username=$3, webhook_url=$4 WHERE id=$5`,
        [bot_token, preview, botInfo.username, webhookUrl, existing.rows[0].id]
      );
    } else {
      await query(
        `INSERT INTO telegram_settings (bot_token, bot_token_preview, bot_username, webhook_url)
         VALUES ($1,$2,$3,$4)`,
        [bot_token, preview, botInfo.username, webhookUrl]
      );
    }
    res.json({ ok: true, username: botInfo.username, webhookUrl });
  } catch (e) {
    console.error('[TG SETTINGS]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /api/telegram/subscribers
router.get('/subscribers', requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT sub.id, sub.chat_id, sub.chat_name, sub.notification_types, sub.active, sub.created_at
      FROM telegram_subscriptions sub
      JOIN telegram_settings ts ON ts.id = sub.settings_id
      ORDER BY sub.created_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/telegram/subscribers
router.post('/subscribers', requireAdmin, async (req, res) => {
  try {
    const { chat_id, chat_name, notification_types } = req.body;
    if (!chat_id) return res.status(400).json({ error: 'chat_id обязателен' });
    const cfg = await query('SELECT id FROM telegram_settings LIMIT 1');
    if (!cfg.rows.length) return res.status(400).json({ error: 'Сначала настройте токен бота' });
    const types = Array.isArray(notification_types) ? notification_types : ['daily_report'];
    await query(
      `INSERT INTO telegram_subscriptions (settings_id, chat_id, chat_name, notification_types)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (chat_id) DO UPDATE SET chat_name=$3, notification_types=$4, active=true`,
      [cfg.rows[0].id, String(chat_id), chat_name || String(chat_id), types]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[TG SUB POST]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /api/telegram/subscribers/:id
router.patch('/subscribers/:id', requireAdmin, async (req, res) => {
  try {
    const { notification_types, active, chat_name } = req.body;
    await query(
      `UPDATE telegram_subscriptions SET
        notification_types = COALESCE($1, notification_types),
        active = COALESCE($2, active),
        chat_name = COALESCE($3, chat_name)
       WHERE id = $4`,
      [notification_types, active, chat_name, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /api/telegram/subscribers/:id
router.delete('/subscribers/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM telegram_subscriptions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/telegram/broadcast
router.post('/broadcast', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Текст сообщения обязателен' });
    const results = await sendBroadcast(message);
    res.json({ ok: true, ...results });
  } catch (e) {
    console.error('[TG BROADCAST]', e.message);
    res.status(500).json({ error: 'Ошибка рассылки' });
  }
});

// POST /api/telegram/test
router.post('/test', requireAdmin, async (req, res) => {
  try {
    const { chat_id } = req.body;
    const cfg = await query('SELECT bot_token FROM telegram_settings LIMIT 1');
    if (!cfg.rows.length) return res.status(400).json({ error: 'Бот не настроен' });
    await sendMessage(cfg.rows[0].bot_token, chat_id, '✅ <b>Repoplus</b>\nТестовое сообщение. Бот работает!');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
