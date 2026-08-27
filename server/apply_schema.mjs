// Apply supabase/schema.sql to the database via the DATABASE_URL in server/.env.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
});

const schemaPath = path.join(__dirname, '..', 'supabase', 'schema.sql');
const sql = fs.readFileSync(schemaPath, 'utf8');

try {
  await pool.query(sql);
  console.log('Schema applied OK');
} catch (e) {
  console.error('Schema FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
