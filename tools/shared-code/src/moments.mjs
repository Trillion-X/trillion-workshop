// src/moments.mjs
//
// Purpose
//   One generic step before work is handed out: arrivals that belong together (close in time and/or subject: photos,
//   screenshots, voice memos, camera clips, recordings, the same words sent to several AIs) become ONE moment and ONE
//   handoff instead of one job each. Which arrivals join, and how long a moment waits, are the rows of
//   src/moments.json; nothing here names an app, a kind of file or a number.
//
// Two ways, by the row an item matches
//   - A row that waits (quiet_minutes above 0): the arrival or asked record is kept as always but marked with its
//     `moment`, which the starting rules read to hand nothing off yet (records/starting-rules.json starting:arrivals,
//     starting:asked). The moment record gathers its members; once nothing joined it for quiet_minutes it closes, and
//     that one write (the only watched one) carries `send`, the job of all its members, which the starting rule
//     starting:moments hands to an AI with once_per = the moment's id.
//   - A row that does not wait (quiet_minutes 0, the same words sent to several AIs): the first is handed off at once
//     as it always was. A later one with the same words, sent through a different app or conversation within the
//     window, is given the first one's once_per, so the handoff already made is its job (src/agents.mjs joined) and
//     the moment record is only the ledger of which messages said the same.
//   - A row with window_minutes 0, or no row: nothing changes. The item is handed off at once.
//
// Non-negotiable invariants
//   1. Pure first: momentOf, due, nextDue, closing and gathered decide from the rows and the records given; only
//      momentsDoor writes, and only `moment` records, the open list and (late joiners) nothing else.
//   2. Nothing is lost: the job of a moment lists every member and ends with a pointer naming every member message,
//      file and asked record, and never exceeds 8000 characters (what hand_off accepts).
//   3. Words that are not in the arrival stay unclaimed: a member of a kind with hear_first (a sound or video) is listed
//      by file, and the job tells the taker to hear every one of them before acting. No transcription is done here.
//   4. A late member (after the moment closed, while its job is still open and untaken) adds its words to that same
//      job through the handoff's once_per; once the job is taken it opens a moment of its own instead.
//   5. While a moment is open its writes are unwatched: no rule runs until it closes (or a late member joins).
//   6. History, imported chats and Trillion's own heard voice never reach this step (src/inbound.mjs keeps them as
//      context, no arrival), so they never open a handoff.
//
// gather_moment (MCP tool, POST /moments/gather) builds ONE moment from arrival and asked records already kept between
// `from` and `until`, with the same rows, and folds the members' still-open untaken handoffs into its handoff.
// dry_run reads and answers only. Gaps longer than a row's window inside the range are ignored on purpose: naming the
// range is the person's word that it is one moment; the answer reports the longest gap.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import data from './moments.json' with { type: 'json' };
import { handoffIdFor } from './agents.mjs';

export const MOMENTS_PATH = '/moments/gather';
// What hand_off accepts as a job (src/agents.mjs handOff, src/inbound.mjs MAX_JOB).
export const MAX_JOB = 8000;
const SAID_MAX = 300;
const MINUTE = 60000;
const HLC_FREE = 'moment';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
const hash = text => bytesToHex(blake3(new TextEncoder().encode(text))).slice(0, 24);
const iso = ms => new Date(ms).toISOString();
const clock = at => iso(Date.parse(at)).slice(11, 16);
const minutes = ms => ms / MINUTE;
const stripId = ({ id, ...value }) => value;

export const momentIdOf = memberId => `${data.record_kind}:${hash(memberId)}`;
/** The words of an item as compared across apps: lower case, letters and digits only, one space between words. */
export const wordsKey = text => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** What an arrival keeps to be compared with others' words: a short hash of the normalised words, or '' when they are too few to mean the same. */
export const textKeyOf = (text, rows = data) => { const key = wordsKey(text); return key.length >= rows.same_text.min_characters && key.split(' ').length >= rows.same_text.min_words ? hash(key) : ''; };

// ---- matching a rule tree (the shape src/metered-use.json uses) over facts, synchronously ----
const lower = value => String(value ?? '').toLowerCase();
const OPERATORS = {
  is_any_of: (fact, params) => (params.values ?? []).map(String).includes(String(fact)),
  is_none_of: (fact, params) => !(params.values ?? []).map(String).includes(String(fact)),
  contains: (fact, params) => lower(fact).includes(lower(params.text)),
  is_text: (fact, params) => lower(fact) === lower(params.text),
  is_empty: fact => !nonempty(fact === null || fact === undefined ? '' : String(fact)),
  is_not_empty: fact => nonempty(fact === null || fact === undefined ? '' : String(fact)),
};
export function holds(tree, facts) {
  if (!tree) return true;
  if (tree.kind === 'group') {
    const hit = tree.combinator === 'or' ? tree.rules.some(rule => holds(rule, facts)) : tree.rules.every(rule => holds(rule, facts));
    return tree.negate ? !hit : hit;
  }
  const test = OPERATORS[tree.operator];
  if (!test) throw new Error(`moments.json: no operator ${tree.operator}`);
  return test(facts[tree.field], tree.params ?? {});
}

