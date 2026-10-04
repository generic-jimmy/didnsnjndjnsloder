// Small shared helpers for the operator console.

// ISO 3166-1 alpha-2 -> regional indicator emoji flag ("US" -> 🇺🇸).
// Anything missing/invalid renders as a globe so the UI never breaks on
// agents that haven't reported a country yet.
export function flagEmoji(countryCode) {
  if (!countryCode || typeof countryCode !== 'string' || countryCode.length !== 2) {
    return '🌐';
  }
  const cc = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '🌐';
  return String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0)));
}

export function countryLabel(agent) {
  if (!agent) return 'Unknown';
  if (agent.country) return agent.country;
  if (agent.country_code) return regionName(agent.country_code);
  return 'Unknown';
}

// ISO 3166-1 alpha-2 -> full country name via the browser's own Intl data
// ("US" -> "United States"). Zero data shipped; cached after first use.
let regionNames = null;
export function regionName(code) {
  const cc = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return cc || 'Unknown';
  try {
    if (!regionNames) regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(cc) || cc;
  } catch {
    return cc;
  }
}

// OS family -> icon glyph. IMPORTANT: use glyphs that ship with core Windows
// fonts. The Windows-logo emoji (U+1FA9F) is Unicode 13 — Windows 10 has no
// glyph for it and renders a tofu box, so we use "⊞" (squared plus, in
// Segoe UI Symbol since forever) which looks like the Windows flag.
export function osIcon(agent) {
  const hay = `${agent?.os_name || ''} ${agent?.os_version || ''} ${agent?.platform || ''}`.toLowerCase();
  if (hay.includes('windows') || agent?.os_name === 'windows') return '⊞';
  if (hay.includes('mac') || hay.includes('darwin') || hay.includes('osx') || agent?.os_name === 'macos') return '🍎';
  if (hay.includes('android') || agent?.os_name === 'android') return '🤖';
  if (hay.includes('linux') || hay.includes('ubuntu') || hay.includes('debian') || hay.includes('centos') ||
      hay.includes('kali') || hay.includes('fedora') || hay.includes('arch') || agent?.os_name === 'linux') return '🐧';
  return '◈';
}

export function osLabel(agent) {
  if (!agent) return 'Unknown OS';
  const family = agent.os_name
    ? agent.os_name.charAt(0).toUpperCase() + agent.os_name.slice(1)
    : (agent.os_version || '').split(' ')[0] || 'Unknown';
  return [family, agent.os_version].filter(Boolean).join(' · ');
}

// Coarse OS family for filters: windows | linux | macos | android | other
export function osFamily(agent) {
  const hay = `${agent?.os_name || ''} ${agent?.os_version || ''} ${agent?.platform || ''}`.toLowerCase();
  if (hay.includes('win')) return 'windows';
  if (hay.includes('mac') || hay.includes('darwin') || hay.includes('osx')) return 'macos';
  if (hay.includes('android')) return 'android';
  if (hay.includes('linux') || hay.includes('ubuntu') || hay.includes('debian') || hay.includes('centos') ||
      hay.includes('kali') || hay.includes('fedora') || hay.includes('arch')) return 'linux';
  return 'other';
}

// Relative time: "just now", "42s ago", "5m ago", "3h ago", "2d ago".
// Falls back to a locale date for anything older / invalid.
export function timeAgo(value) {
  if (!value) return 'never';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'never';
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(value).toLocaleString();
}

export function fullDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// Compact relative time for tight UI slots (agent cards). Never falls back to
// the long locale string ("10/2/2026, 3:41:00 PM") — that overflows narrow
// cards and pushes the Ban/Delete buttons out. Full date stays on the tooltip.
export function timeAgoShort(value) {
  if (!value) return 'never';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
