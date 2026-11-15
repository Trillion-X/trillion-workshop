// Source lifecycle port; exact source slices are retained in ports/source-baselines before adaptation.
// `sourced` is a trusted selected-account owner, never input. config/own/reads/put retain the original facade.
// Mutations need mutationResult and compareAndPut from that owner: atomic current account/right/config checks,
// expected-row comparison, original fact storage and request-key/command-identity receipt. `put` alone is insufficient.
// The records-door adapter below uses the original-preserving copy DATA for source definitions. It never starts
// the old runtime, guesses defaults, fetches external sources or reads credentials.
import data from '../read-data/source-records.json' with { type: 'json' };
import { liveSourceProblems } from '../read-data/live-source-problems.mjs';
import { canonicalJson, makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const fail = (message, code = 'source_input_refused') => Object.assign(new Error(message), { code });
const secretHeader = new RegExp(data.credential_header, 'i');
const secretQuery = new RegExp(data.credential_query, 'i');

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

/** Source-qualified owner. A records door alone does not expose the original fact/configuration owners. */
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

/** Bind lifecycle to the admitted records door and the native owner's current source-configuration supplier.
 * Source definitions retain their original full ids and payload. The extra receipt is only a semantic identity,
 * written atomically with the source; it cannot grant a credential, tool, host, source or account right.
 * `sourceConfig` is supplied by the native owner, never an input field or a customer-editable setting fallback.
 */
export async function accountToolSourcesFromDoor(input = {}, { door, sourceConfig, now } = {}) {
  if (!door || !['readRecord', 'list', 'write'].every(key => typeof door[key] === 'function')
    || !sourceConfig || !['config', 'reads'].every(key => typeof sourceConfig[key] === 'function'))
    throw fail('The current account tool-source owner is unavailable. No sources were changed.', 'source_owner_unavailable');
  const receiptId = request => `${data.change_prefix}${makeHashCodeHexFromJson(request.request_key).slice(3)}`;
  const mutationResult = async request => {
    const receipt = await door.readRecord(data.change_type, receiptId(request));
    if (receipt === null) return { found: false };
    if (receipt.value?.command_identity !== request.command_identity)
      throw fail('This request_key already belongs to a different source change.', 'source_request_conflict');
    return { found: true };
  };
  let ownIdentities = new Map();
  const sourced = {
    config: () => sourceConfig.config(),
    async reads(mine) {
      // Pin native root stamps, not content hashes: an edit followed by restoring the same value is still a change.
      // A caller/stand-in that supplies no root stamp cannot establish this disclosure boundary.
      const pins = [];
      for (const row of mine) {
        const id = `${data.fact_prefix}${row.id}`, held = await door.readRecord(data.record_type, id);
        if (!held || !same(held.value, row) || typeof held.identity !== 'string' || !held.identity)
          throw fail('The current source record has no checked root stamp.', 'source_definitions_changed');
        pins.push({ id, identity: held.identity });
      }
      const reads = await sourceConfig.reads(mine);
      for (const pin of pins) {
        const held = await door.readRecord(data.record_type, pin.id);
        if (held?.identity !== pin.identity)
          throw fail('The account sources changed while their tools were read. Read them again.', 'source_definitions_changed');
      }
      return reads;
    },
    async own() {
      const rows = [];
      const identities = new Map();
      for await (const record of door.list({ type: data.record_type, prefix: data.fact_prefix })) {
        if (!object(record.value) || record.id !== `${data.fact_prefix}${record.value.id}`)
          throw fail('An original source record has a different id from its payload.', 'source_owner_unavailable');
        const held = await door.readRecord(data.record_type, record.id);
        if (!held || !same(held.value, record.value) || typeof held.identity !== 'string' || !held.identity)
          throw fail('The current source record has no checked root stamp.', 'source_definitions_changed');
        identities.set(record.id, held.identity);
        rows.push(record.value);
      }
      ownIdentities = identities;
      return rows;
    },
    mutationResult,
    async compareAndPut(change) {
      const request = { request_key: change.request_key, command_identity: change.command_identity };
      const before = change.expected === null ? null : { type: data.record_type, value: change.expected, identity: ownIdentities.get(change.entity) };
      if (before && !before.identity) throw fail('The original source has no current root stamp.', 'source_definitions_changed');
      await current(sourced, change.configuration);
      try {
        await door.write([
          { id: change.entity, type: data.record_type, value: change.row, expected: before },
          { id: receiptId(request), type: data.change_type, value: { command_identity: request.command_identity }, expected: null },
        ], { key: request.request_key });
      } catch (error) {
        // A conflict or a lost reply can follow the exact atomic source/receipt commit. Read its receipt once;
        // never resend a write, change its key, or turn an unavailable readback into a not-started result.
        if (error?.code !== 'original_command_conflict' && error?.outcome !== 'unknown') throw error;
        let recovered;
        try { recovered = await mutationResult(request); }
        catch { throw error; }
        if (!recovered.found) throw error;
      }
      await current(sourced, change.configuration);
    },
  };
  return accountToolSources(input, { sourced, ...(now ? { now } : {}) });
}

/** Static-row entry. `source_data` is filled from the native task, separately from request input. The native owner
 * fences this snapshot's selected account, current rights and exact default-section witnesses at the physical
 * records commit and final disclosure. This function cannot mint or attest those native witnesses itself.
 */
export async function accountToolSourcesFromTask(envelope, { door } = {}) {
  if (!object(envelope) || Object.keys(envelope).some(key => !['input', 'source_data'].includes(key))
    || !object(envelope.source_data) || !object(envelope.source_data.config) || !Array.isArray(envelope.source_data.reads)
    || envelope.source_data.reads.some(read => !object(read) || typeof read.source_id !== 'string')
    || envelope.source_data.own !== undefined && (!Array.isArray(envelope.source_data.own)
      || envelope.source_data.own.some(row => !object(row) || typeof row.id !== 'string')))
    throw fail('The native task has no current tool-source snapshot. No sources were changed.', 'source_owner_unavailable');
  const snapshot = structuredClone(envelope.source_data);
  const pending = (source, scope) => ({ source_id: source.id, scope, state: 'pending', version: null, read_at: null, checked_at: null, tools: [], held: [] });
  const sourceConfig = {
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
  };
  return accountToolSourcesFromDoor(envelope.input ?? {}, { door, sourceConfig });
}
