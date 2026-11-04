// Read a declared native record through its existing account owner and project
// its saved value with the same EEAF facts function. This is a read adapter: it
// writes no record, indexes no reference, advances no work and reads no file.
// Native declarations are DATA in record-model.json; no product, record kind or
// field is selected by this module. Native history is explicitly unsupported.
import modelData from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-model.json' with { type: 'json' };
import { factsOf } from '../../record-log/do-work/record-model.mjs';
import { nativeInspectionAddress } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-model-tools.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encoder = new TextEncoder();
const MESSAGES = {
  native_record_not_found: 'This saved native record is not available from its owner.',
  native_reader_unavailable: 'This record owner cannot answer inspection here.',
  native_record_changed: 'This saved value differs from the identity its owner admitted.',
  native_record_mismatch: 'The native owner returned a different record or kind.',
  native_record_oversized: 'This saved native value is larger than the inspection byte limit.',
  native_record_too_many_fields: 'This saved native value exceeds the inspection field limit.',
  native_record_too_many_nodes: 'This saved native value exceeds the inspection structure limit.',
  native_record_too_deep: 'This saved native value exceeds the inspection depth limit.',
  native_record_shape_unavailable: 'This saved native value cannot be represented as record facts.',
  native_record_read_budget: 'The native record needs more owner reads than this inspection permits.',
  native_history_unsupported: 'This native owner does not expose historical record facts here.',
  native_record_read_failed: 'The native record owner could not answer this inspection.',
};
const fail = code => Object.assign(new Error(MESSAGES[code] ?? MESSAGES.native_record_read_failed), { code });
const safeCode = error => Object.hasOwn(MESSAGES, error?.code) ? error.code : 'native_record_read_failed';
const checkedLimits = limits => {
  for (const key of ['value_bytes', 'owner_reads', 'nodes', 'facts', 'depth', 'reference_chars']) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 1) throw new TypeError(`Native inspection needs a positive ${key} limit.`);
  }
  return limits;
};

// Before the shared recursive fact projection runs, bound its work and stack.
// Values from SQL are already JSON. The same check also protects injected owner
// readers from cycles or non-JSON values without interpreting their contents.
function checkedValue(value, limits) {
  if (!object(value)) throw fail('native_record_shape_unavailable');
  const stack = [{ value, depth: 0 }], seen = new WeakSet();
  let nodes = 0, characters = 0;
  while (stack.length) {
    const { value: item, depth } = stack.pop();
    if (++nodes > limits.nodes) throw fail('native_record_too_many_nodes');
    if (depth > limits.depth) throw fail('native_record_too_deep');
    if (typeof item === 'string') characters += item.length;
    else if (item !== null && typeof item === 'object') {
      if (seen.has(item) || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw fail('native_record_shape_unavailable');
      seen.add(item);
      const entries = Object.entries(item);
      if (nodes + stack.length + entries.length > limits.nodes) throw fail('native_record_too_many_nodes');
      for (const [key, child] of entries) {
        characters += key.length;
        stack.push({ value: child, depth: depth + 1 });
      }
    } else if (typeof item === 'number' ? !Number.isFinite(item) : item !== null && typeof item !== 'boolean') throw fail('native_record_shape_unavailable');
    if (characters > limits.value_bytes) throw fail('native_record_oversized');
  }
  if (encoder.encode(JSON.stringify(value)).byteLength > limits.value_bytes) throw fail('native_record_oversized');
  return value;
}

/** Exact current Workshop rows, only for a native reader selected by DATA. The
 *  physical row is sized before JSON is fetched; each distinct key costs at most
 *  two indexed SELECTs and is cached for this one inspection. No table setup,
 *  current-index fill, history scan or write happens here. */
export function boundedWorkshopInspectionReader(sql, limits = modelData.native_inspection?.limits) {
  checkedLimits(limits);
  const cache = new Map();
  let reads = 0;
  return entity => {
    if (typeof entity !== 'string' || !entity || entity.length > limits.reference_chars || /[\u0000\r\n]/.test(entity)) throw fail('native_record_mismatch');
    if (cache.has(entity)) return cache.get(entity);
    if (++reads > limits.owner_reads) throw fail('native_record_read_budget');
    const metadata = sql.exec('SELECT seq, at, length(CAST(value AS BLOB)) AS bytes FROM workshop_facts WHERE entity = ? ORDER BY seq DESC LIMIT 1', entity).toArray()[0];
    if (!metadata) { cache.set(entity, null); return null; }
    if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 || metadata.bytes > limits.value_bytes) throw fail('native_record_oversized');
    const row = sql.exec('SELECT value FROM workshop_facts WHERE entity = ? AND seq = ? LIMIT 1', entity, metadata.seq).toArray()[0];
    if (!row) throw fail('native_record_changed');
    let value;
    try { value = JSON.parse(row.value); }
    catch { throw fail('native_record_shape_unavailable'); }
    checkedValue(value, limits);
    const found = { record: entity, seq: metadata.seq, at: metadata.at, bytes: metadata.bytes, value };
    cache.set(entity, found);
    return found;
  };
}

