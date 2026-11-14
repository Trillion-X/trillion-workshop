// tools/keep-a-lists-rows-in-one-of-the-accounts-databases-while/do-work/move-a-list-into-its-own-store.mjs
//
// Purpose
//   Move one list's rows out of the account's primary store into a store of its own, through the records door only.
//   The new engine keeps a list's own store as a record domain (trillion-rust src/storage/record_store_resources/
//   domains.rs, "Old trillion src/placed-lists.mjs:10-41 separated a list's authoritative operations from its physical
//   supply"): a records call that names `scope: {id, incarnation, generation}` reads and writes that history's own
//   file. This is old trillion's `move` and `continueMoves` (src/placed-lists.mjs invariant 4) on that road: a page at a
//   time, where it has reached kept in a row, so an interrupted move resumes there.
//
// Non-negotiable invariants
//   1. The primary is never changed before the list's own store holds every row equal to it. `copy` writes only into
//      the scope; `verify` reads both sides and compares each row's value as canonical JSON; a row that differs
//      (written in the primary after its page was copied) is copied again and verified again.
//   2. Removing the rows from the primary is its own step (`remove`), refused unless `verify` passed on the same
//      progress row. It deletes only rows the scope holds equal, a page at a time; a row that differs is copied again
//      first.
//   3. Every copy write carries a request key made from the list, the step and the page it starts after, so a retried
//      page is the same change, never a second one.
//   4. Where the move has reached is one row in the primary, `list-move:<row_type>` of type `list-move`: state, the
//      cursor, counts and the scope. A run reads it first and goes on from there.
//   5. A move changes no row. The list's own definition rows (type `list` whose `row_type` is this list) are written
//      into the scope after its rows, so a row the primary holds from before the list's choices changed (a person's
//      list held a choice value its definition no longer names, refused value_outside_choices when the definition
//      went first on 2026-11-14) arrives as it is, and the definition checks every write after the move.
//
// Shapes
//   moveList(op, { rowType, scope, step, pageSize, say }) -> progress
//     op(address, method, input, requestKey) -> answer        the records door (use-trillion-from-a-shell opWhole)
//     step: 'copy' | 'verify' | 'remove'                       copy also verifies; remove needs a verified progress
//   canonical(value) -> string                                 JSON with object keys sorted, for comparing rows
//
// Run
//   node move-a-list-into-its-own-store.mjs <row_type> [copy|verify|remove]
import { pathToFileURL } from 'node:url';
import { makeHashCodeHexFromBytes } from 'trillion-workshop/tools/content-identity/read-data/identity.mjs';

const RECORDS = '@own-records';
const PROGRESS_TYPE = 'list-move';
// How many id ranges are copied at once, and the most bytes of rows one write carries: a records write takes 1 MiB of
// records (trillion-rust src/mcp/settings.json `request_bytes`), a read answer 64 KiB (src/mcp.rs MAX_MESSAGE_BYTES).
const PARTS = 8;
const WRITE_BYTES = 700_000;

const hashOf = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text));

export const canonical = value => JSON.stringify(value, (_, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));

const rowOf = record => ({ id: record.id, type: record.type, value: record.value });

