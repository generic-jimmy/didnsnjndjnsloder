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
const OPERATOR_USERNAME = process.env.OPERATOR_USERNAME || 'admin';
const OPERATOR_PASSWORD_HASH = process.env.OPERATOR_PASSWORD_HASH; // Store bcrypt hash of password
// If no hash provided, create a default hash for 'password' at startup (for dev only)
const defaultHash = bcrypt.hashSync('password', 10);
const operatorPasswordHash = OPERATOR_PASSWORD_HASH || defaultHash;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable');
  process.exit(1);
}

// Direct PostgreSQL connection (bypasses RLS; Supabase requires TLS)
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
  process.exit(1);
});

// ---------- Express app ----------
const app = express();
app.use(express.json());

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
  const passwordMatch = await bcrypt.compare(password, operatorPasswordHash);
  if (!passwordMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1h' });
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

// Get agents list (protected)
app.get('/api/agents', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM public.agents ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save script (protected)
app.post('/api/scripts', authenticateToken, async (req, res) => {
  const { name, language, content } = req.body;
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

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Catch-all: serve index.html for SPA routes (Express 5 uses named wildcards; never serve HTML for /api)
app.get('*splat', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

const server = http.createServer(app);

// ---------- WebSocket server ----------
const wss = new WebSocketServer({ server });

// Maps to track connections
const agentConnections = new Map(); // agentId -> WebSocket
const operatorConnections = new Map(); // username -> WebSocket

// Helper functions (same as before)
function sendToAgent(agentId, message) {
  const ws = agentConnections.get(agentId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastToOperators(message) {
  for (const ws of operatorConnections.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const token = url.searchParams.get('token');

  if (path === '/ws/agent') {
    handleAgentConnection(ws, token);
  } else if (path === '/ws/operator') {
    handleOperatorConnection(ws, token);
  } else {
    ws.close(4000, 'Invalid path');
  }
});

// Agent connection handling
async function handleAgentConnection(ws, token) {
  if (!token) {
    ws.close(4001, 'Missing token');
    return;
  }

  // Attach handlers IMMEDIATELY and buffer messages received while auth is
  // in progress — otherwise early messages (like the agent's `register`, sent
  // in on_open) are dropped because no 'message' listener exists yet.
  let agent = null;
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
    agentConnections.delete(agent.id);
    try {
      await pool.query(
        "UPDATE public.agents SET status = 'offline' WHERE id = $1",
        [agent.id]
      );
    } catch (err) {
      console.error('Agent offline update error:', err);
    }
    broadcastToOperators({
      type: 'agent_status',
      agent: { id: agent.id, hostname: agent.hostname, status: 'offline' }
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
    ws.close(4002, 'Invalid token');
    return;
  }

  agentConnections.set(agent.id, ws);

  try {
    await pool.query(
      "UPDATE public.agents SET status = 'online', last_seen = now() WHERE id = $1",
      [agent.id]
    );
  } catch (err) {
    console.error('Agent status update error:', err);
  }

  broadcastToOperators({
    type: 'agent_status',
    agent: { id: agent.id, hostname: agent.hostname, status: 'online' }
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
      await pool.query(
        'UPDATE public.agents SET hostname = $1, ip_address = $2, os_version = $3 WHERE id = $4',
        [message.hostname, message.ip, message.os, agent.id]
      );
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

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;
    operatorConnections.set(username, ws);
    console.log(`Operator connected: ${username}`);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.action === 'terminal_start') {
          sendToAgent(message.agent_id, { type: 'terminal_start', shell: message.shell });
        } else if (message.action === 'terminal_input') {
          sendToAgent(message.agent_id, { type: 'terminal_input', data: message.data });
        } else if (message.action === 'terminal_resize') {
          sendToAgent(message.agent_id, { type: 'terminal_resize', cols: message.cols, rows: message.rows });
        } else if (message.action === 'terminal_stop') {
          sendToAgent(message.agent_id, { type: 'terminal_stop' });
        } else if (message.action === 'script_run') {
          for (const agentId of message.agent_ids) {
            sendToAgent(agentId, { type: 'script_run', language: message.language, content: message.content });
          }
        }
      } catch (err) {
        console.error('Error parsing operator message:', err);
      }
    });

    ws.on('close', () => {
      operatorConnections.delete(username);
      console.log(`Operator disconnected: ${username}`);
    });
  } catch (err) {
    ws.close(4003, 'Invalid token');
  }
}

// ---------- Start server ----------
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});