// ---- items: an arrival or an asked record seen as one member ----
/** { id, kind: 'arrival', ...} from a kept arrival record. */
export const itemOfArrival = (id, value) => ({
  id, kind: 'arrival', message_id: value.message_id, route: value.route, source_id: value.source_id, at: value.at,
  files: (value.files ?? []).map(({ id: file, name }) => ({ id: file, ...(nonempty(name) ? { name } : {}) })),
  from_person: value.from_person !== false, label: value.title ?? '', said: value.said ?? '', job: value.job ?? '', text: value.said ?? '',
  priority: value.priority ?? 0, case_id: value.case_id ?? null, chat_first_minutes: value.chat_first_minutes ?? null, job_id: '',
  text_key: value.text_key ?? '', follows: value.follows ?? '', moment: value.moment ?? '',
});
/** The same for a kept asked record (src/queued-work.mjs). A recording's file is named by its context. */
export const itemOfAsked = (id, value) => ({
  id, kind: 'asked', message_id: value.item ?? id, route: '', source_id: null, at: value.at,
  files: nonempty(value.context?.audio_file) ? [{ name: value.context.audio_file }] : [],
  transcript: nonempty(value.context?.transcript_file) ? value.context.transcript_file : '',
  from_person: true, label: '', said: value.said ?? '', job: value.job ?? '', text: value.said ?? '',
  priority: value.priority ?? 0, case_id: null, chat_first_minutes: null, job_id: value.job_id ?? '', text_key: '', moment: value.moment ?? '',
});

/**
 * An item seen from a job handed out before it was held for a moment (an open handoff of starting:asked or
 * starting:arrivals): its input.arrived names what it came from. null when it names nothing a moment could group.
 */
export function itemOfHandoff(handoff) {
  const arrived = handoff.input?.arrived ?? {};
  if (nonempty(arrived.moment_id)) return null;
  const at = arrived.at ?? handoff.handed_at;
  if (nonempty(arrived.asked_id)) {
    return { ...itemOfAsked(arrived.asked_id, { at, item: handoff.once_per ?? arrived.asked_id, context: arrived.context, job_id: arrived.job_id, said: handoff.said, job: handoff.job, priority: handoff.priority }), handoff_id: handoff.handoff_id };
  }
  if (!nonempty(arrived.message_id)) return null;
  return {
    ...itemOfArrival(handoff.handoff_id, { message_id: arrived.message_id, route: arrived.route, source_id: arrived.source_id, at, files: arrived.files, title: arrived.title, said: handoff.said, job: handoff.job, priority: handoff.priority, case_id: handoff.case_id, from_person: arrived.from_person }),
    handoff_id: handoff.handoff_id,
  };
}

export function kindOf(item, rows = data) {
  const facts = { kind: item.kind, route: item.route, job_id: item.job_id, file: item.files?.[0]?.name ?? '', from_person: String(item.from_person) };
  return rows.kinds.find(row => holds(row.when, facts)) ?? null;
}
export function rowFor(item, rows = data) {
  const kind = kindOf(item, rows);
  const facts = { kind: item.kind, route: item.route, job_id: item.job_id, source_kind: kind?.id ?? '', from_person: String(item.from_person), has_text: String(nonempty(item.text_key) && !kind) };
  return rows.rows.find(row => holds(row.when, facts)) ?? null;
}
/** Does this row hold its arrivals back (a moment that waits), merge them without waiting, or neither? */
export const modeOf = row => (!row || !(row.window_minutes > 0) ? 'alone' : row.quiet_minutes > 0 ? 'waits' : 'merges');

const sharedWords = (left, right, rows) => {
  const long = text => new Set(wordsKey(text).split(' ').filter(word => word.length >= rows.shared_words.min_length));
  const mine = long(left);
  let count = 0;
  for (const word of long(right)) if (mine.has(word)) count += 1;
  return count >= rows.shared_words.min_shared;
};
/** Which of the row's signals hold between an item and one member. */
function signalsBetween(row, item, member, rows) {
  const near = Math.abs(Date.parse(item.at) - Date.parse(member.at)) <= row.window_minutes * MINUTE;
  const held = [];
  for (const signal of row.signals ?? []) {
    if (signal === 'near_in_time' && near) held.push(signal);
    else if (signal === 'same_conversation' && near && nonempty(item.source_id) && item.source_id === member.source_id) held.push(signal);
    else if (signal === 'same_text_across_apps' && near && nonempty(item.text_key) && item.text_key === member.text_key
      && (item.route !== member.route || item.source_id !== member.source_id)) held.push(signal);
    else if (signal === 'shared_words' && near && sharedWords(item.said, member.said, rows)) held.push(signal);
  }
  return held;
}

/**
 * Where an item belongs, from the rows and the moments open now (open: moment values with id; alike: earlier
 * arrivals with the same words, for a row that merges):
 *   { action: 'alone' } | { action: 'open', row } | { action: 'join', moment_id, late, signals }
 *   | { action: 'merge', into: { id, message_id, once_per }, signals }
 * handoffOpen(once_per) says whether a closed moment's job is still open and untaken (a late member may join only then).
 */
