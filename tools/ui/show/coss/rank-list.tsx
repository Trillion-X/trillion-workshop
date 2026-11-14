// parts/ui/show/coss/rank-list.tsx
//
// PURPOSE
//   People (or anything) in a list with an avatar, a name, a line under it and a value at the right, optionally
//   numbered by place and with the reader's own row lit: a leaderboard, a member list. Adapted from 21st.dev's
//   "Activity list" (activity-list.tsx, gathered by the team in community-components.md): avatar, name over a quiet
//   description, the amount right-aligned with a small line beneath it. Dropped from it: image avatars the caller
//   does not have, currency formatting and the entrance animation.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: every label, value and place is the caller's DATA.
//   2. Controls are the licensed Coss sources (Badge) and the shared person mark (DisplayMark); appearance lives in screen-look/show/guide.css
//      (`.rank-*`).

import * as React from 'react';
import { DisplayMark } from '../display-mark';
import { Badge } from './ui/badge';

/** `place` numbers the row (a medal tint for the first three), `highlight` lights the reader's own row, `tag` is a
 *  small badge beside the name (a role, a level). */
export type RankRow = { id: string; name: string; detail?: string; value?: string; value_detail?: string; place?: number; highlight?: boolean; tag?: string };


export function RankList({ rows }: { rows: RankRow[] }) {
  return (
    <ol className="rank-list">
      {rows.map(row => (
        <li key={row.id} className="rank-row" data-highlight={row.highlight ? '' : undefined} data-place={row.place && row.place <= 3 ? row.place : undefined}>
          {typeof row.place === 'number' ? <span className="rank-place">{row.place}</span> : null}
          <DisplayMark spec={{ name: row.name }} size="md" />
          <div className="rank-text">
            <p className="rank-name">{row.name}{row.tag ? <Badge variant="outline" className="rank-tag">{row.tag}</Badge> : null}</p>
            {row.detail ? <p className="rank-detail">{row.detail}</p> : null}
          </div>
          {row.value ? (
            <div className="rank-value">
              <p className="rank-value-main">{row.value}</p>
              {row.value_detail ? <p className="rank-value-detail">{row.value_detail}</p> : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
