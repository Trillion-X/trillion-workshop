// src/media-library.mjs
//
// PURPOSE
//   The Media section's rows: every recording the person's library knows and every file their tools made, each with
//   what has been worked out about it (its title, length, how many edits use it, how many words are said in it, and
//   every fact kept about the file: when and where it was captured, its camera, the person's own fields) and whether
//   its bytes are in their namespace, so it can play. Read in one pass inside the person's own store.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real rows: a row exists because a result or a named file exists; nothing is invented. A recording whose
//      bytes are not in the namespace is listed with `stored: false` and no bytes address.
//   2. Which result kinds and fields make a row is DATA (media-library.json); this file names no kind.
//   3. A result recorded under any identity of the same file is found (a drive's `12:` address or the file's `1f:`).
//   4. `revision` changes whenever a row could change, so a page holding the rows asks again only then (Noop else).
//   5. A file the person deleted or archived (src/namespace-set-aside.mjs) and left with no name is not a row until it
//      is put back.
import settings from './media-library.json' with { type: 'json' };
import filePreviews from './workspace/file-previews.json' with { type: 'json' };
import { hiddenAmong } from './namespace-set-aside.mjs';
import { observedMediaKind, observedMediaType } from './file-type.mjs';
import { ensureMediaNameIndex, mediaNameEligibleSql } from './media-name-index.mjs';
import { ensureMediaRecordingIndex } from './media-recording-index.mjs';
import { tableGeneration } from './table-generation.mjs';

const BYTES_PATH = '/work/api/namespace/bytes/';
const PATH = /^\$(\.[A-Za-z0-9_-]+)*$/;

// One field read from another result kept for the same file: the file is known by the entry's identity or, when the
// namespace holds its bytes, by the file's own identity.
function measureSql(measure) {
  if (!PATH.test(measure.path)) throw new Error(`media-library.json: ${measure.path} is not a plain JSON path`);
  const read = 'j.value, ?';
  if (measure.measure === 'value') return `json_extract(${read})`;
  // The value at the path whole, as JSON text a row carries parsed (every fact kept about the file).
  if (measure.measure === 'json') return `json(json_extract(${read}))`;
  if (measure.measure === 'count') return `json_array_length(${read})`;
  // Words said: the text's spaces plus one, nothing when there is no text.
  if (measure.measure === 'words') return `CASE WHEN trim(coalesce(json_extract(${read}), '')) = '' THEN 0 ELSE length(trim(json_extract(${read}))) - length(replace(trim(json_extract(${read})), ' ', '')) + 1 END`;
  throw new Error(`media-library.json: no measure ${measure.measure}`);
}

// A row's joined fields: each read as the database answered it, a `json` measure parsed back into its value.
function joinedFields(config, row) {
  return Object.fromEntries(config.joins.flatMap(join => Object.entries(join.fields)).map(([field, measure]) => {
    const value = row[field] ?? null;
    return [field, measure.measure === 'json' && typeof value === 'string' ? JSON.parse(value) : value];
  }));
}

// A field several joins name reads the first of them that holds a value (a title the person chose, then the summary's).
function joinedColumns(config, identity = 'r.identity', alias = 'a.identity') {
  const reads = new Map();
  for (const join of config.joins) {
    for (const [field, measure] of Object.entries(join.fields)) {
      const sql = measureSql(measure);
      const uses = sql.split('?').length - 1;
      const read = reads.get(field) ?? { parts: [], values: [] };
      read.parts.push(`(SELECT ${sql} FROM namespace_results j WHERE j.kind = ? AND j.identity IN (${identity}, ${alias}) LIMIT 1)`);
      read.values.push(...Array(uses).fill(measure.path), join.kind);
      reads.set(field, read);
    }
  }
  const columns = [], values = [];
  for (const [field, read] of reads) {
    columns.push(`${read.parts.length > 1 ? `COALESCE(${read.parts.join(', ')})` : read.parts[0]} AS "${field}"`);
    values.push(...read.values);
  }
  return { columns, values };
}

