import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

const { Pool } = pg;

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set — using insecure default. Set it in server/.env!');
}
// Pre-shared secret agents must present to auto-enroll (unknown tokens are rejected otherwise)
const AGENT_ENROLL_SECRET = process.env.AGENT_ENROLL_SECRET || '';
const OPERATOR_USERNAME = process.env.OPERATOR_USERNAME || 'admin';
const OPERATOR_PASSWORD_HASH = process.env.OPERATOR_PASSWORD_HASH; // Store bcrypt hash of password
// If no hash provided, create a default hash for 'password' at startup (for dev only)
const defaultHash = bcrypt.hashSync('password', 10);
const operatorPasswordHash = OPERATOR_PASSWORD_HASH || defaultHash;
if (!OPERATOR_PASSWORD_HASH) {
  console.warn('WARNING: OPERATOR_PASSWORD_HASH not set — default login is admin/password (dev only!)');
}

// Heartbeats older than this (ms) mean the agent is gone even if no close event fired
const STALE_AGENT_MS = 90 * 1000;
// How often the reaper sweeps for dead agents
const REAPER_INTERVAL_MS = 30 * 1000;
// Max script size we relay (bytes)
const MAX_SCRIPT_BYTES = 100 * 1024;
// Server version for the live metrics page
const SERVER_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '1.0.0';
  } catch { return '1.0.0'; }
})();

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable');
  process.exit(1);
}

// Direct PostgreSQL connection (bypasses RLS; Supabase requires TLS)
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  // Max concurrent DB connections. Raise via DB_POOL_MAX to drain bursts faster
  // (e.g. many agents reconnecting at once). Default 25.
  max: parseInt(process.env.DB_POOL_MAX || '25', 10)
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

// ---------- Geo enrichment (country flags) ----------
// Free, key-less lookup with a small in-memory cache. Fire-and-forget: it can
// never block or fail agent registration. Agents that already send
// country_code in their register message always win over the IP lookup.
const geoCache = new Map(); // ip -> { country, country_code, isp, lat, lon }

// ---------- Live server metrics (in-memory, zero deps) ----------
const METRICS_STARTED_AT = Date.now();
const wsMetrics = {
  messagesIn: 0, messagesOut: 0, bytesIn: 0, bytesOut: 0,
  agentConnectionsTotal: 0, operatorConnectionsTotal: 0,
  scriptRunsTotal: 0, scriptErrorsTotal: 0, bannedRejectedTotal: 0,
  geo: { lastStatus: null, lastLatencyMs: null, lastAt: null, success: 0, failure: 0 }
};
// Rolling throughput: one bucket per minute, kept for the last ~60 minutes
const throughput = new Map(); // minuteTs -> { in: n, out: n }
function bumpThroughput(dir, n = 1) {
  const minute = Math.floor(Date.now() / 60000) * 60000;
  let b = throughput.get(minute);
  if (!b) {
    b = { in: 0, out: 0 };
    throughput.set(minute, b);
    if (throughput.size > 70) {
      for (const k of throughput.keys()) if (k < minute - 60 * 60000) throughput.delete(k);
    }
  }
  b[dir] += n;
}