export async function moveList(op, { rowType, scope, step = 'copy', pageSize = 256, parts = PARTS, writeBytes = WRITE_BYTES, say = () => {} }) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(rowType)) throw new Error(`${rowType} is not a list's row type`);
  if (!scope?.id || !scope?.incarnation || !Number.isInteger(scope?.generation)) throw new Error('the scope names its id, incarnation and generation');
  const type = `record:${rowType}`;
  const progressId = `${PROGRESS_TYPE}:${rowType}`;
  const readScope = { scope: { id: scope.id, incarnation: scope.incarnation, generation: scope.generation } };
  const writeScope = { scope: { ...readScope.scope, create: true } };
  const fresh = what => `${progressId}:${what}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const held = await op(RECORDS, 'records:read', { id: progressId, type: PROGRESS_TYPE }, fresh('read'));
  let progress = held?.value ?? { row_type: rowType, scope: readScope.scope, state: 'copying', after: null, copied: 0 };
  if (progress.scope?.id !== scope.id) throw new Error(`${rowType} is already moving into ${progress.scope?.id}`);
  const save = async changes => {
    progress = { ...progress, ...changes, at: new Date().toISOString() };
    await op(RECORDS, 'records:write', { records: [{ id: progressId, type: PROGRESS_TYPE, value: progress }] }, fresh('progress'));
  };
  const primaryPage = (after, bounds = {}) => op(RECORDS, 'records:list', { type, limit: pageSize, ...bounds, ...(after ? { after } : {}) }, fresh('list'));
  const scopePage = (after, bounds = {}) => op(RECORDS, 'records:list', { ...readScope, type, limit: pageSize, ...bounds, ...(after ? { after } : {}) }, fresh('scope-list'));
  const inScope = id => op(RECORDS, 'records:read', { ...readScope, id, type }, fresh('check'));
  const copyRows = (rows, key) => op(RECORDS, 'records:write', { ...writeScope, records: rows.map(rowOf) }, key);
  const same = async row => {
    const there = await inScope(row.id);
    return Boolean(there?.value) && canonical(there.value) === canonical(row.value);
  };

  const definitions = async () => {
    const lists = [];
    let after = null;
    do {
      const answer = await op(RECORDS, 'records:list', { type: 'list', limit: pageSize, ...(after ? { after } : {}) }, fresh('lists'));
      lists.push(...(answer.records ?? []).filter(list => list.value?.row_type === rowType));
      after = answer.next ?? null;
    } while (after);
    return lists;
  };

  if (step === 'copy' && progress.state === 'copying') {
    if (progress.after === null && !progress.copied) {
      // The rows go in before their definition (invariant 5): a definition held in the scope from an earlier start is
      // taken out first, so no row is checked against choices it was written before.
      const held = [];
      for (const list of await definitions()) {
        // A read never makes a store, so before the first write the list's own store is not there and holds nothing.
        const there = await op(RECORDS, 'records:read', { ...readScope, id: list.id, type: 'list' }, fresh('definition'))
          .catch(error => (/original_workspace_source_unavailable/.test(error.message) ? null : Promise.reject(error)));
        if (there?.value) held.push(list);
      }
      if (held.length) await op(RECORDS, 'records:write', { ...readScope, records: held.map(list => ({ id: list.id, type: list.type, value: null })) }, fresh('definition-out'));
    }
    // The list's ids are cut into `parts` ranges once (the plan, kept in the progress row), and the ranges are copied at
    // the same time: a page answer holds what fits one message (a few large rows), so one cursor alone reads slowly.
    if (!progress.parts) {
      const ids = [];
      let after = null;
      do {
        const answer = await op(RECORDS, 'records:list', { type, fields: [], limit: 1000, ...(after ? { after } : {}) }, fresh('ids'));
        ids.push(...(answer.records ?? []).map(row => row.id));
        after = answer.next ?? null;
      } while (after);
      const cuts = [...new Set(Array.from({ length: parts - 1 }, (_, at) => ids[Math.floor(((at + 1) * ids.length) / parts)]).filter(Boolean))]
        .sort().reverse();
      const ranges = cuts.length ? [{ above: cuts[0] }, ...cuts.slice(1).map((cut, at) => ({ above: cut, below: cuts[at] })), { below: cuts.at(-1) }] : [{}];
      await save({ parts: ranges.map((range, at) => ({ name: `part-${at}`, ...range })), cuts, planned: ids.length });
      say(`${rowType}: ${ids.length} rows, cut into ${ranges.length} ranges`);
    }
    // One range, greatest id first: rows are gathered across pages into one write of at most `writeBytes`, whose request
    // key is the BLAKE3 of its ids, so a write asked again after an interruption is the same change. Where the range has
    // reached is its own row, saved after each write.
    const copyRange = async range => {
      const partId = `${progressId}:${range.name}`;
      const kept = (await op(RECORDS, 'records:read', { id: partId, type: PROGRESS_TYPE }, fresh('part')))?.value ?? { after: null, copied: 0, done: false };
      if (kept.done) return kept.copied;
      let { after, copied } = kept, batch = [], bytes = 0, batchStart = after;
      const bounds = { ...(range.above ? { above: range.above } : {}), ...(range.below ? { below: range.below } : {}) };
      const flush = async (next, done) => {
        if (batch.length) await copyRows(batch, `${progressId}:copy:${hashOf(batch.map(row => row.id).join('\n'))}`);
        copied += batch.length;
        await op(RECORDS, 'records:write', { records: [{ id: partId, type: PROGRESS_TYPE, value: { ...range, after: next, copied, done } }] }, fresh('part-save'));
        batch = []; bytes = 0; batchStart = next;
      };
      for (;;) {
        const answer = await op(RECORDS, 'records:list', { type, limit: pageSize, ...bounds, ...(after ? { after } : {}) }, fresh('list'));
        const rows = (answer.records ?? []).map(rowOf);
        const next = answer.next ?? null;
        batch.push(...rows);
        bytes += rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0);
        after = next;
        if (!next) { await flush(null, true); break; }
        if (bytes >= writeBytes) await flush(next, false);
      }
      return copied;
    };
    const ranges = progress.parts;
    const counts = await Promise.all(ranges.map(range => copyRange(range).then(count => {
      say(`${rowType}: ${range.name} copied ${count}`);
      return count;
    })));
    // A cut is a row's own id, strictly outside both ranges beside it, so the cut rows are copied by themselves.
    const cutRows = [];
    for (const id of progress.cuts ?? []) {
      const row = await op(RECORDS, 'records:read', { id, type }, fresh('cut'));
      if (row?.value) cutRows.push(rowOf({ id, type, value: row.value }));
    }
    if (cutRows.length) await copyRows(cutRows, `${progressId}:copy:cuts:${hashOf(cutRows.map(row => row.id).join('\n'))}`);
    const lists = await definitions();
    if (lists.length) await copyRows(lists, fresh('copy-definition'));
    say(`${rowType}: ${lists.length} list definition row(s) in its own store`);
    await save({ state: 'copied', copied: counts.reduce((sum, count) => sum + count, 0) + cutRows.length, after: null });
    say(`${rowType}: copied ${progress.copied}`);
  }

  if ((step === 'copy' || step === 'verify') && ['copied', 'verified'].includes(progress.state)) {
    // Both stores page the type by id in the same order, so the page after the same cursor holds the same ids; a row
    // the scope page does not hold is read alone. The ranges of the copy are checked at the same time.
    const verifyRange = async range => {
      const bounds = { ...(range.above ? { above: range.above } : {}), ...(range.below ? { below: range.below } : {}) };
      let after = null, primary = 0;
      const differing = [];
      do {
        const [answer, theirs] = await Promise.all([primaryPage(after, bounds), scopePage(after, bounds)]);
        const rows = answer.records ?? [];
        const held = new Map((theirs.records ?? []).map(row => [row.id, row]));
        primary += rows.length;
        for (const row of rows) {
          const there = held.get(row.id);
          const equal = there ? canonical(there.value) === canonical(row.value) : await same(row);
          if (!equal) differing.push(row);
        }
        after = answer.next ?? null;
      } while (after);
      return { primary, differing };
    };
    for (let round = 0; ; round += 1) {
      const checked = await Promise.all((progress.parts ?? [{ name: 'all' }]).map(verifyRange));
      let primary = checked.reduce((sum, part) => sum + part.primary, 0);
      const differing = checked.flatMap(part => part.differing);
      for (const id of progress.cuts ?? []) {
        const row = await op(RECORDS, 'records:read', { id, type }, fresh('cut-check'));
        if (!row?.value) continue;
        primary += 1;
        if (!(await same({ id, type, value: row.value }))) differing.push(rowOf({ id, type, value: row.value }));
      }
      say(`${rowType}: verify round ${round}: ${primary} rows in the primary, ${differing.length} differ`);
      if (!differing.length) { await save({ state: 'verified', verified: primary, after: null }); break; }
      if (round >= 3) throw new Error(`${rowType}: ${differing.length} rows still differ after ${round + 1} rounds; first ${differing[0].id}`);
      for (let at = 0; at < differing.length; at += pageSize) await copyRows(differing.slice(at, at + pageSize), fresh(`recopy:${round}:${at}`));
    }
  }

  if (step === 'remove') {
    if (!['verified', 'removing'].includes(progress.state)) throw new Error(`${rowType} is ${progress.state}; remove needs a verified move`);
    // The home row first (trillion-rust records-routes.json `homes`): from it on, every call for the kind is answered in
    // the list's own store, and the rows left in the primary are reached only by `scope: null`.
    const homeId = `home:${type}`;
    await op(RECORDS, 'records:write', { records: [{ id: homeId, type: 'home', value: { kind: type, scope: readScope.scope } }] }, fresh('home'));
    const routed = await op(RECORDS, 'records:list', { type, limit: 1 }, fresh('routed'));
    if (routed?.scope?.id !== scope.id) {
      await op(RECORDS, 'records:write', { records: [{ id: homeId, type: 'home', value: null }] }, fresh('home-out'));
      throw new Error(`${rowType}: this engine does not answer ${type} from its home yet; nothing was removed`);
    }
    let removed = progress.removed ?? 0;
    const kept = progress.kept_newer ?? [];
    await save({ state: 'removing', removed });
    const primary = { scope: null };
    for (;;) {
      const rows = (await op(RECORDS, 'records:list', { ...primary, type, limit: pageSize }, fresh('left'))).records ?? [];
      if (!rows.length) break;
      for (const row of rows) {
        const there = await inScope(row.id);
        if (!there?.value) await copyRows([row], fresh(`late:${row.id}`));
        // Once the home is set the home answers: a row changed there since the copy is newer than the primary's, and
        // the primary's is kept in the primary's history, named here.
        else if (canonical(there.value) !== canonical(row.value)) kept.push(row.id);
      }
      await op(RECORDS, 'records:write', { ...primary, records: rows.map(row => ({ id: row.id, type: row.type, value: null })) }, `${progressId}:remove:${rows[0].id}:${rows.length}`);
      removed += rows.length;
      await save({ removed, kept_newer: kept });
      say(`${rowType}: removed ${removed} from the primary`);
    }
    await save({ state: 'moved', removed, kept_newer: kept });
  }
  return progress;
}

async function main([rowType, step = 'copy']) {
  const shell = await import('trillion-workshop/tools/use-trillion-from-a-shell/do-work/trillion.mjs');
  const credential = await shell.credentialFor();
  const client = shell.trillionClient({ door: shell.doorFor({ credential }), credential });
  // A busy engine answers selected_owner_unavailable when its writer's wait runs out, or original_command_outcome_unknown when
  // it cannot yet say whether a write landed, or original_result_unavailable when a read ran past its time; every answer
  // but a refusal of the input is a busy engine (a write the second computer did not acknowledge in time is refused
  // as current_workspace_rights_refused and rolled back, copies.rs before_domain_commit), and the same request key asked again
  // is the same change, so it is asked again after a pause, a bounded number of times.
  const op = async (address, method, input, requestKey) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await shell.opWhole(client, address, method, input, { requestKey }); } catch (error) {
        if (attempt >= 20 || /input_refused|outside_choices|needs_person/.test(error.message)) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(30, 2 ** attempt) * 1000));
      }
    }
  };
  const context = await op(RECORDS, 'records:list', { type: 'list', limit: 1 }, `${PROGRESS_TYPE}:${rowType}:generation:${Date.now()}`);
  const generation = context?.context?.generation;
  if (!Number.isInteger(generation)) throw new Error('the door named no account generation');
  const say = line => console.log(`${new Date().toLocaleTimeString()} ${line}`);
  const progress = await moveList(op, { rowType, step, scope: { id: `list-${rowType}`, incarnation: 'first', generation }, pageSize: 128, say });
  console.log(JSON.stringify(progress));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
}
