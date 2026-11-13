// src/workspace/waiting-screen.tsx
//
// PURPOSE
//   Waiting on you, one thing at a time (the screen at /waiting, row tool:screen-waiting in
//   records/workshop-screen-tool-records.json, opened by Home's Go through them press and by any AI app's show_screen):
//   everything only the person can do, from the same answer Home's Needs you stack reads (GET /work/api/waiting-on-you,
//   src/waiting-on-you.json), walked one after another until none is left, in the shared one-at-a-time queue
//   (parts/ui/show/one-at-a-time-queue). Each thing says why it needs them, what it unlocks, which goal it serves and
//   what else was tried, with purpose and completion beside its one way to finish.
//   Opened on ONE thing (`/waiting/<key>` or `/waiting?thing=<card id>`, input `thing`, the screen the hold locks the
//   arrangement on: src/workspace/needs-you-hold.tsx, and where a source with no other place opens its cards, such as
//   an unnamed voice) it shows that thing alone, as itself: its steps as a checklist with the values to copy beside
//   them, a saved login it uses shown in place, the place in Trillion it is done in drawn in place (its `does_in`,
//   such as the Facebook Page's Connect on Connections), and what Trillion is checking, read again every
//   `hold.live_seconds` until the thing leaves by itself. While the hold holds it, the card ends with the hold's ways
//   out (src/workspace/hold-ways-out.tsx), and above it the other held things are walked next and back in the hold's
//   rank order (`ranked`), so the held screen is one composed whole.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind of waiting thing, a finish or a tool: they are the answer's DATA, finished through the
//      one path Home's stack uses (needs-you.tsx `finishingOf`), so a thing finishes the same way wherever it is shown.
//   2. The words, which card fields explain a thing (waiting-on-you.json presentation.words.waiting_queue.explain_rows)
//      and the screen a saved
//      login is shown in place with (waiting_queue.login_in_place) are DATA.
//   3. After a thing is finished the answer is read again in the background; the queue has already moved on.
//   4. A thing is drawn as itself, never as one paragraph about it (waiting-queue.ts invariant 7): numbered lines are
//      steps (the shared StepsChecklist), a step's short value is a press that copies it (the shared CopyButton), a
//      card's `uses_login` is that saved login shown in place by its own screen, a card's `does_in` is the screen it
//      is done in, narrowed to it and shown in place (addresses.mjs `placeOfAddress`; a card that names its login and
//      whose `does_in` names no target, an old row, shows the login and not the whole screen), a card's `checking` (else its
//      `done_when`, for a thing Trillion checks itself) is the shared LiveCheck, and the rest is a passage read through
//      the shared reading renderer (MarkdownWords). Nothing here offers an "I did it": a thing Trillion checks is done
//      when Trillion sees it.
//   5. Opened on one thing, the thing's key may be its own key, a card's id, a card a batch holds (one voice names its
//      whole naming pass) or a card's id without its source (waiting-queue.ts `queueThing`), so every address a notice,
//      a source or an AI hands out finds it; once it leaves the answer the screen says it is done.
//   6. A thing that runs in rounds (its `round_step`, src/work-rounds.mjs) says its round, its step and its measured
//      `progress` first, and its press finishes this round: the server keeps what the round showed and opens the next.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { OneAtATimeQueue, type QueueFinish, type QueueThing } from '../../parts/ui/show/one-at-a-time-queue';
import { StepsChecklist } from '../../parts/ui/show/steps-checklist';
import { LiveCheck } from '../../parts/ui/show/live-check';
import { CopyButton } from '../../parts/ui/show/copy-button/CopyButton';
import { MarkdownWords } from '../../parts/ui/show/markdown-block/MarkdownWords';
import { ArtifactEvidence, type EvidenceReference } from '../../parts/ui/show/artifact-evidence';
import { safeLinkedIdentityUrl } from '../../parts/ui/show/linked-identity/LinkedIdentity';
import { relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import { readJson } from './api';
import { finishHere, useHold, WaysOut } from './hold-ways-out';
import { returnToLockedScreen } from '../../parts/screen-arrangement/show/arrangement-lock';
import { PlaceInPlace, ScreenInPlace } from './screen-in-place';
import { refusal } from './failure';
import { openScreenOn } from './open-screen';
import { clipOf, finishingOf, markDone, openCard, type Open } from './needs-you';
import { clipRangeOf, detailParts, loadSupplementalPages, linkOf, queueOf, queueThing, stepValue, successorAfterRemoval, totalOf, unavailableBatchCount, wayOf, type NeedsAnswer, type NeedsCard, type NeedsSection } from './waiting-queue';
import waitingOnYou from '../waiting-on-you.json';
import { bytesAddress, contentTypeOf } from './file-picture';
import checkWords from './live-check-words.json';

const words = waitingOnYou.presentation.words;
const said = words.waiting_queue;
const holdWords = words.hold;
const API = '/work/api/waiting-on-you';
const open: Open = (screen, title, input = {}) => openScreenOn(screen, input, title);
const fill = (template: string, values: Record<string, unknown>) => template.replace(/\{(\w+)\}/g, (_whole, name: string) => String(values[name] ?? ''));
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const namespaceIdentity = (value: unknown): value is string => typeof value === 'string' && /^(?:1f|12):[0-9a-f]{64}$/.test(value);

/** The generic evidence contract carried by any card: resolved Namespace artifacts, references and current context. */
function evidenceFor(card: NeedsCard) {
  const artifacts = new Map<string, { url: string; contentType: string; label: string }>();
  const addArtifact = (identity: unknown, nameValue: unknown, typeValue: unknown) => {
    if (!namespaceIdentity(identity)) return;
    const name = text(nameValue) ?? 'Source file';
    const storedType = text(typeValue);
    artifacts.set(identity, { url: bytesAddress(identity), contentType: contentTypeOf(name, storedType), label: name.split('/').pop() ?? name });
  };
  addArtifact(card.artifact_identity, card.artifact_name, card.artifact_media_type);
  const source = card.source_reference && typeof card.source_reference === 'object' ? card.source_reference as Record<string, unknown> : null;
  if (source && source.kind === 'file') addArtifact(source.id, source.title ?? source.label, source.media_type);
  const references: EvidenceReference[] = source ? [{
    label: 'Source', value: text(source.title) ?? text(source.label) ?? text(source.kind) ?? 'Source',
  }] : [];
  const context: EvidenceReference[] = [];
  const status = text(card.record_status);
  if (status) context.push({ label: 'Status', value: status });
  const destinations = Array.isArray(card.delivery_context) ? card.delivery_context : [];
  const platformUrls = card.platform_urls && typeof card.platform_urls === 'object' ? card.platform_urls as Record<string, unknown> : {};
  const linkedPlatforms = new Set<string>();
  for (const item of destinations) {
    if (!item || typeof item !== 'object') continue;
    const destination = item as Record<string, unknown>;
    const label = text(destination.label) ?? text(destination.platform);
    const state = text(destination.status);
    if (label && state) context.push({ label, value: state });
    const address = text(destination.url) ?? text(platformUrls[String(destination.platform ?? '')]);
    if (label && address) {
      const safeAddress = safeLinkedIdentityUrl(address);
      references.push({ label: `${label} copy`, value: address, ...(safeAddress ? { address: safeAddress } : {}) });
      linkedPlatforms.add(String(destination.platform ?? label));
    }
    const issue = text(destination.error);
    if (label && issue) context.push({ label: `${label} detail`, value: issue });
  }
  for (const [platform, value] of Object.entries(platformUrls)) {
    if (linkedPlatforms.has(platform)) continue;
    const address = text(value);
    if (!address) continue;
    const safeAddress = safeLinkedIdentityUrl(address);
    references.push({ label: `${platform} copy`, value: address, ...(safeAddress ? { address: safeAddress } : {}) });
  }
  return { artifacts: [...artifacts.values()], references, context };
}

/** A saved login shown in place by its own screen (waiting_queue.login_in_place), narrowed to that one login. */
function LoginInPlace({ title }: { title: string }) {
  const place = said.login_in_place;
  return <PlaceInPlace className="waiting-login-in-place" entry={place.entry} input={{ ...place.input, [place.row_input]: title }} placeKey={`login-in-place:${title}`} />;
}

/** Whether an address names what to show of its screen (`show_row`, `show_section`): one without is the whole screen. */
const narrowsScreen = (address: string) => { try { return [...new URL(address, location.origin).searchParams.keys()].some(field => field.startsWith('show_')); } catch { return false; } };
const plainName = (name: string) => name.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').toLowerCase();
/** Whether an address shows only the saved login already shown in place, so drawing it would show that login twice. */
const showsOnlyLogin = (address: string, login: string) => { try { const rows = new URL(address, location.origin).searchParams.get('show_row'); return rows !== null && rows.split(',').every(row => plainName(row) === plainName(login)); } catch { return false; } };

/** What Trillion is checking for this thing, and when it last looked (invariant 4). */
export type Watch = { readAt: number; gone: boolean; /** The last read of the answer failed: say so, never an old check as if it were fresh. */ readFailed?: boolean };
/** What the server says is true now (src/workspace CONTRACT card.check): the check's state, its plain words, when it looked. */
export type CardCheck = { state: 'done' | 'not_yet' | 'cannot_check' | 'failed'; words: string; checked_at?: string };
const checkOf = (card: NeedsCard): CardCheck | null => {
  const check = card.check as Partial<CardCheck> | undefined;
  return check && typeof check.words === 'string' && check.words.trim() && ['done', 'not_yet', 'cannot_check', 'failed'].includes(String(check.state)) ? check as CardCheck : null;
};
const ROW_STATE = { done: 'done', not_yet: 'not_yet', cannot_check: 'plain', failed: 'failed' } as const;

/** True for the first `seconds` after it is drawn, then false: "Checking…" is only ever said for this long. */
function useFirstAnswerWindow(seconds: number): boolean {
  const [waiting, setWaiting] = React.useState(true);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setWaiting(false), seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);
  return waiting;
}

