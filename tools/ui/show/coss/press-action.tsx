// parts/ui/show/coss/press-action.tsx
//
// PURPOSE
//   Makes a whole block (a card, a foot row, a name in a table) the press of one guide action: the block is drawn as a
//   Coss Button holding the caller's children, and pressing it reports the action to the caller. A link to another
//   site is a real link that opens a new tab. Used by profile-card.tsx, course-cards.tsx and rank-table.tsx, whose
//   actions are the block itself rather than a labelled button beside it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no product words and no addresses: what the action does is the caller's (`onAction`).
//   2. An action that names `confirm` asks in place, never in a modal: the first press shows the question with a
//      confirming button and a button to keep things as they are; only the confirming press acts.
//   3. Controls are the licensed Coss Button; appearance lives in screen-look/show/guide.css (`.press-action*`).

import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from './ui/button';
import type { GuideAction, GuideActionHandler } from './guide';

export function PressAction({ action, onAction, className, children }: { action: GuideAction; onAction: GuideActionHandler; className?: string; children: React.ReactNode }) {
  const [asking, setAsking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const confirm = action.send?.confirm;
  const run = async () => {
    setAsking(false);
    setBusy(true);
    try { await onAction(action, {}); } finally { setBusy(false); }
  };
  const classes = className ? `press-action ${className}` : 'press-action';
  if (typeof action.href === 'string' && /^https?:\/\//.test(action.href) && !confirm) {
    return (
      <Button variant="ghost" className={classes} render={<a href={action.href} target="_blank" rel="noopener noreferrer" />}>
        {children}
        <ExternalLink aria-hidden className="press-action-external" />
      </Button>
    );
  }
  return (
    <>
      <Button type="button" variant="ghost" className={classes} title={action.label} aria-busy={busy || undefined} disabled={busy} onClick={() => { if (confirm && !asking) setAsking(true); else void run(); }}>
        {children}
      </Button>
      {asking ? (
        <span className="press-action-confirm" role="status">
          <span className="press-action-question">{confirm}</span>
          <Button type="button" size="xs" variant="destructive-outline" onClick={() => run()}>{`Yes, ${action.label.charAt(0).toLowerCase()}${action.label.slice(1)}`}</Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setAsking(false)}>Keep it</Button>
        </span>
      ) : null}
    </>
  );
}