// A file's family: its stored content type's, or, when that only says "some bytes", its extension's
// (workspace/file-previews.json, the same DATA the Files screen draws by).
const UNNAMED_TYPES = new Set(['', 'application/octet-stream']);
const familyOf = (mediaType, name = '') => {
  if (typeof mediaType === 'string' && !UNNAMED_TYPES.has(mediaType) && mediaType.includes('/')) return mediaType.split('/')[0];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? filePreviews.families_by_extension[name.slice(dot + 1).toLowerCase()] ?? null : null;
};

// The person store installs these triggers once, after its namespace and result tables exist. A standalone reader
// installs them on its first read as well. SQLite keeps the marker and each source-row change in the same transaction,
// including direct SQL writes and writes interrupted before commit. The in-memory map only skips repeated DDL; it is
// never the revision authority and is rebuilt on each store restart.
const readyRevision = new WeakMap();
const MEDIA_CHANGE = 'UPDATE media_library_change SET changed = changed + 1 WHERE id = 1';

/** Keep a one-row revision for Media instead of counting the person's entire namespace on every page. */
export function ensureMediaLibraryRevision(sql, config = settings) {
  const choice = JSON.stringify(config);
  const made = readyRevision.get(sql);
  if (made?.generation === tableGeneration(sql) && made.choice === choice) return;
  sql.exec(`CREATE TABLE IF NOT EXISTS media_library_change (
    id INTEGER PRIMARY KEY CHECK (id = 1), nonce TEXT NOT NULL, changed INTEGER NOT NULL, config TEXT NOT NULL)`);
  sql.exec('CREATE TABLE IF NOT EXISTS media_library_change_kinds (kind TEXT PRIMARY KEY)');
  sql.exec(`INSERT INTO media_library_change (id, nonce, changed, config) VALUES (1, lower(hex(randomblob(16))), 0, ?)
    ON CONFLICT(id) DO UPDATE SET changed = changed + 1, config = excluded.config
    WHERE media_library_change.config <> excluded.config`, choice);
  const kinds = [...new Set([config.entry_kind, ...config.joins.map(join => join.kind), config.page_preview_kind].filter(Boolean))];
  sql.exec(`INSERT INTO media_library_change_kinds (kind)
    SELECT value FROM json_each(?) WHERE true ON CONFLICT(kind) DO NOTHING`, JSON.stringify(kinds));
  sql.exec('DELETE FROM media_library_change_kinds WHERE kind NOT IN (SELECT value FROM json_each(?))', JSON.stringify(kinds));
  const sources = [
    ['namespace_names', ''],
    ['namespace_files', ''],
    ['namespace_aliases', ''],
    ['namespace_set_aside', ''],
    ['namespace_set_aside_names', ''],
    ['namespace_results', 'result'],
  ];
  for (const [table, kind] of sources) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const watched = kind === 'result'
        ? `WHEN ${event === 'DELETE' ? 'OLD' : 'NEW'}.kind IN (SELECT kind FROM media_library_change_kinds)${event === 'UPDATE' ? ' OR OLD.kind IN (SELECT kind FROM media_library_change_kinds)' : ''}`
        : table === 'namespace_files' && event === 'UPDATE'
          ? 'WHEN OLD.identity IS NOT NEW.identity OR OLD.media_type IS NOT NEW.media_type'
          : '';
      sql.exec(`CREATE TRIGGER IF NOT EXISTS media_library_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} ${watched} BEGIN ${MEDIA_CHANGE}; END`);
    }
  }
  readyRevision.set(sql, { generation: tableGeneration(sql), choice });
}

/** One durable indexed-row read; its nonce also prevents a new person's store matching an old page revision. */
export function mediaLibraryRevision(sql, config = settings) {
  ensureMediaLibraryRevision(sql, config);
  const row = sql.exec('SELECT nonce, changed FROM media_library_change WHERE id = 1').toArray()[0];
  return `${row.nonce}:${row.changed}`;
}