/** The one line that says what Trillion sees now, from the answer's `card.check` (never a pill that stays). */
function CheckLine({ card, checks, watch }: { card: NeedsCard; checks: string | null; watch?: Watch }) {
  const waiting = useFirstAnswerWindow(checkWords.first_answer_seconds);
  const check = checkOf(card);
  const when = (iso: string | number) => relativeWhen(new Date(iso).toISOString());
  let row: { label: string; state: 'watching' | 'done' | 'not_yet' | 'plain' | 'failed'; detail?: string };
  if (watch?.gone) row = { label: check?.state === 'done' ? check.words : checks ?? said.thing_done_detail, state: 'done', detail: said.thing_done_detail };
  else if (watch?.readFailed) row = { label: checkWords.could_not_read, state: 'failed', detail: checkWords.retry_note };
  else if (check) row = { label: check.words, state: ROW_STATE[check.state], ...(check.state === 'failed' ? { detail: checkWords.retry_note } : check.state !== 'cannot_check' && check.checked_at ? { detail: fill(said.checked_at, { when: when(check.checked_at) }) } : {}) };
  else if (waiting) row = { label: checkWords.checking, state: 'watching' };
  else row = { label: checks ?? '', state: 'plain' };
  if (!row.label) return null;
  return <LiveCheck label={said.checking_label} rows={[{ key: 'checking', ...row }]} />;
}