async function enrichAgentGeo(agentId, ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.16.')) return;
  const started = Date.now();
  try {
    let geo = geoCache.get(ip);
    if (!geo) {
      const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,isp,lat,lon`, {
        signal: AbortSignal.timeout(3000)
      });
      const data = await res.json();
      wsMetrics.geo.lastLatencyMs = Date.now() - started;
      wsMetrics.geo.lastAt = new Date().toISOString();
      if (data?.status === 'success') {
        geo = {
          country: data.country || null,
          country_code: data.countryCode || null,
          isp: data.isp || null,
          lat: Number.isFinite(data.lat) ? data.lat : null,
          lon: Number.isFinite(data.lon) ? data.lon : null
        };
        geoCache.set(ip, geo);
        if (geoCache.size > 5000) geoCache.clear(); // simple bound
        wsMetrics.geo.lastStatus = 'ok';
        wsMetrics.geo.success++;
      } else {
        geoCache.set(ip, { country: null, country_code: null, isp: null, lat: null, lon: null });
        wsMetrics.geo.lastStatus = 'fail';
        wsMetrics.geo.failure++;
        return;
      }
    }
    await pool.query(
      `UPDATE public.agents
         SET country = COALESCE(country, $2),
             country_code = COALESCE(country_code, $3),
             isp = COALESCE(isp, $4),
             lat = COALESCE(lat, $5),
             lon = COALESCE(lon, $6)
       WHERE id = $1 AND (country_code IS NULL OR isp IS NULL OR lat IS NULL)`,
      [agentId, geo.country, geo.country_code, geo.isp, geo.lat, geo.lon]
    );
  } catch (err) {
    wsMetrics.geo.failure++;
    // geo lookup is best-effort only
  }
}

// ---------- Login rate limiting & account lockout ----------
// 3 failed attempts -> lockout that DOUBLES per repeat offense (5m, 10m, 20m…).
// A successful login fully resets strikes AND the escalation ladder.
// A separate per-IP guard caps request flooding across usernames.
const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_LOCKOUT_BASE_MS = parseInt(process.env.LOGIN_LOCKOUT_BASE_MS || String(5 * 60 * 1000), 10);
const LOGIN_IP_WINDOW_MS = 60 * 1000;
const LOGIN_IP_MAX = parseInt(process.env.LOGIN_IP_MAX || '10', 10);
const loginStates = new Map();  // "username|ip" -> { failures, lockouts, lockedUntil }
const loginIpBuckets = new Map(); // ip -> { count, windowStart }

function clientIp(req) {
  let ip = req.socket?.remoteAddress || 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function getLoginState(key) {
  let st = loginStates.get(key);
  if (!st) {
    st = { failures: 0, lockouts: 0, lockedUntil: 0 };
    loginStates.set(key, st);
  }
  return st;
}

// Periodic sweep so the rate-limit maps never grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, st] of loginStates) {
    if (st.lockedUntil < now - 30 * 60 * 1000) loginStates.delete(k);
  }
  for (const [ip, b] of loginIpBuckets) {
    if (now - b.windowStart > LOGIN_IP_WINDOW_MS) loginIpBuckets.delete(ip);
  }
}, 60 * 1000).unref();

// Per-IP flood guard in front of the login handler
function loginGuard(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  let bucket = loginIpBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > LOGIN_IP_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    loginIpBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > LOGIN_IP_MAX) {
    const retryAfter = Math.ceil((bucket.windowStart + LOGIN_IP_WINDOW_MS - now) / 1000);
    return res.status(429).json({
      error: 'Too many login attempts from this address. Slow down.',
      retry_after_seconds: retryAfter
    });
  }
  next();
}

// Counts a failed attempt; locks the account after LOGIN_MAX_ATTEMPTS strikes.
function rejectLogin(res, state, username, ip) {
  state.failures += 1;
  if (state.failures >= LOGIN_MAX_ATTEMPTS) {
    state.lockouts += 1;
    const duration = LOGIN_LOCKOUT_BASE_MS * Math.pow(2, state.lockouts - 1); // 5m -> 10m -> 20m …
    state.lockedUntil = Date.now() + duration;
    state.failures = 0;
    console.warn(`LOCKOUT: '${username}' from ${ip} locked for ${Math.round(duration / 60000)}min (offense #${state.lockouts})`);
    return res.status(429).json({
      error: 'Account locked — too many failed attempts',
      locked_until: new Date(state.lockedUntil).toISOString(),
      retry_after_seconds: Math.ceil(duration / 1000)
    });
  }
  return res.status(401).json({
    error: 'Invalid credentials',
    attempts_remaining: LOGIN_MAX_ATTEMPTS - state.failures
  });
}

// ---------- Express app ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve static files from the React build (client/dist)
// Supports both local dev (server/../client/dist) and Docker (/app/client/dist)
const devDistPath = path.join(__dirname, '..', 'client', 'dist');
const containerDistPath = path.join(__dirname, 'client', 'dist');
const clientDistPath = fs.existsSync(containerDistPath) ? containerDistPath : devDistPath;
app.use(express.static(clientDistPath));

// ---------- Authentication ----------
// Login endpoint: returns JWT if credentials match (rate-limited: 3 strikes)
app.post('/api/auth/login', loginGuard, async (req, res) => {
  const { username, password } = req.body;
  const ip = clientIp(req);
  const state = getLoginState(`${username || ''}|${ip}`);
  const now = Date.now();
  // Locked? Reject before even touching bcrypt.
  if (state.lockedUntil > now) {
    console.warn(`LOCKOUT: '${username}' from ${ip} tried while locked (${Math.ceil((state.lockedUntil - now) / 1000)}s left)`);
    return res.status(429).json({
      error: 'Account locked — too many failed attempts',
      locked_until: new Date(state.lockedUntil).toISOString(),
      retry_after_seconds: Math.ceil((state.lockedUntil - now) / 1000)
    });
  }
  if (username !== OPERATOR_USERNAME) {
    return rejectLogin(res, state, username, ip);
  }
  const passwordMatch = await bcrypt.compare(password || '', operatorPasswordHash);
  if (!passwordMatch) {
    return rejectLogin(res, state, username, ip);
  }
  // Success — fully reset strikes AND the lockout escalation ladder
  state.failures = 0;
  state.lockouts = 0;
  state.lockedUntil = 0;
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// Middleware to verify JWT for protected REST endpoints
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// Helper: fetch a single agent row
async function getAgent(id) {
  const result = await pool.query('SELECT * FROM public.agents WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] || null;
}

// Helper: fetch one agent WITH its tags (same shape as the agents list)
async function getAgentWithTags(id) {
  const result = await pool.query(
    `SELECT a.id, a.hostname, a.ip_address, a.os_name, a.os_version, a.os_arch, a.platform, a.username,
            a.country, a.country_code, a.isp, a.lat, a.lon, a.status, a.banned, a.ban_reason, a.created_at, a.last_seen,
            COALESCE(
              json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)) FILTER (WHERE t.id IS NOT NULL),
              '[]'
            ) AS tags
       FROM public.agents a
       LEFT JOIN public.agent_tags at2 ON at2.agent_id = a.id
       LEFT JOIN public.tags t ON t.id = at2.tag_id
      WHERE a.id = $1
      GROUP BY a.id
      LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

// Helper: kick a live agent connection (used by ban/delete)
function kickAgent(agentId, code, reason) {
  const ws = agentConnections.get(agentId);
  if (ws) {
    try { ws.close(code, reason); } catch (e) { /* noop */ }
    agentConnections.delete(agentId);
  }
}

// Get agents list (protected) — includes tags for the smart list + fleet map
app.get('/api/agents', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.hostname, a.ip_address, a.os_name, a.os_version, a.os_arch, a.platform, a.username,
              a.country, a.country_code, a.isp, a.lat, a.lon, a.status, a.banned, a.ban_reason, a.created_at, a.last_seen,
              COALESCE(
                json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)) FILTER (WHERE t.id IS NOT NULL),
                '[]'
              ) AS tags
         FROM public.agents a
         LEFT JOIN public.agent_tags at2 ON at2.agent_id = a.id
         LEFT JOIN public.tags t ON t.id = at2.tag_id
        GROUP BY a.id
        ORDER BY a.created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Agent management: ban / unban / delete ----------

// Ban an agent (kicks it immediately; rejected on reconnect while banned)
app.post('/api/agents/:id/ban', authenticateToken, async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const reason = (req.body?.reason || 'Banned by operator').slice(0, 200);
    await pool.query('UPDATE public.agents SET banned = true, ban_reason = $2, status = $3 WHERE id = $1',
      [agent.id, reason, 'banned']);
    kickAgent(agent.id, 4004, 'Agent banned');
    broadcastToOperators({
      type: 'agent_status',
      agent: { id: agent.id, hostname: agent.hostname, status: 'banned', banned: true, ban_reason: reason }
    });
    res.json({ ok: true, id: agent.id, banned: true, ban_reason: reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:id/unban', authenticateToken, async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    await pool.query('UPDATE public.agents SET banned = false, ban_reason = NULL, status = $2 WHERE id = $1',
      [agent.id, 'offline']);
    broadcastToOperators({
      type: 'agent_status',
      agent: { id: agent.id, hostname: agent.hostname, status: 'offline', banned: false, ban_reason: null }
    });
    res.json({ ok: true, id: agent.id, banned: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Permanently remove an agent (cascades to its command logs)
app.delete('/api/agents/:id', authenticateToken, async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    kickAgent(agent.id, 4005, 'Agent removed');
    await pool.query('DELETE FROM public.agents WHERE id = $1', [agent.id]);
    broadcastToOperators({ type: 'agent_removed', agent_id: agent.id });
    res.json({ ok: true, id: agent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Command history for one agent (script runs + results)
app.get('/api/agents/:id/history', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const result = await pool.query(
      `SELECT id, command, output, executed_at, operator_username
         FROM public.command_logs WHERE agent_id = $1
        ORDER BY executed_at DESC LIMIT $2`,
      [req.params.id, limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Scripts ----------
// Save script (protected)
app.post('/api/scripts', authenticateToken, async (req, res) => {
  const { name, language, content } = req.body;
  if (!name || !content) return res.status(400).json({ error: 'Name and content are required' });
  if (!['powershell', 'vbscript'].includes(language)) return res.status(400).json({ error: 'Unsupported language' });
  try {
    const result = await pool.query(
      'INSERT INTO public.scripts (name, language, content, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, language, content, req.user.username]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all scripts (protected)
app.get('/api/scripts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM public.scripts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a saved script (protected)
app.delete('/api/scripts/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM public.scripts WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Tags & groups ----------
app.get('/api/tags', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.name, t.color, t.created_at,
              count(at2.agent_id)::int AS agent_count
         FROM public.tags t
         LEFT JOIN public.agent_tags at2 ON at2.tag_id = t.id
        GROUP BY t.id
        ORDER BY t.name ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create (or recolor) a tag
app.post('/api/tags', authenticateToken, async (req, res) => {
  const name = (req.body?.name || '').trim().slice(0, 40);
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body?.color || '') ? req.body.color : '#22d3ee';
  if (!name) return res.status(400).json({ error: 'Tag name is required' });
  try {
    const result = await pool.query(
      'INSERT INTO public.tags (name, color) VALUES ($1, $2) ' +
      'ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color RETURNING *',
      [name, color]
    );
    broadcastToOperators({ type: 'tags_changed' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tags/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM public.tags WHERE id = $1', [req.params.id]);
    broadcastToOperators({ type: 'tags_changed' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Replace the tag set of one agent (body: { tag_ids: [...] })
app.put('/api/agents/:id/tags', authenticateToken, async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const ids = Array.isArray(req.body?.tag_ids) ? req.body.tag_ids.slice(0, 20) : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM public.agent_tags WHERE agent_id = $1', [agent.id]);
      for (const tagId of ids) {
        await client.query(
          'INSERT INTO public.agent_tags (agent_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [agent.id, tagId]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) { /* noop */ }
      throw e;
    } finally {
      client.release();
    }
    const fresh = await getAgentWithTags(agent.id);
    broadcastToOperators({ type: 'agent_status', agent: { ...fresh, status: agent.status } });
    res.json({ ok: true, id: agent.id, tags: fresh?.tags || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Live server metrics ----------
app.get('/api/metrics/live', authenticateToken, (req, res) => {
  try {
    const now = Date.now();
    const currentMinute = Math.floor(now / 60000) * 60000;
    const series = [];
    for (let i = 59; i >= 0; i--) {
      const m = currentMinute - i * 60000;
      const b = throughput.get(m) || { in: 0, out: 0 };
      series.push({ t: m, in: b.in, out: b.out });
    }
    // last COMPLETE minute gives a stable msg/sec estimate
    const lastComplete = series[series.length - 2] || { in: 0, out: 0 };
    let operatorsConnected = 0;
    for (const set of operatorConnections.values()) operatorsConnected += set.size;
    res.json({
      server_version: SERVER_VERSION,
      node_version: process.version,
      uptime_s: Math.floor((now - METRICS_STARTED_AT) / 1000),
      ws: {
        agents_connected: agentConnections.size,
        operators_connected: operatorsConnected,
        agent_connections_total: wsMetrics.agentConnectionsTotal,
        operator_connections_total: wsMetrics.operatorConnectionsTotal,
        messages_in: wsMetrics.messagesIn,
        messages_out: wsMetrics.messagesOut,
        bytes_in: wsMetrics.bytesIn,
        bytes_out: wsMetrics.bytesOut,
        msg_per_sec_in: +(lastComplete.in / 60).toFixed(2),
        msg_per_sec_out: +(lastComplete.out / 60).toFixed(2),
        script_runs_total: wsMetrics.scriptRunsTotal,
        script_errors_total: wsMetrics.scriptErrorsTotal,
        banned_rejected_total: wsMetrics.bannedRejectedTotal,
        throughput_series: series
      },
      db: {
        pool_total: pool.totalCount ?? null,
        pool_idle: pool.idleCount ?? null,
        pool_waiting: pool.waitingCount ?? null,
        pool_max: parseInt(process.env.DB_POOL_MAX || '25', 10)
      },
      geo: { ...wsMetrics.geo, cache_size: geoCache.size }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fleet timeline for charts: online/offline/banned counts over time
app.get('/api/metrics/timeline', authenticateToken, async (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours || '24', 10) || 24, 24 * 7);
    const result = await pool.query(
      `SELECT captured_at, online, offline, banned, total
         FROM public.metrics_snapshots
        WHERE captured_at >= now() - ($1 || ' hours')::interval
        ORDER BY captured_at ASC`,
      [String(hours)]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- CSV / JSON export ----------
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, columns) {
  const lines = [columns.map((c) => csvEscape(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c.key])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
const AGENT_EXPORT_COLUMNS = [
  { key: 'hostname', label: 'hostname' },
  { key: 'ip_address', label: 'ip' },
  { key: 'status', label: 'status' },
  { key: 'banned', label: 'banned' },
  { key: 'ban_reason', label: 'ban_reason' },
  { key: 'os_name', label: 'os' },
  { key: 'os_version', label: 'os_version' },
  { key: 'os_arch', label: 'arch' },
  { key: 'platform', label: 'platform' },
  { key: 'username', label: 'user' },
  { key: 'country', label: 'country' },
  { key: 'country_code', label: 'country_code' },
  { key: 'isp', label: 'isp' },
  { key: 'tags', label: 'tags' },
  { key: 'created_at', label: 'first_seen' },
  { key: 'last_seen', label: 'last_seen' }
];

// Export the full agent fleet
app.get('/api/export/agents', authenticateToken, async (req, res) => {
  try {
    const format = (req.query.format || 'csv').toLowerCase();
    const result = await pool.query(
      `SELECT a.id, a.hostname, a.ip_address, a.os_name, a.os_version, a.os_arch, a.platform, a.username,
              a.country, a.country_code, a.isp, a.status, a.banned, a.ban_reason, a.created_at, a.last_seen,
              COALESCE(
                json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)) FILTER (WHERE t.id IS NOT NULL),
                '[]'
              ) AS tags
         FROM public.agents a
         LEFT JOIN public.agent_tags at2 ON at2.agent_id = a.id
         LEFT JOIN public.tags t ON t.id = at2.tag_id
        GROUP BY a.id
        ORDER BY a.created_at ASC`
    );
    const rows = result.rows.map((r) => ({ ...r, tags: (r.tags || []).map((t) => t.name).join(' | ') }));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="badman-agents-${stamp}.json"`);
      return res.json(rows);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="badman-agents-${stamp}.csv"`);
    res.send(toCsv(rows, AGENT_EXPORT_COLUMNS));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export one agent's command history
app.get('/api/agents/:id/history/export', authenticateToken, async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const format = (req.query.format || 'csv').toLowerCase();
    const result = await pool.query(
      `SELECT id, command, output, executed_at, operator_username
         FROM public.command_logs WHERE agent_id = $1
        ORDER BY executed_at DESC LIMIT 10000`,
      [agent.id]
    );
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `badman-history-${String(agent.hostname || 'agent').replace(/[^\w.-]+/g, '_')}-${stamp}`;
    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
      return res.json(result.rows);
    }
    const cols = [
      { key: 'executed_at', label: 'executed_at' },
      { key: 'operator_username', label: 'operator' },
      { key: 'command', label: 'command' },
      { key: 'output', label: 'output' }
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    res.send(toCsv(result.rows, cols));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Version-proof SPA catch-all: any non-API GET serves the React app.
// (Replaces the Express 5 '*splat' wildcard, which silently failed to match
// some deep routes and returned 404 on page refresh.)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    const indexFile = path.join(clientDistPath, 'index.html');
    if (fs.existsSync(indexFile)) {
      return res.sendFile(indexFile);
    }
    // Dist not built yet — say so instead of a confusing 404
    return res
      .status(503)
      .send('Client build not found. Run: cd client && npm run build');
  }
  next();
});

const server = http.createServer(app);

// ---------- WebSocket server ----------
const wss = new WebSocketServer({ server });

// Maps to track connections
const agentConnections = new Map(); // agentId -> WebSocket
const operatorConnections = new Map(); // username -> Set<WebSocket> (multi-tab safe)

// Pending script runs: `${agentId}:${runId}` -> { content, operator } (for logging results)
const pendingScripts = new Map(); // agentId -> array of { command, operator, loggedAt }

function sendToAgent(agentId, message) {
  const ws = agentConnections.get(agentId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify(message);
    wsMetrics.messagesOut += 1;
    wsMetrics.bytesOut += Buffer.byteLength(payload, 'utf8');
    bumpThroughput('out');
    ws.send(payload);
    return true;
  }
  return false;
}

function broadcastToOperators(message) {
  const payload = JSON.stringify(message);
  for (const set of operatorConnections.values()) {
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        wsMetrics.messagesOut += 1;
        wsMetrics.bytesOut += Buffer.byteLength(payload, 'utf8');
        bumpThroughput('out');
        ws.send(payload);
      }
    }
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const token = url.searchParams.get('token');
  const enroll = url.searchParams.get('enroll');

  if (path === '/ws/agent') {
    // Best-effort public IP capture (agents behind NAT report their own IP at register)
    let connectIp = req.socket.remoteAddress || null;
    if (connectIp && connectIp.startsWith('::ffff:')) connectIp = connectIp.slice(7);
    handleAgentConnection(ws, token, enroll, connectIp);
  } else if (path === '/ws/operator') {
    handleOperatorConnection(ws, token);
  } else {
    ws.close(4000, 'Invalid path');
  }
});

// Agent connection handling
async function handleAgentConnection(ws, token, enroll, connectIp) {
  if (!token) {
    ws.close(4001, 'Missing token');
    return;
  }

  // Attach handlers IMMEDIATELY and buffer messages received while auth is
  // in progress — otherwise early messages (like the agent's `register`, sent
  // in on_open) are dropped because no 'message' listener exists yet.
  let agent = null;
  let accepted = false; // becomes true only once the connection is fully accepted
  const pending = [];

  ws.on('message', (data) => {
    wsMetrics.messagesIn += 1;
    wsMetrics.bytesIn += data?.length || 0;
    bumpThroughput('in');
    if (!agent) {
      pending.push(data);
      return;
    }
    handleAgentMessage(agent, data);
  });

  ws.on('close', async () => {
    if (!agent) return;
    // Identity check: only treat this as a disconnect if THIS socket is still
    // the registered one. Prevents a rejected-at-door connection (banned
    // token) from broadcasting a bogus 'offline', and prevents a reconnect
    // race where the old socket's close event flips the freshly-connected
    // agent offline.
    if (!accepted || agentConnections.get(agent.id) !== ws) return;
    agentConnections.delete(agent.id);
    pendingScripts.delete(agent.id);
    try {
      await pool.query(
        "UPDATE public.agents SET status = 'offline', last_seen = now() WHERE id = $1 AND banned = false",
        [agent.id]
      );
    } catch (err) {
      console.error('Agent offline update error:', err);
    }
    broadcastToOperators({
      type: 'agent_status',
      agent: { id: agent.id, hostname: agent.hostname, status: 'offline', last_seen: new Date().toISOString() }
    });
    console.log(`Agent ${agent.id} disconnected`);
  });

  // Authenticate
  try {
    const result = await pool.query(
      'SELECT * FROM public.agents WHERE agent_token = $1 LIMIT 1',
      [token]
    );
    agent = result.rows[0];
  } catch (err) {
    console.error('Agent lookup error:', err);
    ws.close(4002, 'Invalid token');
    return;
  }

  if (!agent) {
    // Unknown token → auto-enroll ONLY if the pre-shared secret matches
    if (!AGENT_ENROLL_SECRET || enroll !== AGENT_ENROLL_SECRET) {
      ws.close(4002, 'Invalid token');
      return;
    }
    try {
      const inserted = await pool.query(
        "INSERT INTO public.agents (agent_token, hostname, status, ip_address) VALUES ($1, 'pending', 'offline', $2) " +
        "ON CONFLICT (agent_token) DO UPDATE SET agent_token = EXCLUDED.agent_token RETURNING *",
        [token, connectIp]
      );
      agent = inserted.rows[0];
      console.log(`Agent auto-enrolled: ${token}`);
    } catch (err) {
      console.error('Agent enrollment error:', err);
      ws.close(4002, 'Invalid token');
      return;
    }
  }

  // NEW: banned agents are rejected at the door
  if (agent.banned) {
    wsMetrics.bannedRejectedTotal += 1;
    ws.close(4004, 'Agent banned');
    return;
  }

  agentConnections.set(agent.id, ws);
  accepted = true;
  wsMetrics.agentConnectionsTotal += 1;

  try {
    await pool.query(
      "UPDATE public.agents SET status = 'online', last_seen = now(), ip_address = COALESCE(ip_address, $2) WHERE id = $1",
      [agent.id, connectIp]
    );
  } catch (err) {
    console.error('Agent status update error:', err);
  }

  broadcastToOperators({
    type: 'agent_status',
    agent: { id: agent.id, hostname: agent.hostname, status: 'online', last_seen: new Date().toISOString() }
  });

  // Replay any messages that arrived while auth was completing
  for (const data of pending) {
    handleAgentMessage(agent, data);
  }
}

async function handleAgentMessage(agent, data) {
  try {
    const message = JSON.parse(data.toString());
    if (message.type === 'register') {
      // Store everything the agent reports. New optional fields (os_name,
      // os_arch, platform, username, country, country_code, isp) are kept when
      // present; older agents that only send `os` still work unchanged.
      await pool.query(
        `UPDATE public.agents SET
           hostname = COALESCE($2, hostname),
           ip_address = COALESCE($3, ip_address),
           os_version = COALESCE($4, os_version),
           os_name = COALESCE($5, os_name),
           os_arch = COALESCE($6, os_arch),
           platform = COALESCE($7, platform),
           username = COALESCE($8, username),
           country = COALESCE($9, country),
           country_code = COALESCE($10, country_code),
           isp = COALESCE($11, isp),
           last_seen = now()
         WHERE id = $1`,
        [
          agent.id,
          message.hostname || null,
          message.ip || null,
          message.os_version || message.os || null,
          message.os_name || null,
          message.arch || null,
          message.platform || null,
          message.username || null,
          message.country || null,
          message.country_code || null,
          message.isp || null
        ]
      );
      // Fill in country/ISP from the reported IP when the agent didn't provide it
      const geoIp = message.ip || null;
      enrichAgentGeo(agent.id, geoIp).catch(() => {});
      // Push the refreshed row (with tags) to every open console
      try {
        const fresh = await getAgentWithTags(agent.id);
        if (fresh) {
          broadcastToOperators({ type: 'agent_status', agent: { ...fresh, status: 'online' } });
        }
      } catch (e) { /* non-fatal */ }
      console.log(`Agent ${agent.id} registered: ${message.hostname}`);
    } else if (message.type === 'heartbeat') {
      await pool.query(
        'UPDATE public.agents SET last_seen = now() WHERE id = $1',
        [agent.id]
      );
    } else if (message.type === 'terminal_output' || message.type === 'script_result') {
      broadcastToOperators({
        type: message.type,
        agent_id: agent.id,
        data: message
      });
      // Persist script results so output is NEVER lost if the console misses the event
      if (message.type === 'script_result') {
        const output = typeof message.output === 'string'
          ? message.output
          : (typeof message.data === 'string' ? message.data : '');
        try {
          const updated = await pool.query(
            `UPDATE public.command_logs
                SET output = $2
              WHERE id = (
                SELECT id FROM public.command_logs
                 WHERE agent_id = $1 AND (output IS NULL OR output = '')
                 ORDER BY executed_at DESC LIMIT 1
              ) RETURNING id`,
            [agent.id, output]
          );
          if (updated.rowCount === 0) {
            await pool.query(
              'INSERT INTO public.command_logs (agent_id, command, output, operator_username) VALUES ($1, $2, $3, $4)',
              [agent.id, '(unsaved run)', output, 'agent']
            );
          }
        } catch (err) {
          console.error('Command log update error:', err);
        }
      }
    }
  } catch (err) {
    console.error('Error parsing agent message:', err);
  }
}

// Operator connection handling (validates JWT)
function handleOperatorConnection(ws, token) {
  if (!token) {
    ws.close(4001, 'Missing token');
    return;
  }

  let username;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    username = decoded.username;
  } catch (err) {
    ws.close(4003, 'Invalid token');
    return;
  }

  // Multi-tab safe: one username can hold several concurrent consoles
  let set = operatorConnections.get(username);
  if (!set) {
    set = new Set();
    operatorConnections.set(username, set);
  }
  set.add(ws);
  wsMetrics.operatorConnectionsTotal += 1;
  console.log(`Operator connected: ${username} (${set.size} session(s))`);

  ws.on('message', (data) => {
    try {
      wsMetrics.messagesIn += 1;
      wsMetrics.bytesIn += data?.length || 0;
      bumpThroughput('in');
      const message = JSON.parse(data.toString());
      if (message.action === 'terminal_start') {
        if (!sendToAgent(message.agent_id, { type: 'terminal_start', shell: message.shell })) {
          ws.send(JSON.stringify({ type: 'terminal_error', agent_id: message.agent_id, data: { error: 'Agent offline' } }));
        }
      } else if (message.action === 'terminal_input') {
        sendToAgent(message.agent_id, { type: 'terminal_input', data: message.data });
      } else if (message.action === 'terminal_resize') {
        sendToAgent(message.agent_id, { type: 'terminal_resize', cols: message.cols, rows: message.rows });
      } else if (message.action === 'terminal_stop') {
        sendToAgent(message.agent_id, { type: 'terminal_stop' });
      } else if (message.action === 'script_run') {
        const content = typeof message.content === 'string' ? message.content : '';
        if (!content.trim()) {
          wsMetrics.scriptErrorsTotal += 1;
          ws.send(JSON.stringify({ type: 'script_error', agent_id: null, data: { error: 'Empty script' } }));
          return;
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) {
          wsMetrics.scriptErrorsTotal += 1;
          ws.send(JSON.stringify({ type: 'script_error', agent_id: null, data: { error: 'Script too large' } }));
          return;
        }
        const targets = Array.isArray(message.agent_ids) ? message.agent_ids : [];
        for (const agentId of targets) {
          const ok = sendToAgent(agentId, { type: 'script_run', language: message.language, content });
          if (ok) {
            wsMetrics.scriptRunsTotal += 1;
            // Track the run so its result can be persisted when it comes back
            const list = pendingScripts.get(agentId) || [];
            list.push({ command: content, operator: username, loggedAt: Date.now() });
            pendingScripts.set(agentId, list.slice(-20)); // keep last 20 runs per agent
            pool.query(
              'INSERT INTO public.command_logs (agent_id, command, output, operator_username) VALUES ($1, $2, $3, $4)',
              [agentId, content, '', username]
            ).catch((err) => console.error('Command log insert error:', err));
          } else {
            // The old server silently dropped offline targets — the console
            // never knew why nothing happened. Now it does.
            wsMetrics.scriptErrorsTotal += 1;
            ws.send(JSON.stringify({ type: 'script_error', agent_id: agentId, data: { error: 'Agent offline' } }));
          }
        }
      }
    } catch (err) {
      console.error('Error parsing operator message:', err);
    }
  });

  ws.on('close', () => {
    const set = operatorConnections.get(username);
    if (set) {
      set.delete(ws);
      if (set.size === 0) operatorConnections.delete(username);
    }
    console.log(`Operator disconnected: ${username}`);
  });
}

// ---------- Stale-agent reaper ----------
// Agents whose connection died without a clean close (crash, network drop)
// would otherwise stay 'online' until the next server restart.
const reaper = setInterval(async () => {
  try {
    const stale = await pool.query(
      `SELECT id, hostname FROM public.agents
        WHERE status = 'online'
          AND banned = false
          AND (last_seen IS NULL OR last_seen < now() - interval '90 seconds')`
    );
    for (const row of stale.rows) {
      if (agentConnections.has(row.id)) continue; // socket still alive, skip
      await pool.query("UPDATE public.agents SET status = 'offline' WHERE id = $1", [row.id]);
      broadcastToOperators({
        type: 'agent_status',
        agent: { id: row.id, hostname: row.hostname, status: 'offline', last_seen: new Date().toISOString() }
      });
      console.log(`Reaper marked agent ${row.hostname || row.id} offline`);
    }
  } catch (err) {
    // table might not exist yet on a fresh DB — ignore quietly
  }
}, REAPER_INTERVAL_MS);
reaper.unref();

// ---------- Fleet snapshot (5-min KPI history for the timeline chart) ----------
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
async function captureFleetSnapshot() {
  try {
    const r = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'online' AND banned = false) AS online,
              count(*) FILTER (WHERE status <> 'online' AND banned = false) AS offline,
              count(*) FILTER (WHERE banned = true) AS banned,
              count(*) AS total
         FROM public.agents`
    );
    const row = r.rows[0] || {};
    await pool.query(
      'INSERT INTO public.metrics_snapshots (online, offline, banned, total) VALUES ($1, $2, $3, $4)',
      [Number(row.online) || 0, Number(row.offline) || 0, Number(row.banned) || 0, Number(row.total) || 0]
    );
  } catch (err) {
    // table may not exist yet on a fresh DB — retried on the next tick
  }
}
const snapshotTimer = setInterval(captureFleetSnapshot, SNAPSHOT_INTERVAL_MS);
snapshotTimer.unref();
captureFleetSnapshot(); // seed immediately so the timeline chart is never empty

// ---------- Log retention (command_logs purge) ----------
// Disabled unless configured via env:
//   LOG_RETENTION_DAYS=30            -> purge rows older than 30 days (batched)
//   LOG_RETENTION_MAX_PER_AGENT=1000 -> keep at most 1000 rows per agent
// Sweeps hourly (and once at boot). metrics_snapshots older than 30 days are pruned too.
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '0', 10);
const LOG_RETENTION_MAX_PER_AGENT = parseInt(process.env.LOG_RETENTION_MAX_PER_AGENT || '0', 10);
const RETENTION_SWEEP_MS = 60 * 60 * 1000;

