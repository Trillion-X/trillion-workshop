// parts/ui/show/one-at-a-time-queue/OneAtATimeQueue.tsx
//
// NO PRIOR: searched parts/ui/show for a queue walked one thing at a time ("one-step-at-a-time-surface" is one
// answer of a panel, "swipe-deck" swipes pictures, "next-step-card" is one suggestion in a row, "attention-stack"
// lists every waiting kind at once); none shows a long list as one thing, its place in the list, and its own way to
// finish it.
//
// PURPOSE
//   A long list of tasks shown one at a time: where the person is, one clear action, and compact, always-visible context
//   for why the task is here. Long titles use a quieter, smaller treatment so the task reads as a brief rather than a
//   display heading; longer forms keep their fields in a bounded scroll area with the submit action in view. The next
//   card comes in from the side; "Later" puts a task off without finishing it, and "Back" returns to the one before.
//   The visual anatomy draws on Deepstash's focused deck (Mobbin 6ba924f6), Glassdoor's one-column apply review
//   (Mobbin bb280338), Uxcel's position beside navigation (Mobbin 4ba413cf), and 21st.dev's Approval Card (component
//   36498, MIT) for its brief-description-action hierarchy; no source code was copied.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: every title, word, count and way to finish is the caller's DATA; this part never knows what
//      the things are.
//   2. Each thing finishes its own way, never through one generic box: a press (one big button), a form drawn in
//      place by the shared form body (record-views/hover-form.tsx `HoverFormBody`: words, a link or a file by each
//      box's kind), or words saying the thing comes off by itself (no button).
//  11. The card has ONE strong action (the shared button's primary face, never white). Normally it is the finish press;
//      when the card's own screen draws the strong press (`data-primary-do-it`) the finish turns outline, and a thing whose
//      live check is not_yet, done or failed draws no finish press at all (the check closes it: waiting-screen). A card
//      shown `alone` never draws a switch (guide.tsx draws a switch it holds as a press).
//   3. A finish that succeeded takes the thing out at once (the caller's next list confirms it); one that failed keeps
//      it, with the refusal's words beside the button (the shared button's work face, button/press-work).
//   4. Caller-provided context (`explain`) uses the shared ListingCard's icon-led facts. Purpose appears before the
//      owning artifact/action surface and completion after it; neither requires a disclosure press. Empty and repeated
//      rows are omitted. A thing's `links` (the goal it serves) are
//      quiet links in the line under the title, never boxed chips.
//  12. The finish press is proportionate: the shared button's primary face at its own width, at the start of the card's
//      one footer row, with the caller's `alone.under` (its ways out) beside it on the same row, divided from the thing
//      by a hairline (Tool Approval's footer: one filled press, then the quiet ones). A form or a checked finish stays
//      in the card's body, since it is the thing's own content.
//   5. The position counts the caller's `total`, which may be more than the things handed over (the caller sends the
//      first few of each kind); "n" is the thing's place among those handed over.
//   6. With nothing handed over the caller's `empty` is drawn; with everything put off, the caller's `rest` words and a
//      press to start again.
//   8. `alone` shows the first thing by itself, as a hold does: a finish never hides it here (the caller's next
//      `things` replace it). Whatever way out the caller allows is the caller's `alone.under`, drawn inside the card as
//      its last part, so the thing and its ways out are one composed card that never overlaps itself. When the caller
//      walks several things this way (`alone.moves`), their place ("2 of 3") and only the moves that can be made (a
//      Back with something before it, a Next with something after it) are drawn above the card in ONE header row, a
//      grid of three: the way out and the previous thing at the start, the place in the middle, the next at the end (the
//      row is a labelled group named by the place). An empty `title` draws no head (the card's own title already names
//      the thing).
//  10. A move that cannot be made is not drawn: there is no Back on the first thing, so nothing shows that cannot be
//      pressed (a user: "the back button shows but can't be pressed").
//   9. A thing's `body`, when given, is drawn in place of its one-line detail: the caller's own content (steps, a live
//      check, a control mounted in place), so a thing is shown as itself rather than as a paragraph about it. A
//      `checked` finish with empty words draws nothing (the body already says what is being checked).
//   7. Appearance lives in screen-look/show/one-at-a-time-queue.css (`.queue-*`); it fits any width from a phone up,
//      and a reduced-motion setting turns the slide off.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Button } from '../coss/ui/button';
import { NamedIcon } from '../icon';
import { AudioClipPlayer } from '../audio-clip-player/AudioClipPlayer';
import { ListingCard, type ListingFact, type ListingChip, type ListingFactChips } from '../listing-card';
import { HoverFormBody, type HoverForm } from '../record-views/hover-form';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';

