// src/namespace-set-aside.mjs
//
// PURPOSE
//   Recently Deleted and Archived for a person's files: deleting or archiving a file, a folder or a recording takes its
//   names out of the namespace (src/namespace-store.mjs namespace_names) and keeps them here, with when and by whom, so
//   Put back gives every name back exactly as it was. Each state keeps what it holds for a number of days (the person's
//   keep-for, else the DATA default in namespace-set-aside.json); when that time ends the store's alarm
//   (src/scheduler.mjs, through src/person-store.mjs) moves it on: an archived file moves to Recently Deleted, and a
//   deleted one's names are gone for good. The web port of the Mac app's media-lifecycle.mjs.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here deletes bytes. A name taken away leaves its file reachable by its identity, as `remove: true` does.
//      When a file's names are gone for good, `onGone` is told its identities; src/namespace-byte-release.mjs gives
//      back its storage once nothing else keeps it.
//   2. What each state is called, how long it keeps things by default and what it becomes when its time ends is DATA
//      (namespace-set-aside.json `states`, `when_due`: another state's id, or null for gone for good). This file names
//      no state.
//   3. The time left is worked out when read, never stored: changing keep-for relabels every row at once, and the
//      sweep reads the same arithmetic (`dueAt`) the rows show, so what a row says is what the sweep does.
//   4. `after_days: null` means keep until put back; such a row is never due.
//   5. A file still uploading is never set aside (its upload would lose its only name mid-way); a name that another
//      file took in the meantime is never overwritten by Put back.
//   6. Set-based SQL: a folder of any size is set aside, put back or swept in a few statements, never a row loop.
//
// KEY CONCEPTS
//   item      one thing the person deleted or archived: { id, label, place (the name asked for, null for an identity),
//             state, folder, set_aside_ms, by }
//   names     the names it took away (namespace_set_aside_names); a row with name null marks a file set aside by its
//             identity, so Media and search leave it out even when no name pointed at it
//   hidden    an identity that is set aside and has no name left anywhere (hiddenAmong): Media and search skip it
//
import defaults from './namespace-set-aside.json' with { type: 'json' };
import { checkCarried } from './carry-tables-into-records.mjs';
import { readNamesAgain } from './namespace-view.mjs';
import { folderRevisionOf } from './namespace-store.mjs';

const DAY_MS = 86400000;
const parentOf = name => name.replace(/\/[^/]+\/?$/, '') || '/';
const baseOf = name => name.slice(name.lastIndexOf('/') + 1) || name;
const IDENTITY = /^(1f|12):[0-9a-f]{64}$/;

/** Of these identities, the ones set aside (by themselves or as another identity of the same file) with no name left
 *  pointing at that file. */
