// A per-person seek index of namespace names eligible for Media. It holds no bytes, posters or joined facts.
import filePreviews from './workspace/file-previews.json' with { type: 'json' };

const ready = new WeakMap();
const MAX_BACKFILL_NAMES = 10_000;
const RULE = 'specific-content-type-else-named-extension';
const WEBM_RULE = 'specific-content-type-else-named-extension-with-webm-tracks';
const needsWebmRule = config => config.media_families.includes('audio') !== config.media_families.includes('video');
const choiceOf = config => JSON.stringify([
  needsWebmRule(config) ? WEBM_RULE : RULE,
  config.media_families, filePreviews.families_by_extension,
]);
const extensionRows = '(SELECT extension AS key, family AS value FROM media_library_extensions)';
const familyRows = '(SELECT family AS value FROM media_library_families)';
// Measured WebM tracks can correct an audio/video sender label. Admit either WebM family here and let the Media
// projection apply the measured facts, so a later facts edit cannot make a needed candidate disappear.
export const mediaNameEligibleSql = (name, file, extensions = extensionRows, families = familyRows) => `(
  (CASE WHEN ${file}.media_type IS NOT NULL AND ${file}.media_type NOT IN ('', 'application/octet-stream')
      AND instr(${file}.media_type, '/') > 0 THEN substr(${file}.media_type, 1, instr(${file}.media_type, '/') - 1)
    ELSE (SELECT e.value FROM ${extensions} e
      WHERE substr(lower(${name}.name), -length(e.key) - 1) = '.' || e.key LIMIT 1)
  END) IN (SELECT value FROM ${families})
  OR ((lower(${file}.media_type) IN ('audio/webm', 'video/webm')
      OR lower(${file}.media_type) LIKE 'audio/webm;%' OR lower(${file}.media_type) LIKE 'video/webm;%')
    AND EXISTS (SELECT 1 FROM ${families} WHERE value IN ('audio', 'video'))))`;
const insertNames = (where, conflict = 'REPLACE') => `INSERT OR ${conflict} INTO media_library_name_candidates (name, identity, collection, sort_ms)
  SELECT n.name, n.identity, n.collection, COALESCE(n.modified_at_ms, -1)
  FROM namespace_names n
  LEFT JOIN namespace_aliases a ON a.alias = n.identity
  LEFT JOIN namespace_files f ON f.identity = coalesce(a.identity, n.identity)
  WHERE (${where}) AND n.identity IS NOT NULL
    AND ${mediaNameEligibleSql('n', 'f')}`;
const refreshNames = where => `DELETE FROM media_library_name_candidates
  WHERE name IN (SELECT n.name FROM namespace_names n WHERE ${where}); ${insertNames(where)};`;

const triggers = [
  ['name_insert', 'AFTER INSERT ON namespace_names', `${insertNames('n.name = NEW.name')};`],
  ['name_update', 'AFTER UPDATE ON namespace_names', `DELETE FROM media_library_name_candidates WHERE name = OLD.name; ${insertNames('n.name = NEW.name')};`],
  ['name_delete', 'AFTER DELETE ON namespace_names', 'DELETE FROM media_library_name_candidates WHERE name = OLD.name;'],
  ['file_insert', 'AFTER INSERT ON namespace_files', refreshNames('n.identity = NEW.identity OR n.identity IN (SELECT alias FROM namespace_aliases WHERE identity = NEW.identity)')],
  ['file_update', 'AFTER UPDATE OF identity, media_type ON namespace_files', refreshNames('n.identity IN (OLD.identity, NEW.identity) OR n.identity IN (SELECT alias FROM namespace_aliases WHERE identity IN (OLD.identity, NEW.identity))')],
  ['file_delete', 'AFTER DELETE ON namespace_files', refreshNames('n.identity = OLD.identity OR n.identity IN (SELECT alias FROM namespace_aliases WHERE identity = OLD.identity)')],
  ['alias_insert', 'AFTER INSERT ON namespace_aliases', refreshNames('n.identity = NEW.alias')],
  ['alias_update', 'AFTER UPDATE ON namespace_aliases', refreshNames('n.identity IN (OLD.alias, NEW.alias)')],
  ['alias_delete', 'AFTER DELETE ON namespace_aliases', refreshNames('n.identity = OLD.alias')],
];

