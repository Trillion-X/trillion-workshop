// One person's namespace index, in that person's own SQLite (inside their PersonStore Durable Object).
//
//   namespace_files     one row per file: its content identity, size, type, where it is kept, when it was checked
//   namespace_aliases   other identities that name the same file (e.g. a drive store's SHA-256 address), graded
//   namespace_names     what the person calls a file and the folder it sits in; a name with no identity is a folder
//   namespace_chunks    content-defined chunks this person holds: each chunk's BLAKE3 identity, size and where it is kept
//   namespace_spans     the ordered chunks a file is made of (offset, length, chunk); a file with none is one object
//   namespace_growing   files being uploaded right now, openable by their provisional identity (`up:` + 32 hex)
//                       while chunks arrive; `namespace_demands` holds the chunks a reader is waiting for
//   namespace_unfinished_uploads  whole-file uploads an earlier version began and never finished, kept only until
//                       each is cancelled where it is kept and its room given back
//   namespace_set_aside       files and folders the person deleted or archived (src/namespace-set-aside.mjs): each one
//                       taken out of namespace_names until put back, or until its keep-for time ends;
//                       `namespace_set_aside_names` holds the names each took away (a name of null marks a file set aside
//                       by its identity); the person's own keep-for days per state are the EEAF setting `keep_for`
//   namespace_secrets   each store the person attached (`origin:<id>`): its settings, its access key's id and the bucket
//                       the key opens. Every secret (the lease key, each store's secret key) is sealed in the person's
//                       locked box under heldName(row name), never here; a row an earlier version kept with its secret is
//                       carried into the box in bounded alarm pages (secretCarryPage, keepOnlyPlain)
//   namespace_secret_carry  one durable discovery cursor, including a failed page's retry time
//
// The Worker streams bytes; this index only answers where they are, so a read costs one small lookup.
import { afterTimeCursor, readTimeCursor, timeCursor } from './time-cursor.mjs';
import { familyPrefix, versionFamilies } from './file-versions.mjs';
import { boxName } from './box-name.mjs';
import { fileType, GENERIC_TYPE } from './file-type.mjs';
import { readNamesAgain } from './namespace-view.mjs';
import { namespaceNameCounts } from './namespace-name-counts.mjs';

/** The name a namespace secret (`lease-key`, `origin:<id>`) is sealed under in the person's locked box. */
export const heldName = name => boxName('namespace-secret', name);

const now = () => new Date().toISOString();
const parentOf = name => name.replace(/\/[^/]+\/?$/, '') || '/';
// A file's name: starts with /, at most 4096 characters, and no control characters (a name of NUL bytes read off a
// broken disk once became a folder nobody could open or name), so every name can be shown, typed and searched.
export const isFileName = name => typeof name === 'string' && name.startsWith('/') && name.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(name);
// How many of a file's other names a folder listing carries, so a person sees where else the same bytes are kept.
const ALSO_AT = 3;
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const CHILD_FOLDER_SEEK_LIMIT = 128;
// How many spans one statement writes, as one JSON value (about 120 bytes a span, far under the store's limit on a value).
const SPANS_PER_STATEMENT = 1000;
// Earlier attached-origin rows are inspected once, a keyed page per alarm, never as a foreground table walk.
export const SECRET_CARRY_PAGE = 32;
// The keys of one table the first summary count reads in a chunk (summaryStep), the same chunk as a copy's recount.
const SUMMARY_KEYS = 20_000;

// A folder's version: the highest change number of the folder or any folder under it (namespace_folder_changes), as an
// opaque token. `one(query, ...values)` reads one row; the set-aside check reads the same token through it.
export function folderRevisionOf(one, folder) {
  const root = folder === '/';
  // Every collection lies under the root, so its version is the highest change number there is: one seek on the seq index. The
  // range below walked every collection (11,016 rows in one statement on a large account's Namespace, which stopped the files summary
  // at its rows bound, 2026-10-20 10:04 PM PDT).
  if (root) return `folder:${one('SELECT seq AS revision FROM namespace_folder_changes ORDER BY seq DESC LIMIT 1')?.revision ?? 0}`;
  const row = one(`SELECT MAX(COALESCE((SELECT seq FROM namespace_folder_changes WHERE collection = ?), 0),
    COALESCE((SELECT MAX(seq) FROM namespace_folder_changes WHERE collection >= ? AND collection < ?), 0)) AS revision`,
  folder, `${folder}/`, `${folder}0`);
  return `folder:${row?.revision ?? 0}`;
}

