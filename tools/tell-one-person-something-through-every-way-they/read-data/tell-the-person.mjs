// src/tell-the-person.mjs
//
// Purpose
//   Telling one person something, through every way they chose to be told for that kind of news: the step any rule,
//   schedule, workflow or AI runs (tool:tell-the-person, placement:this-account), and the person's choices that the
//   Notification settings screen draws and changes. What happened and when to tell is never decided here: that is the
//   rule engine's `when` and `where` (src/automations.mjs). This owner only carries the news.
//
// Non-negotiable invariants
//   1. Channels and kinds are DATA (records/tell-the-person.json). Nothing here names a channel, a kind, a vendor or a
//      sender: each channel row names its sender, and the host wires senders by name.
//   2. A person is only ever told about by their own store: the step takes no recipient, so it cannot reach anyone else.
//   3. One notice per key: the same key again tells nobody twice (a rule run's key, or one the caller gives); with
//      `update` it changes that notice's words in place, still sending nothing.
//   4. Every notice is kept (at most `keep`, oldest dropped) with what each channel did, so the in-app list, a failed
//      channel and a repeat are all read from one record.
//   5. One channel failing never stops the others; each is tried on its own and reports in plain words.
//   6. The person's choices only override: a channel or kind they never touched follows its row, so a changed row
//      reaches everyone who did not choose otherwise. A notice one of Trillion's own owners tells with `everyChannel`
//      (who may confirm changes on the account changed, src/passkey-authority.mjs) is not narrowed by them at all: it
//      goes through every channel that can send, whatever kinds, channels turned off or show rules the person (or an AI
//      holding their credentials) chose. Only the service notice passes it; the step an AI or a rule runs cannot.
//   7. Work still going on (`report`) is one notice per key, changed in place on every report and shown only in
//      Trillion (the `shown_here` channel) while it runs, so a progress tick never pushes, mails or texts anyone. When
//      the report says it ended (done or failed) the person is told once through every channel its kind goes through.
//      Nothing here names a program, a tool or a kind of work: source, kind, words and numbers are the caller's.
//   8. A notice that says it is still running but has not been reported for `running_quiet_minutes` (or its kind's own
//      `quiet_minutes`) reads as stopped,
//      so a program that quit never leaves a card moving forever.
//   9. A running report may offer the person at most `report_actions_most` actions ({ id, label }, such as Pause) and
//      name the agent that answers them (`answered_by`). Pressing one only sends that agent one event
//      (`action_event`, refs { key, action }) through the account's own agent events; nothing here knows what an
//      action does, and an action the report did not offer, or one on work that ended, is refused.
//  10. Every notice offers its kind's `actions` (DATA rows, each naming a `road`): a device shows them as buttons and
//      a press is `act({ id, action, text })`, which runs the road the host wired under that name. Nothing here
//      knows what a road does; an action the notice's kind does not offer is refused, and answering marks it read.
//      An action row that says `needs_ref` is offered only by a notice whose refs name that thing (a Finish only on a
//      notice about one waiting thing), so the kind's next action with words answers every other notice.
//  11. A channel whose row says `while_running` is also sent every report of running work (start, each change, the
//      end), so a device can draw the work live (a Live Activity) while every other channel still hears only the end.
//      Each send carries the channel's whole board (`context.board`): every notice it carried that is still running,
//      with this one as it is now, newest change first, so a device draws everything running as one surface and quiet
//      work (invariant 8) drops off it on the next report instead of staying frozen.
//  12. A device reads the notices its own channel carried (`forDevice({ channel, after })`), oldest first, so a
//      device that keeps the last seq it saw shows each notice once.
//  14. A kind that says `reach_now` reaches the person where they are now: the rows of `rows.reach_now.rules` name a
//      device whose own report says the person is at it (`presence()`, each { device, present, at }, the newest report
//      of each device kept by src/tell-devices.mjs) and the devices it then leaves out, so a reply read at the Mac does
//      not also buzz the phone. A report older than `fresh_minutes` says nothing. Nothing here names a device.
//  15. A kind's `group` (filled from the notice's refs, such as a conversation) is the one thread its notices share:
//      a device shows the newest in place of the one before (`shown.group`), so many replies are one notification.
//  16. A spoken answer (`answerAloud({ id, text })`) is the notice's own answer: words in `rows.spoken_answers.later`
//      leave it waiting to be asked again, words in `.stop` mark every notice the spoken channel carried read and turn
//      that channel off, and anything else runs the kind's first action that takes words, as a press with those words.
//
//  18. A person who chose to be written to silently outside their working hours (quiet-hours mode auto_silent) has notices that
//      arrive then shown at `src/tell-quiet-hours.json` `level` (passive) when it is `enabled` (off by default); the host says
//      whether it is quiet (`quietNow(atMs)`), nothing here knows the hours.
//
//  13. Before a notice goes out on a channel (any but `shown_here`, which keeps every notice and lets the open page
//      decide how it shows), the person's show rules are asked (`shows(rows.show_subject, notice, { channel, device })`,
//      src/show-rules-store.mjs): a channel a rule silences or hides is skipped and says which rule held it. The channel
//      row's `device` is the device it reaches. Nothing here names a rule, a device or an effect.
//  14. Every notice lands on the thing it is about: its `open` is made in one place (`noticeAddress`) from the caller's
//      `open`, its `about` ({ kind, id }) or a ref named after a kind of thing a screen opens, through the one address
//      shape every surface uses (src/workspace/addresses.mjs thingAddress), so a tap on a phone, a watch, a Mac, a
//      browser or an email opens that thing, never only the app. The person's notifications are where a notice about
//      nothing in particular goes.
//  17. A kind's `reach` is its ordered reach, as DATA: rows of { after_minutes, channels }. A channel in a row is told
//      only once that many minutes have passed since the notice while the person has not read it (`reachDue`, on the
//      store's scheduler at `reachNextAt`); a channel in no row is told at once. Reading the notice on any surface ends
//      the ladder, and `read_on` keeps which surface it was read on ({ channel, device_id?, from?, at }), so the person is
//      reached down their ways until they see it, and Trillion knows where they did. The first surface is kept, except
//      that one only inferred from seeing the notice's thing (`from: 'thing'`, the open page showing the held thing)
//      gives way to the notice itself read on a way that carried it: a tap on the phone's banner brings the app's page
//      to the front, and that page's receipt can arrive first.
//  18. The told list keeps the newest `keep` notices and, whatever came after, the newest `keep_each_kind` of every kind
//      (`keptNotices`, the one trim every write uses), so a flood of one kind never takes away the last notices of
//      another and where the person read them. Nothing here names a kind.
//
// Key concepts
//   notice   { seq, key, kind, title, body, chips?, open, at, read?, results: { [channel id]: { sent, said } } }, and for work
//            still going on also { state: running | done | failed, source?, progress?: { done, total, unit?, label? },
//            updated_at, actions?: [{ id, label }], answered_by? }
//   choices  { channels: { [id]: { on?, address? } }, kinds: { [id]: [channel id] } } (the person's own overrides)
//   sender   { state(channel, context) → { ready, need?, setup? }, send(channel, notice, context) → { sent, said } };
//            context is { choices, shown, board? } where `shown` is the notice as a device shows it (`deviceNotice`)
//            and `board`, for a while_running channel, is every running notice it carries as a device shows them
//   shown    { id, seq, kind, title, body, open, at, level, read, actions: [{ id, label, input?, opens? }], state?,
//            source?, progress? }
//   road     ({ notice, text, row }) → { said?, open? }, wired by the host by the action row's `road`
//
// Security
//   Credentials are named by the rows and placed by their owners (a Worker secret, the locked box); nothing here reads
//   or returns a value. Push subscriptions are this person's rows in their own store.
//

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const asText = value => (Array.isArray(value) ? value.filter(item => item !== null && item !== undefined).map(String).join(', ') : value === null || value === undefined ? '' : String(value));