// The same projection serves the full AI-facing library and a bounded page for the signed-in screen. Restricting
// identities before the result joins keeps a first page from materializing every transcript and fact.
function libraryRows(sql, config, only = null) {
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  const entryFields = Object.entries(config.entry_fields);
  for (const [, path] of entryFields) if (!PATH.test(path)) throw new Error(`media-library.json: ${path} is not a plain JSON path`);
  const joined = joinedColumns(config);
  const recordingKeys = only?.recordings ?? null;
  const recordings = recordingKeys?.length === 0 ? [] : all(`
    SELECT r.identity AS identity, f.identity AS file, f.media_type AS media_type,
      ${entryFields.map(([field]) => `json_extract(r.value, ?) AS "${field}"`).join(', ')},
      (SELECT n.name FROM namespace_names n WHERE n.identity IN (r.identity, a.identity) ORDER BY n.name LIMIT 1) AS named,
      (SELECT n.modified_at_ms FROM namespace_names n WHERE n.identity IN (r.identity, a.identity) ORDER BY n.name LIMIT 1) AS modified_at_ms
      ${joined.columns.length ? `, ${joined.columns.join(', ')}` : ''}
    FROM namespace_results r
    LEFT JOIN namespace_aliases a ON a.alias = r.identity
    LEFT JOIN namespace_files f ON f.identity = coalesce(a.identity, r.identity)
    WHERE r.kind = ?${recordingKeys ? ' AND r.identity IN (SELECT value FROM json_each(?))' : ''}`,
  ...entryFields.map(([, path]) => path), ...joined.values, config.entry_kind, ...(recordingKeys ? [JSON.stringify(recordingKeys)] : []));

  const rows = recordings.map(row => {
    const joined = joinedFields(config, row);
    const measured = /^(audio|video)\/webm(?:;|$)/i.test(row.media_type ?? '') ? observedMediaKind(joined.facts) : null;
    return {
      identity: row.identity, origin: 'recording',
      name: row.name ?? row.named?.split('/').pop() ?? row.identity,
      path: row.path ?? row.named ?? null,
      media_kind: measured ?? row.media_kind ?? familyOf(row.media_type, row.name ?? row.named ?? ''),
      media_type: observedMediaType(row.media_type, joined.facts) ?? null,
      file: row.file ?? null,
      stored: Boolean(row.file),
      bytes: row.file ? BYTES_PATH + encodeURIComponent(row.file) : null,
      captured_ms: row.modified_at_ms ?? null,
      ...joined,
    };
  });

  // Every other media file the person keeps, each under the first of `file_folders` that holds it
  // (a folder of "/" holds every file), so a video an AI saved anywhere shows in Media too.
  const seen = new Set(rows.map(row => row.identity));
  const madeJoins = joinedColumns(config, 'n.identity', 'a.identity');
  const nameKeys = only?.names ?? null;
  for (const { folder, origin } of config.file_folders) {
    if (nameKeys?.length === 0) break;
    const under = folder === '/' ? '' : folder;
    const made = all(`
      SELECT n.name AS name, n.identity AS identity, n.modified_at_ms AS modified_at_ms, f.identity AS file, f.media_type AS media_type
        ${madeJoins.columns.length ? `, ${madeJoins.columns.join(', ')}` : ''}
      ${nameKeys ? 'FROM json_each(?) wanted CROSS JOIN namespace_names n ON n.name = wanted.value' : 'FROM namespace_names n'}
      LEFT JOIN namespace_aliases a ON a.alias = n.identity
      LEFT JOIN namespace_files f ON f.identity = coalesce(a.identity, n.identity)
      WHERE (n.collection = ? OR (n.collection > ? AND n.collection < ?))
        `,
    ...madeJoins.values, ...(nameKeys ? [JSON.stringify(nameKeys)] : []), folder, `${under}/`, `${under}/\uffff`);
    for (const row of made) {
      const joined = joinedFields(config, row);
      const measured = /^(audio|video)\/webm(?:;|$)/i.test(row.media_type ?? '') ? observedMediaKind(joined.facts) : null;
      const mediaType = observedMediaType(row.media_type, joined.facts);
      const family = measured ?? familyOf(mediaType, row.name);
      if (!row.identity || seen.has(row.identity) || !config.media_families.includes(family)) continue;
      seen.add(row.identity);
      rows.push({
        identity: row.identity, origin, name: row.name.split('/').pop(), path: row.name, media_kind: family, media_type: mediaType,
        file: row.file ?? null, stored: Boolean(row.file), bytes: row.file ? BYTES_PATH + encodeURIComponent(row.file) : null, captured_ms: row.modified_at_ms ?? null,
        ...joined,
      });
    }
  }
  const hidden = hiddenAmong(sql, rows.flatMap(row => [row.identity, row.file]));
  return hidden.size ? rows.filter(row => !hidden.has(row.identity) && !hidden.has(row.file)) : rows;
}

