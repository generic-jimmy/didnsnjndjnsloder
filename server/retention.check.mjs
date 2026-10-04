// Standalone retention check (separate process — bun test shares one process
// across files, which would cache server.js with retention disabled).
// Run with: bun server/retention.check.mjs
import { mock } from 'bun:test';

const logs = [];
const snapshots = [];

function matchQuery(text, params = []) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.startsWith('DELETE FROM public.command_logs') && t.includes('executed_at < now()')) {
    const days = Number(params[0]) || 0;
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    for (let i = logs.length - 1; i >= 0 && removed < 500; i--) {
      if (new Date(logs[i].executed_at).getTime() < cutoff) {
        logs.splice(i, 1);
        removed++;
      }
    }
    return { rows: [], rowCount: removed };
  }
  if (t.startsWith('DELETE FROM public.command_logs') && t.includes('row_number()')) {
    const cap = Number(params[0]) || 0;
    const byAgent = {};
    const toDelete = [];
    for (const l of [...logs].sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at))) {
      byAgent[l.agent_id] = (byAgent[l.agent_id] || 0) + 1;
      if (byAgent[l.agent_id] > cap) toDelete.push(l);
    }
    let removed = 0;
    for (const l of toDelete.slice(0, 500)) {
      const idx = logs.indexOf(l);
      if (idx >= 0) { logs.splice(idx, 1); removed++; }
    }
    return { rows: [], rowCount: removed };
  }
  if (t.startsWith('DELETE FROM public.metrics_snapshots')) {
    // real SQL only removes snapshots older than 30 days — fresh ones survive
    const cutoff = Date.now() - 30 * 86400000;
    const keep = snapshots.filter((s) => new Date(s.captured_at).getTime() >= cutoff);
    const removed = snapshots.length - keep.length;
    snapshots.length = 0;
    snapshots.push(...keep);
    return { rows: [], rowCount: removed };
  }
  if (t.startsWith('SELECT count(*) FILTER')) {
    return { rows: [{ online: 0, offline: 0, banned: 0, total: 0 }], rowCount: 1 };
  }
  if (t.startsWith('INSERT INTO public.metrics_snapshots')) {
    snapshots.push({ captured_at: new Date().toISOString(), online: params[0], offline: params[1], banned: params[2], total: params[3] });
    return { rows: [], rowCount: 1 };
  }
  // boot status reset, reaper, agent lookups... — quiet no-op
  return { rows: [], rowCount: 0 };
}

mock.module('pg', () => ({
  default: {
    Pool: class Pool {
      constructor() { this.totalCount = 0; this.idleCount = 0; this.waitingCount = 0; }
      on() {}
      async query(text, params) { return matchQuery(text, params); }
      async connect() { return { query: (t, p) => matchQuery(t, p), release() {} }; }
      end() {}
    }
  },
  Pool: class Pool2 {
    constructor() { this.totalCount = 0; this.idleCount = 0; this.waitingCount = 0; }
    on() {}
    async query(text, params) { return matchQuery(text, params); }
    async connect() { return { query: (t, p) => matchQuery(t, p), release() {} }; }
    end() {}
  }
}));

process.env.DATABASE_URL = 'postgres://mock:mock@localhost/mock';
process.env.PORT = '4460';
process.env.JWT_SECRET = 'test-secret';
process.env.DB_SSL = 'false';
process.env.LOG_RETENTION_DAYS = '1';
process.env.LOG_RETENTION_MAX_PER_AGENT = '2';

// Seed BEFORE boot: 2 ancient rows (purged by age) + 4 recent rows (capped to newest 2)
const NOW = Date.now();
const DAY = 86400000;
logs.push({ id: 'old1', agent_id: 'A', command: 'old', output: '', executed_at: new Date(NOW - 3 * DAY).toISOString(), operator_username: 'x' });
logs.push({ id: 'old2', agent_id: 'A', command: 'old', output: '', executed_at: new Date(NOW - 2 * DAY).toISOString(), operator_username: 'x' });
logs.push({ id: 'n1', agent_id: 'A', command: 'new', output: '', executed_at: new Date(NOW - 4000).toISOString(), operator_username: 'x' });
logs.push({ id: 'n2', agent_id: 'A', command: 'new', output: '', executed_at: new Date(NOW - 3000).toISOString(), operator_username: 'x' });
logs.push({ id: 'n3', agent_id: 'A', command: 'new', output: '', executed_at: new Date(NOW - 2000).toISOString(), operator_username: 'x' });
logs.push({ id: 'n4', agent_id: 'A', command: 'new', output: '', executed_at: new Date(NOW - 1000).toISOString(), operator_username: 'x' });

await import('./server.js');
await new Promise((r) => setTimeout(r, 800));

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
};

const ids = logs.map((l) => l.id);
check('purges rows older than LOG_RETENTION_DAYS', !ids.includes('old1') && !ids.includes('old2'));
check('caps rows per agent at LOG_RETENTION_MAX_PER_AGENT', JSON.stringify(ids.sort()) === JSON.stringify(['n3', 'n4']));
check('boot fleet snapshot captured', snapshots.length >= 1);

process.exit(failed ? 1 : 0);
