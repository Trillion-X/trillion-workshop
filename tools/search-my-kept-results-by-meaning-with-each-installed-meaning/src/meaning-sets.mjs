// src/meaning-sets.mjs
//
// PURPOSE
//   The passages of a person's kept results encoded by every meaning encoder they installed, so search finds things by
//   meaning in each model's space (src/search.mjs, the lane `meaning` in src/search.json). An encoder is a Marketplace
//   tool serving `encode` whose descriptor declares its space and the results it reads (`encodes`, src/meaning-spaces.mjs).
//   This runs in the person's own store, where tools can run (the search index's owners cannot), on the store's alarm.
//   A read names a result kind (its pieces' words are sent as `texts`) or file media types (the file is sent by its
//   `identity` and the tool answers `items: [{ vector, start?, end? }]`, a picture or the frames of a video).
//   Each file's vectors are kept as its `meaning` result: { sets: [{ space, place, tool_id, items: [{ v, start, end,
//   said }]}] }, one set per space and place, `v` a unit vector as float16 base64.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a model, a result kind or a tool: the installed encoders' declarations say what is read.
//   2. Results are walked by (recorded_at, rowid) through the namespace_results_kind_time index, a page per wake, so a
//      changed result is encoded again and nothing is read whole.
//   3. A run still working holds the walk where it is; the same request key reuses the run on the next wake. A run that
//      failed is tried at most `tries` times. An answer from another model than the space declares is never kept.
//   4. Encoding one space never touches another space's set. An uninstalled encoder's sets are removed, a page a wake.
//   5. A long recording is a bounded number of passages (`passage_characters`), so its `meaning` result stays small.
//
import settings from './meaning-sets.json' with { type: 'json' };
import { answeredInSpace, spaceOf } from './meaning-spaces.mjs';
import { searchFeedWriter } from '../../shared-code/src/search-feed.mjs';
import { identityOf } from '../../shared-code/src/typed-operation-contract.mjs';
import { WorkFailure } from '../../shared-code/src/failure.mjs';

const PRUNE = '(uninstalled)';
const RETIRED = 'retired';

