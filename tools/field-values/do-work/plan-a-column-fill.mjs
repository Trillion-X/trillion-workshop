// tools/field-values/do-work/plan-a-column-fill.mjs
//
// Purpose: fill one column of a list row by row by asking the person's sources in their order, stopping at the first
// answer that passes their check (a waterfall). A run of this tool asks nothing itself: it answers the next calls to
// make (each a Workshop tool and its input, built from the row), and is run again with what those calls answered,
// until every row is filled, skipped or out of sources. So it pays only for the sources it must ask, each row asks one
// source at a time, and the caller's AI runs the calls through tools:run with the request keys given here.
//
// Non-Negotiable Invariants:
//   1. A row that does not meet `run_if` is never asked about, and a row that already has a value is left alone while
//      keep_existing holds (the default), so filled cells never spend again.
//   2. Sources are asked strictly in order; a later source is asked only after every earlier one answered without a
//      value that passes `accept`, failed, or could not be asked because the row lacks an input it needs.
//   3. A call's request key is the content identity of its row, source, tool and input, so the same call asked again
//      (a retry, a second run) carries the same key and is never paid for twice.
//   4. A filled value comes back as an offer with its source (the source's kind, `source` unless it says another), in
//      the shape settle-field-values reads, so the precedence decides whether it may replace anything.
//   5. When the same rejected answer keeps coming back (`stop_after_same_failure` times), the row stops asking.
import { canonicalJson, makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import { isEmpty, readAt } from './row-paths.mjs';

/** Whether an answer passes the person's check: the accept tree over { value }. */
function passes(accept, value, operators) {
  if (!accept) return true;
  const found = filterRecords({ records: [{ value }], fields: [{ id: 'value', kind: accept.kind, path: ['value'] }], tree: accept.tree, operators });
  return found.matches.length === 1;
}

/** A source's input for one row, or the names of the inputs the row lacks. */
function inputFor(source, record) {
  const input = {};
  const missing = [];
  for (const [name, from] of Object.entries(source.input ?? {})) {
    const value = Object.hasOwn(from, 'value') ? from.value : readAt(record, from.from);
    if (isEmpty(value)) missing.push(name);
    else input[name] = value;
  }
  return { input, missing };
}

/** The next calls to make, the values already found, and the rows skipped or out of sources. */
export function planAColumnFill(request) {
  const { records, field, sources, operators } = request;
  const keepExisting = request.keep_existing !== false;
  const sameFailureLimit = request.stop_after_same_failure ?? null;
  const mostCalls = request.most_calls ?? Number.POSITIVE_INFINITY;
  const runIf = request.run_if
    ? new Set(filterRecords({ records, fields: request.fields, tree: request.run_if, operators }).matches)
    : null;
  const attempts = new Map();
  for (const attempt of request.attempts ?? []) attempts.set(JSON.stringify([attempt.row, attempt.source]), attempt);

  const calls = [];
  const filled = [];
  const skipped = [];
  const exhausted = [];
  let waiting = 0;
  let spent = 0;
  for (const attempt of request.attempts ?? []) spent += typeof attempt.cost === 'number' ? attempt.cost : 0;

  records.forEach((record, at) => {
    const row = readAt(record, request.id_path);
    if (runIf && !runIf.has(at)) { skipped.push({ row, why: 'run_if does not hold' }); return; }
    if (keepExisting && !isEmpty(readAt(record, field.path ?? [field.id]))) { skipped.push({ row, why: 'already has a value' }); return; }
    const tried = [];
    const rejected = new Map();
    for (const source of sources) {
      const attempt = attempts.get(JSON.stringify([row, source.id]));
      if (!attempt) {
        const { input, missing } = inputFor(source, record);
        if (missing.length > 0) { tried.push({ source: source.id, outcome: `cannot ask: the row has no ${missing.join(', ')}` }); continue; }
        if (calls.length >= mostCalls) { waiting += 1; return; }
        calls.push({ row, source: source.id, tool: source.tool, input, cost: source.cost ?? null, request_key: makeHashCodeHexFromJson({ row, source: source.id, tool: source.tool, input }) });
        return;
      }
      if (typeof attempt.error === 'string') { tried.push({ source: source.id, outcome: `failed: ${attempt.error}` }); continue; }
      const value = readAt(attempt.answer, source.answer_path ?? []);
      if (isEmpty(value)) { tried.push({ source: source.id, outcome: 'no answer' }); continue; }
      if (passes(request.accept, value, operators)) {
        filled.push({ row, field: field.id, value, answered_by: source.id, offer: { row, field: field.id, value, source: { kind: source.kind ?? 'source', by: source.id } } });
        return;
      }
      tried.push({ source: source.id, outcome: 'answer did not pass the check', value });
      const seen = (rejected.get(canonicalJson(value)) ?? 0) + 1;
      rejected.set(canonicalJson(value), seen);
      if (sameFailureLimit !== null && seen >= sameFailureLimit) {
        exhausted.push({ row, why: `the same answer failed the check ${seen} times`, tried });
        return;
      }
    }
    exhausted.push({ row, why: 'no source gave an answer that passes the check', tried });
  });

  return {
    calls,
    filled,
    skipped,
    exhausted,
    waiting,
    done: calls.length === 0 && waiting === 0,
    cost: { spent, next: calls.reduce((sum, call) => sum + (call.cost ?? 0), 0) },
  };
}