import { DeviceError } from '../../tell-the-person-something-on-all-of-their-own-phones-computers/src/tell-devices.mjs';
import glanceFeeds from './glance-feeds.json' with { type: 'json' };
import quietHoursLevel from './tell-quiet-hours.json' with { type: 'json' };
import screens from '../../shared-code/src/workspace/screens.mjs';
import { thingAddress, thingScreen } from '../../hand-off-jobs-between-agents/src/workspace/addresses.mjs';

// An address of the person's own Trillion (`/decisions/c1`), never another site or a protocol-relative `//host`.
const ownPath = value => (nonempty(value) && /^\/(?![/\\])/.test(value.trim()) ? value.trim() : null);
// A kind's address made from the refs, with every {name} in it filled (a path, or a whole https address such as a program's
// own page), or null when one is missing, so a half-filled address (`/file/`) is never what a tap opens.
const fullyFilled = (template, refs) => {
  const names = nonempty(template) ? [...template.matchAll(/\{(\w+)\}/g)].map(([, name]) => name) : [];
  if (!names.length || !names.every(name => nonempty(refs[name]))) return null;
  const filled = fill(template, refs).trim();
  return ownPath(filled) ?? (/^https:\/\//.test(filled) ? filled : null);
};

/**
 * Where a tap on a notice lands: the thing it is about, the one address shape every surface uses
 * (src/workspace/addresses.mjs thingAddress). In order: the caller's own `open`; `refs.open`; the kind's address with
 * every name filled; the thing named by `about` ({ kind, id, item? }); the first ref named after a kind of thing a screen
 * opens, or that kind with `_id` (`refs.decision`, `refs.file`, `refs.handoff_id`, `refs.space_id`, `refs.list`); the
 * kind's fixed address; only then the person's notifications. Nothing here names a kind of thing: the screens' `opens_kinds` do.
 */
export function noticeAddress(rows, kind, input, refs) {
  const about = object(input.about) ? thingAddress(screens, input.about.kind, input.about.id, input.about.item) : null;
  // A ref named after a kind (`list`, or `handoff_id`) with the screen's item input beside it (`row`) opens that item.
  const named = Object.entries(refs).map(([name, value]) => {
    const kindName = name.replace(/_id$/, '');
    return nonempty(value) ? thingAddress(screens, kindName, value, refs[thingScreen(screens, kindName)?.route_item_input ?? '']) : null;
  }).find(Boolean) ?? null;
  return ownPath(input.open) ?? ownPath(refs.open) ?? fullyFilled(kind.open, refs) ?? about ?? named
    ?? (kind.open && !/\{\w+\}/.test(kind.open) ? ownPath(kind.open) : null) ?? rows.default_open;
}

/** How long a running notice of this kind stays up between reports: the kind's `quiet_minutes`, else the rows' own. */
// A kind names its channels as a list, or as { every: true, except: [...] }: every channel the DATA has, now and any
// added later (a new surface reaches what matters without editing each kind), less the ones it leaves out.
export const kindChannels = (kind, channels) => (Array.isArray(kind.channels) ? kind.channels
  : kind.channels?.every ? channels.map(row => row.id).filter(id => !(kind.channels.except ?? []).includes(id)) : []);

export const quietMinutesOf = (rows, kind) => rows.kinds.find(row => row.id === kind)?.quiet_minutes ?? rows.running_quiet_minutes;

export class TellError extends Error {}

// A generic tool being accepted, queued or completed is not proof it sent anything. The channel's DATA names the
// positive sender receipt. Pending work may be polled with the same request key; unknown outcomes stay held.
export function connectionToolReceipt(row, response, reply) {
  const proof = row.settings?.accepted_when;
  const value = Array.isArray(proof?.path) ? proof.path.reduce((held, field) => held?.[field], reply) : undefined;
  if (response.ok && reply.state === 'completed' && proof?.equals === true && value === true) return { sent: true, said: `Sent through ${row.label}.` };
  const pending = response.ok && ['queued', 'running'].includes(reply.state);
  const rejected = response.ok && reply.state === 'completed' && value === false;
  return { sent: false, retryable: pending || rejected, ...(pending ? { pending: true } : {}),
    said: reply.error ?? (pending ? `${row.label} is still queued or running; no delivery is confirmed.` : `${row.label} returned no positive delivery receipt.`) };
}

// What a running report offers the person: at most `most` { id, label }, ids short words, labels a few words.
function actionsOf(value, most) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > most || !value.every(item => object(item) && nonempty(item.id) && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(item.id) && nonempty(item.label))) {
    throw new TellError(`actions is a list of at most ${most} { id, label }, each id a short lower-case word.`);
  }
  return value.map(item => ({ id: item.id, label: cut(item.label.trim(), 40) }));
}

// Short facts a notice is drawn with instead of a sentence ("12 of 40 files", "3 heard"), each words and an optional
// tone the look colours: whatever sent the notice decides what its card shows, as DATA.
function chipsOf(value, most) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > most || !value.every(item => object(item) && nonempty(item.text) && (item.tone === undefined || nonempty(item.tone)))) {
    throw new TellError(`chips is a list of at most ${most} { text, tone? }, each a few words.`);
  }
  return value.map(item => ({ text: cut(item.text.trim(), 60), ...(item.tone ? { tone: item.tone.trim().slice(0, 24) } : {}) }));
}

// The notices the told list keeps, oldest first: the newest `keep`, and the newest `keep_each_kind` of each kind (invariant 18).
export function keptNotices(list, rows) {
  const ordered = [...list].sort((a, b) => a.seq - b.seq);
  const each = Number.isSafeInteger(rows.keep_each_kind) && rows.keep_each_kind > 0 ? rows.keep_each_kind : 0;
  const kept = new Set(ordered.slice(-rows.keep));
  const seen = new Map();
  for (const notice of [...ordered].reverse()) {
    const many = seen.get(notice.kind) ?? 0;
    if (many < each) kept.add(notice);
    seen.set(notice.kind, many + 1);
  }
  return ordered.filter(notice => kept.has(notice));
}

