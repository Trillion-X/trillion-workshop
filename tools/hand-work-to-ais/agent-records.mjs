// src/agent-records.mjs
//
// Purpose: the agents store (src/agents.mjs makeAgents) kept as records of the person's record store, so a card, a
// handoff, a delivery and a delivery secret are each one record and a write is one log row (parts/record-log), never a
// table row plus one index entry per question asked of it. On a large store the handoff table alone kept 12 indexes,
// so one hand-off wrote 13 rows and every update rewrote most of them.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The interface is the one makeAgents takes (src/agents.mjs header): every call answers what the memory store and
//      the table store answer, in the same order.
//   2. What a record is found by is kept beside it, under FOUND_BY, from the record alone (foundBy): a fact with no value
//      is '' so "has none" is a value an index holds (an index entry exists only for values). The questions themselves are
//      DATA in src/record-indexes.json, read as scans of those facts; nothing here reads every record of a kind to answer one.
//   3. Within one transaction(fn) the records written are kept in memory and written as ONE log row when fn returns
//      (group commit); a read of one record sees them, and a scan writes them first, so no question misses a write.
//   4. A record id is its kind's type, a colon and the id the interface uses, so kinds never collide (an agent's card
//      and its delivery secret share the agent's id).
//   5. The reconciler's due work is read from the review index alone (dueReviews), and where its last slice of open work
//      ended is one small record (`agent-review-mark:reconcile`, reviewMark / putReviewMark), written only when it moves.
//   6. The scheduler asks for the earliest due time of the reconciler (nextReviewAt) and of the own-AI routing (scheduledWake)
//      on every arm, so neither reads work whole: nextReviewAt takes the MIN of the review_ready index (work waiting on
//      nothing, then the few jobs that wait on other work, each checked with only its own body); the own-AI clock reads
//      the wake timing index, which orders each open job by a time it is never due before (wake_from) per addressee and priority
//      and carries the facts its due time is worked out from, so bodies are read for no job at all. Both are kept in the
//      one write path (FOUND), so a job taken or finished leaves them with the write that took or finished it. Handoffs
//      written before the wake facts existed get them from a bounded step (WAKE_STEP open jobs a call, its place the
//      record `agent-review-mark:wake-capability-facts`), and until that step is done, or while any open job is still unmoved from a
//      table, scheduledWake says it is not ready and the caller reads open work as before: never a missed wake.
//      Work the own AIs can never take (wakeFactsOf: too deep, or in the way of a kind it is not for) holds no wake
//      entry, so the clock never walks it; work written before that is taken out by the same kind of step (the record
//      `agent-review-mark:wake-parked`), which does not hold the index back from use. The same pass gives every open job
//      review_depends, so nextReviewAt reads review_next, which leaves out reviews waiting on work still open: walking that work
//      is the cost of a store with many such jobs, and the write that finishes what it waits on writes it again. Taken work
//      still has its hold expiry reviewed even if a prerequisite reopens. The review-hold-facts mark replaces wake-parked,
//      whose completed pass could have left taken work with no review entry.
//
// Shapes
//   agentRecordStore({ records, transaction, now }) -> the store makeAgents takes, plus
//     savedInstructions / putSavedInstructions are the caller's (spread them in)
//   AGENT_RECORD_TABLES                             the tables the table store kept, as rows src/tables-into-records.mjs
//                                                   moves into these records
//

import { handoffProjection, projectHandoff, pathPresent, taskMapHandoff, TASK_MAP_FIELDS } from './handoff-projection.mjs';
import { MAX_PRIORITY, MAX_PULLED, reviewOf, scheduledHandoffOf, takeFactsOf, wakeFactsOf } from './agents.mjs';
import { WorkFailure } from './failure.mjs';
import { keepContentJson, readContentJson } from '../parts/serialized-content/do-work/content-json.mjs';
import { SOURCE_RESULT_CONTENT, SOURCE_RESULT_JSON } from './handoff-result-source.mjs';
import { needsOf } from './own-ais.mjs';

export class NotificationIndexBuilding extends WorkFailure {
  constructor() {
    super('service-busy', 'Your work notifications are catching up with saved results. Please try again shortly.');
    this.notification_index_building = true;
  }
}

export const FOUND_BY = 'found_by';
const ACTOR = { actor: { by: 'trillion' } };
// Logical content fields share the sealed scalar payload owner; metadata never opens them.
const CONTENT_FIELDS = { result: 'result_record', corrections: 'corrections_record' };
const SOURCE_FINISH_CORRECTIONS = Symbol('source-finish-corrections');
const DUE_PAGE = 50;
// How many review entries one look at the review index takes.
const REVIEW_PAGE = 32;
// The values of the `wake_timing` index in the order src/record-indexes.json lists its paths (all but `open` are found_by facts).
const WAKE_PATHS = ['open', 'wake_to', 'rank', 'wake_from', 'handoff_id', 'handed_at', 'state', 'taken_by', 'generation', 'hold_until',
  'in_the_way', 'in_the_way_by', 'in_the_way_at', 'blocked_kind', 'depth', 'source_id', 'active_at', 'silence', 'from_person', 'prefer_until', 'needs'];
// How many open jobs one call checks for complete wake facts, and the record keeping where the step ended. The capability
// mark is separate from earlier facts: a completed older mark cannot conceal missing origin or execution needs.
const WAKE_STEP = 64;
const WAKE_MARK = 'wake-capability-facts';
// The same for parked wake work and review membership derived from reviewOf. The old wake-parked mark cannot certify
// these facts: taken work waiting on a reopened prerequisite could have been removed from the hold-expiry index.
const PARKED_MARK = 'review-hold-facts';
// The same for the take facts, and how many entries of a bounded view of them one take reads: the jobs ready for any agent
// by the time (a chat's work whose silence window has ended, a hold that has run out) in the order they became so.
const TAKE_MARK = 'take-facts';
const TAKE_RIPE = 32;
// The same for the reader fact (to_reader): who reads the card a waiting job is addressed to, so a connecting reader's
// greeting is one range of one index and never one look at each of the reader's cards (716 on one large store).
const READER_MARK = 'to-reader-facts';
// The same for the ids of the jobs a job waits on, so the jobs waiting on one job are found without reading every job that waits on any.
const DEPENDS_MARK = 'dependency-facts';

const KIND = { card: 'agent-card', handoff: 'agent-handoff', held: 'agent-held-work', heldState: 'agent-held-work-state', scheduleState: 'agent-schedule-state', delivery: 'agent-delivery', secret: 'agent-delivery-secret', reviewMark: 'agent-review-mark' };
// The one record keeping where the reconciler's last slice of open work ended (src/agents.mjs reconcile).
const REVIEW_MARK = 'reconcile';
const DUE_REVIEW_MARK = 'due-review-search';
const NEXT_REVIEW_MARK = 'next-review-search';
// What Home's workstreams card draws of a job (src/agents.mjs aiWork fields=home), when the home index cannot say.
const HOME_FIELDS = ['state', 'in_the_way', 'parent_handoff_id', 'handed_at', 'from_agent', 'said', 'finished_at'];
const keyOf = (kind, id) => `${KIND[kind]}:${id}`;
const idOf = (kind, key) => key.slice(KIND[kind].length + 1);
const blank = value => value ?? '';

// What each kind is found by, from the record alone (invariant 2).
const FOUND = {
  card: card => ({ reader: blank(card.reader), takes_work: card.takes_work ? 1 : 0, source_id: blank(card.source_id), reaches: card.delivery ? 1 : 0 }),
  handoff: (item, toReader = '') => {
    const review = reviewOf(item);
    return {
      open: item.state === 'finished' ? 0 : 1, handed_at: item.handed_at, state: item.state,
      to_agent: blank(item.to_agent), taken_by: blank(item.taken_by),
      // The reader of the card a waiting job is addressed to, while that card takes work (the greeting's one range).
      ...(toReader && item.state === 'open' ? { to_reader: toReader } : {}),
      // Highest priority first is the lowest rank, so a range in key order is the order work is taken in.
      rank: MAX_PRIORITY - (item.priority ?? 0),
      source_id: blank(item.input?.arrived?.source_id),
      needs: JSON.stringify(needsOf(item)),
      prefer_until: item.target?.strict === false ? blank(item.target.prefer_until) : '',
      // Whether it waits on other work: the few open jobs that do are read to find the ones waiting on one job.
      depends: item.depends_on?.length ? 1 : 0,
      dep_ids: (item.depends_on ?? []).join(' '),
      // The earliest review follows reviewOf: taken work's hold expiry waits on nothing, even when a prerequisite reopens.
      // Only a review that itself waits on unfinished work holds no entry; finishing that work writes its dependents again.
      review_checked: 1,
      ...(item.waits_open && review.waits_on.length ? {} : { review_depends: review.waits_on.length ? 1 : 0 }),
      ...(review.review_at === null ? {} : { review_at: review.review_at }),
      // What the own-AI clock weighs to know when it is due (wakeFactsOf): none once finished, so it leaves that index.
      ...wakeFactsOf(item),
      // What a take of work addressed to nobody weighs (takeFactsOf): the first job an agent may take is one index read.
      ...takeFactsOf(item),
    };
  },
  delivery: item => ({ agent_id: item.agent_id, subject_id: item.event?.subject_id ?? '', state: item.state, next_at: blank(item.next_at), created_at: blank(item.created_at) }),
  secret: () => ({}),
  reviewMark: () => ({}),
  held: () => ({}),
  heldState: () => ({}),
  scheduleState: () => ({}),
};

// The tables the table store kept (src/person-store.mjs before the record engine), each row as its record: what
// src/tables-into-records.mjs moves. `first` names the rows the store needs from the first call (cards, secrets, open
// work and events still to send); the rest follow a batch at a time.
export const AGENT_RECORD_TABLES = [
  { table: 'agent_cards', first: '1 = 1', recordOf: row => recordOf('card', row.agent_id, JSON.parse(row.value)) },
  { table: 'agent_delivery_secrets', first: '1 = 1', recordOf: row => recordOf('secret', row.agent_id, { secret: row.secret }) },
  { table: 'agent_handoffs', first: 'open = 1', recordOf: row => recordOf('handoff', row.handoff_id, JSON.parse(row.value)) },
  { table: 'agent_deliveries', first: "state = 'waiting'", recordOf: row => recordOf('delivery', row.event_id, JSON.parse(row.value)) },
];

