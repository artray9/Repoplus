const express  = require('express');
const { query } = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { dailySync } = require('../jobs/sync');
const { syncClientFacebook } = require('../services/facebook');

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

// POST /api/integrations/token — сохранить/обновить токен
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

// POST /api/integrations/sync/manual — ежедневный sync вручную
router.post('/sync/manual', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, message: 'Синхронизация запущена' });
    dailySync().catch(e => console.error('[MANUAL SYNC] error:', e.message));
  } catch (e) {
    res.status(500).json({ error: 'Ошибка запуска синхронизации' });
  }
});

// POST /api/integrations/sync/backfill — выгрузка за произвольный период
// Body: { client_id?: uuid|null, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
router.post('/sync/backfill', requireAdmin, async (req, res) => {
  try {
    const { client_id, from, to } = req.body;
    if (!from || !to) {
      return res.status(400).json({ error: 'from и to обязательны (YYYY-MM-DD)' });
    }
    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'Формат даты: YYYY-MM-DD' });
    }
    if (from > to) {
      return res.status(400).json({ error: 'from должна быть раньше to' });
    }

    res.json({ ok: true, message: `Backfill запущен: ${from} — ${to}` });

    // Run async
    (async () => {
      try {
        const clientsRes = client_id
          ? await query('SELECT * FROM clients WHERE id = $1 AND active = true', [client_id])
          : await query('SELECT * FROM clients WHERE active = true');

        const clients = clientsRes.rows;
        console.log(`[BACKFILL] ${from}–${to} for ${clients.length} client(s)`);

        for (const client of clients) {
          try {
            const n = await syncClientFacebook(client, from, to);
            console.log(`[BACKFILL] ${client.name}: ${n} rows`);
          } catch (e) {
            console.error(`[BACKFILL] ${client.name} FB error:`, e.message);
          }
          // Rate-limit buffer between clients
          await new Promise(r => setTimeout(r, 1000));
        }
        console.log('[BACKFILL] Done');
      } catch (e) {
        console.error('[BACKFILL] Fatal:', e.message);
      }
    })();
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
