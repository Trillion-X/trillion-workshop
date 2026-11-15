// Current Native names wire adapter. Its readiness comes from an actual admitted
// source/right-checked observation, never a caller flag or a static version claim.
// An old installed server cannot pass this handshake. Only the declared typed
// absent answer is empty; refusals, loading and malformed answers stay failures.
const CONTRACT = 'native-conditioned-names/v1';
const EFFECTS = Object.freeze({ set_aside: 'name_command_set_aside', put_back: 'name_command_put_back', forget_set_aside: 'name_command_forget_set_aside' });
const fail = (code, message) => Object.assign(new Error(message), { code });
const token = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactName = name => typeof name === 'string' && name.startsWith('/') && name.length > 1 && !name.endsWith('/') && !name.includes('\0');

export function admittedNamesFromDoor(door) {
  if (typeof door?.files !== 'function') throw fail('fenced_names_unavailable', 'The run has no admitted Native names door.');
  let ready = false;
  const probe = new Map();
  async function observe(input) {
    if (!exactName(input?.name) || !['live', 'set_aside'].includes(input.tree)) throw fail('bad_observation', 'Observe an exact Native source name.');
    const answer = await door.files('name_command_observe', input);
    if (answer?.contract !== CONTRACT) throw fail('fenced_names_unavailable', 'The installed Native source has not attested its conditioned names contract.');
    if (answer.status === 'absent') {
      if (answer.name !== input.name || answer.tree !== input.tree) throw fail('native_observation_invalid', 'The absent observation names another source.');
      ready = true;
      return { tree: input.tree, name: input.name, folder: false, members: [], folders: [], next_after: null, absent: true };
    }
    const value = answer.observation;
    if (answer.status !== 'present' || value?.name !== input.name || value.tree !== input.tree
      || typeof value.folder !== 'boolean' || !Array.isArray(value.members) || !Array.isArray(value.folders)
      || value.members.length + value.folders.length > (input.limit ?? 1000)
      || !Object.hasOwn(value, 'next_after') || value.next_after !== null && typeof value.next_after !== 'string'
      || [...value.members, ...value.folders].some(row => !exactName(row.name) || !(row.name === input.name || row.name.startsWith(`${input.name}/`))
        || !token(row.generation) || !token(row.destination_generation))
      || value.members.some(row => typeof row.identity !== 'string' || !/^(1f|12):[0-9a-f]{64}$/.test(row.identity) || row.folder === true)
      || new Set([...value.members, ...value.folders].map(row => row.name)).size !== value.members.length + value.folders.length
      || value.next_after !== null && value.next_after === input.after
      || value.folders.some(row => row.folder !== true)) throw fail('native_observation_invalid', 'The admitted Native source returned no valid bounded observation.');
    ready = true;
    return value;
  }
  function originalValid(original) {
    if (!ready || !Object.values(EFFECTS).includes(original?.operation) || typeof original.request_key !== 'string' || !original.request_key
      || !exactName(original.input?.name) || !token(original.input.expected_generation)
      || original.operation !== EFFECTS.forget_set_aside && !token(original.input.expected_destination_generation)) {
      throw fail('native_original_invalid', 'The exact original conditioned name command is unavailable.');
    }
  }
  function committed(answer, original) {
    const result = answer?.result;
    const forget = original.operation === EFFECTS.forget_set_aside;
    const allowed = new Set(forget ? ['name', 'folder', 'forgotten'] : ['name', 'folder', 'generation', 'destination_generation']);
    if (answer?.contract !== CONTRACT || answer.status !== 'committed' || result?.name !== original.input.name
      || Object.hasOwn(result, 'folder') && typeof result.folder !== 'boolean'
      || (result.folder === true) !== (original.input.folder === true)
      || Object.keys(result).some(key => !allowed.has(key))
      || (forget ? result.forgotten !== true : !token(result.generation) || !token(result.destination_generation))) {
      throw fail('native_original_result_invalid', 'The Native original command has no valid committed result.');
    }
    return { status: 'committed', result };
  }
  return {
    get protocol() { return ready ? 'fenced-names/1' : null; },
    effects: EFFECTS,
    async ready({ name, tree = 'live' }) {
      if (!ready) probe.set(`${tree}:${name}`, await observe({ tree, name, after: null, limit: 100 }));
    },
    async observe(input) {
      const key = `${input.tree}:${input.name}`;
      // Only reuse the exact first observation used to attest this run. The
      // caller freezes it before effects. Other limits/cursors read afresh.
      if (input.after === null && input.limit === 100 && probe.has(key)) { const value = probe.get(key); probe.delete(key); return value; }
      return observe(input);
    },
    async operation(original) {
      originalValid(original);
      try { return committed(await door.files(original.operation, original.input, { key: original.request_key }), original); }
      catch (error) {
        // Only an explicit Native not-started outcome proves no effect. All
        // transport/missing/unavailable outcomes remain unknown in the core.
        if (error?.outcome === 'not_started') return { status: 'not_started', code: error.code ?? 'native_refused' };
        throw error;
      }
    },
    async result(original) {
      originalValid(original);
      // No execution path, even for typed absence or a missing/erased receipt.
      return committed(await door.files('name_command_result', original), original);
    },
  };
}
