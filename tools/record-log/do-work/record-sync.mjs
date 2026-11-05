// parts/record-log/do-work/record-sync.mjs
//
// TWO COPIES OF ONE RECORD STORE MADE EQUAL BY TRADING ONE ROOT, THEN ONLY THE NET CHANGES, THEN ONLY THE BUCKETS THAT
// STILL DIFFER, SETTLING EVERY CONFLICT THE SAME WAY ON BOTH SIDES AND KEEPING THE VERSION THAT DID NOT WIN.
//
// Purpose
//   A device keeps its own copy of a person's records (the same record store over its own SQLite) so it reads them in
//   nanoseconds and keeps working while it is offline. A copy settles with the one it follows (usually the hosted store)
//   in bounded requests (settleWith asks, answerSettle answers): it sends its root, how far it took, and the net change
//   of its own rows since it last sent in acknowledged batches (netChanges: one envelope per record in each batch);
//   the other side applies each field only where it still holds what the change replaced, and answers with its root,
//   its net changes
//   after that position and, when they can be needed, its buckets. Only when the roots still differ (rows the other
//   side no longer keeps) does the copy ask for the records of exactly the buckets that differ, a bounded page per
//   request. A field both sides changed differently is settled by byContent on both sides (the same answer from the
//   same two values, so neither side leads), and both versions are kept in a `kept-apart` record beside it.
//
// Non-negotiable invariants
//   1. Both copies settle a conflict the same way without asking each other: byContent ranks a removal first (a record
//      one side removed stays removed) and then the lower JSON text; the version that lost is kept, never dropped.
//   2. Applying the same changes twice changes nothing (a field already holding the value is passed over), so a settle
//      cut off anywhere is simply sent again.
//   3. A settle sends bounded batches, advancing its send position only after each batch is acknowledged. A lost
//      acknowledgement safely replays the batch. A settle with nothing changed on either side writes no row anywhere.
//   4. The asking copy keeps its positions (`state`) and the caller stores them; the answering side keeps one position
//      per copy beside the store (copyPositions, never a record, so it never travels), written once per settle and only
//      when it moved. A row a copy wrote while taking the other side's changes is never sent back, and a copy's own rows
//      are never answered back to it.
//   5. Two stores with no leader (a person's store and a space's) take from each other one way at a time with
//      takeFromPeer, each keeping one position per peer; a device's copy uses the one-request settle.
//   6. Nothing here names a host, a route or a device: the asker is handed `send(request) -> answer`; the answering
//      side's policy on what a copy may change is its `apply`.
//   7. What crosses is the net change of each record, never every row, and every answer is bounded in rows and
//      characters.
//   8. Records taken by bucket are taken only when they add up to the buckets the other side said it holds: a group
//      of buckets is read whole (every page answering the same requested bucket checksums), summed the way the store sums itself, and
//      compared before anything is taken. Records that arrived changed are refused (status 409) with nothing taken;
//      a group the other side changed while it was read is asked again, and left for the next settle if it keeps
//      moving. Corruption on the way never becomes this copy's records.
//   9. Buckets that differ are merged by stamps both ways (record-stamps.mjs), never copied over: what the other side
//      holds later is taken here, and what this copy holds later, or the other side no longer holds at all (a store
//      that lost its storage, a store rebuilt from its kept history), goes back to it in the same settle. A settle
//      never undoes a later change on either side, so a copy that lost everything is filled again by its copies.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { bucketsThatDiffer, storeSums } from './record-digest.mjs';
import { envelopeStamp } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { stateFrom, merge, keptFrom, envelopeOfKept, sameKept } from './record-stamps.mjs';

const PAGE = 200;
// Buckets read and checked together before any is taken (1/16 of a store held at most), and how often a group the
// other side changed during the read is asked again in one settle.
const VERIFY_BUCKETS = 16;
const MOVED_TRIES = 3;
const bucketText = (buckets, bucket) => buckets.slice(bucket * 16, bucket * 16 + 16);
// A record as its stamped state: one kept before stamps counts as stamped before every stamped write.
const stamped = record => ({ type: record.type, value: record.value, meta: record.meta ?? { at: '' } });

