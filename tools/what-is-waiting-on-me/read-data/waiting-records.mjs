// Binds the existing source-row aggregator to the current records/tool doors. Sources remain editable DATA;
// missing owners, failed reads and exhausted bounds remain unread, never successful empty collections.
import DATA from './waiting-sources.json' with { type: 'json' };
import WAITING from '../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json' with { type: 'json' };
import { whatIsWaitingOnMe } from './waiting.mjs';
import { nextRound } from './work-rounds.mjs';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const at = (value, path) => String(path).split('.').reduce((node, part) => node?.[part], value);

function receiptEffectHolds(source, value, receipt) {
  if (!receipt?.next_round && !Object.entries(source.done.set).every(([field, expected]) => JSON.stringify(value[field]) === JSON.stringify(expected))) return false;
  const fields = receipt?.effect_fields;
  const required = receipt?.next_round ? [source.done.rounds?.done_field, source.done.rounds?.log_field,
    source.done.rounds?.step_field, source.done.rounds?.starts_field, ...Object.keys(source.done.set)] : Object.keys(source.done.set);
  return Array.isArray(fields) && required.every(field => field && fields.includes(field)) &&
    makeHashCodeHexFromJson(Object.fromEntries(fields.map(field => [field, value[field]]))) === receipt.effect_identity;
}
const sourceFor = (sources, id) => [...sources.values()].find(source => source.done?.record_type && typeof source.done.prefix === 'string' && id.startsWith(source.done.prefix));

async function sourceRows(door) {
  const sources = new Map(DATA.sources.map(source => [source.id, source]));
  const problems = [];
  const seen = new Set();
  try {
    let count = 0;
    for await (const record of door.list({ type: DATA.registry_type, limit: DATA.page_rows })) {
      if (++count > DATA.most_rows) throw new Error('The waiting source registry exceeds its read bound.');
      const row = record.value;
      if (!object(row) || typeof row.id !== 'string' || !row.id || seen.has(row.id)) throw new Error('Each waiting source needs one unique id.');
      seen.add(row.id);
      const before = sources.get(row.id) ?? {};
      sources.set(row.id, { ...before, ...row, section: { ...before.section, ...row.section } });
    }
  } catch (error) { problems.push({ source: DATA.registry_type, error: error.message }); }
  return { sources, problems };
}

export async function readWaitingOnMe(_input = {}, { door } = {}) {
  const { sources, problems } = await sourceRows(door);
  const found = {};
  const cache = new Map();
  async function readSource(source) {
    const read = source.read;
    if (!object(read)) throw new Error(source.unavailable ?? 'This source has no current reader.');
    if (read.type && read.tool) throw new Error('A source read names one record type or one reader tool.');
    const key = JSON.stringify(read);
    if (!cache.has(key)) cache.set(key, (async () => {
      const records = [];
      if (typeof read.type === 'string') {
        const query = Object.fromEntries(['type', 'prefix', 'where', 'fields', 'order', 'above', 'below', 'reverse'].filter(key => read[key] !== undefined).map(key => [key, read[key]]));
        for await (const record of door.list({ ...query, limit: DATA.page_rows })) {
          records.push(record);
          if (records.length > DATA.most_rows) throw new Error('This waiting source exceeds its read bound.');
        }
      } else if (typeof read.tool === 'string' && typeof read.records === 'string') {
        let cursor;
        const cursors = new Set();
        do {
          const ran = await door.run(read.tool, { ...read.input, ...(cursor ? { [read.cursor]: cursor } : {}) });
          if (ran?.exit_code && ran.exit_code !== 0) throw new Error(ran.error || 'The source reader failed.');
          const result = ran?.result ?? ran;
          const rows = at(result, read.records);
          if (!Array.isArray(rows)) throw new Error('The source reader did not answer its collection.');
          records.push(...rows);
          if (records.length > DATA.most_rows) throw new Error('This waiting source exceeds its read bound.');
          cursor = read.next ? at(result, read.next) : null;
          if (cursor && (!read.cursor || cursors.has(cursor))) throw new Error('The source reader did not advance its page.');
          if (!cursor && read.more && at(result, read.more) === true) throw new Error('The source reader has more rows without a continuation.');
          if (cursor) cursors.add(cursor);
        } while (cursor);
      } else throw new Error('A source read names its record type or its current reader tool.');
      return records;
    })());
    return cache.get(key);
  }
  for (const source of sources.values()) {
    if (source.applicable === false && typeof source.because === 'string' && source.because.trim()) { found[source.id] = []; continue; }
    try { found[source.id] = await readSource(source); }
    catch (error) { problems.push({ source: source.id, error: error.message }); }
  }
  const rows = [...sources.values()];
  const aggregate = whatIsWaitingOnMe({ sources: rows, found });
  const sections = rows.map(source => ({ ...source.section, id: source.id,
    total: aggregate.sources.find(row => row.id === source.id)?.waiting ?? 0,
    cards: aggregate.cards.filter(card => card.source === source.id).map(card => {
      if (typeof card.opens !== 'string') return card;
      const { opens, ...rest } = card;
      return { ...rest, address: card.address ?? opens };
    }) }));
  const complete = !problems.length && aggregate.sources.every(source => !source.unread && source.skipped === 0);
  return { ...aggregate, sections, finishes: WAITING.finishes, complete,
    waiting_sources: { complete, sources: aggregate.sources, problems } };
}

