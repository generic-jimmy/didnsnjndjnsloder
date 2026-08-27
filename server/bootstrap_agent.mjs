// One-time bootstrap: verify the direct DB connection and upsert an agent row
// so the remote agent can authenticate. Usage: node bootstrap_agent.mjs [token] [hostname]
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
});

const TOKEN = process.argv[2] || 'SWB37-BW34T-4UV3D-3339J';
const HOSTNAME = process.argv[3] || 'DESKTOP-AGENT';

try {
  const db = await pool.query('select current_database() as db');
  console.log('DB OK:', db.rows[0].db);

  await pool.query(
    `insert into public.agents (agent_token, hostname, status)
     values ($1, $2, 'offline')
     on conflict (agent_token) do nothing`,
    [TOKEN, HOSTNAME]
  );

  const a = await pool.query(
    'select id, hostname, status from public.agents where agent_token = $1',
    [TOKEN]
  );
  console.log('Agent row:', JSON.stringify(a.rows[0]));
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