function recordOf(kind, id, value, toReader) {
  const kept = { ...value, [FOUND_BY]: FOUND[kind](value, toReader) };
  return { id: keyOf(kind, id), type: KIND[kind], value: kept };
}
const plainValueOf = stored => {
  if (stored === null || stored === undefined) return null;
  const { [FOUND_BY]: _found, schedule: _schedule, result_record: _resultRecord, corrections_record: _correctionsRecord, result_json, ...value } = stored;
  if (typeof result_json === 'string') value.result = JSON.parse(result_json);
  return value;
};
// Two index entries in the order their values and ids sort as keys (values compared as JSON text, then ids).
const entryOrder = (a, b) => {
  for (let index = 0; index < Math.max(a.values.length, b.values.length); index += 1) {
    const left = JSON.stringify(a.values[index]);
    const right = JSON.stringify(b.values[index]);
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
const pageOf = limit => (Number.isFinite(limit) && limit >= 0 ? limit : Infinity);

export function agentRecordStore({ records, transaction = fn => fn(), firstRows = () => [], heldSummaryReady = () => true, cardsMoving = () => true }) {
  // Records written inside one transaction(fn), written as one log row when it returns (invariant 3).
  let pending = null;
  let pendingRetractions = null;
  // Complete source answers are a separate record in the same transaction. The handoff's admission body stays
  // small on both engines; only an ordinary result read opens its payload. Never expose physical references.
  const resultKey = id => `agent-handoff-result:${id}`;
  const historyKey = id => `agent-handoff-result:${id}:corrections`;
  const valueOf = (stored, contents = null) => {
    const value = plainValueOf(stored);
    if (value) for (const [field, reference] of Object.entries(CONTENT_FIELDS)) {
      if (typeof stored[reference] !== 'string') continue;
      const payload = pending?.has(stored[reference]) ? pending.get(stored[reference]).value
        : contents ? contents.get(stored[reference]) : records.read(stored[reference]);
      if (!payload || typeof payload.json !== 'string') throw new Error('Saved handoff content is unavailable');
      value[field] = readContentJson(payload);
    }
    return value;
  };
  let reviewCache = null;
  let deliveryDueCache = null;
  // Every card, asked for by each open-work page and each notice read (one large store: 809 cards, about 27,000 rows a
  // read). Kept with the record journal's number it was read at; a later read re-reads only the cards written since
  // (records.changedSince), and everything again when the journal cannot say (a rollback, or past what it keeps) or,
  // while the table move may still bring cards in (`cardsMoving`), when it has brought rows in (its load progress
  // changed), since that writes past the journal. Once the cards have moved, the move's later loads (open work and
  // deliveries, every few seconds) leave the kept cards alone.
  let cardsKept = null;
  const keptCards = () => {
    if (typeof records.changeSeq !== 'function') return records.ids(KIND.card).map(key => valueOf(records.read(key))).filter(Boolean);
    const loaded = cardsMoving() ? JSON.stringify(records.logStore?.().loadProgress?.() ?? null) : null;
    const changed = cardsKept?.loaded === loaded ? records.changedSince(cardsKept.seq) : null;
    const seq = records.changeSeq();
    if (!changed) {
      cardsKept = { seq, loaded, byKey: new Map(records.ids(KIND.card).map(key => [key, valueOf(records.read(key))]).filter(([, card]) => card)) };
    } else {
      for (const key of changed) {
        if (!key.startsWith(`${KIND.card}:`)) continue;
        const card = valueOf(records.read(key));
        if (card) cardsKept.byKey.set(key, card); else cardsKept.byKey.delete(key);
      }
      cardsKept.seq = seq;
    }
    return [...cardsKept.byKey.keys()].sort().map(key => structuredClone(cardsKept.byKey.get(key)));
  };
  const flush = () => {
    if (!pending?.size) return;
    const retiring = [...pendingRetractions].filter(id => !pending.has(id));
    const types = typeof records.typesOf === 'function' ? records.typesOf(retiring)
      : new Map(retiring.map(id => [id, records.typeOf(id)]));
    for (const id of retiring) if (types.get(id) !== null)
      pending.set(id, { id, type: 'agent-handoff-result', value: null });
    pendingRetractions.clear();
    const batch = [...pending.values()];
    pending.clear();
    records.write(batch, ACTOR);
  };
  // The reader of the card a waiting job is addressed to, while that card takes work ('' for anything else). A card still
  // in its table is not read here: the reader facts are only kept (and only trusted) once the cards are records.
  const readerOf = item => {
    if (item.state !== 'open' || !item.to_agent) return '';
    const card = read('card', item.to_agent);
    return card?.takes_work && card.reader ? card.reader : '';
  };
  const put = (kind, id, value) => {
    const sourceCorrections = kind === 'handoff' ? value[SOURCE_FINISH_CORRECTIONS] : null;
    const sourceResultJson = kind === 'handoff' && value.result_source_receipt && typeof value[SOURCE_RESULT_JSON] === 'string' ? value[SOURCE_RESULT_JSON] : null;
    const sourceResultContent = kind === 'handoff' && value.result_source_receipt && value[SOURCE_RESULT_CONTENT] && typeof value[SOURCE_RESULT_CONTENT] === 'object' ? value[SOURCE_RESULT_CONTENT] : null;
    const { [SOURCE_FINISH_CORRECTIONS]: _sourceFinishCorrections, [SOURCE_RESULT_JSON]: _sourceResultJson, [SOURCE_RESULT_CONTENT]: _sourceResultContent, ...storedValue } = value;
    const record = recordOf(kind, id, storedValue, kind === 'handoff' ? readerOf(value) : undefined);
    const batch = [record];
    if (kind === 'handoff') {
      const keptCorrections = sourceCorrections === historyKey(id) && records.typeOf(sourceCorrections) === 'agent-handoff-result'
        ? sourceCorrections : null;
      const payloadId = resultKey(id);
      if (value.result_source_receipt && value.result !== null && value.result !== undefined) {
        record.value.result_record = payloadId;
        record.value.result = null;
        batch.push({ id: payloadId, type: 'agent-handoff-result', value: sourceResultContent ?? keepContentJson(sourceResultJson ?? JSON.stringify(value.result)) });
        pendingRetractions?.delete(payloadId);
      } else if (pending?.get(payloadId)?.value || (!pending && records.typeOf(payloadId) !== null)) {
        batch.push({ id: payloadId, type: 'agent-handoff-result', value: null });
      } else pendingRetractions?.add(payloadId);
      const correctionId = historyKey(id);
      if (Array.isArray(value.corrections) && value.corrections.length) {
        record.value.corrections_record = correctionId;
        delete record.value.corrections;
        batch.push({ id: correctionId, type: 'agent-handoff-result', value: keepContentJson(JSON.stringify(value.corrections)) });
        pendingRetractions?.delete(correctionId);
      } else if (keptCorrections === correctionId) {
        // A verified source finish deliberately did not open the potentially large history body.
        // Carry forward only the owner-validated content reference; ordinary clears still tombstone it.
        record.value.corrections_record = correctionId;
        delete record.value.corrections;
        pendingRetractions?.delete(correctionId);
      } else if (pending?.get(correctionId)?.value || (!pending && records.typeOf(correctionId) !== null)) {
        batch.push({ id: correctionId, type: 'agent-handoff-result', value: null });
      } else pendingRetractions?.add(correctionId);
    }
    if (pending) for (const entry of batch) pending.set(entry.id, entry);
    else records.write(batch, ACTOR);
  };
  const read = (kind, id) => {
    const key = keyOf(kind, id);
    if (pending?.has(key)) return structuredClone(valueOf(pending.get(key).value));
    return valueOf(records.read(key));
  };
  const fromFirstRows = (table, options) => firstRows(table, options).map(record => valueOf(record.value));
  const oldCards = () => fromFirstRows('agent_cards', { limit: Infinity });
  const scan = (kind, name, options) => { flush(); return records.scan(KIND[kind], name, options).map(entry => ({ ...entry, id: idOf(kind, entry.id) })); };
  const scanSelectedValues = (kind, name, options) => { flush(); return records.scanSelectedValues(KIND[kind], name, options).map(entry => ({ ...entry, id: idOf(kind, entry.id) })); };
  // Selected roots use the record owner's existing identity and value-byte bounds.
  // Reconstruct entry order here: Map deduplication must not remove a caller's
  // duplicate entries or make their nested outward values share one object.
  const readAll = (kind, entries, { pointReads = false } = {}) => {
    if (typeof records.readMany !== 'function') return entries.map(entry => read(kind, entry.id)).filter(Boolean);
    const keys = entries.map(entry => keyOf(kind, entry.id));
    const stored = keys.filter(key => !pending?.has(key));
    const found = stored.length ? (pointReads ? records.readMany(stored, { pointReads: true }) : records.readMany(stored)) : new Map();
    // Results and correction histories are sealed content records. Read only the
    // selected roots' references together, under readMany's existing bounds;
    // transaction-local payloads still take precedence over stored content.
    const references = new Set();
    for (const key of keys) {
      const raw = pending?.has(key) ? pending.get(key).value : found.get(key);
      if (!raw) continue;
      for (const reference of Object.values(CONTENT_FIELDS)) {
        const id = raw[reference];
        if (typeof id === 'string' && !pending?.has(id)) references.add(id);
      }
    }
    const contents = references.size ? records.readMany([...references]) : new Map();
    const seen = new Set();
    return entries.map((entry, at) => {
      const key = keys[at];
      if (pending?.has(key)) return structuredClone(valueOf(pending.get(key).value, contents));
      const raw = found.get(key);
      const value = valueOf(seen.has(key) ? structuredClone(raw) : raw, contents);
      seen.add(key);
      return value;
    }).filter(Boolean);
  };
  const readScheduled = entries => {
    const fields = records.fields?.fieldsOf?.(KIND.handoff, entries.map(entry => keyOf('handoff', entry.id)), ['schedule']) ?? new Map();
    return entries.map(entry => {
      const value = fields.get(keyOf('handoff', entry.id))?.schedule;
      if (value) return JSON.parse(value);
      const item = read('handoff', entry.id);
      return item ? scheduledHandoffOf(item) : null;
    }).filter(Boolean);
  };
  // Notices are capped after origin eligibility and ordered by the event the person sees, not when the job was
  // handed off. These indexes use existing fields, so already-kept results need no handoff rewrite. Only index
  // metadata identifies eligible sender groups without walking excluded history; at most `limit` bodies are read.
  const notificationWork = ({ limit, since, exclude_from = [] }) => {
    if (['notice_waiting', 'notice_taken', 'notice_finished'].some(name => !records.indexReady(KIND.handoff, name))) throw new NotificationIndexBuilding();
    const size = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 0;
    if (!size) return [];
    const excluded = new Set(exclude_from);
    const newest = (name, state, after) => {
      const found = [];
      let last = null;
      for (;;) {
        const options = { reverse: true, limit: size };
        const page = last ? scan('handoff', name, {
          ...options, equal: last.values, idTo: keyOf('handoff', last.id),
        }) : [];
        if (last && page.length < size) page.push(...scan('handoff', name, {
          ...options, equal: last.values.slice(0, 2), before: last.values[2], limit: size - page.length,
        }));
        if (page.length < size) page.push(...scan('handoff', name, {
          ...options, equal: [state], ...(after ? { after } : {}),
          ...(last ? { before: last.values[1] } : {}), limit: size - page.length,
        }));
        if (!page.length) break;
        for (const entry of page) if (!excluded.has(entry.values[2])) found.push(entry);
        if (found.length >= size || page.length < size) break;
        last = page.at(-1);
      }
      return found.slice(0, size);
    };
    // Origin-first indexes let the record owner jump over excluded groups. For each remaining group only its
    // newest entry is discovered; groups whose head cannot enter the page are never paged or hydrated.
    const newestEligible = (name, state, after) => {
      const originName = `${name}_origin`;
      flush();
      const canonical = entry => ({ ...entry, id: idOf('handoff', entry.id), values: [entry.values[0], entry.values[2], entry.values[1]] });
      const heads = records.lastPerGroup(KIND.handoff, originName, { equal: [state], exclude: exclude_from })
        .map(canonical).filter(entry => !after || entry.values[1] > after).sort((a, b) => -entryOrder(a, b));
      let found = [];
      for (const head of heads) {
        if (found.length >= size && entryOrder(head, found.at(-1)) <= 0) break;
        const page = scan('handoff', originName, { equal: [state, head.values[2]], ...(after ? { after } : {}), reverse: true, limit: size })
          .map(entry => ({ ...entry, values: [entry.values[0], entry.values[2], entry.values[1]] }));
        found = [...found, ...page].sort((a, b) => -entryOrder(a, b)).slice(0, size);
      }
      return found;
    };
    // Keep the already-complete notification read available while this separate bounded projection builds.
    const originsReady = excluded.size && ['notice_waiting_origin', 'notice_taken_origin', 'notice_finished_origin']
      .every(name => records.indexReady(KIND.handoff, name));
    const select = originsReady ? newestEligible : newest;
    const selected = [
      ...select('notice_waiting', 'open'),
      ...select('notice_taken', 'taken'),
      ...select('notice_finished', 'finished', since),
    ].sort((a, b) => String(b.values[1]).localeCompare(String(a.values[1])) || a.id.localeCompare(b.id)).slice(0, size);
    // A cold feed reads its selected bodies together. One lookup per job repeats page-fence seeks as the kept
    // history grows; the record owner already bounds grouped reads by both identities and selected value bytes.
    return readAll('handoff', selected);
  };
  // A progress line needs child identities, not their instructions or results. Parent membership, child identity and
  // order are already current index facts; mutations and removals update these keys in the same record write.
  const handedOnMetadataFromMany = ids => {
    const groups = new Map([...new Set(ids)].map(id => [id, []]));
    if (!groups.size) return groups;
    flush();
    for (const entry of records.scanFirstValues(KIND.handoff, 'parent', [...groups.keys()])) {
      groups.get(entry.values[0])?.push({ handoff_id: idOf('handoff', entry.id), handed_at: entry.values[1] });
    }
    return groups;
  };
  // Open work in the order it is taken: each entry as { id, values: [rank, handed_at] } (highest priority, then oldest).
  const taken = entries => entries.map(entry => ({ id: entry.id, values: entry.values.slice(-2) }));
  const inTakingOrder = lists => lists.flat().sort(entryOrder);
  // Addressed to `to_agent`, or with none, the work any agent may take (addressed to nobody, or only preferred until a
  // time already past).
  // The work addressed to an agent only until a time now past (strict: false), as entries in the order it is taken.
  const preferredEntries = nowIso => scan('handoff', 'preferred', { equal: [1], after: '', to: nowIso }).map(entry => {
    const found = records.read(keyOf('handoff', entry.id))?.[FOUND_BY];
    return found ? { id: entry.id, values: [found.rank, found.handed_at] } : null;
  }).filter(Boolean);
  // The entries of index `name` under `equal` whose last two values and id ([rank, handed_at], id) come after `mark`
  // ({ id, rank, handed_at }, or null for the first), in key order, at most `limit`: three bounded ranges, never the
  // whole index read to find where a page starts.
  const afterMark = (name, equal, mark, limit) => {
    if (!mark) return scan('handoff', name, { equal, limit });
    const tied = scan('handoff', name, { equal: [...equal, mark.rank, mark.handed_at], idFrom: `${keyOf('handoff', mark.id)}\0`, limit });
    const same = tied.length < limit ? scan('handoff', name, { equal: [...equal, mark.rank], after: mark.handed_at, limit: limit - tied.length }) : [];
    const rest = tied.length + same.length < limit ? scan('handoff', name, { equal, after: mark.rank, limit: limit - tied.length - same.length }) : [];
    return [...tied, ...same, ...rest];
  };
  // Only the page after `mark` is read from the queue index: a take pages through the queue a few jobs at a time, and
  // reading the whole addressed queue for every page made a take cost pages x jobs (2026-10-10: 19,700 rows a take).
  const queueEntries = (to_agent, nowIso, mark = null, limit = Infinity) => {
    const legacy = fromFirstRows('agent_handoffs', { where: 'open = 1', orderBy: 'handed_at, handoff_id', limit: 100000 })
      .filter(item => to_agent
        ? item.to_agent === to_agent
        : !item.to_agent || (item.target?.strict === false && (item.target.prefer_until ?? '') <= nowIso))
      .map(item => ({ id: item.handoff_id, values: [MAX_PRIORITY - (item.priority ?? 0), item.handed_at], item }));
    const queued = taken(afterMark('queue', [1, to_agent || ''], mark, limit));
    return inTakingOrder(to_agent ? [queued, legacy] : [queued, preferredEntries(nowIso), legacy]);
  };
  const tupleAfter = (entry, mark) => entryOrder(entry, mark) > 0;
  const needsContent = (selected, field) => selected.fields.includes(field) || selected.presence.some(path => path[0] === field);
  const physicalSelection = selected => ({ ...selected, fields: [...new Set([...selected.fields,
    ...Object.entries(CONTENT_FIELDS).filter(([field]) => needsContent(selected, field)).map(([, reference]) => reference)])] });
  const logicalProjection = (kept, id, selected) => {
    const decoded = valueOf(kept.fields);
    return projectHandoff({ ...decoded, handoff_id: id, field_presence: selected.presence.map((path, index) =>
      typeof kept.fields[CONTENT_FIELDS[path[0]]] === 'string'
        ? pathPresent(decoded, path) : kept.presence[index]) }, selected);
  };
  const readProjected = (entries, selected) => {
    if (!selected || !records.fields?.projectOf)
      return readAll('handoff', entries).map(item => projectHandoff(item, selected));
    const found = records.fields.projectOf(KIND.handoff, entries.map(entry => keyOf('handoff', entry.id)), physicalSelection(selected));
    return entries.flatMap(entry => {
      const value = found.get(keyOf('handoff', entry.id));
      return value ? [logicalProjection(value, entry.id, selected)] : [];
    });
  };
  // The task map's fields of each job (src/handoff-projection.mjs taskMapHandoff): an entry of an index that carries
  // them answers alone; any other job is read by those fields, never whole (its words and results are the most of it).
  const taskMapOf = (entries, { carried = false, index = null } = {}) => {
    if (!entries.length) return [];
    const keys = entries.map(entry => keyOf('handoff', entry.id));
    const covered = carried && records.indexCovered ? records.indexCovered(KIND.handoff, index, keys) : new Set();
    const missing = keys.filter(key => !covered.has(key));
    if (missing.length && !records.fields?.projectOf) return readAll('handoff', entries).map(taskMapHandoff);
    flush();
    const found = missing.length ? records.fields.projectOf(KIND.handoff, missing, { fields: [...TASK_MAP_FIELDS, 'input'] }) : new Map();
    return entries.flatMap((entry, at) => {
      if (covered.has(keys[at])) {
        const { 'input.arrived.message_id': message_id, 'input.arrived.asked_id': asked_id, ...own } = entry.carried;
        return [taskMapHandoff({ ...own, handoff_id: entry.id, input: { arrived: { message_id, asked_id } } })];
      }
      const value = found.get(keys[at]);
      return value ? [taskMapHandoff({ ...valueOf(value.fields), handoff_id: entry.id })] : [];
    });
  };
  const newestStatePage = (open, { before = null, limit, projection = null } = {}) => {
    const selected = handoffProjection(projection);
    const size = pageOf(limit);
    if (!size) return [];
    const mark = before ? api.handoff(before, { projection: { fields: ['handed_at'] } }) : null;
    if (before && !mark) return [];
    // Both halves are bounded, even when thousands of jobs share one timestamp.
    const tied = mark ? scan('handoff', 'time', { equal: [open, mark.handed_at], idTo: keyOf('handoff', before), reverse: true, limit: size + 1, carried: selected !== null })
      .filter(entry => entry.id !== before).slice(0, size) : [];
    const older = mark ? tied.length < size ? scan('handoff', 'time', { equal: [open], before: mark.handed_at, reverse: true, limit: size - tied.length, carried: selected !== null }) : []
      : scan('handoff', 'time', { equal: [open], reverse: true, limit: size, carried: selected !== null });
    const entries = [...tied, ...older];
    if (!selected || !records.fields?.projectOf)
      return readAll('handoff', entries).map(item => projectHandoff(item, selected));
    const projected = new Map();
    const missing = [];
    for (const entry of entries) {
      const covered = Object.entries(CONTENT_FIELDS).every(([field, reference]) => !needsContent(selected, field) || (typeof entry.carried_defined?.[reference] === 'boolean' && !entry.carried[reference]))
        && selected.fields.every(name => typeof entry.carried_defined?.[name] === 'boolean')
        && selected.presence.every(path => typeof entry.carried_presence?.[JSON.stringify(path)] === 'boolean');
      if (!covered) { missing.push(keyOf('handoff', entry.id)); continue; }
      projected.set(keyOf('handoff', entry.id), {
        fields: { id: keyOf('handoff', entry.id), ...Object.fromEntries(selected.fields.filter(name => entry.carried_defined[name]).map(name => [name, entry.carried[name]])) },
        presence: selected.presence.map(path => entry.carried_presence[JSON.stringify(path)]),
      });
    }
    // A legacy/partial entry, an unsupported field or an object projection uses
    // the existing bounded owner; finished-window selection never refills itself.
    if (missing.length) for (const [id, value] of records.fields.projectOf(KIND.handoff, missing, physicalSelection(selected))) projected.set(id, value);
    return entries.flatMap(entry => {
      const value = projected.get(keyOf('handoff', entry.id));
      return value ? [logicalProjection(value, entry.id, selected)] : [];
    });
  };
  const scheduleRevision = () => read('scheduleState', 'handoffs')?.revision ?? 0;
  // Read one bounded window from an ordered review index. The cursor includes the
  // time and id so an arbitrarily large timestamp tie resumes without skipping.
  const reviewWindow = (index, prefix, cursor, limit, through = null) => {
    const readSame = after => scan('handoff', index, {
      equal: [...prefix, cursor?.review_at ?? ''], ...(after ? { idFrom: `${keyOf('handoff', after)}\0` } : {}),
      limit: limit + (after ? 1 : 0),
    }).filter(entry => !after || entry.id > after).slice(0, limit);
    const same = cursor ? readSame(cursor.id) : scan('handoff', index, { equal: [...prefix, ''], limit });
    const remaining = limit - same.length;
    const later = remaining > 0 ? scan('handoff', index, {
      equal: prefix, after: cursor?.review_at ?? '', ...(through === null ? {} : { to: through }), limit: remaining,
    }) : [];
    return [...same, ...later];
  };
  const heldAgent = item => item?.state !== 'finished' && item?.taken_by ? item.taken_by : null;
  // What counting an agent's slots needs of a job it holds (capacityFor), kept in its held summary so that is one read.
  const holdOf = item => ({ state: item.state, taken_by: item.taken_by, taken_at: item.taken_at ?? null, hold_until: item.hold_until ?? null, hold_minutes: item.hold_minutes ?? null, in_the_way: Boolean(item.in_the_way) });
  const indexedHeldBy = id => readAll('handoff', scan('handoff', 'held', { equal: [1, id] }));
  const heldOrder = (a, b) => a.handed_at.localeCompare(b.handed_at) || a.handoff_id.localeCompare(b.handoff_id);
  const scheduledValue = item => ({ ...item, schedule: JSON.stringify(scheduledHandoffOf(item)) });
  let firstHandoffChecked = false;
  const initializeEmptyHandoffs = () => {
    if (firstHandoffChecked) return;
    firstHandoffChecked = true;
    // The owner writes every dependency fact and hold from the first job onward.
    // Only a proved empty store can certify that without migrating earlier jobs.
    // Keep these marks in the first job's transaction, never on a read or before
    // older handoff tables finish moving.
    if (!heldSummaryReady() || [...(pending?.keys() ?? [])].some(key => key.startsWith(`${KIND.handoff}:`))
      || records.ids(KIND.handoff, { limit: 1 }).length
      || firstRows('agent_handoffs', { limit: 1 }).length) return;
    put('reviewMark', DEPENDS_MARK, { done: true });
    put('heldState', 'active', { enabled: true });
    put('heldState', 'complete', { enabled: true });
    // An empty store can certify current facts only when it declares the
    // indexes that consume them. Older declarations still need the bounded
    // fact migration when the current indexes are admitted.
    if (['wake_timing', 'wake_person', 'review_ready', 'review_next']
      .every(name => records.indexDeclared?.(KIND.handoff, name) === true)) {
      put('reviewMark', WAKE_MARK, { done: true });
      put('reviewMark', PARKED_MARK, { done: true });
    }
  };
  const writeHandoff = item => {
    initializeEmptyHandoffs();
    // This durable handoff-only revision validates a persisted scheduler cursor after a store reset. The general
    // record change journal is process-local and cannot do that job.
    const revision = (read('scheduleState', 'handoffs')?.revision ?? 0) + 1;
    put('scheduleState', 'handoffs', { revision });
    // Before any summary is seeded, no handoff write needs to read its old body.
    if (!read('heldState', 'active')) return put('handoff', item.handoff_id, scheduledValue(item));
    // Moving a hold needs only the previous state and holder. New IDs have no
    // body to read; existing current jobs already keep these in their narrow
    // schedule field. Only older jobs without that field need their full value.
    const handoffKey = keyOf('handoff', item.handoff_id);
    const previous = pending?.has(handoffKey) ? read('handoff', item.handoff_id)
      : records.typeOf(handoffKey) === null ? null : readScheduled([{ id: item.handoff_id }])[0];
    const nowHeld = heldAgent(item);
    const complete = read('heldState', 'complete')?.enabled === true;
    for (const agent of new Set([heldAgent(previous), nowHeld].filter(Boolean))) {
      // The first read of an agent's work seeds this exact-key summary. Until then,
      // writes have only the handoff to keep; the first indexed read sees all of them.
      const summary = read('held', agent) ?? (complete ? { ids: [], holds: {} } : null);
      if (!summary) continue;
      const ids = new Set(summary.ids);
      const holds = { ...summary.holds };
      const hold = agent === nowHeld ? holdOf(item) : undefined;
      // Unchanged: the job is in (or out of) the summary as it should be, with the hold it has now.
      if (ids.has(item.handoff_id) === (agent === nowHeld) && JSON.stringify(holds[item.handoff_id]) === JSON.stringify(hold) && summary.holds) continue;
      ids.delete(item.handoff_id);
      delete holds[item.handoff_id];
      if (agent === nowHeld) { ids.add(item.handoff_id); holds[item.handoff_id] = hold; }
      put('held', agent, { ids: [...ids], holds });
    }
    put('handoff', item.handoff_id, scheduledValue(item));
  };

  // An open job's timing as the own-AI clock weighs it (scheduledHandoffOf), from one entry of the wake index.
  const scheduledOfWake = values => {
    const f = Object.fromEntries(WAKE_PATHS.map((name, at) => [name, values[at]]));
    return {
      handoff_id: f.handoff_id, handed_at: f.handed_at, state: f.state, to_agent: null, target: f.prefer_until ? { strict: false, prefer_until: f.prefer_until } : null, taken_by: f.taken_by || null,
      priority: MAX_PRIORITY - f.rank, in_the_way: f.in_the_way === 1, in_the_way_by: f.in_the_way_by || null,
      in_the_way_at: f.in_the_way_at || null, blocked_kind: f.blocked_kind || null, hold_until: f.hold_until || null, generation: f.generation,
      input: { needs: typeof f.needs === 'string' ? JSON.parse(f.needs) : [], arrived: { from_person: f.from_person === 1, source_id: f.source_id || null, depth: f.depth === '' ? null : f.depth, chat_silence_minutes: f.silence >= 0 ? f.silence : null, chat_first_minutes: null } },
      source_active_at: f.active_at || null,
    };
  };
  const wakeMark = () => read('reviewMark', WAKE_MARK);
  // Whether the wake index holds every open job: each had its wake facts written (the step below is done) and none waits
  // in a table. Both named index builds finish through the existing idle maintainer, and the separate origin-fact
  // mark prevents an older completed wake-only check from certifying missing origin values.
  const wakeReady = () => wakeMark()?.done === true && records.indexReady(KIND.handoff, 'wake_timing') && records.indexReady(KIND.handoff, 'wake_person') && firstRows('agent_handoffs', { where: 'open = 1', limit: 1 }).length === 0;
  // Gives the next WAKE_STEP open jobs written before kinds of facts existed (those missing any `fact`) those facts, by writing
  // them again, and keeps where it ended in the record `agent-review-mark:<mark>`.
  const keepFacts = (markName, fact) => {
    const mark = read('reviewMark', markName);
    if (mark?.done) return;
    const needed = Array.isArray(fact) ? fact : [fact];
    const after = mark?.after && read('handoff', mark.after) ? mark.after : null;
    const from = after ? read('handoff', after) : null;
    const sameTime = from ? scan('handoff', 'time', { equal: [1, from.handed_at], idFrom: `${keyOf('handoff', after)}\0`, limit: WAKE_STEP }) : [];
    const later = sameTime.length < WAKE_STEP
      ? scan('handoff', 'time', { equal: [1], ...(from ? { after: from.handed_at } : {}), limit: WAKE_STEP - sameTime.length }) : [];
    const page = [...sameTime, ...later];
    api.transaction(() => {
      for (const entry of page) {
        const stored = records.read(keyOf('handoff', entry.id));
        if (stored && needed.some(name => stored[FOUND_BY]?.[name] === undefined)) put('handoff', entry.id, scheduledValue(valueOf(stored)));
      }
      put('reviewMark', markName, { after: page.at(-1)?.id ?? after, done: page.length < WAKE_STEP });
    });
  };
  const keepWakeFacts = () => keepFacts(WAKE_MARK, ['from_person', 'needs']);
  // One bounded pass repairs review membership and removes old parked wake entries. Every older record lacks
  // review_checked, including those whose wake-parked pass finished; rewriting it derives both sets of current facts.
  // Parked work never keeps the clock from using the wake index, and reviews use the complete older index until done.
  const keepParked = () => keepFacts(PARKED_MARK, ['wake_checked', 'review_checked']);
  // Whether review_next holds every open job: each carries its facts of the current kind (the step above is done) and none
  // waits in a table. Once true it stays true (the marks never go back, and new work is written with its facts).
  let reviewNextKept = false;
  const reviewNextWhole = () => {
    if (!reviewNextKept) reviewNextKept = read('reviewMark', PARKED_MARK)?.done === true && records.indexReady?.(KIND.handoff, 'review_next') === true
      && firstRows('agent_handoffs', { where: 'open = 1', limit: 1 }).length === 0;
    return reviewNextKept;
  };
  // Whether the take facts are kept on every open job, the same way: none waits in a table.
  // Whether to_reader is kept on every waiting job: the cards are records, each open job has been looked at once, and none
  // waits in a table.
  const readerReady = () => !cardsMoving() && read('reviewMark', READER_MARK)?.done === true && firstRows('agent_handoffs', { where: 'open = 1', limit: 1 }).length === 0;
  const takeReady = () => read('reviewMark', TAKE_MARK)?.done === true && firstRows('agent_handoffs', { where: 'open = 1', limit: 1 }).length === 0;
  // Whether every open job that waits on others has its dependency ids, the same way.
  const dependsReady = () => read('reviewMark', DEPENDS_MARK)?.done === true && firstRows('agent_handoffs', { where: 'open = 1', limit: 1 }).length === 0;
  // The open jobs waiting on any of `ids`: from the dependents index, which says what each waits on, only those are read
  // (until every open job has that fact, a step of a few a call, every job that waits on anything is read).
  const dependentsOfAny = ids => {
    flush();
    if (!dependsReady()) keepFacts(DEPENDS_MARK, 'dep_ids');
    const waiting = dependsReady()
      ? scan('handoff', 'dependents', { equal: [1] }).filter(entry => ids.some(id => entry.values[1].split(' ').includes(id)))
      : scan('handoff', 'depends', { equal: [1, 1] });
    return readAll('handoff', waiting).filter(item => ids.some(id => item.depends_on?.includes(id)));
  };

  // The jobs any agent may take after `mark` (null for the first), in the order they are taken, at most `limit`, from the
  // take facts: the jobs ready for anyone from the start in one range of key order, those that become ready with time
  // (a chat's work once its silence window ends, taken work once its hold does) from a bounded look at the ones already
  // ready, oldest ready first, and for an owner of a chat (`source_id`) the same two over the work that chat owns. Nothing
  // that cannot be taken by this agent is walked, and no job is read.
  const takeableEntries = ({ nowIso, source_id, mark, limit }) => {
    const ordered = (name, equal) => afterMark(name, equal, mark, limit);
    const ripe = (name, equal) => scan('handoff', name, { equal, after: '', to: nowIso, limit: TAKE_RIPE });
    const entries = [
      ...ordered('takeable', ['']), ...ripe('takeable', []),
      ...(source_id ? [...ordered('takeable_source', [source_id, '']), ...ripe('takeable_source', [source_id])] : []),
    ];
    const seen = new Set();
    return inTakingOrder([taken(entries.filter(entry => !seen.has(entry.id) && seen.add(entry.id)))])
      .filter(entry => !mark || tupleAfter(entry, { id: mark.id, values: [mark.rank, mark.handed_at] })).slice(0, limit);
  };

  const api = {
    card: id => read('card', id) ?? fromFirstRows('agent_cards', { where: 'agent_id = ?', params: [id], limit: 1 })[0] ?? null,
    // The cards of many ids in one batch: a page of work names a few dozen agents, and one read per id walks the key
    // store's pages once per id (src/agent-records.mjs readAll shares each page across the batch).
    cardsById: ids => readAll('card', ids.map(id => ({ id }))),
    putCard: card => {
      const before = read('card', card.agent_id);
      put('card', card.agent_id, card);
      // Work already waiting for the card is found under its new reader (or none). At most 50 jobs wait for one agent by
      // name (src/agents.mjs), so this is one page.
      if (before && (before.reader !== card.reader || Boolean(before.takes_work) !== Boolean(card.takes_work))) {
        for (const entry of scan('handoff', 'pending', { equal: ['open', card.agent_id], limit: 100 })) put('handoff', entry.id, read('handoff', entry.id));
      }
    },
    cards: () => { flush(); return [...keptCards(), ...oldCards()]; },
    cardIdsOf: ({ reader, takes_work = false }) => [...new Set([
      ...scan('card', 'reader', { equal: takes_work ? [reader, 1] : [reader] }).map(entry => entry.id),
      ...oldCards().filter(card => card.reader === reader && (!takes_work || card.takes_work)).map(card => card.agent_id),
    ])],
    takerIds: () => [...new Set([
      ...scan('card', 'taker', { equal: [1, ''] }).map(entry => entry.id),
      ...oldCards().filter(card => card.takes_work && !card.source_id).map(card => card.agent_id),
    ])],
    cardsForSource: source => [...readAll('card', scan('card', 'taker', { equal: [1, source] })), ...oldCards().filter(card => card.takes_work && card.source_id === source)],
    reachableCards: () => [...readAll('card', scan('card', 'reaches', { equal: [1] })), ...oldCards().filter(card => card.delivery)],
    anyTaker: () => scan('card', 'taker', { equal: [1], limit: 1 }).length > 0 || oldCards().some(card => card.takes_work),

    handoff: (id, { projection = null } = {}) => {
      const selected = handoffProjection(projection), key = keyOf('handoff', id);
      if (pending?.has(key)) {
        const value = pending.get(key).value;
        if (!selected || !value) return projectHandoff(valueOf(value), selected);
        const names = physicalSelection(selected).fields;
        return logicalProjection({ fields: Object.fromEntries(names.filter(name => value[name] !== undefined).map(name => [name, value[name]])),
          presence: selected.presence.map(path => pathPresent(value, path)) }, id, selected);
      }
      if (selected && records.fields?.projectOf) {
        const value = records.fields.projectOf(KIND.handoff, [key], physicalSelection(selected)).get(key);
        if (value) return logicalProjection(value, id, selected);
      }
      // Earlier engines/owners retain their complete authoritative fallback.
      return projectHandoff(read('handoff', id) ?? valueOf(firstRows('agent_handoffs', { where: 'handoff_id = ?', params: [id], limit: 1 })[0]?.value), selected);
    },
    // Verified result decoding can happen while the source history is too large to hydrate alongside it.
    // Read every handoff field except the two content bodies, and carry only a pointer proved by this owner.
    sourceFinish: id => {
      if (typeof records.readOwn !== 'function') return read('handoff', id);
      flush();
      const key = keyOf('handoff', id);
      if (records.typeOf(key) !== KIND.handoff) return null;
      const kept = records.readOwn(key, ['result', 'corrections'], { openErasable: true });
      if (!kept) return null;
      const value = plainValueOf(kept);
      const pointer = historyKey(id);
      if (kept.corrections_record !== undefined && kept.corrections_record !== null
          && (kept.corrections_record !== pointer || records.typeOf(pointer) !== 'agent-handoff-result'))
        throw new Error('Saved handoff content is unavailable');
      if (kept.corrections_record === pointer)
        value[SOURCE_FINISH_CORRECTIONS] = pointer;
      return value;
    },
    sourceAdmissionRecoveryVersion: () => records.ownFieldRecoveryVersion?.() ? 'record-log-complete-source-admission/v2' : null,
    inlineHistoryRecovery: id => {
      const version = api.sourceAdmissionRecoveryVersion();
      if (!version || typeof records.readOwnFieldJson !== 'function' || typeof records.rewriteOwnFieldJsonIfEqual !== 'function') return null;
      flush();
      const key = keyOf('handoff', id);
      if (records.typeOf(key) !== KIND.handoff) return null;
      const kept = records.readOwn(key, Object.keys(CONTENT_FIELDS));
      if (kept?.state !== 'taken' || (!kept.corrections_record && !records.ownFieldPresent(key, 'corrections'))) return null;
      return version;
    },
    normalizeInlineHistory: (id, admission) => api.transaction(() => {
      flush();
      if (!api.sourceAdmissionRecoveryVersion()) return false;
      const key = keyOf('handoff', id), kept = records.readOwn(key, Object.keys(CONTENT_FIELDS));
      if (!kept || kept.state !== admission.state || kept.taken_by !== admission.agent_id || (kept.generation ?? 0) !== admission.generation
          || (kept.revision ?? null) !== admission.revision
          || Object.values(kept.effects ?? {}).some(effect => ['starting', 'unknown'].includes(effect.state)))
        throw Object.assign(new WorkFailure('request-refused', 'The result lease changed during history recovery.'), { code: 'result_recovery_conflict' });
      if (kept.corrections_record || !records.ownFieldPresent(key, 'corrections')) return false;
      const originalJson = records.readOwnFieldJson(key, KIND.handoff, 'corrections');
      if (originalJson === null) return false;
      const payloadId = historyKey(id);
      // No supplied source replaces history. Its authoritative exact JSON is sealed through the normal owner.
      records.write([{ id: payloadId, type: 'agent-handoff-result', value: keepContentJson(originalJson) }], ACTOR);
      if (!records.rewriteOwnFieldJsonIfEqual(key, KIND.handoff, 'corrections', originalJson, { corrections_record: payloadId }, ACTOR))
        throw Object.assign(new WorkFailure('request-refused', 'Correction history changed during representation recovery.'), { code: 'result_recovery_conflict' });
      return true;
    }),
    // A live admission marker is offered only for this finished legacy root, on an owner that can physically repair it.
    legacyResultRecovery: id => {
      const version = records.ownFieldRecoveryVersion?.();
      if (!version || typeof records.rewriteOwnFieldIfEqual !== 'function') return null;
      flush();
      const key = keyOf('handoff', id);
      if (records.typeOf(key) !== KIND.handoff) return null;
      const kept = records.readOwn(key, Object.keys(CONTENT_FIELDS));
      if (kept?.state !== 'finished' || kept.result_source_receipt || kept.result_record || !records.ownFieldPresent(key, 'result')) return null;
      return version;
    },
    recoverLegacyResult: (id, expected, receipt, preparedContent = null) => api.transaction(() => {
      flush();
      if (!api.legacyResultRecovery(id)) return false;
      const key = keyOf('handoff', id), payloadId = resultKey(id);
      const kept = records.readOwn(key, Object.keys(CONTENT_FIELDS));
      if (kept.state !== 'finished' || kept.taken_by !== receipt.agent_id || (kept.generation ?? 0) !== receipt.generation
          || Object.values(kept.effects ?? {}).some(effect => ['starting', 'unknown'].includes(effect.state)))
        throw Object.assign(new WorkFailure('request-refused', 'The result lease changed during recovery.'), { code: 'result_recovery_conflict' });
      // Both writes use the normal owner. The payload kind seals its JSON and erases with its handoff.
      const expectedJson = JSON.stringify(expected);
      // The verified source reader already prepared this exact result before
      // decoding it. Reuse that representation while the result graph is live.
      // Equality still checks the original authoritative field below.
      records.write([{ id: payloadId, type: 'agent-handoff-result', value: preparedContent ?? keepContentJson(expectedJson) }], ACTOR);
      if (!records.rewriteOwnFieldJsonIfEqual(key, KIND.handoff, 'result', expectedJson,
          { result_record: payloadId, result_source_receipt: receipt }, ACTOR))
        throw Object.assign(new WorkFailure('request-refused', 'The finished result differs from the verified source.'), { code: 'result_recovery_conflict' });
      return true;
    }),
    putHandoff: item => pending ? writeHandoff(item) : api.transaction(() => writeHandoff(item)),
    openHandoffs: ({ after = null, limit = Infinity, projection = null } = {}) => {
      const selected = handoffProjection(projection);
      const mark = after ? api.handoff(after, { projection: { fields: ['handed_at'] } }) : null;
      if (after && !mark) return [];
      const size = pageOf(limit);
      if (!size) return [];
      // Bound both index walks, including a page boundary inside one timestamp. The cursor stays readable
      // after that handoff is finished, so closing a duplicate cannot rewind the next page.
      const sameTime = mark
        ? scan('handoff', 'time', { equal: [1, mark.handed_at], idFrom: keyOf('handoff', after), limit: size + 1 })
          .filter(entry => entry.id !== after).slice(0, size)
        : [];
      const later = mark
        ? (sameTime.length < size ? scan('handoff', 'time', { equal: [1], after: mark.handed_at, limit: size - sameTime.length }) : [])
        : scan('handoff', 'time', { equal: [1], limit: size });
      const current = readProjected([...sameTime, ...later], selected);
      const legacy = firstRows('agent_handoffs', {
        where: `open = 1${mark ? ' AND (handed_at, handoff_id) > (?, ?)' : ''}`,
        params: mark ? [mark.handed_at, after] : [], orderBy: 'handed_at, handoff_id', limit: size,
      }).map(record => valueOf(record.value));
      const merged = [...current, ...legacy].sort((a, b) => a.handed_at.localeCompare(b.handed_at) || a.handoff_id.localeCompare(b.handoff_id));
      return merged.slice(0, size).map(item => projectHandoff(item, selected));
    },
    // The own-AI clock's way into the wake timing index, a page of one addressee and priority at a time in the order its jobs
    // can first be due (src/own-ais-routing.mjs soonestIndexed): ready() says whether the index holds every open job (when
    // it does not, the caller reads openScheduledHandoffs); priorities(to_agent, after) is the next priority there is
    // work at after `after` (highest first; null for the first), or null; rows({ to_agent, priority, after, limit }) are up
    // to `limit` entries { key, cursor, item } after the entry `cursor` of the last page (null for the first page); held(id)
    // the unfinished jobs `id` holds. `from_person` seeks only jobs the daily cap exempts at every priority, through
    // the declared wake_person index: it never reads capped jobs to find them.
    scheduledWake: {
      step: () => (read('reviewMark', WAKE_MARK)?.done === true ? keepParked() : keepWakeFacts()),
      ready: () => { flush(); return wakeReady(); },
      priorities: (to_agent, after) => {
        const [next] = scan('handoff', 'wake_timing', { equal: [1, to_agent], ...(after === null ? {} : { after: MAX_PRIORITY - after }), limit: 1 });
        return next ? MAX_PRIORITY - next.values[2] : null;
      },
      rows: ({ to_agent, priority, from_person = false, after = null, limit }) => {
        const name = from_person ? 'wake_person' : 'wake_timing';
        const head = [1, to_agent, MAX_PRIORITY - priority];
        const tied = after ? scan('handoff', name, { equal: [...head, after.key], after: after.id, limit }) : [];
        const later = tied.length < limit
          ? scan('handoff', name, { equal: head, ...(after ? { after: after.key } : {}), limit: limit - tied.length }) : [];
        return [...tied, ...later].map(entry => ({ key: entry.values[3], cursor: { key: entry.values[3], id: entry.values[4] }, item: scheduledOfWake(entry.values) }));
      },
      held: id => readScheduled(scan('handoff', 'held', { equal: [1, id] })).filter(item => item.state === 'taken'),
    },
    openScheduledHandoffsPage: ({ after = null, limit = 100 } = {}) => {
      flush();
      const size = Math.min(100, pageOf(limit));
      if (!size) return [];
      const cursorId = typeof after === 'string' ? after : after?.handoff_id;
      const mark = after ? (typeof after === 'string' ? read('handoff', after) ?? fromFirstRows('agent_handoffs', {
        where: 'handoff_id = ?', params: [after], limit: 1,
      })[0] ?? null : after) : null;
      if (after && !mark) return [];
      const sameTime = mark
        ? scan('handoff', 'time', { equal: [1, mark.handed_at], idFrom: keyOf('handoff', cursorId), limit: size + 1 })
          .filter(entry => entry.id !== cursorId).slice(0, size)
        : [];
      const later = mark
        ? (sameTime.length < size ? scan('handoff', 'time', { equal: [1], after: mark.handed_at, limit: size - sameTime.length }) : [])
        : scan('handoff', 'time', { equal: [1], limit: size });
      const current = readScheduled([...sameTime, ...later]);
      const legacy = fromFirstRows('agent_handoffs', {
        where: `open = 1${mark ? ' AND (handed_at, handoff_id) > (?, ?)' : ''}`,
        params: mark ? [mark.handed_at, cursorId] : [], orderBy: 'handed_at, handoff_id', limit: size,
      }).map(item => scheduledHandoffOf(item));
      return structuredClone([...current, ...legacy].sort((a, b) => a.handed_at.localeCompare(b.handed_at)
        || a.handoff_id.localeCompare(b.handoff_id)).slice(0, size));
    },
    scheduleRevision: () => { flush(); return read('scheduleState', 'handoffs')?.revision ?? 0; },
    reviewSearchMark: name => { flush(); return read('reviewMark', name); },
    putReviewSearchMark: (name, value) => put('reviewMark', name, value),
    openScheduledHandoffs: () => {
      flush();
      if (wakeReady()) return scan('handoff', 'wake_timing', { equal: [1] }).map(entry => scheduledOfWake(entry.values))
        .sort((a, b) => a.handed_at.localeCompare(b.handed_at) || a.handoff_id.localeCompare(b.handoff_id));
      keepWakeFacts();
      const all = [];
      for (let after = null;;) {
        const page = api.openScheduledHandoffsPage({ after, limit: 100 });
        all.push(...page);
        if (page.length < 100) return all;
        after = page.at(-1);
      }
    },
    ownWorkWaiting: ({ nowIso, before = null, minPriority, limit = 1, includeSaid = false }) => {
      const found = [];
      // The open work at or above the priority, one rank at a time in the order handed: only the first few jobs of each
      // rank are read (those held right now are passed over), never every open job.
      if (records.indexReady(KIND.handoff, 'open_rank')) {
        flush();
        const size = Math.max(limit, 8);
        for (let rank = 0; rank <= MAX_PRIORITY - minPriority; rank += 1) {
          let kept = 0;
          for (let after = null; kept < limit;) {
            const page = scan('handoff', 'open_rank', { equal: [1, rank], ...(after === null ? {} : { after }), limit: size });
            for (const item of readAll('handoff', page)) {
              if (before && item.handed_at >= before) { kept = limit; break; }
              if (item.taken_by && item.hold_until && item.hold_until >= nowIso) continue;
              found.push({ handoff_id: item.handoff_id, handed_at: item.handed_at, ...(includeSaid ? { said: item.said ?? null } : {}) });
              kept += 1;
              if (kept >= limit) break;
            }
            if (page.length < size) break;
            after = page.at(-1).values[2];
          }
        }
        return found.sort((a, b) => a.handed_at.localeCompare(b.handed_at) || a.handoff_id.localeCompare(b.handoff_id)).slice(0, limit);
      }
      for (let after = null; found.length < limit;) {
        const page = api.openHandoffs({ after, limit: 50 });
        for (const item of page) {
          if ((item.priority ?? 0) < minPriority || before && item.handed_at >= before) continue;
          if (item.taken_by && item.hold_until && item.hold_until >= nowIso) continue;
          found.push({ handoff_id: item.handoff_id, handed_at: item.handed_at,
            ...(includeSaid ? { said: item.said ?? null } : {}) });
          if (found.length >= limit) break;
        }
        if (page.length < 50) break;
        after = page.at(-1).handoff_id;
      }
      return found;
    },
    newestOpen: (limit, options = {}) => newestStatePage(1, { ...options, limit }),
    // The open work handed between two times (ISO, `after` not included, `to` included), oldest first, at most `limit`: the
    // time index holds the time handed, so only the jobs in the range are read (gather_moment, src/moments.mjs).
    openHandedBetween: (after, to, limit) => readAll('handoff', scan('handoff', 'time', { equal: [1], after, to, limit: pageOf(limit) })),
    // The open work something stands in the way of, newest handed first, at most `limit`; null while the index is being
    // built. The index holds the words and the time handed, so only the jobs shown are read, never every open job.
    blockedOpen: (limit, { fields = null, titleFallback = false } = {}) => {
      if (!records.indexReady(KIND.handoff, 'blocked-open')) return null;
      const entries = scan('handoff', 'blocked-open', { reverse: true, limit: pageOf(limit) });
      if (!Array.isArray(fields) || !records.fields?.fieldsOf) return readAll('handoff', entries);
      const keys = entries.map(entry => keyOf('handoff', entry.id));
      const own = records.fields.fieldsOf(KIND.handoff, keys, fields);
      if (titleFallback) {
        const missing = keys.filter(key => own.has(key) && !(typeof own.get(key).said === 'string' && own.get(key).said.trim()));
        const jobs = records.fields.fieldsOf(KIND.handoff, missing, ['job']);
        for (const key of missing) own.get(key).job = jobs.get(key)?.job ?? null;
      }
      return entries.map(entry => {
        const value = own.get(keyOf('handoff', entry.id));
        return value ? { ...value, handoff_id: entry.id } : null;
      }).filter(Boolean);
    },
    // The open work as Home's workstreams card draws it, newest handed first, at most `limit`; null while the index is being
    // built. The index holds what a row is drawn from (state, what stands in the way, the job it was handed on from), and
    // carries its words (`said`, erasable) sealed as the record keeps them, opened as they are read: no job is read to
    // draw a row, and no key holds its words. A job with no words of its own kept is read whole.
    homeOpen: limit => {
      if (!records.indexReady(KIND.handoff, 'home-open')) return null;
      const size = pageOf(limit);
      const drawn = new Map(scan('handoff', 'home-open', { equal: [1], reverse: true, limit: size, carried: true }).map(({ id, values: [, handed_at, state, in_the_way, parent_handoff_id, from_agent], carried }) => [id, { handoff_id: id, state, in_the_way, parent_handoff_id, handed_at, finished_at: null, said: carried?.said ?? null, from_agent, job: '' }]));
      const listed = scan('handoff', 'time', { equal: [1], reverse: true, limit: size });
      // A job the index holds no entry for (one kept before it carried `in_the_way`, so a path is missing) or no words of its
      // own is read by the fields the card draws, never whole: a job's words and results are many times its row.
      const missing = listed.filter(({ id }) => !(typeof drawn.get(id)?.said === 'string' && drawn.get(id).said.trim())).map(({ id }) => keyOf('handoff', id));
      const own = missing.length && records.fields?.fieldsOf ? records.fields.fieldsOf(KIND.handoff, missing, HOME_FIELDS) : null;
      const untitled = own ? missing.filter(key => own.has(key) && !(typeof own.get(key).said === 'string' && own.get(key).said.trim())) : [];
      const jobs = untitled.length ? records.fields.fieldsOf(KIND.handoff, untitled, ['job']) : new Map();
      return listed.map(({ id }) => {
        const row = drawn.get(id);
        if (row && typeof row.said === 'string' && row.said.trim()) return row;
        const key = keyOf('handoff', id);
        if (!own) return read('handoff', id);
        const value = own.get(key);
        return value ? { in_the_way: null, parent_handoff_id: null, from_agent: null, ...value, handoff_id: id, finished_at: value.finished_at ?? null, job: jobs.get(key)?.job ?? '' } : null;
      }).filter(Boolean);
    },
    notificationWork,
    heldBy: id => {
      // A selected index range opens a page in every overlapping run, including
      // runs with no work for this agent. Once initialized, the summary is a
      // point read: absent keys in older runs are rejected by their filters.
      if (!id || !heldSummaryReady()) return indexedHeldBy(id);
      const summary = read('held', id);
      if (summary) {
        const items = readAll('handoff', summary.ids.map(handoffId => ({ id: handoffId }))).filter(item => heldAgent(item) === id);
        // A summary written before it kept the holds gets them now, so the next count of this agent's slots reads only it.
        if (!summary.holds) {
          const save = () => put('held', id, { ids: items.map(item => item.handoff_id), holds: Object.fromEntries(items.map(item => [item.handoff_id, holdOf(item)])) });
          if (pending) save(); else api.transaction(save);
        }
        return items.sort(heldOrder);
      }
      if (read('heldState', 'complete')?.enabled === true) return [];
      const held = indexedHeldBy(id);
      const seed = () => {
        put('held', id, { ids: held.map(item => item.handoff_id), holds: Object.fromEntries(held.map(item => [item.handoff_id, holdOf(item)])) });
        if (!read('heldState', 'active')) put('heldState', 'active', { enabled: true });
      };
      if (pending) seed(); else api.transaction(seed);
      return held;
    },
    // What an agent holds as far as counting its slots goes (state, holder, hold times, whether something is in the way), from
    // its held summary alone: no job is read. null when the summary does not say (not seeded yet, or kept before it held
    // these), and the caller reads the jobs.
    heldLoad: id => {
      if (!id || !heldSummaryReady()) return null;
      const summary = read('held', id);
      if (!summary && read('heldState', 'complete')?.enabled === true) return [];
      return summary?.holds && summary.ids.every(handoffId => summary.holds[handoffId]) ? summary.ids.map(handoffId => ({ handoff_id: handoffId, ...summary.holds[handoffId] })) : null;
    },
    heldByMany: ids => {
      if (ids.some(id => !id)) return ids.flatMap(id => api.heldBy(id));
      const unique = [...new Set(ids)];
      if (unique.length <= 1) return unique.flatMap(id => api.heldBy(id));
      if (!heldSummaryReady()) {
        const held = api.boardAgentLoads(unique, { includeWaiting: false }).held;
        return ids.flatMap(id => held.get(id) ?? []);
      }
      const summaries = new Map(unique.map(id => [id, read('held', id)]));
      if (read('heldState', 'complete')?.enabled === true) return ids.flatMap(id =>
        readAll('handoff', (summaries.get(id)?.ids ?? []).map(handoffId => ({ id: handoffId })))
          .filter(item => heldAgent(item) === id).sort(heldOrder));
      const missing = unique.filter(id => !summaries.get(id));
      let first = null;
      if (missing.length === 1) {
        const id = missing[0];
        first = new Map([[id, api.heldBy(id)]]);
      } else if (missing.length) {
        // A reader with many cards initializes them with one index walk and one
        // log write, rather than reopening every run for every absent summary.
        first = api.boardAgentLoads(missing, { includeWaiting: false }).held;
        const seed = () => {
          for (const id of missing) put('held', id, { ids: first.get(id).map(item => item.handoff_id) });
          if (!read('heldState', 'active')) put('heldState', 'active', { enabled: true });
        };
        if (pending) seed(); else api.transaction(seed);
      }
      const missingIds = new Set(missing);
      return ids.flatMap(id => missingIds.has(id) ? first.get(id) ?? []
        : readAll('handoff', summaries.get(id).ids.map(handoffId => ({ id: handoffId })))
          .filter(item => heldAgent(item) === id).sort(heldOrder));
    },
    boardAgentLoads: (ids, { includeWaiting = true } = {}) => {
      const wanted = new Set(ids);
      const held = new Map(ids.map(id => [id, []]));
      const waiting = new Map(ids.map(id => [id, 0]));
      // One range walk per fact answers the whole board. Walking the same record
      // index once per card multiplied the work of a busy account by its AI count.
      // Work nobody holds or is named for keeps '' there, first in key order; `after: ''` starts past all of it, so the
      // thousands of open jobs waiting for anyone are never walked to count what the named AIs hold or wait on.
      for (const entry of scan('handoff', 'held', { equal: [1], after: '' })) {
        const id = entry.values[1];
        if (!wanted.has(id)) continue;
        const item = read('handoff', entry.id);
        if (item) held.get(id).push(item);
      }
      if (includeWaiting) for (const entry of scan('handoff', 'pending', { equal: ['open'], after: '' })) {
        const id = entry.values[1];
        if (wanted.has(id)) waiting.set(id, waiting.get(id) + 1);
      }
      return { held, waiting };
    },
    openAddressedTo: id => readAll('handoff', scan('handoff', 'addressed', { equal: [1, id] })),
    pendingAddressedTo: (ids, limit) => {
      const size = pageOf(limit);
      if (!ids.length || size === 0) return [];
      const entries = scanSelectedValues('handoff', 'pending', { equal: ['open'], values: [...new Set(ids)], limit: size });
      const selected = inTakingOrder([taken(entries)]).slice(0, size);
      return readAll('handoff', selected);
    },
    openForSource: id => readAll('handoff', scan('handoff', 'source', { equal: [1, id] })),
    unaddressedForSource: id => readAll('handoff', scan('handoff', 'source', { equal: [1, id, ''] })),
    dependentsOf: id => dependentsOfAny([id]),
    // The work waiting on any of several jobs, found and read once.
    dependentsOfAny,
    openQueue: ({ to_agent = null, nowIso, after = null, limit = Infinity, takeable = null, pointReads = false }) => {
      let mark = null;
      if (after) {
        const kept = records.read(keyOf('handoff', after))?.[FOUND_BY];
        const earlier = kept ? null : fromFirstRows('agent_handoffs', { where: 'handoff_id = ?', params: [after], limit: 1 })[0];
        const found = kept ?? (earlier ? FOUND.handoff(earlier) : null);
        if (!found) return [];
        mark = { id: after, rank: found.rank, handed_at: found.handed_at };
      }
      // Work addressed to nobody, as the one agent asking may take it (takeable): from the take facts, a few jobs and no more.
      if (takeable && !to_agent) {
        const size = pageOf(limit);
        const ready = takeableEntries({ nowIso, source_id: takeable.source_id, mark, limit: size });
        const preferred = preferredEntries(nowIso).filter(entry => !mark || tupleAfter(entry, { id: mark.id, values: [mark.rank, mark.handed_at] }));
        return readAll('handoff', inTakingOrder([ready, preferred]).slice(0, size));
      }
      let entries = queueEntries(to_agent, nowIso, mark, pageOf(limit));
      if (mark) entries = entries.filter(entry => tupleAfter(entry, { id: mark.id, values: [mark.rank, mark.handed_at] }));
      const page = entries.slice(0, pageOf(limit));
      // The take caller may select the existing admitted point path for scattered named roots; page membership and limits stay the same.
      const stored = new Map(readAll('handoff', page.filter(entry => !entry.item), { pointReads: pointReads === true && Boolean(to_agent) }).map(item => [item.handoff_id, item]));
      return page.map(entry => entry.item ?? stored.get(entry.id)).filter(Boolean);
    },
    // The way take reads the work any agent may take without walking it (takeFactsOf): ready() says whether every open job
    // has its take facts (until then a take reads open work as before), step() gives the next few theirs, and lapsed(...)
    // are the open jobs for `to_agent` whose asker stopped waiting by nowIso, oldest first, from an index on take_by.
    takeable: {
      ready: () => { flush(); return takeReady(); },
      step: () => keepFacts(TAKE_MARK, 'takes'),
      lapsed: ({ to_agent, nowIso, limit }) => readAll('handoff', scan('handoff', 'lapsing', { equal: [to_agent], to: nowIso, limit: pageOf(limit) })),
      // The earliest take_by among all open work, or undefined: the first entry of the index on take_by alone.
      earliest: () => scan('handoff', 'lapse_at', { limit: 1 })[0]?.values[0],
      // The addressees that hold open work with a take_by, one at a time in the index's order: the first from `from`
      // (inclusive), or the first after `after`, or undefined past the last. One key read, whatever the index holds.
      addressee: ({ from, after } = {}) => scan('handoff', 'lapsing', { ...(after !== undefined ? { after } : from !== undefined ? { from } : {}), limit: 1 })[0]?.values[0],
    },
    // The waiting work addressed to any card of one reader, in the order it is taken, at most `limit`, or null while the
    // reader facts are not yet kept on every open job (a step of that is taken here, as a take does for the take facts).
    pendingForReader: (reader, limit) => {
      flush();
      if (!readerReady() && (cardsMoving() || (keepFacts(READER_MARK, 'to_reader'), !readerReady()))) return null;
      return readAll('handoff', scan('handoff', 'pending_reader', { equal: [reader], limit: pageOf(limit) })).filter(item => item.state === 'open');
    },
    // With `most`, counting stops there: a full queue is known from its first `most` jobs, never by reading them all.
    waitingCount: (id, { most = Infinity } = {}) => {
      const kept = scan('handoff', 'pending', { equal: ['open', id], limit: pageOf(most) }).length;
      return kept >= most ? kept : kept + fromFirstRows('agent_handoffs', { where: 'open = 1 AND state = \'open\' AND to_agent = ?', params: [id], limit: Number.isFinite(most) ? most - kept : 100000 }).length;
    },
    // The work whose review has fallen due by nowIso, in the review index's order ('' first, then the oldest time), at
    // most `limit`, skipping work still waiting on unfinished work. `finished(id)` says whether a handoff it waits on is
    // finished; a store that keeps some work elsewhere (src/agent-legacy-rows.mjs) answers it over both.
    dueReviews: (nowIso, limit = Infinity, finished = id => read('handoff', id)?.state === 'finished') => {
      const size = pageOf(limit);
      if (size === 0) return [];
      const saved = read('reviewMark', DUE_REVIEW_MARK);
      const through = saved?.through && saved.through > nowIso ? saved.through : nowIso;
      const cursor = saved?.cursor ?? null;
      const dirty = Boolean(saved?.dirty || saved?.revision !== undefined && saved.revision !== scheduleRevision());
      const page = reviewWindow('review', [1], cursor, REVIEW_PAGE, through);
      const due = [];
      let last = null;
      for (const entry of page) {
        last = entry;
        const item = read('handoff', entry.id);
        if (item && reviewOf(item).waits_on.every(finished)) due.push(item);
        if (due.length >= size) break;
      }
      const continueSearch = Boolean(last && (page.length === REVIEW_PAGE || due.length >= size));
      const nextCursor = continueSearch ? { id: last.id, review_at: last.values[1] } : null;
      // A changed handoff may have unblocked a candidate already passed by this
      // cursor. Finish the bounded pass, then restart once against the new state.
      const cursorAfter = dirty && !continueSearch ? null : nextCursor;
      const next = { revision: scheduleRevision(), through, cursor: cursorAfter, dirty: dirty && continueSearch };
      if (JSON.stringify(saved ?? null) !== JSON.stringify(next)) put('reviewMark', DUE_REVIEW_MARK, next);
      return due;
    },
    reviewMark: () => read('reviewMark', REVIEW_MARK)?.after ?? null,
    putReviewMark: after => put('reviewMark', REVIEW_MARK, { after }),
    // The earliest review, from the MIN of the review_ready index: the work waiting on nothing (depends 0) is ready as it
    // stands, so its first entry and the first timed one after the '' ones are the answer for it; of the few jobs that wait
    // on other work (depends 1) only those due before that are read, each with the handoffs it waits on, stopping at the first
    // whose waits are all finished. The earlier of the two (the work due now first); until the index is built, the review
    // index is walked from its start a page at a time instead.
    nextReviewAt: (nowIso, finished = id => read('handoff', id)?.state === 'finished') => {
      flush();
      const ready = entry => {
        const item = read('handoff', entry.id);
        return Boolean(item) && reviewOf(item).waits_on.every(finished);
      };
      const earlier = (timed, candidate) => candidate === null ? timed : timed === null ? candidate : candidate < timed ? candidate : timed;
      const continuationAt = new Date(Date.parse(nowIso) + 1000).toISOString();
      // review_next is complete only once the bounded review-hold-facts pass has repaired every older open job.
      const index = reviewNextWhole() ? 'review_next' : 'review_ready';
      if (records.indexReady?.(KIND.handoff, 'review_ready') !== true) {
        const saved = read('reviewMark', NEXT_REVIEW_MARK);
        const cursor = saved?.index === 'review' ? saved.cursor ?? null : null;
        const page = reviewWindow('review', [1], cursor, REVIEW_PAGE);
        const found = page.find(ready);
        const last = page.at(-1);
        const continueCursor = !found && last && page.length === REVIEW_PAGE ? { id: last.id, review_at: last.values[1] } : null;
        const next = { index: 'review', cursor: continueCursor };
        if (JSON.stringify(saved ?? null) !== JSON.stringify(next)) put('reviewMark', NEXT_REVIEW_MARK, next);
        if (found) return found.values[1] === '' ? nowIso : found.values[1];
        return continueCursor ? continuationAt : null;
      }
      const first = (equal, options = {}) => scan('handoff', index, { equal, ...options, limit: 1 })[0];
      const independentNow = Boolean(first([1, 0, '']));
      const independentTimed = first([1, 0], { after: '' })?.values[2] ?? null;
      // Work already due is answered without reading the jobs that wait on other work: none of them can be due before now,
      // so each of their reads would only repeat the answer the scheduler already has.
      if (independentNow) return earlier(independentTimed, nowIso);
      const independent = independentTimed;
      const saved = read('reviewMark', NEXT_REVIEW_MARK);
      const cursor = saved?.index === index ? saved.cursor ?? null : null;
      // A dependency-bound review later than the known independent review cannot advance this clock.
      const page = reviewWindow(index, [1, 1], cursor, REVIEW_PAGE, independent);
      const found = page.find(ready);
      const last = page.at(-1);
      const continueCursor = !found && last && page.length === REVIEW_PAGE ? { id: last.id, review_at: last.values[2] } : null;
      const next = { index, cursor: continueCursor };
      if (JSON.stringify(saved ?? null) !== JSON.stringify(next)) put('reviewMark', NEXT_REVIEW_MARK, next);
      if (found) return earlier(independent, found.values[2] === '' ? nowIso : found.values[2]);
      return continueCursor ? earlier(independent, continuationAt) : independent;
    },
    handedOnMetadataFromMany,
    handedOnIdsFromMany: ids => new Map([...handedOnMetadataFromMany(ids)].map(([id, children]) => [id, children.map(child => child.handoff_id)])),
    handedOnFrom: id => readAll('handoff', scan('handoff', 'parent', { equal: [id] })),
    handedOnFromMany: (ids, { taskMap = false } = {}) => {
      const groups = new Map([...new Set(ids)].map(id => [id, []]));
      if (!groups.size) return groups;
      flush();
      const entries = records.scanFirstValues(KIND.handoff, 'parent', [...groups.keys()])
        .map(entry => ({ ...entry, id: idOf('handoff', entry.id) }));
      for (const item of taskMap ? taskMapOf(entries) : readAll('handoff', entries)) {
        groups.get(item.parent_handoff_id)?.push(item);
      }
      return groups;
    },
    // { taskMap: true } answers only what the task map draws of each job (taskMapOf).
    fromMessage: (id, { taskMap = false } = {}) => {
      const entries = [...scan('handoff', 'message', { equal: [id] }), ...scan('handoff', 'asked', { equal: [id] })];
      return (taskMap ? taskMapOf(entries) : readAll('handoff', entries))
        .sort((a, b) => a.handed_at.localeCompare(b.handed_at) || a.handoff_id.localeCompare(b.handoff_id));
    },
    // The newest index orders by when each job was handed, so its entries carry every other field the map draws.
    newestHandoffs: (limit, { taskMap = false } = {}) => taskMap
      ? taskMapOf(scan('handoff', 'newest', { reverse: true, limit, carried: true })
        .map(entry => ({ ...entry, carried: { ...entry.carried, handed_at: entry.values[0] } })), { carried: true, index: 'newest' })
      : readAll('handoff', scan('handoff', 'newest', { reverse: true, limit })),
    // One page of the work handed on from `id`, newest handed first, after the part named by before: the parent index
    // walked in its handed_at order, bounded like the finished page even when parts share a time.
    // A caller holding the part another table keeps passes it as `mark` ({ handoff_id, handed_at, parent_handoff_id }).
    partsPage: (id, { before = null, limit, mark: given = null } = {}) => {
      const size = pageOf(limit);
      if (!size) return [];
      const mark = before ? given ?? api.handoff(before, { projection: { fields: ['handed_at', 'parent_handoff_id'] } }) : null;
      if (before && (!mark || mark.parent_handoff_id !== id)) return [];
      const tied = mark ? scan('handoff', 'parent', { equal: [id, mark.handed_at], idTo: keyOf('handoff', before), reverse: true, limit: size + 1 })
        .filter(entry => entry.id !== before).slice(0, size) : [];
      const older = mark ? tied.length < size ? scan('handoff', 'parent', { equal: [id], before: mark.handed_at, reverse: true, limit: size - tied.length }) : []
        : scan('handoff', 'parent', { equal: [id], reverse: true, limit: size });
      return readAll('handoff', [...tied, ...older]);
    },
    finishedHandoffs: options => newestStatePage(0, options),

    deliverySecret: id => read('secret', id)?.secret ?? fromFirstRows('agent_delivery_secrets', { where: 'agent_id = ?', params: [id], limit: 1 })[0]?.secret ?? null,
    putDeliverySecret: (id, secret) => put('secret', id, { secret }),
    delivery: id => read('delivery', id) ?? fromFirstRows('agent_deliveries', { where: 'event_id = ?', params: [id], limit: 1 })[0] ?? null,
    putDelivery: item => put('delivery', item.event_id, item),
    dueDeliveries: nowIso => {
      const current = readAll('delivery', scan('delivery', 'due', { equal: ['waiting'], after: '', to: nowIso, limit: DUE_PAGE }));
      const legacy = firstRows('agent_deliveries', {
        where: "state = 'waiting' AND next_at IS NOT NULL AND next_at <= ?", params: [nowIso],
        orderBy: 'next_at, event_id', limit: DUE_PAGE,
      }).map(record => valueOf(record.value));
      return [...current, ...legacy].sort((a, b) => a.next_at.localeCompare(b.next_at) || a.event_id.localeCompare(b.event_id)).slice(0, DUE_PAGE);
    },
    deadDeliveries: id => [...readAll('delivery', scan('delivery', 'agent', { equal: [id, 'dead'] })), ...fromFirstRows('agent_deliveries', { where: "agent_id = ? AND state = 'dead'", params: [id], limit: 100000 })],
    deliveriesFor: id => [...readAll('delivery', scan('delivery', 'subject', { equal: [id] })), ...fromFirstRows('agent_deliveries', { where: 'subject_id = ?', params: [id], orderBy: 'event_id', limit: 100000 })],
    waitingFor: (id, limit = Infinity) => {
      const maximum = pageOf(limit);
      if (maximum === 0) return 0;
      const current = scan('delivery', 'agent', { equal: [id, 'waiting'], limit: maximum }).length;
      if (current >= maximum) return current;
      return current + fromFirstRows('agent_deliveries', { where: "agent_id = ? AND state = 'waiting'", params: [id], limit: Math.min(100000, maximum - current) }).length;
    },
    // One capped count per selected recipient. Packed index pages are selected together;
    // each state prefix retains the same limit and legacy row contribution as waitingFor.
    waitingForMany: (ids, limit = Infinity) => {
      const counts = new Map([...new Set(ids)].map(id => [id, 0]));
      const maximum = pageOf(limit);
      if (!counts.size || maximum === 0) return counts;
      // Keep every selected batch small even when all recipients are at their cap.
      // The ordinary owner fallback keeps exact answers for unbounded callers.
      const selected = [...counts.keys()];
      for (let from = 0; from < selected.length; from += 16) {
        const entries = scanSelectedValues('delivery', 'agent', { values: selected.slice(from, from + 16), suffix: ['waiting'], limit: maximum });
        for (const entry of entries) counts.set(entry.values[0], counts.get(entry.values[0]) + 1);
      }
      for (const [id, current] of counts) if (current < maximum) {
        counts.set(id, current + fromFirstRows('agent_deliveries', { where: "agent_id = ? AND state = 'waiting'", params: [id], limit: Math.min(100000, maximum - current) }).length);
      }
      return counts;
    },
    streamWaiting: id => {
      const ready = [];
      let last = null;
      while (ready.length < MAX_PULLED) {
        const remaining = MAX_PULLED - ready.length;
        // Resume inside a tied timestamp before moving to the next one.
        const tied = last ? scan('delivery', 'agent', {
          equal: [id, 'waiting', last.values[2]], idFrom: `${keyOf('delivery', last.id)}\0`, limit: remaining,
        }) : [];
        const later = tied.length < remaining ? scan('delivery', 'agent', {
          equal: [id, 'waiting'], ...(last ? { after: last.values[2] } : {}), limit: remaining - tied.length,
        }) : [];
        const page = [...tied, ...later];
        if (!page.length) break;
        for (const item of readAll('delivery', page)) if (!item.next_at) ready.push(item);
        last = page.at(-1);
        if (page.length < remaining) break;
      }
      if (ready.length === MAX_PULLED) return ready;
      return [...ready, ...fromFirstRows('agent_deliveries', {
        where: "agent_id = ? AND state = 'waiting' AND next_at IS NULL", params: [id],
        orderBy: 'event_id', limit: MAX_PULLED - ready.length,
      })];
    },
    nextDeliveryAt: () => {
      flush();
      const seq = records.changeSeq?.();
      let current;
      if (deliveryDueCache && Number.isSafeInteger(seq)) {
        const changed = seq === deliveryDueCache.seq ? [] : records.changedSince?.(deliveryDueCache.seq);
        if (Array.isArray(changed) && !changed.some(id => id.startsWith('agent-delivery:'))) {
          deliveryDueCache.seq = seq;
          current = deliveryDueCache.at;
        }
      }
      if (current === undefined) {
        const [entry] = scan('delivery', 'due', { equal: ['waiting'], after: '', limit: 1 });
        current = entry ? Date.parse(entry.values[1]) : null;
        const after = records.changeSeq?.();
        deliveryDueCache = Number.isSafeInteger(after) ? { seq: after, at: current } : null;
      }
      const legacy = fromFirstRows('agent_deliveries', { where: "state = 'waiting' AND next_at IS NOT NULL", orderBy: 'next_at, event_id', limit: 1 })[0];
      const old = legacy ? Date.parse(legacy.next_at) : null;
      return current === null ? old : old === null ? current : Math.min(current, old);
    },

    transaction: fn => {
      const mark = records.changeMark?.() ?? null;
      try { return transaction(() => {
        if (pending) return fn();
        pending = new Map();
        pendingRetractions = new Set();
        try { const result = fn(); flush(); return result; }
        finally { pending = null; pendingRetractions = null; }
      }); } catch (error) {
        // A record owner can apply a batch before its enclosing SQL transaction refuses. Re-read committed
        // state after rollback, rather than retaining a removed payload or the premature reopened handoff.
        firstHandoffChecked = false; reviewNextKept = false;
        cardsKept = null; reviewCache = null; deliveryDueCache = null;
        records.forgetCached?.(error, mark);
        throw error;
      }
    },
  };
  return api;
}