const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
// How far work has got: done of total (in `unit`, which the page reads to word the numbers), or only words. Anything
// else is refused rather than drawn as a guess.
function progressOf(value) {
  if (value === undefined || value === null) return null;
  if (!object(value)) throw new TellError('progress is { done, total, unit?, label? }.');
  const label = nonempty(value.label) ? cut(value.label.trim(), 160) : null;
  if (value.done === undefined && value.total === undefined) return label ? { label } : null;
  if (!count(value.done) || !count(value.total) || value.done > value.total) throw new TellError('progress.done and progress.total are counts, with done no more than total.');
  return { done: value.done, total: value.total, ...(nonempty(value.unit) ? { unit: value.unit.trim().slice(0, 40) } : {}), ...(label ? { label } : {}) };
}

/**
 * rows:    records/tell-the-person.json
 * store:   { choices() → choices | null, putChoices(choices), notices({ after }?) → [notice] (with `after`, those whose seq
 *          is past it may be all that is read), putNotices([notice]),
 *          delivery(key) → retained receipt | null, putDelivery(key, receipt) }
 *          The last two are required for retain_delivery: durable action receipts outlive the short UI history.
 * senders: { [sender name]: sender } (owner wiring: the person store)
 * now:     () → Date
 * observe: (notice) → void. Told each new notice as it is made (the person store keeps it in the account's journey for
 *          Trillion HQ, src/journey.mjs); anything it throws is ignored, so a notice is never held up by it.
 * guardFor: (refs, input) → null | (async () → { inactive?, blocked?, retryable?, reason? }). The owner's check that what a
 *          notice is about still stands (src/person-store.mjs waitingNoticeGuard: a waiting row or held thing not yet done),
 *          made right before every channel sends, for every tell, so no caller has to remember to ask. A caller's own
 *          beforeSend runs after it; either one denying stops the send. One check is shared by the channels of one tell.
 */
