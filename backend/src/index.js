require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const authRoutes         = require('./routes/auth');
const clientsRoutes      = require('./routes/clients');
const analyticsRoutes    = require('./routes/analytics');
const integrationsRoutes = require('./routes/integrations');
const { dailySync }      = require('./jobs/sync');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ───────────────────────────────────────────────────
const corsOptions = {
  // Разрешаем запросы с вашего домена и из переменной окружения
  origin: [process.env.FRONTEND_URL, 'https://repoplus.kz', 'http://repoplus.kz'],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// Request logger (dev)
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ── ROUTES ───────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/clients',      clientsRoutes);
app.use('/api/analytics',    analyticsRoutes);
app.use('/api/integrations', integrationsRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── CRON: ежедневная синхронизация в 06:00 UTC+5 ─────────────────
// (01:00 UTC)
cron.schedule('0 1 * * *', async () => {
  console.log('[CRON] Starting daily sync…');
  try { await dailySync(); }
  catch (e) { console.error('[CRON] dailySync error:', e.message); }
});

// ── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Repoplus API running on port ${PORT}`);
});
