// Reads the waiting sources over the records the caller hands in (stored) and the reader tools' results (pages). Sources
// remain editable DATA; missing owners, unhanded records or pages, failed reads and exhausted bounds remain unread.
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

/** The waiting sources: the ones the Workshop ships, each registry row (a record:waiting-sources record) laid over the
 * shipped source of its id. A row without one unique id is refused, never skipped. */
function sourcesFrom(rows) {
  const sources = new Map(DATA.sources.map(source => [source.id, source]));
  const seen = new Set();
  for (const record of rows) {
    const row = record?.value;
    if (!object(row) || typeof row.id !== 'string' || !row.id || seen.has(row.id)) throw new Error('Each waiting source needs one unique id.');
    seen.add(row.id);
    const before = sources.get(row.id) ?? {};
    sources.set(row.id, { ...before, ...row, section: { ...before.section, ...row.section } });
  }
  return sources;
}

/** The records the caller handed in as `stored` (each { id, type, value }), read the way the store would list them. */
function storedFrom(input) {
  if (!Array.isArray(input.stored)) throw new Error('stored is the person\'s records of the kinds the sources read, as their own store gives them: [{ id, type, value }].');
  for (const record of input.stored) if (!object(record) || typeof record.id !== 'string' || typeof record.type !== 'string') throw new Error('Each stored record needs its id and its type.');
  return input.stored;
}

/** The results of a reader tool, in the order the caller ran it (each page's result, following the source's cursor). */
function pagesFrom(input) {
  if (input.pages === undefined) return {};
  if (!object(input.pages) || Object.values(input.pages).some(pages => !Array.isArray(pages))) throw new Error('pages is { [tool id]: [result, ...] }, each reader\'s results in the order it was run.');
  return input.pages;
}

/** The records of one kind, with an optional id prefix; nothing outside what the caller handed in is there. */
const recordsOf = (stored, type, prefix) => stored.filter(record => record.type === type && (prefix === undefined || record.id.startsWith(prefix)));

function sourcesOf(stored) {
  const registry = recordsOf(stored, DATA.registry_type);
  if (registry.length > DATA.most_rows) throw new Error('The waiting source registry exceeds its read bound.');
  try { return { sources: sourcesFrom(registry), problems: [] }; }
  catch (error) { return { sources: new Map(DATA.sources.map(source => [source.id, source])), problems: [{ source: DATA.registry_type, error: error.message }] }; }
}

/** The waiting answer over the person's records the caller handed in (`stored`) and the results of the reader tools a
 * source names (`pages`). Nothing is read or written here: a source whose records or pages were not handed in is unread,
 * and it says what to run. */
