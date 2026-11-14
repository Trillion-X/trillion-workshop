// parts/ui/show/coss/person-cards.tsx
//
// PURPOSE
//   People as cards in a grid, drawn from a guide section's `people` DATA: each card is the person's mark (show/display-mark),
//   the name with a small tag beside it (a level, a role), a status at the right, a quiet line under the name,
//   then lists, each under its label when it has one (each either one line per item, or the items as chips) and the card's actions along its foot.
//   A list with no items says its `empty` words instead, so a list still being filled reads as waiting, not missing.
//   Anatomy follows 21st.dev's "Info Card" (ravikatiyar162, id 4162: avatar, name, a line under it, actions along the
//   foot) and "Opportunity Card" (ravikatiyar162, id 7464: the person's details over labelled facts, then the actions),
//   with the chips of nexus-ui's "Suggestions" (id 26546: short rounded suggestions in a wrapping row). Dropped from
//   them: follower counts, photo avatars the caller does not have, the premium badge and hover animations.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no product words: every name, label, item and action is the caller's DATA, and what an action
//      does is the caller's (the guide's ActionButton, handed in as `action`).
//   2. Nothing is shown that the caller did not send: no invented picture, count or reason.
//   3. Controls are the licensed Coss sources (Badge) and the shared person mark (DisplayMark) and the guide's own action buttons; appearance lives in
//      screen-look/show/guide.css (`.person-*`).

import * as React from 'react';
import { Badge, badgeVariantForTone } from './ui/badge';
import { DisplayMark } from '../display-mark';
import type { GuideAction, GuidePerson } from './guide';

export function PersonCards({ people, action }: { people: GuidePerson[]; action: (action: GuideAction) => React.ReactNode }) {
  return (
    <ul className="person-cards">
      {people.map(person => (
        <li key={person.id} className="person-card" data-highlight={person.highlight ? '' : undefined}>
          <div className="person-top">
            <DisplayMark spec={{ name: person.name }} size="lg" />
            <div className="person-names">
              <p className="person-name">
                <span className="person-name-text">{person.name}</span>
                {person.tag ? <Badge variant="outline" className="person-tag">{person.tag}</Badge> : null}
              </p>
              {person.detail ? <p className="person-detail">{person.detail}</p> : null}
            </div>
            {person.status ? <Badge variant={badgeVariantForTone(person.status.tone ?? 'quiet')} className="person-status" data-tone={person.status.tone ?? 'quiet'}>{person.status.label}</Badge> : null}
          </div>
          {person.lists?.map((list, index) => (
            <div key={list.label ?? index} className="person-list">
              {list.label ? <p className="person-list-label">{list.label}</p> : null}
              {!list.items.length ? <p className="person-list-empty">{list.empty ?? ''}</p>
                : list.style === 'chips' ? (
                  <ul className="person-chips">{list.items.map(item => <li key={item} className="person-chip">{item}</li>)}</ul>
                ) : (
                  <ul className="person-lines">{list.items.map(item => <li key={item} className="person-line">{item}</li>)}</ul>
                )}
            </div>
          ))}
          {person.actions?.length ? <div className="person-actions">{person.actions.map(item => <React.Fragment key={item.label}>{action(item)}</React.Fragment>)}</div> : null}
        </li>
      ))}
    </ul>
  );
}
