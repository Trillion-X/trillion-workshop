// A delivered source may belong to several resources behind one connection. Every route comes from the complete
// paginated proof tree declared by its owner. Partial discovery never subscribes; provider acknowledgements are
// kept per route. Intent, connection incarnation and task generation fence slow replies across stop and reconnect.
// Provider subscriptions can be shared by several Trillion accounts. Stopping here removes only this account's
// routes; it never deletes the shared provider subscription on the strength of an eventually consistent KV count.
import { buildInvocation, WorkshopError } from './workshop.mjs';
import { selectDeclaredValue } from '../parts/ui/read-data/declared-selector.ts';
import { withoutSecrets } from './scheduler.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const revision = row => row?.control_revision ?? 0;
const proofError = message => Object.assign(new WorkshopError(message), { restart_proof: true });
const keyFor = id => `event-listen:${id}`;
const scalar = value => (text(value) || typeof value === 'number') ? String(value) : null;
const read = (value, selector) => {
  const found = selectDeclaredValue(value, selector);
  return object(found) && found.selector_contract_error ? undefined : found;
};
const later = (now, failures) => now + Math.min(60_000 * 2 ** Math.min(failures, 6), 3_600_000);
const serial = () => {
  const pending = new Map();
  return (key, work) => {
    const next = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    pending.set(key, next);
    const clear = () => { if (pending.get(key) === next) pending.delete(key); };
    next.then(clear, clear);
    return next;
  };
};
export const hasRouteCollection = source => object(source?.route_key_proof?.collection);