async function runRetentionSweep() {
  if (LOG_RETENTION_DAYS <= 0 && LOG_RETENTION_MAX_PER_AGENT <= 0) return;
  const started = Date.now();
  try {
    let purged = 0;
    if (LOG_RETENTION_DAYS > 0) {
      for (;;) {
        const r = await pool.query(
          `DELETE FROM public.command_logs
            WHERE id IN (
              SELECT id FROM public.command_logs
               WHERE executed_at < now() - ($1 || ' days')::interval
               LIMIT 500)`,
          [String(LOG_RETENTION_DAYS)]
        );
        purged += r.rowCount || 0;
        if ((r.rowCount || 0) < 500) break;
      }
      await pool.query("DELETE FROM public.metrics_snapshots WHERE captured_at < now() - interval '30 days'");
    }
    let capped = 0;
    if (LOG_RETENTION_MAX_PER_AGENT > 0) {
      for (;;) {
        const r = await pool.query(
          `DELETE FROM public.command_logs
            WHERE id IN (
              SELECT id FROM (
                SELECT id, row_number() OVER (PARTITION BY agent_id ORDER BY executed_at DESC) AS rn
                  FROM public.command_logs) ranked
              WHERE rn > $1 LIMIT 500)`,
          [LOG_RETENTION_MAX_PER_AGENT]
        );
        capped += r.rowCount || 0;
        if ((r.rowCount || 0) < 500) break;
      }
    }
    if (purged || capped) {
      console.log(`[retention] purged ${purged} by age, capped ${capped} by count in ${Date.now() - started}ms`);
    }
  } catch (err) {
    // tables may not exist yet on a fresh DB — retried on the next sweep
  }
}
runRetentionSweep(); // sweep once at boot so backlog is cleaned immediately
const retentionTimer = setInterval(runRetentionSweep, RETENTION_SWEEP_MS);
retentionTimer.unref();

// Reset any stale 'online' statuses left over from a previous run or crash
(async () => {
  try {
    await pool.query("UPDATE public.agents SET status = 'offline' WHERE status = 'online'");
    console.log('Reset stale agent statuses to offline');
  } catch (err) {
    console.error('Failed to reset agent statuses:', err.message);
  }
})();

// ---------- Start server ----------
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