// The keys of erasable records (erasable.mjs) travel beside the rows and records that need them, never as records:
// { keys: { id: key | null } } for the ids that have one (null: erased there), nothing when none does.
const keysBeside = (store, ids, from_page = null) => {
  const keys = ids.length ? (from_page === null ? store.erasureKeys?.(ids) : store.erasureKeys?.(ids, { from_page })) : null;
  return keys && Object.keys(keys).length ? { keys } : {};
};

/** The record type conflicts are kept in, unless a caller names its own. */
export const KEPT_APART = 'kept-apart';

/**
 * Whether the other copy's value wins a conflict: the same answer on both copies. Absent (removed) ranks first, then
 * the lower JSON text. Deterministic and symmetric: byContent(a, b) and byContent(b, a) never both hold.
 */
export function byContent(here, there) {
  const rank = value => (value === null || value === undefined ? '' : `~${JSON.stringify(value)}`);
  return rank(there) < rank(here);
}

/**
 * The net change of a run of log rows (oldest first): one envelope per record, carrying the stamped state those rows
 * left it in (record-stamps.mjs: each field touched with the stamp of its last write, and the floor when a whole write
 * or a removal was among them), and what it held before the first of them (`was` or `prior`, when every row said),
 * so a copy that changed it from something else meets a conflict and keeps both versions. A record changed back to
 * what it was still crosses: its stamps moved. Answers [{ id, envelopes }] (one row named for the last row given), or
 * [] when nothing changed.
 */
export function netChanges(rows) {
  const byId = new Map();
  const states = new Map();
  for (const row of rows) {
    row.envelopes.forEach((envelope, index) => {
      // A purge (this copy let go of a record its leader never held) crosses as nothing: what came before it is dropped.
      if (envelope.purge) { states.delete(envelope.id); return; }
      const given = stateFrom(envelope, envelopeStamp(row.id, envelope, index));
      states.set(envelope.id, states.has(envelope.id) && !envelope.exact ? merge(states.get(envelope.id), given) : given);
    });
  }
  for (const row of rows) {
    for (const envelope of row.envelopes) {
      if (envelope.purge) { byId.delete(envelope.id); continue; }
      const now = byId.get(envelope.id);
      if (envelope.remove || envelope.value !== undefined) {
        const after = envelope.remove ? null : { type: envelope.type, value: envelope.value };
        if (!now) { byId.set(envelope.id, { whole: true, before: envelope.prior ?? null, after, basis: 'prior' in envelope }); continue; }
        if (now.whole) { now.after = after; continue; }
        // A run of field changes before a whole value: what the record held before them is the whole value's prior with
        // those changes taken back.
        const prior = envelope.prior ?? null;
        const before = prior && { type: prior.type, value: { ...prior.value, ...now.was } };
        if (before) for (const field of now.added) delete before.value[field];
        byId.set(envelope.id, { whole: true, before, after, basis: now.basis && 'prior' in envelope });
        continue;
      }
      if (!now) {
        byId.set(envelope.id, { whole: false, type: envelope.type, set: { ...envelope.set }, unset: new Set(envelope.unset ?? []), was: { ...envelope.was }, added: new Set(envelope.added ?? []), basis: Boolean(envelope.was) });
        continue;
      }
      if (now.whole) {
        const value = { ...(now.after?.value ?? {}) };
        for (const field of envelope.unset ?? []) delete value[field];
        Object.assign(value, envelope.set ?? {});
        now.after = { type: envelope.type, value };
        continue;
      }
      for (const field of [...Object.keys(envelope.set ?? {}), ...(envelope.unset ?? [])]) {
        const first = !(field in now.was) && !now.added.has(field) && !(field in now.set) && !now.unset.has(field);
        if (first) { if (envelope.was && field in envelope.was) now.was[field] = envelope.was[field]; else now.added.add(field); }
      }
      for (const field of envelope.unset ?? []) { delete now.set[field]; now.unset.add(field); }
      for (const [field, value] of Object.entries(envelope.set ?? {})) { now.set[field] = value; now.unset.delete(field); }
      now.basis = now.basis && Boolean(envelope.was);
    }
  }
  const envelopes = [];
  for (const [id, change] of byId) {
    const state = states.get(id);
    if (state.floor !== '' || change.whole) {
      // A whole write or a removal among the rows (or a whole state a settle carried, whose fields were only ever set
      // one at a time, so it has no floor): the state they left, whole, with what came before when known.
      const kept = keptFrom(state);
      if (!kept) continue;
      envelopes.push({ ...envelopeOfKept(id, kept), ...(change.whole && change.basis ? { prior: change.before } : {}) });
      continue;
    }
    // Field changes only: each field touched, with its stamp and (when every row said) what it held before.
    const set = {};
    const unset = [];
    const stamps = {};
    let at = '';
    for (const [field, cell] of state.fields) {
      if (cell.removed) unset.push(field); else set[field] = cell.value;
      stamps[field] = cell.stamp;
      if (cell.stamp > at) at = cell.stamp;
    }
    for (const field of Object.keys(stamps)) if (stamps[field] === at) delete stamps[field];
    const was = Object.fromEntries(Object.entries(change.was).filter(([field]) => field in set || unset.includes(field)));
    const added = [...change.added].filter(field => field in set);
    envelopes.push({ id, type: state.type ?? change.type, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}), at, ...(Object.keys(stamps).length ? { stamps } : {}), ...(change.basis ? { was } : {}), ...(added.length ? { added } : {}) });
  }
  return envelopes.length ? [{ id: rows.at(-1).id, envelopes }] : [];
}