/** The thing itself (invariant 4): its passage, its steps with their values, the login it uses, and the live check. */
function ThingBody({ card, checks, watch, changed }: { card: NeedsCard; checks: string | null; watch?: Watch; changed?: () => void }) {
  const parts = detailParts(card.detail);
  const login = text(card.uses_login);
  // A thing that names its login shows that login, never the whole screen a bare `does_in` (an old row) would open, nor
  // the same login a second time.
  const doesIn = text(card.does_in) && !(login && (!narrowsScreen(text(card.does_in)!) || showsOnlyLogin(text(card.does_in)!, login))) ? text(card.does_in) : null;
  const loginStep = login ? parts.steps.findIndex(step => step.includes(login)) : -1;
  const steps = parts.steps.map((step, index) => {
    const { label, value } = stepValue(step);
    return {
      key: `${index}:${step}`,
      label,
      ...(value ? { beside: <CopyButton text={value} label={value} copiedLabel={said.copied} variant="outline" size="sm" className="waiting-value" /> } : {}),
      ...(login && index === loginStep ? { under: <LoginInPlace title={login} /> } : {}),
    };
  });
  const evidence = evidenceFor(card);
  const hasEvidence = evidence.artifacts.length || evidence.references.length || evidence.context.length;
  return (
    <>
      {hasEvidence && !card.finishes_in_place ? <ArtifactEvidence {...evidence} onOpenReference={reference => { if (reference.address) window.open(reference.address, '_blank', 'noopener'); }} /> : null}
      {parts.before ? <MarkdownWords words={parts.before} breaks className="file-preview-markdown waiting-words" /> : null}
      {steps.length ? <StepsChecklist steps={steps} words={{ count: said.steps_count, tick: said.step_tick }} keptAt={`waiting-steps:${card.id}`} /> : null}
      {login && loginStep < 0 ? <LoginInPlace title={login} /> : null}
      {parts.after ? <MarkdownWords words={parts.after} breaks className="file-preview-markdown waiting-words" /> : null}
      {doesIn ? <ScreenInPlace className="waiting-place-in-place" address={doesIn} onChanged={changed} /> : null}
      {checks || checkOf(card) || watch?.readFailed ? <CheckLine card={card} checks={checks} watch={watch} /> : null}
    </>
  );
}

