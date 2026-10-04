import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ComposableMap, Geographies, Geography, Marker, ZoomableGroup } from 'react-simple-maps';
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  Tooltip, AreaChart, Area, CartesianGrid
} from 'recharts';
import api from '../api';
import Flag from './Flag';
import { osIcon, osFamily, timeAgo, regionName } from '../utils';

// Lazy-loaded world atlas (TopoJSON, 110m — small) so the console bundle stays lean
const worldUrl = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

const OS_COLORS = { windows: '#60a5fa', linux: '#34d399', macos: '#fbbf24', android: '#a78bfa', other: '#64748b' };
const STATUS_COLORS = { online: '#34d399', offline: '#f87171', banned: '#fbbf24' };
const MIN_ZOOM = 1;
const MAX_ZOOM = 10;

function startOfUTCDay() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function Kpi({ label, value, tone, sub }) {
  return (
    <div className={`kpi-card ${tone || ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

// GLOBAL FLEET DASHBOARD — compact single-screen layout:
//   [ KPI row ]
//   [ world map (fixed height) | OS donut + top countries stacked ]
//   [ 24h online timeline (full width) ]
// Live via the agents prop (already WS-driven in Dashboard) + 60s timeline poll.
function FleetDashboard({ agents, onSelectAgent }) {
  const [world, setWorld] = useState(null);
  const [worldError, setWorldError] = useState(false);
  const [hover, setHover] = useState(null); // { agent, x, y }
  const [timeline, setTimeline] = useState([]);
  const [position, setPosition] = useState({ coordinates: [8, 8], zoom: 1 });
  const mapRef = useRef(null);

  const zoomIn = () => setPosition((p) => ({ ...p, zoom: Math.min(p.zoom * 1.6, MAX_ZOOM) }));
  const zoomOut = () => setPosition((p) => ({ ...p, zoom: Math.max(p.zoom / 1.6, MIN_ZOOM) }));
  const zoomReset = () => setPosition({ coordinates: [8, 8], zoom: 1 });

  // Load the topojson once (CDN with graceful failure)
  useEffect(() => {
    let dead = false;
    fetch(worldUrl)
      .then((r) => r.json())
      .then((data) => { if (!dead) setWorld(data); })
      .catch(() => { if (!dead) setWorldError(true); });
    return () => { dead = true; };
  }, []);

  // Timeline (5-min server snapshots)
  const loadTimeline = () => {
    api.get('/metrics/timeline?hours=24')
      .then((res) => setTimeline(res.data || []))
      .catch(() => {});
  };
  useEffect(() => {
    loadTimeline();
    const t = setInterval(loadTimeline, 60000);
    return () => clearInterval(t);
  }, []);

  const kpis = useMemo(() => {
    const t0 = startOfUTCDay();
    return {
      total: agents.length,
      online: agents.filter((a) => a.status === 'online' && !a.banned).length,
      offline: agents.filter((a) => a.status !== 'online' && !a.banned).length,
      banned: agents.filter((a) => a.banned).length,
      newToday: agents.filter((a) => a.created_at && new Date(a.created_at).getTime() >= t0).length
    };
  }, [agents]);

  const osData = useMemo(() => {
    const groups = {};
    for (const a of agents) {
      const fam = osFamily(a);
      groups[fam] = (groups[fam] || 0) + 1;
    }
    return Object.entries(groups)
      .map(([name, value]) => ({ name, value }))
      .sort((x, y) => y.value - x.value);
  }, [agents]);

  const countryData = useMemo(() => {
    const groups = {};
    for (const a of agents) {
      const cc = (a.country_code || '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc)) continue;
      if (!groups[cc]) groups[cc] = { code: cc, name: a.country || regionName(cc), count: 0 };
      groups[cc].count += 1;
    }
    return Object.values(groups).sort((x, y) => y.count - x.count).slice(0, 8);
  }, [agents]);

  const timelineData = useMemo(
    () => timeline.map((p) => ({
      ...p,
      time: new Date(p.captured_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    })),
    [timeline]
  );

  // Map pins: agents with coordinates. Tiny deterministic jitter for co-located devices.
  const pins = useMemo(() => {
    const seen = {};
    return agents
      .filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon) && (a.lat !== 0 || a.lon !== 0))
      .map((a) => {
        const key = `${a.lat.toFixed(2)},${a.lon.toFixed(2)}`;
        seen[key] = (seen[key] || 0) + 1;
        const n = seen[key] - 1;
        const j = n === 0 ? 0 : (n * 0.35);
        const hash = [...a.id].reduce((s, c) => s + c.charCodeAt(0), 0);
        return {
          agent: a,
          lon: a.lon + j * Math.cos(hash) * 0.8,
          lat: a.lat + j * Math.sin(hash) * 0.55
        };
      });
  }, [agents]);
  const unlocated = agents.length - pins.length;

  const exportAgents = async (format) => {
    try {
      const res = await api.get(`/export/agents?format=${format}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `badman-agents-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      window.alert(err?.response?.data?.error || 'Export failed');
    }
  };

  const status = (a) => (a.banned ? 'banned' : a.status === 'online' ? 'online' : 'offline');

  return (
    <div className="fleet-page">
      <div className="fleet-head">
        <span className="panel-title"><span className="title-dot" /> Global Fleet</span>
        <span className="fleet-meta">{pins.length} pinned · {unlocated} awaiting geo data</span>
        <div className="fleet-export">
          <span className="fleet-export-label">Export:</span>
          <button className="btn-ghost btn-small" onClick={() => exportAgents('csv')}>Agents CSV</button>
          <button className="btn-ghost btn-small" onClick={() => exportAgents('json')}>Agents JSON</button>
        </div>
      </div>

      <div className="kpi-row">
        <Kpi label="Total Agents" value={kpis.total} />
        <Kpi label="Online" value={kpis.online} tone="green" />
        <Kpi label="Offline" value={kpis.offline} tone="red" />
        <Kpi label="Banned" value={kpis.banned} tone="amber" />
        <Kpi label="New Today" value={kpis.newToday} tone="accent" />
      </div>

      {/* Map + charts BESIDE each other — everything fits on one screen */}
      <div className="fleet-grid">
        <div className="fleet-map-card" ref={mapRef}>
          {!world && !worldError && <div className="fleet-map-loading">Loading world map…</div>}
          {worldError && (
            <div className="fleet-map-loading">
              Map data unavailable (offline?) — KPIs, charts and exports still work.
            </div>
          )}
          {world && (
            <ComposableMap
              projection="geoEqualEarth"
              width={800}
              height={400}
              projectionConfig={{ scale: 148, center: [8, 8] }}
              style={{ width: '100%', height: '100%' }}
              onMouseMove={(e) => {
                // Guard INSIDE the updater: a stale mousemove can arrive after
                // onMouseLeave cleared the hover (h === null) — spreading over
                // null produced {x,y} with no agent and crashed the tooltip.
                if (!hover) return;
                const rect = mapRef.current?.getBoundingClientRect();
                if (!rect) return;
                setHover((h) => (h ? { ...h, x: e.clientX - rect.left, y: e.clientY - rect.top } : null));
              }}
            >
              <ZoomableGroup
                zoom={position.zoom}
                center={position.coordinates}
                maxZoom={MAX_ZOOM}
                onMoveEnd={(pos) => {
                  if (pos && Array.isArray(pos.coordinates) && Number.isFinite(pos.zoom)) {
                    setPosition({ coordinates: pos.coordinates, zoom: pos.zoom });
                  }
                }}
              >
              <Geographies geography={world}>
                {({ geographies }) => (
                  <>
                    {geographies.map((g) => (
                      <Geography
                        key={g.rsmKey}
                        geography={g}
                        fill="#1a2740"
                        stroke="#2e4066"
                        strokeWidth={0.4}
                        style={{
                          default: { outline: 'none' },
                          hover: { fill: '#243454', outline: 'none' },
                          pressed: { outline: 'none' }
                        }}
                      />
                    ))}
                    {pins.map(({ agent, lon, lat }) => (
                      <Marker key={agent.id} coordinates={[lon, lat]}>
                        <circle
                          r={4.2 / position.zoom}
                          fill={STATUS_COLORS[status(agent)]}
                          stroke="#070b12"
                          strokeWidth={1 / position.zoom}
                          className="fleet-pin"
                          onMouseEnter={(e) => {
                            const rect = mapRef.current?.getBoundingClientRect();
                            if (!rect) return;
                            setHover({ agent, x: e.clientX - rect.left, y: e.clientY - rect.top });
                          }}
                          onMouseLeave={() => setHover(null)}
                          onClick={() => onSelectAgent?.(agent)}
                          style={{ cursor: 'pointer' }}
                        />
                      </Marker>
                    ))}
                  </>
                )}
              </Geographies>
              </ZoomableGroup>
            </ComposableMap>
          )}
          {world && (
            <div className="fleet-zoom">
              <button onClick={zoomIn} title="Zoom in" disabled={position.zoom >= MAX_ZOOM}>+</button>
              <button onClick={zoomOut} title="Zoom out" disabled={position.zoom <= MIN_ZOOM}>&minus;</button>
              <button className="fz-reset" onClick={zoomReset} title="Reset view">1:1</button>
            </div>
          )}
          {hover?.agent && (
            <div className="fleet-tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
              <div className="ft-row">
                <Flag agent={hover.agent} size="md" />
                <b>{hover.agent.hostname || hover.agent.ip_address || 'unknown'}</b>
                <span className={`agent-badge ${status(hover.agent)}`}>{status(hover.agent)}</span>
              </div>
              <div className="ft-row muted">
                {hover.agent.ip_address || '—'} · {hover.agent.os_name || '?'} {hover.agent.os_version || ''}
              </div>
              <div className="ft-row muted">
                {(hover.agent.country || regionName(hover.agent.country_code) || 'Unknown')}
                {hover.agent.isp ? ` · ${hover.agent.isp}` : ''}
              </div>
              <div className="ft-row muted">seen {timeAgo(hover.agent.last_seen)}</div>
              <div className="ft-row hint">click to open console</div>
            </div>
          )}
        </div>

        <div className="fleet-side">
          <div className="fleet-chart-card">
            <span className="metric-label">OS Distribution</span>
            <ResponsiveContainer width="100%" height={118}>
              <PieChart>
                <Pie
                  data={osData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={34}
                  outerRadius={52}
                  paddingAngle={3}
                  stroke="#070b12"
                >
                  {osData.map((d) => <Cell key={d.name} fill={OS_COLORS[d.name] || '#64748b'} />)}
                </Pie>
                <Tooltip
                  contentStyle={{ background: '#0f1626', border: '1px solid #26375a', borderRadius: 8, fontSize: 12 }}
                  formatter={(v, n) => [`${v} agent(s)`, osIcon({ os_name: n }) + ' ' + n]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="fleet-legend">
              {osData.map((d) => (
                <span key={d.name} className="fleet-legend-item">
                  <span className="legend-dot" style={{ background: OS_COLORS[d.name] }} />
                  {osIcon({ os_name: d.name })} {d.name} ({d.value})
                </span>
              ))}
            </div>
          </div>

          <div className="fleet-chart-card">
            <span className="metric-label">Top Countries</span>
            <ResponsiveContainer width="100%" height={128}>
              <BarChart data={countryData} layout="vertical" margin={{ left: 4, right: 12, top: 2, bottom: 2 }}>
                <CartesianGrid stroke="#1c2a45" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#7d8ba6', fontSize: 9 }} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="code"
                  width={42}
                  tick={{ fill: '#7d8ba6', fontSize: 9 }}
                  tickFormatter={(code) => {
                    const c = countryData.find((x) => x.code === code);
                    return c ? c.name.slice(0, 11) : code;
                  }}
                />
                <Tooltip
                  contentStyle={{ background: '#0f1626', border: '1px solid #26375a', borderRadius: 8, fontSize: 12 }}
                  formatter={(v) => [`${v} agent(s)`, '']}
                />
                <Bar dataKey="count" fill="#22d3ee" radius={[0, 4, 4, 0]} barSize={10} />
              </BarChart>
            </ResponsiveContainer>
            <div className="fleet-flags-row">
              {countryData.slice(0, 8).map((c) => (
                <span key={c.code} className="fleet-flag-item" title={`${c.name}: ${c.count}`}>
                  <Flag agent={{ country_code: c.code, country: c.name }} size="sm" />
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="fleet-chart-card wide fleet-timeline">
        <span className="metric-label">Fleet Online History — 24h (5-min snapshots)</span>
        <ResponsiveContainer width="100%" height={148}>
          <AreaChart data={timelineData} margin={{ top: 6, right: 12, left: -14, bottom: 0 }}>
            <defs>
              <linearGradient id="gOnline" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" stopOpacity={0.45} />
                <stop offset="100%" stopColor="#34d399" stopOpacity={0.03} />
              </linearGradient>
              <linearGradient id="gOffline" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f87171" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#f87171" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#1c2a45" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="time" tick={{ fill: '#7d8ba6', fontSize: 10 }} interval={Math.max(1, Math.floor(timelineData.length / 8))} />
            <YAxis tick={{ fill: '#7d8ba6', fontSize: 10 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: '#0f1626', border: '1px solid #26375a', borderRadius: 8, fontSize: 12 }}
            />
            <Area type="stepAfter" dataKey="online" name="online" stroke="#34d399" fill="url(#gOnline)" strokeWidth={1.6} />
            <Area type="stepAfter" dataKey="offline" name="offline" stroke="#f87171" fill="url(#gOffline)" strokeWidth={1.4} stackOffset="none" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default FleetDashboard;
