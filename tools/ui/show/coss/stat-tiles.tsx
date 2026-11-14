// parts/ui/show/coss/stat-tiles.tsx
//
// PURPOSE
//   A row of numbers that matter, each a tile with a quiet label, a big value in the display face and a line under it
//   (with an optional icon and a thin bar for how far along it is). Adapted from 21st.dev's "Stats Card" (ravikatiyar162
//   stats-card-1): title, primary value, icon, and a small line under the value. Dropped from it: the up/down percent
//   change, which a caller rarely has honestly.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: every label, value and line is the caller's DATA; `progress` is 0..1 or absent.
//   2. Appearance lives in screen-look/show/guide.css (`.stat-*`); icons are named DATA (NamedIcon).

import * as React from 'react';
import { NamedIcon } from '../icon/NamedIcon';

export type StatTile = { id: string; label: string; value: string; detail?: string; icon?: string; progress?: number; tone?: string };

export function StatTiles({ tiles }: { tiles: StatTile[] }) {
  return (
    <div className="stat-tiles">
      {tiles.map(tile => (
        <div key={tile.id} className="stat-tile" data-tone={tile.tone}>
          <p className="stat-label">{tile.icon ? <NamedIcon name={tile.icon} className="stat-icon" aria-hidden /> : null}{tile.label}</p>
          <p className="stat-value">{tile.value}</p>
          {typeof tile.progress === 'number' ? (
            <span className="stat-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, Math.max(0, tile.progress)) * 100)} aria-label={tile.detail ?? tile.label}>
              <span className="stat-bar-fill" style={{ width: `${Math.min(1, Math.max(0, tile.progress)) * 100}%` }} />
            </span>
          ) : null}
          {tile.detail ? <p className="stat-detail">{tile.detail}</p> : null}
        </div>
      ))}
    </div>
  );
}
