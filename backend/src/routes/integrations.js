const express  = require('express');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { dailySync } = require('../jobs/sync');

const router = express.Router();
router.use(authMiddleware);

// GET /api/integrations/:clientId — статус интеграций клиента
router.get('/:clientId', requireAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT source, expires_at, updated_at
       FROM integration_tokens WHERE client_id = $1`,
      [req.params.clientId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/integrations/token — сохранить токен вручную (Facebook long-lived token и т.д.)
router.post('/token', requireAdmin, async (req, res) => {
  try {
    const { client_id, source, access_token, refresh_token, expires_at } = req.body;
    if (!client_id || !source || !access_token) {
      return res.status(400).json({ error: 'client_id, source и access_token обязательны' });
    }
    await query(
      `INSERT INTO integration_tokens (client_id, source, access_token, refresh_token, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (client_id, source)
       DO UPDATE SET access_token=$3, refresh_token=$4, expires_at=$5, updated_at=NOW()`,
      [client_id, source, access_token, refresh_token || null, expires_at || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/integrations/sync/manual — ручная синхронизация (вызывается из дашборда)
router.post('/sync/manual', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, message: 'Синхронизация запущена' });
    // Запускаем асинхронно — не блокируем ответ
    dailySync().catch(e => console.error('[MANUAL SYNC] error:', e.message));
  } catch (e) {
    res.status(500).json({ error: 'Ошибка запуска синхронизации' });
  }
});

module.exports = router;
