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
app.use('/api/oauth',        oauthRoutes);

// ── CRON: 06:00 UTC+5 = 01:00 UTC ────────────────────────────────
cron.schedule('0 1 * * *', async () => {
  console.log('[CRON] Starting daily sync…');
  try { await dailySync(); }
  catch (e) { console.error('[CRON] error:', e.message); }
});

// ── AUTO-MIGRATE ON STARTUP ──────────────────────────────────────
async function autoMigrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        fb_account_id TEXT,
        google_account_id TEXT,
        tt_account_id TEXT,
        amo_subdomain TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(client_id, source)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ad_metrics (
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
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_metrics_client_date ON ad_metrics(client_id, date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_metrics_source ON ad_metrics(source)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        amo_lead_id TEXT,
        date DATE,
        status TEXT,
        pipeline TEXT,
        price NUMERIC DEFAULT 0,
        utm_source TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(client_id, amo_lead_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS account_balances (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        balance NUMERIC DEFAULT 0,
        currency TEXT DEFAULT 'USD',
        spend_cap NUMERIC,
        fetched_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(client_id, source)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        access_token TEXT NOT NULL,
        meta JSONB DEFAULT '{}',
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS client_access (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, client_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_client_access_user ON client_access(user_id)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS telegram_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bot_token TEXT NOT NULL,
        bot_token_preview TEXT,
        bot_username TEXT,
        webhook_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS telegram_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        settings_id UUID REFERENCES telegram_settings(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        chat_name TEXT,
        notification_types TEXT[] DEFAULT ARRAY['daily_report'],
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(chat_id)
      )
    `);
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'`);
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    console.log('[MIGRATE] Auto-migration complete');
  } catch(e) {
    console.error('[MIGRATE] Auto-migration error:', e.message);
  } finally {
    client.release();
  }
}

// ── START ────────────────────────────────────────────────────────
autoMigrate().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`🚀 Repoplus API running on ${HOST}:${PORT}`);
  });
});
