require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const authRoutes         = require('./routes/auth');
const clientsRoutes      = require('./routes/clients');
const analyticsRoutes    = require('./routes/analytics');
const integrationsRoutes = require('./routes/integrations');
const settingsRoutes     = require('./routes/settings');
const usersRoutes        = require('./routes/users');
const telegramRoutes     = require('./routes/telegram');
const { dailySync }      = require('./jobs/sync');

const app  = express();
const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

// ── HEALTHCHECK ──────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date() });
});

// ── CORS ─────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://repoplus.kz',
  'http://repoplus.kz',
  'https://artray9.github.io',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: ${origin} не разрешён`));
  },
  credentials: true,
}));

app.use(express.json());

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ── ROUTES ───────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/clients',      clientsRoutes);
app.use('/api/analytics',    analyticsRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/settings',     settingsRoutes);
app.use('/api/users',        usersRoutes);
app.use('/api/telegram',     telegramRoutes);

// ── CRON: 06:00 UTC+5 = 01:00 UTC ────────────────────────────────
cron.schedule('0 1 * * *', async () => {
  console.log('[CRON] Starting daily sync…');
  try { await dailySync(); }
  catch (e) { console.error('[CRON] error:', e.message); }
});

// ── START ────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`🚀 Repoplus API running on ${HOST}:${PORT}`);
});