/**
 * What `store` wrote after `position` (one of its log row ids, or null), as the net change of up to `most_rows` rows and
 * about `chars` characters of them: { rows: [{ id, envelopes }] (one per record, or none), oldest, last, rows_read,
 * more }. Rows `leave_out(row)` names (an asking copy's own, already held there) are passed over but still move `last`.
 * What crosses to a peer is this, so a record changed a thousand times crosses once. `more`: rows remain after `last`.
 */
export function changesAfter(store, position = null, { most_rows = 5000, chars = SETTLE_CHARS, leave_out = null } = {}) {
  const rows = [];
  let oldest = null;
  let last = position;
  let more = true;
  let read = 0;
  let size = 0;
  while (more && read < most_rows && size < chars) {
    const asked = Math.min(PAGE, most_rows - read);
    const page = store.logAfter(last, { limit: asked, lazy: true, buffer_chars: () => chars - size });
    oldest = page.oldest;
    let pageRead = 0;
    more = false;
    for (const row of page.rows) {
      read += 1;
      pageRead += 1;
      last = row.id;
      if (leave_out?.(row)) continue;
      rows.push(row);
      size += JSON.stringify(row.envelopes).length;
      if (size >= chars) {
        // Older array-only stores keep their page semantics; the current owner looks only at later ids. No next
        // transaction is decoded just to learn whether another answer is needed.
        more = Array.isArray(page.rows) ? row !== page.rows.at(-1) : page.more;
        break;
      }
    }
    more = more || pageRead === asked;
  }
  const changes = netChanges(rows);
  return { rows: store.sharedChanges?.(changes) ?? changes, oldest, last, rows_read: read, more };
}

/**
 * Takes what `peer` ({ changesAfter(position) }, may be async: this module's changesAfter over the peer's store, any
 * transport) wrote since `seen` (the last of its log rows this store took, or null) into `store`, settling conflicts
 * with byContent and keeping both versions apart. The one thing a store keeps per peer is `seen`. Answers { seen,
 * took, rows_read, conflicts, gap } (gap: the peer no longer keeps every row since `seen`, so what it still differs in
 * is settled by bucket).
 */