function installTriggers(sql, replace = false) {
  for (const [name, event, body] of triggers) {
    if (replace) sql.exec(`DROP TRIGGER IF EXISTS media_library_candidate_${name}`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS media_library_candidate_${name} ${event} BEGIN ${body} END`);
  }
}

function install(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS media_library_name_candidates (
    name TEXT PRIMARY KEY, identity TEXT NOT NULL, collection TEXT NOT NULL, sort_ms INTEGER NOT NULL)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS media_library_name_candidates_recent
    ON media_library_name_candidates (sort_ms DESC, identity DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS media_library_name_candidates_identity
    ON media_library_name_candidates (identity, name)`);
  sql.exec('CREATE TABLE IF NOT EXISTS media_library_extensions (extension TEXT PRIMARY KEY, family TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS media_library_families (family TEXT PRIMARY KEY)');
  sql.exec(`CREATE TABLE IF NOT EXISTS media_library_name_index_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), choice TEXT NOT NULL, after_name TEXT, ready INTEGER NOT NULL)`);
  installTriggers(sql);
}

/** Whether a started index still has work for the account's one scheduler. */
export function mediaNameIndexPending(sql, config) {
  let state;
  try {
    state = sql.exec('SELECT choice, ready FROM media_library_name_index_state WHERE id = 1').toArray()[0];
  } catch (error) {
    if (!/no such table: media_library_name_index_state/.test(String(error))) throw error;
    return false;
  }
  if (!state) return false;
  const choice = choiceOf(config);
  return state.ready !== 1 || state.choice !== choice;
}

/** Install direct-write triggers, then optionally advance one bounded historical batch. */
export function ensureMediaNameIndex(sql, config, { advance = true } = {}) {
  const choice = choiceOf(config);
  const cached = ready.get(sql);
  if (!cached) install(sql);
  let state;
  try {
    state = sql.exec('SELECT choice, after_name, ready FROM media_library_name_index_state WHERE id = 1').toArray()[0];
  } catch (error) {
    if (!/no such table: media_library_name_index_state/.test(String(error))) throw error;
    // A transaction may roll back initial DDL after this connection's readiness cache was filled.
    install(sql);
  }
  // A DATA change can retire many old candidates. Keep the legacy reader on the page and reset on the alarm.
  if (state && state.choice !== choice && !advance) {
    ready.set(sql, { choice, complete: false });
    return false;
  }
  const starting = !state;
  if (!state || state.choice !== choice) {
    // Keep one durable pending row before retiring anything. -1 means the old candidates and matching rules are
    // being retired; an interrupted wake resumes here even if the choice changes again.
    if (state) sql.exec('UPDATE media_library_name_index_state SET choice = ?, after_name = NULL, ready = -1 WHERE id = 1', choice);
    else sql.exec('INSERT INTO media_library_name_index_state (id, choice, after_name, ready) VALUES (1, ?, NULL, -1)', choice);
    state = { choice, after_name: null, ready: -1 };
  }
  if (state.ready === -1 && !advance && !starting) {
    ready.set(sql, { choice, complete: false });
    return false;
  }
  const count = Number(config.candidate_index_backfill_names_per_wake ?? config.candidate_index_backfill_names_per_read ?? MAX_BACKFILL_NAMES);
  if (!Number.isInteger(count) || count < 1 || count > MAX_BACKFILL_NAMES) throw new Error('Media index backfill size must be 1 to 10,000 names.');
  if (state.ready === -1) {
    // A DATA change may leave millions of old candidates. One wake deletes no more than count, then yields before
    // rebuilding. Direct writes can still use the old rules until the retirement is complete.
    if (sql.exec('SELECT 1 FROM media_library_name_candidates LIMIT 1').toArray().length) {
      if (!advance) {
        ready.set(sql, { choice, complete: false });
        return false;
      }
      sql.exec('DELETE FROM media_library_name_candidates WHERE name IN (SELECT name FROM media_library_name_candidates ORDER BY name LIMIT ?)', count);
      ready.set(sql, { choice, complete: false });
      return false;
    }
    // Existing stores have trigger bodies from the earlier candidate rule. Replace them only after the old
    // candidates are gone; an interrupted replacement stays pending and the historical scan repairs missed writes.
    if (!starting && needsWebmRule(config)) installTriggers(sql, true);
    // Every rule change is retryable while ready is -1. Set ready to 0 only after all rules match this choice.
    sql.exec('DELETE FROM media_library_extensions');
    sql.exec('DELETE FROM media_library_families');
    const admittedExtensions = Object.fromEntries(Object.entries(filePreviews.families_by_extension)
      .filter(([, familyName]) => config.media_families.includes(familyName)));
    sql.exec('INSERT INTO media_library_extensions (extension, family) SELECT key, value FROM json_each(?)', JSON.stringify(admittedExtensions));
    sql.exec('INSERT INTO media_library_families (family) SELECT value FROM json_each(?)', JSON.stringify(config.media_families));
    sql.exec('UPDATE media_library_name_index_state SET after_name = NULL, ready = 0 WHERE id = 1');
    state = { choice, after_name: null, ready: 0 };
  }
  if (state.ready === 1) {
    ready.set(sql, { choice, complete: true });
    return true;
  }
  if (!advance) {
    ready.set(sql, { choice, complete: false });
    return false;
  }
  const names = sql.exec('SELECT name FROM namespace_names WHERE name > ? ORDER BY name LIMIT ?', state.after_name ?? '', count + 1).toArray();
  const batch = names.slice(0, count);
  if (batch.length) {
    // Direct-write triggers may already hold a newer value for a name in this older slice.
    sql.exec(insertNames('n.name > ? AND n.name <= ?', 'IGNORE'), state.after_name ?? '', batch.at(-1).name);
    sql.exec('UPDATE media_library_name_index_state SET after_name = ? WHERE id = 1', batch.at(-1).name);
  }
  if (names.length <= count) {
    // The old page cursor must reset when a complete index changes the candidate ordering.
    sql.exec('UPDATE media_library_change SET changed = changed + 1 WHERE id = 1');
    sql.exec('UPDATE media_library_name_index_state SET ready = 1 WHERE id = 1');
    ready.set(sql, { choice, complete: true });
    return true;
  }
  ready.set(sql, { choice, complete: false });
  return false;
}