export function makeTellThePerson({ rows, store, senders, roads = {}, askAgent = null, shows = null, presence = () => [], guardFor = null, observe = null, quietNow = () => false, quietRow = quietHoursLevel, now = () => new Date() }) {
  // The guard of one tell: the owner's, then the caller's. Channels sending together share one check.
  const guarded = (refs, input, beforeSend) => {
    const owner = guardFor?.(refs, input) ?? null;
    if (!owner) return beforeSend;
    let flight = null;
    const ask = () => (flight ??= Promise.resolve().then(owner).finally(() => { flight = null; }));
    return async () => {
      const denied = await ask();
      if (denied?.inactive || denied?.blocked || denied?.retryable) return denied;
      return beforeSend ? beforeSend() : denied;
    };
  };
  const channelRows = new Map(rows.channels.map(row => [row.id, row]));
  const kindRows = new Map(rows.kinds.map(row => [row.id, row]));
  const actionRows = new Map((rows.actions ?? []).map(row => [row.id, row]));
  const choices = () => {
    const saved = store.choices() ?? {};
    return { channels: object(saved.channels) ? saved.channels : {}, kinds: object(saved.kinds) ? saved.kinds : {} };
  };
  const senderOf = row => {
    const sender = senders[row.sender];
    if (!sender) throw new TellError(`No sender named ${row.sender} is wired for ${row.label}.`);
    return sender;
  };
  // A notice told on every channel (invariant 6, `every_channel`) keeps every channel on that its row has on, or that the
  // person turned on: their turning one off does not narrow it.
  const isOn = (row, chosen, every = false) => (every ? row.on_by_default !== false || chosen.channels[row.id]?.on === true
    : typeof chosen.channels[row.id]?.on === 'boolean' ? chosen.channels[row.id].on : row.on_by_default !== false);
  const kindOf = id => kindRows.get(id) ?? kindRows.get(rows.default_kind);
  // The channels of a kind's ordered reach that are due for a notice told at `at` (invariant 17): null when the kind has
  // no ladder, so every channel is due.
  const reachRows = kind => (Array.isArray(kind.reach) ? kind.reach.filter(row => Array.isArray(row?.channels)) : []);
  const notYetDue = (kind, at) => {
    const ladder = reachRows(kind);
    if (!ladder.length) return null;
    const since = now().getTime() - Date.parse(at);
    return new Set(ladder.filter(row => !(Number(row.after_minutes ?? 0) * 60_000 <= since)).flatMap(row => row.channels));
  };
  const channelsFor = (kind, chosen, every = false) => (every ? rows.channels.map(row => row.id)
    : Array.isArray(chosen.kinds[kind.id]) ? chosen.kinds[kind.id] : kindChannels(kind, rows.channels)).filter(id => channelRows.has(id));
  // A saved/queued notice, provider acceptance and a read receipt are independent evidence. In particular, a
  // device-pull channel merely keeps work for a later read, and a provider accepting a push does not mean it was read.
  const deliveryReceipt = notice => {
    const channels = Object.entries(notice.results).map(([channel, result]) => ({ channel, ...result,
      evidence: result.sent ? channelRows.get(channel)?.delivery_evidence ?? 'unknown' : result.stage ?? 'not-sent' }));
    const accepted = channels.filter(result => result.sent && result.evidence === 'provider-accepted');
    const uncertain = channels.some(result => ['attempting', 'uncertain'].includes(result.stage));
    const awareness = notice.read === true ? 'read-receipt' : 'unknown';
    const words = rows.delivery_words;
    const said = awareness === 'read-receipt' ? words.read : accepted.length ? fill(words.accepted, { channels: accepted.map(result => channelRows.get(result.channel).label).join(', ') }) : uncertain ? words.uncertain : words.stored;
    return { channels, delivery_accepted: accepted.length > 0, awareness, uncertain, said, ...(notice.read_on ? { read_on: notice.read_on } : {}) };
  };
  const currentNotice = notice => {
    const shown = store.notices().find(item => item.key === notice.key);
    const retained = store.delivery?.(notice.key);
    return { ...notice, ...shown, ...(retained ?? {}), results: retained?.results ?? shown?.results ?? notice.results };
  };
  // Merge only the channels this call owns against the freshest receipt. An older channel finishing must not
  // overwrite a sibling's later claim or acceptance. The durable receipt contains no task body or contact address.
  const keepNotice = (notice, { results: changes = {}, attempt = null, payload = {} } = {}) => {
    const current = store.notices();
    const same = current.find(item => item.key === notice.key);
    const retained = store.delivery?.(notice.key);
    const latest = { ...notice, ...same, ...(retained ?? {}), ...payload };
    latest.results = { ...(retained?.results ?? same?.results ?? notice.results) };
    for (const [channel, result] of Object.entries(changes)) {
      if (attempt && latest.results[channel]?.attempt !== attempt) continue;
      latest.results[channel] = result;
    }
    if (latest.retain_delivery === true) store.putDelivery(latest.key, {
      key: latest.key, seq: latest.seq, retain_delivery: true, results: latest.results,
      ...(Object.hasOwn(latest, 'read') ? { read: latest.read } : {}),
    });
    store.putNotices(keptNotices([...current.filter(item => item.key !== notice.key), latest], rows));
    return latest;
  };
  // A running notice nobody has reported for `running_quiet_minutes` reads as stopped (invariant 8).
  // A kind may keep its running notices up longer between reports (`quiet_minutes`, such as a Waiting on you board).
  const stateNow = item => (item.state === 'running' && now() - Date.parse(item.updated_at) > quietMinutesOf(rows, item.kind) * 60_000 ? 'stopped' : item.state);
  const needWords = (need, row) => fill(rows.needs?.[need] ?? rows.needs?.setup ?? '', { label: row.label });
  // What the person has already been told of this kind, for their frequency rules (show-rules.json subject `notification`):
  // how many earlier notices of the kind Trillion still keeps (`keptNotices` bounds it per kind) and the hours since the newest.
  const earlierOfKind = notice => {
    const earlier = store.notices().filter(item => item.kind === notice.kind && item.key !== notice.key && item.seq < notice.seq);
    const last = Math.max(...earlier.map(item => Date.parse(item.at)).filter(Number.isFinite), -Infinity);
    return { times_shown: earlier.length, hours_since_last_shown: Number.isFinite(last) ? Math.max(0, (now().getTime() - last) / 3_600_000) : null };
  };
  // A rule the person keeps that holds this notice back on this channel, in words, or null (invariant 13).
  const heldBack = async (row, notice) => {
    if (!shows || row.id === rows.shown_here || notice.every_channel === true) return null;
    const answer = await shows(rows.show_subject, { kind: notice.kind, title: notice.title, ...earlierOfKind(notice) }, { channel: row.id, device: row.device ?? null });
    return answer?.silenced ? `Held back by your rule: ${answer.rules.map(rule => rule.label).filter(Boolean).join(', ') || 'a rule you keep'}.` : null;
  };
  // The actions a notice of `kind` offers, as DATA rows; a row that `needs_ref` is offered only by a notice whose refs
  // name that thing (invariant 10).
  const offeredBy = (kind, notice) => (kind.actions ?? rows.default_actions ?? []).map(id => actionRows.get(id))
    .filter(row => row && (!row.needs_ref || notice?.refs?.[row.needs_ref] != null));
  // Inside the person's own quiet hours, when they chose to have notices sent without a push (calendar-tasks.json working hours
  // mode auto_silent) and `src/tell-quiet-hours.json` is turned on, a notice is shown at that file's level (passive): nothing
  // here knows the hours, `quietNow(at)` is the host's answer from the person's own store. Off unless the row says `enabled`.
  const quietLevel = item => (quietRow.enabled === true && quietNow(Date.parse(item.at)) === true ? quietRow.level : null);
  // A notice as a device shows it: its words, how loudly, and its buttons (its kind's, then what running work offers).
  const deviceNotice = item => {
    const kind = kindOf(item.kind);
    const running = item.state ? stateNow(item) === 'running' : false;
    const buttons = [
      ...(running ? (item.actions ?? []) : []),
      ...offeredBy(kind, item).map(({ id, label, input, opens }) => ({ id, label, ...(input ? { input } : {}), ...(opens ? { opens: true } : {}) })),
    ];
    return {
      id: `told:${item.seq}`, seq: item.seq, kind: item.kind, title: item.title, body: item.body, open: item.open, at: item.at,
      level: quietLevel(item) ?? kind.level ?? rows.default_level, read: Boolean(item.read), actions: buttons,
      ...(item.state ? { state: stateNow(item), updated_at: item.updated_at } : {}),
      ...(item.source ? { source: item.source } : {}),
      ...(item.progress ? { progress: item.progress } : {}),
      ...(item.chips ? { chips: item.chips } : {}),
      ...(item.group ? { group: item.group } : {}),
    };
  };
  // The devices left out because the person is at another one now (invariant 14): device -> the words saying why.
  const notHereNow = kind => {
    const reach = rows.reach_now;
    if (!kind.reach_now || !reach) return new Map();
    const reports = presence() ?? [];
    const left = new Map();
    for (const rule of reach.rules) {
      const here = reports.some(item => item.device === rule.when_present && item.present === 'here' && now() - Date.parse(item.at) <= reach.fresh_minutes * 60_000);
      if (here) for (const device of rule.skip_devices) left.set(device, rule.said);
    }
    return left;
  };
  // A notice's buttons on the page: work still going on offers what it reported (Pause, Stop) and ended work nothing;
  // a notice that is not about work offers its kind's own (Reply with its field, Open), so the page answers it in place
  // the way a Mac or phone notification does.
  const pageButtons = item => {
    if (item.state) return stateNow(item) === 'running' && item.actions?.length ? { actions: item.actions } : {};
    const buttons = deviceNotice(item).actions;
    return buttons.length ? { actions: buttons } : {};
  };
  // Everything a while_running channel is drawing now (invariant 11): `notice` as it is now, beside every other notice
  // that channel carried and is still running, newest change first, so one device surface shows the whole set.
  const boardOf = (row, notice) => store.notices()
    .filter(item => item.key !== notice.key && item.results?.[row.id] && stateNow(item) === 'running')
    .concat(notice)
    .sort((a, b) => Date.parse(b.updated_at ?? b.at) - Date.parse(a.updated_at ?? a.at))
    .map(deviceNotice);
  const context = (chosen, notice = null, row = null) => ({
    choices: chosen, ...(notice ? { shown: deviceNotice(notice) } : {}), ...(notice && row?.while_running ? { board: boardOf(row, notice) } : {}),
  });

  async function stateOf(row, chosen) {
    try {
      const state = await senderOf(row).state(row, context(chosen));
      return state.ready ? { ready: true, ...(state.setup ? { setup: state.setup } : {}) }
        : { ready: false, need: state.need, said: needWords(state.need, row), ...(state.connect_url ? { connect_url: state.connect_url } : {}), ...(state.setup ? { setup: state.setup } : {}) };
    } catch (error) {
      return { ready: false, need: 'setup', said: String(error.message ?? error) };
    }
  }

  // What the Notification settings screen draws.
  async function settings() {
    const chosen = choices();
    const channels = await Promise.all(rows.channels.map(async row => ({
      id: row.id, label: row.label, on: isOn(row, chosen),
      ...(nonempty(chosen.channels[row.id]?.address) ? { address: chosen.channels[row.id].address } : {}),
      state: await stateOf(row, chosen),
    })));
    return { channels, kinds: rows.kinds.map(kind => ({ id: kind.id, label: kind.label, channels: channelsFor(kind, chosen) })), needs: rows.needs };
  }

  // The person's change: { channels: { id: { on?, address? } }, kinds: { id: [channel ids] } }. Only rows that exist.
  // Keeping it is one synchronous write (a route or action commits it with its receipt); choose answers with the settings.
  function keepChoices(change = {}) {
    const chosen = choices();
    for (const [id, value] of Object.entries(object(change.channels) ? change.channels : {})) {
      if (!channelRows.has(id) || !object(value)) throw new TellError(`There is no way to be told called ${id}.`);
      const next = { ...chosen.channels[id] };
      if (typeof value.on === 'boolean') next.on = value.on;
      if (value.address !== undefined) {
        if (value.address !== null && !(nonempty(value.address) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.address.trim()))) throw new TellError('That does not look like an email address.');
        if (value.address === null) delete next.address; else next.address = value.address.trim();
      }
      chosen.channels[id] = next;
    }
    for (const [id, list] of Object.entries(object(change.kinds) ? change.kinds : {})) {
      if (!kindRows.has(id) || !Array.isArray(list) || !list.every(item => channelRows.has(item))) throw new TellError(`${id} is not a kind of news, or names a way to be told that does not exist.`);
      chosen.kinds[id] = [...new Set(list)];
    }
    store.putChoices(chosen);
  }
  async function choose(change = {}) {
    keepChoices(change);
    return settings();
  }

  // The step: tell the person one thing through each channel its kind goes through that is on and can send.
  // `everyChannel` is for Trillion's own owners only (the service notice, src/standalone-resource-behavior.mjs
  // tell:serviceNotice): the step an AI or rule runs never passes it, so only they can tell past the person's choices.
  async function tell(input = {}, { beforeSend: callers = null, everyChannel = false } = {}) {
    if (!nonempty(input.title)) throw new TellError('title is what to tell the person, in a few words.');
    const kind = kindOf(nonempty(input.kind) ? input.kind : rows.default_kind);
    const refs = object(input.refs) ? Object.fromEntries(Object.entries(input.refs).map(([name, value]) => [name, asText(value)])) : {};
    const beforeSend = guarded(refs, input, callers);
    const list = store.notices();
    const key = nonempty(input.key) ? input.key : `told:${crypto.randomUUID()}`;
    if (input.retain_delivery === true && (!store.delivery || !store.putDelivery)) throw new TellError('Durable action delivery receipts are not wired. No notice was sent.');
    const saved = store.delivery?.(key);
    const shownEarlier = list.find(item => item.key === key);
    const earlier = saved || shownEarlier ? { ...shownEarlier, ...saved, results: saved?.results ?? shownEarlier.results } : null;
    if (earlier && input.retry_failed !== true) {
      const title = cut(input.title.trim(), rows.title_max);
      const body = cut(asText(input.body).trim(), rows.body_max);
      // A notice about something still being read (a bill's amount so far) keeps its newest words: `update` changes the
      // one notice in place and sends nothing, so the list never shows an amount older than the last reading.
      if (input.update === true && (title !== earlier.title || body !== earlier.body)) {
        store.putNotices(list.map(item => item.key === key ? { ...item, title, body, updated_at: now().toISOString() } : item));
        return { told: false, updated: true, ...deliveryReceipt(earlier), said: 'The notice now says the newest words.' };
      }
      const receipt = deliveryReceipt(earlier);
      return { told: false, ...receipt, said: rows.delivery_words.repeat + receipt.said };
    }
    // An explicit read satisfies this notice's initial delivery obligation. The source still owns any unfinished
    // task and its later follow-up; do not retry another channel merely because it became ready after the read.
    if (earlier?.read === true) return { recorded: true, told: false, ...deliveryReceipt(earlier) };
    const notice = {
      seq: (list.at(-1)?.seq ?? 0) + 1, key, kind: kind.id,
      title: cut(input.title.trim(), rows.title_max), body: cut(asText(input.body).trim(), rows.body_max),
      open: noticeAddress(rows, kind, input, refs), refs, at: now().toISOString(), results: {},
      ...(chipsOf(input.chips, rows.chips_most).length ? { chips: chipsOf(input.chips, rows.chips_most) } : {}),
      ...(kind.group && fill(kind.group, refs) ? { group: cut(fill(kind.group, refs), 200) } : {}),
      ...(earlier ? structuredClone(earlier) : {}),
      ...(input.retain_delivery === true || saved ? { retain_delivery: true } : {}),
      ...(everyChannel === true ? { every_channel: true } : {}),
    };
    // A new notice is told to `observe` (the account's journey for Trillion HQ); a failure there never stops the notice.
    if (!earlier) { try { observe?.(notice); } catch { /* the notice goes on */ } }
    const chosen = choices();
    const later = notYetDue(kind, notice.at);
    const every = notice.every_channel === true;
    const wanted = channelsFor(kind, chosen, every).map(id => channelRows.get(id)).filter(row => isOn(row, chosen, every) && !row.while_running && !later?.has(row.id)).filter(row => {
      const result = notice.results[row.id];
      if (result?.sent || ['attempting', 'uncertain'].includes(result?.stage)) return false;
      return result?.stage !== 'checking' || now().getTime() - Date.parse(result.started_at) > rows.delivery_claim_seconds * 1000;
    });
    // Reserve the key and every channel before awaiting readiness. A second call joins the stored attempt. A
    // stale readiness check can be retried; a request that may have left the process cannot be blindly repeated.
    const attempt = crypto.randomUUID();
    const claims = Object.fromEntries(wanted.map(row => [row.id, { sent: false, stage: 'checking', attempt, started_at: now().toISOString(), said: rows.delivery_words.checking }]));
    keepNotice(notice, { results: claims });
    const owns = row => currentNotice(notice).results[row.id]?.attempt === attempt;
    const away = notHereNow(kind);
    let denied = null;
    await Promise.all(wanted.map(async row => {
      const finish = result => keepNotice(notice, { results: { [row.id]: result }, attempt });
      if (row.device && away.has(row.device)) { finish({ sent: false, stage: 'unavailable', said: away.get(row.device) }); return; }
      const held = await heldBack(row, notice);
      if (held) { finish({ sent: false, stage: 'unavailable', said: held }); return; }
      const state = await stateOf(row, chosen);
      if (!state.ready) { finish({ sent: false, stage: 'unavailable', said: state.said }); return; }
      if (!owns(row)) return;
      // The source owner checks current assignment/access after all async channel preflight, immediately before
      // the sender is invoked. A revoked request cannot leave merely because it was readable at the first lookup.
      let sendNotice = currentNotice(notice);
      if (beforeSend) {
        let guard;
        try { guard = await beforeSend(); } catch (error) { guard = { blocked: true, reason: String(error.message ?? error).slice(0, 200) }; }
        if (!owns(row)) return;
        if (guard?.inactive || guard?.blocked || guard?.retryable) {
          denied = guard;
          finish({ sent: false, stage: 'unavailable', said: guard.reason ?? 'The source no longer authorizes this notice.' });
          return;
        }
        if (guard?.notice) sendNotice = keepNotice(notice, { payload: guard.notice });
      }
      keepNotice(notice, { results: { [row.id]: { sent: false, stage: 'attempting', attempt, said: rows.delivery_words.attempting } }, attempt });
      try {
        const result = await senderOf(row).send(row, sendNotice, context(chosen, sendNotice, row));
        finish({ sent: Boolean(result.sent), stage: result.sent ? 'accepted' : result.pending === true ? 'queued' : result.retryable === true ? 'unavailable' : 'uncertain', said: String(result.said ?? '') });
      } catch (error) {
        finish({ sent: false, stage: 'uncertain', said: String(error.message ?? error).slice(0, 200) });
      }
    }));
    const receipt = deliveryReceipt(currentNotice(notice));
    return { recorded: true, told: receipt.delivery_accepted || receipt.awareness === 'read-receipt', ...receipt,
      ...(denied ? { ...(denied.inactive ? { inactive: true } : {}), ...(denied.blocked ? { blocked: true } : {}), reason: denied.reason } : {}) };
  }

  // Work still going on, reported by whatever does it (a program on the person's computer, a Workshop run, an AI):
  // { key, title, body?, kind?, source?, refs?, open?, state?: running | done | failed, progress?: { done, total,
  // unit?, label? } }. The same key changes the one notice in place; it is told through the kind's channels once,
  // when the report says the work ended.
  async function report(input = {}) {
    if (!nonempty(input.key)) throw new TellError('key names the work being reported, so each report changes the same notice.');
    if (!nonempty(input.title)) throw new TellError('title is what the work is, in a few words.');
    const state = input.state ?? 'running';
    if (!rows.work_states.includes(state)) throw new TellError(`state is one of ${rows.work_states.join(', ')}.`);
    const progress = progressOf(input.progress);
    const kind = kindOf(nonempty(input.kind) ? input.kind : rows.default_kind);
    const refs = object(input.refs) ? Object.fromEntries(Object.entries(input.refs).map(([name, value]) => [name, asText(value)])) : {};
    const actions = state === 'running' ? actionsOf(input.actions, rows.report_actions_most) : [];
    const chips = chipsOf(input.chips, rows.chips_most);
    const answeredBy = actions.length && nonempty(input.answered_by) ? input.answered_by.trim().slice(0, 200) : null;
    if (actions.length && !answeredBy) throw new TellError('answered_by names the agent that answers the actions a report offers.');
    const list = store.notices();
    const earlier = list.find(item => item.key === input.key);
    if (earlier && earlier.state && earlier.state !== 'running' && state !== 'running') return { reported: false, said: 'This work was already reported as ended.' };
    const at = now().toISOString();
    const fresh = !earlier || earlier.state !== 'running';
    const notice = {
      ...(fresh ? { seq: (list.at(-1)?.seq ?? 0) + 1, at, results: { [rows.shown_here]: keptListSender.send() } } : earlier),
      key: input.key, kind: kind.id, state, updated_at: at,
      title: cut(input.title.trim(), rows.title_max), body: cut(asText(input.body).trim(), rows.body_max),
      open: noticeAddress(rows, kind, input, refs), refs,
      ...(nonempty(input.source) ? { source: cut(input.source.trim(), rows.title_max) } : {}),
      ...(progress ? { progress } : {}),
      ...(actions.length ? { actions, answered_by: answeredBy } : {}),
      ...(chips.length ? { chips } : {}),
    };
    if (!progress) delete notice.progress;
    if (!chips.length) delete notice.chips;
    if (!actions.length) { delete notice.actions; delete notice.answered_by; }
    if (state === 'running') {
      // Channels that draw work live hear every report while it runs (invariant 11); the end goes below with the rest.
      const chosen = choices();
      const live = channelsFor(kind, chosen).map(id => channelRows.get(id)).filter(row => row.while_running && isOn(row, chosen));
      notice.results = { ...notice.results };
      await Promise.all(live.map(async row => {
        const ready = await stateOf(row, chosen);
        if (!ready.ready) { notice.results[row.id] = { sent: false, said: ready.said }; return; }
        try {
          const result = await senderOf(row).send(row, notice, context(chosen, notice, row));
          notice.results[row.id] = { sent: Boolean(result.sent), said: String(result.said ?? '') };
        } catch (error) {
          notice.results[row.id] = { sent: false, said: String(error.message ?? error).slice(0, 200) };
        }
      }));
    }
    if (state !== 'running') {
      const chosen = choices();
      const wanted = channelsFor(kind, chosen).filter(id => id !== rows.shown_here).map(id => channelRows.get(id)).filter(row => isOn(row, chosen));
      notice.results = { ...notice.results };
      await Promise.all(wanted.map(async row => {
        const held = await heldBack(row, notice);
        if (held) { notice.results[row.id] = { sent: false, said: held }; return; }
        const ready = await stateOf(row, chosen);
        if (!ready.ready) { notice.results[row.id] = { sent: false, said: ready.said }; return; }
        try {
          const result = await senderOf(row).send(row, notice, context(chosen, notice, row));
          notice.results[row.id] = { sent: Boolean(result.sent), said: String(result.said ?? '') };
        } catch (error) {
          notice.results[row.id] = { sent: false, said: String(error.message ?? error).slice(0, 200) };
        }
      }));
    }
    store.putNotices(keptNotices([...list.filter(item => item.key !== input.key), notice], rows));
    const receipt = deliveryReceipt(notice);
    return { reported: true, recorded: true, id: `told:${notice.seq}`, state, ...receipt,
      said: state === 'running' ? 'Shown in Trillion while it runs.' : `Recorded that the work ${state === 'done' ? 'finished' : 'stopped'}. ${receipt.said}` };
  }

  // The person pressed one of the actions a running report offered ({ id: 'told:<seq>', action }): the agent that
  // reported it is sent one event and does the rest; the next report shows what changed.
  async function act({ id, action, text, submission_id } = {}) {
    if (!nonempty(id) || !nonempty(action)) throw new TellError('Name the notice (id) and the action to take.');
    if (submission_id !== undefined && (typeof submission_id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(submission_id))) throw new TellError('The reply could not be sent. Start a new reply and try again.');
    const notice = store.notices().find(item => `told:${item.seq}` === id);
    if (!notice) throw new TellError('There is no such notice.');
    // One of the notice's kind's own actions (invariant 10): its road does it, and answering marks the notice read.
    const row = notice.actions?.some(item => item.id === action) ? null : offeredBy(kindOf(notice.kind), notice).find(item => item.id === action);
    if (row) {
      if (row.input && !nonempty(text)) throw new TellError(rows.action_words.needs_words);
      const road = roads[row.road];
      if (!road) throw new TellError(fill(rows.action_words.not_an_action, { action: row.label }));
      const answer = (await road({ notice, text: nonempty(text) ? text.trim() : null, row, submission_id })) ?? {};
      markRead({ ids: [id] });
      return { done: true, said: answer.said ?? row.said ?? '', ...(answer.open ? { open: answer.open } : row.opens ? { open: notice.open } : {}) };
    }
    if (!notice.actions?.some(item => item.id === action) && !notice.state) throw new TellError(fill(rows.action_words.not_an_action, { action }));
    const offered = notice.actions?.find(item => item.id === action);
    if (stateNow(notice) !== 'running' || !offered || !notice.answered_by) throw new TellError(fill(rows.action_words.not_offered, { label: offered?.label ?? action }));
    if (!askAgent) throw new TellError(rows.action_words.cannot_ask);
    const at = now().toISOString();
    const sent = await askAgent({
      type: rows.action_event, to_agent: notice.answered_by, idempotency_key: `${notice.key}:${action}:${at}`, subject_id: notice.key,
      refs: { key: notice.key, action }, summary: cut(`${offered.label}: ${notice.title}`, 300),
    });
    if (!sent?.event) return { asked: false, said: fill(rows.action_words.unreachable, { source: notice.source ?? notice.title }) };
    return { asked: true, said: fill(rows.action_words.asked, { label: offered.label, source: notice.source ?? notice.title }) };
  }

  // The person answered a notice out loud (invariant 16): { id: 'told:<seq>', text } -> what was done, in words.
  async function answerAloud({ id, text } = {}) {
    if (!nonempty(id) || !nonempty(text)) throw new TellError('Name the notice (id) and what was said (text).');
    const notice = store.notices().find(item => `told:${item.seq}` === id);
    if (!notice) throw new TellError('There is no such notice.');
    const spoken = rows.spoken_answers;
    const said = text.trim().toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const says = list => list.some(words => said === words || said.startsWith(`${words} `) || said.endsWith(` ${words}`) || said.includes(` ${words} `));
    if (says(spoken.stop.says)) {
      const carried = store.notices().filter(item => item.results?.[spoken.channel]).map(item => `told:${item.seq}`);
      if (carried.length) markRead({ ids: carried });
      await choose({ channels: { [spoken.channel]: { on: false } } });
      return { did: 'stop', said: spoken.stop.said };
    }
    if (says(spoken.later.says)) return { did: 'later', said: spoken.later.said };
    const action = offeredBy(kindOf(notice.kind), notice).find(row => row.input);
    if (!action) return { did: 'nothing', said: spoken.no_answer };
    const answer = await act({ id, action: action.id, text: text.trim() });
    return { did: 'answered', action: action.id, said: answer.said };
  }

  const test = () => tell({ ...rows.test, key: `test:${now().toISOString()}` });
  // What one device reads (invariant 12): the notices its own channel carried after `after`, oldest first.
  const forDevice = ({ channel, after = 0 } = {}) => {
    if (!channelRows.has(channel)) throw new TellError(`There is no way to be told called ${channel}.`);
    const since = Number.isFinite(Number(after)) ? Number(after) : 0;
    return { notices: store.notices({ after: since }).filter(item => item.results[channel] && item.seq > since).slice(-rows.shown_most).map(deviceNotice) };
  };
  // What the open Trillion page shows: the notices its own channel (`shown_here`) carried, newest first, with the
  // person's read mark, the surface they read it on (`read_on`, invariant 17) and how far each of its ways got (`told`).
  // One kept notice as every reader sees it: the page's list (recent) and an AI's (told).
  const shownRow = item => ({
      id: `told:${item.seq}`, kind: item.kind, title: item.title, body: item.body, open: item.open, at: item.at, read: Boolean(item.read),
      ...(item.read_on ? { read_on: item.read_on } : {}),
      told: Object.fromEntries(Object.entries(item.results).map(([channel, result]) => [channel, result.sent ? 'sent' : result.stage ?? 'not-sent'])),
      ...(item.state ? { state: stateNow(item), updated_at: item.updated_at } : {}),
      ...(item.source ? { source: item.source } : {}),
      ...(item.progress ? { progress: item.progress } : {}),
      ...(item.chips ? { chips: item.chips } : {}),
      ...(kindOf(item.kind).preview_ref && typeof item.refs?.[kindOf(item.kind).preview_ref] === 'string'
        ? { preview_identity: item.refs[kindOf(item.kind).preview_ref] } : {}),
      ...pageButtons(item),
    });
  const recent = () => ({ notices: store.notices().filter(item => item.results[rows.shown_here]?.sent).slice(-rows.shown_most).reverse().map(shownRow) });
  // The surface a read came from (invariant 17): its channel (`here`: the open page's own, `shown_here`), and its
  // device when the surface has one.
  // `from: 'thing'` marks a read inferred from the person seeing the thing the notice is about (the open page showing
  // the held thing), not the notice itself.
  const surfaceOf = on => {
    const channel = on?.here === true ? rows.shown_here : on?.channel;
    return object(on) && channelRows.has(channel)
      ? { channel, ...(nonempty(on.device_id) ? { device_id: on.device_id.slice(0, 200) } : {}), ...(on.from === 'thing' ? { from: 'thing' } : {}), at: now().toISOString() } : null;
  };
  // The surface kept for a notice read again: the first one, except that the notice itself read on a way that carried
  // it (a tap on the phone's banner) replaces a surface only inferred from seeing its thing, since that tap is what
  // brought the page that saw the thing to the front.
  const keptSurface = (item, surface) => {
    const kept = item.read_on;
    if (!kept) return surface ?? undefined;
    if (kept.from === 'thing' && surface && !surface.from && item.results?.[surface.channel]?.sent) return surface;
    return kept;
  };
  // The person read (or, with read false, did not read) the notices `ids`, or the notice `key`, on the surface `on`.
  function markRead({ ids, key, read = true, on } = {}) {
    if (nonempty(key)) ids = store.notices().filter(item => item.key === key).map(item => `told:${item.seq}`);
    if (!Array.isArray(ids) || !ids.every(nonempty)) throw new TellError('Name the notices as a list of their ids.');
    const wanted = new Set(ids);
    const surface = read !== false ? surfaceOf(on) : null;
    store.putNotices(store.notices().map(item => {
      if (!wanted.has(`told:${item.seq}`)) return item;
      // The first surface it was seen on is kept; reading it again elsewhere does not move it (keptSurface).
      const seen = read !== false ? keptSurface(item, surface) : undefined;
      const receipt = store.delivery?.(item.key);
      if (receipt) store.putDelivery(item.key, { ...receipt, read: read !== false, ...(seen ? { read_on: seen } : {}) });
      const { read_on: _, ...rest } = item;
      return { ...rest, read: read !== false, ...(seen ? { read_on: seen } : {}) };
    }));
    return { ids, read: read !== false, ...(surface ? { on: surface } : {}) };
  }

  // When the next row of an ordered reach comes due for a notice the person has not read (invariant 17), or null.
  // The channels of a ladder row still to tell for a notice: ones the kind sends and the person has on, not yet tried.
  const untold = (kind, row, item, chosen) => {
    const sends = new Set(channelsFor(kind, chosen, item.every_channel === true).filter(id => isOn(channelRows.get(id), chosen, item.every_channel === true)));
    return row.channels.filter(channel => sends.has(channel) && !item.results?.[channel]);
  };
  function reachNextAt() {
    let next = null;
    const chosen = choices();
    for (const item of store.notices()) {
      if (item.read === true || item.state) continue;
      const kind = kindOf(item.kind);
      for (const row of reachRows(kind)) {
        const at = Date.parse(item.at) + Number(row.after_minutes ?? 0) * 60_000;
        if (!untold(kind, row, item, chosen).length) continue;
        if (next === null || at < next) next = at;
      }
    }
    return next;
  }

  // Tells each unread notice through the rows of its ordered reach that came due (invariant 17); one tell per notice,
  // through the notice's own key, so a row already told is never told again.
  async function reachDue() {
    let told = 0;
    const chosen = choices();
    for (const item of store.notices()) {
      if (item.read === true || item.state) continue;
      const kind = kindOf(item.kind);
      const due = reachRows(kind).filter(row => Date.parse(item.at) + Number(row.after_minutes ?? 0) * 60_000 <= now().getTime()
        && untold(kind, row, item, chosen).length);
      if (!due.length) continue;
      await tell({ title: item.title, body: item.body, kind: kind.id, refs: item.refs, key: item.key, retry_failed: true }).catch(() => null);
      told += 1;
    }
    return { told };
  }
  // What an AI reads (tool:my-notices): the same notices as recent, optionally of one kind, with where each was seen.
  const told = ({ limit = 20, kind = null } = {}) => {
    // Every kept notice, whichever ways it went, of the kind asked for before the newest are taken, so one kind is found
    // however many of another came after it. Why each way that did not carry it did not, in its sender's own words.
    const most = Math.max(1, Math.min(100, Number(limit) || 20));
    const notices = store.notices().filter(item => !kind || item.kind === kind).slice(-most).reverse().map(item => {
      const { id, kind: of, title = null, at = null, open = null, read, read_on, told: ways } = shownRow(item);
      const why = Object.fromEntries(Object.entries(item.results ?? {}).filter(([, result]) => !result.sent && result.said).map(([channel, result]) => [channel, String(result.said).slice(0, 200)]));
      return { id, kind: of, title, at, open, read, ...(read_on ? { read_on } : {}), told: ways, ...(Object.keys(why).length ? { why } : {}) };
    });
    const seen = notices.filter(item => item.read).length;
    return { notices, said: `${notices.length} ${notices.length === 1 ? 'notice' : 'notices'}, newest first; ${seen} seen.` };
  };
  return { settings, keepChoices, choose, tell, report, act, answerAloud, test, recent, told, forDevice, deviceNotice, markRead, reachNextAt, reachDue };
}