export type QueueAction = { label: string; run: () => unknown | Promise<unknown> };
/** How one thing is finished. */
export type QueueFinish =
  /** A press; its run resolving `false` means the thing is not finished by it (it was only opened): the queue moves
   *  on as with Later. */
  | { kind: 'press'; label: string; run: () => Promise<unknown>; said?: string }
  | { kind: 'form'; form: HoverForm }
  | { kind: 'checked'; words: string };
export type QueueThing = {
  key: string;
  title: string;
  /** A Lucide icon name for the kind of thing. */
  icon?: string;
  /** Who asked for the thing, in the caller's words. */
  byline?: string;
  /** When it is due or was added, in the caller's words. */
  when?: string;
  /** A short line under the title, such as what was said. */
  detail?: string;
  /** The thing itself, drawn in place of `detail` when the caller has more than a line to show (steps to follow, a
   *  check running, a control): any content the caller composes from shared parts (invariant 9). */
  body?: React.ReactNode;
  /** Small muted words beside the title, such as a round and measured progress. */
  meta?: string[];
  /** A sound to play with the thing. */
  clip?: string;
  /** Caller-owned label that distinguishes a short clip from a full recording. */
  clipLabel?: string;
  /** Caller-owned audio status words when no recording is ready to play. */
  audioNote?: string;
  finish: QueueFinish;
  /** A second press, such as opening the thing where it lives. */
  open?: QueueAction;
  /** Caller-provided context for the shared ListingCard summary; rows with empty text are left out. */
  explain?: { title: string; rows: { label: string; text?: string | null; icon?: string; role?: 'purpose' | 'completion' | 'context' }[] };
  /** Shared listing-card chips for related records or fields. */
  chips?: ListingChip[];
  /** Quiet links in the line under the title, such as the goal the thing serves (invariant 4). */
  links?: { label: string; value?: string; icon?: string; run?: () => unknown }[];
  factChips?: ListingFactChips;
};
export type QueueWords = { position: string; later: string; back: string; working: string; done: string; again: string };
export type QueueEmpty = { icon?: string; title: string; detail?: string; action?: QueueAction };
export type OneAtATimeQueueProps = {
  title: string;
  things: QueueThing[];
  /** How many things there are in all, counting those not handed over. */
  total: number;
  words: QueueWords;
  /** Drawn when nothing is left. */
  empty: QueueEmpty;
  /** Drawn when every thing left was put off. */
  rest: { title: string; detail?: string };
  /** A press at the top, such as going back to where the person came from. */
  leave?: QueueAction;
  /** One thing alone (invariant 8): no place in a list, no progress, no Back and no Later; the caller's own way out,
   *  if any, drawn under the card instead. */
  alone?: { under?: React.ReactNode; moves?: AloneMoves };
};
/** The things walked one at a time while each is shown alone (invariant 8): the place, and the moves that can be made. */
export type AloneMoves = { position: string; back?: QueueAction; next?: QueueAction };

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));

