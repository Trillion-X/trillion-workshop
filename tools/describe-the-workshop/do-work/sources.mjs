// Source lifecycle port; exact source slices are retained in ports/source-baselines before adaptation.
// `sourced` is a trusted selected-account owner, never input. config/own/reads and the mutation pair keep the original
// facade. Mutations need mutationResult and compareAndPut from that owner. `put` alone is insufficient.
// This tool reads and writes no store. The caller reads its own tool-source rows and the receipt of an earlier run
// with the same request_key from the person's store, gives them as `own` (each {id, value, identity}) and `receipt`,
// and writes what comes back as `keep`: the source row with the identity it was read at (its expected version), and
// the request receipt. The caller's store applies both in one atomic write that checks those versions.
// It never starts the old runtime, guesses defaults, fetches external sources or reads credentials.
import data from '../read-data/source-records.json' with { type: 'json' };
import { liveSourceProblems } from '../read-data/live-source-problems.mjs';
import { canonicalJson, makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const fail = (message, code = 'source_input_refused') => Object.assign(new Error(message), { code });
const secretHeader = new RegExp(data.credential_header, 'i');
const secretQuery = new RegExp(data.credential_query, 'i');
const receiptIdOf = request => `${data.change_prefix}${makeHashCodeHexFromJson(request.request_key).slice(3)}`;

function addressProblem(value) {
  try {
    const address = new URL(value);
    return Boolean(address.username || address.password || [...address.searchParams.keys()].some(key => secretQuery.test(key)));
  } catch { return false; } // The canonical validator reports invalid addresses.
}

function sourceOf(add, config, existing = null) {
  if (!object(add) || Object.keys(add).some(key => ![...data.fields, 'id'].includes(key)))
    throw fail('Supply only id, kind, url, name, headers, connection and only. Keep keys in the connection owner.');
  let host = '';
  try { host = new URL(String(add.url ?? existing?.url)).hostname; } catch { /* validator reports it */ }
  const row = { ...(existing ?? {}), ...Object.fromEntries(data.fields.filter(key => Object.hasOwn(add, key)).map(key => [key, add[key]])) };
  if (existing) for (const key of data.optional_fields) if (Object.hasOwn(add, key) && add[key] === null) delete row[key];
  if (!existing) row.id = String(add.id ?? `${host}-${row.kind}`).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, data.source_id_max);
  else if (Object.hasOwn(add, 'id') && add.id !== existing.id) throw fail('An edit keeps the source id. Add another source to give it another id.');
  const problems = liveSourceProblems(row, config.kinds);
  if (problems.length) throw fail(`This source cannot be read: ${problems.join(' ')}`);
  if (addressProblem(row.url) || Object.keys(row.headers ?? {}).some(name => secretHeader.test(name)))
    throw fail('Keep sign-in values and keys in the connection owner; source addresses and headers hold no credentials.');
  if (row.connection !== undefined && (Object.keys(row.connection).some(key => !['connection_id', 'field_id'].includes(key))
    || !row.connection.connection_id || !row.connection.field_id))
    throw fail('connection names only the connection_id and field_id.');
  return row;
}

async function configuration(sourced) {
  const config = await sourced.config();
  if (!object(config) || !object(config.kinds) || !Array.isArray(config.sources)
    || Object.values(config.kinds).some(kind => !object(kind) || kind.source?.kind !== 'tool-row-source' || !object(kind.source.list)))
    throw fail('The current live-source templates and defaults are unavailable.', 'source_configuration_unavailable');
  const seen = new Set();
  for (const row of config.sources) {
    if (liveSourceProblems(row, config.kinds).length || seen.has(row.id))
      throw fail('The current default sources are malformed or repeated.', 'source_configuration_unavailable');
    seen.add(row.id);
  }
  return structuredClone(config);
}

async function current(sourced, config) {
  if (!same(await configuration(sourced), config))
    throw fail('The source templates or defaults changed. Read the sources again.', 'source_configuration_changed');
}

async function own(sourced) {
  const rows = await sourced.own();
  if (!Array.isArray(rows) || rows.some(row => !object(row) || typeof row.id !== 'string') || new Set(rows.map(row => row.id)).size !== rows.length)
    throw fail('The source owner returned an invalid or repeated source list.', 'source_owner_unavailable');
  return structuredClone(rows);
}

