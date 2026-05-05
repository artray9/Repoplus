const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => console.error('[DB] Unexpected error:', err));

const query = (text, params) => pool.query(text, params);

module.exports = { query, pool };