/** True while the card's own screen draws the card's one strong press (guide.tsx `data-primary-do-it`): the finish is then quiet. */
function useScreenHasStrongPress(ref: React.RefObject<HTMLElement | null>): boolean {
  const [has, setHas] = React.useState(false);
  React.useLayoutEffect(() => {
    const card = ref.current?.closest('.queue-card');
    if (!card) return undefined;
    const look = () => setHas(Boolean(card.querySelector('[data-primary-do-it]')));
    look();
    const watching = new MutationObserver(look);
    watching.observe(card, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-primary-do-it'] });
    return () => watching.disconnect();
  }, [ref]);
  return has;
}

function FinishPress({ finish, words, onDone, onLater }: { finish: Extract<QueueFinish, { kind: 'press' }>; words: QueueWords; onDone: () => void; onLater: () => void }) {
  const [refusal, setRefusal] = React.useState('');
  const holder = React.useRef<HTMLDivElement | null>(null);
  const quiet = useScreenHasStrongPress(holder);
  const press = async () => {
    setRefusal('');
    let finished: unknown;
    try { finished = await finish.run(); } catch (cause) { setRefusal(errorWords(cause)); throw cause; }
    if (finished === false) onLater(); else onDone();
  };
  return (
    <div className="queue-finish" data-finish="press" data-quiet={quiet ? 'true' : undefined} ref={holder}>
      <Button size={quiet ? 'default' : 'lg'} variant={quiet ? 'ghost' : 'default'} className="queue-finish-press" pendingLabel={words.working} doneLabel={finish.said ?? words.done} onClick={() => press()}>
        <NamedIcon name="Check" />{finish.label}
      </Button>
      {refusal ? <p className="queue-refusal" role="alert">{refusal}</p> : null}
    </div>
  );
}

function FinishForm({ finish, onDone }: { finish: Extract<QueueFinish, { kind: 'form' }>; onDone: () => void }) {
  // What the person typed or chose; a box they have not touched holds the form's own `start` (a suggested row).
  const [values, setValues] = React.useState<Record<string, string>>({});
  const compact = finish.form.fields.length > 3;
  return (
    <div className="queue-finish" data-finish="form" data-many-fields={compact ? 'true' : undefined}>
      <HoverFormBody className="queue-form" form={{ ...finish.form, title: '', details: [] }} values={values} onValues={setValues} onSent={onDone} autoFocus={false} />
    </div>
  );
}

function Card({ thing, words, onDone, onLater, under, alone = false }: { thing: QueueThing; words: QueueWords; onDone: () => void; onLater: () => void; under?: React.ReactNode; alone?: boolean }) {
  const finish = thing.finish;
  const seenFacts = new Set<string>();
  const representedByChip = new Set([...(thing.chips ?? []).map(chip => chip.value ?? chip.label), ...(thing.links ?? []).map(link => link.value ?? link.label)]
    .map(value => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()));
  const facts = (thing.explain?.rows ?? [])
    .filter(row => row.text && row.text.trim())
    .filter(row => {
      const value = row.text!.trim();
      const key = value.normalize('NFC').replace(/\s+/g, ' ').toLocaleLowerCase();
      if (seenFacts.has(key) || representedByChip.has(key)) return false;
      seenFacts.add(key);
      return true;
    })
    .map(row => ({ label: row.label, value: row.text!.trim(), role: row.role ?? 'context', ...(row.icon ? { icon: row.icon } : {}) }));
  const context: ListingFact[] = facts.filter(fact => fact.role === 'context');
  const purpose = facts.filter(fact => fact.role === 'purpose');
  const completion = facts.filter(fact => fact.role === 'completion');
  const byline = [thing.meta?.join(' · '), thing.byline].filter(Boolean).join(' · ');
  const listing = {
    id: thing.key,
    title: thing.title,
    ...(thing.icon ? { icon: thing.icon } : {}),
    ...(byline ? { byline } : {}),
    ...(thing.when ? { when: thing.when } : {}),
    ...(thing.chips?.length ? { chips: thing.chips } : {}),
    ...(thing.factChips ? { factChips: thing.factChips } : {}),
    ...(context.length ? { facts: context } : {}),
  };
  const footer = finish.kind === 'press' || under ? (
    <footer className="queue-card-under">
      {finish.kind === 'press' ? <FinishPress finish={finish} words={words} onDone={onDone} onLater={onLater} /> : null}
      {under}
    </footer>
  ) : undefined;
  return (
    <div className="queue-card" role="group" aria-label={thing.title} data-thing={thing.key} data-alone={alone ? 'true' : undefined}>
      <ListingCard
        listing={listing}
        className="queue-listing"
        content={(
          <div className="queue-listing-content">
            {purpose.map(fact => <p key={fact.label} className="queue-task-purpose"><span>{fact.label}</span>{fact.value}</p>)}
            {thing.links?.length ? (
              <div className="queue-card-links">
                {thing.links.map(link => (link.run
                  ? <Button key={link.label} variant="link" size="sm" className="queue-card-link" onClick={() => link.run?.()}>{link.icon ? <NamedIcon name={link.icon} /> : null}{link.label}</Button>
                  : <span key={link.label} className="queue-card-link">{link.icon ? <NamedIcon name={link.icon} /> : null}{link.label}</span>))}
              </div>
            ) : null}
            {!thing.body && thing.detail ? <p className="queue-card-detail">{thing.detail}</p> : null}
            {thing.body ? <div className="queue-card-body">{thing.body}</div> : null}
            {completion.map(fact => <p key={fact.label} className="queue-task-completion"><NamedIcon name={fact.icon ?? 'CircleCheck'} /><span><span>{fact.label}</span>{fact.value}</span></p>)}
            {thing.clip ? <div className="queue-card-clip">{thing.clipLabel ? <span className="queue-card-meta">{thing.clipLabel}</span> : null}<AudioClipPlayer src={thing.clip} /></div> : null}
            {!thing.clip && thing.audioNote ? <p className="queue-audio-note" role="status"><NamedIcon name="AudioLines" />{thing.audioNote}</p> : null}
            {finish.kind === 'form' ? <FinishForm finish={finish} onDone={onDone} /> : null}
            {finish.kind === 'checked' && finish.words ? (
              <p className="queue-checked"><NamedIcon name="CircleCheck" /><span>{finish.words}</span></p>
            ) : null}
          </div>
        )}
        controls={footer}
      />
    </div>
  );
}

/** The queue: where the person is, the one thing in front of them, and what moves them on. */
export function OneAtATimeQueue({ title, things, total, words, empty, rest, leave, alone }: OneAtATimeQueueProps) {
  const [gone, setGone] = React.useState<Set<string>>(() => new Set());
  const [index, setIndex] = React.useState(0);
  const [moving, setMoving] = React.useState<'on' | 'back'>('on');
  // A thing the caller no longer hands over is gone already; one finished here is gone before the caller says so.
  const left = things.filter(thing => !gone.has(thing.key));
  const current = left[index] ?? null;
  // The caller's total still counts what it hands over; a thing finished here and still handed over is counted off.
  const all = Math.max(total - (things.length - left.length), left.length);

  const done = (key: string) => () => { setMoving('on'); setGone(current => new Set(current).add(key)); };
  const later = () => { setMoving('on'); setIndex(at => at + 1); };
  const back = () => { setMoving('back'); setIndex(at => Math.max(0, at - 1)); };

  if (!left.length) {
    return (
      <section className="queue" aria-label={title} data-state="empty">
        <div className="queue-empty">
          <span className="queue-empty-icon" aria-hidden="true"><NamedIcon name={empty.icon ?? 'CircleCheck'} /></span>
          <h2 className="queue-empty-title">{empty.title}</h2>
          {empty.detail ? <p className="queue-empty-detail">{empty.detail}</p> : null}
          {empty.action ? <Button variant="outline" onClick={() => empty.action?.run()}>{empty.action.label}</Button> : null}
        </div>
      </section>
    );
  }

  // Alone, the caller's next list is the only truth: a finish never hides the thing here, the caller's next answer
  // replaces it (a batch half done stays, smaller).
  if (alone && things.length) {
    const only = things[0];
    const moves = alone.moves;
    const leaveButton = leave ? <Button size="icon-sm" variant="ghost" className="queue-leave" aria-label={leave.label} onClick={() => leave.run()}><NamedIcon name="ArrowLeft" /></Button> : null;
    return (
      <section className="queue" aria-label={title || only.title} data-state="alone">
        {moves ? (
          <>
            {title ? <h1 className="queue-title">{title}</h1> : null}
            {/* One header row (invariant 8): the way back and the previous thing at the start, the place in the middle, the next at the end. */}
            <header className="queue-head queue-alone-moves" role="group" aria-label={moves.position}>
              <div className="queue-head-start">
                {leaveButton}
                {moves.back ? <Button variant="ghost" size="sm" className="queue-back" onClick={() => moves.back?.run()}><NamedIcon name="ChevronLeft" />{moves.back.label}</Button> : null}
              </div>
              <span className="queue-position" aria-live="polite">{moves.position}</span>
              <div className="queue-head-end">
                {moves.next ? <Button variant="ghost" size="sm" className="queue-later" onClick={() => moves.next?.run()}>{moves.next.label}<NamedIcon name="ChevronRight" /></Button> : null}
              </div>
            </header>
          </>
        ) : title || leave ? (
          <header className="queue-head">
            {leaveButton}
            {title ? <h1 className="queue-title">{title}</h1> : null}
          </header>
        ) : null}
        <div className="queue-deck" data-behind={0}>
          <div key={only.key} className="queue-slot" data-moving="on">
            <Card thing={only} words={words} onDone={() => {}} onLater={() => {}} under={alone.under} alone />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="queue" aria-label={title} data-state={current ? 'thing' : 'rest'}>
      <header className="queue-head">
        {leave ? <Button size="icon-sm" variant="ghost" className="queue-leave" aria-label={leave.label} onClick={() => leave.run()}><NamedIcon name="ArrowLeft" /></Button> : null}
        <h1 className="queue-title">{title}</h1>
        <span className="queue-position" aria-live="polite">{fill(words.position, { n: Math.min(index + 1, left.length), total: all })}</span>
      </header>
      {current ? (
        <div className="queue-deck" data-behind={Math.min(left.length - index - 1, 2)}>
          <div key={current.key} className="queue-slot" data-moving={moving}>
            <Card thing={current} words={words} onDone={done(current.key)} onLater={later} />
          </div>
        </div>
      ) : (
        <div className="queue-empty">
          <span className="queue-empty-icon" aria-hidden="true"><NamedIcon name="Clock" /></span>
          <h2 className="queue-empty-title">{rest.title}</h2>
          {rest.detail ? <p className="queue-empty-detail">{rest.detail}</p> : null}
          <Button variant="outline" onClick={() => { setMoving('back'); setIndex(0); }}>{words.again}</Button>
        </div>
      )}
      {current ? (
        <footer className="queue-moves">
          {index > 0 ? <Button variant="ghost" className="queue-back" onClick={back}><NamedIcon name="ChevronLeft" />{words.back}</Button> : <span />}
          {current.open ? <Button variant="outline" className="queue-open" onClick={() => current.open?.run()}>{current.open.label}<NamedIcon name="ArrowUpRight" /></Button> : null}
          <Button variant="ghost" className="queue-later" onClick={later}>{words.later}<NamedIcon name="ChevronRight" /></Button>
        </footer>
      ) : null}
    </section>
  );
}
