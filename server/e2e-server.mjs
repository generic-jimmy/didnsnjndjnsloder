// E2E demo/test server: runs the REAL server + built client against an
// in-memory pg mock, seeds a realistic fleet, and connects 2 LIVE fake
// agents over WebSocket (register + heartbeat + terminal echo) so the UI
// can be verified end-to-end in a browser.
// Run with: bun server/e2e-server.mjs   (then open http://localhost:3001)
import { mock } from 'bun:test';
import WebSocket from 'ws';

const agents = new Map();
const logs = [];
const scripts = [];
const tagStore = new Map();
const agentTags = new Map();
const snapshots = [];
let seq = 0;
const uuid = 'b2c3d4e5-0000-4000-8000-0000000000';

function matchQuery(text, params = []) {
  const t = text.replace(/\s+/g, ' ').trim();
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
  if (t.startsWith("UPDATE public.agents SET status = 'online'")) {
    const a = agents.get(params[0]);
    if (a) { a.status = 'online'; a.last_seen = new Date(); if (params[1] && !a.ip_address) a.ip_address = params[1]; }
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  if (t.startsWith('UPDATE public.agents SET last_seen = now() WHERE id')) {
    const a = agents.get(params[0]);
    if (a) a.last_seen = new Date();
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  if (t.startsWith("UPDATE public.agents SET status = 'offline', last_seen = now()")) {
    const a = agents.get(params[0]);
    if (a && !a.banned) a.status = 'offline';
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  if (t.includes("UPDATE public.agents SET status = 'offline' WHERE status = 'online'")) {
    for (const a of agents.values()) if (a.status === 'online') a.status = 'offline';
    return { rows: [], rowCount: 0 };
  }
  if (t.startsWith("UPDATE public.agents SET status = 'offline' WHERE id = $1")) {
    const a = agents.get(params[0]);
    if (a) a.status = 'offline';
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  if (t.startsWith('SELECT * FROM public.agents WHERE agent_token')) {
    const row = [...agents.values()].find((a) => a.agent_token === params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (t.startsWith('SELECT * FROM public.agents WHERE id = $1')) {
    const row = agents.get(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (t.startsWith('SELECT a.id, a.hostname') && t.includes('WHERE a.id = $1')) {
    const row = agents.get(params[0]);
    if (!row) return { rows: [], rowCount: 0 };
    const tags = (agentTags.get(params[0]) || []).map((tid) => tagStore.get(tid)).filter(Boolean);
    return { rows: [{ ...row, tags }], rowCount: 1 };
  }
  if (t.startsWith('SELECT a.id, a.hostname')) {
    const rows = [...agents.values()].map((row) => ({
      ...row,
      tags: (agentTags.get(row.id) || []).map((tid) => tagStore.get(tid)).filter(Boolean)
    }));
    return { rows, rowCount: rows.length };
  }
  if (t.startsWith('UPDATE public.agents SET country = COALESCE')) {
    const a = agents.get(params[0]);
    if (a) {
      a.country = a.country ?? params[1];
      a.country_code = a.country_code ?? params[2];
      a.isp = a.isp ?? params[3];
      a.lat = a.lat ?? params[4];
      a.lon = a.lon ?? params[5];
    }
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  if (t.startsWith('UPDATE public.agents SET banned = true')) {
    const a = agents.get(params[0]);
    if (a) { a.banned = true; a.ban_reason = params[1]; a.status = 'banned'; }
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  if (t.startsWith('UPDATE public.agents SET banned = false')) {
    const a = agents.get(params[0]);
    if (a) { a.banned = false; a.ban_reason = null; a.status = 'offline'; }
    return { rows: [], rowCount: a ? 1 : 0 };
  }
  if (t.startsWith('DELETE FROM public.agents WHERE id')) {
    const had = agents.delete(params[0]);
    agentTags.delete(params[0]);
    return { rows: [], rowCount: had ? 1 : 0 };
  }
  if (t.startsWith('INSERT INTO public.command_logs')) {
    const row = { id: `log-${++seq}`, agent_id: params[0], command: params[1], output: params[2] ?? '', operator_username: params[3], executed_at: new Date().toISOString() };
    logs.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (t.startsWith('UPDATE public.command_logs') && t.includes('SET output = $2')) {
    const list = logs.filter((l) => l.agent_id === params[0] && (l.output === '' || l.output === null))
      .sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));
    if (list.length > 0) { list[0].output = params[1]; return { rows: [list[0]], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
  if (t.startsWith('SELECT id, command, output, executed_at, operator_username') && t.includes('LIMIT $2')) {
    const list = logs.filter((l) => l.agent_id === params[0]).slice(0, params[1]);
    return { rows: list, rowCount: list.length };
  }
  if (t.startsWith('SELECT id, command, output, executed_at, operator_username')) {
    const list = logs.filter((l) => l.agent_id === params[0]).slice(0, 10000);
    return { rows: list, rowCount: list.length };
  }
  if (t.startsWith('INSERT INTO public.scripts')) {
    const row = { id: `script-${++seq}`, name: params[0], language: params[1], content: params[2], created_by: params[3], created_at: new Date().toISOString() };
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
  if (t.startsWith('SELECT t.id, t.name')) {
    const rows = [...tagStore.values()].map((tag) => ({
      ...tag,
      agent_count: [...agentTags.values()].filter((ids) => ids.includes(tag.id)).length
    }));
    return { rows, rowCount: rows.length };
  }
  if (t.startsWith('INSERT INTO public.tags')) {
    const existing = [...tagStore.values()].find((x) => x.name === params[0]);
    if (existing) { existing.color = params[1]; return { rows: [existing], rowCount: 1 }; }
    const row = { id: 'tag-' + (++seq) + '-u' + Date.now(), name: params[0], color: params[1], created_at: new Date().toISOString() };
    tagStore.set(row.id, row);
    return { rows: [row], rowCount: 1 };
  }
  if (t.startsWith('DELETE FROM public.tags WHERE id')) {
    tagStore.delete(params[0]);
    for (const [aid, ids] of agentTags) agentTags.set(aid, ids.filter((x) => x !== params[0]));
    return { rows: [], rowCount: 1 };
  }
  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
  if (t.startsWith('DELETE FROM public.agent_tags WHERE agent_id')) {
    agentTags.set(params[0], []);
    return { rows: [], rowCount: 1 };
  }
  if (t.startsWith('INSERT INTO public.agent_tags')) {
    const ids = agentTags.get(params[0]) || [];
    if (!ids.includes(params[1])) ids.push(params[1]);
    agentTags.set(params[0], ids);
    return { rows: [], rowCount: 1 };
  }
  if (t.startsWith('SELECT count(*) FILTER')) {
    const list = [...agents.values()];
    return {
      rows: [{
        online: list.filter((a) => a.status === 'online' && !a.banned).length,
        offline: list.filter((a) => a.status !== 'online' && !a.banned).length,
        banned: list.filter((a) => a.banned).length,
        total: list.length
      }],
      rowCount: 1
    };
  }
  if (t.startsWith('INSERT INTO public.metrics_snapshots')) {
    snapshots.push({ captured_at: new Date().toISOString(), online: params[0], offline: params[1], banned: params[2], total: params[3] });
    return { rows: [], rowCount: 1 };
  }
  if (t.startsWith('SELECT captured_at, online, offline, banned, total')) {
    return { rows: snapshots, rowCount: snapshots.length };
  }
  if (t.startsWith('DELETE FROM public.metrics_snapshots')) return { rows: [], rowCount: 0 };
  if (t.startsWith('DELETE FROM public.command_logs')) return { rows: [], rowCount: 0 };
  if (t.startsWith('INSERT INTO public.agents')) {
    const row = { id: uuid + (++seq), agent_token: params[0], hostname: 'pending', status: 'offline', ip_address: params[1], banned: false };
    agents.set(row.id, row);
    return { rows: [row], rowCount: 1 };
  }
  console.error('UNMATCHED QUERY:', t.slice(0, 100));
  return { rows: [], rowCount: 0 };
}

mock.module('pg', () => ({
  default: {
    Pool: class Pool {
      constructor() { this.totalCount = 2; this.idleCount = 1; this.waitingCount = 0; }
      on() {}
      async query(text, params) { return matchQuery(text, params); }
      async connect() { return { query: (t, p) => matchQuery(t, p), release() {} }; }
      end() {}
    }
  },
  Pool: class Pool2 {
    constructor() { this.totalCount = 2; this.idleCount = 1; this.waitingCount = 0; }
    on() {}
    async query(text, params) { return matchQuery(text, params); }
    async connect() { return { query: (t, p) => matchQuery(t, p), release() {} }; }
    end() {}
  }
}));

process.env.DATABASE_URL = 'postgres://mock:mock@localhost/mock';
process.env.PORT = '3001';
process.env.JWT_SECRET = 'e2e-secret';
process.env.DB_SSL = 'false';
process.env.DB_POOL_MAX = '25';
process.env.LOGIN_LOCKOUT_BASE_MS = '30000'; // 30s — visible countdown in the UI

// ---------- seed a realistic fleet ----------
const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const seeds = [
  { tok: 'AGENT-ONLINE-1', hostname: 'WIN-DC-01', ip: '10.0.0.11', os_name: 'windows', os_version: 'Server 2022', arch: 'x86_64', platform: 'win32', user: 'svc-backup', cc: 'DE', country: 'Germany', isp: 'Hetzner Online GmbH', lat: 50.11, lon: 8.68, status: 'offline', seen: 0.02 },
  { tok: 'AGENT-ONLINE-2', hostname: 'KALI-BOX', ip: '10.0.0.22', os_name: 'linux', os_version: 'Kali 2024.3', arch: 'x86_64', platform: 'linux', user: 'root', cc: 'US', country: 'United States', isp: 'DigitalOcean LLC', lat: 39.04, lon: -77.49, status: 'offline', seen: 0.05 },
  { tok: 'AGENT-OFFLINE-1', hostname: 'MAC-MINI-STUDIO', ip: '10.0.0.33', os_name: 'macos', os_version: 'Sonoma 14.6', arch: 'arm64', platform: 'darwin', user: 'editor', cc: 'JP', country: 'Japan', isp: 'NTT Communications', lat: 35.68, lon: 139.69, status: 'offline', seen: 26 },
  { tok: 'AGENT-OFFLINE-2', hostname: 'ANDRD-GALAXY', ip: '10.0.0.44', os_name: 'android', os_version: '14', arch: 'arm64', platform: 'android', user: 'owner', cc: 'BR', country: 'Brazil', isp: 'Vivo Fibra', lat: -23.55, lon: -46.63, status: 'offline', seen: 74 },
  { tok: 'AGENT-BANNED-1', hostname: 'LEGACY-XP-SHOP', ip: '10.0.0.55', os_name: 'windows', os_version: 'XP SP3', arch: 'x86', platform: 'win32', user: 'admin', cc: 'GB', country: 'United Kingdom', isp: 'BT Group plc', lat: 51.5, lon: -0.12, status: 'offline', seen: 200, banned: true, reason: 'Decommissioned — refuses to update' }
];
for (const [i, s] of seeds.entries()) {
  const id = uuid + '-' + s.tok; // unique per seed (suffix digit was NOT unique!)
  agents.set(id, {
    id, agent_token: s.tok, hostname: s.hostname, ip_address: s.ip,
    os_name: s.os_name, os_version: s.os_version, os_arch: s.arch, platform: s.platform,
    username: s.user, country: s.country, country_code: s.cc, isp: s.isp,
    lat: s.lat, lon: s.lon,
    status: s.status, banned: !!s.banned, ban_reason: s.reason || null,
    created_at: hoursAgo(s.seen + 96), last_seen: hoursAgo(s.seen)
  });
}
// tags
tagStore.set('tag-1', { id: 'tag-1', name: 'prod', color: '#34d399', created_at: hoursAgo(100) });
tagStore.set('tag-2', { id: 'tag-2', name: 'staging', color: '#fbbf24', created_at: hoursAgo(90) });
tagStore.set('tag-3', { id: 'tag-3', name: 'client-X', color: '#a78bfa', created_at: hoursAgo(80) });
const ids = [...agents.keys()];
console.log(`[seed] agents=${agents.size}`);
agentTags.set(ids[0], ['tag-1', 'tag-3']);            // WIN-DC-01: prod, client-X
agentTags.set(ids[1], ['tag-1']);                      // KALI-BOX: prod
agentTags.set(ids[2], ['tag-2']);                      // MAC-MINI: staging
// timeline snapshots (24h of 5-min history, gently varying)
for (let i = 288; i >= 0; i--) {
  const wave = Math.round(1.2 + Math.sin(i / 11) + 1.2);
  snapshots.push({
    captured_at: new Date(NOW - i * 300000).toISOString(),
    online: Math.max(0, wave), offline: seeds.length - Math.max(0, wave) - 1, banned: 1, total: seeds.length
  });
}

await import('./server.js');
console.log('E2E server on http://localhost:3001 (login: admin / password)');

// ---------- LIVE fake agents (register + heartbeat + terminal echo) ----------
const ONLINE_TOKENS = ['AGENT-ONLINE-1', 'AGENT-ONLINE-2'];
function startFakeAgent(token, regExtra, label) {
  const ws = new WebSocket(`ws://127.0.0.1:3001/ws/agent?token=${token}`);
  ws.on('open', () => {
    console.log(`[fake-agent] ${label} connected`);
    ws.send(JSON.stringify({ type: 'register', hostname: regExtra.hostname, ip: regExtra.ip, os_name: regExtra.os_name, os: regExtra.os_version, arch: regExtra.arch, platform: regExtra.platform, username: regExtra.user, country_code: regExtra.cc, country: regExtra.country, isp: regExtra.isp }));
  });
  ws.on('message', (d) => {
    let msg;
    try { msg = JSON.parse(d.toString()); } catch { return; }
    if (msg.type === 'terminal_start') {
      ws.send(JSON.stringify({ type: 'terminal_output', data: `Microsoft Windows [Version 10.0.19045]\r\nC:\\Users\\${regExtra.user}> ` }));
    } else if (msg.type === 'terminal_input') {
      const cmd = String(msg.data || '').trim();
      if (cmd) {
        ws.send(JSON.stringify({ type: 'terminal_output', data: `\r\n[${label}] executed: ${cmd}\r\nC:\\Users\\${regExtra.user}> ` }));
      }
    } else if (msg.type === 'script_run') {
      ws.send(JSON.stringify({ type: 'script_result', output: `[${label}] script (${msg.language}) OK: ${String(msg.content).split('\n')[0].slice(0, 60)}` }));
    }
  });
  const hb = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
  }, 15000);
  ws.on('close', () => clearInterval(hb));
  ws.on('error', (e) => console.error(`[fake-agent] ${label} error:`, e.message));
}
setTimeout(() => {
  startFakeAgent(ONLINE_TOKENS[0], { hostname: 'WIN-DC-01', ip: '10.0.0.11', os_name: 'windows', os_version: 'Server 2022', arch: 'x86_64', platform: 'win32', user: 'svc-backup', cc: 'DE', country: 'Germany', isp: 'Hetzner Online GmbH' }, 'WIN-DC-01');
  startFakeAgent(ONLINE_TOKENS[1], { hostname: 'KALI-BOX', ip: '10.0.0.22', os_name: 'linux', os_version: 'Kali 2024.3', arch: 'x86_64', platform: 'linux', user: 'root', cc: 'US', country: 'United States', isp: 'DigitalOcean LLC' }, 'KALI-BOX');
}, 500);
