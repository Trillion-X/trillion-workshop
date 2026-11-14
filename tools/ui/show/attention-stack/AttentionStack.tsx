// parts/ui/show/attention-stack/AttentionStack.tsx
//
// NO PRIOR: searched ~/dev/bitfield-packages/packages/*/show for "needs you", "waiting on you" and "attention"
// (group/show/ReviewPanel.tsx is a goal board's lenses, not this job) and the 21st.dev MCP for "action required task
// list with count badges" and "needs your attention inbox card" (Notification Stack, List Group Badge, Button with
// Count Badge); none draws a person's waiting things as count-first groups with one action each.
//
// PURPOSE
//   What only the person can do, put in front of them first and kept there until it is done: one card headed by how
//   many things wait, then each kind of waiting thing as its own group, most urgent first, each with its count, its
//   icon, its first few things, and on each thing one filled button that does it (or opens the small form that does
//   it in place), with a sound to play beside the thing when it has one. The anatomy follows Deel's "For you today"
//   (count-badged groups, each with its one Review button) and 21st.dev's "Alert with Action Buttons" and "Button with
//   Count Badge": the count is the loudest thing on the card, and the action is a filled button, never a quiet link.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: every title, count, label and thing is the caller's DATA; this part never knows what waits.
//   2. A button tells what its press did in itself through the shared button's work face (button/press-work): while it
//      works it says the caller's working words and cannot be pressed again, then its done words or Try again, and a
//      refusal's words show beside it.
//   3. A thing with a form answers in place through the shared hover form (record-views/hover-form.tsx); its button
//      opens that form.
//   4. A group shows its first `shown` things and one control for the rest; nothing is cut off without saying how many.
//   5. With nothing waiting the caller draws nothing (the stack never shows an empty "all clear" box over the person's
//      work); the caller decides that by passing no groups.
//   6. Appearance lives in screen-look/show/attention-stack.css (`.attention-*`); it fits any width from a phone pane up.
//   7. A group's count may be more than the things it was handed (the caller counts what waits beyond them); its
//      "more" control only ever says how many more it can show, and the stack's `go` press (beside the count) is the
//      way through all of them.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Button, buttonVariants } from '../coss/ui/button';
import { Badge } from '../coss/ui/badge';
import { NamedIcon } from '../icon';
import { AudioClipPlayer } from '../audio-clip-player/AudioClipPlayer';
import { HoverFormCell, type HoverForm } from '../record-views/hover-form';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';

export type AttentionAction = { label: string; run?: () => unknown | Promise<unknown> };
export type AttentionThing = {
  id: string;
  title: string;
  detail?: string;
  /** A short word such as when, muted beside the title. */
  meta?: string;
  /** A sound to play beside the thing (an address the page can read). */
  clip?: string;
  action: AttentionAction;
  form?: HoverForm;
};
export type AttentionGroup = {
  id: string;
  title: string;
  icon?: string;
  count: number;
  things: AttentionThing[];
  notice?: string;
  /** One button for the whole group, such as marking everything in it seen. */
  all?: AttentionAction;
};
export type AttentionWords = { working: string; done: string; more: string; fewer: string };
export type AttentionStackProps = {
  title: string;
  count: number;
  groups: AttentionGroup[];
  words: AttentionWords;
  /** One press beside the count that goes through everything waiting (such as one thing at a time on its own screen). */
  go?: AttentionAction;
  /** How many things each group shows before its "more" control. */
  shown?: number;
};

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));

// The shared button says its own work (button/press-work): the returned promise is the work. The refusal stays beside it.
function DoButton({ action, words, variant = 'default' }: { action: AttentionAction; words: AttentionWords; variant?: 'default' | 'outline' }) {
  const [refusal, setRefusal] = React.useState('');
  const press = async () => {
    setRefusal('');
    try { await action.run?.(); } catch (cause) { setRefusal(errorWords(cause)); throw cause; }
  };
  return (
    <span className="attention-do">
      <Button size="sm" variant={variant} className="attention-do-button" pendingLabel={words.working} doneLabel={words.done} onClick={() => press()}>
        {action.label}
      </Button>
      {refusal ? <span className="attention-refusal" role="alert">{refusal}</span> : null}
    </span>
  );
}

function Thing({ thing, words }: { thing: AttentionThing; words: AttentionWords }) {
  return (
    <li className="attention-thing" data-has-clip={thing.clip ? 'true' : undefined}>
      <span className="attention-thing-text">
        <span className="attention-thing-title">{thing.title}{thing.meta ? <span className="attention-thing-meta">{thing.meta}</span> : null}</span>
        {thing.detail ? <span className="attention-thing-detail">{thing.detail}</span> : null}
      </span>
      {thing.clip ? <span className="attention-thing-clip"><AudioClipPlayer src={thing.clip} /></span> : null}
      {thing.form
        ? <HoverFormCell form={thing.form}><span className={`attention-do-button attention-do-form ${buttonVariants({ size: 'sm', variant: 'default' })}`}>{thing.action.label}</span></HoverFormCell>
        : <DoButton action={thing.action} words={words} />}
    </li>
  );
}

function Group({ group, words, shown }: { group: AttentionGroup; words: AttentionWords; shown: number }) {
  const [open, setOpen] = React.useState(false);
  const things = open ? group.things : group.things.slice(0, shown);
  const rest = group.things.length - things.length;
  return (
    <section className="attention-group" data-group={group.id} aria-label={group.title}>
      <header className="attention-group-head">
        {group.icon ? <span className="attention-group-icon" aria-hidden="true"><NamedIcon name={group.icon} /></span> : null}
        <span className="attention-group-title">{group.title}</span>
        <Badge className="attention-count" variant="destructive" size="sm">{group.count}</Badge>
        {group.all ? <span className="attention-group-all"><DoButton action={group.all} words={words} variant="outline" /></span> : null}
      </header>
      <ul className="attention-things">{things.map(thing => <Thing key={thing.id} thing={thing} words={words} />)}</ul>
      {group.notice ? <p className="attention-group-notice" role="status">{group.notice}</p> : null}
      {rest > 0 || open ? (
        <Button size="sm" variant="ghost" className="attention-more" onClick={() => setOpen(!open)}>
          {open ? words.fewer : fill(words.more, { n: rest })}
        </Button>
      ) : null}
    </section>
  );
}

/** The stack: the count, then each waiting kind in the caller's order. */
export function AttentionStack({ title, count, groups, words, go, shown = 3 }: AttentionStackProps) {
  return (
    <section className="attention-stack" aria-label={title}>
      <header className="attention-head">
        <span className="attention-total">{count}</span>
        <span className="attention-title">{title}</span>
        {go ? <Button size="sm" className="attention-go" onClick={() => go.run?.()}>{go.label}<NamedIcon name="ArrowRight" /></Button> : null}
      </header>
      {groups.map(group => <Group key={group.id} group={group} words={words} shown={shown} />)}
    </section>
  );
}