export function momentOf(item, open = [], rows = data, { alike = [], handoffOpen = () => false, mergeable = () => true } = {}) {
  const row = rowFor(item, rows);
  const mode = modeOf(row);
  if (mode === 'alone') return { action: 'alone' };
  if (mode === 'merges') {
    const hits = alike.filter(other => other.id !== item.id && other.row === row.id && other.text_key === item.text_key && nonempty(item.text_key) && mergeable(other.once_per ?? other.message_id)).map(other => ({ other, signals: signalsBetween(row, item, other, rows) }))
      .filter(hit => hit.signals.length).sort((a, b) => Date.parse(a.other.at) - Date.parse(b.other.at));
    if (!hits.length) return { action: 'alone' };
    const { other, signals } = hits[0];
    return { action: 'merge', row, into: { id: other.id, message_id: other.message_id, route: other.route, once_per: other.once_per ?? other.message_id }, signals };
  }
  const time = Date.parse(item.at);
  const candidates = open.filter(moment => moment.row === row.id && moment.members.length < row.most_members && (!moment.closed_at
    ? true : handoffOpen(moment.id) && time <= Date.parse(moment.closed_at) + row.late_minutes * MINUTE + 0 * 1))
    .filter(moment => !moment.members.some(member => member.id === item.id))
    .map(moment => {
      const from = Date.parse(moment.from);
      const within = time - from <= row.most_span_minutes * MINUTE && Date.parse(moment.until) - time <= row.most_span_minutes * MINUTE;
      const signals = within ? [...new Set(moment.members.flatMap(member => signalsBetween(row, item, member, rows)))] : [];
      return { moment, signals };
    }).filter(hit => hit.signals.length)
    .sort((a, b) => Date.parse(b.moment.until) - Date.parse(a.moment.until));
  if (!candidates.length) return { action: 'open', row };
  const { moment, signals } = candidates[0];
  return { action: 'join', row, moment_id: moment.id, late: Boolean(moment.closed_at), signals };
}

/** Ids of the moments still open whose quiet time ended (closes_at) by now. */
export const due = (now, moments) => moments.filter(moment => !moment.closed_at && Date.parse(moment.closes_at) <= now).map(moment => moment.id);
/** The earliest time a moment closes (ms), or null. */
export function nextDue(moments) {
  const times = moments.filter(moment => !moment.closed_at).map(moment => Date.parse(moment.closes_at));
  return times.length ? Math.min(...times) : null;
}

// ---- record shapes ----
const memberOf = item => ({ id: item.id, kind: item.kind, message_id: item.message_id, route: item.route, at: item.at, ...(item.source_id ? { source_id: item.source_id } : {}), ...(item.files.length ? { files: item.files } : {}) });
const unionFiles = members => [...new Map(members.flatMap(member => member.files ?? []).map(file => [file.id ?? file.name, file])).values()];
const spanOf = members => { const times = members.map(member => Date.parse(member.at)); return { from: iso(Math.min(...times)), until: iso(Math.max(...times)) }; };

/** A new moment of one item, opened at `now` (ms). */
export function opened(item, row, now) {
  const members = [memberOf(item)];
  return { row: row.id, members, files: unionFiles(members), ...spanOf(members), opened_at: iso(now), last_at: iso(now), closes_at: iso(now + row.quiet_minutes * MINUTE), closed_at: null, handoff_id: null };
}
/** The moment with one more member at `now`; a closed moment stays closed. */
export function joinedWith(moment, item, row, now) {
  const members = [...moment.members, memberOf(item)];
  return { ...moment, members, files: unionFiles(members), ...spanOf(members), last_at: iso(now), ...(moment.closed_at ? {} : { closes_at: iso(now + row.quiet_minutes * MINUTE) }) };
}

// ---- the words ----
const counts = (members, items, rows) => {
  const tally = new Map();
  for (const item of members) {
    const kind = kindOf(items.get(item.id) ?? { ...item, files: item.files ?? [] }, rows);
    const key = kind?.id ?? '';
    tally.set(key, [...(tally.get(key) ?? [kind, 0])].with(1, (tally.get(key)?.[1] ?? 0) + 1));
  }
  return [...tally.values()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => fill(rows.words.count, { n, what: kind ? (n === 1 ? kind.label : kind.plural) : rows.words.title_other }));
};
export function titleOf(moment, items, rows = data) {
  const { from, until } = spanOf(moment.members);
  return fill(rows.words.title, { from: clock(from), until: clock(until), counts: counts(moment.members, items, rows).join(rows.words.count_join) }).slice(0, SAID_MAX);
}

const fileLabel = file => file.id ?? file.name;
const pointerOf = (members, rows) => {
  // Only the first pointer_most of each are listed (a gather of hundreds must not push the pointer out of the job); the rest are counted.
  const most = rows.gather.pointer_most;
  const list = values => {
    const all = [...new Set(values)];
    if (!all.length) return rows.words.pointer_none;
    return all.length <= most ? all.join(', ') : fill(rows.words.pointer_more, { shown: all.slice(0, most).join(', '), more: all.length - most });
  };
  return fill(rows.words.pointer, {
    messages: list(members.filter(member => member.kind === 'arrival').map(member => member.message_id)),
    files: list(members.flatMap(member => (member.files ?? []).map(fileLabel))),
    asked: list(members.filter(member => member.kind === 'asked').map(member => member.id)),
  });
}