export async function takeFromPeer(store, peer, seen = null, { actor = { by: 'sync' }, kept_apart = KEPT_APART } = {}) {
  const report = { seen, took: 0, rows_read: 0, conflicts: [], gap: false };
  for (let more = true; more;) {
    const answer = await peer.changesAfter(report.seen);
    if (report.seen === null || (answer.oldest !== null && answer.oldest > report.seen)) report.gap = true;
    report.rows_read += answer.rows_read;
    report.seen = answer.last;
    more = answer.more;
    if (!answer.rows.length) continue;
    const result = await store.applyChanges(answer.rows, { actor }, { prefer: byContent, keep_apart: kept_apart });
    report.took += answer.rows[0].envelopes.length;
    report.conflicts.push(...result.conflicts);
  }
  return report;
}

export const SETTLE_CHARS = 4_000_000;
const COPY_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const POSITIONS = 'record_copy_positions';

/** The answering side's positions: one row per copy that settled with it, beside the store, never a record. */
export function copyPositions(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${POSITIONS} (copy TEXT PRIMARY KEY, took_through TEXT, settled_at TEXT NOT NULL) WITHOUT ROWID`);
  const of = copy => sql.exec(`SELECT copy, took_through, settled_at FROM ${POSITIONS} WHERE copy = ?`, copy).toArray()[0] ?? null;
  return {
    of,
    list: () => sql.exec(`SELECT copy, took_through, settled_at FROM ${POSITIONS} ORDER BY copy`).toArray(),
    move(copy, tookThrough, at) {
      if (of(copy)?.took_through === tookThrough) return false;
      sql.exec(`INSERT INTO ${POSITIONS} (copy, took_through, settled_at) VALUES (?, ?, ?) ON CONFLICT (copy) DO UPDATE SET took_through = excluded.took_through, settled_at = excluded.settled_at`, copy, tookThrough, at);
      return true;
    },
    /** A copy that is gone (a device removed, a copy made by mistake): its row is taken away. */
    forget(copy) {
      const had = of(copy) !== null;
      if (had) sql.exec(`DELETE FROM ${POSITIONS} WHERE copy = ?`, copy);
      return had;
    },
  };
}

/**
 * Answers one settle request against `store`, the copy the asker follows. The request is either
 *   { copy, root, took_through, rows }  the asker's own net changes (applied here through `apply`, by default the
 *                                       store's applyChanges settling conflicts with byContent and keeping them apart),
 *                                       answered with this side's root and its net changes after took_through, its
 *                                       buckets when the asker may need them (roots differed, or its position is gone)
 *   { copy, want_buckets, after }       a bounded page of the records in those buckets, with this side's root and
 *                                       buckets as they stood when it was read
 *   { copy, forget: true }              the copy is gone: its position is taken away ({ forgotten })
 * `positions` (copyPositions) keeps how far each copy took, written once a settle has taken everything there was.
 * Optional synchronous `phase(label, work)` attributes existing work; it must return work() and preserve its errors.
 */
export function answerSettle(store, request, { apply = null, positions = null, now = () => new Date(), most_rows = 5000, chars = SETTLE_CHARS, kept_apart = KEPT_APART, phase = (_label, work) => work() } = {}) {
  const copy = String(request?.copy ?? '');
  if (!COPY_ID.test(copy)) throw Object.assign(new Error('A copy names itself with letters, digits, dots, dashes, colons or underscores.'), { status: 400 });
  if (request.forget === true) return { forgotten: positions ? positions.forget(copy) : false };
  if (phase('copy:shared-preparation', () => store.shareFields?.(kept_apart))?.more) {
    if (request.bounded_shared_fields === true) return { preparing: true };
    throw Object.assign(new Error('Your records are being prepared. Try again in a moment.'), { status: 503 });
  }
  if (Array.isArray(request.want_buckets)) {
    return phase('copy:bucket-selection', () => {
      const wanted = request.want_buckets.filter(bucket => Number.isInteger(bucket) && bucket >= 0);
      const { root, buckets } = store.checksum({ build: false });
      const page = store.recordsInBucketsPage(wanted, { after: typeof request.after === 'string' ? request.after : null, chars, key_owners: true });
      return { root, buckets, ...page, ...keysBeside(store, (page.records ?? []).map(record => record.id), page.records ?? null) };
    });
  }
  const rows = Array.isArray(request.rows) ? request.rows : [];
  const context = { actor: { by: 'settle', from_copy: copy } };
  const applying = () => {
    if (request.keys && typeof request.keys === 'object') store.takeErasureKeys?.(request.keys);
    return rows.length ? (apply ?? ((sent, how) => store.applyChanges(sent, how, { prefer: byContent, keep_apart: kept_apart })))(rows, context) : { applied: 0, conflicts: [] };
  };
  const result = rows.length || request.keys && typeof request.keys === 'object'
    ? phase('copy:change-payload', applying) : applying();
  const tookThrough = typeof request.took_through === 'string' ? request.took_through : null;
  // A known equal root already proves that the asker holds the same values and removal/field stamps. Its log
  // position can be older or absent after a restore; decoding that already-held history adds no state. Pending
  // uploads still take the ordinary path, and a checksum not yet built is never evidence of equality.
  if (!rows.length && typeof request.root === 'string') {
    const equalAnswer = phase('copy:equal-root', () => {
      const equal = store.checksum({ build: false });
      if (equal.root === null || equal.root !== request.root) return null;
      const last = store.lastLogId() ?? tookThrough;
      const oldest = store.logAfter(null, { limit: 0 }).oldest;
      const gap = tookThrough === null || (oldest !== null && oldest > tookThrough);
      if (positions && last !== tookThrough) positions.move(copy, last, now().toISOString());
      return { root: equal.root, rows: [], last, more: false, gap,
        applied: result.applied ?? 0, conflicts: result.conflicts ?? [], ...(gap ? { buckets: equal.buckets } : {}) };
    });
    if (equalAnswer) return equalAnswer;
  }
  return phase('copy:change-payload', () => {
    const taken = changesAfter(store, tookThrough, { most_rows, chars, leave_out: row => row.actor?.from_copy === copy });
    const gap = tookThrough === null || (taken.oldest !== null && taken.oldest > tookThrough);
    const { root, buckets } = store.checksum({ build: false });
    if (positions && !taken.more && taken.last !== tookThrough) positions.move(copy, taken.last, now().toISOString());
    return {
      root, rows: taken.rows, last: taken.last, more: taken.more, gap,
      ...keysBeside(store, taken.rows.flatMap(row => row.envelopes.map(envelope => envelope.id))),
      applied: result.applied ?? 0, conflicts: result.conflicts ?? [],
      ...(gap || request.root !== root || rows.length ? { buckets } : {}),
    };
  });
}

/**
 * Settles `copy` (a record store) with the copy it follows, reached through `send(request) -> answer` (answerSettle on
 * the other side: in this process, over HTTP, a worker message or the local network). Local changes cross in bounded,
 * acknowledged net-change batches; then a bounded page per request is used only for buckets that still differ.
 * state: { took_through, sent_through } kept by the caller. Conflicts here settle as there (byContent) and keep both
 * versions apart. Records taken by bucket are checked against the other side's buckets first (invariant 8). Answers
 * { state, root, equal, sent, took, buckets_taken, records_taken, buckets_moved, conflicts, gap, requests }.
 * Optional onProgress(state) durably keeps each acknowledged cursor before the next request. Upload positions move
 * only after every split batch of their source page is acknowledged; received positions move only after apply.
 */
export async function settleWith(copy, send, { id, state = {}, kept_apart = KEPT_APART, max_upload_rows = PAGE, max_upload_chars = SETTLE_CHARS, verify_buckets = VERIFY_BUCKETS, onProgress = null } = {}) {
  while (copy.shareFields?.(kept_apart)?.more) await Promise.resolve();
  const transmit = send;
  send = async request => {
    for (;;) {
      const answer = await transmit({ ...request, bounded_shared_fields: true });
      if (!answer.preparing) return answer;
      // The original bounded upload and cursor stay intact until the answering store finishes its bounded migration.
    }
  };
  const next = { took_through: state.took_through ?? null, sent_through: state.sent_through ?? null };
  let savedProgress = JSON.stringify(next);
  const keepProgress = async () => {
    if (!onProgress) return;
    const text = JSON.stringify(next);
    if (text === savedProgress) return;
    // Taken records are durable before their cursor. An interrupted callback safely replays the same page.
    await onProgress({ ...next });
    savedProgress = text;
  };
  const report = { sent: 0, took: 0, buckets_taken: 0, records_taken: 0, buckets_moved: 0, conflicts: [], gap: false, requests: 0 };
  // Source pages are bounded by log rows and characters. A single write can name more records than the wire limit,
  // so split its net envelopes too. Keep the log cursor before the page until every envelope batch is acknowledged;
  // after a crash the whole page may replay, which applyChanges handles idempotently.
  const uploadBatches = changes => {
    const batches = [];
    let envelopes = [];
    const flush = () => { if (envelopes.length) batches.push([{ id: changes[0].id, envelopes }]); envelopes = []; };
    for (const row of changes) for (const envelope of row.envelopes) {
      const candidate = [...envelopes, envelope];
      if (envelopes.length >= max_upload_rows || JSON.stringify([{ id: row.id, envelopes: candidate }]).length > max_upload_chars) {
        if (!envelopes.length) throw Object.assign(new Error(`Record ${envelope.id} exceeds the ${max_upload_chars}-character sync limit.`), { status: 413 });
        flush();
        if (JSON.stringify([{ id: row.id, envelopes: [envelope] }]).length > max_upload_chars) {
          throw Object.assign(new Error(`Record ${envelope.id} exceeds the ${max_upload_chars}-character sync limit.`), { status: 413 });
        }
      }
      envelopes.push(envelope);
      if (envelopes.length >= max_upload_rows) flush();
    }
    flush();
    return batches;
  };
  const takeAnswer = async answer => {
    report.gap ||= answer.gap;
    if (answer.keys) copy.takeErasureKeys?.(answer.keys);
    report.conflicts.push(...(answer.conflicts ?? []));
    if (answer.rows?.length) {
      const result = copy.applyChanges(answer.rows, { actor: { by: 'settle', from_leader: true } }, { prefer: byContent, keep_apart: kept_apart });
      report.took += answer.rows.reduce((count, row) => count + row.envelopes.length, 0);
      report.conflicts.push(...result.conflicts);
    }
    next.took_through = answer.last;
    await keepProgress();
  };
  let answer = null;
  let first = true;
  let moreLocal = true;
  while (moreLocal) {
    const page = changesAfter(copy, next.sent_through, {
      most_rows: max_upload_rows,
      chars: max_upload_chars,
      leave_out: row => row.actor?.from_leader,
    });
    const batches = uploadBatches(page.rows);
    if (!batches.length && first) batches.push([]);
    for (const rows of batches) {
      answer = await send({ copy: id, root: copy.checksum().root, took_through: next.took_through, rows, ...keysBeside(copy, rows.flatMap(row => row.envelopes.map(envelope => envelope.id))) });
      report.requests += 1;
      report.sent += rows.reduce((count, row) => count + row.envelopes.length, 0);
      first = false;
      await takeAnswer(answer);
    }
    // No own records in this source page still requires one request to receive the leader's changes.
    if (!batches.length && first) {
      answer = await send({ copy: id, root: copy.checksum().root, took_through: next.took_through, rows: [] });
      report.requests += 1;
      first = false;
      await takeAnswer(answer);
    }
    next.sent_through = page.last ?? next.sent_through;
    await keepProgress();
    moreLocal = page.more;
  }
  while (answer?.more) {
    answer = await send({ copy: id, root: copy.checksum().root, took_through: next.took_through, rows: [] });
    report.requests += 1;
    await takeAnswer(answer);
  }
  let mine = copy.checksum();
  // A store still building its checksum (record-log-store buildSums) answers none; the buckets wait until both know it.
  if (mine.root !== answer.root && answer.buckets && mine.buckets) {
    const differ = bucketsThatDiffer(mine.buckets, answer.buckets);
    // One group read whole and checked (invariant 8): { records } when every page answered the same group checksums and the
    // records add up to the buckets the other side gave, null when it moved while being read; a 409 when they do not.
    const readGroup = async group => {
      for (let tries = 0; tries < MOVED_TRIES; tries += 1) {
        const records = [];
        let seen = null;
        for (let after = null; ;) {
          const page = await send({ copy: id, want_buckets: group, after });
          report.requests += 1;
          if (seen !== null && (typeof page.buckets !== 'string' || typeof seen.buckets !== 'string' || group.some(bucket => bucketText(page.buckets, bucket) !== bucketText(seen.buckets, bucket)))) { seen = null; break; }
          seen ??= { root: page.root, buckets: page.buckets };
          records.push(...page.records);
          if (page.keys) copy.takeErasureKeys?.(page.keys);
          if (page.next === null) break;
          after = page.next;
        }
        if (seen === null) continue;
        const sums = storeSums();
        for (const record of records) {
          if (record.type !== null) sums.add(record.id, record.type, record.value);
          sums.stamps(record.id, null, record.meta ?? null);
        }
        const summed = sums.text();
        const wrong = group.filter(bucket => typeof seen.buckets !== 'string' || bucketText(summed, bucket) !== bucketText(seen.buckets, bucket));
        if (wrong.length) {
          throw Object.assign(new Error(`The records of ${wrong.length} bucket${wrong.length === 1 ? '' : 's'} arrived changed: they do not add up to what the other copy holds, so none were taken.`), { status: 409, refused: wrong });
        }
        return records;
      }
      report.buckets_moved += group.length;
      return null;
    };
    for (let at = 0; at < differ.length; at += verify_buckets) {
      const group = differ.slice(at, at + verify_buckets);
      const records = await readGroup(group);
      if (!records) continue;
      const theirs = new Map(records.map(record => [record.id, stamped(record)]));
      if (records.length) {
        const merged = copy.applyChanges([{ id: 'settle', envelopes: records.map(record => envelopeOfKept(record.id, stamped(record))) }], { actor: { by: 'settle', from_leader: true } });
        report.records_taken += merged.applied;
      }
      const back = copy.recordsInBuckets(group)
        .filter(record => !sameKept(stamped(record), theirs.get(record.id) ?? null))
        .map(record => envelopeOfKept(record.id, stamped(record)));
      for (const rows of uploadBatches([{ id: copy.lastLogId(), envelopes: back }])) {
        answer = await send({ copy: id, root: copy.checksum().root, took_through: next.took_through, rows, ...keysBeside(copy, rows.flatMap(row => row.envelopes.map(envelope => envelope.id))) });
        report.requests += 1;
        report.sent += rows[0].envelopes.length;
        await takeAnswer(answer);
      }
      // What the other side would not take (its own rule on what a copy may change) stays as it holds it: those
      // buckets are taken from it exactly, as checked.
      const kept = copy.checksum().buckets;
      const refused = back.length ? group.filter(bucket => bucketText(kept, bucket) !== bucketText(answer.buckets ?? '', bucket)) : [];
      const exact = refused.length ? await readGroup(refused) : null;
      if (exact) {
        const held = new Set(exact.map(record => record.id));
        if (exact.length) copy.takeRecords(exact, { actor: { by: 'settle', from_leader: true } });
        const gone = copy.recordsInBuckets(refused).filter(record => !held.has(record.id)).map(record => ({ id: record.id, type: record.type, value: null }));
        if (gone.length) copy.takeRecords(gone, { actor: { by: 'settle', from_leader: true } });
        report.records_taken += exact.length + gone.length;
      }
      report.buckets_taken += group.length;
    }
    next.sent_through = copy.lastLogId() ?? next.sent_through;
    await keepProgress();
    mine = copy.checksum();
  }
  return { state: next, root: mine.root, ...report, equal: mine.root !== null && mine.root === answer.root };
}