/** One waiting thing as the queue draws it; `openWith` is where a thing opened from it opens (beside, on this page;
 *  inside the lock when the hold holds it, needs-you-hold.tsx), `watch` when it is shown alone and read again. */
export function queueThingOf(answer: NeedsAnswer, section: NeedsSection, card: NeedsCard, done: () => void, openWith: Open = open, watch?: Watch, finishingHere?: (write: Promise<unknown>) => Promise<unknown>): QueueThing {
  // A confirmed absence cannot keep the removed thing's editor, artifact or actions alive.
  if (watch?.gone) return { key: card.id, title: card.title ?? section.title, finish: { kind: 'checked', words: said.thing_done_detail } };
  const finishing = finishingOf(answer, section, card, openWith, done);
  // A press that finishes the thing hands its write to `finishingHere` (the held screen takes the thing off at once and
  // keeps it off unless the write is refused); a press that only opens it is run as it is.
  const settle = (write: Promise<unknown>) => (finishingHere ? finishingHere(write) : write);
  const checkedByTrillion = wayOf(answer, section, card).kind === 'checked';
  const checks = text(card.checking) ?? (checkedByTrillion ? text(card.done_when) : null) ?? checkOf(card)?.words ?? null;
  const facts = card.facts && typeof card.facts === 'object' ? card.facts as Record<string, unknown> : {};
  const body = card.body && typeof card.body === 'object' ? card.body as Record<string, unknown> : {};
  const due = text(card.due) ?? text(facts.due) ?? text(body.deadline);
  const finish: QueueFinish = card.finishes_in_place && text(card.does_in)
    ? { kind: 'checked', words: '' }
    : finishing.form
    ? { kind: 'form', form: finishing.form }
    // Trillion checks it itself (not_yet, done, failed): the check closes the card, so no Done press is drawn beside it.
    : finishing.press && !(checkOf(card) && checkOf(card)!.state !== 'cannot_check')
      ? { kind: 'press', label: finishing.press.label, ...(finishing.said ? { said: finishing.said } : {}),
        run: async () => { await (finishing.press!.finishes ? settle(finishing.press!.run()) : finishing.press!.run()); return finishing.press!.finishes; } }
      // Nothing checks it and the server gave no press (cannot_check, or no check on a thing Trillion does not watch):
      // the card still has its one primary Done, which marks the row done as every finish does, never a dead end.
      : !finishing.press && (!checkedByTrillion || checkOf(card)?.state === 'cannot_check')
        && (!checkOf(card) || checkOf(card)!.state === 'cannot_check') && !card.batch
        ? { kind: 'press', label: words.needs_you.done, run: async () => { await settle(markDone([card.id]).then(done)); return true; } }
      // The live check already says what Trillion watches for; the finish's own words would say it twice.
      : { kind: 'checked', words: checks ? '' : finishing.checked ?? '' };
  // A thing finished some other way than opening it can still be opened where it lives.
  const link = linkOf(card);
  const opens = finish.kind !== 'press' || finishing.press?.finishes;
  const clipRange = clipRangeOf(card.clip_at);
  const clip = clipOf(card);
  const round = text(card.round_step) ? fill(said.round, { ...card, round: Number(card.rounds_done ?? 0) + 1 }) : null;
  const measured = text(card.progress) && card.progress !== 'Not measured' ? text(card.progress) : null;
  const by = text(card.by);
  const byline = by ? fill(said.by, { by }) : null;
  const received = text(card.at);
  const receivedWhen = received && Number.isFinite(Date.parse(received)) ? relativeWhen(received) : received;
  const dueWhen = due ? fill(said.due, { when: Number.isFinite(Date.parse(due)) ? relativeWhen(due) : due }) : null;
  const when = [receivedWhen, dueWhen].filter(Boolean).join(' · ');
  const meta = [round, measured].filter((part): part is string => Boolean(part));
  const explainRows = said.explain_rows.map((row: { card: string; label: string; icon?: string; role?: 'purpose' | 'completion' | 'context' }) => ({
    label: row.label,
    text: text(card[row.card]),
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.role ? { role: row.role } : {}),
  }));
  const pursuit = text(card.pursuit);
  // A batch's own form already draws each of its cards; its words stay the one line they are.
  const drawn = !Array.isArray(card.batch) && (card.detail || checks || text(card.uses_login) || text(card.does_in));
  // A round's press finishes this round, never the whole thing (work-rounds.mjs invariant 3).
  if (round && finish.kind === 'press') finish.label = words.needs_you.finish_round;
  return {
    key: card.id,
    title: card.title ?? section.title,
    ...(section.icon ? { icon: section.icon } : {}),
    ...(byline ? { byline } : {}),
    ...(when ? { when } : {}),
    ...(drawn ? { body: <ThingBody card={card} checks={checks} watch={watch} changed={done} /> } : card.detail ? { detail: card.detail } : {}),
    ...(meta.length ? { meta } : {}),
    explain: { title: said.explain, rows: explainRows },
    // The goal it serves is a quiet link that opens the thing where it lives in that goal, never a boxed chip.
    ...(pursuit ? { links: [{ label: fill(said.pursuit_chip.label, { pursuit }), value: pursuit, icon: said.pursuit_chip.icon, ...(card.opens || card.address ? { run: () => openCard(card, openWith) } : {}) }] } : {}),
    ...(clip ? { clip, clipLabel: clipRange ? said.short_clip : said.full_recording } : {}),
    ...(!clip && card.clip_status === 'not_found' ? { audioNote: said.clip_not_found } : !clip && card.clip_status === 'not_checked' ? { audioNote: said.clip_not_checked } : {}),
    finish,
    ...(opens && link ? { open: { label: said.open, run: () => window.open(link, '_blank', 'noopener') } } : {}),
  };
}

