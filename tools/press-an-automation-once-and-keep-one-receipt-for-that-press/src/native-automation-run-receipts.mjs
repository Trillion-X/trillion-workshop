// One original press -> one original native child command. This is binding
// evidence beside the existing journal, never a queue or another execution path.
import { canonical, identityOf } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const operations = new Set(['rules:run', 'schedules:run', 'automations:request']);
const CHILD_FIELDS = ['owner', 'resource', 'book', 'generation', 'permit_id', 'operation', 'input_identity'];
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => canonical(a) === canonical(b);
const synchronous = value => {
  if (value && typeof value.then === 'function') throw new TypeError('Native run preparation must be synchronous with its original binding.');
  return value;
};

export function nativeAutomationRunReceipts({ transaction, read, write, context, current, childCommand, readChild, finish, captured }) {
  if (![transaction, read, write, context, current, childCommand, readChild, finish].every(value => typeof value === 'function')
    || typeof captured?.original !== 'function' || typeof captured?.reconcile !== 'function')
    throw new TypeError('Native automation runs require original command binding, protected readback and canonical local completion owners.');
  if (childCommand.constructor?.name === 'AsyncFunction') throw new TypeError('The native child-command builder must be synchronous.');
  const identity = () => {
    const c = context();
    if (!operations.has(c?.operation)) return null;
    if (![c.owner, c.resource, c.permit_id, c.input_identity].every(value => typeof value === 'string' && value)
      || !['string', 'number'].includes(typeof c.generation)) throw fail('The run has no original admitted parent command.', 403);
    return { owner: c.owner, resource: c.resource, generation: c.generation, permit_id: c.permit_id,
      input_identity: c.input_identity, operation: c.operation };
  };
  const original = () => {
    const principal = identity();
    if (!principal) return null;
    const row = read(`resource-automation-run:${principal.permit_id}`);
    return row && Object.entries(principal).every(([key, value]) => row[key] === value) ? row : null;
  };
  return {
    prepare({ rule_id, schedule_id, source_identity, then, input, job, pressed_at }) {
      const principal = identity();
      if (!principal) throw fail('Native run preparation requires its own admitted automation command.', 403);
      if (Boolean(rule_id) === Boolean(schedule_id) || typeof source_identity !== 'string' || !source_identity
        || typeof pressed_at !== 'string' || !Number.isFinite(Date.parse(pressed_at))) throw fail('The original automation source and press time are required.', 400);
      const request_key = `run-now:${principal.permit_id}`;
      // The mounted native execution owner supplies the SAME builder used by
      // its live run path, including all tool/workflow input fields. No private
      // input, job label, credential or duplicated principal is kept here.
      const target = synchronous(childCommand({ then, input, job, request_key }));
      if (!target || !['tools:run', 'workflows:start'].includes(target.operation)
        || ![target.owner, target.resource, target.permit_id, target.input_identity].every(value => typeof value === 'string' && value)
        || target.owner !== principal.owner || target.resource !== principal.resource || target.generation !== principal.generation
        || target.book !== null && typeof target.book !== 'string') throw fail('The original native child target is invalid.');
      const child = clone(Object.fromEntries(CHILD_FIELDS.map(key => [key, target[key]])));
      return transaction(() => {
        const held = read(`resource-automation-run:${principal.permit_id}`);
        if (held) {
          const previous = original();
          if (!previous || previous.source_identity !== source_identity || previous.rule_id !== rule_id || previous.schedule_id !== schedule_id
            || !equal(previous.child, child)) throw fail('The original press already names different automation work.');
          // Returning this key to run/start would turn recovery into dispatch.
          throw fail('The original automation press requires outcome readback; it must not start again.', 503);
        }
        write(`resource-automation-run:${principal.permit_id}`, { ...principal, ...(rule_id ? { rule_id } : { schedule_id }),
          source_identity, request_key, pressed_at, child, binding_identity: identityOf(canonical([principal, source_identity, child, request_key, pressed_at])) });
        return { request_key, pressed_at };
      });
    },
    async reconcile(input = {}) {
      const principal = identity();
      if (!principal) return { state: 'unknown' };
      await current(principal.operation, input, true);
      if (captured.original()) return captured.reconcile(input);
      const row = original();
      if (!row) return { state: 'unknown' };
      if (row.binding_identity !== identityOf(canonical([principal, row.source_identity, row.child, row.request_key, row.pressed_at])))
        throw fail('The retained original automation press binding changed.');
      const outcome = await readChild(clone(row.child));
      await current(principal.operation, input, true);
      if (!outcome || outcome.state !== 'committed' || !Object.hasOwn(outcome, 'result')) return { state: 'unknown' };
      // The canonical finish owner checks the original source incarnation and
      // captures the parent response in its existing local receipt transaction.
      // This result is the accepted original start, which may still be working.
      await finish({ rule_id: row.rule_id, schedule_id: row.schedule_id, source_identity: row.source_identity,
        request_key: row.request_key, started: outcome.result, ran_at: row.pressed_at });
      return captured.reconcile(input);
    },
    original,
  };
}