/** The complete rows and their revision, read whole: for tests that compare a page with every row. No request or alarm
 *  reads this; the owner reads a page (mediaLibraryPage) or the newest few (mediaLibraryRecent). */
export function mediaLibrary(sql, { known = null, config = settings } = {}) {
  const revision = mediaLibraryRevision(sql, config);
  if (known === revision) return { revision, unchanged: true };
  return { revision, origin_labels: config.origin_labels, rows: libraryRows(sql, config) };
}

// Choose a small page from indexed names and entry identities before reading their joined results. A named file uses
// the first matching folder in DATA, then its first name, just as the complete library does.
function pageCandidates(sql, { config, after, limit, stored, origin, indexed, recordingsIndexed }) {
  // Each source yields its own newest `limit` rows. Their merged top `limit` is the same as a global sort,
  // while the name source can stop at the recent-name index instead of ranking the person's whole namespace.
  const recordingIdentity = recordingsIndexed ? 'c.identity' : 'r.identity';
  const recordingSort = recordingsIndexed ? 'c.sort_ms' : `COALESCE((SELECT n.modified_at_ms FROM namespace_names n
    WHERE n.identity IN (r.identity, a.identity) ORDER BY n.name LIMIT 1), -1)`;
  const recordingAfter = !after ? null : after[1] === 1
    ? { sql: `AND (${recordingSort}, ${recordingIdentity}) < (?, ?)`, values: [after[0], after[2]] }
    : { sql: `AND ${recordingSort} < ?`, values: [after[0]] };
  const recordings = origin !== null && origin !== 'recording' ? [] : sql.exec(`
    SELECT 1 AS source_order, ${recordingIdentity} AS identity, NULL AS name, ${recordingSort} AS sort_ms
    FROM ${recordingsIndexed ? 'media_library_recording_candidates c INDEXED BY media_library_recording_candidates_recent' : 'namespace_results r'}
    LEFT JOIN namespace_aliases a ON a.alias = ${recordingIdentity}
    LEFT JOIN namespace_files f ON f.identity = coalesce(a.identity, ${recordingIdentity})
    WHERE ${recordingsIndexed ? '1 = 1' : 'r.kind = ?'}
      ${stored === null ? '' : `AND f.identity IS ${stored ? 'NOT ' : ''}NULL`}
      ${recordingAfter?.sql ?? ''}
    ORDER BY ${recordingSort} DESC, ${recordingIdentity} DESC LIMIT ?`,
  ...(recordingsIndexed ? [] : [config.entry_kind]), ...(recordingAfter?.values ?? []), limit).toArray();

  const folderPriority = alias => {
    const values = [];
    const cases = config.file_folders.map(({ folder }, index) => {
      if (folder === '/') return `WHEN 1 THEN ${index}`;
      values.push(folder, `${folder}/`, `${folder}/\uffff`);
      return `WHEN (${alias}.collection = ? OR (${alias}.collection > ? AND ${alias}.collection < ?)) THEN ${index}`;
    }).join(' ');
    return { sql: `CASE ${cases} ELSE ${config.file_folders.length} END`, values };
  };
  const chosen = folderPriority('n');
  const better = folderPriority('b');
  const originIndexes = config.file_folders.flatMap(({ origin: label }, index) => label === origin ? [index] : []);
  const selectedOrigin = origin === null ? null : folderPriority('n');
  const nameTable = indexed ? 'media_library_name_candidates' : 'namespace_names';
  const nameIndex = indexed ? 'media_library_name_candidates_recent' : 'namespace_names_recent';
  const sortMs = indexed ? 'n.sort_ms' : 'COALESCE(n.modified_at_ms, -1)';
  const eligibleExtensions = indexed ? null : JSON.stringify(Object.fromEntries(Object.entries(filePreviews.families_by_extension)
    .filter(([, family]) => config.media_families.includes(family))));
  const names = origin === 'recording' || (origin !== null && !originIndexes.length) ? [] : sql.exec(`
    ${indexed ? '' : `WITH eligible_extensions AS (SELECT key, value FROM json_each(?)),
      eligible_families AS (SELECT value FROM json_each(?))`}
    SELECT 0 AS source_order, n.identity, n.name, ${sortMs} AS sort_ms
    FROM ${nameTable} n INDEXED BY ${nameIndex}
    LEFT JOIN namespace_aliases a ON a.alias = n.identity
    LEFT JOIN namespace_files f ON f.identity = coalesce(a.identity, n.identity)
    WHERE n.identity IS NOT NULL AND ${chosen.sql} < ${config.file_folders.length}
      ${indexed ? '' : `AND ${mediaNameEligibleSql('n', 'f', 'eligible_extensions', 'eligible_families')}`}
      AND NOT EXISTS (SELECT 1 FROM namespace_results r WHERE r.identity = n.identity AND r.kind = ?)
      AND n.name = (SELECT b.name FROM ${nameTable} b
        ${indexed ? '' : 'LEFT JOIN namespace_aliases ba ON ba.alias = b.identity LEFT JOIN namespace_files bf ON bf.identity = coalesce(ba.identity, b.identity)'}
        WHERE b.identity = n.identity
        ${indexed ? '' : `AND ${mediaNameEligibleSql('b', 'bf', 'eligible_extensions', 'eligible_families')}`}
        ORDER BY ${better.sql}, b.name LIMIT 1)
      ${stored === null ? '' : `AND f.identity IS ${stored ? 'NOT ' : ''}NULL`}
      ${selectedOrigin ? `AND ${selectedOrigin.sql} IN (${originIndexes.join(', ')})` : ''}
      ${after ? `AND (${sortMs}, 0, n.identity) < (?, ?, ?)` : ''}
    ORDER BY ${sortMs} DESC, n.identity DESC LIMIT ?`,
  ...(indexed ? [] : [eligibleExtensions, JSON.stringify(config.media_families)]),
  ...chosen.values, config.entry_kind, ...better.values,
  ...(selectedOrigin?.values ?? []), ...(after ?? []), limit).toArray();

  return [...recordings, ...names].sort((a, b) => b.sort_ms - a.sort_ms || b.source_order - a.source_order
    || (a.identity < b.identity ? 1 : a.identity > b.identity ? -1 : 0)).slice(0, limit);
}