const QUEUE_WORDS = { position: said.position, later: said.later, back: said.back, working: words.needs_you.working, done: words.needs_you.done, again: said.again };

function Waiting() {
  const loaded = useScreenLoad<NeedsAnswer>('waiting', { loading: { label: said.loading, layout: 'rows' }, read: () => readJson<NeedsAnswer>(API), failed: refusal(said.failed) });
  const [supplement, setSupplement] = React.useState<{ source: NeedsAnswer; page: NeedsAnswer } | null>(null);
  const source = loaded.state ? null : loaded.value;
  React.useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    void loadSupplementalPages(source, (query, cursor, signal) => readJson<NeedsAnswer>(`${API}?${encodeURIComponent(query)}=${encodeURIComponent(cursor)}&settle=no`, { signal }), controller.signal)
      .then(page => { if (!controller.signal.aborted) setSupplement({ source, page }); }).catch(() => {});
    return () => controller.abort();
  }, [source]);
  if (loaded.state) return <ScreenState state={loaded.state} />;
  const answer = supplement?.source === source ? supplement.page : loaded.value;
  const again = () => void loaded.reload();
  const things = queueOf(answer).map(item => queueThingOf(answer, item.section, item.card, again));
  const unavailable = answer.sections.map(section => {
    const count = unavailableBatchCount(section);
    return count && section.batch?.unavailable ? section.batch.unavailable.replace(/\{count\}/g, String(count)) : null;
  }).filter(Boolean).join(' ');
  return (
    <OneAtATimeQueue
      title={said.title}
      things={things}
      total={totalOf(answer)}
      words={QUEUE_WORDS}
      empty={{ icon: unavailable && !things.length ? 'AudioLines' : 'CircleCheck', title: things.length ? said.all_done : (unavailable ? said.title : said.all_done), detail: unavailable || said.all_done_detail }}
      rest={{ title: said.skipped_all, detail: said.skipped_all_detail }}
    />
  );
}