export function readWaitingOnMe(input = {}) {
  const stored = storedFrom(input);
  const pages = pagesFrom(input);
  const { sources, problems } = sourcesOf(stored);
  const found = {};
  function readSource(source) {
    const read = source.read;
    if (!object(read)) throw new Error(source.unavailable ?? 'This source has no current reader.');
    if (read.type && read.tool) throw new Error('A source read names one record type or one reader tool.');
    if (typeof read.type === 'string') {
      if (['where', 'fields', 'order', 'above', 'below', 'reverse'].some(key => read[key] !== undefined)) throw new Error('This source names a store query the handed-in records cannot answer; name only its type and prefix.');
      const records = recordsOf(stored, read.type, read.prefix);
      if (records.length > DATA.most_rows) throw new Error('This waiting source exceeds its read bound.');
      return records;
    }
    if (typeof read.tool === 'string' && typeof read.records === 'string') {
      const ran = pages[read.tool];
      if (!ran) throw new Error(`${read.tool} was not run: hand in its results, first with ${JSON.stringify(read.input ?? {})} and then with ${read.cursor ?? 'its cursor'} set to each ${read.next ?? 'next'} until there is none.`);
      const records = [];
      const cursors = new Set();
      let index = 0;
      let cursor = null;
      do {
        const result = ran[index++];
        if (result === undefined) throw new Error(`${read.tool} stopped before its last page was handed in.`);
        if (result?.exit_code && result.exit_code !== 0) throw new Error(result.error || 'The source reader failed.');
        const page = result?.result ?? result;
        const rows = at(page, read.records);
        if (!Array.isArray(rows)) throw new Error('The source reader did not answer its collection.');
        records.push(...rows);
        if (records.length > DATA.most_rows) throw new Error('This waiting source exceeds its read bound.');
        cursor = read.next ? at(page, read.next) : null;
        if (cursor && (!read.cursor || cursors.has(cursor))) throw new Error('The source reader did not advance its page.');
        if (!cursor && read.more && at(page, read.more) === true) throw new Error('The source reader has more rows without a continuation.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return records;
    }
    throw new Error('A source read names its record type or its current reader tool.');
  }
  for (const source of sources.values()) {
    if (source.applicable === false && typeof source.because === 'string' && source.because.trim()) { found[source.id] = []; continue; }
    try { found[source.id] = readSource(source); }
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

// The records a completion works on come in the request (the caller reads them); nothing here reaches a store.
function completionInput(input) {
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || input.ids.some(id => typeof id !== 'string')) throw new Error('ids must name 1 to 100 waiting records.');
  if (typeof input.request_key !== 'string' || !input.request_key.trim()) throw new Error('request_key names this completion.');
  if (!Array.isArray(input.records)) throw new Error('records is the current waiting records, as the person\'s own store gives them: [{ id, type, value }].');
  if (input.sources !== undefined && !Array.isArray(input.sources)) throw new Error('sources is the person\'s record:waiting-sources records, as the person\'s own store gives them.');
  return { sources: sourcesFrom(input.sources ?? []), held: new Map(input.records.map(record => [record.id, record])) };
}

/** The completion of each waiting record, worked out from the records handed in, and the `keep` of each record that changes:
 * each kept record expecting the value it was read with. Only the action a source explicitly declares is
 * worked out; a source with another action owner cannot be closed by guessing a status field or deleting a display
 * card. Nothing is written here; a record that already carries this key's receipt answers completed with no write. */
export function finishWaitingOnMe(input = {}, { now = () => new Date() } = {}) {
  const { sources, held } = completionInput(input);
  const keep = [];
  const completed = [];
  const next_round = [];
  const signature = makeHashCodeHexFromJson({ ids: [...new Set(input.ids)].sort(), showed: input.showed ?? {} });
  for (const id of new Set(input.ids)) {
    const source = sourceFor(sources, id);
    if (!source || !object(source.done.set)) throw new Error(`This waiting item must be completed through its source owner: ${id}`);
    const before = held.get(id);
    if (before?.type !== source.done.record_type || !object(before.value)) throw new Error(`This waiting item was not handed in: ${id}`);
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
    if (JSON.stringify(value) !== JSON.stringify(before.value)) keep.push({ id, type: source.done.record_type, value, expected: { type: source.done.record_type, value: before.value } });
    (continuing ? next_round : completed).push(id);
  }
  return { completed, changed: keep.length, keep, ...(next_round.length ? { next_round } : {}) };
}

/** Whether a completion's saved receipt still holds on the records handed in, whatever a feed showed or hid. */
export function verifyWaitingCompletion(input = {}) {
  const { sources, held } = completionInput(input);
  const completed = [], next_round = [];
  for (const id of new Set(input.ids)) {
    const source = sourceFor(sources, id);
    if (!source || !object(source.done.set)) throw new Error('This item must be verified by its source owner.');
    const current = held.get(id);
    const receipt = current?.value?.waiting_finish;
    if (!current || receipt?.key !== input.request_key || !receiptEffectHolds(source, current.value, receipt)) {
      throw Object.assign(new Error('The current waiting item no longer proves that completion.'), { code: 'original_command_conflict' });
    }
    (receipt.next_round ? next_round : completed).push(id);
  }
  return { completed, ...(next_round.length ? { next_round } : {}) };
}