const PAGE_SIZE = 60;
const PAGE_SCAN = 100;
// How many pages deep a suggestion or a shelf of recent media reads (mediaLibraryRecent).
const RECENT_PAGES = 5;
const MAX_SAVED_POSTER_CHARS = 180_000;
const PAGE_POSTER_BUDGET_CHARS = 1_500_000;
const SAVED_PREVIEW_JSON_LIMIT = 2_000_000;
const IMAGE_DATA = /^data:image\/(?:jpeg|png|webp);base64,/i;

// The saved still is already in the person's result store. Return it with this small page so an opening tile can
// paint its real picture without a second owner round trip; leave large or unsupported results to the shared lazy
// preview path. The full library never includes image data.
function addSavedPagePosters(sql, rows, config) {
  if (!config.page_preview_kind) return;
  const files = [...new Set(rows.flatMap(row => row.file ? [row.file] : []))];
  if (!files.length) return;
  const saved = new Map(sql.exec(`SELECT identity, json_extract(value, '$.poster') AS poster,
      json_extract(value, '$.video_poster_version') AS video_poster_version,
      json_extract(value, '$.duration') AS duration
    FROM namespace_results WHERE kind = ? AND identity IN (SELECT value FROM json_each(?)) AND length(value) <= ?`,
  config.page_preview_kind, JSON.stringify(files), SAVED_PREVIEW_JSON_LIMIT).toArray().map(item => [item.identity, item]));
  let budget = PAGE_POSTER_BUDGET_CHARS;
  for (const row of rows) {
    const preview = saved.get(row.file);
    const poster = preview?.poster;
    if (typeof poster !== 'string' || poster.length > MAX_SAVED_POSTER_CHARS || !IMAGE_DATA.test(poster)) continue;
    if (row.media_kind === 'video' && (preview.video_poster_version !== 1 || preview.duration === 0)) continue;
    if (poster.length > budget) continue;
    row.preview = { poster, ...(preview.video_poster_version === 1 ? { video_poster_version: 1 } : {}) };
    budget -= poster.length;
  }
}