/**
 * The job of these members (items: Map id -> the member as an item, with its own job words). `first` true is the whole
 * moment's job; false is a late addition. Never longer than MAX_JOB; always ends with the pointer.
 */
export function jobOf(moment, members, items, rows = data, { first = true } = {}) {
  const words = rows.words;
  const kinds = new Map(members.map(member => [member.id, kindOf(items.get(member.id) ?? member, rows)]));
  const head = first ? `${titleOf(moment, items, rows)}\n\n${fill(words.lead, { n: members.length })}` : fill(words.late_lead, { n: members.length });
  // A recording that already has its words in a transcript file (a camera clip's, named in its own job) is read, not
  // heard again; one with no words (a voice memo) is heard first. Neither line claims to know what was said.
  const spoken = members.filter(member => kinds.get(member.id)?.hear_first);
  const written = spoken.map(member => (items.get(member.id) ?? member).transcript).filter(nonempty);
  const hear = spoken.filter(member => !nonempty((items.get(member.id) ?? member).transcript)).flatMap(member => (member.files ?? []).map(fileLabel));
  const hearLine = [
    hear.length ? fill(words.hear_first, { files: [...new Set(hear)].join(', ') }) : '',
    written.length ? fill(words.read_transcripts, { files: [...new Set(written)].join(', ') }) : '',
  ].filter(Boolean).map(line => `\n\n${line}`).join('');
  const lines = members.map((member, at) => {
    const item = items.get(member.id) ?? member;
    const kind = kinds.get(member.id);
    const excerpt = nonempty(item.said) ? fill(words.member_words, { words: item.said.trim().replace(/\s+/g, ' ').slice(0, words.words_excerpt) }) : '';
    const files = (member.files ?? []).length ? fill(words.member_files, { files: member.files.map(fileLabel).join(', ') }) : '';
    return fill(words.member, { n: at + 1, at: clock(member.at), what: kind?.label ?? words.title_other, route: member.route || member.kind, label: nonempty(item.label) ? fill(words.member_label, { label: item.label }) : '', files, id: member.message_id ?? member.id }) + excerpt;
  });
  const pointer = pointerOf(members, rows);
  const fixed = [head + hearLine, lines.join('\n'), pointer].join('\n\n');
  const room = MAX_JOB - fixed.length - 2;
  const share = members.length ? Math.floor(room / members.length) : 0;
  let bodies = '';
  if (share >= 80) {
    bodies = members.map((member, at) => {
      const own = (items.get(member.id)?.job ?? '').trim();
      if (!own) return '';
      const part = fill(words.part, { n: at + 1, what: kinds.get(member.id)?.label ?? words.title_other });
      const space = share - part.length - 2;
      return `${part}\n${own.length <= space ? own : `${own.slice(0, Math.max(0, space - words.clipped.length - 1))} ${words.clipped}`}`;
    }).filter(Boolean).join('\n\n');
  }
  const job = [head + hearLine, lines.join('\n'), bodies, pointer].filter(Boolean).join('\n\n');
  // The pointer is the one thing that must survive: when the list itself is too long, the list is cut, not the pointer.
  return job.length <= MAX_JOB ? job : `${job.slice(0, Math.max(0, MAX_JOB - pointer.length - 2))}\n\n${pointer}`.slice(-MAX_JOB);
}

/**
 * The moment as it is closed: the words for the handoff (send, said), priority and the facts the starting rule hands on.
 * items: Map member id -> item (with its job words), read by the caller. `at` is the close time.
 */
export function closing(moment, items, at, rows = data) {
  const present = moment.members.filter(member => items.has(member.id));
  const known = present.length ? present : moment.members;
  const title = titleOf(moment, items, rows);
  const sources = new Set(moment.members.map(member => member.source_id ?? ''));
  const chat = [...items.values()].map(item => item.chat_first_minutes).filter(value => Number.isFinite(value));
  const first = [...moment.members].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  return {
    ...moment, closed_at: iso(at), handoff_id: handoffIdFor(`once-per:${moment.id}`), once_per: moment.id, title,
    send: jobOf(moment, known, items, rows), said: title,
    priority: Math.max(0, ...[...items.values()].map(item => item.priority ?? 0)),
    route: first.route || first.kind, at: first.at, message_id: first.message_id,
    message_ids: [...new Set(moment.members.map(member => member.message_id))],
    from_person: [...items.values()].some(item => item.from_person !== false),
    ...(sources.size === 1 && nonempty([...sources][0]) ? { source_id: [...sources][0] } : {}),
    ...(chat.length ? { chat_first_minutes: Math.min(...chat) } : {}),
    ...(items.get(first.id)?.case_id ? { case_id: items.get(first.id).case_id } : {}),
  };
}