export function hiddenAmong(sql, identities) {
  const asked = [...new Set(identities.filter(Boolean))];
  if (!asked.length) return new Set();
  // Peek at no more archive names than requested identities, plus one. DISTINCT would still walk every duplicate
  // archive name to reach the next identity, so a many-named archived file could make a one-file page scan them all.
  const firstSetAside = sql.exec('SELECT identity FROM namespace_set_aside_names WHERE identity IS NOT NULL LIMIT ?',
    asked.length + 1).toArray().map(row => row.identity);
  if (!firstSetAside.length) return new Set();

  // Resolve an alias to its file, then all sibling aliases of that file. Looking only one edge away misses a file
  // archived under one drive alias when the caller asks under another drive alias.
  const sameFileOf = ids => {
    const roots = new Map(ids.map(id => [id, id]));
    for (const { alias, identity } of sql.exec(`SELECT alias, identity FROM namespace_aliases
      WHERE alias IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).toArray()) roots.set(alias, identity);
    const groups = new Map([...new Set(roots.values())].map(id => [id, new Set([id])]));
    for (const { alias, identity } of sql.exec(`SELECT alias, identity FROM namespace_aliases
      WHERE identity IN (SELECT value FROM json_each(?))`, JSON.stringify([...groups.keys()])).toArray()) groups.get(identity).add(alias);
    return new Map(ids.map(id => [id, groups.get(roots.get(id))]));
  };
  const allFamilyIds = families => [...new Set([...families.values()].flatMap(ids => [...ids]))];

  let candidates;
  let sameFile;
  if (firstSetAside.length <= asked.length) {
    const setAsideFiles = new Set(allFamilyIds(sameFileOf(firstSetAside)));
    candidates = asked.filter(id => setAsideFiles.has(id));
    if (!candidates.length) return new Set();
    sameFile = sameFileOf(candidates);
  } else {
    sameFile = sameFileOf(asked);
    const setAside = new Set(sql.exec(`SELECT DISTINCT identity FROM namespace_set_aside_names
      WHERE identity IN (SELECT value FROM json_each(?))`, JSON.stringify(allFamilyIds(sameFile))).toArray().map(row => row.identity));
    candidates = asked.filter(id => [...sameFile.get(id)].some(member => setAside.has(member)));
    if (!candidates.length) return new Set();
  }
  const named = new Set(sql.exec('SELECT DISTINCT identity FROM namespace_names WHERE identity IN (SELECT value FROM json_each(?))',
    JSON.stringify(allFamilyIds(sameFile))).toArray().map(row => row.identity));
  return new Set(candidates.filter(id => ![...sameFile.get(id)].some(member => named.has(member))));
}

/**
 * sql:      the person's store (the namespace tables already exist, src/namespace-store.mjs)
 * keepFor:  the person's keep-for choice as one EEAF setting ({ read() → { <state>: days | null } | null, write(value) })
 * settings: namespace-set-aside.json (tests pass their own)
 * now:      epoch ms
 */
export function setAsideStore(sql, { keepFor: keptChoice, settings = defaults, now = () => Date.now(), newId = () => crypto.randomUUID(), onGone = () => {} }) {
  const one = (query, ...values) => sql.exec(query, ...values).toArray()[0] ?? null;
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  const stateById = new Map(settings.states.map(state => [state.id, state]));
  const stateOf = id => {
    const state = stateById.get(id);
    if (!state) throw new Error(`Choose one of: ${settings.states.map(row => row.id).join(', ')}.`);
    return state;
  };

  // The person's keep-for days per state; a state they never changed keeps its DATA default.
  const keptFor = () => {
    const saved = keptChoice.read() ?? {};
    return new Map(settings.states.map(state => [state.id, Object.hasOwn(saved, state.id) ? saved[state.id] : state.after_days]));
  };
  const keepFor = () => {
    const days = keptFor();
    return {
      states: settings.states.map(state => ({ id: state.id, label: state.label, after_days: days.get(state.id), default_after_days: state.after_days, when_due: state.when_due, due_words: state.due_words })),
      choices: settings.keep_for_choices,
    };
  };
  const checkDays = value => {
    if (value === null) return null;
    if (!Number.isInteger(value) || value < 0 || value > settings.max_days) throw new Error(`Choose a whole number of days from 0 to ${settings.max_days}, or null to keep until put back.`);
    return value;
  };

  // When one item's time ends: its state's keep-for counted from when it entered that state; null when kept.
  const dueAt = (item, days) => (days.get(item.state) === null || days.get(item.state) === undefined ? null : item.set_aside_ms + days.get(item.state) * DAY_MS);

  const namesOf = (id, limit) => all('SELECT name, identity, byte_length FROM namespace_set_aside_names WHERE id = ? AND name IS NOT NULL ORDER BY ordinal LIMIT ?', id, limit);
  const shown = (item, days = keptFor(), at = now()) => {
    const state = stateOf(item.state);
    const due = dueAt(item, days);
    const totals = one('SELECT count(name) AS names, COALESCE(SUM(CASE WHEN name IS NOT NULL THEN byte_length END), 0) AS bytes FROM namespace_set_aside_names WHERE id = ?', item.id);
    const names = namesOf(item.id, settings.names_shown_per_item);
    const first = names[0] ?? one('SELECT identity FROM namespace_set_aside_names WHERE id = ? ORDER BY ordinal LIMIT 1', item.id);
    return {
      id: item.id, label: item.label, state: item.state, state_label: state.label, folder: Boolean(item.folder),
      set_aside_at: new Date(item.set_aside_ms).toISOString(), by: item.by ?? null,
      names: names.map(row => row.name), name_count: totals.names, byte_length: totals.bytes,
      where: item.place ? parentOf(item.place) : names[0] ? parentOf(names[0].name) : null, identity: first?.identity ?? null,
      after_days: days.get(item.state), due_at: due === null ? null : new Date(due).toISOString(),
      days_left: due === null ? null : Math.max(0, Math.ceil((due - at) / DAY_MS)), due_words: state.due_words,
    };
  };

  // What one asked thing takes away: { label, folder, names: SQL predicate over namespace_names, markers } or a refusal.
  function resolve(asked) {
    if (typeof asked?.name === 'string') {
      const name = asked.name.trim().replace(/\/+$/, '') || '/';
      if (!name.startsWith('/')) return { error: 'A name starts with /.' };
      if (name === '/') return { error: 'Your whole Files cannot be deleted. Choose files or folders inside it.' };
      if (one('SELECT 1 AS named FROM namespace_names WHERE name = ?', name)) return { label: baseOf(name), place: name, folder: false, where: 'name = ?', values: [name], markers: [] };
      if (one('SELECT 1 AS inside FROM namespace_names WHERE name >= ? AND name < ? LIMIT 1', `${name}/`, `${name}0`)) {
        return { label: baseOf(name), place: name, folder: true, where: '(name >= ? AND name < ?)', values: [`${name}/`, `${name}0`], markers: [] };
      }
      return { error: 'No file or folder has this name.' };
    }
    if (typeof asked?.identity === 'string' && IDENTITY.test(asked.identity)) {
      const canonical = one('SELECT identity FROM namespace_aliases WHERE alias = ?', asked.identity)?.identity ?? asked.identity;
      const family = [...new Set([asked.identity, canonical, ...all('SELECT alias FROM namespace_aliases WHERE identity = ?', canonical).map(row => row.alias)])];
      const list = JSON.stringify(family);
      const named = one('SELECT name FROM (SELECT name FROM namespace_names WHERE identity IN (SELECT value FROM json_each(?)) LIMIT 20) ORDER BY name LIMIT 1', list);
      const known = named || one('SELECT 1 AS kept FROM namespace_files WHERE identity IN (SELECT value FROM json_each(?))', list)
        || (one("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'namespace_results'") && one('SELECT 1 AS worked FROM namespace_results WHERE identity IN (SELECT value FROM json_each(?)) LIMIT 1', list));
      if (!known) return { error: 'No file with this identity is in your files.' };
      const label = typeof asked.label === 'string' && asked.label.trim() ? asked.label.trim().slice(0, 200) : named ? baseOf(named.name) : asked.identity;
      return { label, place: null, folder: false, where: 'identity IN (SELECT value FROM json_each(?))', values: [list], markers: family };
    }
    return { error: 'Give a name (starting with /) or a file identity.' };
  }

  /** Take these files, folders or recordings out of view into `state`. Answers { set_aside: [row], refused: [{ asked, error }] }. */
  function setAside({ items, state, by = null }) {
    stateOf(state);
    if (!Array.isArray(items) || !items.length || items.length > settings.items_per_request) throw new Error(`Choose from 1 to ${settings.items_per_request} files or folders.`);
    const at = now();
    const done = [], refused = [];
    for (const asked of items) {
      if (Object.hasOwn(asked ?? {}, 'expected_folder_revision')) {
        const name = typeof asked.name === 'string' ? asked.name.trim().replace(/\/+$/, '') : '';
        const exactFile = name && one('SELECT 1 AS found FROM namespace_names WHERE name = ?', name);
        const exists = !exactFile && name && one('SELECT 1 AS found FROM namespace_names WHERE name >= ? AND name < ? LIMIT 1', `${name}/`, `${name}0`);
        const current = exists ? folderRevisionOf(one, name) : null;
        if (!exists || current !== asked.expected_folder_revision) {
          refused.push({ asked, error: 'This folder changed. Open its current version before removing it.', code: 'stale_version', current_revision: current });
          continue;
        }
      }
      if (Object.hasOwn(asked ?? {}, 'expected_identity')) {
        const current = typeof asked?.name === 'string' ? one('SELECT identity FROM namespace_names WHERE name = ?', asked.name) : null;
        if (!current || current.identity !== asked.expected_identity) {
          refused.push({ asked, error: 'This file changed. Open its current version before removing it.', code: 'stale_version', current_identity: current?.identity ?? null });
          continue;
        }
      }
      const found = resolve(asked);
      if (found.error) { refused.push({ asked, error: found.error }); continue; }
      // A checked upload may have no visible name yet. Its intended path still keeps a folder from being removed
      // underneath it; otherwise the finished file could recreate that folder after the delete.
      const intended = found.folder
        ? one('SELECT 1 AS uploading FROM namespace_name_intents WHERE name >= ? AND name < ? LIMIT 1', `${found.place}/`, `${found.place}0`)
        : found.place
          ? one('SELECT 1 AS uploading FROM namespace_name_intents WHERE name = ? LIMIT 1', found.place)
          : one(`SELECT 1 AS uploading FROM namespace_name_intents WHERE name IN (SELECT name FROM namespace_names WHERE ${found.where}) LIMIT 1`, ...found.values);
      if (one(`SELECT 1 AS uploading FROM namespace_names WHERE ${found.where} AND identity LIKE 'up:%' LIMIT 1`, ...found.values)
        || one(`SELECT 1 AS uploading FROM namespace_names_promised WHERE name IN (SELECT name FROM namespace_names WHERE ${found.where}) LIMIT 1`, ...found.values)
        || intended) {
        refused.push({ asked, error: 'It is still uploading. Wait for it to finish, or stop the upload.' });
        continue;
      }
      const id = newId();
      sql.exec('INSERT INTO namespace_set_aside (id, label, place, state, folder, set_aside_ms, by) VALUES (?, ?, ?, ?, ?, ?, ?)', id, found.label, found.place, state, found.folder ? 1 : 0, at, by);
      sql.exec(`INSERT INTO namespace_set_aside_names (id, ordinal, name, collection, identity, byte_length, modified_at_ms)
        SELECT ?, row_number() OVER (ORDER BY name), name, collection, identity, byte_length, modified_at_ms FROM namespace_names WHERE ${found.where}`, id, ...found.values);
      const taken = one('SELECT count(*) AS n FROM namespace_set_aside_names WHERE id = ?', id).n;
      found.markers.forEach((identity, index) => sql.exec('INSERT INTO namespace_set_aside_names (id, ordinal, name, collection, identity) VALUES (?, ?, NULL, NULL, ?)', id, taken + index + 1, identity));
      sql.exec(`DELETE FROM namespace_names WHERE ${found.where}`, ...found.values);
      readNamesAgain(sql);
      done.push(shown({ id, label: found.label, place: found.place, state, folder: found.folder ? 1 : 0, set_aside_ms: at, by }));
    }
    return { set_aside: done, refused, said: stateOf(state).set_aside_words };
  }

  /** What is set aside, newest first, a page at a time (`after`: the last row's set_aside_at + id). */
  function list({ state = null, after = null, limit = settings.list_limit } = {}) {
    if (state !== null) stateOf(state);
    const size = Math.min(Math.max(1, Number(limit) || settings.list_limit), settings.list_limit);
    const cursor = after && typeof after === 'object' ? after : null;
    // A later page seeks to its cursor in namespace_set_aside_newest instead of walking every newer row.
    const rows = cursor
      ? all(`SELECT * FROM namespace_set_aside WHERE (? IS NULL OR state = ?)
        AND (set_aside_ms, id) < (?, ?) ORDER BY set_aside_ms DESC, id DESC LIMIT ?`, state, state, cursor.ms ?? null, cursor.id ?? null, size + 1)
      : all('SELECT * FROM namespace_set_aside WHERE (? IS NULL OR state = ?) ORDER BY set_aside_ms DESC, id DESC LIMIT ?', state, state, size + 1);
    const days = keptFor(), at = now();
    const page = rows.slice(0, size);
    return { items: page.map(row => shown(row, days, at)), next_after: rows.length > size ? { ms: page.at(-1).set_aside_ms, id: page.at(-1).id } : null, keep_for: keepFor() };
  }

  /** Give every name of these items back. Answers { results: [{ id, label, put_back: true } | { id, label, error }] }. */
  function putBack(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > settings.items_per_request) throw new Error(`Choose from 1 to ${settings.items_per_request} to put back.`);
    const results = [];
    for (const id of new Set(ids)) {
      const item = one('SELECT id, label FROM namespace_set_aside WHERE id = ?', id);
      if (!item) { results.push({ id, error: 'It is not in Recently Deleted or Archived.' }); continue; }
      const taken = one('SELECT n.name FROM namespace_set_aside_names s JOIN namespace_names n ON n.name = s.name WHERE s.id = ? LIMIT 1', id);
      if (taken) { results.push({ id, label: item.label, error: `Another file now has the name ${taken.name}. Rename or move that one, then put this back.` }); continue; }
      sql.exec(`INSERT INTO namespace_names (name, collection, identity, byte_length, modified_at_ms, named_at)
        SELECT name, collection, identity, byte_length, modified_at_ms, ? FROM namespace_set_aside_names WHERE id = ? AND name IS NOT NULL`, new Date(now()).toISOString(), id);
      forget(id);
      results.push({ id, label: item.label, put_back: true });
    }
    return { results };
  }

  function forget(id) {
    sql.exec('DELETE FROM namespace_set_aside_names WHERE id = ?', id);
    sql.exec('DELETE FROM namespace_set_aside WHERE id = ?', id);
  }

  /** Change how long a state keeps things: { after_days: { <state>: days | null } }; a state left out keeps its days
   *  (so { after_days: {} } changes nothing). Answers the keep-for now in force. */
  function setKeepFor({ after_days } = {}) {
    if (!after_days || typeof after_days !== 'object' || Array.isArray(after_days)) throw new Error('Say how many days each state keeps things, as after_days: { state: days }.');
    const chosen = Object.entries(after_days).map(([state, days]) => [stateOf(state).id, checkDays(days)]);
    if (chosen.length) keptChoice.write({ ...(keptChoice.read() ?? {}), ...Object.fromEntries(chosen) });
    return keepFor();
  }

  /** The earliest time anything set aside is due, epoch ms, or null (one index seek per state). */
  function nextDue() {
    const days = keptFor();
    let soonest = null;
    for (const state of settings.states) {
      const oldest = one('SELECT set_aside_ms FROM namespace_set_aside WHERE state = ? ORDER BY set_aside_ms LIMIT 1', state.id);
      const due = oldest ? dueAt({ state: state.id, set_aside_ms: oldest.set_aside_ms }, days) : null;
      if (due !== null && (soonest === null || due < soonest)) soonest = due;
    }
    return soonest;
  }

  /** Move on everything whose time has ended, at most `sweep_batch` per state, oldest first. Answers what moved. */
  function sweep(at = now()) {
    const days = keptFor();
    const moved = [], removed = [];
    for (const state of settings.states) {
      const keep = days.get(state.id);
      if (keep === null || keep === undefined) continue;
      const due = all('SELECT id, label FROM namespace_set_aside WHERE state = ? AND set_aside_ms <= ? ORDER BY set_aside_ms LIMIT ?', state.id, at - keep * DAY_MS, settings.sweep_batch);
      for (const row of due) {
        if (state.when_due === null) {
          // The files whose names are now gone for good are told to onGone, which gives back their storage once
          // nothing else keeps them (src/namespace-byte-release.mjs).
          onGone(all('SELECT DISTINCT identity FROM namespace_set_aside_names WHERE id = ? AND identity IS NOT NULL', row.id).map(item => item.identity));
          forget(row.id); removed.push(row); continue;
        }
        sql.exec("UPDATE namespace_set_aside SET state = ?, set_aside_ms = ?, by = 'schedule' WHERE id = ?", stateOf(state.when_due).id, at, row.id);
        moved.push({ ...row, to: state.when_due });
      }
    }
    return { moved, removed };
  }

  /** Every item, as list() shows them, oldest first: what the release rules (src/namespace-release-rules.mjs) decide over. */
  function everything() {
    const days = keptFor(), at = now();
    return all('SELECT * FROM namespace_set_aside ORDER BY set_aside_ms, id').map(row => shown(row, days, at));
  }

  /** Delete these items for good now, as the sweep does when their time ends: their files are told to onGone. */
  function forgetNow(ids) {
    const removed = [];
    for (const id of new Set(ids)) {
      const row = one('SELECT id, label FROM namespace_set_aside WHERE id = ?', id);
      if (!row) continue;
      onGone(all('SELECT DISTINCT identity FROM namespace_set_aside_names WHERE id = ? AND identity IS NOT NULL', id).map(item => item.identity));
      forget(id); removed.push(row);
    }
    return removed;
  }

  /** Whether anything is in Recently Deleted or Archived at all. */
  const holdsAny = () => Boolean(one('SELECT 1 AS held FROM namespace_set_aside LIMIT 1'));

  return { setAside, list, putBack, keepFor, setKeepFor, nextDue, sweep, everything, forgetNow, holdsAny };
}

/** The person's keep-for days from before they were a setting (the `namespace_keep_for` table, one row per state),
 *  carried once into the same setting (src/carry-tables-into-records.mjs); a day the person chose since stays. */
export const keepForCarrier = keptChoice => ({
  table: 'namespace_keep_for',
  carry(rows) {
    if (!rows.length) return;
    const merged = { ...Object.fromEntries(rows.map(row => [row.state, row.after_days])), ...(keptChoice.read() ?? {}) };
    keptChoice.write(merged);
    checkCarried('namespace_keep_for', merged, keptChoice.read());
  },
});
