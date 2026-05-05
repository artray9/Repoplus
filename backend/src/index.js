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
const HOST = '0.0.0.0'; // Railway требует явного биндинга на все интерфейсы

// ── HEALTHCHECK — до всего, без авторизации и CORS ───────────────
// Railway бьёт сюда сразу после деплоя, должен отвечать мгновенно
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date() });
});

// ── MIDDLEWARE ───────────────────────────────────────────────────
const allowedOrigins = [
  'https://repoplus.kz',
  'http://repoplus.kz',
  'https://artray9.github.io',  // GitHub Pages
  process.env.FRONTEND_URL,
].filter(Boolean); // убираем undefined если FRONTEND_URL не задан

app.use(cors({
  origin: (origin, callback) => {
    // Разрешаем запросы без origin (curl, Postman, Railway healthcheck)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: ${origin} не разрешён`));
  },
  credentials: true,
}));

app.use(express.json());

// Request logger
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ── ROUTES ───────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/clients',      clientsRoutes);
app.use('/api/analytics',    analyticsRoutes);
app.use('/api/integrations', integrationsRoutes);

// ── CRON: ежедневная синхронизация в 06:00 UTC+5 (01:00 UTC) ────
cron.schedule('0 1 * * *', async () => {
  console.log('[CRON] Starting daily sync…');
  try { await dailySync(); }
  catch (e) { console.error('[CRON] dailySync error:', e.message); }
});

// ── START ────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`🚀 Repoplus API running on ${HOST}:${PORT}`);
});
