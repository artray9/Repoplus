const express  = require('express');
const { query } = require('../db');
const { encrypt } = require('../lib/crypto');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { dailySync } = require('../jobs/sync');
const { syncClientFacebook } = require('../services/facebook');
const { syncClientTikTok }   = require('../services/tiktok');
const { syncClientGoogle }   = require('../services/google');
const { syncClientAmoCRM }   = require('../services/amocrm');
const { ownsClient }         = require('./clients');

const router = express.Router();
router.use(authMiddleware);

router.get('/:clientId', requireAdmin, async (req, res) => {
  try {
    if (!(await ownsClient(req.user, req.params.clientId))) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }
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

router.post('/token', requireAdmin, async (req, res) => {
  try {
    const { client_id, source, access_token, refresh_token, expires_at } = req.body;
    if (!client_id || !source || !access_token) {
      return res.status(400).json({ error: 'client_id, source и access_token обязательны' });
    }
    if (!(await ownsClient(req.user, client_id))) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }
    await query(
      `INSERT INTO integration_tokens (client_id, source, access_token, refresh_token, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (client_id, source)
       DO UPDATE SET access_token=$3, refresh_token=$4, expires_at=$5, updated_at=NOW()`,
      [client_id, source, encrypt(access_token), encrypt(refresh_token) || null, expires_at || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/sync/manual', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, message: 'Синхронизация запущена' });
    const ownerId = req.user.role === 'superadmin' ? null : req.user.userId;
    dailySync(ownerId).catch(e => console.error('[MANUAL SYNC] error:', e.message));
  } catch (e) {
    res.status(500).json({ error: 'Ошибка запуска синхронизации' });
  }
});

router.post('/sync/backfill', requireAdmin, async (req, res) => {
  try {
    const { client_id, from, to, sources } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from и to обязательны (YYYY-MM-DD)' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return res.status(400).json({ error: 'Формат даты: YYYY-MM-DD' });
    if (from > to) return res.status(400).json({ error: 'from должна быть раньше to' });

    const activeSources = Array.isArray(sources) && sources.length
      ? sources
      : ['facebook', 'tiktok', 'google', 'amocrm'];

    if (client_id && !(await ownsClient(req.user, client_id))) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }

    res.json({ ok: true, message: 'Backfill: ' + from + '-' + to + ' (' + activeSources.join(', ') + ')' });

    const isSuper = req.user.role === 'superadmin';
    (async () => {
      try {
        let clientsRes;
        if (client_id) {
          clientsRes = await query('SELECT * FROM clients WHERE id = $1 AND active = true', [client_id]);
        } else if (isSuper) {
          clientsRes = await query('SELECT * FROM clients WHERE active = true');
        } else {
          clientsRes = await query('SELECT * FROM clients WHERE active = true AND owner_id = $1', [req.user.userId]);
        }
        const clients = clientsRes.rows;
        console.log('[BACKFILL] ' + from + '-' + to + ' for ' + clients.length + ' client(s)');

        for (const client of clients) {
          if (activeSources.includes('facebook')) {
            try {
              const n = await syncClientFacebook(client, from, to);
              console.log('[BACKFILL] ' + client.name + ' FB: ' + n + ' rows');
            } catch (e) { console.error('[BACKFILL] ' + client.name + ' FB:', e.message); }
          }
          if (activeSources.includes('tiktok')) {
            try {
              const n = await syncClientTikTok(client, from, to);
              console.log('[BACKFILL] ' + client.name + ' TT: ' + n + ' rows');
            } catch (e) { console.error('[BACKFILL] ' + client.name + ' TT:', e.message); }
          }
          if (activeSources.includes('google')) {
            try {
              const n = await syncClientGoogle(client, from, to);
              console.log('[BACKFILL] ' + client.name + ' Google: ' + n + ' rows');
            } catch (e) { console.error('[BACKFILL] ' + client.name + ' Google:', e.message); }
          }
          if (activeSources.includes('amocrm')) {
            try {
              const n = await syncClientAmoCRM(client, from, to);
              console.log('[BACKFILL] ' + client.name + ' amoCRM: ' + n + ' leads');
            } catch (e) { console.error('[BACKFILL] ' + client.name + ' amoCRM:', e.message); }
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        console.log('[BACKFILL] Done');
      } catch (e) { console.error('[BACKFILL] Fatal:', e.message); }
    })();
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
