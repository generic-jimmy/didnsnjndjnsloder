// Smoke test for the upgraded server: mocks PostgreSQL with an in-memory
// store (bun mock.module), then exercises the real HTTP + WS logic:
// login, agents list, agent connect/register/heartbeat, operator relay,
// script_run + script_error, ban/unban/delete, command_logs, history.
import { mock, describe, test, expect, beforeAll } from 'bun:test';
import fs from 'fs';

// ---------- in-memory "postgres" ----------
const agents = new Map(); // id -> row
const logs = [];          // command_logs rows
const scripts = [];
let seq = 0;
const id = () => `id-${++seq}`;
const uuid = 'a1b2c3d4-0000-4000-8000-000000000000';

function matchQuery(text, params) {
  const t = text.replace(/\s+/g, ' ').trim();

  // register update
  if (t.startsWith('UPDATE public.agents SET hostname = COALESCE')) {
    const a = agents.get(params[0]);
    if (a) Object.assign(a, {
      hostname: params[1] ?? a.hostname,
      ip_address: params[2] ?? a.ip_address,
      os_version: params[3] ?? a.os_version,
      os_name: params[4] ?? a.os_name,
      os_arch: params[5] ?? a.os_arch,
      platform: params[6] ?? a.platform,
      username: params[7] ?? a.username,
      country: params[8] ?? a.country,
      country_code: params[9] ?? a.country_code,
      isp: params[10] ?? a.isp
    });
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  // agent status online on connect
  if (t.startsWith("UPDATE public.agents SET status = 'online'")) {
    const a = agents.get(params[0]);
    if (a) { a.status = 'online'; a.last_seen = new Date(); if (params[1] && !a.ip_address) a.ip_address = params[1]; }
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  // heartbeat
  if (t.startsWith('UPDATE public.agents SET last_seen = now() WHERE id')) {
    const a = agents.get(params[0]);
    if (a) a.last_seen = new Date();
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  // offline on disconnect
  if (t.startsWith("UPDATE public.agents SET status = 'offline', last_seen = now()")) {
    const a = agents.get(params[0]);
    if (a && !a.banned) a.status = 'offline';
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  // offline on boot reset
  if (t.includes("UPDATE public.agents SET status = 'offline' WHERE status = 'online'")) {
    let n = 0;
    for (const a of agents.values()) if (a.status === 'online') { a.status = 'offline'; n++; }
    return { rows: [], rowCount: n };
  }
  // offline from reaper
  if (t.startsWith("UPDATE public.agents SET status = 'offline' WHERE id = $1") && t.includes('Reaper') === false) {
    const a = agents.get(params[0]);
    if (a) a.status = 'offline';
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  // select by token
  if (t.startsWith('SELECT * FROM public.agents WHERE agent_token')) {
    const row = [...agents.values()].find((a) => a.agent_token === params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  // getAgent by id
  if (t.startsWith('SELECT * FROM public.agents WHERE id = $1')) {
    const row = agents.get(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  // list agents (management endpoints)
  if (t.startsWith('SELECT id, hostname')) {
    return { rows: [...agents.values()], rowCount: agents.size };
  }
  // auto-enroll insert
  if (t.startsWith('INSERT INTO public.agents')) {
    const row = { id: uuid + (seq++), agent_token: params[0], hostname: 'pending', status: 'offline', ip_address: params[1], banned: false };
    agents.set(row.id, row);
    return { rows: [row], rowCount: 1 };
  }
  // ban
  if (t.startsWith('UPDATE public.agents SET banned = true')) {
    const a = agents.get(params[0]);
    if (a) { a.banned = true; a.ban_reason = params[1]; a.status = 'banned'; }
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  // unban
  if (t.startsWith('UPDATE public.agents SET banned = false')) {
    const a = agents.get(params[0]);
    if (a) { a.banned = false; a.ban_reason = null; a.status = 'offline'; }
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  // delete agent
  if (t.startsWith('DELETE FROM public.agents WHERE id')) {
    const had = agents.delete(params[0]);
    return { rows: [], rowCount: had ? 1 : 0 };
  }
  // insert command log
  if (t.startsWith('INSERT INTO public.command_logs')) {
    const row = { id: id(), agent_id: params[0], command: params[1], output: params[2] ?? '', operator_username: params[3], executed_at: new Date().toISOString() };
    logs.push(row);
    return { rows: [row], rowCount: 1 };
  }
  // update command log output (script result)
  if (t.startsWith('UPDATE public.command_logs') && t.includes('SET output = $2')) {
    const list = logs.filter((l) => l.agent_id === params[0] && (l.output === '' || l.output === null))
      .sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));
    if (list.length > 0) { list[0].output = params[1]; return { rows: [list[0]], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
  // history
  if (t.startsWith('SELECT id, command, output, executed_at, operator_username')) {
    const list = logs.filter((l) => l.agent_id === params[0]).slice(0, params[1]);
    return { rows: list, rowCount: list.length };
  }
  // insert script
  if (t.startsWith('INSERT INTO public.scripts')) {
    const row = { id: id(), name: params[0], language: params[1], content: params[2], created_by: params[3], created_at: new Date().toISOString() };
    scripts.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (t.startsWith('SELECT * FROM public.scripts ORDER BY created_at DESC')) {
    return { rows: [...scripts].reverse(), rowCount: scripts.length };
  }
  if (t.startsWith('DELETE FROM public.scripts WHERE id')) {
    const i = scripts.findIndex((s) => s.id === params[0]);
    if (i >= 0) scripts.splice(i, 1);
    return { rows: [], rowCount: i >= 0 ? 1 : 0 };
  }
  console.error('UNMATCHED QUERY:', t.slice(0, 120));
  return { rows: [], rowCount: 0 };
}

mock.module('pg', () => ({
  default: {
    Pool: class Pool {
      constructor() {}
      on() {}
      async query(text, params = []) {
        return matchQuery(text, params);
      }
      end() {}
    }
  },
  Pool: class Pool2 {
    constructor() {}
    on() {}
    async query(text, params = []) { return matchQuery(text, params); }
    end() {}
  }
}));

process.env.DATABASE_URL = 'postgres://mock:mock@localhost/mock';
process.env.PORT = '4444';
process.env.JWT_SECRET = 'test-secret';
process.env.DB_SSL = 'false';

// Seed one known agent + one banned agent
const AGENT_ID = uuid + '100';
const BANNED_ID = uuid + '200';
agents.set(AGENT_ID, {
  id: AGENT_ID, agent_token: 'TOKEN-OK', hostname: 'PC-ALPHA', status: 'offline',
  banned: false, created_at: new Date().toISOString(), last_seen: new Date().toISOString()
});
agents.set(BANNED_ID, {
  id: BANNED_ID, agent_token: 'TOKEN-BANNED', hostname: 'PC-BAD', status: 'offline',
  banned: true, ban_reason: 'test', created_at: new Date().toISOString(), last_seen: null
});

const { WebSocket } = await import('ws');

const BASE = 'http://127.0.0.1:4444';
let operatorToken = '';
let opWs = null;
let opMessages = [];
let waiters = [];

function nextOpMessage(type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const idx = opMessages.findIndex((m) => !type || m.type === type);
    if (idx >= 0) return resolve(opMessages.splice(idx, 1)[0]);
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}; got ${JSON.stringify(opMessages.map(m=>m.type))}`)), timeoutMs);
    waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
}
function pump(msg) {
  opMessages.push(msg);
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    const idx = opMessages.findIndex((m) => m.type === w.type);
    if (idx >= 0) {
      waiters.splice(i, 1);
      w.resolve(opMessages.splice(idx, 1)[0]);
      break;
    }
  }
}

async function startServer() {
  await import('./server.js');
  // wait for listen
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up on 4444');
}

describe('Badman upgraded server', () => {
  beforeAll(async () => {
    // the SPA catch-all serves client/dist/index.html — create a stub for tests
    const distDir = new URL('../client/dist/', import.meta.url).pathname;
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(distDir + 'index.html', '<html><body>stub</body></html>');
    await startServer();
  }, 30000);

  test('health + login', async () => {
    const h = await fetch(`${BASE}/health`);
    expect(await h.json()).toEqual({ status: 'ok' });
    const bad = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
    expect(bad.status).toBe(401);
    const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password' }) });
    expect(res.status).toBe(200);
    operatorToken = (await res.json()).token;
    expect(operatorToken.length).toBeGreaterThan(10);
  });

  test('agents list requires auth and returns seeded rows', async () => {
    const noAuth = await fetch(`${BASE}/api/agents`);
    expect(noAuth.status).toBe(401);
    const res = await fetch(`${BASE}/api/agents`, { headers: { authorization: `Bearer ${operatorToken}` } });
    const rows = await res.json();
    expect(rows.length).toBe(2);
    expect(rows[0].hostname).toBe('PC-ALPHA');
  });

  test('operator websocket connects', async () => {
    opWs = new WebSocket(`ws://127.0.0.1:4444/ws/operator?token=${operatorToken}`);
    await new Promise((resolve, reject) => {
      opWs.on('open', resolve);
      opWs.on('error', reject);
    });
    opWs.on('message', (d) => pump(JSON.parse(d.toString())));
    await new Promise((r) => setTimeout(r, 200));
  });

  test('banned agent is rejected at the door (close 4004)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:4444/ws/agent?token=TOKEN-BANNED`);
    const code = await new Promise((resolve) => {
      ws.on('close', (c) => resolve(c));
      ws.on('open', () => { /* server should close us */ });
    });
    expect(code).toBe(4004);
  });

  test('agent connects, registers with full details, heartbeats', async () => {
    // flush any stale broadcasts from earlier tests
    opMessages.length = 0; waiters.length = 0;
    const agentWs = new WebSocket(`ws://127.0.0.1:4444/ws/agent?token=TOKEN-OK`);
    await new Promise((resolve, reject) => {
      agentWs.on('open', resolve);
      agentWs.on('error', reject);
      agentWs.on('close', (c, r) => reject(new Error(`closed ${c} ${r}`)));
    });
    agentWs.send(JSON.stringify({
      type: 'register',
      hostname: 'WIN-SRV-01',
      ip: '8.8.8.8',
      os: 'Windows Server 2022',
      os_name: 'windows',
      arch: 'x86_64',
      platform: 'win32',
      username: 'operator',
      country_code: 'DE'
    }));
    agentWs.send(JSON.stringify({ type: 'heartbeat' }));
    const statusMsg = await nextOpMessage('agent_status');
    expect(statusMsg.agent.status).toBe('online');
    // register triggers a refreshed agent_status broadcast with full details
    const regMsg = await nextOpMessage('agent_status');
    expect(regMsg.agent.hostname).toBe('WIN-SRV-01');
    expect(regMsg.agent.os_arch).toBe('x86_64');
    expect(regMsg.agent.country_code).toBe('DE');
    global.__agentWs = agentWs;
  });

  test('terminal_start relays to agent', async () => {
    opWs.send(JSON.stringify({ action: 'terminal_start', agent_id: AGENT_ID, shell: 'cmd' }));
    const msg = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no relay')), 3000);
      global.__agentWs.on('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
    });
    expect(msg.type).toBe('terminal_start');
    expect(msg.shell).toBe('cmd');
  });

  test('terminal_output flows agent -> operator', async () => {
    global.__agentWs.send(JSON.stringify({ type: 'terminal_output', data: 'C:\\> echo hello' }));
    const msg = await nextOpMessage('terminal_output');
    expect(msg.data.data).toBe('C:\\> echo hello');
  });

  test('script_run to OFFLINE agent -> script_error (was silent before!)', async () => {
    opWs.send(JSON.stringify({ action: 'script_run', agent_ids: [BANNED_ID], language: 'powershell', content: 'whoami' }));
    const msg = await nextOpMessage('script_error');
    expect(msg.agent_id).toBe(BANNED_ID);
    expect(msg.data.error).toBe('Agent offline');
  });

  test('script_run online -> logged, result persisted, operator receives it', async () => {
    opWs.send(JSON.stringify({ action: 'script_run', agent_ids: [AGENT_ID], language: 'powershell', content: 'Get-Process' }));
    await new Promise((r) => setTimeout(r, 300));
    global.__agentWs.send(JSON.stringify({ type: 'script_result', output: 'chrome.exe pid 4242' }));
    const msg = await nextOpMessage('script_result');
    expect(msg.data.output).toBe('chrome.exe pid 4242');
    await new Promise((r) => setTimeout(r, 300));
    const hist = await fetch(`${BASE}/api/agents/${AGENT_ID}/history`, { headers: { authorization: `Bearer ${operatorToken}` } });
    const rows = await hist.json();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].output).toBe('chrome.exe pid 4242');
    expect(rows[0].command).toBe('Get-Process');
  });

  test('saved scripts round-trip', async () => {
    const save = await fetch(`${BASE}/api/scripts`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` }, body: JSON.stringify({ name: 'enum', language: 'powershell', content: 'Get-Service' }) });
    expect(save.status).toBe(200);
    const list = await fetch(`${BASE}/api/scripts`, { headers: { authorization: `Bearer ${operatorToken}` } });
    const rows = await list.json();
    expect(rows[0].name).toBe('enum');
    const del = await fetch(`${BASE}/api/scripts/${rows[0].id}`, { method: 'DELETE', headers: { authorization: `Bearer ${operatorToken}` } });
    expect(del.status).toBe(200);
  });

  test('ban kicks the live agent + rejects reconnect; unban restores', async () => {
    const kicked = new Promise((resolve) => global.__agentWs.on('close', (c) => resolve(c)));
    const res = await fetch(`${BASE}/api/agents/${AGENT_ID}/ban`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` }, body: JSON.stringify({ reason: 'testing' }) });
    expect(res.status).toBe(200);
    const code = await kicked;
    expect(code).toBe(4004);
    // reconnect attempt rejected
    const ws2 = new WebSocket(`ws://127.0.0.1:4444/ws/agent?token=TOKEN-OK`);
    const code2 = await new Promise((resolve) => ws2.on('close', (c) => resolve(c)));
    expect(code2).toBe(4004);
    const unban = await fetch(`${BASE}/api/agents/${AGENT_ID}/unban`, { method: 'POST', headers: { authorization: `Bearer ${operatorToken}` } });
    expect(unban.status).toBe(200);
    // now reconnect works
    const ws3 = new WebSocket(`ws://127.0.0.1:4444/ws/agent?token=TOKEN-OK`);
    await new Promise((resolve, reject) => { ws3.on('open', resolve); ws3.on('error', reject); });
    ws3.close();
  });

  test('delete agent removes row and broadcasts agent_removed', async () => {
    const res = await fetch(`${BASE}/api/agents/${BANNED_ID}`, { method: 'DELETE', headers: { authorization: `Bearer ${operatorToken}` } });
    expect(res.status).toBe(200);
    const list = await fetch(`${BASE}/api/agents`, { headers: { authorization: `Bearer ${operatorToken}` } });
    const rows = await list.json();
    expect(rows.find((a) => a.id === BANNED_ID)).toBeUndefined();
  });

  test('SPA catch-all serves index for deep routes, 404s API', async () => {
    const spa = await fetch(`${BASE}/some/deep/route`);
    expect(spa.status).toBe(200);
    const api404 = await fetch(`${BASE}/api/nope`, { headers: { authorization: `Bearer ${operatorToken}` } });
    expect(api404.status).toBe(404);
  });
});