/** Source-qualified owner. The caller supplies `sourced`; nothing here reads or writes a store. */
export async function accountToolSources(input = {}, { sourced, now = () => new Date() } = {}) {
  if (!sourced || !['config', 'own', 'reads'].every(key => typeof sourced[key] === 'function'))
    throw fail('The current account tool-source owner is unavailable. No sources were changed.', 'source_owner_unavailable');
  if (!object(input) || Object.keys(input).some(key => ![...data.operations, 'request_key'].includes(key)))
    throw fail('Supply add, edit or remove, and a request_key for a change. An empty request lists sources.');
  const operations = data.operations.filter(key => input[key] !== undefined && input[key] !== null);
  if (operations.length > 1) throw fail('Change one source at a time: add, edit or remove.');
  let config = await configuration(sourced);
  if (operations.length) {
    if (typeof input.request_key !== 'string' || !input.request_key.trim()) throw fail('Give the same request_key when retrying the same source change.');
    if (typeof sourced.compareAndPut !== 'function' || typeof sourced.mutationResult !== 'function')
      throw fail('The source owner cannot yet keep a conditional source change. No sources were changed.', 'source_mutation_owner_unavailable');
    const operation = operations[0], command = { operation, input: input[operation] };
    const request = { request_key: input.request_key, command_identity: makeHashCodeHexFromJson(command) };
    const result = await sourced.mutationResult(request);
    if (!object(result) || typeof result.found !== 'boolean') throw fail('The source owner returned no checked retry result.', 'source_owner_unavailable');
    if (!result.found) {
      const rows = await own(sourced), active = rows.filter(row => row.status !== 'deleted');
      let row, expected = null;
      const at = now().toISOString();
      if (operation === 'add') {
        row = sourceOf(input.add, config);
        if (config.sources.some(item => item.id === row.id)) throw fail(`${row.id} is already read for every account.`);
        expected = rows.find(item => item.id === row.id) ?? null;
        if (expected && expected.status !== 'deleted') throw fail(`${row.id} is already a source this account added. Edit it instead.`);
        row = { ...row, added_at: at };
      } else {
        const id = operation === 'edit' ? input.edit?.id : input.remove;
        expected = active.find(item => item.id === id) ?? null;
        if (!expected) throw fail('This is not an active source this account added.');
        row = operation === 'edit' ? { ...sourceOf(input.edit, config, expected), updated_at: at }
          : { ...expected, status: 'deleted', removed_at: at };
      }
      await current(sourced, config);
      await sourced.compareAndPut({ ...request, entity: `${data.fact_prefix}${row.id}`, row, expected, configuration: config });
    }
    // A retry discloses the current list, not the previous result under expired rights.
    config = await configuration(sourced);
  }
  const beforeRead = await own(sourced);
  const mine = beforeRead.filter(row => row.status !== 'deleted');
  const reads = await sourced.reads(mine);
  if (!Array.isArray(reads)) throw fail('The source owner returned no source-read states.', 'source_owner_unavailable');
  await current(sourced, config);
  if (!same(await own(sourced), beforeRead))
    throw fail('The account sources changed while their tools were read. Read them again.', 'source_definitions_changed');
  const shown = (source, read) => ({ ...source, ...(read ? { version: read.version ?? null, read_at: read.read_at ?? null,
    checked_at: read.checked_at ?? null, ...(read.state ? { state: read.state } : {}), ...(read.error ? { error: read.error } : {}),
    tools: read.tools ?? [], held: read.held ?? [] } : {}) });
  const readOf = (id, scope) => reads.find(read => read.source_id === id && (!read.scope || read.scope === scope));
  const ownIds = new Set(mine.map(source => source.id));
  return {
    every_account: config.sources.map(source => ownIds.has(source.id) ? {...source,overridden_by_account:true} : shown(source, readOf(source.id, 'default'))),
    yours: mine.map(source => shown(source, readOf(source.id, 'account'))),
    kinds: Object.entries(config.kinds).map(([id, kind]) => ({ id, label: kind.label, becomes: kind.becomes })),
  };
}

/** The caller's own rows as values: each {id, value, identity}, the id being the record id of its source. */
function ownRowsOf(given) {
  if (!Array.isArray(given) || given.length > 4096) throw fail('own is the list of the tool-source rows the caller read: {id, value, identity}.', 'source_owner_unavailable');
  const seen = new Set();
  return given.map(row => {
    if (!object(row) || typeof row.id !== 'string' || !object(row.value) || row.id !== `${data.fact_prefix}${row.value.id}`
      || typeof row.identity !== 'string' || !row.identity)
      throw fail(`Each own row is {id, value, identity} with the id ${data.fact_prefix}<source id> and the identity it was read at.`, 'source_owner_unavailable');
    if (seen.has(row.id)) throw fail(`${row.id} is given more than once.`, 'source_owner_unavailable');
    seen.add(row.id);
    return structuredClone(row);
  });
}