/** Complete only the action a source explicitly declares, at that same persisted record, with compare-and-write.
 * Sources with another action owner cannot be closed by guessing a status field or deleting a display card. */
export async function finishWaitingOnMe(input = {}, { door, now = () => new Date() } = {}) {
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || input.ids.some(id => typeof id !== 'string')) throw new Error('ids must name 1 to 100 waiting records.');
  if (typeof input.request_key !== 'string' || !input.request_key.trim()) throw new Error('request_key names this completion.');
  const { sources, problems } = await sourceRows(door);
  if (problems.length) throw new Error('The waiting source actions could not be read.');
  const writes = [];
  const completed = [];
  const next_round = [];
  const checks = [];
  const signature = makeHashCodeHexFromJson({ ids: [...new Set(input.ids)].sort(), showed: input.showed ?? {} });
  for (const id of new Set(input.ids)) {
    const source = sourceFor(sources, id);
    if (!source || !object(source.done.set)) throw new Error(`This waiting item must be completed through its source owner: ${id}`);
    const before = await door.readRecord(source.done.record_type, id);
    if (!object(before?.value)) throw new Error(`This waiting item is no longer available: ${id}`);
    const receipt = before.value.waiting_finish;
    if (receipt?.key === input.request_key) {
      if (receipt.signature !== signature) throw new Error('The completion key already names different input.');
      if (!receiptEffectHolds(source, before.value, receipt)) {
        throw Object.assign(new Error('This waiting item changed after that completion. Read its current source before continuing.'), { code: 'original_command_conflict' });
      }
      (receipt.next_round ? next_round : completed).push(id);
      continue;
    }
    const alreadyDone = Object.entries(source.done.set).every(([field, value]) => JSON.stringify(before.value[field]) === JSON.stringify(value));
    const round = alreadyDone ? null : nextRound(before.value, { showed: input.showed?.[id], at: now().toISOString() }, source.done.rounds);
    const { finished, ...roundValues } = round ?? {};
    const continuing = round && finished === false;
    const effect = { ...Object.fromEntries(Object.keys(source.done.set).map(field => [field, before.value[field]])),
      ...roundValues, ...(!continuing ? source.done.set : {}) };
    const set = { ...effect, waiting_finish: { key: input.request_key, signature, next_round: Boolean(continuing),
      effect_fields: Object.keys(effect), effect_identity: makeHashCodeHexFromJson(effect) } };
    const value = { ...before.value, ...set };
    if (JSON.stringify(value) !== JSON.stringify(before.value)) writes.push({ id, type: source.done.record_type, value, expected: { type: source.done.record_type, value: before.value } });
    checks.push({ id, type: source.done.record_type, set });
    (continuing ? next_round : completed).push(id);
  }
  if (writes.length) await door.write(writes, { key: input.request_key });
  for (const check of checks) {
    const kept = await door.readRecord(check.type, check.id);
    if (!kept || !Object.entries(check.set).every(([field, value]) => JSON.stringify(kept.value?.[field]) === JSON.stringify(value))) throw new Error('A waiting item changed before completion could be confirmed.');
  }
  return { completed, changed: writes.length, ...(next_round.length ? { next_round } : {}) };
}

/** Current exact-target proof after a command, independent of whether a feed hid or failed to read that card. */
export async function verifyWaitingCompletion(input = {}, { door } = {}) {
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || input.ids.some(id => typeof id !== 'string') || typeof input.request_key !== 'string') throw new Error('Name the completion key and its 1 to 100 exact record ids.');
  const { sources, problems } = await sourceRows(door);
  if (problems.length) throw new Error('The waiting source actions could not be read.');
  const completed = [], next_round = [];
  for (const id of new Set(input.ids)) {
    const source = sourceFor(sources, id);
    if (!source || !object(source.done.set)) throw new Error('This item must be verified by its source owner.');
    const current = await door.readRecord(source.done.record_type, id);
    const receipt = current?.value?.waiting_finish;
    if (!current || receipt?.key !== input.request_key || !receiptEffectHolds(source, current.value, receipt)) {
      throw Object.assign(new Error('The current waiting item no longer proves that completion.'), { code: 'original_command_conflict' });
    }
    (receipt.next_round ? next_round : completed).push(id);
  }
  return { completed, ...(next_round.length ? { next_round } : {}) };
}