/**
 * Return null for a reference no native declaration owns. Otherwise return the
 * native record's current facts or a typed unavailable envelope. `readers` are
 * trusted, exact account-owner callbacks, keyed by the declaration's reader;
 * they return { kind, value, source?, expected_identity?, id?, title?, open_href? }.
 * A source identity confirms saved-value integrity, never an observed outcome.
 */
export function readNativeRecordInspection(requested, { readers = {}, declarations = modelData.native_inspection?.readers ?? [],
  limits = modelData.native_inspection?.limits, identity, valid = null, known = null } = {}) {
  if (typeof requested !== 'string' || !requested.trim()) return null;
  checkedLimits(limits);
  const raw = requested.trim();
  if (raw.length > limits.reference_chars) return null;
  const address = nativeInspectionAddress(raw, declarations);
  if (!address) return null;
  const { declaration, id } = address;
  const base = { id, requested_id: raw, type: declaration.type, value: null, facts: null, parts: [], sets: [],
    source: { kind: 'native_owner', reader: declaration.reader, record: id },
    coverage: { source: 'native_owner', facts: 'unavailable', history: 'unsupported', limits }, complete: false };
  const unavailable = code => ({ ...base, error: { code, message: MESSAGES[code] },
    coverage: { ...base.coverage, facts: code === 'native_history_unsupported' ? 'historical_unsupported' : 'unavailable', code } });
  if (valid || known) return unavailable('native_history_unsupported');
  const read = readers[declaration.reader];
  if (typeof read !== 'function') return unavailable('native_reader_unavailable');
  try {
    const found = read(id, { declaration, limits });
    if (found?.then) throw fail('native_record_read_failed');
    if (!found || found.value === null || found.value === undefined) return unavailable('native_record_not_found');
    if (found.kind !== declaration.type || found.id !== undefined && found.id !== id) throw fail('native_record_mismatch');
    // Only explicit owner metadata leaves the callback, never its transport,
    // credentials, request object or unrecognised error text.
    for (const key of ['record', 'seq', 'at', 'bytes', 'run_state', 'withdrawn', 'admitted_at']) {
      if (['string', 'number', 'boolean'].includes(typeof found.source?.[key])) base.source[key] = found.source[key];
    }
    checkedValue(found.value, limits);
    if (found.expected_identity !== undefined && found.expected_identity !== null) {
      if (typeof found.expected_identity !== 'string' || typeof identity !== 'function') throw fail('native_record_changed');
      if (identity(found.value) !== found.expected_identity) throw fail('native_record_changed');
      base.source.identity = found.expected_identity;
      base.coverage.integrity = 'matches_owner_admission';
    } else base.coverage.integrity = 'not_recorded';
    const facts = factsOf(found.value);
    if (facts.length > limits.facts) throw fail('native_record_too_many_fields');
    return { ...base, value: found.value, facts, complete: true,
      ...(typeof found.title === 'string' && found.title ? { title: found.title.slice(0, 200) } : {}),
      ...(typeof found.open_href === 'string' && /^(?:https?:\/\/|\/(?!\/))/.test(found.open_href) ? { open_href: found.open_href } : {}),
      coverage: { ...base.coverage, facts: 'current', field_count: facts.length } };
  } catch (error) { return unavailable(safeCode(error)); }
}
