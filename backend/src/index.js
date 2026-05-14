require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const { pool } = require('./db');

const authRoutes         = require('./routes/auth');
const clientsRoutes      = require('./routes/clients');
const analyticsRoutes    = require('./routes/analytics');
const integrationsRoutes = require('./routes/integrations');
const settingsRoutes     = require('./routes/settings');
const usersRoutes        = require('./routes/users');
const telegramRoutes     = require('./routes/telegram');
const oauthRoutes        = require('./routes/oauth');
const sourcesRoutes      = require('./routes/sources');
const { dailySync }      = require('./jobs/sync');

const app  = express();
const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }));

// Whitelist: production-домены + всё что в FRONTEND_URL и EXTRA_ORIGINS.
// EXTRA_ORIGINS — список через запятую: https://foo.com,https://bar.com
const allowedOrigins = [
  'https://repoplus.kz',
  'http://repoplus.kz',
  'https://www.repoplus.kz',
  process.env.FRONTEND_URL,
  ...(process.env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
].filter(Boolean);

// Wildcard preview-домены: github.io, railway.app, vercel.app
function isOriginAllowed(origin) {
  if (allowedOrigins.includes(origin)) return true;
  try {
    const host = new URL(origin).host;
    if (host.endsWith('.github.io'))      return true;
    if (host.endsWith('.up.railway.app')) return true;
    if (host.endsWith('.vercel.app'))     return true;
  } catch (e) {}
  return false;
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (isOriginAllowed(origin)) return callback(null, true);
    console.warn('[CORS] Blocked:', origin);
    callback(new Error('CORS: ' + origin + ' not allowed'));
  },
  credentials: true,
}));

app.use(express.json());
app.use((req, _res, next) => {
  console.log(new Date().toISOString() + ' ' + req.method + ' ' + req.path);
  next();
});

app.use('/api/auth',         authRoutes);
app.use('/api/clients',      clientsRoutes);
app.use('/api/analytics',    analyticsRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/settings',     settingsRoutes);
app.use('/api/users',        usersRoutes);
app.use('/api/telegram',     telegramRoutes);
app.use('/api/oauth',        oauthRoutes);
app.use('/api/sources',      sourcesRoutes);

app.post('/api/wishes', async (req, res) => {
  const { text, email } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const { query } = require('./db');
    await query('INSERT INTO wishes (text, email) VALUES ($1,$2)', [text.slice(0, 2000), email || null]).catch(() => {});
    console.log('[WISH] ' + (email || 'anon') + ': ' + text.slice(0, 60));
  } catch(e) {}
  res.json({ ok: true });
});

// Daily sync — 06:00 Asia/Almaty каждый день.
cron.schedule('0 6 * * *', async () => {
  console.log('[CRON] daily sync (Asia/Almaty 06:00)...');
  try { await dailySync(); } catch(e) { console.error('[CRON]', e.message); }
}, { timezone: 'Asia/Almaty' });

async function autoMigrate() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS clients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      fb_account_id TEXT,
      google_account_id TEXT,
      google_manager_id TEXT,
      tt_account_id TEXT,
      amo_subdomain TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS integration_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(client_id, source)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ad_metrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      date DATE NOT NULL,
      campaign_id TEXT,
      campaign_name TEXT,
      impressions NUMERIC DEFAULT 0,
      clicks NUMERIC DEFAULT 0,
      spend NUMERIC DEFAULT 0,
      leads NUMERIC DEFAULT 0,
      conversions NUMERIC DEFAULT 0,
      ctr NUMERIC DEFAULT 0,
      cpm NUMERIC DEFAULT 0,
      cpl NUMERIC DEFAULT 0,
      result_type TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(client_id, source, date, campaign_id)
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_metrics_client_date ON ad_metrics(client_id, date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_metrics_source ON ad_metrics(source)`);
    await client.query(`CREATE TABLE IF NOT EXISTS crm_leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
      amo_lead_id TEXT,
      date DATE, status TEXT, pipeline TEXT,
      price NUMERIC DEFAULT 0,
      utm_source TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(client_id, amo_lead_id)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS account_balances (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      balance NUMERIC DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      spend_cap NUMERIC,
      fetched_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(client_id, source)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      access_token TEXT NOT NULL,
      meta JSONB DEFAULT '{}',
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS client_access (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, client_id)
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_client_access_user ON client_access(user_id)`);
    await client.query(`CREATE TABLE IF NOT EXISTS telegram_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bot_token TEXT NOT NULL,
      bot_token_preview TEXT,
      bot_username TEXT,
      webhook_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS telegram_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      settings_id UUID REFERENCES telegram_settings(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      chat_name TEXT,
      notification_types TEXT[] DEFAULT ARRAY['daily_report'],
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(chat_id)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS wishes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      text TEXT NOT NULL,
      email TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
      client_name TEXT,
      invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(email)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS user_oauth_tokens (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
      source        TEXT NOT NULL,
      access_token  TEXT NOT NULL,
      refresh_token TEXT,
      expires_at    TIMESTAMP,
      extra         JSONB DEFAULT '{}',
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, source)
    )`);
    await client.query(`ALTER TABLE account_balances ADD COLUMN IF NOT EXISTS extra JSONB DEFAULT '{}'`);
    await client.query(`ALTER TABLE account_balances ADD COLUMN IF NOT EXISTS amount_spent NUMERIC DEFAULT 0`);
    await client.query(`ALTER TABLE account_balances ADD COLUMN IF NOT EXISTS next_bill_date TIMESTAMP`);
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'`);
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE users    DROP CONSTRAINT IF EXISTS users_role_check`);
    await client.query(`ALTER TABLE users ALTER COLUMN password DROP NOT NULL`);
    await client.query(`ALTER TABLE clients  ADD COLUMN IF NOT EXISTS google_manager_id TEXT`);
    await client.query(`ALTER TABLE clients  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    console.log('[MIGRATE] complete');
  } catch(e) {
    console.error('[MIGRATE] error:', e.message);
  } finally {
    client.release();
  }
}

autoMigrate().then(() => {
  app.listen(PORT, HOST, () => {
    console.log('Repoplus API running on ' + HOST + ':' + PORT);
  });
});