/** What hand_off is given for a closed moment (the starting rule fills the same from the record). */
export const handoffOf = moment => ({
  job: moment.send, said: moment.said, once_per: moment.id, priority: moment.priority,
  ...(moment.case_id ? { case_id: moment.case_id } : {}),
  input: { arrived: {
    route: moment.route, at: moment.at, message_id: moment.message_id, message_ids: moment.message_ids, from_person: moment.from_person,
    title: moment.title, files: moment.files, moment_id: moment.id,
    ...(moment.source_id ? { source_id: moment.source_id } : {}),
    ...(moment.chat_first_minutes !== undefined ? { chat_first_minutes: moment.chat_first_minutes } : {}),
  } },
});

/**
 * The one moment a range of kept items makes, for gather_moment (pure). items: item list; row: the row (default: the
 * first row that waits). -> { row, members (oldest first), longest_gap_minutes } or null when none belong.
 */
export function gathered(items, rows = data, row = null) {
  const wanted = row ?? rows.rows.find(candidate => modeOf(candidate) === 'waits');
  const mine = items.filter(item => rowFor(item, rows)?.id === wanted?.id).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  if (!wanted || !mine.length) return null;
  const gaps = mine.slice(1).map((item, at) => minutes(Date.parse(item.at) - Date.parse(mine[at].at)));
  return { row: wanted, items: mine, longest_gap_minutes: gaps.length ? Math.max(...gaps) : 0 };
}

// ---- the door: the only part that writes ----
const KIND = data.record_kind;
const OPEN = data.open_list;

/**
 * eeaf: the person's records ({ read, write, scan }). handoffOpen(once_per) -> true when that job is open and untaken.
 * now() -> a Date. rows: moments.json (or a test's).
 */
export function momentsDoor({ eeaf, handoffOpen = () => false, mergeable = () => true, continuesOf = item => nonempty(item.follows), now = () => new Date(), rows = data }) {
  const openIds = () => eeaf.read(OPEN)?.ids ?? [];
  const keepIds = (ids, actor) => { if (JSON.stringify(ids) !== JSON.stringify(openIds())) eeaf.write([{ id: OPEN, type: 'setting', value: { ids } }], { actor, unwatched: true }); };
  const openMoments = () => openIds().map(id => { const value = eeaf.read(id); return value ? { id, ...value } : null; }).filter(Boolean);
  // One watched write per moment closed: its one record the starting rule fires on.
  const closeAll = (ids, at) => {
    const closed = [];
    for (const id of ids) {
      const moment = { id, ...eeaf.read(id) };
      const items = new Map();
      for (const member of moment.members) {
        const value = eeaf.read(member.id);
        if (value) items.set(member.id, member.kind === 'asked' ? itemOfAsked(member.id, value) : itemOfArrival(member.id, value));
      }
      eeaf.write([{ id, type: KIND, value: stripId(closing(moment, items, at, rows)) }], { actor: { by: 'trillion', app: 'moments' } });
      closed.push(id);
    }
    return closed;
  };
  const actorOf = item => ({ by: 'carrier', app: item.route || item.kind });

  return {
    /**
     * Where a freshly kept item goes, and the writes that say so. -> { moment?: id, once_per?: id } to add to the item's
     * record: `moment` when it is held for a moment (no handoff of its own), `once_per` when its words are already
     * another message's job. Writes only moment records and the open list.
     */
    place(item) {
      const at = now().getTime();
      const itemRow = rowFor(item, rows);
      const mode = modeOf(itemRow);
      if (mode === 'alone') return {};
      if (mode === 'merges') {
        if (continuesOf(item)) return {};
        const from = iso(Date.parse(item.at) - itemRow.window_minutes * MINUTE);
        const to = iso(Date.parse(item.at) + itemRow.window_minutes * MINUTE);
        // The earlier arrivals' words are read from their kept messages (nothing extra is stored on an arrival to compare).
        const alike = eeaf.scan('arrival', 'at', { from, to, limit: 100 }).map(entry => {
          const value = eeaf.read(entry.id);
          return value && { ...itemOfArrival(entry.id, value), text_key: textKeyOf(eeaf.read(value.message_id)?.text, rows), once_per: value.once_per, row: itemRow.id };
        }).filter(other => other && !continuesOf(other));
        const placed = momentOf(item, [], rows, { alike, mergeable });
        if (placed.action !== 'merge') return {};
        const id = momentIdOf(placed.into.once_per);
        const ledger = eeaf.read(id) ?? { row: itemRow.id, members: [memberOf({ ...itemOfArrival(placed.into.id, eeaf.read(placed.into.id) ?? {}), id: placed.into.id })], files: [], ...spanOf([{ at: item.at }]), opened_at: iso(at), last_at: iso(at), closes_at: null, closed_at: iso(at), handoff_id: handoffIdFor(`once-per:${placed.into.once_per}`), once_per: placed.into.once_per };
        if (!ledger.members.some(member => member.id === item.id)) {
          const members = [...ledger.members, memberOf(item)];
          eeaf.write([{ id, type: KIND, value: { ...ledger, members, ...spanOf(members), last_at: iso(at) } }], { actor: actorOf(item), unwatched: true });
        }
        return { once_per: placed.into.once_per, job: fill(rows.words.same_words_job, { route: placed.into.route, message_id: placed.into.message_id }) };
      }
      const placed = momentOf(item, openMoments(), rows, { handoffOpen });
      if (placed.action === 'open') {
        const id = momentIdOf(item.id);
        if (!eeaf.read(id)) eeaf.write([{ id, type: KIND, value: opened(item, placed.row, at) }], { actor: actorOf(item), unwatched: true });
        // Too many open at once: the oldest close early (handed off as they are), none is forgotten.
        const stillOpen = openMoments().filter(moment => !moment.closed_at && moment.id !== id).sort((a, b) => Date.parse(a.opened_at) - Date.parse(b.opened_at));
        const early = stillOpen.slice(0, Math.max(0, stillOpen.length + 1 - rows.most_open_moments)).map(moment => moment.id);
        closeAll(early, at);
        keepIds([...new Set([...openIds(), id])], actorOf(item));
        return { moment: id };
      }
      // join: a moment still open gathers silently; one already closed gets its late member through a watched write.
      const moment = eeaf.read(placed.moment_id);
      if (moment.members.some(member => member.id === item.id)) return { moment: placed.moment_id };
      const next = joinedWith(moment, item, placed.row, at);
      if (!placed.late) { eeaf.write([{ id: placed.moment_id, type: KIND, value: next }], { actor: actorOf(item), unwatched: true }); return { moment: placed.moment_id }; }
      const items = new Map([[item.id, item]]);
      const lateSend = jobOf(next, [memberOf(item)], items, rows, { first: false });
      eeaf.write([{ id: placed.moment_id, type: KIND, value: { ...next, send: lateSend, said: moment.said, title: moment.title } }], { actor: actorOf(item) });
      return { moment: placed.moment_id };
    },

    /** The moments whose quiet time ended close now: one watched write each. -> the ids closed. */
    closeDue(at = now().getTime()) {
      const closed = closeAll(due(at, openMoments()), at);
      // A closed moment stays joinable for its row's late_minutes, then leaves the list; an open one never leaves it.
      const kept = openMoments().filter(moment => {
        if (!moment.closed_at) return true;
        const row = rows.rows.find(candidate => candidate.id === moment.row);
        return row && at <= Date.parse(moment.closed_at) + row.late_minutes * MINUTE;
      });
      const stillOpen = kept.filter(moment => !moment.closed_at);
      const joinable = kept.filter(moment => moment.closed_at).sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at)).slice(-rows.most_open_moments);
      keepIds([...stillOpen, ...joinable].map(moment => moment.id), { by: 'trillion', app: 'moments' });
      return closed;
    },

    /** When the next open moment closes (ms), or null; the scheduler's time. */
    nextDue: () => nextDue(openMoments()),
    /** The moments the door holds (open or still joinable), for screens and tests. */
    open: openMoments,
  };
}