const pageCursor = row => JSON.stringify([row.sort_ms, row.source_order, row.identity]);
function readPageCursor(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 256) throw new Error('This media page is not valid. Start at the newest media.');
  let cursor;
  try { cursor = JSON.parse(value); } catch { throw new Error('This media page is not valid. Start at the newest media.'); }
  if (!Array.isArray(cursor) || cursor.length !== 3 || !Number.isSafeInteger(cursor[0]) || ![0, 1].includes(cursor[1])
    || typeof cursor[2] !== 'string' || cursor[2].length > 100) throw new Error('This media page is not valid. Start at the newest media.');
  return cursor;
}

/** A stable recent-first page for the signed-in Media screen and AI tools. */
export function mediaLibraryPage(sql, { after = null, limit = PAGE_SIZE, stored = null, origin = null, unused = false, previews = true, known = null, config = settings, nameIndexAdvance = true, recordingIndexAdvance = true, examine = Infinity, requireIndexes = false } = {}) {
  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > PAGE_SIZE) throw new Error(`Choose 1 to ${PAGE_SIZE} media items per page.`);
  if (stored !== null && typeof stored !== 'boolean') throw new Error('Choose stored originals, indexed media, or both.');
  if (origin !== null && (typeof origin !== 'string' || origin.length > 80)) throw new Error('Choose a Media origin.');
  if (typeof previews !== 'boolean') throw new Error('Choose whether to include media pictures.');
  ensureMediaLibraryRevision(sql, config);
  const indexed = origin === 'recording' ? false : ensureMediaNameIndex(sql, config, { advance: nameIndexAdvance });
  const recordingsIndexed = origin === null || origin === 'recording'
    ? ensureMediaRecordingIndex(sql, config, { advance: recordingIndexAdvance }) : false;
  if (requireIndexes && (origin !== 'recording' && !indexed || (origin === null || origin === 'recording') && !recordingsIndexed)) {
    throw Object.assign(new Error('Your Media library is preparing its current page. It will continue automatically.'),
      { status: 503, code: 'MEDIA_INDEX_PENDING' });
  }
  const revision = mediaLibraryRevision(sql, config);
  const reset = Boolean(after && known !== revision);
  let cursor = reset ? null : readPageCursor(after);
  const rows = [];
  let more = false;
  let scan = Math.min(PAGE_SCAN, Math.max(8, size + 1));
  // `examine` bounds the candidates one page looks at when most of them are filtered out (unused: true): a short page with a cursor.
  let examined = 0;
  while (rows.length < size && examined < examine) {
    const want = Math.min(scan, examine - examined);
    const candidates = pageCandidates(sql, { config, after: cursor, limit: want, stored, origin, indexed, recordingsIndexed });
    if (!candidates.length) { more = false; break; }
    const projected = libraryRows(sql, config, {
      recordings: candidates.filter(item => item.source_order === 1).map(item => item.identity),
      names: candidates.filter(item => item.source_order === 0).map(item => item.name),
    });
    const bySource = new Map(projected.map(row => [`${row.origin === 'recording' ? 1 : 0}:${row.identity}`, row]));
    let consumed = 0;
    for (const candidate of candidates) {
      cursor = JSON.parse(pageCursor(candidate));
      consumed += 1;
      const row = bySource.get(`${candidate.source_order}:${candidate.identity}`);
      if (!row || (unused && Number(row.edits) > 0)) continue;
      rows.push(row);
      if (rows.length === size) break;
    }
    examined += consumed;
    more = consumed < candidates.length || candidates.length === want;
    if (rows.length === size || candidates.length < want) break;
    scan = Math.min(PAGE_SCAN, scan * 2);
  }
  if (previews) addSavedPagePosters(sql, rows, config);
  return { revision, origin_labels: config.origin_labels, rows, next_after: more && cursor ? JSON.stringify(cursor) : null, ...(reset ? { reset: true } : {}) };
}

