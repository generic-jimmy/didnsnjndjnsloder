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
const geoCache = new Map(); // ip -> { country, country_code, isp }

async function enrichAgentGeo(agentId, ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.16.')) return;
  try {
    let geo = geoCache.get(ip);
    if (!geo) {
      const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,isp`, {
        signal: AbortSignal.timeout(3000)
      });
      const data = await res.json();
      if (data?.status === 'success') {
        geo = { country: data.country || null, country_code: data.countryCode || null, isp: data.isp || null };
        geoCache.set(ip, geo);
        if (geoCache.size > 5000) geoCache.clear(); // simple bound
      } else {
        geoCache.set(ip, { country: null, country_code: null, isp: null });
        return;
      }
    }
    await pool.query(
      `UPDATE public.agents
         SET country = COALESCE(country, $2),
             country_code = COALESCE(country_code, $3),
             isp = COALESCE(isp, $4)
       WHERE id = $1 AND (country_code IS NULL OR isp IS NULL)`,
      [agentId, geo.country, geo.country_code, geo.isp]
    );
  } catch (err) {
    // geo lookup is best-effort only
  }
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
// Login endpoint: returns JWT if credentials match
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== OPERATOR_USERNAME) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const passwordMatch = await bcrypt.compare(password || '', operatorPasswordHash);
  if (!passwordMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
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

// Helper: kick a live agent connection (used by ban/delete)
function kickAgent(agentId, code, reason) {
  const ws = agentConnections.get(agentId);
  if (ws) {
    try { ws.close(code, reason); } catch (e) { /* noop */ }
    agentConnections.delete(agentId);
  }
}

// Get agents list (protected)
app.get('/api/agents', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, hostname, ip_address, os_name, os_version, os_arch, platform, username,
              country, country_code, isp, status, banned, ban_reason, created_at, last_seen
         FROM public.agents ORDER BY created_at ASC`
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
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function broadcastToOperators(message) {
  for (const set of operatorConnections.values()) {
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
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
    ws.close(4004, 'Agent banned');
    return;
  }

  agentConnections.set(agent.id, ws);
  accepted = true;

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
      // Push the refreshed row to every open console
      try {
        const fresh = await getAgent(agent.id);
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
  console.log(`Operator connected: ${username} (${set.size} session(s))`);

  ws.on('message', (data) => {
    try {
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
          ws.send(JSON.stringify({ type: 'script_error', agent_id: null, data: { error: 'Empty script' } }));
          return;
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) {
          ws.send(JSON.stringify({ type: 'script_error', agent_id: null, data: { error: 'Script too large' } }));
          return;
        }
        const targets = Array.isArray(message.agent_ids) ? message.agent_ids : [];
        for (const agentId of targets) {
          const ok = sendToAgent(agentId, { type: 'script_run', language: message.language, content });
          if (ok) {
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
