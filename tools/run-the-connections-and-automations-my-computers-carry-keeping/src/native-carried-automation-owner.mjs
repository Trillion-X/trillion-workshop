import { carriedVerbForPath } from '../../shared-code/src/carried-connections.mjs';
// Bind ordinary carried/automation interfaces to the installed resource owners.
// Algorithms, durable work and recovery stay in carried-connections/automations.
// Set operations must use the native action wrappers that keep original
// continuation context; mounting the raw setters would lose scheduled authority.
export function nativeCarriedAutomationOwners({ automations, carried, actions, context, current, receipts }) {
  for (const name of ['rules:set', 'schedules:set']) {
    if (typeof actions?.[name] !== 'function') throw new TypeError(`The native ${name} command is required.`);
  }
  if (typeof automations?.listRules !== 'function' || typeof carried?.ask !== 'function' || typeof context !== 'function')
    throw new TypeError('The installed resource automation, carried and context owners are required.');
  const requestInput = input => {
    const original = context();
    if (typeof original?.request_key !== 'string' || !original.request_key)
      throw Object.assign(new Error('Carried work requires its original admitted request identity.'), { status: 403 });
    return { ...input, request_key: typeof input.request_key === 'string' && input.request_key.trim() ? input.request_key : original.request_key };
  };
  return {
    automations: { ...automations,
      setRule: input => actions['rules:set'](input),
      setSchedule: input => actions['schedules:set'](input),
    },
    carried: {
      ask: (verb, input = {}) => {
        return carried.ask(verb, requestInput(input));
      },
    },
    async reconcileCarried(input) {
      if (typeof current !== 'function' || typeof carried.readOriginal !== 'function') return { state: 'unknown' };
      const verb = input?.method === 'POST' ? carriedVerbForPath(input.path) : null;
      if (!verb) return { state: 'unknown' };
      await current('carried:request', input, true);
      const bound = receipts?.original();
      if (!bound) return { state: 'unknown' };
      const result = await carried.readOriginal(verb, {}, bound);
      await current('carried:request', input, true);
      return result ? { state: 'committed', result: { native_response: true, status: 200, headers: { 'content-type': 'application/json' }, body: result } } : { state: 'unknown' };
    },
  };
}


// This is only the original command's local binding, not another work queue.
// It holds opaque identities beside the native journal; private input stays in
// the canonical handoff and may be omitted from the generic recovery schema.
export function nativeCarriedRequestReceipts({ transaction, read, write, context }) {
  if (![transaction, read, write, context].every(value => typeof value === 'function'))
    throw new TypeError('Carried receipts require the resource transaction, facts and original context.');
  const identity = () => {
    const c = context();
    if (c?.operation !== 'carried:request') return null;
    if (![c.permit_id, c.input_identity, c.owner, c.resource].every(value => typeof value === 'string' && value) || !['string', 'number'].includes(typeof c.generation))
      throw Object.assign(new Error('The original carried command has no admitted identity.'), { status: 403 });
    return { permit_id: c.permit_id, input_identity: c.input_identity, owner: c.owner, resource: c.resource, generation: c.generation };
  };
  const matches = (row, source) => row && Object.entries(source).every(([key, value]) => row[key] === value);
  return {
    commit(create) {
      const source = identity();
      if (!source) return create();
      return transaction(() => {
        const result = create(), handoff_id = result?.handoff?.handoff_id;
        if (typeof handoff_id !== 'string' || !handoff_id) throw new TypeError('The canonical carried handoff did not return its original identity.');
        const key = `resource-carried-command:${source.permit_id}`, earlier = read(key);
        if (earlier && (!matches(earlier, source) || earlier.handoff_id !== handoff_id))
          throw Object.assign(new Error('The original carried request already names different work.'), { status: 409 });
        if (!earlier) write(key, { ...source, handoff_id });
        return result;
      });
    },
    original() {
      const source = identity();
      if (!source) return null;
      const row = read(`resource-carried-command:${source.permit_id}`);
      return matches(row, source) && typeof row.handoff_id === 'string' ? row : null;
    },
  };
}