/** Native interactive reads require the seek indexes and examine one bounded
 * candidate window. Their existing resource scheduler builds older indexes. */
export function boundedMediaLibraryPage(sql, options = {}) {
  return mediaLibraryPage(sql, { ...options, nameIndexAdvance: false, recordingIndexAdvance: false,
    requireIndexes: true, examine: PAGE_SCAN });
}

/**
 * The newest rows of the library, at most `pages` pages deep (each the page above), for a suggestion or a shelf that
 * draws on recent media: the rows `keep` accepts, stopping once `window` of them are held. Nothing reads the whole
 * library; a changed library is told by its revision, as in mediaLibrary. Each page looks at no more than PAGE_SCAN
 * candidates (`examine`), so media mostly used in edits cost a short page and a cursor, not a walk to the end.
 */
export function mediaLibraryRecent(sql, { known = null, pages = RECENT_PAGES, window = null, keep = null, stored = null, unused = false, config = settings, nameIndexAdvance = true, recordingIndexAdvance = true, requireIndexes = false } = {}) {
  const revision = mediaLibraryRevision(sql, config);
  if (known === revision) return { revision, unchanged: true };
  const rows = [];
  let after = null;
  for (let page = 0; page < pages; page += 1) {
    const answer = mediaLibraryPage(sql, { after, known: revision, stored, unused, previews: false, config, nameIndexAdvance, recordingIndexAdvance, examine: PAGE_SCAN, requireIndexes });
    for (const row of answer.rows) if (!keep || keep(row)) rows.push(row);
    after = answer.next_after;
    if (!after || (window !== null && rows.length >= window)) break;
  }
  return { revision, origin_labels: config.origin_labels, rows };
}

/** The same page request is understood by the signed-in screen and the direct person-store API; none asked is the first page. */
export function mediaLibraryQuery(params) {
  const known = params.get('revision');
  const limit = params.get('limit');
  const stored = params.get('stored');
  const unused = params.get('unused');
  const previews = params.get('previews');
  if (stored !== null && stored !== 'true' && stored !== 'false') throw new Error('Choose stored originals, indexed media, or both.');
  if (unused !== null && unused !== 'true' && unused !== 'false') throw new Error('Choose whether to show media not used in an edit.');
  if (previews !== null && previews !== 'true' && previews !== 'false') throw new Error('Choose whether to include media pictures.');
  return { known, page: { ...(limit === null ? {} : { limit }), after: params.get('after'), stored: stored === null ? null : stored === 'true',
    origin: params.get('origin'), unused: unused === 'true', previews: previews !== 'false' } };
}