export function namespaceStore(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_files (identity TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, media_type TEXT, origin TEXT NOT NULL, key TEXT NOT NULL, part_bytes INTEGER NOT NULL, stored_at TEXT NOT NULL, checked_at TEXT NOT NULL, checked_part INTEGER, prefix_identity TEXT, arrival_revision TEXT, arrival_completed_revision TEXT)`);
  const fileColumns = new Set(sql.exec('PRAGMA table_info(namespace_files)').toArray().map(column => column.name));
  for (const column of ['prefix_identity', 'arrival_revision', 'arrival_completed_revision']) {
    if (!fileColumns.has(column)) sql.exec(`ALTER TABLE namespace_files ADD COLUMN ${column} TEXT`);
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_aliases (alias TEXT PRIMARY KEY, identity TEXT NOT NULL, grade TEXT NOT NULL, added_at TEXT NOT NULL)`);
  // Every read of a file's other identities goes by the file's own identity, so it is indexed: without it each read
  // walked every alias this person holds, and a list of a hundred files held the store for seconds.
  // A summary carries only the first aliases that can supply its names. Seek them in the same alias order as a
  // full lookup and stop at its limit; an identity-only index must sort every alias before it can stop.
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_aliases_identity_alias ON namespace_aliases (identity, alias)`);
  sql.exec('DROP INDEX IF EXISTS namespace_aliases_identity');
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_names (name TEXT PRIMARY KEY, collection TEXT NOT NULL, identity TEXT, byte_length INTEGER, modified_at_ms INTEGER, named_at TEXT NOT NULL)`);
  // A local DAV mount retries a journal op after an uncertain reply. Its move receipt is committed in this same
  // SQLite transaction as the archive and name change, and remains until that exact mount durably acknowledges it.
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_move_receipts (op_id TEXT PRIMARY KEY, input_identity TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_move_receipts_created ON namespace_move_receipts (created_at, op_id)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_names_collection ON namespace_names (collection, name)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_names_identity ON namespace_names (identity)`);
  const nameCounts = namespaceNameCounts(sql);
  // Media pages walk recent names and stop after a bounded candidate page instead of ranking every name.
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_names_recent ON namespace_names (COALESCE(modified_at_ms, -1) DESC, identity DESC)`);
  // Which folders changed, and in what order: every change to a name moves its folder (both folders, for a move) to the
  // newest place of one running count, one row per folder, so a copy on a device asks "what changed after N" with one
  // index read and lists again only those folders, instead of listing every folder it shows to see whether anything did.
  // The count is the highest number kept (rows are never removed), so a change writes exactly one row: its folder's.
  // A folder's version (Finder rejects a stale folder move or delete with it) is read from the same rows: the highest
  // number at or under the folder (folderRevisionOf), so a nested change is seen without writing every ancestor.
  // An earlier version kept a separate counter row and wrote a random version for every ancestor folder on every name
  // change (12-15 rows for one finished upload, the largest writer on a busy store, 2026-10-07); the newest folder row
  // takes the old counter's value so a device holding it is not told to list everything again, and both tables go.
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_folder_changes (collection TEXT PRIMARY KEY, seq INTEGER NOT NULL)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_folder_changes_seq ON namespace_folder_changes (seq)`);
  for (const old of ['namespace_folder_name_added', 'namespace_folder_name_removed', 'namespace_folder_name_changed',
    'namespace_folder_revision_added', 'namespace_folder_revision_removed', 'namespace_folder_revision_changed']) sql.exec(`DROP TRIGGER IF EXISTS ${old}`);
  if (sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'namespace_change_count'").toArray().length) {
    sql.exec(`UPDATE namespace_folder_changes SET seq = MAX(seq, (SELECT seq FROM namespace_change_count WHERE id = 1))
      WHERE collection = (SELECT collection FROM namespace_folder_changes ORDER BY seq DESC LIMIT 1)`);
    sql.exec('DROP TABLE namespace_change_count');
  }
  sql.exec('DROP TABLE IF EXISTS namespace_folder_revisions');
  const markFolder = folder => `INSERT INTO namespace_folder_changes (collection, seq)
      VALUES (${folder}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM namespace_folder_changes))
      ON CONFLICT(collection) DO UPDATE SET seq = excluded.seq;`;
  sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_folder_marked_added AFTER INSERT ON namespace_names BEGIN ${markFolder('NEW.collection')} END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_folder_marked_removed AFTER DELETE ON namespace_names BEGIN ${markFolder('OLD.collection')} END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_folder_marked_changed AFTER UPDATE ON namespace_names BEGIN ${markFolder('NEW.collection')} END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_folder_marked_left AFTER UPDATE OF collection ON namespace_names
    WHEN OLD.collection IS NOT NEW.collection BEGIN ${markFolder('OLD.collection')} END`);
  // A name a new upload asks for while a file already kept has it (the same file sent again under its name) is
  // promised, not given: the kept file keeps the name until the upload finishes, so a send that is stopped, or never
  // finishes, can never leave the kept file without its name (a camera clip's S03.MP4 proxy, 2026-10-04, lost its only name to a
  // second send of itself).
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_names_promised (upload TEXT NOT NULL, name TEXT NOT NULL, promised_at TEXT NOT NULL, PRIMARY KEY (upload, name))`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_names_promised_name ON namespace_names_promised (name)`);
  // A conditional upload keeps its visible name untouched until its checked finish. Its intended names still block
  // moving or deleting a parent folder while bytes arrive, so a late finish cannot recreate the old path.
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_name_intents (upload TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (upload, name))`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_name_intents_name ON namespace_name_intents (name)`);
  // An earlier version lent such a name to the upload: each one still lent goes back to its kept file and becomes a
  // promise, and the table goes.
  if (sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'namespace_names_lent'").toArray().length) {
    sql.exec(`UPDATE namespace_names SET identity = l.identity, byte_length = f.byte_length
      FROM namespace_names_lent l JOIN namespace_files f ON f.identity = l.identity
      WHERE namespace_names.name = l.name AND namespace_names.identity = l.upload`);
    sql.exec(`INSERT INTO namespace_names_promised (upload, name, promised_at) SELECT l.upload, l.name, l.lent_at FROM namespace_names_lent l
      JOIN namespace_growing g ON g.growing = l.upload AND g.finished IS NULL ON CONFLICT(upload, name) DO NOTHING`);
    sql.exec('DROP TABLE namespace_names_lent');
  }
  // Whole-file multipart uploads were replaced by chunks. Finished files keep their rows in namespace_files (spans = 0,
  // one object at `key`) and read as before. An upload an earlier version started and never finished is carried into
  // namespace_unfinished_uploads BEFORE its tables are dropped, so the Worker can still cancel it where it is kept and
  // give back the room it claimed (settleUnfinishedUploads in namespace.mjs); then the row is forgotten.
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_unfinished_uploads (upload_id TEXT PRIMARY KEY, origin TEXT NOT NULL, key TEXT NOT NULL, byte_length INTEGER NOT NULL)`);
  if (sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'namespace_uploads'").toArray().length) {
    sql.exec('INSERT INTO namespace_unfinished_uploads (upload_id, origin, key, byte_length) SELECT upload_id, origin, key, byte_length FROM namespace_uploads WHERE true ON CONFLICT(upload_id) DO NOTHING');
    sql.exec('DROP TABLE IF EXISTS namespace_upload_parts');
    sql.exec('DROP TABLE namespace_uploads');
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_secret_carry (id INTEGER PRIMARY KEY CHECK (id = 1), after TEXT NOT NULL, done INTEGER NOT NULL, retry_at INTEGER)`);
  // A new empty index has nothing to carry. Existing descriptors are discovered through the cursor, without an
  // index build or an upfront JSON scan. Modern attachments cannot add plaintext secrets.
  sql.exec(`INSERT INTO namespace_secret_carry (id, after, done) SELECT 1, '',
    NOT EXISTS (SELECT 1 FROM namespace_secrets LIMIT 1) WHERE NOT EXISTS (SELECT 1 FROM namespace_secret_carry WHERE id = 1) ON CONFLICT(id) DO NOTHING`);
  const hasPlainSecret = `NEW.name = 'lease-key' OR (NEW.name >= 'origin:' AND NEW.name < 'origio'
    AND CASE WHEN json_valid(NEW.value) THEN json_type(NEW.value, '$.key.key') = 'text'
      AND length(json_extract(NEW.value, '$.key.key')) > 0 ELSE 0 END)`;
  for (const [suffix, event] of [['added', 'INSERT'], ['changed', 'UPDATE OF name, value']]) {
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_secret_carry_${suffix} AFTER ${event} ON namespace_secrets
      WHEN ${hasPlainSecret} BEGIN UPDATE namespace_secret_carry SET after = '', done = 0, retry_at = NULL WHERE id = 1; END`);
  }
  // A stored file being moved to another origin: parts copied, the copy completed there, then every part compared
  // byte for byte with the original before the file's row names the new place.
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_moves (identity TEXT PRIMARY KEY, to_origin TEXT NOT NULL, to_key TEXT NOT NULL, upload_id TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, parts_verified INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, from_origin TEXT, from_key TEXT, byte_length INTEGER, cleanup_pending INTEGER NOT NULL DEFAULT 0)`);
  const moveColumns = new Set(sql.exec('PRAGMA table_info(namespace_moves)').toArray().map(column => column.name));
  for (const [column, type] of [['from_origin', 'TEXT'], ['from_key', 'TEXT'], ['byte_length', 'INTEGER'], ['cleanup_pending', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!moveColumns.has(column)) sql.exec(`ALTER TABLE namespace_moves ADD COLUMN ${column} ${type}`);
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_move_parts (identity TEXT NOT NULL, number INTEGER NOT NULL, etag TEXT NOT NULL, PRIMARY KEY (identity, number))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_chunks (chunk TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, origin TEXT NOT NULL, key TEXT NOT NULL, stored_at TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_spans (file TEXT NOT NULL, ordinal INTEGER NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY (file, ordinal))`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_spans_offset ON namespace_spans (file, offset)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_chunks_origin ON namespace_chunks (origin, stored_at)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_growing (growing TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, media_type TEXT, origin TEXT NOT NULL, started_at TEXT NOT NULL, finished TEXT, new_bytes INTEGER NOT NULL DEFAULT 0, aliases TEXT NOT NULL DEFAULT '[]')`);
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_demands (growing TEXT NOT NULL, ordinal INTEGER NOT NULL, asked_at TEXT NOT NULL, PRIMARY KEY (growing, ordinal))`);
  // The upload table's columns, read once for every column check below (each ALTER adds a column none of the others asks about).
  const growingColumns = new Set(sql.exec('PRAGMA table_info(namespace_growing)').toArray().map(column => column.name));
  // Which app started an upload (an AI app's name, or what a sender's requests say about it), for the activity it shows.
  if (!growingColumns.has('app')) sql.exec('ALTER TABLE namespace_growing ADD COLUMN app TEXT');
  // An upload whose length its sender does not know yet (a file still being written): its byte_length is how far its
  // chunks describe it, it grows as they are described, and it is fixed when the upload finishes.
  if (!growingColumns.has('length_open')) sql.exec('ALTER TABLE namespace_growing ADD COLUMN length_open INTEGER NOT NULL DEFAULT 0');
  // How far an upload's chunks describe it and how many of its bytes are stored, kept as its chunks are described and
  // stored, so reading an upload in progress never sums every span it has again. Uploads open when this was added are
  // counted once here.
  // Each column is added on its own, so a start cut off between the two never leaves one that stops every later start.
  if (!growingColumns.has('spans_described')) sql.exec('ALTER TABLE namespace_growing ADD COLUMN spans_described INTEGER NOT NULL DEFAULT 0');
  if (!growingColumns.has('bytes_held')) {
    sql.exec('ALTER TABLE namespace_growing ADD COLUMN bytes_held INTEGER NOT NULL DEFAULT 0');
    for (const { growing } of sql.exec('SELECT growing FROM namespace_growing WHERE finished IS NULL').toArray()) {
      sql.exec(`UPDATE namespace_growing SET
        spans_described = (SELECT COUNT(*) FROM namespace_spans WHERE file = ?),
        bytes_held = (SELECT COALESCE(SUM(s.length), 0) FROM namespace_spans s JOIN namespace_chunks c ON c.chunk = s.chunk WHERE s.file = ?)
        WHERE growing = ?`, growing, growing, growing);
    }
  }
  // The bytes an open upload has described in chunks that have not arrived yet, one row per (upload, chunk) with the
  // total length of that upload's spans of the chunk. Kept where the spans are written, so a chunk arriving adds what
  // it fills to bytes_held by one keyed delete, never by summing the upload's spans again (that read every span of the
  // file on every chunk: O(spans) a chunk, O(n^2) an import). Uploads open when this was added are counted once here.
  const waitsExisted = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'namespace_span_waits'").toArray().length > 0;
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_span_waits (file TEXT NOT NULL, chunk TEXT NOT NULL, length INTEGER NOT NULL, PRIMARY KEY (file, chunk))`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_span_waits_chunk ON namespace_span_waits (chunk)`);
  if (!waitsExisted) {
    for (const { growing } of sql.exec('SELECT growing FROM namespace_growing WHERE finished IS NULL').toArray()) {
      sql.exec(`INSERT INTO namespace_span_waits (file, chunk, length)
        SELECT s.file, s.chunk, SUM(s.length) FROM namespace_spans s LEFT JOIN namespace_chunks c ON c.chunk = s.chunk
        WHERE s.file = ? AND c.chunk IS NULL GROUP BY s.chunk ON CONFLICT(file, chunk) DO NOTHING`, growing);
    }
  }
  // A file made of chunks has spans; spans = 0 means the whole file is one object at `key`.
  // Read with the file table's other columns at the top (fileColumns); the ALTERs since add only other columns.
  if (!fileColumns.has('spans')) sql.exec('ALTER TABLE namespace_files ADD COLUMN spans INTEGER NOT NULL DEFAULT 0');
  // Ordered by when each file was kept, so the oldest whole files on an origin (heldOn) are read a page at a time,
  // never every whole file on it and sorted.
  sql.exec('DROP INDEX IF EXISTS namespace_files_origin');
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_files_origin_stored ON namespace_files (origin, spans, stored_at)`);
  sql.exec('CREATE INDEX IF NOT EXISTS namespace_files_recent ON namespace_files (stored_at DESC, identity)');

  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_set_aside (id TEXT PRIMARY KEY, label TEXT NOT NULL, place TEXT, state TEXT NOT NULL, folder INTEGER NOT NULL DEFAULT 0, set_aside_ms INTEGER NOT NULL, by TEXT)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_set_aside_state ON namespace_set_aside (state, set_aside_ms)`);
  // Recently Deleted and Archived, newest first a page at a time (src/namespace-set-aside.mjs list), walk this index.
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_set_aside_newest ON namespace_set_aside (set_aside_ms, id)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_set_aside_names (id TEXT NOT NULL, ordinal INTEGER NOT NULL, name TEXT, collection TEXT, identity TEXT, byte_length INTEGER, modified_at_ms INTEGER, PRIMARY KEY (id, ordinal))`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_set_aside_names_identity ON namespace_set_aside_names (identity)`);

  // Exact totals for the person's namespace. Existing rows are counted only on the first summary request; subsequent
  // changes are recorded by SQLite beside their base rows, including writes made outside this module.
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_summary_counts (id INTEGER PRIMARY KEY CHECK (id = 1), ready INTEGER NOT NULL DEFAULT 0, files INTEGER NOT NULL, bytes INTEGER NOT NULL, names INTEGER NOT NULL, uploads_in_progress INTEGER NOT NULL, bytes_in_progress INTEGER NOT NULL, chunks INTEGER NOT NULL, chunk_bytes INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_summary_origins (origin TEXT PRIMARY KEY, files INTEGER NOT NULL, bytes INTEGER NOT NULL)`);

  const one = (query, ...values) => sql.exec(query, ...values).toArray()[0] ?? null;
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  const folderRevision = folder => folderRevisionOf(one, folder);

  const summaryCounts = () => one('SELECT * FROM namespace_summary_counts WHERE id = 1 AND ready = 1');
  // The first count, a bounded chunk of one table's keys at a time (SUMMARY_KEYS), so a copy that lands rows without counting
  // them (src/namespace-native-carry.mjs) is counted under the bound of the command that landed them, and a book met cold counts
  // in one walk (seedSummary). The cursor holds the tallies so far; nothing is written until the last chunk.
  const SUMMARY_STAGES = [
    ['namespace_files', 'byte_length, origin', 'origin', 'COUNT(*) AS n, COALESCE(SUM(byte_length), 0) AS bytes, MAX(r) AS last'],
    ['namespace_names', '1 AS one', null, 'COUNT(*) AS n, MAX(r) AS last'],
    ['namespace_growing', 'byte_length, finished', null, "COUNT(*) AS n, COALESCE(SUM(finished IS NULL), 0) AS open, COALESCE(SUM(CASE WHEN finished IS NULL THEN byte_length END), 0) AS open_bytes, MAX(r) AS last"],
    ['namespace_chunks', 'byte_length', null, 'COUNT(*) AS n, COALESCE(SUM(byte_length), 0) AS bytes, MAX(r) AS last'],
  ];
  const summaryStep = (cursor = null, keys = SUMMARY_KEYS) => {
    if (!cursor && summaryCounts()) return { cursor: null, done: true };
    const state = cursor ?? { stage: 0, last: 0, files: 0, bytes: 0, names: 0, uploads_in_progress: 0, bytes_in_progress: 0, chunks: 0, chunk_bytes: 0, origins: {} };
    const [table, columns, groupBy, aggregates] = SUMMARY_STAGES[state.stage];
    const rows = all(`SELECT ${groupBy ? `${groupBy}, ` : ''}${aggregates} FROM (SELECT rowid AS r, ${columns} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?)${groupBy ? ` GROUP BY ${groupBy}` : ''}`, state.last, keys);
    const next = { ...state, origins: { ...state.origins } };
    const taken = rows.reduce((sum, row) => sum + row.n, 0);
    next.last = Math.max(state.last, ...rows.map(row => row.last ?? 0));
    for (const row of rows) {
      if (state.stage === 0) {
        next.files += row.n; next.bytes += row.bytes;
        const held = next.origins[row.origin] ?? { files: 0, bytes: 0 };
        next.origins[row.origin] = { files: held.files + row.n, bytes: held.bytes + row.bytes };
      } else if (state.stage === 1) next.names += row.n;
      else if (state.stage === 2) { next.uploads_in_progress += row.open; next.bytes_in_progress += row.open_bytes; }
      else { next.chunks += row.n; next.chunk_bytes += row.bytes; }
    }
    if (taken === keys) return { cursor: next, done: false };
    if (state.stage + 1 < SUMMARY_STAGES.length) return { cursor: { ...next, stage: state.stage + 1, last: 0 }, done: false };
    writeSummary(next);
    return { cursor: null, done: true };
  };
  const seedSummary = () => { let step = { cursor: null, done: false }; while (!step.done) step = summaryStep(step.cursor); installSummaryTriggers(); };
  const writeSummary = counted => {
    // Every statement is synchronous in the person's Durable Object, so no request can interleave with the write. The totals are
    // kept after it by the triggers (installSummaryTriggers), which a copy installs from its source at the end of its semantics.
    sql.exec('DELETE FROM namespace_summary_origins');
    sql.exec(`INSERT INTO namespace_summary_counts (id, ready, files, bytes, names, uploads_in_progress, bytes_in_progress, chunks, chunk_bytes)
      VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ready = 1, files = excluded.files, bytes = excluded.bytes,
        names = excluded.names, uploads_in_progress = excluded.uploads_in_progress,
        bytes_in_progress = excluded.bytes_in_progress, chunks = excluded.chunks, chunk_bytes = excluded.chunk_bytes`,
      counted.files, counted.bytes, counted.names, counted.uploads_in_progress, counted.bytes_in_progress, counted.chunks, counted.chunk_bytes);
    for (const [origin, held] of Object.entries(counted.origins)) sql.exec('INSERT INTO namespace_summary_origins (origin, files, bytes) VALUES (?, ?, ?)', origin, held.files, held.bytes);
  };
  const installSummaryTriggers = () => {
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_file_added AFTER INSERT ON namespace_files BEGIN
      UPDATE namespace_summary_counts SET files = files + 1, bytes = bytes + NEW.byte_length WHERE id = 1;
      INSERT INTO namespace_summary_origins (origin, files, bytes) VALUES (NEW.origin, 1, NEW.byte_length)
        ON CONFLICT(origin) DO UPDATE SET files = files + 1, bytes = bytes + excluded.bytes;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_file_removed AFTER DELETE ON namespace_files BEGIN
      UPDATE namespace_summary_counts SET files = files - 1, bytes = bytes - OLD.byte_length WHERE id = 1;
      UPDATE namespace_summary_origins SET files = files - 1, bytes = bytes - OLD.byte_length WHERE origin = OLD.origin;
      DELETE FROM namespace_summary_origins WHERE origin = OLD.origin AND files = 0;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_file_changed AFTER UPDATE OF origin, byte_length ON namespace_files
      WHEN NEW.origin IS NOT OLD.origin OR NEW.byte_length IS NOT OLD.byte_length BEGIN
      UPDATE namespace_summary_counts SET bytes = bytes + NEW.byte_length - OLD.byte_length WHERE id = 1;
      UPDATE namespace_summary_origins SET files = files - 1, bytes = bytes - OLD.byte_length WHERE origin = OLD.origin;
      DELETE FROM namespace_summary_origins WHERE origin = OLD.origin AND files = 0;
      INSERT INTO namespace_summary_origins (origin, files, bytes) VALUES (NEW.origin, 1, NEW.byte_length)
        ON CONFLICT(origin) DO UPDATE SET files = files + 1, bytes = bytes + excluded.bytes;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_name_added AFTER INSERT ON namespace_names BEGIN
      UPDATE namespace_summary_counts SET names = names + 1 WHERE id = 1;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_name_removed AFTER DELETE ON namespace_names BEGIN
      UPDATE namespace_summary_counts SET names = names - 1 WHERE id = 1;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_growing_added AFTER INSERT ON namespace_growing WHEN NEW.finished IS NULL BEGIN
      UPDATE namespace_summary_counts SET uploads_in_progress = uploads_in_progress + 1,
        bytes_in_progress = bytes_in_progress + NEW.byte_length WHERE id = 1;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_growing_removed AFTER DELETE ON namespace_growing WHEN OLD.finished IS NULL BEGIN
      UPDATE namespace_summary_counts SET uploads_in_progress = uploads_in_progress - 1,
        bytes_in_progress = bytes_in_progress - OLD.byte_length WHERE id = 1;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_growing_changed AFTER UPDATE OF byte_length, finished ON namespace_growing BEGIN
      UPDATE namespace_summary_counts SET
        uploads_in_progress = uploads_in_progress + (NEW.finished IS NULL) - (OLD.finished IS NULL),
        bytes_in_progress = bytes_in_progress + CASE WHEN NEW.finished IS NULL THEN NEW.byte_length ELSE 0 END
          - CASE WHEN OLD.finished IS NULL THEN OLD.byte_length ELSE 0 END WHERE id = 1;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_chunk_added AFTER INSERT ON namespace_chunks BEGIN
      UPDATE namespace_summary_counts SET chunks = chunks + 1, chunk_bytes = chunk_bytes + NEW.byte_length WHERE id = 1;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_chunk_removed AFTER DELETE ON namespace_chunks BEGIN
      UPDATE namespace_summary_counts SET chunks = chunks - 1, chunk_bytes = chunk_bytes - OLD.byte_length WHERE id = 1;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS namespace_summary_chunk_changed AFTER UPDATE OF byte_length ON namespace_chunks BEGIN
      UPDATE namespace_summary_counts SET chunk_bytes = chunk_bytes + NEW.byte_length - OLD.byte_length WHERE id = 1;
    END`);
  };

  // The list goes in as one JSON value, so its length never meets the store's limit on bound values per query.
  const chunksHeld = chunks => new Set(all('SELECT chunk FROM namespace_chunks WHERE chunk IN (SELECT value FROM json_each(?))', JSON.stringify(chunks)).map(row => row.chunk));
  // How much of a file its spans describe, and how many of their chunks have not arrived.
  const describedOf = file => one('SELECT COUNT(*) AS spans, COALESCE(SUM(s.length), 0) AS bytes, COALESCE(SUM(CASE WHEN c.chunk IS NULL THEN 1 ELSE 0 END), 0) AS missing FROM namespace_spans s LEFT JOIN namespace_chunks c ON c.chunk = s.chunk WHERE s.file = ?', file);
  // A file still being uploaded, readable by its provisional identity as far as its chunks have arrived.
  const growingRow = identity => {
    const row = one('SELECT * FROM namespace_growing WHERE growing = ? AND finished IS NULL', identity);
    if (!row) return null;
    const names = all('SELECT name FROM namespace_names WHERE identity = ? ORDER BY rowid LIMIT 20', row.growing).map(item => item.name).sort(byName);
    // A type the sender left generic is known from the file's name (src/file-type.mjs), so every reader sees a video.
    return {
      identity: row.growing, byte_length: row.byte_length, length_known: !row.length_open, media_type: fileType(row.media_type, names), origin: row.origin, growing: true, spans: row.spans_described, bytes_held: row.bytes_held,
      stored_at: row.started_at, checked_at: null, aliases: [], app: row.app ?? null,
      names,
    };
  };
  const fileRow = (identity, withAliases = true, { includeNames = true } = {}) => {
    const direct = one('SELECT * FROM namespace_files WHERE identity = ?', identity);
    const alias = direct ? null : one('SELECT identity FROM namespace_aliases WHERE alias = ?', identity);
    const row = direct ?? (alias ? one('SELECT * FROM namespace_files WHERE identity = ?', alias.identity) : null);
    if (!row) return growingRow(identity);
    // A private range consumes storage metadata, not display names. A specific
    // stored type needs no name lookup; generic types retain the same bounded
    // alias/name inference used by full and default byte lookups.
    const needsNames = includeNames !== false || !row.media_type || row.media_type === GENERIC_TYPE;
    const aliases = !needsNames ? [] : withAliases ? all('SELECT alias, grade FROM namespace_aliases WHERE identity = ? ORDER BY alias', row.identity) : all('SELECT alias FROM namespace_aliases WHERE identity = ? ORDER BY alias LIMIT ?', row.identity, NAMES_OF_FILE);
    const names = needsNames ? namesOfFile(row.identity, aliases) : [];
    return {
      identity: row.identity, byte_length: row.byte_length, media_type: fileType(row.media_type, names), key: row.key, origin: row.origin, spans: row.spans,
      prefix_identity: row.prefix_identity ?? null,
      stored_at: row.stored_at, checked_at: row.checked_at,
      ...(withAliases ? { aliases } : {}),
      ...(includeNames !== false ? { names } : {}),
    };
  };
  // Up to NAMES_OF_FILE of the names a file is known by, in name order, from the names of its identity and of each of its
  // first aliases, each read by the identity index and stopped at its limit. Sorting every name an identity holds to keep
  // the first 20 (ORDER BY name LIMIT 20 over `identity = ? OR identity IN (aliases)`) read all of them on every call: the
  // same bytes under thousands of names (empty files, copies) made each arriving file read every name already there
  // (the person's store, 2026-10-08: 1.7M rows read a call of namespaceKeepWholeFiles). A file with more names than that shows
  // the ones named first, not the ones first in the alphabet.
  const NAMES_OF_FILE = 20;
  const namesOfFile = (identity, aliases) => {
    const identities = [...new Set([identity, ...aliases.slice(0, NAMES_OF_FILE).map(item => item.alias)])];
    // Bounded compound queries keep each identity's indexed first-20 seek.
    // Durable Object SQLite allows only five terms in a compound SELECT.
    // Names remain individual rows, including large historical strings.
    const rows = [];
    for (let at = 0; at < identities.length; at += 5) {
      const group = identities.slice(at, at + 5);
      // reads-ok: at most five fixed subqueries, each identity-indexed and LIMIT 20; at most 21 identities total.
      const query = group.map(() => 'SELECT name FROM (SELECT name FROM namespace_names WHERE identity = ? ORDER BY rowid LIMIT ?)').join(' UNION ALL ');
      rows.push(...all(query, ...group.flatMap(held => [held, NAMES_OF_FILE])));
    }
    return [...new Set(rows.map(item => item.name))].sort(byName).slice(0, NAMES_OF_FILE);
  };

  // Whether a name's file is kept: a finished file is stored; an upload still arriving is not, and says how far it got
  // and its upload id, so a reader never takes a half-sent file for a whole one.
  const storedOf = identity => {
    const row = identity ? fileRow(identity) : null;
    if (!row) return { stored: identity ? false : null };
    // The file's content type rides along, so a list can pick how to show and play it without a read per file.
    return row.growing ? { stored: false, media_type: row.media_type ?? null, uploading: { upload: row.identity, bytes_held: row.bytes_held, byte_length: row.byte_length, ...(row.length_known === false ? { length_known: false } : {}) } } : { stored: true, media_type: row.media_type ?? null };
  };

  // Exact byte metadata has one source name, so resolving it never enumerates aliases or display names.
  // Its identity and length come from the stored file, not a possibly stale named row.
  const fileMetadataOfName = row => {
    if (!row.identity) return { stored: null };
    const file = one('SELECT identity, byte_length, media_type FROM namespace_files WHERE identity = ?', row.identity)
      ?? one('SELECT f.identity, f.byte_length, f.media_type FROM namespace_aliases a JOIN namespace_files f ON f.identity = a.identity WHERE a.alias = ?', row.identity);
    if (file) return { stored: true, identity: file.identity, byte_length: file.byte_length, media_type: fileType(file.media_type, [row.name]) ?? null };
    const growing = one('SELECT growing, byte_length, media_type, bytes_held, length_open FROM namespace_growing WHERE growing = ? AND finished IS NULL', row.identity);
    return growing
      ? { stored: false, media_type: fileType(growing.media_type, [row.name]) ?? null, uploading: { upload: growing.growing, bytes_held: growing.bytes_held, byte_length: growing.byte_length, ...(growing.length_open ? { length_known: false } : {}) } }
      : { stored: false };
  };

  // storedOf for a whole page of names at once: three set reads (files, files known by another identity, uploads still
  // arriving) instead of a file's whole row, names and aliases read for every name. A name's type, when its store left
  // it generic, is read from that name (src/file-type.mjs), as storedOf reads it from the file's names.
  const storedOfPage = rows => {
    const identities = [...new Set(rows.map(row => row.identity).filter(Boolean))];
    const found = new Map();
    if (identities.length) {
      for (const row of all('SELECT identity, media_type FROM namespace_files WHERE identity IN (SELECT value FROM json_each(?))', JSON.stringify(identities))) found.set(row.identity, row);
      const other = identities.filter(identity => !found.has(identity));
      if (other.length) for (const row of all('SELECT a.alias AS identity, f.media_type FROM namespace_aliases a JOIN namespace_files f ON f.identity = a.identity WHERE a.alias IN (SELECT value FROM json_each(?))', JSON.stringify(other))) found.set(row.identity, row);
      const arriving = identities.filter(identity => !found.has(identity));
      if (arriving.length) for (const row of all('SELECT * FROM namespace_growing WHERE growing IN (SELECT value FROM json_each(?)) AND finished IS NULL', JSON.stringify(arriving))) found.set(row.growing, { ...row, growing: true });
    }
    return new Map(rows.map(row => {
      const file = row.identity ? found.get(row.identity) : null;
      if (!file) return [row.name, { stored: row.identity ? false : null }];
      const mediaType = fileType(file.media_type, [row.name]) ?? null;
      return [row.name, file.growing
        ? { stored: false, media_type: mediaType, uploading: { upload: row.identity, bytes_held: file.bytes_held, byte_length: file.byte_length, ...(file.length_open ? { length_known: false } : {}) } }
        : { stored: true, media_type: mediaType }];
    }));
  };

  return {
    // A store this person attached: { id, interface?, settings?, key: { key_id, bucket } }, its secret already sealed in
    // the box. Replacing it keeps one row per id.
    attachOrigin(origin) {
      if (origin.key?.key !== undefined) throw new Error('A store\'s secret key is sealed in the locked box, never kept in the file index.');
      sql.exec('INSERT INTO namespace_secrets (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value', `origin:${origin.id}`, JSON.stringify(origin));
    },
    attachedOrigins(ids = undefined) {
      const rows = ids === undefined
        ? all("SELECT value FROM namespace_secrets WHERE name LIKE 'origin:%' ORDER BY name")
        : ids.length ? all('SELECT value FROM namespace_secrets WHERE name IN (SELECT value FROM json_each(?)) ORDER BY name',
          JSON.stringify([...new Set(ids.map(id => `origin:${id}`))])) : [];
      return rows.map(row => JSON.parse(row.value)).map(({ key, ...origin }) => ({ ...origin, key: key ? { key_id: key.key_id, bucket: key.bucket } : null }));
    },
    // Secrets an earlier version kept here, still to be carried into the box: [{ name, value }], each value the text the
    // box keeps under heldName(name): the lease key itself, or a store's SigV4 signing root ('AWS4' + its secret key).
    heldHere(names = undefined) {
      const rows = names === undefined
        ? all("SELECT name, value FROM namespace_secrets WHERE name = 'lease-key' OR name LIKE 'origin:%' ORDER BY name")
        : names.length ? all('SELECT name, value FROM namespace_secrets WHERE name IN (SELECT value FROM json_each(?)) ORDER BY name', JSON.stringify([...new Set(names)])) : [];
      return rows.flatMap(row => {
        if (row.name === 'lease-key') return [{ name: row.name, value: row.value }];
        if (!row.name.startsWith('origin:')) return [];
        const secret = JSON.parse(row.value).key?.key;
        return typeof secret === 'string' && secret ? [{ name: row.name, value: `AWS4${secret}` }] : [];
      });
    },
    secretCarryNextAt() {
      const row = one('SELECT done, retry_at FROM namespace_secret_carry WHERE id = 1');
      return row.done ? null : (row.retry_at ?? Date.now());
    },
    secretCarryPage() {
      const state = one('SELECT after, done FROM namespace_secret_carry WHERE id = 1');
      if (state.done) return null;
      const rows = all("SELECT name, value FROM namespace_secrets WHERE name > ? AND name >= 'origin:' AND name < 'origio' ORDER BY name LIMIT ?", state.after, SECRET_CARRY_PAGE);
      const lease = one("SELECT name, value FROM namespace_secrets WHERE name = 'lease-key'");
      const held = [...(lease ? [lease] : []), ...rows].flatMap(row => {
        if (row.name === 'lease-key') return [{ name: row.name, value: row.value }];
        const secret = JSON.parse(row.value).key?.key;
        return typeof secret === 'string' && secret ? [{ name: row.name, value: `AWS4${secret}` }] : [];
      });
      return { held, after: rows.at(-1)?.name ?? state.after, done: rows.length < SECRET_CARRY_PAGE };
    },
    finishSecretCarryPage(page) {
      sql.exec('UPDATE namespace_secret_carry SET after = ?, done = ?, retry_at = NULL WHERE id = 1', page.after, page.done ? 1 : 0);
    },
    delaySecretCarry(retryAt) {
      sql.exec('UPDATE namespace_secret_carry SET retry_at = ? WHERE id = 1 AND done = 0', retryAt);
    },
    // Once the box holds them: the lease key's row goes, and each store's row keeps only its plain half.
    keepOnlyPlain(names) {
      for (const name of names) {
        if (name === 'lease-key') { sql.exec("DELETE FROM namespace_secrets WHERE name = 'lease-key'"); continue; }
        const row = one('SELECT value FROM namespace_secrets WHERE name = ?', name);
        if (!row) continue;
        const { key, ...origin } = JSON.parse(row.value);
        sql.exec('UPDATE namespace_secrets SET value = ? WHERE name = ?', JSON.stringify({ ...origin, key: { key_id: key.key_id, ...(key.bucket ? { bucket: key.bucket } : {}) } }), name);
      }
    },
    locate: fileRow,
    // Arrival bookkeeping and file organization need the file and its bounded display names, never every alias.
    // Explicit alias consumers keep locate(), whose complete identities and grades remain unchanged.
    locateForArrival: identity => fileRow(identity, false),
    // A byte reader needs the file's storage row, type and a download name, but never its complete alias list.
    // An account can name the same bytes many ways; a single range must not read one SQL row per alias.
    // Private byte admission opts out of display names; a generic stored type
    // still uses the established name inference, and growing rows stay fresh.
    locateForBytes: (identity, options) => fileRow(identity, false, options),
    // Every identity the same bytes are known by (the one asked, the file's own, and its aliases), from two indexed
    // reads: what a lookup by any identity needs, without the names and sizes locate also gathers.
    identitiesOf(identity) {
      const own = one('SELECT identity FROM namespace_files WHERE identity = ?', identity)?.identity ?? one('SELECT identity FROM namespace_aliases WHERE alias = ?', identity)?.identity ?? null;
      return [...new Set([identity, ...(own ? [own, ...all('SELECT alias FROM namespace_aliases WHERE identity = ?', own).map(row => row.alias)] : [])])];
    },
    addAliases(identity, aliases, grade = 'attested') {
      for (const alias of aliases) sql.exec('INSERT INTO namespace_aliases (alias, identity, grade, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias) DO NOTHING', alias, identity, grade, now());
      return fileRow(identity);
    },
    // Answers { named, unnamed_uploads }: the uploads still arriving that these names were taken from and that now have
    // no name at all, which nobody can find or finish any more, for the caller to cancel.
    putNames(names, onChanged = null) {
      let named = 0;
      const movedFrom = new Set();
      // The compare phase sees the original rows. Two operations on one name could each pass against that same row,
      // then the later operation would overwrite the earlier one. Make a batch unambiguous before it changes a row.
      const seen = new Set();
      for (const item of names) {
        if (!isFileName(item?.name)) continue;
        if (seen.has(item.name)) return { named: 0, unnamed_uploads: [], conflicts: [{ name: item.name, code: 'duplicate_name' }] };
        seen.add(item.name);
      }
      // Only this request's distinct names, read before the compare/write phase. Nothing
      // can interleave with this synchronous owner; these maps never survive the call.
      const beforeRows = new Map();
      const promised = new Map();
      const selectedNames = [...seen];
      // Public naming batches may contain thousands of long Unicode paths. Keep
      // each JSON binding below 32KiB as well as bounding its name count.
      for (let start = 0; start < selectedNames.length;) {
        let count = Math.min(128, selectedNames.length - start);
        let selected = JSON.stringify(selectedNames.slice(start, start + count));
        while (count > 1 && new TextEncoder().encode(selected).byteLength > 32_768) {
          count = Math.ceil(count / 2);
          selected = JSON.stringify(selectedNames.slice(start, start + count));
        }
        for (const row of all('SELECT n.name, n.identity, n.byte_length, n.modified_at_ms FROM json_each(?) AS requested JOIN namespace_names n ON n.name = requested.value LIMIT ?', selected, count)) beforeRows.set(row.name, row);
        for (const row of all('SELECT n.name, n.upload FROM json_each(?) AS requested JOIN namespace_names_promised n ON n.name = requested.value', selected)) {
          if (!promised.has(row.name)) promised.set(row.name, []);
          promised.get(row.name).push(row.upload);
        }
        start += count;
      }
      // Compare every supplied base before any row changes. A rename is a remove plus an add; a losing editor must
      // leave both names untouched and keep its completed bytes reachable by content identity.
      const sources = new Map();
      const conflicts = names.flatMap(item => {
        if (!isFileName(item?.name)) return [];
        const refused = [];
        if (Object.hasOwn(item, 'source_name') || Object.hasOwn(item, 'source_identity') || Object.hasOwn(item, 'source_byte_length')) {
          // A reference copy is admitted by this account's current source name inside the same transaction as the
          // destination compare/write. A prior HTTP lookup cannot prevent a removal or replacement between calls.
          const source = isFileName(item.source_name) ? one(`SELECT n.identity, n.byte_length, n.modified_at_ms, f.byte_length AS file_byte_length FROM namespace_names n
            JOIN namespace_files f ON f.identity = n.identity WHERE n.name = ?`, item.source_name) : null;
          if (item.remove === true || !/^1f:[0-9a-f]{64}$/.test(item.source_identity ?? '')
              || item.identity !== item.source_identity || source?.identity !== item.source_identity) {
            refused.push({ name: item.name, code: 'source_changed', source_name: item.source_name ?? null,
              source_identity: item.source_identity ?? null, current_identity: source?.identity ?? null });
          } else if (Object.hasOwn(item, 'source_byte_length') && (!Number.isSafeInteger(item.source_byte_length)
              || item.source_byte_length < 0 || source.byte_length !== item.source_byte_length || source.file_byte_length !== item.source_byte_length)) {
            // A represented native length can replace separate source HTTP lookups only when both the current
            // source name and canonical stored file agree here, before any name in this batch is changed.
            refused.push({ name: item.name, code: 'source_length_changed', source_name: item.source_name,
              source_identity: item.source_identity, source_byte_length: item.source_byte_length,
              current_name_byte_length: source.byte_length, current_file_byte_length: source.file_byte_length });
          } else sources.set(item.source_name, source);
        }
        if (Object.hasOwn(item, 'expected_identity')) {
          const current = beforeRows.get(item.name);
          const current_identity = current?.identity ?? null;
          const matches = item.expected_identity === null ? !current : current?.identity === item.expected_identity;
          if (!matches) refused.push({ name: item.name, expected_identity: item.expected_identity, current_identity });
        }
        return refused;
      });
      if (conflicts.length) return { named: 0, unnamed_uploads: [], conflicts };
      for (const item of names) {
        const name = typeof item?.name === 'string' ? item.name : '';
        if (!isFileName(name)) continue;
        const beforeRow = beforeRows.get(name);
        const before = beforeRow?.identity;
        if (before?.startsWith('up:') && before !== item.identity) movedFrom.add(before);
        // `remove: true` takes the name away; the file it named stays, reachable by its identity and other names.
        if (item.remove === true) {
          for (const row of sql.exec('DELETE FROM namespace_names_promised WHERE name = ? RETURNING upload', name).toArray()) movedFrom.add(row.upload);
          const removed = sql.exec('DELETE FROM namespace_names WHERE name = ? RETURNING identity', name).toArray();
          named += removed.length;
          for (const row of removed) onChanged?.(row.identity);
          readNamesAgain(sql);
          continue;
        }
        const identity = typeof item.identity === 'string' && (/^(1f|12):[0-9a-f]{64}$/.test(item.identity) || /^up:[0-9a-f]{32}$/.test(item.identity)) ? item.identity : null;
        // A names-only reference carries the source name's date/size. An existing destination already naming those
        // same bytes retains its own metadata; lookup-by-identity HTTP replies do not carry name modification dates.
        const metadata = Object.hasOwn(item, 'source_name') ? (before === identity ? beforeRow : sources.get(item.source_name)) : item;
        // A name given to anything else is no longer promised to an upload still arriving.
        const unpromised = (promised.get(name) ?? []).some(upload => upload !== identity)
          ? sql.exec('DELETE FROM namespace_names_promised WHERE name = ? AND upload IS NOT ? RETURNING upload', name, identity).toArray() : [];
        for (const row of unpromised) movedFrom.add(row.upload);
        if (unpromised.length) onChanged?.(identity);
        // Asked for by an upload while a kept file has it: the kept file keeps it until the upload finishes.
        if (identity?.startsWith('up:') && before && !before.startsWith('up:') && one('SELECT 1 AS kept FROM namespace_files WHERE identity = ?', before)) {
          sql.exec('INSERT INTO namespace_names_promised (upload, name, promised_at) VALUES (?, ?, ?) ON CONFLICT(upload, name) DO NOTHING', identity, name, now());
          named += 1;
          continue;
        }
        const byte_length = Number.isSafeInteger(metadata?.byte_length) ? metadata.byte_length : null;
        const modified_at_ms = Number.isSafeInteger(metadata?.modified_at_ms) ? metadata.modified_at_ms : null;
        if (beforeRow && beforeRow.identity === identity && beforeRow.byte_length === byte_length && beforeRow.modified_at_ms === modified_at_ms) {
          named += 1;
          continue;
        }
        // Sending the same name again names the kept bytes as before; it does not rename them at a new time or
        // change their folder. Keep the accepted-name count below, but write and wake folder readers only when a
        // stored field changes. IS NOT compares missing metadata as well as values, including NULL -> 0.
        const changed = sql.exec(`INSERT INTO namespace_names (name, collection, identity, byte_length, modified_at_ms, named_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET identity = excluded.identity, byte_length = excluded.byte_length, modified_at_ms = excluded.modified_at_ms, named_at = excluded.named_at
          WHERE namespace_names.identity IS NOT excluded.identity OR namespace_names.byte_length IS NOT excluded.byte_length OR namespace_names.modified_at_ms IS NOT excluded.modified_at_ms
          ${onChanged ? 'RETURNING identity' : ''}`,
          name, parentOf(name), identity, byte_length, modified_at_ms, now()).toArray();
        for (const row of changed) onChanged?.(row.identity);
        named += 1;
      }
      const unnamed_uploads = [...movedFrom].filter(upload => one('SELECT 1 AS open FROM namespace_growing WHERE growing = ? AND finished IS NULL', upload) && !one('SELECT 1 AS named FROM namespace_names WHERE identity = ?', upload) && !one('SELECT 1 AS promised FROM namespace_names_promised WHERE upload = ?', upload));
      // An empty naming batch changes nothing and lets an installed client check the serving store's actual
      // condition support before a reference write. Older stores ignore source fields, so fail closed there.
      return { named, unnamed_uploads, ...(names.length === 0 ? { name_conditions: { source_identity: true, source_byte_length: true, expected_identity: true } } : {}) };
    },
    // One page of a folder. Each name that is one of several versions of the same file (file-versions.mjs) carries
    // `version` { family, latest, latest_name, versions }; each whose bytes are also kept under other names carries
    // `named_at` (when this name was given in Trillion, so a reader whose file carries no modified time can still show
    // a true date), `also_named` (how many other names) and `also_at` (up to ALSO_AT of those names, so a person sees where else it is:
    // the same clip copied from two drives, or saved twice). A family's names share a leading part, so they sit together in name order:
    // only a family reaching past this page's first or last name is read further, by that part (an index seek).
    listNames(collection, after, limit) {
      // A page may carry long names. Consume the bounded query through its cursor so SQLite never materializes
      // all of its result rows at once (the old toArray() exceeded the account store's result limit).
      const rows = Array.from(sql.exec('SELECT name, identity, byte_length, modified_at_ms, named_at FROM namespace_names WHERE collection = ? AND name > ? ORDER BY name LIMIT ?', collection, after, limit + 1));
      const stored = storedOfPage(rows.slice(0, limit));
      const page = rows.slice(0, limit).map(row => ({ ...row, ...stored.get(row.name) }));
      const around = new Map(page.map(row => [row.name, row]));
      const first = page[0]?.name;
      const last = page.at(-1)?.name;
      for (const prefix of new Set(page.map(row => familyPrefix(row.name)))) {
        if (!((after && first.startsWith(prefix)) || (rows.length > limit && last.startsWith(prefix)))) continue;
        for (const row of sql.exec('SELECT name, identity, byte_length, modified_at_ms FROM namespace_names WHERE collection = ? AND name >= ? AND name < ? ORDER BY name LIMIT 1000', collection, prefix, `${prefix}\uffff`)) if (!around.has(row.name)) around.set(row.name, row);
      }
      const versions = versionFamilies([...around.values()]);
      const identities = [...new Set(page.map(row => row.identity).filter(Boolean))];
      // Preserve exact legacy counts until the bounded background fill is complete. Warm pages seek only the
      // displayed identities' summary rows, regardless of how many copies live in other folders.
      const counts = !identities.length ? [] : nameCounts.ready() ? nameCounts.counts(identities)
        : all('SELECT identity, COUNT(*) AS names FROM namespace_names WHERE identity IN (SELECT value FROM json_each(?)) GROUP BY identity', JSON.stringify(identities));
      const namesOf = new Map(counts.map(row => [row.identity, row.names]));
      const shared = identities.filter(identity => namesOf.get(identity) > 1);
      // Each shared identity reads its first few names by the identity index.
      const placesOf = new Map(shared.map(identity => [identity, all('SELECT name FROM namespace_names WHERE identity = ? ORDER BY rowid LIMIT ?', identity, ALSO_AT + 1).map(row => row.name).sort(byName)]));
      const names = page.map(row => {
        const version = versions.get(row.name);
        const others = (namesOf.get(row.identity) ?? 1) - 1;
        const at = others > 0 ? (placesOf.get(row.identity) ?? []).filter(name => name !== row.name).slice(0, ALSO_AT) : [];
        return { ...row, ...(version ? { version } : {}), ...(others > 0 ? { also_named: others, also_at: at } : {}) };
      });
      return { collection, names, next_after: rows.length > limit ? page.at(-1).name : null };
    },
    // One named entry for a folder listing: the file under that name, or whether it is a folder with names under it.
    // Exact occupancy does not need byte state, aliases or a subtree revision. Existing detailed reads retain them.
    entry(name, { includeDetails = true, includeFileMetadata = false } = {}) {
      const row = one(includeFileMetadata
        ? 'SELECT name, identity, byte_length, modified_at_ms, named_at FROM namespace_names WHERE name = ?'
        : 'SELECT name, identity, byte_length, modified_at_ms FROM namespace_names WHERE name = ?', name);
      if (row) return { ...row, folder: false, ...(includeFileMetadata ? fileMetadataOfName(row) : includeDetails ? storedOf(row.identity) : {}) };
      const inside = one('SELECT 1 AS found FROM namespace_names WHERE name >= ? AND name < ? LIMIT 1', `${name}/`, `${name}0`);
      return inside || name === '/' ? { name, folder: true, ...(includeDetails ? { revision: folderRevision(name) } : {}) } : null;
    },
    folderRevision,
    childFoldersWithRevisions(collection) {
      const folders = this.childFolders(collection);
      return { folders, folder_revisions: Object.fromEntries(folders.map(folder => [folder, folderRevision(folder)])) };
    },
    // One server-side transaction moves the whole subtree; a client never exposes a partly moved 5,000-name batch.
    moveReceipt(opId) {
      return one('SELECT input_identity, output FROM namespace_move_receipts WHERE op_id = ?', opId);
    },
    // The receipts kept, counted up to `most` only: a caller asks whether a limit is reached, and a store holding more reads no further.
    moveReceiptCount(most = Number.MAX_SAFE_INTEGER) {
      return one('SELECT COUNT(*) AS count FROM (SELECT 1 FROM namespace_move_receipts LIMIT ?)', most)?.count ?? 0;
    },
    saveMoveReceipt(opId, inputIdentity, output) {
      sql.exec('INSERT INTO namespace_move_receipts (op_id, input_identity, output, created_at) VALUES (?, ?, ?, ?)',
        opId, inputIdentity, JSON.stringify(output), now());
    },
    forgetMoveReceipt(opId) {
      sql.exec('DELETE FROM namespace_move_receipts WHERE op_id = ?', opId);
      return (one('SELECT changes() AS changed')?.changed ?? 0) > 0;
    },
    // One server-side transaction moves the whole subtree; a client never exposes a partly moved 5,000-name batch.
    moveFolder(from, to, expectedRevision) {
      if (!isFileName(from) || !isFileName(to) || from === '/' || to === '/' || from === to || to.startsWith(`${from}/`))
        return { error: 'Choose a folder and a different name outside it.' };
      if (!/^folder:\d+$/.test(expectedRevision ?? '')) return { error: 'Open the current folder before moving it.', code: 'stale_version' };
      const sourcePrefix = `${from}/`, sourceEnd = `${from}0`, targetPrefix = `${to}/`, targetEnd = `${to}0`;
      if (one('SELECT 1 AS found FROM namespace_names WHERE name = ?', from)) return { error: 'This name is a file, not a folder.' };
      if (!one('SELECT 1 AS found FROM namespace_names WHERE name >= ? AND name < ? LIMIT 1', sourcePrefix, sourceEnd))
        return { error: 'This folder is no longer here.', code: 'stale_version', current_revision: null };
      const current = folderRevision(from);
      if (current !== expectedRevision) return { error: 'This folder changed. Open its current version before moving it.', code: 'stale_version', current_revision: current };
      if (one('SELECT 1 AS found FROM namespace_names WHERE name = ? OR (name >= ? AND name < ?) LIMIT 1', to, targetPrefix, targetEnd))
        return { error: 'The destination already has files or a folder.', code: 'filename_collision' };
      if (one('SELECT 1 AS found FROM namespace_names WHERE name >= ? AND name < ? AND identity LIKE ? LIMIT 1', sourcePrefix, sourceEnd, 'up:%')
        || one('SELECT 1 AS found FROM namespace_names_promised WHERE name >= ? AND name < ? LIMIT 1', sourcePrefix, sourceEnd)
        || one('SELECT 1 AS found FROM namespace_name_intents WHERE name >= ? AND name < ? LIMIT 1', sourcePrefix, sourceEnd))
        return { error: 'A file in this folder is still uploading. Try again when it finishes.', code: 'stale_version', current_revision: current };
      // SQLite substring/length count Unicode code points; JS admission counts UTF-16 units.
      // Most paths are short enough under either count. Validate only potentially long results
      // with the same admission owner before mutating any name.
      const sourceCharacters = [...from].length;
      let afterName = sourcePrefix;
      for (;;) {
        const longNames = sql.exec('SELECT name FROM namespace_names WHERE name > ? AND name < ? AND (length(name) - ?) * 2 + ? > 4096 ORDER BY name LIMIT 50', afterName, sourceEnd, sourceCharacters, to.length).toArray();
        if (longNames.some(row => !isFileName(to + row.name.slice(from.length))))
          return { error: 'A file name would be too long after the move.' };
        if (longNames.length < 50) break;
        afterName = longNames.at(-1).name;
      }
      sql.exec(`UPDATE namespace_names SET name = ? || substr(name, ?), collection = ? || substr(collection, ?), named_at = ?
        WHERE name >= ? AND name < ?`, to, sourceCharacters + 1, to, sourceCharacters + 1, now(), sourcePrefix, sourceEnd);
      const moved = one('SELECT changes() AS moved')?.moved ?? 0;
      readNamesAgain(sql);
      return { moved, from, to, revision: folderRevision(to) };
    },
    // Seek to each direct child's first collection, then past all of that child's descendants.
    // The (collection, name) index covers each seek, so deep trees cost one or two reads per child.
    // A wide folder falls back to one range scan rather than issuing thousands of SQL statements.
    childFolders(collection) {
      const prefix = collection === '/' ? '/' : `${collection}/`;
      // Every folder prefix ends in '/'; '0' is the next byte in the index's binary collation.
      // This upper bound includes supplementary Unicode names, unlike a suffix of U+FFFF.
      const end = `${prefix.slice(0, -1)}0`;
      const children = new Set();
      let after = prefix;
      let inclusive = false;
      while (true) {
        const row = one(`SELECT collection FROM namespace_names WHERE collection ${inclusive ? '>=' : '>'} ? AND collection < ? ORDER BY collection LIMIT 1`, after, end);
        if (!row) break;
        const next = row.collection.slice(prefix.length).split('/')[0];
        if (!next) { after = `${prefix}0`; inclusive = true; continue; }
        const child = prefix + next;
        children.add(child);
        if (children.size > CHILD_FOLDER_SEEK_LIMIT) {
          // Returning this many children already dominates the work; one range scan is cheaper
          // than another seek for every direct child. The limit caps statement count.
          return [...new Set(all('SELECT DISTINCT collection FROM namespace_names WHERE collection > ? AND collection < ?', prefix, end)
            .map(({ collection: name }) => prefix + name.slice(prefix.length).split('/')[0]).filter(name => name !== prefix))].sort();
        }
        if (row.collection === child) {
          // child-2 and child.2 sort between child and child/, so check that gap first.
          after = child;
          inclusive = false;
        } else {
          // '/' sorts immediately before '0' under the index's binary collation.
          after = `${child}0`;
          inclusive = true;
        }
      }
      return [...children].sort();
    },
    // The folders whose names changed after `after` in the running count, oldest change first, and the count now. A
    // copy that has never asked (after 0) or holds a count this store never reached (it was cleared) gets `all: true`:
    // list again whatever it keeps. A store where nothing was ever named answers nothing changed, so a new account's
    // drive is not told to list everything again on every look.
    changedFolders(after = 0, limit = 1000) {
      const seq = one('SELECT COALESCE(MAX(seq), 0) AS seq FROM namespace_folder_changes')?.seq ?? 0;
      if (after > seq || (!(after > 0) && seq > 0)) return { seq, all: true, folders: [] };
      const folders = all('SELECT collection, seq FROM namespace_folder_changes WHERE seq > ? ORDER BY seq LIMIT ?', after, limit);
      return folders.length === limit
        ? { seq: folders.at(-1).seq, all: false, folders: folders.map(row => row.collection), more: true }
        : { seq, all: false, folders: folders.map(row => row.collection) };
    },
    // A copy of a folder (or the whole drive, from '/') under another folder, made of names only: every name under
    // `from` is given again under `to`, pointing at the same bytes by identity, so nothing is copied or stored again and
    // the copy is as fast as writing its names. A name already used under `to` keeps what it names (the copy never
    // overwrites), uploads still arriving are left out, and `to` may not sit inside `from` unless `from` is the whole drive. One page of `limit` names
    // per call, in name order after `after`; `next_after` continues it.
    forkFolder(from, to, after = '', limit = 5000) {
      const source = from === '/' ? '/' : from.replace(/\/+$/, '');
      const target = to.replace(/\/+$/, '');
      if (!isFileName(source) || !isFileName(target) || target === '/') return { error: 'Name the folder to copy from and a folder to copy into, each starting with /.' };
      const sourcePrefix = source === '/' ? '/' : `${source}/`;
      // The whole drive may be copied into one of its own folders (that folder itself is left out of the copy); any
      // other folder cannot be copied inside itself.
      if (source !== '/' && (target === source || target.startsWith(sourcePrefix))) return { error: 'The copy cannot go inside the folder it copies.' };
      const targetPrefix = `${target}/`;
      const page = all(`SELECT name, identity, byte_length, modified_at_ms FROM namespace_names
        WHERE name > ? AND name >= ? AND name < ? AND identity IS NOT NULL AND identity NOT LIKE 'up:%' ORDER BY name LIMIT ?`,
      after, sourcePrefix, `${sourcePrefix.slice(0, -1)}0`, limit + 1);
      let copied = 0;
      for (const row of page.slice(0, limit)) {
        if (row.name.startsWith(targetPrefix)) continue;
        const name = `${target}/${row.name.slice(sourcePrefix.length)}`;
        if (!isFileName(name)) continue;
        copied += sql.exec(`INSERT INTO namespace_names (name, collection, identity, byte_length, modified_at_ms, named_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(name) DO NOTHING RETURNING 1`, name, parentOf(name), row.identity, row.byte_length, row.modified_at_ms, now()).toArray().length;
      }
      return { from: source, to: target, copied, looked_at: Math.min(page.length, limit), next_after: page.length > limit ? page[limit - 1].name : null };
    },
    // A folder and every folder under it (at most 1000): where a set of files, like an unpacked export, was put.
    // Each next folder is one index seek past the last (as childFolders walks), so the cost follows the folders found,
    // never the files inside them.
    foldersUnder(folder) {
      const prefix = folder === '/' ? '/' : `${folder}/`;
      const end = `${prefix.slice(0, -1)}0`;
      const found = [folder];
      for (let after = prefix; found.length <= 1000;) {
        const row = one('SELECT collection FROM namespace_names WHERE collection > ? AND collection < ? ORDER BY collection LIMIT 1', after, end);
        if (!row) break;
        found.push(row.collection);
        after = row.collection;
      }
      return found;
    },
    // The newest files named in one folder or any folder beneath it, newest first (the collection index's range, then
    // only those rows sorted): where a person's own recordings or notes are looked for.
    newestUnder(folder, limit = 50) {
      const prefix = folder === '/' ? '/' : `${folder}/`;
      return all('SELECT name, identity, byte_length, modified_at_ms FROM namespace_names WHERE identity IS NOT NULL AND (collection = ? OR (collection > ? AND collection < ?)) ORDER BY modified_at_ms DESC LIMIT ?', folder, prefix, `${prefix}\uffff`, limit);
    },
    // Names directly in one folder whose last part begins with `stem`, in name order (an index seek, never a scan).
    namesStartingWith(collection, stem, limit = 20) {
      const start = `${collection === '/' ? '/' : `${collection}/`}${stem}`;
      return all('SELECT name, identity FROM namespace_names WHERE collection = ? AND name >= ? AND name < ? ORDER BY name LIMIT ?', collection, start, `${start}\uffff`, limit);
    },
    byName(name) {
      const row = one('SELECT identity FROM namespace_names WHERE name = ?', name);
      const file = row?.identity ? fileRow(row.identity) : null;
      // The point lookup proved this name, even when it was added after the
      // bounded sample of other names for the same bytes.
      return file ? { ...file, names: [name, ...file.names.filter(other => other !== name)]
        .slice(0, NAMES_OF_FILE).sort(byName) } : null;
    },
    // Every named file's extension and bytes, summed per extension (the Drives screen's file types for the cloud space).
    byExtension() {
      const sums = new Map();
      for (const { name, byte_length } of sql.exec('SELECT name, byte_length FROM namespace_names WHERE identity IS NOT NULL')) {
        const base = name.slice(name.lastIndexOf('/') + 1);
        const dot = base.lastIndexOf('.');
        const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
        const now = sums.get(extension) ?? { extension, files: 0, bytes: 0 };
        now.files += 1;
        now.bytes += byte_length ?? 0;
        sums.set(extension, now);
      }
      return [...sums.values()];
    },
    // Kept files no name points at and that were not deleted or archived (Recently Deleted and Archived keep theirs):
    // reachable only by identity, so lost from Files and search. How many, and the first `limit` with what is known of
    // each (its other identities, the kinds of results kept about it) to find its name again.
    unnamed(limit = 50, before = null) {
      const has = table => one("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", table).n > 0;
      const from = `FROM namespace_files f WHERE NOT EXISTS (SELECT 1 FROM namespace_names n WHERE n.identity = f.identity)${
        has('namespace_set_aside_names') ? ' AND NOT EXISTS (SELECT 1 FROM namespace_set_aside_names s WHERE s.identity = f.identity)' : ''}`;
      const results = has('namespace_results');
      // Paged by the last file's time and identity, so files kept in the same instant are never skipped (src/time-cursor.mjs).
      const after = afterTimeCursor(readTimeCursor(before), 'f.stored_at', 'f.identity');
      const page = all(`SELECT f.identity, f.byte_length, f.media_type, f.stored_at ${from} AND ${after.sql} ORDER BY f.stored_at DESC, f.identity DESC LIMIT ?`, ...after.args, limit).map(row => {
        const aliases = all('SELECT alias FROM namespace_aliases WHERE identity = ?', row.identity).map(alias => alias.alias);
        const kept = results ? [...new Set([row.identity, ...aliases].flatMap(identity => all('SELECT kind FROM namespace_results WHERE identity = ?', identity).map(result => result.kind)))] : [];
        // The app that sent it (the upload it finished from), so a sender that leaves files nameless can be found.
        const upload = aliases.find(alias => alias.startsWith('up:'));
        const app = upload ? one('SELECT app FROM namespace_growing WHERE growing = ?', upload)?.app ?? null : null;
        return { ...row, aliases, kept, app };
      });
      return { count: one(`SELECT COUNT(*) AS n ${from}`).n, files: page, next_before: page.length === limit ? timeCursor(page.at(-1).stored_at, page.at(-1).identity) : null };
    },
    /** How many files were stored at or after `since` (an ISO time), counting at most the newest 1000, and the newest time. */
    storedSince(since) {
      const row = one('SELECT COUNT(*) AS count, MAX(stored_at) AS at FROM (SELECT stored_at FROM namespace_files WHERE stored_at >= ? ORDER BY stored_at DESC LIMIT 1000)', String(since));
      return { count: row?.count ?? 0, at: row?.at ?? null };
    },
    /** One bounded chunk of the first summary count: { cursor, done }. Done at once when the totals are already kept. */
    summaryStep,
    /** The triggers that keep the totals once they are counted: present after a copy has installed its source's (if the source kept none). */
    keepSummary: installSummaryTriggers,
    summary() {
      let counts = summaryCounts();
      if (!counts) { seedSummary(); counts = summaryCounts(); }
      const { files, bytes, names, uploads_in_progress, bytes_in_progress, chunks, chunk_bytes } = counts;
      const byOrigin = Object.fromEntries(all('SELECT origin, files, bytes FROM namespace_summary_origins ORDER BY origin').map(row => [row.origin, { files: row.files, bytes: row.bytes }]));
      return { files, bytes, by_origin: byOrigin, names, uploads_in_progress, bytes_in_progress, chunks, chunk_bytes };
    },
    move(identity) {
      const row = one('SELECT * FROM namespace_moves WHERE identity = ?', identity);
      if (!row) return null;
      return { ...row, parts: Object.fromEntries(all('SELECT number, etag FROM namespace_move_parts WHERE identity = ?', identity).map(part => [part.number, part.etag])) };
    },
    startMove(move) {
      const file = one('SELECT origin, key, byte_length FROM namespace_files WHERE identity = ?', move.identity);
      sql.exec('INSERT INTO namespace_moves (identity, to_origin, to_key, upload_id, started_at, from_origin, from_key, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', move.identity, move.to_origin, move.to_key, move.upload_id, now(), file?.origin ?? null, file?.key ?? null, file?.byte_length ?? null);
    },
    movePartCopied(identity, number, etag) {
      sql.exec('INSERT INTO namespace_move_parts (identity, number, etag) VALUES (?, ?, ?) ON CONFLICT(identity, number) DO UPDATE SET etag = excluded.etag', identity, number, etag);
    },
    moveCompleted(identity) { sql.exec('UPDATE namespace_moves SET completed = 1 WHERE identity = ?', identity); },
    movePartsVerified(identity, count) { sql.exec('UPDATE namespace_moves SET parts_verified = ? WHERE identity = ?', count, identity); },
    dropMove(identity) {
      sql.exec('DELETE FROM namespace_move_parts WHERE identity = ?', identity);
      sql.exec('DELETE FROM namespace_moves WHERE identity = ?', identity);
    },
    // The verified destination becomes current atomically, while the move retains a durable source-cleanup instruction.
    finishMove(identity) {
      const move = one('SELECT * FROM namespace_moves WHERE identity = ?', identity);
      if (!move) return fileRow(identity);
      const file = one('SELECT origin, key, byte_length FROM namespace_files WHERE identity = ?', identity);
      sql.exec('UPDATE namespace_moves SET from_origin = COALESCE(from_origin, ?), from_key = COALESCE(from_key, ?), byte_length = COALESCE(byte_length, ?), cleanup_pending = 1 WHERE identity = ?', file?.origin ?? null, file?.key ?? null, file?.byte_length ?? null, identity);
      sql.exec('UPDATE namespace_files SET origin = ?, key = ?, checked_at = ? WHERE identity = ?', move.to_origin, move.to_key, now(), identity);
      return fileRow(identity);
    },
    partBytesOf(identity) { return one('SELECT part_bytes FROM namespace_files WHERE identity = ?', identity)?.part_bytes ?? null; },
    // Stored files kept in one origin, in identity order, a page at a time.
    filesIn(origin, after, limit) {
      const rows = all('SELECT identity, byte_length FROM namespace_files WHERE origin = ? AND identity > ? ORDER BY identity LIMIT ?', origin, after, limit + 1);
      return { origin, files: rows.slice(0, limit), next_after: rows.length > limit ? rows[limit - 1].identity : null };
    },
    // One bounded page of stored identities for background work such as saved
    // media covers. Resolve names in batches so generic MIME types get the
    // same extension-aware classification as locate(), without one lookup per
    // file or a whole-account scan on a person's request.
    storedFilesAfter(after = null, limit = 64) {
      const count = Math.min(128, Math.max(1, Math.floor(Number(limit) || 64)));
      const cursor = after && typeof after.stored_at === 'string' && typeof after.identity === 'string' ? after : null;
      const rows = cursor
        // `stored_at <= ?` first, so the read seeks to the cursor in namespace_files_recent instead of walking every
        // newer file on each page (2026-10-05: a page read every file above it).
        ? all('SELECT identity, media_type, stored_at FROM namespace_files WHERE stored_at <= ? AND (stored_at < ? OR identity > ?) ORDER BY stored_at DESC, identity LIMIT ?', cursor.stored_at, cursor.stored_at, cursor.identity, count + 1)
        : all('SELECT identity, media_type, stored_at FROM namespace_files ORDER BY stored_at DESC, identity LIMIT ?', count + 1);
      const page = rows.slice(0, count);
      if (!page.length) return { files: [], next_after: null };
      const identities = JSON.stringify(page.map(row => row.identity));
      const names = [
        ...all('SELECT identity, name FROM namespace_names WHERE identity IN (SELECT value FROM json_each(?))', identities),
        ...all('SELECT a.identity, n.name FROM namespace_aliases a JOIN namespace_names n ON n.identity = a.alias WHERE a.identity IN (SELECT value FROM json_each(?))', identities),
      ];
      const namesByIdentity = new Map();
      for (const row of names) {
        if (!namesByIdentity.has(row.identity)) namesByIdentity.set(row.identity, []);
        namesByIdentity.get(row.identity).push(row.name);
      }
      return {
        files: page.map(row => ({ identity: row.identity, media_type: fileType(row.media_type, namesByIdentity.get(row.identity) ?? []), stored_at: row.stored_at })),
        next_after: rows.length > count ? { stored_at: page.at(-1).stored_at, identity: page.at(-1).identity } : null,
      };
    },
    // Account deletion walks what the store keeps one page at a time: the rows after `after` in key order (`cursor` is the
    // key to continue from). Each stage names its own table and key, and every row says where its bytes are kept.
    deletionPage(stage, after = '', limit = 1) {
      const count = Math.min(100, Math.max(1, Math.floor(Number(limit) || 1)));
      if (stage === 'moves') return this.movesInProgress(after, count).map(row => ({ ...row, cursor: row.identity }));
      if (stage === 'uploads') return all('SELECT upload_id AS cursor, upload_id, origin, key, byte_length FROM namespace_unfinished_uploads WHERE upload_id > ? ORDER BY upload_id LIMIT ?', after, count);
      if (stage === 'growing') return all('SELECT growing AS cursor, origin, byte_length - new_bytes AS byte_length FROM namespace_growing WHERE growing > ? AND finished IS NULL AND length_open = 0 AND byte_length > new_bytes ORDER BY growing LIMIT ?', after, count);
      if (stage === 'files') return all("SELECT identity AS cursor, origin, key, byte_length FROM namespace_files WHERE identity > ? AND key != '' ORDER BY identity LIMIT ?", after, count);
      if (stage === 'chunks') return all('SELECT chunk AS cursor, origin, key, byte_length FROM namespace_chunks WHERE chunk > ? ORDER BY chunk LIMIT ?', after, count);
      throw new Error(`Unknown namespace deletion stage ${stage}.`);
    },

    // ---- chunks and growing files ----------------------------------------------------------------------------
    // Of these chunk identities, the ones this person already holds.
    chunksHeld,
    chunkStored(chunk) {
      const added = sql.exec('INSERT INTO namespace_chunks (chunk, byte_length, origin, key, stored_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chunk) DO NOTHING RETURNING chunk', chunk.chunk, chunk.byte_length, chunk.origin, chunk.key, now()).toArray().length;
      // Room was claimed for the whole file when it started; what it really added is counted, and the rest given back.
      if (added && chunk.growing) sql.exec('UPDATE namespace_growing SET new_bytes = new_bytes + ? WHERE growing = ?', chunk.byte_length, chunk.growing);
      return added;
    },
    // A chunk of an upload in progress whose bytes are now in a store, in one step: the upload must still be open; the
    // chunk is recorded unless this person already holds it; the upload's stored bytes grow by every span of it that
    // chunk fills. Answers { error } for an upload that is not open, else { added } (false: it was already held, so
    // the copy just written is not needed). `placed`: the chunk went to the store the upload claimed its room in.
    chunkArrived({ growing, chunk, byte_length, origin, key, placed }) {
      if (!one('SELECT 1 AS open FROM namespace_growing WHERE growing = ? AND finished IS NULL', growing)) return { error: 'This upload is not open.' };
      const added = this.chunkStored({ chunk, byte_length, origin, key, growing: placed ? growing : null }) > 0;
      // Every open upload that described this chunk before it arrived now holds the bytes of its spans of it (kept by
      // addSpans in namespace_span_waits, found by the chunk's index: a few rows, whatever the size of any file).
      if (added) {
        for (const wait of all('DELETE FROM namespace_span_waits WHERE chunk = ? RETURNING file, length', chunk)) {
          sql.exec('UPDATE namespace_growing SET bytes_held = bytes_held + ? WHERE growing = ?', wait.length, wait.file);
        }
      }
      return { added };
    },
    chunkMoved(chunk, origin, key) { sql.exec('UPDATE namespace_chunks SET origin = ?, key = ? WHERE chunk = ?', origin, key, chunk); },
    // What this person keeps on `origin`, oldest first: chunks, and files kept whole before chunks (no spans).
    heldOn(origin, limit) {
      return {
        chunks: all('SELECT chunk, byte_length, origin, key FROM namespace_chunks WHERE origin = ? ORDER BY stored_at LIMIT ?', origin, limit),
        whole_files: all(`SELECT identity FROM (
          SELECT identity, stored_at AS age FROM namespace_files WHERE origin = ? AND spans = 0
          UNION SELECT m.identity, m.started_at AS age FROM namespace_moves m WHERE m.cleanup_pending = 1 AND m.from_origin = ?
        ) ORDER BY age, identity LIMIT ?`, origin, origin, limit).map(row => row.identity),
      };
    },
    // Whether this person keeps anything on any of these origins.
    holdsAnyOn(origins) {
      const list = JSON.stringify(origins);
      return Boolean(one('SELECT 1 AS held FROM namespace_chunks WHERE origin IN (SELECT value FROM json_each(?)) LIMIT 1', list) ?? one('SELECT 1 AS held FROM namespace_files WHERE origin IN (SELECT value FROM json_each(?)) AND spans = 0 LIMIT 1', list));
    },
    // Distinct chunks of a file kept somewhere other than `origin`, a page at a time.
    chunksOf(file, origin, limit) {
      return all('SELECT DISTINCT c.chunk, c.byte_length, c.origin, c.key FROM namespace_spans s JOIN namespace_chunks c ON c.chunk = s.chunk WHERE s.file = ? AND c.origin != ? LIMIT ?', file, origin, limit);
    },
    setOrigin(identity, origin) { sql.exec('UPDATE namespace_files SET origin = ?, checked_at = ? WHERE identity = ?', origin, now(), identity); return fileRow(identity); },
    startGrowing(growing, nameUpdate = null, intentNames = []) {
      sql.exec('INSERT INTO namespace_growing (growing, byte_length, media_type, origin, started_at, aliases, app, length_open) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', growing.growing, growing.length_open ? 0 : growing.byte_length, growing.media_type, growing.origin, now(), JSON.stringify(growing.aliases ?? []), growing.app ?? null, growing.length_open ? 1 : 0);
      // The provisional name and the upload are one account change. A folder move cannot slip between creating the
      // upload and seeing its name, then let a late sender recreate the old folder after the move.
      const named = nameUpdate ? this.putNames([{ ...nameUpdate, identity: growing.growing, byte_length: growing.length_open ? null : growing.byte_length }]) : null;
      for (const name of intentNames) sql.exec('INSERT INTO namespace_name_intents (upload, name) VALUES (?, ?)', growing.growing, name);
      return { file: growingRow(growing.growing), unnamed_uploads: named?.unnamed_uploads ?? [] };
    },
    growing(identity) { return one('SELECT * FROM namespace_growing WHERE growing = ?', identity); },
    // Of these file identities, the ones this person already holds as a file (or a single chunk of the same bytes).
    // Which of these identities are held, whole or as one stored chunk, each with its length: [{ identity, byte_length }].
    wholeFilesHeld(identities) {
      const list = JSON.stringify(identities);
      const held = new Map();
      for (const row of all('SELECT identity, byte_length FROM namespace_files WHERE identity IN (SELECT value FROM json_each(?))', list)) held.set(row.identity, row.byte_length);
      for (const row of all('SELECT chunk AS identity, byte_length FROM namespace_chunks WHERE chunk IN (SELECT value FROM json_each(?))', list)) if (!held.has(row.identity)) held.set(row.identity, row.byte_length);
      return [...held].map(([identity, byte_length]) => ({ identity, byte_length }));
    },
    // Whole files that each fit in one chunk, kept in one step: the chunk (already stored where `origin`/`key` say, or
    // held before), the file made of that one chunk, its aliases and its name. A file already held is only named.
    keepWholeFiles(files, onArrivalWork = null) {
      const at = now();
      const again = [];
      const changed = new Set();
      const inserted = new Set();
      const distinctIdentities = [...new Set(files.map(file => file.identity))];
      const heldFiles = new Map(), heldChunks = new Map();
      for (let start = 0; start < distinctIdentities.length; start += 128) {
        const page = distinctIdentities.slice(start, start + 128);
        for (const row of all(`SELECT f.identity, f.arrival_revision, f.arrival_completed_revision, f.prefix_identity, c.chunk, c.origin
          FROM json_each(?) AS requested LEFT JOIN namespace_files f ON f.identity = requested.value LEFT JOIN namespace_chunks c ON c.chunk = requested.value LIMIT ?`, JSON.stringify(page), page.length)) {
          if (row.identity !== null) heldFiles.set(row.identity, row);
          if (row.chunk !== null) heldChunks.set(row.chunk, row);
        }
      }
      for (const file of files) {
        if (file.key && !heldChunks.has(file.identity) && sql.exec('INSERT INTO namespace_chunks (chunk, byte_length, origin, key, stored_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chunk) DO NOTHING RETURNING 1', file.identity, file.byte_length, file.origin, file.key, at).toArray().length) {
          changed.add(file.identity);
          heldChunks.set(file.identity, { chunk: file.identity, origin: file.origin });
        }
        const held = heldFiles.get(file.identity);
        if (!held) {
          const chunk = heldChunks.get(file.identity);
          // Held when the sender asked, its bytes were given back since (src/namespace-byte-release.mjs): send it again.
          if (!chunk) { again.push(file.identity); continue; }
          const revision = crypto.randomUUID();
          sql.exec("INSERT INTO namespace_files (identity, byte_length, media_type, origin, key, part_bytes, stored_at, checked_at, checked_part, spans, prefix_identity, arrival_revision) VALUES (?, ?, ?, ?, '', 0, ?, ?, NULL, 1, ?, ?)", file.identity, file.byte_length, file.media_type ?? null, chunk.origin, at, at, file.prefix_identity ?? null, revision);
          inserted.add(file.identity);
          sql.exec('INSERT INTO namespace_spans (file, ordinal, offset, length, chunk) VALUES (?, 0, 0, ?, ?) ON CONFLICT(file, ordinal) DO NOTHING', file.identity, file.byte_length, file.identity);
          heldFiles.set(file.identity, { identity: file.identity, arrival_revision: revision, arrival_completed_revision: null, prefix_identity: file.prefix_identity ?? null });
          changed.add(file.identity);
        } else {
          // Earlier files have no completion token. Process their first accepted retry.
          if (held.arrival_revision === null) changed.add(file.identity);
          if (file.prefix_identity && held.prefix_identity === null && sql.exec('UPDATE namespace_files SET prefix_identity = ? WHERE identity = ? AND prefix_identity IS NULL RETURNING 1', file.prefix_identity, file.identity).toArray().length) {
            held.prefix_identity = file.prefix_identity;
            changed.add(file.identity);
          }
        }
        for (const alias of file.aliases ?? []) if (alias !== file.identity && sql.exec("INSERT INTO namespace_aliases (alias, identity, grade, added_at) VALUES (?, ?, 'checked', ?) ON CONFLICT(alias) DO NOTHING RETURNING 1", alias, file.identity, at).toArray().length) changed.add(file.identity);
      }
      const accepted = files.filter(file => !again.includes(file.identity));
      this.putNames(accepted.filter(file => file.name).map(file => ({ name: file.name, identity: file.identity, byte_length: file.byte_length, modified_at_ms: file.modified_at_ms })), identity => changed.add(identity));
      // One fresh token per changed file fences a later completion, including delete/recreate races.
      for (const identity of changed) {
        // The new file's token already covers all changes in this synchronous owner transaction.
        if (inserted.has(identity)) continue;
        const revision = crypto.randomUUID();
        sql.exec('UPDATE namespace_files SET arrival_revision = ? WHERE identity = ?', revision, identity);
        const held = heldFiles.get(identity);
        if (held) held.arrival_revision = revision;
      }
      if (onArrivalWork && accepted.length) onArrivalWork([...new Set(accepted.map(file => file.identity))]
        .map(identity => heldFiles.get(identity))
        .filter(row => row && row.arrival_revision !== row.arrival_completed_revision)
        .map(({ identity, arrival_revision }) => ({ identity, arrival_revision })));
      return { kept: files.length - again.length, again };
    },
    completeWholeFileArrivals(arrivals) {
      for (const { identity, arrival_revision } of arrivals) sql.exec(`UPDATE namespace_files SET arrival_completed_revision = ?
        WHERE identity = ? AND arrival_revision = ? AND arrival_completed_revision IS NOT ?`,
      arrival_revision, identity, arrival_revision, arrival_revision);
    },
    // Uploads not finished yet, oldest first, each with how much of it arrived and what it is called.
    unfinishedGrowing() {
      return all('SELECT growing, byte_length, new_bytes, origin, started_at, app FROM namespace_growing WHERE finished IS NULL ORDER BY started_at')
        .map(row => ({ ...row, names: all('SELECT name FROM (SELECT name FROM namespace_names WHERE identity = ?1 LIMIT 20) UNION SELECT name FROM (SELECT name FROM namespace_names_promised WHERE upload = ?1 LIMIT 20) UNION SELECT name FROM (SELECT name FROM namespace_name_intents WHERE upload = ?1 LIMIT 20) LIMIT 20', row.growing).map(item => item.name) }));
    },
    // Stop an upload: its description, the reads waiting on it and the names pointing at it go; chunks already stored
    // stay (another upload of the same file skips them). Answers the room it still held, to give back.
    cancelGrowing(file) {
      const growing = one('SELECT byte_length, new_bytes, origin, length_open FROM namespace_growing WHERE growing = ? AND finished IS NULL', file);
      if (!growing) return { error: 'This upload is not open.' };
      sql.exec('DELETE FROM namespace_spans WHERE file = ?', file);
      sql.exec('DELETE FROM namespace_span_waits WHERE file = ?', file);
      sql.exec('DELETE FROM namespace_demands WHERE growing = ?', file);
      // Names promised to it stay with the kept files that have them; names it was given go.
      sql.exec('DELETE FROM namespace_names_promised WHERE upload = ?', file);
      sql.exec('DELETE FROM namespace_name_intents WHERE upload = ?', file);
      const names = sql.exec('DELETE FROM namespace_names WHERE identity = ? RETURNING 1', file).toArray().length;
      if (names) readNamesAgain(sql);
      sql.exec("UPDATE namespace_growing SET finished = 'cancelled' WHERE growing = ?", file);
      return { cancelled: file, names_removed: names, unused_room: growing.length_open ? 0 : Math.max(0, growing.byte_length - growing.new_bytes), origin: growing.origin };
    },
    // Add the next spans of a growing file. They must continue exactly where the last one ended and stay inside the
    // declared size; a file whose length is not known yet grows to where they end. Returns the ordinals whose chunks
    // this person does not hold yet.
    addSpans(file, spans) {
      const growing = one('SELECT byte_length, length_open FROM namespace_growing WHERE growing = ? AND finished IS NULL', file);
      if (!growing) return { error: 'This upload is not open.' };
      const last = one('SELECT ordinal, offset, length FROM namespace_spans WHERE file = ? ORDER BY ordinal DESC LIMIT 1', file);
      const first = last ? last.ordinal + 1 : 0;
      let ordinal = first, offset = last ? last.offset + last.length : 0;
      // Spans sent again are read in one statement, by their ordinals: the request's own size, never one lookup a span.
      // reads-ok: only the ordinals the request names (at most MAX_SPANS_PER_REQUEST), each by the primary key; `offset` is a column
      const again = new Map(all('SELECT s.ordinal, s.offset, s.chunk FROM namespace_spans s WHERE s.file = ?1 AND s.ordinal IN (SELECT value FROM json_each(?2))', file, JSON.stringify(spans.filter(span => span.ordinal < first).map(span => span.ordinal))).map(row => [row.ordinal, row]));
      const described = [];
      let refused = null;
      for (const span of spans) {
        // A span sent again is the same span: sent with other bytes, it is refused, never quietly left as it was.
        if (span.ordinal < ordinal) {
          const kept = again.get(span.ordinal) ?? described[span.ordinal - first];
          if (kept && (kept.chunk !== span.chunk || kept.offset !== span.offset)) { refused = `Piece ${span.ordinal} was already sent with other bytes. Send this file as a new upload (start again), or send piece ${ordinal} next, starting at byte ${offset}.`; break; }
          continue;
        }
        if (span.ordinal !== ordinal || span.offset !== offset) { refused = `Chunk ${span.ordinal} must start at ${offset} as number ${ordinal}.`; break; }
        if (!growing.length_open && offset + span.length > growing.byte_length) { refused = 'These chunks run past the size of the file.'; break; }
        described.push(span);
        ordinal += 1; offset += span.length;
      }
      // One chunk lookup for the whole request: the spans written and the answer's `needed` both come from it.
      const heldNow = chunksHeld([...new Set(spans.map(span => span.chunk))]);
      // Spans written are counted even when a later span in the request is refused. Those whose chunk is already held
      // are stored bytes from the moment they are described; for the rest, the bytes wait on the chunk (chunkArrived).
      const waiting = new Map();
      let heldBytes = 0;
      for (const span of described) {
        if (heldNow.has(span.chunk)) heldBytes += span.length;
        else waiting.set(span.chunk, (waiting.get(span.chunk) ?? 0) + span.length);
      }
      // The rows go in a statement for each SPANS_PER_STATEMENT spans, as one JSON value (the store limits bound values).
      for (let at = 0; at < described.length; at += SPANS_PER_STATEMENT) {
        sql.exec(`INSERT INTO namespace_spans (file, ordinal, offset, length, chunk) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?2)`, file, JSON.stringify(described.slice(at, at + SPANS_PER_STATEMENT).map(span => [span.ordinal, span.offset, span.length, span.chunk])));
      }
      for (const entries = [...waiting]; entries.length;) {
        sql.exec(`INSERT INTO namespace_span_waits (file, chunk, length) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2) WHERE true ON CONFLICT(file, chunk) DO UPDATE SET length = length + excluded.length`, file, JSON.stringify(entries.splice(0, SPANS_PER_STATEMENT)));
      }
      sql.exec('UPDATE namespace_growing SET spans_described = ?, bytes_held = bytes_held + ? WHERE growing = ?', ordinal, heldBytes, file);
      if (refused) return { error: refused };
      if (growing.length_open && offset > growing.byte_length) sql.exec('UPDATE namespace_growing SET byte_length = ? WHERE growing = ?', offset, file);
      return { needed: spans.filter(span => !heldNow.has(span.chunk)).map(span => span.ordinal), spans_recorded: ordinal, bytes_described: offset };
    },
    // The spans of a file covering start..end (inclusive), each with where its chunk is kept, or `stored: false`
    // when its chunk has not arrived yet.
    spans(file, start, end, limit = 64) {
      // The span holding `start`; none when the file is not described that far yet (the last span ends before it).
      const first = one('SELECT ordinal, offset, length FROM namespace_spans WHERE file = ? AND offset <= ? ORDER BY offset DESC LIMIT 1', file, start);
      if (!first || first.offset + first.length <= start) return [];
      return all('SELECT s.ordinal, s.offset, s.length, s.chunk, c.origin, c.key FROM namespace_spans s LEFT JOIN namespace_chunks c ON c.chunk = s.chunk WHERE s.file = ? AND s.ordinal >= ? AND s.offset <= ? ORDER BY s.ordinal LIMIT ?', file, first.ordinal, end, limit)
        .map(row => ({ ...row, stored: row.key !== null }));
    },
    demand(file, ordinals) {
      for (const ordinal of ordinals) sql.exec('INSERT INTO namespace_demands (growing, ordinal, asked_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', file, ordinal, now());
    },
    demands(file) {
      return all('SELECT d.ordinal FROM namespace_demands d JOIN namespace_spans s ON s.file = d.growing AND s.ordinal = d.ordinal LEFT JOIN namespace_chunks c ON c.chunk = s.chunk WHERE d.growing = ? AND c.chunk IS NULL ORDER BY d.asked_at LIMIT 64', file).map(row => row.ordinal);
    },
    // How much of a growing file its chunks describe, and how many of those chunks have not arrived yet.
    described(file) { return describedOf(file); },
    // How far a growing file's spans reach, by its last span alone: spans run on from byte 0 with no gap (addSpans), so the
    // count and the end of the last span are the whole answer. For a sender asking where to continue, once per request.
    reach(file) {
      // reads-ok: the last span of the file by its key, one row; `offset` here is a column, not paging
      const last = one('SELECT ordinal, offset, length FROM namespace_spans WHERE file = ? ORDER BY ordinal DESC LIMIT 1', file);
      return { spans: last ? last.ordinal + 1 : 0, bytes: last ? last.offset + last.length : 0 };
    },
    // Every chunk arrived: the growing file becomes a file under its content identity. Its names and its provisional
    // identity (kept as an alias) move with it. A file this person already holds under that identity keeps its row.
    // `byteLength`, when the sender gives it, is the length it read: a file whose length was open is fixed at it.
    finishGrowing(file, identity, grade, byteLength = null, prefixIdentity = null, nameUpdate = null) {
      const growing = one('SELECT * FROM namespace_growing WHERE growing = ? AND finished IS NULL', file);
      if (!growing) return { error: 'This upload is not open.' };
      const described = describedOf(file);
      if (described.bytes !== growing.byte_length) return { error: `The chunks describe ${described.bytes} of ${growing.byte_length} bytes.` };
      if (byteLength !== null && byteLength !== described.bytes) return { error: `The chunks describe ${described.bytes} bytes, not the ${byteLength} this file has.` };
      if (described.missing) return { error: `${described.missing} chunks have not arrived yet.`, missing: described.missing };
      const at = now();
      if (one('SELECT identity FROM namespace_files WHERE identity = ?', identity)) {
        sql.exec('DELETE FROM namespace_spans WHERE file = ?', file);
        if (prefixIdentity) sql.exec('UPDATE namespace_files SET prefix_identity = ? WHERE identity = ? AND prefix_identity IS NULL', prefixIdentity, identity);
      }
      else {
        sql.exec('UPDATE namespace_spans SET file = ? WHERE file = ?', identity, file);
        sql.exec("INSERT INTO namespace_files (identity, byte_length, media_type, origin, key, part_bytes, stored_at, checked_at, checked_part, spans, prefix_identity) VALUES (?, ?, ?, ?, '', 0, ?, ?, NULL, ?, ?)", identity, growing.byte_length, growing.media_type, growing.origin, at, at, described.spans, prefixIdentity);
      }
      for (const alias of [file, ...JSON.parse(growing.aliases)]) sql.exec('INSERT INTO namespace_aliases (alias, identity, grade, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias) DO NOTHING', alias, identity, grade, at);
      sql.exec('UPDATE namespace_names SET identity = ?, byte_length = ? WHERE identity = ?', identity, growing.byte_length, file);
      // Each name promised to it moves to it now from the kept file that held it meanwhile (a name the person took away
      // since stays away).
      sql.exec(`UPDATE namespace_names SET identity = ?, byte_length = ?, named_at = ?
        WHERE name IN (SELECT name FROM namespace_names_promised WHERE upload = ?)`, identity, growing.byte_length, at, file);
      sql.exec('DELETE FROM namespace_names_promised WHERE upload = ?', file);
      sql.exec('UPDATE namespace_growing SET finished = ?, length_open = 0 WHERE growing = ?', identity, file);
      sql.exec('DELETE FROM namespace_demands WHERE growing = ?', file);
      sql.exec('DELETE FROM namespace_span_waits WHERE file = ?', file);
      // A finished file may claim several names together, including removing its old name after a move. The
      // conditional name checks happen before any name changes; losing bytes remain addressable by identity.
      const updates = nameUpdate ? (Array.isArray(nameUpdate) ? nameUpdate : [nameUpdate]) : [];
      const named = updates.length ? this.putNames(updates.map(item => item.remove === true
        ? { ...item, remove: true }
        : { ...item, identity, byte_length: growing.byte_length })) : null;
      sql.exec('DELETE FROM namespace_name_intents WHERE upload = ?', file);
      // A file whose length was open claimed its room chunk by chunk, so none is left over to give back.
      return { file: fileRow(identity), ...(named?.conflicts?.length ? { conflicts: named.conflicts } : {}), unused_room: growing.length_open ? 0 : growing.byte_length - growing.new_bytes, origin: growing.origin, app: growing.app ?? null };
    },
    // Only the Worker calls this after checking the first stored chunk's BLAKE3.
    // The existing file identity and first span must still be current before a
    // legacy file's bounded prefix becomes durable metadata.
    rememberPrefix(identity, prefixIdentity, firstChunk) {
      if (!/^1f:[0-9a-f]{64}$/.test(identity ?? '') || !/^1f:[0-9a-f]{64}$/.test(prefixIdentity ?? '')
        || !/^1f:[0-9a-f]{64}$/.test(firstChunk ?? '')) return false;
      const row = one('SELECT prefix_identity FROM namespace_files WHERE identity = ?', identity);
      const first = one('SELECT offset, length, chunk FROM namespace_spans WHERE file = ? ORDER BY ordinal LIMIT 1', identity);
      if (!row || first?.offset !== 0 || first.chunk !== firstChunk || first.length < 1024 * 1024) return false;
      if (row.prefix_identity) return row.prefix_identity === prefixIdentity;
      sql.exec('UPDATE namespace_files SET prefix_identity = ? WHERE identity = ? AND prefix_identity IS NULL', prefixIdentity, identity);
      return true;
    },
    // In-progress destination uploads and completed moves whose source cleanup still holds room, read by identity page.
    movesInProgress(after = '', limit = 100) {
      const count = Math.min(100, Math.max(1, Math.floor(Number(limit) || 100)));
      return all(`SELECT m.identity, m.to_origin AS origin, m.to_key AS key, m.upload_id,
        COALESCE(m.byte_length, f.byte_length) AS byte_length, m.from_origin, m.from_key, m.cleanup_pending
        FROM namespace_moves m JOIN namespace_files f ON f.identity = m.identity
        WHERE m.identity > ? ORDER BY m.identity LIMIT ?`, after, count);
    },
    // Uploads an earlier version began and never finished: each is cancelled where it is kept, then forgotten.
    unfinishedUploads() { return all('SELECT upload_id, origin, key, byte_length FROM namespace_unfinished_uploads'); },
    forgetUnfinishedUpload(uploadId) { sql.exec('DELETE FROM namespace_unfinished_uploads WHERE upload_id = ?', uploadId); },
    nameCountsFillStep: nameCounts.fillStep,
    clear() {
      for (const table of ['namespace_unfinished_uploads', 'namespace_files', 'namespace_aliases', 'namespace_names', 'namespace_name_intents', 'namespace_secrets', 'namespace_moves', 'namespace_move_parts', 'namespace_move_receipts', 'namespace_chunks', 'namespace_spans', 'namespace_span_waits', 'namespace_growing', 'namespace_demands', 'namespace_set_aside', 'namespace_set_aside_names']) sql.exec(`DELETE FROM ${table}`);
      sql.exec('DELETE FROM namespace_summary_origins');
      sql.exec('DELETE FROM namespace_summary_counts');
      nameCounts.reset();
      readNamesAgain(sql);
    },
  };
}