/**
 * gather_moment: one moment from kept arrival and asked records between `from` and `until`.
 *   input { from, until, dry_run?, row?, hand_off? }; deps { eeaf, agents, now }.
 * dry_run answers what it would group and write nothing. Real: writes the moment, hands off its one job and closes the
 * members' still-open untaken handoffs as joined into it (agents.foldIntoMoment).
 */
/** POST /moments/gather, answered by whichever store keeps the account's arrivals: a kept moment settles the account's
 *  arrivals so the moment's handoff and its rules run at once. */
// A gather's whole effect is one synchronous write, committed with its answer through `commit` (kept under the command's
// receipt, src/standalone-resource-behavior.mjs routeReceipts); settling the arrivals after it is convergent.
export const MOMENT_RECEIPTED_WRITES = Object.freeze(['moments:gather']);
export async function handleMomentsRequest({ eeaf, agents, settle, commit = change => change() }, request) {
  try {
    const body = await request.json();
    const answer = commit(() => gatherMoment(body, { eeaf, agents }), { operation: 'moments:gather' });
    if (answer.dry_run === false) await settle();
    return Response.json(answer);
  } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
}

export function gatherMoment(input = {}, { eeaf, agents, now = () => new Date(), rows = data }) {
  const parse = (value, name) => { const ms = Date.parse(value); if (!nonempty(value) || Number.isNaN(ms)) throw new Error(`${name} is required: a date and time like 2026-10-08T21:00:00Z`); return ms; };
  const from = parse(input.from, 'from');
  const until = parse(input.until, 'until');
  if (until < from) throw new Error('until is before from.');
  const row = input.row ? rows.rows.find(candidate => candidate.id === input.row) : null;
  if (input.row && !row) throw new Error(`There is no moment row ${input.row}: the rows are ${rows.rows.map(candidate => candidate.id).join(', ')}.`);
  const bound = rows.gather;
  const left = [];
  // A range longer than most_range_minutes is cut at its end (the answer says so); gather the rest with a later range.
  const reach = Math.min(until, from + bound.most_range_minutes * MINUTE);
  if (reach < until) left.push(`The range is longer than ${bound.most_range_minutes} minutes: only up to ${iso(reach)} was looked at. Gather a later range for the rest.`);
  const items = [];
  const arrivals = eeaf.scan('arrival', 'at', { from: iso(from), to: iso(reach), limit: bound.most_arrivals + 1 });
  if (arrivals.length > bound.most_arrivals) left.push(`More than ${bound.most_arrivals} arrivals were kept in that time; only the first ${bound.most_arrivals} were looked at.`);
  for (const entry of arrivals.slice(0, bound.most_arrivals)) {
    const value = eeaf.read(entry.id);
    if (value) items.push(itemOfArrival(entry.id, value));
  }
  const asked = eeaf.scan('asked', 'at', { from: iso(from), to: iso(reach), limit: bound.most_asked + 1 });
  if (asked.length > bound.most_asked) left.push(`More than ${bound.most_asked} asked records were kept in that time; only the first ${bound.most_asked} were looked at.`);
  for (const entry of asked.slice(0, bound.most_asked)) {
    const value = eeaf.read(entry.id);
    if (value) items.push(itemOfAsked(entry.id, value));
  }
  // Jobs handed out before any index led to their record (a recording asked about before asked.at existed, say): the open
  // untaken jobs handed in the range (and a little after), each seen through its own input.arrived.
  const heldBack = new Set(items.flatMap(item => [item.id, item.message_id]));
  const earlier = rows.earlier_handoffs;
  const sought = agents.openHandedBetween(iso(from - 1), iso(reach + earlier.handed_within_minutes * MINUTE), earlier.most);
  for (const handoff of sought.handoffs) {
    const item = itemOfHandoff(handoff);
    if (!item || heldBack.has(item.id) || heldBack.has(item.message_id)) continue;
    const when = Date.parse(item.at);
    if (!(when >= from && when <= reach)) continue;
    items.push(item);
    heldBack.add(item.id); heldBack.add(item.message_id);
  }
  if (sought.more) left.push(`More than ${earlier.most} open jobs were handed in that time; only the first ${earlier.most} were looked at.`);
  // The same range asked again is the moment it already made: its stored members stand (the ones folded or finished since
  // are no longer seen in the records, but are still members), its job text is never sent again, and only a member that
  // was not in it joins, as a late addition.
  const idOf = rowId => momentIdOf(`${iso(from)}|${iso(until)}|${rowId}`);
  const known = (row ? [row] : rows.rows).map(candidate => ({ candidate, id: idOf(candidate.id) })).map(found => ({ ...found, moment: eeaf.read(found.id) })).find(found => found.moment && nonempty(found.moment.handoff_id));
  if (known) return gatherAgain(known, items, { input, left, eeaf, agents, now, rows });
  const first = gathered(items, rows, row);
  const empty = { dry_run: input.dry_run === true, grouped: 0, members: [], ...(left.length ? { left } : {}), note: 'Nothing between those times belongs to a moment under the rows of moments.json.' };
  if (!first) return empty;
  // The gathered moment is named by what was asked for, never by its first member, so it cannot overwrite a moment that
  // is live (its first arrival may belong to one): the same call again is the same moment.
  const id = momentIdOf(`${iso(from)}|${iso(until)}|${first.row.id}`);
  const elsewhere = items.filter(item => nonempty(item.moment) && item.moment !== id);
  if (elsewhere.length) left.push(`${elsewhere.length} already belong to another moment and were left in it: ${elsewhere.map(item => `${item.id} (${item.moment})`).join(', ')}.`);
  const second = gathered(items.filter(item => !elsewhere.includes(item)), rows, first.row);
  if (!second) return { ...empty, ...(left.length ? { left } : {}) };
  // The row's own limits hold here too: a span longer than most_span_minutes, then more than most_members, are cut from the end.
  const limit = second.row;
  const start = Date.parse(second.items[0].at);
  const inSpan = second.items.filter(item => Date.parse(item.at) - start <= limit.most_span_minutes * MINUTE);
  const inCount = inSpan.slice(0, limit.most_members);
  const cut = second.items.filter(item => !inCount.includes(item));
  if (cut.length) left.push(`${cut.length} were left out because a moment holds at most ${limit.most_members} members over ${limit.most_span_minutes} minutes (${limit.id}): ${cut.map(item => item.id).join(', ')}. Gather a later range for them.`);
  const gaps = inCount.slice(1).map((item, at) => minutes(Date.parse(item.at) - Date.parse(inCount[at].at)));
  const found = { row: limit, items: inCount, longest_gap_minutes: gaps.length ? Math.max(...gaps) : 0 };
  const members = found.items.map(memberOf);
  const later = Date.parse(found.items.at(-1).at);
  const base = { ...opened(found.items[0], found.row, later), members, files: unionFiles(members), ...spanOf(members), closes_at: iso(later) };
  const itemsById = new Map(found.items.map(item => [item.id, item]));
  const moment = closing({ id, ...base }, itemsById, now().getTime(), rows);
  const keys = [...new Set(found.items.flatMap(item => [item.message_id, item.id]))];
  const preview = {
    moment_id: id, row: found.row.id, title: moment.title, grouped: members.length, from: moment.from, until: moment.until,
    longest_gap_minutes: Number(found.longest_gap_minutes.toFixed(1)), members: members.map(member => ({ id: member.id, kind: member.kind, message_id: member.message_id, route: member.route, at: member.at })),
    files: (moment.files ?? []).map(fileLabel), job_length: moment.send.length,
  };
  if (input.dry_run === true) return { dry_run: true, ...preview, ...(left.length ? { left } : {}), would_fold: agents.openHandoffsFor(keys, id).map(handoff => handoff.handoff_id) };
  // The earlier job of the same moment (a repeat of this call) stays one job: the handoff is once_per the moment id.
  eeaf.write([{ id, type: KIND, value: stripId(moment) }], { actor: { by: 'person', app: 'gather_moment' }, unwatched: true });
  const handed = agents.handOff(handoffOf({ id, ...moment }));
  // At most most_folds jobs are closed per call; a repeat of the call folds the next ones (the moment and its job stay one).
  const folded = agents.foldIntoMoment({ keys: keys.slice(0, bound.most_folds * 2), moment_id: id, handoff_id: handed.handoff.handoff_id });
  if (keys.length > bound.most_folds * 2) left.push(`Only the open jobs of the first ${bound.most_folds * 2} message and record ids were folded; call gather_moment again with the same range to fold the rest.`);
  return { dry_run: false, ...preview, ...(left.length ? { left } : {}), handoff_id: handed.handoff.handoff_id, repeated: handed.repeated === true, folded };
}