export function makeRouteListeners({ facts, routes, workshop, connections, connection = null, now, rearm, keepAlive = null }) {
  const control = serial(), registration = serial(), running = new Map(), background = new Map();
  const currentConnection = async source => {
    const id = source.connects_with?.connection_id;
    // The source's own connection, read alone: asking for every connection costs more with each one the person adds.
    const found = connection ? await connection(id) : (await connections()).find(item => item.connection_id === id);
    if (found?.vendor !== source.connects_with.vendor) return null;
    return found?.status === 'connected' && text(found.connected_at) ? `${id}:${found.connected_at}` : null;
  };
  const changed = source => Object.assign(new WorkshopError(`${source.label} was stopped or its connection changed during setup.`), { retryable: false });
  async function wanted(source, held) {
    const row = await facts.read(keyFor(source.id));
    if (revision(row) !== revision(held) || row?.stop_requested || row?.connection_revision !== held.connection_revision
      || await currentConnection(source) !== held.connection_revision) throw changed(source);
    return row;
  }
  const save = (source, held, change) => control(source.id, async () => {
    const row = await wanted(source, held);
    const next = { ...row, ...change };
    await facts.write(keyFor(source.id), next);
    return next;
  });
  async function removeRoutes(source, keys) {
    await registration(source.id, async () => {
      const current = await facts.read(keyFor(source.id));
      for (const key of keys) {
        if (!current?.stop_requested && (current?.registered_route_keys ?? []).includes(key)) continue;
        await routes.remove(source.id, key, { revision: revision(current) });
      }
    });
  }

  async function task(source, held, purpose, tool_id, input, acknowledged = null) {
    const key = `event-listen-task:${source.id}:${purpose}`;
    const entry = await control(source.id, async () => {
      await wanted(source, held);
      const before = await facts.read(key);
      const reusable = revision(before) === revision(held) && before?.connection_revision === held.connection_revision && before?.tool_id === tool_id && same(before.input, input);
      if (reusable && before.retry_at > now().getTime()) throw Object.assign(new WorkshopError(before.problem), { retry_at: before.retry_at, ...(before.retryable === false ? { retryable: false } : {}) });
      if (reusable && ['working', 'scheduled', 'completed'].includes(before.state)) return before;
      const generation = (before?.generation ?? 0) + 1;
      const next = { source_id: source.id, purpose, tool_id, input, at: held.setup_at, control_revision: revision(held), connection_revision: held.connection_revision,
        generation, state: 'working', failures: reusable ? before.failures ?? 0 : 0,
        request_key: `event-route:${source.id}:${revision(held)}:${purpose}:${generation}` };
      await facts.write(key, next);
      return next;
    });
    let result;
    try {
      result = entry.task_id ? await workshop.read({ task_id: entry.task_id })
        : await workshop.run({ tool_id, input, request_key: entry.request_key, wait_seconds: 30, job: `Set up incoming events from ${source.label}` });
    } catch (error) { result = { state: 'working', error: withoutSecrets(error), ...(error.retryable === false ? { retryable: false } : {}) }; }
    if (result.state === 'completed' && acknowledged && !acknowledged(result.output))
      result = { ...result, state: 'failed', error: 'The provider did not acknowledge the subscription.' };
    await control(source.id, async () => {
      await wanted(source, held);
      const latest = await facts.read(key);
      if (latest?.request_key !== entry.request_key) throw changed(source);
      const problem = result.state === 'completed' ? null : withoutSecrets(result.error ?? result.state);
      await facts.write(key, { ...entry, task_id: result.task_id ?? entry.task_id, state: result.state, checked_at: now().toISOString(),
        problem, failures: problem ? entry.failures + 1 : 0,
        retry_at: problem ? later(now().getTime(), entry.failures) : null,
        ...(result.retryable === false ? { retryable: false } : {}) });
    });
    if (result.state !== 'completed') throw Object.assign(new WorkshopError(`${source.label}: ${withoutSecrets(result.error ?? result.state)}.`), {
      retry_at: later(now().getTime(), entry.failures), ...(result.retryable === false ? { retryable: false } : {}) });
    return result.output;
  }

  async function prove(source, held) {
    const keys = new Set();
    let pages = 0;
    async function collection(spec, parent, address) {
      const base = await buildInvocation(spec.input ?? {}, { input: {}, task: {}, extra: { parent } });
      let after = null;
      const cursors = new Set();
      do {
        // A malformed or cycling provider cannot turn one setup into an unbounded walk. Refuse the whole proof,
        // including already read pages; no subset is treated as all of the account's resources.
        if (++pages > 256) throw proofError(`${source.label}'s ownership proof exceeded 256 pages; no partial subscription was made.`);
        const input = { ...base, ...(after === null ? {} : { [spec.cursor.input_field]: after }) };
        const output = await task(source, held, `proof:${address}:${cursors.size}`, spec.tool_id, input);
        const items = read(output, spec.items_selector);
        if (!Array.isArray(items)) throw proofError(`${source.label}'s ownership proof did not return its declared list.`);
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          const id = scalar(read(item, spec.id_selector));
          if (!id) throw proofError(`${source.label}'s ownership proof returned a resource without its declared identity.`);
          if (spec.children?.length) {
            for (let child = 0; child < spec.children.length; child += 1)
              await collection(spec.children[child], item, `${address}/${encodeURIComponent(id)}/${child}`);
          } else keys.add(id);
          if (keys.size > 4096) throw proofError(`${source.label}'s ownership proof exceeded 4096 routes; no partial subscription was made.`);
        }
        const more = read(output, spec.cursor.more_selector);
        if (more !== true && more !== false) throw proofError(`${source.label}'s ownership proof returned an invalid continuation flag.`);
        if (!more) break;
        after = scalar(read(output, spec.cursor.output_selector));
        if (!after || after.length > 2048 || cursors.has(after)) throw proofError(`${source.label}'s ownership proof returned a missing or repeated cursor.`);
        cursors.add(after);
      } while (true);
    }
    await collection(source.route_key_proof.collection, {}, 'root');
    return [...keys].sort();
  }

  async function perform(source, held) {
    const proved = await prove(source, held);
    await wanted(source, held);
    let current = await save(source, held, { proved_route_keys: proved, ready: false });
    const removed = (current.registered_route_keys ?? []).filter(key => !proved.includes(key));
    current = await save(source, held, { registered_route_keys: proved,
      route_keys: (current.route_keys ?? []).filter(key => proved.includes(key)),
      subscribed_routes: Object.fromEntries(Object.entries(current.subscribed_routes ?? {}).filter(([key]) => proved.includes(key))) });
    await removeRoutes(source, removed);
    let problem = null;
    for (const route_key of proved) {
      current = await wanted(source, held);
      if (current.route_keys.includes(route_key) && current.subscribed_routes?.[route_key]?.connection_revision === held.connection_revision) continue;
      // Publish a proved pending route before the provider starts sending. Its receive gate returns a retry until
      // the acknowledgement is kept, so an early delivery cannot be acknowledged and discarded in this gap.
      await registration(source.id, async () => {
        await wanted(source, held);
        await routes.add(source.id, route_key, { revision: revision(held) });
        try { await wanted(source, held); }
        catch (error) {
          const latest = await facts.read(keyFor(source.id));
          if (latest?.stop_requested || !(latest?.registered_route_keys ?? []).includes(route_key)) await routes.remove(source.id, route_key, { revision: revision(latest) });
          throw error;
        }
      });
      try {
        const subscription = source.route_subscription;
        const input = await buildInvocation(subscription.input, { input: {}, task: {}, extra: { route: { route_key } } });
        const output = await task(source, held, `subscribe:${encodeURIComponent(route_key)}`, subscription.tool_id, input, value => read(value, subscription.success_selector) === true);
        await control(source.id, async () => {
          const latest = await wanted(source, held);
          await facts.write(keyFor(source.id), { ...latest, route_keys: [...new Set([...latest.route_keys, route_key])].sort(),
            subscribed_routes: { ...latest.subscribed_routes, [route_key]: { connection_revision: held.connection_revision, at: now().toISOString() } } });
        });
      } catch (error) {
        await wanted(source, held);
        problem ??= error;
      }
    }
    const noRoutes = !proved.length ? `${source.label}: the connected account returned no resources to listen to.` : null;
    current = await save(source, held, { ready: !problem && proved.length > 0, setup_complete: !problem, stopped: false, setup_failures: problem ? current.setup_failures ?? 0 : 0, retryable: problem?.retryable !== false, problem: problem ? withoutSecrets(problem) : noRoutes,
      next_check_at: problem ? Number.isFinite(problem.retry_at) ? problem.retry_at : later(now().getTime(), 0)
        : now().getTime() + source.route_subscription.recheck_minutes * 60_000 });
    await rearm();
    if (problem) throw problem;
    if (noRoutes) return { source_id: source.id, accounts: [], listening: false, problem: noRoutes, retry_at: current.next_check_at };
    return { source_id: source.id, accounts: current.route_keys, listening: true, next_call: { tool: 'list_rules', arguments: {} } };
  }

  async function listenNow(source, { stop = false, automatic = false } = {}, capture = () => {}) {
    const connection = await currentConnection(source);
    const outcome = await control(source.id, async () => {
      const before = await facts.read(keyFor(source.id));
      if (stop || !connection) {
        const next = { ...before, source_id: source.id, stop_requested: stop || before?.stop_requested === true,
          stopped: true, ready: false, control_revision: revision(before) + 1, route_keys: [], registered_route_keys: [],
          subscribed_routes: {}, connection_revision: connection, at: now().toISOString(), next_check_at: null };
        await facts.write(keyFor(source.id), next);
        return { done: true, removed: before?.registered_route_keys ?? [], row: next };
      }
      if (automatic && before?.stop_requested) return { done: true, row: before };
      const sameConnection = before?.connection_revision === connection;
      const pending = sameConnection && !before.stop_requested && !before.setup_complete;
      const next = pending ? before : { ...before, source_id: source.id, stopped: false, stop_requested: false, ready: false, setup_complete: false,
        control_revision: revision(before) + 1, connection_revision: connection, problem: null, retryable: true, setup_failures: 0, setup_at: now().toISOString(), at: now().toISOString(),
        route_keys: [], registered_route_keys: sameConnection ? before.registered_route_keys ?? [] : [],
        subscribed_routes: sameConnection ? before.subscribed_routes ?? {} : {}, next_check_at: now().getTime() };
      if (!pending) await facts.write(keyFor(source.id), next);
      return { row: next, removed: sameConnection ? [] : before?.registered_route_keys ?? [] };
    });
    capture(outcome.row);
    await removeRoutes(source, outcome.removed ?? []);
    if (outcome.done) {
      await rearm();
      return { source_id: source.id, listening: false, ...(outcome.row.stop_requested ? { stopped: true } : { problem: `${source.label}'s connection is not connected.`, retryable: false }) };
    }
    const held = outcome.row;
    const id = `${source.id}:${revision(held)}`;
    if (running.has(id)) return running.get(id);
    const work = perform(source, held).catch(async error => {
      await control(source.id, async () => {
        const row = await facts.read(keyFor(source.id));
        if (revision(row) === revision(held)) await facts.write(keyFor(source.id), { ...row, ready: false, setup_complete: error?.restart_proof === true ? true : row.setup_complete, problem: withoutSecrets(error), retryable: error?.retryable !== false,
          next_check_at: error.retryable === false ? null : Number.isFinite(error.retry_at) ? error.retry_at : later(now().getTime(), 0) });
      });
      await rearm();
      throw error;
    }).finally(() => { if (running.get(id) === work) running.delete(id); });
    running.set(id, work);
    return work;
  }
  async function listen(source, options = {}) {
    let held = await facts.read(keyFor(source.id));
    try { return await listenNow(source, options, row => { held = row; }); }
    catch (error) {
      if (error && typeof error === 'object') error.event_control_revision = revision(held);
      throw error;
    }
  }
  async function state(source, row = null) {
    row ??= await facts.read(keyFor(source.id));
    const connected = Boolean(row && row.connection_revision && row.connection_revision === await currentConnection(source));
    return { ...row, current_connection: connected, ready: Boolean(connected && !row?.stop_requested && row?.ready) };
  }
  async function due(source) {
    const row = await facts.read(keyFor(source.id));
    if (!row || row.stop_requested) return null;
    const connection = await currentConnection(source);
    if (connection !== row.connection_revision) return now().getTime();
    if (!connection) return null;
    if (!Number.isFinite(row.next_check_at)) return null;
    return background.has(source.id) ? Math.max(row.next_check_at, now().getTime() + 60_000) : row.next_check_at;
  }
  async function accepts(source, event) {
    const row = await state(source);
    if (!row.current_connection || row.stop_requested || row.stopped) return false;
    if ((row.route_keys ?? []).includes(event.route_key)) return true;
    if ((row.registered_route_keys ?? []).includes(event.route_key)) throw Object.assign(new WorkshopError(`${source.label}'s subscription is still being confirmed; retry this delivery.`), { route_pending: true });
    return false;
  }
  async function runDue(source) {
    if (background.has(source.id)) return { started: false };
    const before = await facts.read(keyFor(source.id));
    if (background.has(source.id)) return { started: false };
    const work = Promise.resolve().then(() => listen(source, { automatic: true })).catch(async error => {
      // Connection reads and route cleanup can fail before perform owns the attempt. Retain their backoff too;
      // an accepted background wake must not leave an already-due row spinning the shared scheduler.
      await control(source.id, async () => {
        const row = await facts.read(keyFor(source.id));
        if (!row || row.stop_requested || revision(row) !== (error?.event_control_revision ?? revision(before))) return;
        const failures = (row.setup_failures ?? 0) + 1;
        await facts.write(keyFor(source.id), { ...row, ready: false, setup_failures: failures, problem: withoutSecrets(error),
          next_check_at: error?.retryable === false ? null : Math.max(later(now().getTime(), failures - 1),
            Number.isFinite(row.next_check_at) ? row.next_check_at : 0, Number.isFinite(error?.retry_at) ? error.retry_at : 0),
          retryable: error?.retryable !== false });
      });
    }).finally(async () => {
      if (background.get(source.id) === work) background.delete(source.id);
      await rearm();
    });
    background.set(source.id, work);
    if (keepAlive) {
      try { keepAlive(work); return { started: true }; } catch {}
    }
    await work;
    return { started: true };
  }
  async function connectionRemoved(source) {
    // A disconnect callback may finish after a reconnect; it cannot stop that replacement connection.
    if (await currentConnection(source) === null) await listen(source, { automatic: true });
  }
  return { listen, runDue, state, due, accepts, connectionRemoved };
}
