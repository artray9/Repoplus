/**
 * /api/telegram — настройки Telegram бота и управление подписчиками
 */
const express = require('express');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { getBotInfo, sendMessage, sendBroadcast } = require('../services/telegram');

const router = express.Router();
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

// POST /api/telegram/settings — сохранить/обновить токен бота
router.post('/settings', requireAdmin, async (req, res) => {
  try {
    const { bot_token } = req.body;
    if (!bot_token) return res.status(400).json({ error: 'bot_token обязателен' });

    // Проверяем токен через Telegram API
    let botInfo;
    try { botInfo = await getBotInfo(bot_token); }
    catch (e) { return res.status(400).json({ error: 'Невалидный токен: ' + e.message }); }

    const preview = bot_token.slice(0, 10) + '...' + bot_token.slice(-5);

    // Upsert (у нас одна глобальная запись)
    const existing = await query('SELECT id FROM telegram_settings LIMIT 1');
    if (existing.rows.length) {
      await query(
        `UPDATE telegram_settings SET bot_token=$1, bot_token_preview=$2, bot_username=$3 WHERE id=$4`,
        [bot_token, preview, botInfo.username, existing.rows[0].id]
      );
    } else {
      await query(
        `INSERT INTO telegram_settings (bot_token, bot_token_preview, bot_username)
         VALUES ($1,$2,$3)`,
        [bot_token, preview, botInfo.username]
      );
    }
    res.json({ ok: true, username: botInfo.username });
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

// POST /api/telegram/subscribers — добавить подписчика
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

// POST /api/telegram/broadcast — ручная рассылка
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

// POST /api/telegram/test — тестовое сообщение
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