/** Static-row entry. `source_data` is filled from the native task, separately from request input. The native owner
 * fences this snapshot's selected account, current rights and exact default-section witnesses at the physical
 * records commit and final disclosure. This function cannot mint or attest those native witnesses itself.
 * The caller's `own` rows and `receipt` (the earlier run's tool-source-change row for this request_key, or null)
 * come in as input fields; the change comes back as `keep` for the caller to write.
 */
export async function accountToolSourcesFromTask(envelope, { now } = {}) {
  if (!object(envelope) || Object.keys(envelope).some(key => !['input', 'source_data'].includes(key))
    || !object(envelope.source_data) || !object(envelope.source_data.config) || !Array.isArray(envelope.source_data.reads)
    || envelope.source_data.reads.some(read => !object(read) || typeof read.source_id !== 'string')
    || envelope.source_data.own !== undefined && (!Array.isArray(envelope.source_data.own)
      || envelope.source_data.own.some(row => !object(row) || typeof row.id !== 'string')))
    throw fail('The native task has no current tool-source snapshot. No sources were changed.', 'source_owner_unavailable');
  const { own: given = [], receipt = null, ...operation } = object(envelope.input) ? envelope.input : {};
  const snapshot = structuredClone(envelope.source_data);
  const start = ownRowsOf(given);
  const identities = new Map(start.map(row => [row.id, row.identity]));
  const keep = [];
  let changed = null;
  const ownNow = () => {
    const values = start.map(row => row.value);
    if (!changed) return structuredClone(values);
    return structuredClone([...values.filter(value => value.id !== changed.id), changed]);
  };
  const pending = (source, scope) => ({ source_id: source.id, scope, state: 'pending', version: null, read_at: null, checked_at: null, tools: [], held: [] });
  const sourced = {
    config: async () => structuredClone(snapshot.config),
    async reads(own) {
      const ownIds = new Set(own.map(source => source.id));
      const selected = [...snapshot.config.sources.filter(source => !ownIds.has(source.id)).map(source => ({ source, scope: 'default' })),
        ...own.map(source => ({ source, scope: 'account' }))];
      return selected.map(({ source, scope }) => {
        const problems = liveSourceProblems(source, snapshot.config.kinds);
        if (problems.length) return { ...pending(source, scope), state: 'unavailable', error: 'This source does not match the current live-source templates.', held: [{ reasons: problems }] };
        // An add or edit after snapshot creation cannot inherit another definition's cached tools. Native reads
        // may name the exact definition identity; an absent proof leaves the source pending, never empty-ready.
        const identity = makeHashCodeHexFromJson(source);
        const read = snapshot.reads.find(read => read.source_id === source.id && read.scope === scope
          && (scope === 'default' || read.definition_identity === identity
            || Array.isArray(snapshot.own) && snapshot.own.some(row => row.id === source.id && same(row, source))));
        return read ? structuredClone(read) : pending(source, scope);
      });
    },
    own: async () => ownNow(),
    async mutationResult(request) {
      if (receipt === null) return { found: false };
      if (!object(receipt) || receipt.id !== receiptIdOf(request))
        throw fail('The receipt given is not the one for this request_key.', 'source_request_conflict');
      if (receipt.value?.command_identity !== request.command_identity)
        throw fail('This request_key already belongs to a different source change.', 'source_request_conflict');
      return { found: true };
    },
    async compareAndPut(change) {
      const identity = change.expected === null ? null : identities.get(change.entity);
      if (change.expected !== null && !identity) throw fail('The original source has no identity. Give its identity as the store holds it.', 'source_definitions_changed');
      keep.push({ id: change.entity, type: data.record_type, value: change.row, expected: change.expected === null ? null : { identity } });
      keep.push({ id: receiptIdOf({ request_key: change.request_key }), type: data.change_type, value: { command_identity: change.command_identity }, expected: null });
      changed = change.row;
    },
  };
  const answer = await accountToolSources(operation, { sourced, ...(now ? { now } : {}) });
  return keep.length ? { ...answer, keep } : answer;
}