/** The sender that keeps the notice where the person's own screens read it: keeping is the send. */
export const keptListSender = {
  state: () => ({ ready: true }),
  send: () => ({ sent: true, said: 'Shown in Trillion.' }),
};

// ---- the person store's routes ---------------------------------------------------------------------------------

// A route whose whole effect is one synchronous write commits it through the owner's `commit` (a write and its reply
// kept under the command's receipt, src/standalone-resource-behavior.mjs tellReceipts), or runs it when there is none.
const committed = (owner, operation, change) => typeof owner.commit === 'function' ? owner.commit(change, { operation }) : change();
const ROUTES = {
  'GET /tell': (owner) => owner.tell.settings(),
  // The choice is committed alone; the settings it answers with are read after it (rebuilt the same way for a lost one).
  'POST /tell': (owner, body) => { committed(owner, 'tell:choose', () => owner.tell.keepChoices(body)); return owner.tell.settings(); },
  'POST /tell/test': (owner) => owner.tell.test(),
  'POST /tell/progress': (owner, body) => owner.tell.report(body),
  // With ?channel=<id>, what that channel's devices read (after=<seq> for only the newer ones); else the page's list.
  'GET /tell/notices': (owner, body, query) => (query.has('channel') ? owner.tell.forDevice({ channel: query.get('channel'), after: query.get('after') ?? 0 }) : owner.tell.recent()),
  'POST /tell/notices/read': (owner, body) => committed(owner, 'tell:read-notices', () => owner.tell.markRead(body)),
  'POST /tell/notices/act': (owner, body) => owner.tell.act(body),
  'POST /tell/notices/answer-aloud': (owner, body) => owner.tell.answerAloud(body),
  'GET /tell/devices': (owner) => ({ devices: owner.devices.listed(), web_push_key: owner.webPushKey() }),
  'POST /tell/devices/find': (owner, body) => owner.devices.find(body),
  'POST /tell/devices': (owner, body) => committed(owner, 'tell:add-device', () => owner.devices.add(body)),
  'POST /tell/devices/remove': (owner, body) => committed(owner, 'tell:remove-device', () => owner.devices.remove(body)),
  'POST /tell/activities': (owner, body) => committed(owner, 'tell:keep-activity', () => owner.activities.keep(body)),
  // What a glance surface (an iPhone widget, a watch complication) can be set to show, and which feeds a surface that
  // shows several (the watch app) shows: read-data/glance-feeds.json, as DATA. Old trillion let the marketplace publish
  // over its `/feeds` and `/surfaces` (src/marketplace-content-document.mjs); that read is the published shelf's, another
  // account's, so here the shipped DATA answers.
  'GET /tell/feeds': async () => ({ feeds: glanceFeeds.feeds, surfaces: glanceFeeds.surfaces ?? {} }),
};
// The writes the routes commit through owner.commit.
export const TELL_RECEIPTED_WRITES = Object.freeze(['tell:choose', 'tell:read-notices', 'tell:add-device', 'tell:remove-device', 'tell:keep-activity']);
export const isTellPath = path => path === '/tell' || path.startsWith('/tell/');

/**
 * owner: { tell (makeTellThePerson), devices (src/tell-devices.mjs tellDevices), webPushKey() → base64url | null,
 *          activities: { keep({ key, token, app, environment, ended }) },
 *          commit?(change, { operation }) → change's answer, kept with it in one transaction (TELL_RECEIPTED_WRITES) }
 */
export async function handleTellRequest(owner, request) {
  const url = new URL(request.url);
  const route = ROUTES[`${request.method} ${url.pathname}`];
  if (!route) return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    const body = request.method === 'GET' ? {} : JSON.parse((await request.text()) || '{}');
    return Response.json(await route(owner, body, url.searchParams));
  } catch (error) {
    // A road that refused with its own status (a plan that does not include it) answers with that status and words.
    const own = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : null;
    return Response.json({ error: String(error.message ?? error), ...(error?.upgrade_needed ? { upgrade_needed: true } : {}) }, { status: own ?? (error instanceof TellError || error instanceof DeviceError || error instanceof SyntaxError ? 400 : 500) });
  }
}
