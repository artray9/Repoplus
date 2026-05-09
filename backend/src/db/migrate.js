require('dotenv').config({ path: '../../.env' });
const { pool } = require('./index');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email      TEXT UNIQUE NOT NULL,
        password   TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'viewer',
        name       TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
        name              TEXT NOT NULL,
        fb_account_id     TEXT,
        google_account_id TEXT,
        tt_account_id     TEXT,
        amo_subdomain     TEXT,
        active            BOOLEAN DEFAULT true,
        created_at        TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name         TEXT NOT NULL,
        source       TEXT NOT NULL,
        access_token TEXT NOT NULL,
        meta         JSONB DEFAULT '{}',
        expires_at   TIMESTAMP,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_tokens (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id     UUID REFERENCES clients(id) ON DELETE CASCADE,
        source        TEXT NOT NULL,
        access_token  TEXT NOT NULL,
        refresh_token TEXT,
        expires_at    TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE(client_id, source)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ad_metrics (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id     UUID REFERENCES clients(id) ON DELETE CASCADE,
        source        TEXT NOT NULL,
        date          DATE NOT NULL,
        campaign_id   TEXT,
        campaign_name TEXT,
        impressions   NUMERIC DEFAULT 0,
        clicks        NUMERIC DEFAULT 0,
        spend         NUMERIC DEFAULT 0,
        leads         NUMERIC DEFAULT 0,
        conversions   NUMERIC DEFAULT 0,
        ctr           NUMERIC DEFAULT 0,
        cpm           NUMERIC DEFAULT 0,
        cpl           NUMERIC DEFAULT 0,
        result_type   TEXT,
        created_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE(client_id, source, date, campaign_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_metrics_client_date ON ad_metrics(client_id, date);
      CREATE INDEX IF NOT EXISTS idx_metrics_source ON ad_metrics(source)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_leads (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
        amo_lead_id TEXT,
        date        DATE,
        status      TEXT,
        pipeline    TEXT,
        price       NUMERIC DEFAULT 0,
        utm_source  TEXT,
        created_at  TIMESTAMP DEFAULT NOW(),
        UNIQUE(client_id, amo_lead_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS account_balances (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id  UUID REFERENCES clients(id) ON DELETE CASCADE,
        source     TEXT NOT NULL,
        balance    NUMERIC DEFAULT 0,
        currency   TEXT DEFAULT 'USD',
        spend_cap  NUMERIC,
        fetched_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(client_id, source)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS client_access (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
        client_id  UUID REFERENCES clients(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, client_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_client_access_user ON client_access(user_id)
    `);


    // Telegram bot settings & subscriptions
    await client.query(`
      CREATE TABLE IF NOT EXISTS telegram_settings (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bot_token         TEXT NOT NULL,
        bot_token_preview TEXT,
        bot_username      TEXT,
        webhook_url       TEXT,
        created_at        TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS telegram_subscriptions (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        settings_id        UUID REFERENCES telegram_settings(id) ON DELETE CASCADE,
        chat_id            TEXT NOT NULL,
        chat_name          TEXT,
        notification_types TEXT[] DEFAULT ARRAY['daily_report'],
        active             BOOLEAN DEFAULT true,
        created_at         TIMESTAMP DEFAULT NOW(),
        UNIQUE(chat_id)
      )
    `);

    // Idempotent column additions
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'`);
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);

    await client.query('COMMIT');
    console.log('Migration complete');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