type Answer = NeedsAnswer & { hold?: { live_seconds?: number } };

/** One thing alone (invariant 5), read again every `hold.live_seconds` so what Trillion checks ticks by itself. While
 *  the hold holds it, the hold's ways out end its card and the other held things are walked next and back in rank
 *  order. */
function WaitingThing({ thing }: { thing: string }) {
  const loaded = useScreenLoad<Answer>(`waiting:${thing}`, { loading: { label: said.loading, layout: 'rows' }, read: () => readJson<Answer>(API), failed: refusal(said.failed), laterFailure: () => { failedRead.current = true; } });
  const hold = useHold();
  const [readAt, setReadAt] = React.useState(() => Date.now());
  const [readFailed, setReadFailed] = React.useState(false);
  // A later read that fails keeps the answer drawn (useScreenLoad `laterFailure`); it is said, never a stale check as fresh.
  const failedRead = React.useRef(false);
  const readDone = () => { setReadAt(Date.now()); setReadFailed(failedRead.current); failedRead.current = false; };
  const [at, setAt] = React.useState(thing);
  const seen = React.useRef<{ key: string; section: NeedsSection; card: NeedsCard } | null>(null);
  const completedHere = React.useRef(false);
  const completionSnapshot = React.useRef<{ key: string; rank: string[] } | null>(null);
  const answer = loaded.state ? null : loaded.value;
  const seconds = answer?.hold?.live_seconds ?? 0;
  const ranked = hold.view?.held ? hold.view.ranked ?? [] : [];
  // Finished here: taken off at once, before the store answers (hold-ways-out.tsx invariant 5); back if it refuses.
  const [finished, setFinished] = React.useState<ReadonlySet<string>>(() => new Set());
  const finishedKeys = React.useRef(new Set<string>());
  const found = answer ? queueThing(answer, at) : null;
  const item = found && !finished.has(found.key) && !finished.has(found.card.id) ? found : null;
  if (item) seen.current = item;
  const shown = item ?? seen.current;
  const place = answer && shown ? ranked.findIndex(one => one.key === shown.key || queueThing(answer, one.key)?.key === shown.key) : -1;
  const rankSignature = ranked.map(one => one.key).join('|');
  // The rank as it stood while the shown thing was in it. A held thing that leaves by itself (Trillion's own check
  // found it done, so the answer no longer has it) moves the hold on from where it was, as a finish pressed here does;
  // without it the hold stayed on "no longer waiting" while other things were still held.
  const lastPlaced = React.useRef<{ key: string; rank: string[] } | null>(null);
  if (shown && place >= 0) lastPlaced.current = { key: ranked[place].key, rank: ranked.map(one => one.key) };
  // The answer no longer has the shown thing while the hold still ranks it: the hold is read again, once, so its rank
  // catches up and the hold can move on (a finish pressed here reads it in `complete`).
  React.useEffect(() => {
    if (!loaded.state && shown && !item && place >= 0 && !completedHere.current) hold.reload();
  }, [loaded.state, item?.key, shown?.key, place]);
  // Keep the order from the finish action. Hold and answer refreshes are independent, so the hold may remove
  // this card before the answer confirms its completion; a later rank cannot locate the card's old position.
  React.useEffect(() => {
    const completed = completedHere.current ? completionSnapshot.current : lastPlaced.current;
    if (!loaded.state && completed && shown && !item && place < 0 && ranked.length) {
      const next = successorAfterRemoval(completed.key, completed.rank.map(key => ({ key })), ranked);
      if (next) {
        completionSnapshot.current = null;
        completedHere.current = false;
        lastPlaced.current = null;
        seen.current = null;
        setAt(next.key);
      }
    }
  }, [loaded.state, item?.key, shown?.key, place, rankSignature]);
  React.useEffect(() => {
    if (!seconds) return undefined;
    const every = setInterval(() => { void loaded.reload().then(readDone).catch(() => setReadFailed(true)); }, seconds * 1000);
    return () => clearInterval(every);
  }, [seconds, loaded.reload]);
  if (loaded.state) return <ScreenState state={loaded.state} />;
  const refresh = () => { hold.reload(); void loaded.reload().then(readDone); };
  const complete = () => {
    // Taken off at the press already (finishingHere): the store's answer only needs reading again.
    if (shown && finishedKeys.current.has(shown.card.id)) { refresh(); return; }
    if (place >= 0) completionSnapshot.current = { key: ranked[place].key, rank: ranked.map(one => one.key) };
    completedHere.current = true;
    refresh();
  };
  const finishingHere = (write: Promise<unknown>) => {
    if (!shown) return write;
    const keys = [shown.key, shown.card.id, ...(place >= 0 ? [ranked[place].key] : [])];
    if (place >= 0) completionSnapshot.current = { key: ranked[place].key, rank: ranked.map(one => one.key) };
    completedHere.current = true;
    for (const key of keys) finishedKeys.current.add(key);
    setFinished(now => new Set([...now, ...keys]));
    return finishHere(keys, write).catch((failure: unknown) => {
      completedHere.current = false;
      completionSnapshot.current = null;
      for (const key of keys) finishedKeys.current.delete(key);
      setFinished(now => new Set([...now].filter(key => !keys.includes(key))));
      throw failure;
    });
  };
  // `seen` retains the old rank for successor selection, not an executable card after source absence.
  // Failed refreshes retain loaded.value, so their still-current item remains visible with its failure state.
  const things = item ? [queueThingOf(loaded.value, item.section, item.card, complete, open, { readAt, readFailed }, finishingHere)] : [];
  // Held: the ranked things this one is among, walked by the moves that can be made, and the ways out for the one shown.
  const moveTo = (index: number) => { completedHere.current = false; seen.current = null; setAt(ranked[index].key); }
  const held = hold.view && place >= 0 ? {
    under: <WaysOut view={hold.view} thing={ranked[place]} reload={refresh} />,
    ...(ranked.length > 1 ? { moves: {
      position: fill(holdWords.position, { n: place + 1, total: ranked.length }),
      ...(place > 0 ? { back: { label: holdWords.previous, run: () => moveTo(place - 1) } } : {}),
      ...(place < ranked.length - 1 ? { next: { label: holdWords.next, run: () => moveTo(place + 1) } } : {}),
    } } : {}),
  } : {};
  return (
    <OneAtATimeQueue
      title=""
      things={things}
      total={things.length}
      words={QUEUE_WORDS}
      empty={{ icon: 'CircleCheck', title: said.thing_unknown, action: { label: said.back, run: () => { if (!returnToLockedScreen()) open('screen-waiting', said.title); } } }}
      rest={{ title: said.skipped_all }}
      alone={held}
      leave={{ label: said.back, run: () => open('screen-waiting', said.title) }}
    />
  );
}

export function mountWaitingScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}): () => void {
  const thing = text(props.surfaceInput?.thing);
  return mountReactSurface(element, thing ? <WaitingThing thing={thing} /> : <Waiting />);
}