/** A vector as base64 float16, unit length: how kept vectors are written (src/search.mjs reads them). */
export function halvesOf(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  const bits = new Uint16Array(vector.length);
  const word = new Float32Array(1), view = new Uint32Array(word.buffer);
  vector.forEach((value, index) => {
    word[0] = value / norm;
    const i = view[0], sign = (i >>> 16) & 0x8000, exponent = ((i >>> 23) & 0xff) - 127 + 15, fraction = (i >>> 13) & 0x3ff;
    bits[index] = exponent <= 0 ? sign : exponent >= 31 ? sign | 0x7c00 : sign | (exponent << 10) | fraction;
  });
  const bytes = new Uint8Array(bits.buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// `$.a.b` → value.a.b; the same small path grammar as search.json.
const atPath = (value, path) => String(path ?? '').replace(/^\$\.?/, '').split('.').filter(Boolean).reduce((held, step) => (held === null || held === undefined ? undefined : held[step]), value);

/** Consecutive pieces joined into passages of about `characters`: { text, start, end } (times when the pieces have them). */
export function passagesOf(value, read, characters) {
  const pieces = atPath(value, read.pieces_path);
  if (!Array.isArray(pieces)) return [];
  const times = read.time_fields ?? {};
  const passages = [];
  let held = null;
  for (const piece of pieces) {
    const text = typeof piece?.[read.text_field] === 'string' ? piece[read.text_field].trim() : '';
    if (!text) continue;
    const start = Number.isFinite(piece[times.start]) ? piece[times.start] : null;
    const end = Number.isFinite(piece[times.end]) ? piece[times.end] : start;
    if (held && held.text.length + text.length + 1 > characters) { passages.push(held); held = null; }
    held = held ? { text: `${held.text} ${text}`, start: held.start ?? start, end: end ?? held.end } : { text, start, end };
  }
  if (held) passages.push(held);
  return passages;
}

/**
 * The meaning-sets owner in one person's store.
 *   sql       the person's store (namespace_results)
 *   encoders  async ({ after, revision, limit }) → one durable page of tools serving `encode`
 *   runTool   input → the Workshop task ({ state, output, error })
 *   keep      rows → namespaceResults('put', rows), answering { refused? }
 *   enabled   synchronous tool → whether this installed encoder is still useful
 *   pruned    synchronous (space, { installed }) → terminal prune in transaction
 *   transaction the existing store's synchronous transaction owner
 */
export function makeMeaningSets({ sql, encoders, catalogRevision = null, runTool, keep, enabled = () => true, spaceEnabled = null, pruned = () => {}, transaction = fn => fn(), config = settings }) {
  sql.exec('CREATE TABLE IF NOT EXISTS meaning_set_cursor (space TEXT NOT NULL, read TEXT NOT NULL, after_at TEXT NOT NULL, after_identity TEXT NOT NULL, source_revision INTEGER NOT NULL DEFAULT -1, PRIMARY KEY (space, read))');
  if (!sql.exec('PRAGMA table_info(meaning_set_cursor)').toArray().some(column => column.name === 'source_revision')) {
    sql.exec('ALTER TABLE meaning_set_cursor ADD COLUMN source_revision INTEGER NOT NULL DEFAULT -1');
  }
  // The catalog rows below replace the legacy JSON walk state without opening or rewriting that old row.
  sql.exec('CREATE TABLE IF NOT EXISTS meaning_set_marks (space TEXT NOT NULL, read TEXT NOT NULL, identity TEXT NOT NULL, value_identity TEXT NOT NULL, tries INTEGER NOT NULL, said TEXT, PRIMARY KEY (space, read, identity))');
  sql.exec('CREATE TABLE IF NOT EXISTS meaning_set_receipts (signature TEXT NOT NULL, space TEXT NOT NULL, read TEXT NOT NULL, identity TEXT NOT NULL, value_identity TEXT NOT NULL, PRIMARY KEY (signature,space,read,identity))');
  sql.exec('CREATE TABLE IF NOT EXISTS meaning_set_catalog_state (singleton INTEGER PRIMARY KEY CHECK (singleton=1), revision TEXT NOT NULL, cursor TEXT, complete INTEGER NOT NULL, work_after TEXT NOT NULL DEFAULT \'\', work_done INTEGER NOT NULL DEFAULT 0, prune_after TEXT NOT NULL DEFAULT \'\', prune_done INTEGER NOT NULL DEFAULT 0, scan_after TEXT NOT NULL DEFAULT \'\', source_frontier INTEGER)');
  if (!sql.exec('PRAGMA table_info(meaning_set_catalog_state)').toArray().some(column => column.name === 'scan_after')) {
    sql.exec("ALTER TABLE meaning_set_catalog_state ADD COLUMN scan_after TEXT NOT NULL DEFAULT ''");
  }
  if (!sql.exec('PRAGMA table_info(meaning_set_catalog_state)').toArray().some(column => column.name === 'source_frontier')) {
    sql.exec('ALTER TABLE meaning_set_catalog_state ADD COLUMN source_frontier INTEGER');
  }
  if (!sql.exec('PRAGMA table_info(meaning_set_catalog_state)').toArray().some(row => row.name === 'scan_done')) sql.exec('ALTER TABLE meaning_set_catalog_state ADD COLUMN scan_done INTEGER NOT NULL DEFAULT 0');
  const catalogStateColumns = new Set(sql.exec('PRAGMA table_info(meaning_set_catalog_state)').toArray().map(row => row.name));
  if (!catalogStateColumns.has('cleanup_after_signature')) sql.exec("ALTER TABLE meaning_set_catalog_state ADD COLUMN cleanup_after_signature TEXT NOT NULL DEFAULT ''");
  if (!catalogStateColumns.has('cleanup_after_space')) sql.exec("ALTER TABLE meaning_set_catalog_state ADD COLUMN cleanup_after_space TEXT NOT NULL DEFAULT ''");
  if (!catalogStateColumns.has('cleanup_after_read')) sql.exec("ALTER TABLE meaning_set_catalog_state ADD COLUMN cleanup_after_read TEXT NOT NULL DEFAULT ''");
  if (!catalogStateColumns.has('cleanup_after_identity')) sql.exec("ALTER TABLE meaning_set_catalog_state ADD COLUMN cleanup_after_identity TEXT NOT NULL DEFAULT ''");
  if (!catalogStateColumns.has('cleanup_revision')) sql.exec('ALTER TABLE meaning_set_catalog_state ADD COLUMN cleanup_revision TEXT');
  if (!catalogStateColumns.has('cleanup_source_frontier')) sql.exec('ALTER TABLE meaning_set_catalog_state ADD COLUMN cleanup_source_frontier INTEGER');
  if (!catalogStateColumns.has('cleanup_done')) sql.exec('ALTER TABLE meaning_set_catalog_state ADD COLUMN cleanup_done INTEGER NOT NULL DEFAULT 0');
  sql.exec('CREATE TABLE IF NOT EXISTS meaning_set_catalog_tools (revision TEXT NOT NULL, tool_id TEXT NOT NULL, descriptor TEXT NOT NULL, PRIMARY KEY (revision,tool_id))');
  if (!sql.exec('PRAGMA table_info(meaning_set_catalog_tools)').toArray().some(column => column.name === 'space')) sql.exec('ALTER TABLE meaning_set_catalog_tools ADD COLUMN space TEXT');
  sql.exec('CREATE INDEX IF NOT EXISTS meaning_set_catalog_tools_space ON meaning_set_catalog_tools(revision,space,tool_id)');
  sql.exec('CREATE TABLE IF NOT EXISTS meaning_set_catalog_spaces (revision TEXT NOT NULL, space TEXT NOT NULL, PRIMARY KEY (revision,space))');
  sql.exec('CREATE TABLE IF NOT EXISTS meaning_set_catalog_signatures (revision TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY (revision,signature))');
  // Retired and uninstalled spaces remain discoverable even if their old descriptors no longer serve a job.
  sql.exec('CREATE TABLE IF NOT EXISTS meaning_set_walked (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), spaces TEXT NOT NULL)');
  // reads-ok: each caller's statement is a literal this lint checks where it is written.
  const all = (query, ...values) => {
    const bound = typeof query === 'string' && query.match(/\bLIMIT\s+(\?|\d+)\s*$/i);
    const limit = bound && (bound[1] === '?' ? values.at(-1) : Number(bound[1]));
    const most = bound?.[1] === '?' ? settings.per_wake : 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > most)
      throw TypeError('Meaning reads require a bounded terminal SQL LIMIT within the existing result/file page sizes.');
    // reads-ok: executable terminal LIMIT enforces the existing bounded result and file page sizes; keys are indexed.
    return sql.exec(query, ...values).toArray();
  };
  const catalogState = () => all('SELECT revision,cursor,complete,work_after,work_done,prune_after,prune_done,scan_after,source_frontier,scan_done,cleanup_after_signature,cleanup_after_space,cleanup_after_read,cleanup_after_identity,cleanup_revision,cleanup_source_frontier,cleanup_done FROM meaning_set_catalog_state WHERE singleton=1 LIMIT 1')[0] ?? null;
  const saveCatalogState = state => sql.exec(`INSERT INTO meaning_set_catalog_state (singleton,revision,cursor,complete,work_after,work_done,prune_after,prune_done,scan_after,source_frontier,scan_done,cleanup_after_signature,cleanup_after_space,cleanup_after_read,cleanup_after_identity,cleanup_revision,cleanup_source_frontier,cleanup_done)
    VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor,complete=excluded.complete,
    work_after=excluded.work_after,work_done=excluded.work_done,prune_after=excluded.prune_after,prune_done=excluded.prune_done,scan_after=excluded.scan_after,source_frontier=excluded.source_frontier,scan_done=excluded.scan_done,
    cleanup_after_signature=excluded.cleanup_after_signature,cleanup_after_space=excluded.cleanup_after_space,cleanup_after_read=excluded.cleanup_after_read,cleanup_after_identity=excluded.cleanup_after_identity,
    cleanup_revision=excluded.cleanup_revision,cleanup_source_frontier=excluded.cleanup_source_frontier,cleanup_done=excluded.cleanup_done`,
    String(state.revision), state.cursor ?? null, state.complete ? 1 : 0, state.work_after ?? '', state.work_done ? 1 : 0, state.prune_after ?? '', state.prune_done ? 1 : 0, state.scan_after ?? '', state.source_frontier ?? null, state.scan_done ? 1 : 0,
    state.cleanup_after_signature ?? '', state.cleanup_after_space ?? '', state.cleanup_after_read ?? '', state.cleanup_after_identity ?? '', state.cleanup_revision ?? null, state.cleanup_source_frontier ?? null, state.cleanup_done ? 1 : 0);
  const addCatalogTools = (revision, tools) => {
    // One revision is an immutable descriptor snapshot. The same tool may
    // appear on several physical holder pages, but its definition must agree.
    for (const tool of tools) {
      if (typeof tool?.id !== 'string') continue;
      const [held] = all('SELECT descriptor FROM meaning_set_catalog_tools WHERE revision=? AND tool_id=? LIMIT 1', String(revision), tool.id);
      if (!held) continue;
      let prior;
      try { prior = JSON.parse(held.descriptor); } catch { return false; }
      if (identityOf(prior) !== identityOf(tool)) return false;
    }
    for (const tool of tools) {
      if (typeof tool?.id !== 'string') continue;
      const space = spaceOf(tool);
      const signature = `${tool.id}:${JSON.stringify(tool.encodes ?? {})}`;
      if (readsOf(tool).some(read => !read.result_kind)) feed.watchFiles();
      feed.register(readsOf(tool).filter(read => typeof read.result_kind === 'string').map(read => read.result_kind));
      sql.exec('INSERT INTO meaning_set_catalog_tools (revision,tool_id,descriptor,space) VALUES (?,?,?,?) ON CONFLICT(revision,tool_id) DO UPDATE SET descriptor=excluded.descriptor,space=excluded.space', String(revision), tool.id, JSON.stringify(tool), space);
      sql.exec('INSERT OR IGNORE INTO meaning_set_catalog_signatures (revision,signature) VALUES (?,?)', String(revision), signature);
      if (space) sql.exec('INSERT OR IGNORE INTO meaning_set_catalog_spaces (revision,space) VALUES (?,?)', String(revision), space);
      if (space && !walked().includes(space)) setWalked([...walked(), space]);
    }
    return true;
  };
  const oldToolRevision = revision => all('SELECT revision FROM meaning_set_catalog_tools WHERE revision < ? LIMIT 1', revision)[0]
    ?? all('SELECT revision FROM meaning_set_catalog_tools WHERE revision > ? LIMIT 1', revision)[0];
  const oldSpaceRevision = revision => all('SELECT revision FROM meaning_set_catalog_spaces WHERE revision < ? LIMIT 1', revision)[0]
    ?? all('SELECT revision FROM meaning_set_catalog_spaces WHERE revision > ? LIMIT 1', revision)[0];
  const oldSignatureRevision = revision => all('SELECT revision FROM meaning_set_catalog_signatures WHERE revision < ? LIMIT 1', revision)[0]
    ?? all('SELECT revision FROM meaning_set_catalog_signatures WHERE revision > ? LIMIT 1', revision)[0];
  // Old catalog snapshots are removed in small indexed pages after a replacement snapshot is complete.
  function cleanupCatalog(state) {
    const revision = String(state.revision), frontier = feed.sourceRevision();
    if (state.cleanup_revision !== revision) {
      state.cleanup_after_signature = ''; state.cleanup_after_space = ''; state.cleanup_after_read = ''; state.cleanup_after_identity = '';
      state.cleanup_revision = revision; state.cleanup_source_frontier = frontier; state.cleanup_done = 0;
    } else if (state.cleanup_done && state.cleanup_source_frontier !== frontier) {
      // Finish each bounded keyset pass before restarting for concurrent source changes.
      state.cleanup_after_signature = ''; state.cleanup_after_space = ''; state.cleanup_after_read = ''; state.cleanup_after_identity = '';
      state.cleanup_source_frontier = frontier; state.cleanup_done = 0;
    }
    if (!state.cleanup_done) {
      const page = all(`SELECT signature,space,read,identity FROM meaning_set_receipts
        WHERE (signature,space,read,identity) > (?,?,?,?) ORDER BY signature,space,read,identity LIMIT 32`,
        state.cleanup_after_signature ?? '', state.cleanup_after_space ?? '', state.cleanup_after_read ?? '', state.cleanup_after_identity ?? '');
      for (const row of page) {
        const [installed] = all('SELECT 1 AS present FROM meaning_set_catalog_signatures WHERE revision=? AND signature=? LIMIT 1', revision, row.signature);
        let exists;
        if (installed) {
          if (row.read.startsWith('files:')) {
            [exists] = all('SELECT 1 AS present FROM namespace_files WHERE identity=? LIMIT 1', row.identity);
          } else {
            const kind = row.read.slice(0, row.read.indexOf('>'));
            [exists] = all('SELECT 1 AS present FROM namespace_results WHERE kind=? AND identity=? LIMIT 1', kind, row.identity);
          }
        }
        if (!installed || !exists) sql.exec('DELETE FROM meaning_set_receipts WHERE signature=? AND space=? AND read=? AND identity=?', row.signature, row.space, row.read, row.identity);
      }
      if (page.length) {
        const last = page.at(-1);
        state.cleanup_after_signature = last.signature; state.cleanup_after_space = last.space; state.cleanup_after_read = last.read; state.cleanup_after_identity = last.identity;
      }
      if (page.length < 32) {
        state.cleanup_done = 1;
        const latestFrontier = feed.sourceRevision();
        if (latestFrontier !== state.cleanup_source_frontier) {
          state.cleanup_after_signature = ''; state.cleanup_after_space = ''; state.cleanup_after_read = ''; state.cleanup_after_identity = '';
          state.cleanup_source_frontier = latestFrontier; state.cleanup_done = 0;
        }
      }
      saveCatalogState(state);
      if (!state.cleanup_done) return true;
    }
    const old = oldToolRevision(revision);
    if (!old) {
      const space = oldSpaceRevision(revision);
      if (space) {
        const rows = all('SELECT space FROM meaning_set_catalog_spaces WHERE revision=? ORDER BY space LIMIT 32', space.revision);
        for (const row of rows) sql.exec('DELETE FROM meaning_set_catalog_spaces WHERE revision=? AND space=?', space.revision, row.space);
        return rows.length > 0;
      }
      const signature = oldSignatureRevision(revision);
      if (!signature) return false;
      const rows = all('SELECT signature FROM meaning_set_catalog_signatures WHERE revision=? ORDER BY signature LIMIT 32', signature.revision);
      for (const row of rows) sql.exec('DELETE FROM meaning_set_catalog_signatures WHERE revision=? AND signature=?', signature.revision, row.signature);
      return rows.length > 0;
    }
    const rows = all('SELECT tool_id FROM meaning_set_catalog_tools WHERE revision=? ORDER BY tool_id LIMIT 32', old.revision);
    for (const row of rows) sql.exec('DELETE FROM meaning_set_catalog_tools WHERE revision=? AND tool_id=?', old.revision, row.tool_id);
    return rows.length > 0;
  }
  const walked = () => { try { return JSON.parse(all('SELECT spaces FROM meaning_set_walked WHERE singleton = 1 LIMIT 1')[0]?.spaces ?? '[]'); } catch { return []; } };
  const setWalked = spaces => sql.exec('INSERT INTO meaning_set_walked (singleton, spaces) VALUES (1, ?) ON CONFLICT (singleton) DO UPDATE SET spaces = excluded.spaces', JSON.stringify([...new Set(spaces)].sort()));
  let lastWake = Date.now() - config.seconds_between_wakes * 1000;
  const readsOf = tool => tool.encodes?.reads ?? [];
  const catalogMatches = revision => !catalogRevision || String(catalogRevision()) === String(revision);
  const readKey = read => (read.result_kind ? `${read.result_kind}>${read.place}` : `files:${read.media_types.join(',')}>${read.place}`);
  // Bind the existing progress key to the actual read DATA. A mutable saved
  // descriptor can change extraction without changing model space or place.
  const definitionKey = read => `(definition)${readKey(read)}`;
  const sameRead = (space, read) => cursorOf(space, definitionKey(read)).after_at === identityOf(read);
  function prepareRead(space, read) {
    if (sameRead(space, read)) return;
    transaction(() => {
      const key = readKey(read);
      sql.exec('DELETE FROM meaning_set_cursor WHERE space = ? AND read = ?', space, key);
      sql.exec('DELETE FROM meaning_set_marks WHERE space = ? AND read = ?', space, key);
      moveCursor(space, definitionKey(read), identityOf(read), '');
    });
  }
  const typeMatches = (types, mediaType) => { const type = String(mediaType ?? '').split(';')[0].trim().toLowerCase(); return types.some(pattern => (pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern)); };
  const feed = searchFeedWriter(sql);
  const cursorOf = (space, read) => all('SELECT after_at, after_identity,source_revision FROM meaning_set_cursor WHERE space = ? AND read = ? LIMIT 1', space, read)[0] ?? { after_at: '', after_identity: '', source_revision: -1 };
  const resetCursor = (space, read, sourceRevision) => sql.exec('INSERT INTO meaning_set_cursor (space,read,after_at,after_identity,source_revision) VALUES (?,?,\'\',\'\',?) ON CONFLICT(space,read) DO UPDATE SET after_at=\'\',after_identity=\'\',source_revision=excluded.source_revision', space, read, sourceRevision);
  const moveCursor = (space, read, at, identity, sourceRevision=-1) => sql.exec('INSERT INTO meaning_set_cursor (space, read, after_at, after_identity,source_revision) VALUES (?, ?, ?, ?,?) ON CONFLICT (space, read) DO UPDATE SET after_at = excluded.after_at, after_identity = excluded.after_identity,source_revision=excluded.source_revision', space, read, at, identity,sourceRevision);
  const moveResultCursor = (space, read, at, rowid, sourceRevision) => moveCursor(space, read, at, `rowid:${rowid}`,sourceRevision);
  // What a read has after its cursor: results of its kind in the order they were kept (the kind_time index), or files
  // of its media types in the order they arrived (namespace_files rowid; `value_identity` is the file's own identity,
  // its bytes, so a file is encoded once).
  const after = (read, cursor, limit) => (read.result_kind
    ? resultAfter(read, cursor, limit)
    : filesAfter(read, cursor, limit));
  function resultAfter(read, cursor, limit) {
    const at = cursor.after_at ?? '', match = /^rowid:(\d+)$/.exec(cursor.after_identity ?? '');
    const rowid = match ? Number(match[1]) : 0;
    const sameTime = rowid && at
      ? all(`SELECT rowid AS source_rowid,identity,value,value_identity,recorded_at FROM namespace_results INDEXED BY namespace_results_kind_time
        WHERE kind=? AND recorded_at=? AND rowid>? ORDER BY rowid LIMIT ?`, read.result_kind, at, rowid, limit)
      : [];
    if (sameTime.length >= limit) return sameTime;
    return [...sameTime, ...all(`SELECT rowid AS source_rowid,identity,value,value_identity,recorded_at FROM namespace_results INDEXED BY namespace_results_kind_time
      WHERE kind=? AND recorded_at>? ORDER BY recorded_at,rowid LIMIT ?`, read.result_kind, at, limit - sameTime.length)];
  }
  function filesAfter(read, cursor, limit) {
    const found = [];
    let from = Number(cursor.after_at) || 0;
    // A page of files at a time, most of which may be of other types; one call looks at most four pages.
    for (let page = 0; page < 4 && found.length < limit; page += 1) {
      const rows = all('SELECT rowid AS at, identity, media_type FROM namespace_files WHERE rowid > ? ORDER BY rowid LIMIT 500', from);
      for (const row of rows) {
        if (found.length >= limit) break;
        from = row.at;
        if (typeMatches(read.media_types, row.media_type)) found.push({ identity: row.identity, value: null, value_identity: row.identity, recorded_at: String(row.at), at: row.at });
      }
      if (rows.length < 500) break;
    }
    // Files looked at past the last matching one move the cursor too, so a store of other files is passed once.
    if (found.length < limit && from > (found.at(-1)?.at ?? (Number(cursor.after_at) || 0))) found.push({ passed: true, identity: '', recorded_at: String(from) });
    return found;
  }
  const meaningOf = identity => { try { return JSON.parse(all("SELECT value FROM namespace_results WHERE identity = ? AND kind = 'meaning' LIMIT 1", identity)[0]?.value ?? '{}'); } catch { return {}; } };

  async function keepSets(identity, sets, expectedRevision) {
    // Individual encoder ids remain on each set; the result producer names this owner so its output cannot move the
    // input frontier and trigger a self-sustaining re-encode cycle.
    const answer = await keep([{ identity, kind: 'meaning', value: { sets }, produced_by: 'search:meaning' }], expectedRevision);
    if (answer?.stale) return { stale: true };
    if (answer?.refused?.length) throw new Error(`The meaning vectors could not be kept: ${answer.refused[0].reason}`);
    return { stale: false };
  }
  const changed = () => Object.assign(new WorkFailure('service-busy', 'The installed meaning encoder changed while work was awaited.'), { status: 503, code: 'meaning_encoder_changed' });
  async function assertEnabled(tool, definition, expectedRevision = null) {
    if (catalogRevision && expectedRevision !== null && expectedRevision !== undefined) {
      if (!catalogMatches(expectedRevision) || !enabled(tool)) throw changed();
      return;
    }
    const held = await encoders();
    if (!Array.isArray(held) || !held.some(current => current.id === tool.id && spaceOf(current) === spaceOf(tool) && identityOf(current) === definition && enabled(current))) throw changed();
  }
  async function runCurrent(tool, input, definition, expectedRevision = null) {
    let task;
    try { task = await runTool(input); }
    catch (error) { await assertEnabled(tool, definition, expectedRevision); throw error; }
    // A withdrawn/replaced encoder never spends the old model's retry budget,
    // even when its reply failed, is malformed, or is still pending.
    await assertEnabled(tool, definition, expectedRevision);
    return task;
  }

  // One file's own vectors from an encoder that reads files: { items } or { pending }.
  async function encodeFile(tool, read, row, definition, expectedRevision = null) {
    const task = await runCurrent(tool, { tool_id: tool.id, input: { identity: row.identity }, request_key: `meaning:${spaceOf(tool)}:${row.identity}:${definition}:${identityOf(read)}`, wait_seconds: config.tool_wait_seconds }, definition, expectedRevision);
    if (task?.state === 'failed') throw new Error(task.error ?? `${tool.id} did not start`);
    if (task?.state !== 'completed') return { pending: true };
    if (!answeredInSpace(tool, task.output)) throw new Error(`${tool.id} answered with another model than its space declares`);
    const made = task.output?.items;
    if (!Array.isArray(made) || made.some(item => !Array.isArray(item?.vector) || item.vector.length !== tool.encodes.space.dim)) throw new Error(`${tool.id} answered no items of ${tool.encodes.space.dim}-number vectors`);
    return { items: made.map(item => ({ v: halvesOf(item.vector), start: Number.isFinite(item.start) ? item.start : null, end: Number.isFinite(item.end) ? item.end : null, said: null })) };
  }

  // One result's (or file's) vectors in one encoder's space: { kept } once its set is written, { pending } while a run works.
  async function encodeResult(tool, read, row, expectedRevision) {
    const space = spaceOf(tool), definition = identityOf(tool), reading = identityOf(read);
    if (!read.result_kind) {
      const made = await encodeFile(tool, read, row, definition, expectedRevision);
      if (made.pending) return made;
      if (!catalogMatches(expectedRevision)) return { stale: true };
      const others = (meaningOf(row.identity).sets ?? []).filter(set => !(set.space === space && set.place === read.place));
      const kept = await keepSets(row.identity, made.items.length ? [...others, { space, place: read.place, tool_id: tool.id, items: made.items }] : others, expectedRevision);
      if (kept.stale) return { stale: true };
      return { kept: made.items.length };
    }
    let value;
    try { value = JSON.parse(row.value); } catch { value = null; }
    const passages = passagesOf(value, read, config.passage_characters);
    const vectors = [];
    for (let at = 0; at < passages.length; at += config.per_request) {
      const batch = passages.slice(at, at + config.per_request);
      const input = { texts: batch.map(passage => `${tool.encodes.space.passage_prompt ?? ''}${passage.text}`) };
      const task = await runCurrent(tool, { tool_id: tool.id, input, request_key: `meaning:${space}:${row.identity}:${row.value_identity}:${definition}:${reading}:${at}`, wait_seconds: config.tool_wait_seconds }, definition, expectedRevision);
      if (task?.state === 'failed') throw new Error(task.error ?? `${tool.id} did not start`);
      if (task?.state !== 'completed') return { pending: true };
      if (!answeredInSpace(tool, task.output)) throw new Error(`${tool.id} answered with another model than its space declares`);
      const made = task.output?.vectors;
      if (!Array.isArray(made) || made.length !== batch.length || made.some(vector => !Array.isArray(vector) || vector.length !== tool.encodes.space.dim)) throw new Error(`${tool.id} answered no vector of ${tool.encodes.space.dim} numbers for each passage`);
      vectors.push(...made);
    }
    if (!catalogMatches(expectedRevision)) return { stale: true };
    await assertEnabled(tool, definition, expectedRevision);
    const others = (meaningOf(row.identity).sets ?? []).filter(set => !(set.space === space && set.place === read.place));
    const items = passages.map((passage, index) => ({ v: halvesOf(vectors[index]), start: passage.start, end: passage.end, said: passage.text }));
    const kept = await keepSets(row.identity, items.length ? [...others, { space, place: read.place, tool_id: tool.id, items }] : others, expectedRevision);
    if (kept.stale) return { stale: true };
    return { kept: items.length };
  }

  // Retirement removes vectors but retains its learned evidence and a completed
  // prune in the existing cursor. Actual uninstall also releases that evidence.
  function finishPrune(space, installed) {
    transaction(() => {
      pruned(space, { installed });
      for (const table of ['meaning_set_cursor', 'meaning_set_marks']) sql.exec(`DELETE FROM ${table} WHERE space = ?`, space);
      if (installed) moveCursor(space, PRUNE, RETIRED, '');
      else setWalked(walked().filter(held => held !== space));
    });
  }
  async function currentInstallation(state, space) {
    if (!catalogRevision) {
      const tools = await encoders();
      if (Array.isArray(tools)) {
        const matching = tools.filter(tool => spaceOf(tool) === space);
        return { installed: matching.length > 0, active: matching.some(enabled) };
      }
    }
    const present = all('SELECT 1 AS present FROM meaning_set_catalog_spaces WHERE revision=? AND space=? LIMIT 1', state.revision, space).length > 0;
    if (spaceEnabled) return { installed: present, active: present && spaceEnabled(space) };
    let afterTool = '';
    for (;;) {
      const page = all('SELECT descriptor,tool_id FROM meaning_set_catalog_tools WHERE revision=? AND space=? AND tool_id>? ORDER BY tool_id LIMIT 32', state.revision, space, afterTool);
      for (const row of page) {
        let tool;
        try { tool = JSON.parse(row.descriptor); } catch { continue; }
        if (enabled(tool)) return { installed: true, active: true };
      }
      if (page.length < 32) return { installed: present, active: false };
      afterTool = page.at(-1).tool_id;
    }
  }
  async function pruneInactive(state, answer, budget) {
    let pending = false;
    const spaces = walked();
    for (const space of spaces) {
      if (budget.left <= 0) { pending = true; break; }
      if (!catalogMatches(state.revision)) return true;
      const status = await currentInstallation(state, space);
      const cursor = cursorOf(space, PRUNE);
      if (status.active) {
        if (all('SELECT 1 FROM meaning_set_cursor WHERE space=? AND read=? LIMIT 1',space,PRUNE).length) transaction(() => {
          for (const table of ['meaning_set_cursor', 'meaning_set_marks']) sql.exec(`DELETE FROM ${table} WHERE space = ?`, space);
          state.work_after = ''; state.work_done = 0; state.scan_after = ''; state.scan_done = 0;
        });
        continue;
      }
      if (cursor.after_at === RETIRED) {
        if (!status.installed) finishPrune(space, false);
        continue;
      }
      const limit = Math.min(config.per_wake, budget.left);
      const rows = all("SELECT identity, value FROM namespace_results WHERE kind = 'meaning' AND identity > ? ORDER BY identity LIMIT ?", cursor.after_identity, limit);
      // A real checkpoint precedes an awaited removal, including an uncertain
      // keep reply, so active re-admission can repair every partially pruned row.
      if (rows.length) moveCursor(space, PRUNE, '', cursor.after_identity);
      for (const row of rows) {
        if (!catalogMatches(state.revision) || (await currentInstallation(state, space)).active) throw changed();
        budget.left -= 1;
        // namespaceResults starts its synchronous results.put transaction when
        // keep is invoked. Read the current value after the final await, then
        // remove only this space in that same turn, preserving fresh siblings.
        const value = meaningOf(row.identity), sets = Array.isArray(value?.sets) ? value.sets : [];
        if (sets.some(set => set.space === space)) {
          const kept = await keepSets(row.identity, sets.filter(set => set.space !== space), state.revision);
          if (kept.stale) return true;
          answer.removed += 1;
          if (!catalogMatches(state.revision) || (await currentInstallation(state, space)).active) throw changed();
        }
      }
      if (rows.length < limit) finishPrune(space, status.installed);
      else {
        moveCursor(space, PRUNE, '', rows.at(-1).identity);
        pending = true;
      }
    }
    return pending;
  }

  /**
   * Encodes up to per_wake results; answers { kept, pending, failed, removed, done }. `stage` is the scheduler's budget
   * ({ left() }): once spent, no further result is started.
   */
  async function catchUp(stage = null, followedEmptyPage = false) {
    if (!Number.isSafeInteger(config.per_wake) || config.per_wake < 1 || config.per_wake > settings.per_wake)
      throw TypeError('Meaning reads require a bounded terminal SQL LIMIT within the existing result/file page sizes.');
    lastWake = Date.now();
    const answer = { kept: 0, pending: 0, failed: 0, removed: 0 };
    let state = catalogState();
    let currentRevision = catalogRevision ? String(catalogRevision()) : null;
    if (state && currentRevision !== null && state.revision !== currentRevision) state = null;
    if (!state || !state.complete || !catalogRevision) {
      state ??= { revision: currentRevision ?? '', cursor: null, complete: 0, work_after: '', work_done: 0, prune_after: '', prune_done: 0, scan_after: '', source_frontier: null };
      let page = await encoders({ after: state.cursor || null, revision: state.revision || null, limit: 32 });
      if (Array.isArray(page) && !catalogRevision) {
        const tools = page;
        currentRevision = `compat:${JSON.stringify(tools.map(tool => [tool?.id, identityOf(tool)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))}`;
        if (state.revision !== currentRevision) state = { revision: currentRevision, cursor: null, complete: 0, work_after: '', work_done: 0, prune_after: '', prune_done: 0, scan_after: '', source_frontier: null };
        page = { tools, cursor: { after: null, revision: currentRevision }, complete: true, restart: false };
      }
      if (catalogRevision && String(catalogRevision()) !== String(page?.cursor?.revision ?? page?.revision ?? '')) {
        answer.pending += 1;
        return { ...answer, done: false };
      }
      if (Array.isArray(page)) {
        answer.pending += 1;
        saveCatalogState(state);
        return { ...answer, done: false };
      } else if (!page || !Array.isArray(page.tools)) {
        answer.pending += 1; saveCatalogState(state);
        return { ...answer, done: false };
      } else if (state.revision && state.revision !== String(page.cursor?.revision ?? page.revision ?? currentRevision ?? '') && state.cursor) {
        const revision = String(page.cursor?.revision ?? page.revision ?? currentRevision ?? '');
        state = { revision, cursor: null, complete: 0, work_after: '', work_done: 0, prune_after: '', prune_done: 0, scan_after: '', source_frontier: null };
        answer.pending += 1; saveCatalogState(state);
        return { ...answer, done: false };
      } else if (page.restart || (page.cursor?.revision !== undefined && state.revision && String(page.cursor.revision) !== state.revision)) {
        const revision = String(page.cursor?.revision ?? page.revision ?? currentRevision ?? '');
        state = { revision, cursor: null, complete: 0, work_after: '', work_done: 0, prune_after: '', prune_done: 0, scan_after: '', source_frontier: null };
        answer.pending += 1; saveCatalogState(state);
        return { ...answer, done: false };
      } else {
        state.revision = String(page.cursor?.revision ?? page.revision ?? state.revision ?? '');
        if (page.pending) {
          // Continue past the descriptors that could not be read yet; the pass completes only once none is unread.
          state.cursor = page.cursor?.after ?? null;
          answer.pending += 1; saveCatalogState(state);
          return { ...answer, done: false };
        }
        if (!addCatalogTools(state.revision, page.tools)) {
          answer.pending += 1;
          saveCatalogState(state);
          return { ...answer, done: false };
        }
        const completedBefore = state.complete;
        state.cursor = page.cursor?.after ?? page.next_cursor ?? null;
        state.complete = page.complete === true ? 1 : 0;
        if (state.complete && !completedBefore) { state.cursor = null; state.work_after = ''; state.work_done = 0; state.prune_after = ''; state.prune_done = 0; state.scan_after = ''; state.scan_done = 0; state.source_frontier = null; }
      }
      saveCatalogState(state);
      // A scheduler invocation reads one catalog page. No partial inventory can be used to prune. A page that held no tool
      // (the shipped tools ended, or there are none) read no descriptor, so the next page is read in the same invocation,
      // once: an emptied store's catalog completes in one wake (test/delete-everything-lazy-tables.test.mjs).
      if (!state.complete) return page?.tools?.length === 0 && !followedEmptyPage ? catchUp(stage, true) : { ...answer, done: false };
    }

    if (!catalogMatches(state.revision)) {
      answer.pending += 1;
      return { ...answer, done: false };
    }
    cleanupCatalog(state);
    if (!catalogMatches(state.revision)) {
      answer.pending += 1;
      return { ...answer, done: false };
    }
    if (state.source_frontier === null || state.source_frontier === undefined) state.source_frontier = feed.sourceRevision();
    saveCatalogState(state);
    let budget = config.per_wake;
    const spent = () => budget <= 0 || (stage !== null && stage.left() <= 0);
    const pruningPending = await pruneInactive(state, answer, { get left() { return Math.min(budget, stage === null ? budget : stage.left()); }, set left(value) { budget = value; } });
    if (pruningPending) { state.prune_done = 0; saveCatalogState(state); return { ...answer, done: false }; }
    state.prune_done = 1;
    saveCatalogState(state);
    if (budget > 0 && !state.work_done) {
      const toolRows = all('SELECT tool_id,descriptor FROM meaning_set_catalog_tools WHERE revision=? AND tool_id>? ORDER BY tool_id LIMIT 32', state.revision, state.work_after);
      for (const saved of toolRows) {
        if (spent()) break;
        let tool;
        try { tool = JSON.parse(saved.descriptor); } catch { state.work_after = saved.tool_id; continue; }
        if (!enabled(tool)) { state.work_after = saved.tool_id; continue; }
        let finishedTool = true;
        for (const read of readsOf(tool)) {
          const space = spaceOf(tool), key = readKey(read);
          if (spent()) { finishedTool = false; break; }
          prepareRead(space, read);
          let cursor = cursorOf(space, key);
          let freshPosition=false;
          if (cursor.source_revision !== state.source_frontier) {
            // A new read has no committed input position to reset. Keep it
            // absent until an admitted reply advances it; withdrawn work must
            // not leave an apparent source-position receipt.
            if(all('SELECT 1 FROM meaning_set_cursor WHERE space=? AND read=? LIMIT 1',space,key).length)
              resetCursor(space, key, state.source_frontier);
            else freshPosition=true;
            cursor={after_at:'',after_identity:'',source_revision:state.source_frontier};
          } else if (read.result_kind && cursor.after_identity && !/^rowid:\d+$/.test(cursor.after_identity)) {
            // Older releases ordered by identity. Restart safely; successful receipts avoid re-encoding unchanged rows.
            resetCursor(space, key, state.source_frontier);
            cursor = cursorOf(space, key);
          }
          const sourcePage=after(read, cursor, Math.max(1, budget));
          if(freshPosition&&!sourcePage.length)moveCursor(space,key,cursor.after_at,cursor.after_identity,state.source_frontier);
          for (const row of sourcePage) {
            if (row.passed) { moveCursor(space, key, row.recorded_at, '',state.source_frontier); continue; }
            if (spent()) { finishedTool = false; break; }
            budget -= 1;
            const [mark] = all('SELECT value_identity, tries FROM meaning_set_marks WHERE space = ? AND read = ? AND identity = ? LIMIT 1', space, key, row.identity);
            const signature = `${tool.id}:${JSON.stringify(tool.encodes ?? {})}`;
            const [receipt] = all('SELECT value_identity FROM meaning_set_receipts WHERE signature=? AND space=? AND read=? AND identity=? LIMIT 1', signature, space, key, row.identity);
            const currentSets = receipt?.value_identity === row.value_identity ? meaningOf(row.identity).sets ?? [] : [];
            if (receipt?.value_identity === row.value_identity && currentSets.some(set => set.space === space && set.place === read.place)) {
              sql.exec('DELETE FROM meaning_set_marks WHERE space = ? AND read = ? AND identity = ?', space, key, row.identity);
            } else if (!(mark?.value_identity === row.value_identity && mark.tries >= config.tries)) {
              try {
                const done = await encodeResult(tool, read, row, state.revision);
                if (done.stale) {
                  answer.pending += 1;
                  return { ...answer, done: false };
                }
                if (done.pending) { answer.pending += 1; finishedTool = false; break; }
                answer.kept += 1;
                sql.exec('INSERT INTO meaning_set_receipts (signature,space,read,identity,value_identity) VALUES (?,?,?,?,?) ON CONFLICT(signature,space,read,identity) DO UPDATE SET value_identity=excluded.value_identity', signature, space, key, row.identity, row.value_identity);
                sql.exec('DELETE FROM meaning_set_marks WHERE space = ? AND read = ? AND identity = ?', space, key, row.identity);
              } catch (error) {
                if(error.code==='meaning_encoder_changed')throw error;
                answer.failed += 1;
                const tries = (mark?.value_identity === row.value_identity ? mark.tries : 0) + 1;
                sql.exec('INSERT INTO meaning_set_marks (space, read, identity, value_identity, tries, said) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (space, read, identity) DO UPDATE SET value_identity = excluded.value_identity, tries = excluded.tries, said = excluded.said',
                  space, key, row.identity, row.value_identity, tries, (error instanceof Error ? error.message : String(error)).slice(0, 300));
                if (tries < config.tries) { finishedTool = false; break; }
              }
            }
            if (read.result_kind) moveResultCursor(space, key, row.recorded_at, row.source_rowid,state.source_frontier);
            else moveCursor(space, key, row.recorded_at, row.identity,state.source_frontier);
          }
          // Filling the entire admitted page does not prove this read is
          // exhausted. Resume this tool directly instead of skipping it and
          // requiring the stale scanner to discover it again next wake.
          if (spent()) finishedTool = false;
          if (!finishedTool) break;
        }
        if (!finishedTool) break;
        state.work_after = saved.tool_id;
      }
      if (toolRows.length < 32 && !spent() && !answer.pending) state.work_done = 1;
      saveCatalogState(state);
    }
    return { ...answer, done: !(await stale()) };
  }

  /** Whether any result is still owed an encoding in an installed space (or files passed since the cursor, which one
   *  wake moves past), or an uninstalled space still has sets. */
  async function stale() {
    const state = catalogState();
    let current = catalogRevision ? String(catalogRevision()) : null;
    if (!catalogRevision) {
      const tools = await encoders();
      if (Array.isArray(tools)) {
        current = `compat:${JSON.stringify(tools.map(tool => [tool?.id, identityOf(tool)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))}`;
        for (const tool of tools) {
          const space = spaceOf(tool), active = enabled(tool);
          const cursor = all('SELECT after_at FROM meaning_set_cursor WHERE space=? AND read=? LIMIT 1', space, PRUNE)[0];
          if (active ? Boolean(cursor) : cursor?.after_at !== RETIRED) return true;
        }
      }
    }
    if (!state || !state.complete || !state.prune_done || !state.work_done || !state.cleanup_done || (current !== null && state.revision !== current)) return true;
    const sourceFrontier = feed.sourceRevision();
    if (state.source_frontier !== sourceFrontier) {
      state.source_frontier = sourceFrontier;
      state.work_after = '';
      state.work_done = 0;
      state.scan_after = ''; state.scan_done = 0;
      saveCatalogState(state);
      return true;
    }
    const oldCatalog = oldToolRevision(state.revision);
    const oldSpaces = oldSpaceRevision(state.revision);
    const oldSignatures = oldSignatureRevision(state.revision);
    if (oldCatalog || oldSpaces || oldSignatures) return true;
    if (state.scan_done) return false;
    const tools = all('SELECT tool_id,descriptor FROM meaning_set_catalog_tools WHERE revision=? AND tool_id>? ORDER BY tool_id LIMIT 32', state.revision, state.scan_after ?? '');
    for (let at = 0; at < tools.length; at += 1) {
      let tool;
      try { tool = JSON.parse(tools[at].descriptor); } catch { continue; }
      if (!enabled(tool)) continue;
      let resetLegacy = false;
      const owesWork = readsOf(tool).some(read => {
        let cursor = cursorOf(spaceOf(tool), readKey(read));
        if (read.result_kind && cursor.source_revision === state.source_frontier && cursor.after_identity && !/^rowid:\d+$/.test(cursor.after_identity)) {
          // Legacy identity cursors cannot be translated into rowids. Reset and let receipts preserve completed work.
          resetCursor(spaceOf(tool), readKey(read), state.source_frontier);
          cursor = cursorOf(spaceOf(tool), readKey(read));
          resetLegacy = true;
        }
        return cursor.source_revision !== state.source_frontier || after(read, cursor, 1).length > 0;
      });
      if (resetLegacy || owesWork) {
        state.work_after = at ? tools[at - 1].tool_id : (state.scan_after ?? '');
        state.work_done = 0;
        state.scan_after = ''; state.scan_done = 0;
        saveCatalogState(state);
        return true;
      }
    }
    if (tools.length < 32) {
      state.scan_after = ''; state.scan_done = 1;
      saveCatalogState(state);
      return false;
    }
    state.scan_after = tools.at(-1).tool_id;
    saveCatalogState(state);
    return true;
  }

  /** When the alarm should next encode, or null when nothing is owed. */
  const nextAt = async () => ((await stale()) ? lastWake + config.seconds_between_wakes * 1000 : null);

  return { catchUp, stale, nextAt };
}