// A repeat of a gather: -> the stored moment and its handoff as they are, with any new member joined (never the whole job text again).
function gatherAgain({ candidate, id, moment }, items, { input, left, eeaf, agents, now, rows }) {
  const have = new Set(moment.members.flatMap(member => [member.id, member.message_id]));
  const elsewhere = items.filter(item => nonempty(item.moment) && item.moment !== id);
  const wanted = (gathered(items.filter(item => !elsewhere.includes(item)), rows, candidate)?.items ?? []).filter(item => !have.has(item.id) && !have.has(item.message_id));
  const room = Math.max(0, candidate.most_members - moment.members.length);
  const start = Date.parse(moment.from);
  const fresh = wanted.filter(item => Date.parse(item.at) - start <= candidate.most_span_minutes * MINUTE).slice(0, room);
  if (wanted.length > fresh.length) left.push(`${wanted.length - fresh.length} were left out because a moment holds at most ${candidate.most_members} members over ${candidate.most_span_minutes} minutes (${candidate.id}): ${wanted.filter(item => !fresh.includes(item)).map(item => item.id).join(', ')}.`);
  const listed = list => list.map(member => ({ id: member.id, kind: member.kind, message_id: member.message_id, route: member.route, at: member.at }));
  const report = {
    exists: true, moment_id: id, row: candidate.id, title: moment.title, grouped: moment.members.length, from: moment.from, until: moment.until,
    members: listed(moment.members), files: (moment.files ?? []).map(fileLabel), handoff_id: moment.handoff_id,
    note: 'This range was already gathered into this moment; its job is not sent again.',
  };
  if (input.dry_run === true) return { dry_run: true, ...report, would_join: listed(fresh.map(memberOf)), ...(left.length ? { left } : {}) };
  if (!fresh.length) return { dry_run: false, ...report, repeated: true, joined: 0, folded: [], ...(left.length ? { left } : {}) };
  const members = [...moment.members, ...fresh.map(memberOf)];
  const itemsById = new Map(items.map(item => [item.id, item]));
  const grown = { ...moment, members, files: unionFiles(members), ...spanOf(members), last_at: iso(now().getTime()) };
  grown.title = grown.said = titleOf(grown, itemsById, rows);
  // The stored first job stays as sent; only the late addition's own words go to the handoff (agents.joined appends them).
  const late = jobOf(grown, fresh.map(memberOf), itemsById, rows, { first: false });
  eeaf.write([{ id, type: KIND, value: stripId(grown) }], { actor: { by: 'person', app: 'gather_moment' }, unwatched: true });
  const handed = agents.handOff(handoffOf({ id, ...grown, send: late }));
  const folded = agents.foldIntoMoment({ keys: [...new Set(fresh.flatMap(item => [item.message_id, item.id]))], moment_id: id, handoff_id: handed.handoff.handoff_id });
  return { dry_run: false, ...report, title: grown.title, grouped: members.length, members: listed(members), files: grown.files.map(fileLabel), repeated: true, joined: fresh.length, folded, ...(left.length ? { left } : {}) };
}

// The tool the person's AIs run to re-gather what was already kept (POST MOMENTS_PATH).
export function momentTools(call) {
  return [{
    name: 'gather_moment',
    description: 'Gathers the photos, screenshots, voice memos and camera clips (and recordings asked about) that were kept between from and until (ISO times) into ONE moment with one job, using the rows of moments.json, and closes the still-open untaken jobs those items each had as joined into it. The job lists every member, names every sound or video file to hear first, and ends with a pointer to every message and file. Gaps inside the range are ignored (naming the range says it is one moment); the answer reports the longest. With dry_run true nothing is written and the answer says what would be grouped and which open jobs would be folded. Optional row: the id of the moments.json row to gather. The same call again returns the same job.',
    inputSchema: { type: 'object', required: ['from', 'until'], properties: { from: { type: 'string' }, until: { type: 'string' }, dry_run: { type: 'boolean' }, row: { type: 'string' } } },
    run: input => call(MOMENTS_PATH, input),
  }];
}
export const momentAnnotations = {
  gather_moment: { title: 'Gather what came together into one moment', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
