import React, { useState } from 'react';
import { countryLabel, flagEmoji, regionName } from '../utils';

// Renders a REAL country flag image (flagcdn.com) — this is the fix for
// Windows, where Unicode flag emoji show as plain letters ("US") because
// Windows ships no flag emoji font.
//
// Fallback chain: flagcdn image -> unicode emoji char -> globe.
// A failed/offline image never breaks the layout.
export default function Flag({ agent, size = 'sm', tooltip }) {
  const [imgFailed, setImgFailed] = useState(false);
  const cc = (agent?.country_code || '').toLowerCase();
  const valid = /^[a-z]{2}$/.test(cc);
  const name = countryLabel(agent) === 'Unknown' && valid ? regionName(cc) : countryLabel(agent);
  const isp = agent?.isp ? ` · ${agent.isp}` : '';
  const label = tooltip !== undefined ? tooltip : `${name}${isp}`;
  const dims = size === 'lg'
    ? { w: 28, h: 19 }
    : size === 'md'
      ? { w: 23, h: 16 }
      : { w: 21, h: 14 };

  if (valid && !imgFailed) {
    return (
      <img
        className={`flag flag-${size}`}
        src={`https://flagcdn.com/w40/${cc}.png`}
        srcSet={`https://flagcdn.com/w80/${cc}.png 2x`}
        width={dims.w}
        height={dims.h}
        alt={name}
        title={label}
        loading="lazy"
        onError={() => setImgFailed(true)}
      />
    );
  }
  // Offline / unknown code: unicode emoji (works on macOS/Linux) or globe
  return (
    <span
      className={`flag flag-${size} flag-fallback`}
      title={label}
      style={{ width: dims.w, height: dims.h }}
    >
      {valid ? flagEmoji(cc) : '🌐'}
    </span>
  );
}
