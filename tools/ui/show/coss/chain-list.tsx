// parts/ui/show/coss/chain-list.tsx
//
// PURPOSE
//   People (or anything) as one chain from top to bottom, drawn from a guide section's `chain` DATA: each link is a
//   numbered node on a rail with an avatar, the name, a small tag (a level), a badge that stands out (a title the
//   caller gives, such as the top place's), and a quiet line under the name; between two links the rail carries the
//   caller's word for how one leads to the next. The reader's own link is lit. Anatomy follows 21st.dev's "Vertical
//   Titled Stepper" (sean0205, id 29815: numbered nodes joined by a line, the current one marked) and the Timeline of
//   cubby-ui (id 28295: a rail with items hung from it). Dropped from them: step completion checks, loading spinners
//   and dates.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no product words: every name, tag, badge and the word between links is the caller's DATA.
//   2. The order is the caller's: the first link is drawn at the top, and nothing is sorted here.
//   3. Controls are the licensed Coss sources (Badge) and the shared person mark (DisplayMark) and NamedIcon; appearance lives in
//      screen-look/show/guide.css (`.chain-*`).

import { Badge } from './ui/badge';
import { DisplayMark } from '../display-mark';
import { NamedIcon } from '../icon/NamedIcon';
import type { GuideChain } from './guide';

export function ChainList({ chain }: { chain: GuideChain }) {
  return (
    <ol className="chain-list" aria-label={chain.label}>
      {chain.links.map((link, index) => (
        <li key={link.id} className="chain-link" data-highlight={link.highlight ? '' : undefined}>
          <div className="chain-row">
            <span className="chain-node" aria-hidden>{index + 1}</span>
            <DisplayMark spec={{ name: link.name }} size="md" />
            <div className="chain-text">
              <p className="chain-name">
                <span className="chain-name-text">{link.name}</span>
                {link.tag ? <Badge variant="outline" className="chain-tag">{link.tag}</Badge> : null}
                {link.badge ? <Badge variant="outline" className="chain-badge">{link.badge.icon ? <NamedIcon name={link.badge.icon} aria-hidden className="chain-badge-icon" /> : null}{link.badge.label}</Badge> : null}
              </p>
              {link.detail ? <p className="chain-detail">{link.detail}</p> : null}
            </div>
          </div>
          {chain.between && index < chain.links.length - 1 ? <p className="chain-between"><NamedIcon name="ArrowDown" aria-hidden className="chain-between-icon" />{chain.between}</p> : null}
        </li>
      ))}
    </ol>
  );
}
