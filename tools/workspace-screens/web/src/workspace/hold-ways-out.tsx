// src/workspace/hold-ways-out.tsx
//
// PURPOSE
//   The hold's only ways out (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs, each a counter of src/escape-chain.json): set the thing shown
//   aside for a while with a reason the AIs weigh (a few times a day); hand it back to the AIs with what happened when
//   the person's part is done or it does not work where they are (`view.hand_back`, never counted against the asides);
//   or ask the hold off, which costs what the person chose in advance and never takes effect at once. They are drawn by the held screen itself (src/workspace/
//   waiting-screen.tsx, opened on the held thing) as the last part of the thing's own card, real buttons beside each
//   other, so the thing and its ways out are one composed screen rather than a bar pinned under it (the owner 2026-10-07:
//   the card and a separate pinned bar of plain text links overlapped and cut each other off). `useHold` reads the
//   hold's view (tool:see-what-holds-me), one view shared by the lock and the held screen, read again every
//   `every_seconds`, when the page is shown again and after every way out.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind of waiting thing or a stake: the words are src/waiting-on-you.json
//      `presentation.words.hold`, the stakes and limits its `hold`.
//   2. Only shared parts draw it: Button, Container, Text, NamedIcon and the shared form body (HoverFormBody).
//   4. The ways are folded behind ONE quiet text button (`said.aside`) that opens them in one small panel; each keeps its
//      own `.hold-way-out` and `data-way` (done, broken, aside, off), and Back from any of them returns to that panel.
//   3. A way out applies to the thing shown (its key and title), so moving to the next held thing and setting it aside
//      sets that one aside.
//   5. A thing finished on this page (`finishHere`) leaves the shared view at once, before the store answers: it is out
//      of `ranked`, and when it was the held thing with nothing else ranked the hold lets go. Only a read that started
//      after the store confirmed the finish may show it again; a read already on its way (the store can take minutes)
//      never brings it back, and a finish the store refused puts it back at once.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Button, Container, NamedIcon, Text } from '../../parts/ui';
import { HoverFormBody, type HoverForm } from '../../parts/ui/show/record-views/hover-form';
import { relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import { parseRecord, recordText, type RecordFrom, type RecordNew } from '../../parts/ui/show/record-picker';
import { postJson, readJson } from './api';
import { recordSource } from './record-source';
import type { Finish, NeedsCard, NeedsSection } from './waiting-queue';
import waitingOnYou from '../waiting-on-you.json';
import setup from '../setup-steps.json';
import firstAnswers from './first-answers.json';
import { runWorkshopTool } from './workshop-tool-api';
import { readPersonalHold } from './initial-personal-hold.mjs';

const said = waitingOnYou.presentation.words.hold;
export const HOLD_API = '/work/api/needs-you-hold';

/** Initial paint and later refreshes use the same owner and a current setup answer. */
export async function readCurrentPersonalHold(currentSetup?: unknown): Promise<HoldView> {
  return readPersonalHold(runWorkshopTool, {
    setup: currentSetup ?? await readJson(firstAnswers.paths.initial_setup),
    gate: setup.gate,
    rules: waitingOnYou.hold,
    section: waitingOnYou.sections.find(section => section.id === 'asks'),
  });
}

type Way = { id: string; label: string; icon?: string; title: string; placeholder?: string; submit: string };
type Stake = { id: string; label: string; delay_minutes?: number; chosen?: boolean; from?: string; fields?: { name: string; label: string; placeholder?: string; kind?: 'text' | 'record'; from?: RecordFrom; new?: RecordNew }[] };
export type HoldView = {
  on: boolean;
  held: { key: string; section: NeedsSection; card: NeedsCard } | null;
  /** Every thing that may hold, held first, in the DATA's rank order. */
  ranked?: { key: string; title: string }[];
  finishes?: Finish[];
  asides_left: number;
  /** The ways to hand the thing shown back to the AIs, whatever the asides left. */
  hand_back?: Way[];
  stakes: Stake[];
  off_at?: string;
  back_at?: string;
  every_seconds: number;
};

const fill = (template: string, values: Record<string, unknown>) => template.replace(/\{(\w+)\}/g, (_whole, name: string) => String(values[name] ?? ''));

// One view of the hold for the whole page: the lock (needs-you-hold.tsx) and the held screen (waiting-screen.tsx) read
// the same view, so a way out taken in the held screen moves the lock at once.
let shared: HoldView | null = null;
/** Things finished on this page (invariant 5), by every key they are known by, with when the store confirmed it. */
const finishedHere = new Map<string, { confirmedAt: number | null }>();
/** The view as this page shows it: the store's, less what was finished here (invariant 5). */
let shown: HoldView | null = null;
function showView(): void {
  if (!shared || !finishedHere.size) { shown = shared; return; }
  const gone = (key: string) => finishedHere.has(key);
  const ranked = (shared.ranked ?? []).filter(one => !gone(one.key));
  const heldGone = shared.held ? gone(shared.held.key) || gone(shared.held.card.id) : false;
  // The held thing finished here: the held screen walks on to the next ranked thing itself; with none left, let go.
  shown = { ...shared, ranked, held: heldGone && !ranked.length ? null : shared.held };
}
const tellAll = () => { showView(); for (const listen of listeners) listen(); };
/** Seed the current first answer before mounting consumers; later reads follow the same owner. */
export function primeHold(view: HoldView): void { shared = view; tellAll(); }
const listeners = new Set<() => void>();
let timer: number | undefined;
let reading = false;
let askedAgain = false;

/** A thing finished on this page (invariant 5): out of the view at once by each of its `keys`, kept out until a read that
 *  started after `write` succeeded, and back at once if `write` fails. Resolves or rejects as `write` does. */
export async function finishHere<T>(keys: string[], write: Promise<T>): Promise<T> {
  const own = keys.filter(Boolean);
  for (const key of own) finishedHere.set(key, { confirmedAt: null });
  tellAll();
  try {
    const result = await write;
    const at = Date.now();
    for (const key of own) if (finishedHere.has(key)) finishedHere.set(key, { confirmedAt: at });
    readHold();
    return result;
  } catch (failure) {
    for (const key of own) finishedHere.delete(key);
    tellAll();
    throw failure;
  }
}

function readHold(): void {
  // A read asked for while one runs (a way out just taken) runs once that one is back, so its answer is never stale.
  if (reading) { askedAgain = true; return; }
  reading = true;
  const started = Date.now();
  void readCurrentPersonalHold().then(view => {
    shared = view;
    // A read that started after the store confirmed a finish is the truth about it from here on.
    for (const [key, { confirmedAt }] of finishedHere) if (confirmedAt !== null && started > confirmedAt) finishedHere.delete(key);
    tellAll();
  }).catch(() => null).finally(() => {
    reading = false;
    window.clearTimeout(timer);
    if (askedAgain) { askedAgain = false; readHold(); return; }
    if (listeners.size) timer = window.setTimeout(readHold, Math.max(15, shared?.every_seconds ?? 90) * 1000);
  });
}
const again = () => { if (document.visibilityState === 'visible') readHold(); };
function subscribe(listen: () => void) {
  listeners.add(listen);
  if (listeners.size === 1) {
    readHold();
    document.addEventListener('visibilitychange', again);
    window.addEventListener('focus', again);
  }
  return () => {
    listeners.delete(listen);
    if (listeners.size) return;
    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', again);
    window.removeEventListener('focus', again);
  };
}

/** The hold's view, read again every `every_seconds` (at least 15), when the page is shown again and after every way
 *  out; null until read. Every part of the page that asks shares one view and one read. */
export function useHold(): { view: HoldView | null; reload: () => void } {
  const view = React.useSyncExternalStore(subscribe, () => shown);
  return { view, reload: readHold };
}

/** What the stake is sent: a record field as the chosen row's title, with its id beside it (`<name>_id`). */
const stakeValues = (stake: Stake, values: Record<string, string>) => Object.fromEntries((stake.fields ?? []).flatMap(field => {
  if (field.kind !== 'record') return [[field.name, values[field.name] ?? '']];
  const chosen = parseRecord(values[field.name] ?? '');
  return [[field.name, recordText(values[field.name] ?? '')], ...(chosen?.id ? [[`${field.name}_id`, chosen.id]] : [])];
}));

/** The ways out of the hold for the thing shown (invariant 3). */
export function WaysOut({ view, thing, reload }: { view: HoldView; thing: { key: string; title: string }; reload: () => void }) {
  const [open, setOpen] = React.useState<'aside' | 'off' | 'choose' | null>(null);
  // The ways out are folded behind ONE quiet button (the owner 2026-10-07: four stacked buttons were off-brand).
  const [menu, setMenu] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  const [way, setWay] = React.useState<Way | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [choosing, setChoosing] = React.useState<Stake | null>(null);
  const change = (body: Record<string, unknown>) => postJson<HoldView>(HOLD_API, body).then(() => { setOpen(null); setWay(null); setValues({}); setChoosing(null); setMenu(false); reload(); });
  const inForce = view.stakes.find(stake => stake.chosen) ?? view.stakes[0];
  const aside: HoverForm = {
    title: said.aside_title, submit: said.aside_submit,
    fields: [{ name: 'reason', label: fill(said.aside_left, { n: view.asides_left }), placeholder: said.aside_placeholder, kind: 'long-text' }],
    run: values => change({ op: 'aside', key: thing.key, title: thing.title, reason: values.reason }),
  };
  const handBack: HoverForm | null = way ? {
    title: way.title, submit: way.submit,
    fields: [{ name: 'reason', label: way.title, placeholder: way.placeholder, kind: 'long-text' }],
    run: values => change({ op: 'hand_back', key: thing.key, title: thing.title, way: way.id, reason: values.reason }),
  } : null;
  const choose: HoverForm | null = choosing ? {
    title: choosing.label, submit: said.choose_submit, records: recordSource,
    // A field is a text box unless the stake's DATA says it is a record (the person's own list of people).
    fields: (choosing.fields ?? []).map(field => ({ ...field, kind: field.kind === 'record' ? 'record' : 'text' })),
    run: values => change({ op: 'stake', stake: choosing.id, values: stakeValues(choosing, values) }),
  } : null;
  return (
    <Container className="hold-ways">
      {view.off_at ? <Text className="hold-pending">{fill(said.off_pending, { when: relativeWhen(view.off_at), back: view.back_at ? relativeWhen(view.back_at) : '' })}</Text> : null}
      {open === null && !way ? (
        <Container className="hold-ways-menu">
          <Button ref={trigger} variant="ghost" size="sm" className="hold-ways-trigger" aria-expanded={menu} aria-controls="hold-ways-panel" onClick={() => setMenu(shown => !shown)}>
            {said.aside}<NamedIcon name={menu ? 'ChevronUp' : 'ChevronDown'} />
          </Button>
          {menu ? (
            <Container className="hold-ways-panel" id="hold-ways-panel" role="group" aria-label={said.aside} onKeyDown={event => { if (event.key === 'Escape') { setMenu(false); trigger.current?.focus(); } }}>
              {(view.hand_back ?? []).map((item, index) => (
                <Button key={item.id} variant="ghost" size="sm" className="hold-way-out" data-way={item.id} autoFocus={index === 0} onClick={() => setWay(item)}>
                  {item.icon ? <NamedIcon name={item.icon} /> : null}{item.label}
                </Button>
              ))}
              {view.asides_left > 0
                ? <Button variant="ghost" size="sm" className="hold-way-out" data-way="aside" onClick={() => setOpen('aside')}><NamedIcon name="Clock" />{said.aside_submit}</Button>
                : <Text className="hold-pending">{said.no_asides}</Text>}
              {view.off_at ? null : <Button variant="ghost" size="sm" className="hold-way-out" data-way="off" onClick={() => setOpen('off')}><NamedIcon name="Power" />{said.off}</Button>}
            </Container>
          ) : null}
        </Container>
      ) : null}
      {handBack ? (
        <Container className="hold-way">
          <HoverFormBody className="queue-form" form={handBack} values={values} onValues={setValues} />
          <Button variant="ghost" onClick={() => setWay(null)}>{said.back}</Button>
        </Container>
      ) : null}
      {open === 'aside' ? (
        <Container className="hold-way">
          <HoverFormBody className="queue-form" form={aside} values={values} onValues={setValues} />
          <Button variant="ghost" onClick={() => setOpen(null)}>{said.back}</Button>
        </Container>
      ) : null}
      {open === 'off' && inForce ? (
        <Container className="hold-way">
          <Text className="hold-way-title">{said.off_title}</Text>
          <Text className="hold-stake">{inForce.label}</Text>
          <Container className="hold-ways-row">
            <Button variant="outline" onClick={() => change({ op: 'off' })}>{said.off_ask}</Button>
            <Button variant="ghost" onClick={() => setOpen('choose')}>{said.choose}</Button>
            <Button variant="ghost" onClick={() => setOpen(null)}>{said.back}</Button>
          </Container>
        </Container>
      ) : null}
      {open === 'choose' ? (
        <Container className="hold-way">
          <Text className="hold-way-title">{said.choose_title}</Text>
          {choose ? <HoverFormBody className="queue-form" form={choose} values={values} onValues={setValues} /> : (
            <Container className="hold-stakes">
              {view.stakes.map(stake => (
                <Button key={stake.id} variant={stake.chosen ? 'secondary' : 'outline'} className="hold-stake-choice" data-stake={stake.id}
                  onClick={() => (stake.fields?.length ? setChoosing(stake) : change({ op: 'stake', stake: stake.id }))}>
                  {stake.chosen ? <NamedIcon name="Check" /> : null}{stake.label}
                </Button>
              ))}
              <Text className="hold-pending">{said.choose_note}</Text>
            </Container>
          )}
          <Button variant="ghost" onClick={() => (choosing ? setChoosing(null) : setOpen('off'))}>{said.back}</Button>
        </Container>
      ) : null}
    </Container>
  );
}
