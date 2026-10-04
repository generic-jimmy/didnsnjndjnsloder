import React, { useState, useEffect, useRef } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid
} from 'recharts';
import api from '../api';

function fmtUptime(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}
function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtTime(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// LIVE SERVER METRICS — polls /api/metrics/live every 5s.
// WS connections, message throughput, DB pool health, geo-API status, versions.
function ServerMetrics() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(true);
  const timerRef = useRef(null);

  const load = () => {
    api.get('/metrics/live')
      .then((res) => { setData(res.data); setError(''); })
      .catch((err) => setError(err?.response?.data?.error || 'Failed to load metrics'));
  };

  useEffect(() => {
    load();
    return () => clearInterval(timerRef.current);
  }, []);

  useEffect(() => {
    clearInterval(timerRef.current);
    if (auto) {
      timerRef.current = setInterval(load, 5000);
      return () => clearInterval(timerRef.current);
    }
    return undefined;
  }, [auto]);

  if (error && !data) {
    return <div className="metrics-page"><div className="sr-error">{error}</div></div>;
  }
  if (!data) {
    return <div className="metrics-page"><div className="metrics-loading">Loading server metrics…</div></div>;
  }

  const ws = data.ws || {};
  const db = data.db || {};
  const geo = data.geo || {};
  const poolUsed = db.pool_max > 0 ? Math.min(100, Math.round(((db.pool_total || 0) / db.pool_max) * 100)) : 0;
  const chartData = (ws.throughput_series || []).map((p) => ({ ...p, time: fmtTime(p.t) }));

  return (
    <div className="metrics-page">
      <div className="metrics-head">
        <span className="panel-title"><span className="title-dot" /> Server Metrics</span>
        <span className="metrics-meta">
          v{data.server_version} · node {data.node_version} · up {fmtUptime(data.uptime_s)}
        </span>
        <label className="metrics-auto">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          live (5s)
        </label>
        <button className="btn-ghost btn-small" onClick={load}>Refresh</button>
      </div>
      {error && <div className="sr-error">{error}</div>}

      <div className="metrics-grid">
        <div className="metric-card">
          <span className="metric-label">Agents Connected</span>
          <span className="metric-value accent">{ws.agents_connected ?? '—'}</span>
          <span className="metric-sub">{ws.agent_connections_total ?? 0} sessions since boot</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Operators Connected</span>
          <span className="metric-value green">{ws.operators_connected ?? '—'}</span>
          <span className="metric-sub">{ws.operator_connections_total ?? 0} sessions since boot</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Messages</span>
          <span className="metric-value">{(ws.messages_in || 0).toLocaleString()} in / {(ws.messages_out || 0).toLocaleString()} out</span>
          <span className="metric-sub">{fmtBytes(ws.bytes_in)} in · {fmtBytes(ws.bytes_out)} out</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Throughput</span>
          <span className="metric-value">{ws.msg_per_sec_in ?? 0} /s in · {ws.msg_per_sec_out ?? 0} /s out</span>
          <span className="metric-sub">scripts {ws.script_runs_total ?? 0} · errors {ws.script_errors_total ?? 0} · banned rejects {ws.banned_rejected_total ?? 0}</span>
        </div>

        <div className="metric-card wide">
          <span className="metric-label">Message Throughput — last 60 minutes</span>
          <div className="metric-chart">
            <ResponsiveContainer width="100%" height={150}>
              <AreaChart data={chartData} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#34d399" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1c2a45" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="time" tick={{ fill: '#7d8ba6', fontSize: 10 }} tickMargin={4} interval={9} />
                <YAxis tick={{ fill: '#7d8ba6', fontSize: 10 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: '#0f1626', border: '1px solid #26375a', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#d7e3f4' }}
                />
                <Area type="monotone" dataKey="in" name="msg in" stroke="#22d3ee" fill="url(#gIn)" strokeWidth={1.6} />
                <Area type="monotone" dataKey="out" name="msg out" stroke="#34d399" fill="url(#gOut)" strokeWidth={1.6} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="metric-card">
          <span className="metric-label">DB Connection Pool</span>
          <span className="metric-value">{db.pool_total ?? '—'} / {db.pool_max}</span>
          <div className="pool-bar"><div className="pool-fill" style={{ width: `${poolUsed}%` }} /></div>
          <span className="metric-sub">
            idle {db.pool_idle ?? '—'} · waiting {db.pool_waiting ?? '—'}
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Geo-IP API</span>
          <span className={`metric-value ${geo.lastStatus === 'ok' ? 'green' : geo.lastStatus === 'fail' ? 'red' : ''}`}>
            <span className={`geo-dot ${geo.lastStatus === 'ok' ? 'ok' : geo.lastStatus === 'fail' ? 'fail' : ''}`} />
            {geo.lastStatus === 'ok' ? 'Healthy' : geo.lastStatus === 'fail' ? 'Failing' : 'Idle'}
          </span>
          <span className="metric-sub">
            last {geo.lastLatencyMs != null ? `${geo.lastLatencyMs}ms` : '—'} · ok {geo.success ?? 0} · fail {geo.failure ?? 0} · cache {geo.cache_size ?? 0}
          </span>
        </div>
      </div>
    </div>
  );
}

export default ServerMetrics;
