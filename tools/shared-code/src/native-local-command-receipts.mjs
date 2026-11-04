// Original local mutation evidence beside the existing native command journal.
// A local domain write and its exact protected result share one transaction.
// Recovery finishes only supplied idempotent bookkeeping, never replays the
// mutation or an external tool effect. No private input enters receipt facts.
import { canonical, identityOf } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';
const resultIdentity = value => identityOf(canonical(value));
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const json = value => JSON.parse(JSON.stringify(value));
const sync = (value, owner) => { if (value && typeof value.then === 'function') throw new TypeError(`Native local ${owner} must be synchronous.`); return value; };
export function nativeLocalCommandReceipts({ records, transaction, read, write, context, current, finish = async () => {}, operations, requestOperations = [], receiptPrefix, requestBody = value => value, requestValue = value => value, captureResult = null, forget = null, rebuild = {} }) {
  if(captureResult!==null&&(typeof captureResult!=='function'||captureResult.constructor?.name==='AsyncFunction'))throw new TypeError('Original local result capture must be synchronous.');
  if(captureResult!==null&&(typeof forget!=='function'||forget.constructor?.name==='AsyncFunction'))throw new TypeError('A journal that captures local results needs the synchronous receipt forget.');
  const allowed = new Set(operations), requests = new Set(requestOperations);
  if (!allowed.size || typeof receiptPrefix !== 'string' || !/^[a-z][a-z-]+$/.test(receiptPrefix)) throw new TypeError('Local mutation receipts require declared operations and their own metadata prefix.');
  if (!records || ![transaction, read, write, context, current, finish, requestBody, requestValue].every(value => typeof value === 'function'))
    throw new TypeError('Native local mutation receipts require the actual records, transaction, context and completion owners.');
  if ([transaction, read, write, context, requestBody, requestValue].some(value => value.constructor?.name === 'AsyncFunction'))
    throw new TypeError('Native local mutation transactions, facts, context and formatting must be synchronous.');
  const identity = operation => {
    const c = sync(context(), 'context');
    // A session that keeps nothing (native_nonretaining) keeps no receipt or reply either; its lost commands stay unknown.
    if (!allowed.has(operation) || c?.operation !== operation && !requests.has(c?.operation) || c.native_nonretaining === true) return null;
    if (![c.permit_id, c.input_identity, c.owner, c.resource].every(value => typeof value === 'string' && value)
      || !['number', 'string'].includes(typeof c.generation)) throw fail('The original local mutation has no admitted identity.', 403);
    return { owner: c.owner, resource: c.resource, generation: c.generation, permit_id: c.permit_id, input_identity: c.input_identity, operation: c.operation };
  };
  const original = () => {
    const c = sync(context(), 'context');
    if (!allowed.has(c?.operation) && !requests.has(c?.operation)) return null;
    const row = sync(read(`${receiptPrefix}:${c.permit_id}`), 'receipt reads'), source = row && identity(row.mutation);
    return source && Object.entries(source).every(([key, value]) => row[key] === value) ? row : null;
  };
  // The kept response as { result } (a null response is kept too), or null once it was erased.
  const resultOf = row => {
    const result = records.read(`resource-command-result:${row.permit_id}`)?.value?.result;
    if (result === undefined) return null;
    if (resultIdentity(result) !== row.result_identity) throw fail('The original local response changed after commitment.');
    return { result };
  };
  return {
    // A command whose writes span awaits marks itself begun before its first write, and commits its answer as its last
    // step: a lost command with no mark wrote nothing (aborted), one begun but not committed is unknown.
    begin({ operation } = {}) {
      const principal = identity(operation);
      if (!principal) return;
      transaction(() => {
        const held = sync(read(`${receiptPrefix}:${principal.permit_id}`), 'receipt reads');
        if (held && held.begun !== operation && original()?.mutation !== operation) throw fail('The original local command already names different work.');
        if (!held) sync(write(`${receiptPrefix}:${principal.permit_id}`, { ...principal, begun: operation }), 'receipt writes');
      });
    },
    // raw: a route whose own answer is not an HTTP envelope keeps that answer as it is.
    commit(change, { operation, source, spaces = [], status = 200, headers = { 'content-type': 'application/json' }, raw = false } = {}) {
      const principal = identity(operation);
      if (!principal) return change();
      const mark = records.changeMark?.() ?? null;
      try { return sync(transaction(() => {
        const held = sync(read(`${receiptPrefix}:${principal.permit_id}`), 'receipt reads');
        const previous = original();
        if (held && (held.begun ? held.begun !== operation || !Object.entries(principal).every(([key, value]) => held[key] === value)
          : !previous || previous.mutation !== operation || previous.source !== source))
          throw fail('The original local command already names different work.');
        if (previous) {
          const kept = resultOf(previous);
          if (!kept) throw fail('The original local response was erased.', 410);
          const { result } = kept;
          return requests.has(principal.operation) && !previous.raw ? sync(requestValue(result.body, { operation }), 'response formatting') : result;
        }
        // Only a real model-declared source key can own derived output. Rules
        // and schedules need not declare erasable words; their replies then
        // keep the ordinary protected-result owner's independent key.
        const erasureSource = source ? records.erasureOwnerOf?.(source) : null;
        const changed = change();
        if (changed && typeof changed.then === 'function') throw new TypeError('Native local mutation commits must be synchronous.');
        // A write that answers nothing is kept, and answered, as null.
        const answer = changed === undefined ? null : json(changed);
        const enveloped = requests.has(principal.operation) && !raw;
        const body = enveloped ? requestBody(answer, { operation }) : answer;
        if (body && typeof body.then === 'function') throw new TypeError('Native local response formatting must be synchronous.');
        const result = enveloped ? { native_response: true, status, headers: json(headers), body: json(body) } : answer;
        const metadata = { ...principal, mutation: operation, source, spaces: [...new Set(spaces)], result_identity: resultIdentity(result), ...(enveloped || !requests.has(principal.operation) ? {} : { raw: true }) };
        records.write([{ id: `resource-command-result:${principal.permit_id}`, type: 'resource-command-result',
          value: { ...(erasureSource ? { source_record: erasureSource } : {}), value: { result } } }], { actor: { by: 'resource-result-owner' }, unwatched: true });
        // The journal is given the command's answer here only when the receipt keeps the whole of it: a write whose answer
        // is read after it (rebuild) leaves the journal to keep the answer the command returns. A command the journal
        // commits in this same transaction is answered from the journal alone, so it keeps no receipt fact of its own (a
        // begun mark is forgotten): the fact was a third copy of every such command's receipt (2026-10-18).
        if(captureResult&&typeof rebuild[operation]!=='function'){
          sync(captureResult(sync(context(),'context'),result),'original result capture');
          if(held)sync(forget(`${receiptPrefix}:${principal.permit_id}`),'receipt forget');
        }
        else sync(write(`${receiptPrefix}:${principal.permit_id}`, metadata), 'receipt writes');
        return answer;
      }), 'transactions'); } catch (error) {
        // The SQL owner rolls back, and the record projection must forget any
        // values observed from that abandoned transaction too.
        records.forgetCached?.(error, mark);
        throw error;
      }
    },
    async reconcile(input = {}) {
      if (!allowed.has(context()?.operation) && !requests.has(context()?.operation) || context()?.native_nonretaining === true) return { state: 'unknown' };
      await current(context().operation, input, true);
      const row = original();
      if (!row) {
        // The domain write and its receipt share one transaction, and the command journal asks only once no live
        // invocation holds the command: no receipt at all proves the write never happened. A receipt that names other
        // work, or a command begun and not committed (begin), stays unknown, never another command's outcome.
        const c = context();
        return read(`${receiptPrefix}:${c.permit_id}`) ? { state: 'unknown' } : { state: 'aborted' };
      }
      resultOf(row); // Refuse changed protected output before any bookkeeping.
      await finish({ spaces: row.spaces });
      await current(context().operation, input, true);
      // Erasure or withdrawal may have completed while bookkeeping awaited.
      const final = resultOf(row);
      // A write whose answer also shows what was read after it keeps only its own part; that read is made again here,
      // reading only (`rebuild` per mutation, the same read the answer made).
      if (final && typeof rebuild[row.mutation] === 'function') return { state: 'committed', result: await rebuild[row.mutation](final.result, input) };
      return final ? { state: 'committed', result: final.result }
        : { state: 'committed', result_withheld: true, result_identity: row.result_identity };
    },
    original,
  };
}
