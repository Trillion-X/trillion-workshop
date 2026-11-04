// src/file-tidy.mjs
//
// PURPOSE
//   Tidying a person's files: their own AI suggests a title and/or a folder for each file, grounded in what is already
//   kept about it (its transcript, summary, facts: src/namespace-results.mjs); the person accepts or rejects each
//   suggestion; the accepted ones are applied as one tidy-up (a title is recorded as a result of kind `title_kind`, a
//   folder is the file's name moved into it in the namespace, src/namespace-store.mjs); every tidy-up is kept in a
//   history and the latest one not undone can be undone. Ported from the Mac's organization owner
//   (media-workspace/organization-owner.mjs, recording-evidence.mjs, media-titles.mjs): its grounding check and its
//   "the evidence changed since" refusal.
//
//   namespace_tidy_proposals  one row per suggestion: the file's name and identity when suggested, the title and folder
//                             suggested, the results it cites (kind + value identity), who suggested it, its state
//   namespace_tidy_batches    one row per applied tidy-up: when, what changed for each file (before and after), when undone
//
//   Routes (under /mcp/api with a personal key or app sign-in, and /work/api for the person's own page):
//     GET  /namespace/tidy?state=        suggestions, newest first, with how many are in each state
//     POST /namespace/tidy               { items: [{ name, title?, folder?, evidence: [kind], reason? }], produced_by? }
//     POST /namespace/tidy/decisions     { decisions: [{ id, choice: accept | reject }] }
//     POST /namespace/tidy/apply         { ids? }  every accepted suggestion (or those of `ids` that are accepted)
//     POST /namespace/tidy/undo          the latest tidy-up not undone yet
//     GET  /namespace/tidy/history       applied tidy-ups, newest first
//
// NON-NEGOTIABLE INVARIANTS
//   1. Grounded: a suggestion cites results already kept for the file, and its title (and a folder that does not exist
//      yet) must be mentioned by their words (the Mac's groundingProblem, its thresholds DATA in file-tidy.json). A
//      suggestion with no cited words is refused; nothing here invents or runs a model.
//   2. Never stale: applying re-reads the file under its name and the value identity of every cited result; a file
//      renamed, moved or replaced, or evidence that changed since, refuses that suggestion (state `stale`) and applies
//      nothing for it.
//   3. One tidy-up is one change: every accepted suggestion that passes is applied in the caller's transaction, and
//      undone the same way, only when every file it touched is still as the tidy-up left it.
//   4. The files themselves are never touched: a folder move changes a name, a title is a result; the bytes stay.
//   5. Words, limits and states are DATA (file-tidy.json); the result kinds cited are named by the caller.
//
// SECURITY
//   One store per person (their PersonStore Durable Object); every read and write is theirs.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import settings from './file-tidy.json' with { type: 'json' };

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const now = () => new Date().toISOString();
const baseOf = name => name.slice(name.lastIndexOf('/') + 1);
const parentOf = name => name.replace(/\/[^/]+$/, '') || '/';
const placeIn = (folder, name) => `${folder === '/' ? '' : folder}/${baseOf(name)}`;
const oneLine = value => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

/** The grounding check (media-workspace/recording-evidence.mjs), its thresholds and ignored words read from DATA. */
export function grounding(config = settings.grounding) {
  const container = new Set(config.container_words);
  const words = value => String(value ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const counted = word => word.length >= config.min_word_length && !/^\d+$/.test(word) && !container.has(word);
  const stem = word => word.slice(0, config.stem_length);
  return {
    /** The word stems a text mentions. */
    mentioned: text => new Set(words(text).filter(counted).map(stem)),
    /** The words of a title the evidence does not mention, when too many are missing; else null. */
    titleMissing(title, mentioned) {
      const judged = [...new Set(words(title).filter(counted))];
      const missing = judged.filter(word => !mentioned.has(stem(word)));
      return judged.length > 0 && missing.length * config.missing_share_denominator > judged.length ? missing : null;
    },
    /** Whether a term has words to judge and the evidence mentions none of them. */
    unsupported(term, mentioned) {
      const judged = words(term).filter(counted);
      return judged.length > 0 && !judged.some(word => mentioned.has(stem(word)));
    },
  };
}

// Every piece of text in the cited results, up to `budget` characters (a transcript, a summary's words, a fact's name).
function textOf(values, budget) {
  const parts = [];
  let left = budget;
  const walk = value => {
    if (left <= 0) return;
    if (typeof value === 'string') { const piece = value.slice(0, left); parts.push(piece); left -= piece.length; }
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(values);
  return parts.join('\n');
}

// A folder as a clean path: starts with /, no empty, `.` or `..` parts, no trailing /. Null when not one.
function folderPath(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '') || '/';
  if (!trimmed.startsWith('/') || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (trimmed !== '/' && trimmed.slice(1).split('/').some(part => !part.trim() || part === '.' || part === '..')) return null;
  return trimmed;
}

export const isTidyPath = path => path === '/namespace/tidy' || path.startsWith('/namespace/tidy/');

/** The reads that change nothing; every other verb runs in one transaction of the person's store. */
export const TIDY_READS = new Set(['list', 'history']);

/** A person's tidy-ups. sql: their store; namespace: their namespaceStore; results: their resultsStore. */
export function tidyStore(sql, { namespace, results, config = settings }) {
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_tidy_proposals (id TEXT PRIMARY KEY, name TEXT NOT NULL, identity TEXT NOT NULL, title TEXT, folder TEXT, reason TEXT, evidence TEXT NOT NULL, produced_by TEXT, state TEXT NOT NULL, problem TEXT, batch INTEGER, proposed_at TEXT NOT NULL, decided_at TEXT)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_tidy_proposals_name ON namespace_tidy_proposals (name, state)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS namespace_tidy_proposals_state ON namespace_tidy_proposals (state)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_tidy_batches (seq INTEGER PRIMARY KEY AUTOINCREMENT, applied_at TEXT NOT NULL, changes TEXT NOT NULL, undone_at TEXT, tidy_up_name TEXT)`);
  if (!sql.exec("SELECT 1 FROM pragma_table_info('namespace_tidy_batches') WHERE name = 'tidy_up_name'").toArray().length) sql.exec('ALTER TABLE namespace_tidy_batches ADD COLUMN tidy_up_name TEXT');
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  const one = (query, ...values) => all(query, ...values)[0] ?? null;
  const words = config.words;
  const check = grounding(config.grounding);
  const batchId = seq => `tidy-up:${seq}`;
  const shown = row => ({
    id: row.id, name: row.name, identity: row.identity, title: row.title, folder: row.folder, reason: row.reason,
    evidence: JSON.parse(row.evidence), produced_by: row.produced_by, state: row.state, problem: row.problem,
    proposed_at: row.proposed_at, decided_at: row.decided_at,
    tidy_up: row.batch === null ? null : { id: batchId(row.batch), applied_at: row.applied_at, undone_at: row.undone_at },
  });
  // Suggestions not decided against and not applied: a newer suggestion for the same file replaces these.
  const openStates = JSON.stringify(config.replaceable_states);
  const titleNow = identity => results.evidence(identity, [config.title_kind])[0] ?? null;

  // What would stop a suggestion being applied now: the file under its name changed, the cited results changed, or
  // the name it would move to is taken. Null when it can be applied.
  function problemOf(row) {
    const file = namespace.byName(row.name);
    if (!file || file.identity !== row.identity) return words.file_changed;
    const cited = JSON.parse(row.evidence);
    const current = new Map(results.evidence(row.identity, cited.map(item => item.kind)).map(item => [item.kind, item.value_identity]));
    const changed = cited.filter(item => current.get(item.kind) !== item.value_identity).map(item => item.kind);
    if (changed.length) return fill(words.evidence_changed, { kinds: changed.join(', ') });
    if (row.folder) {
      const target = placeIn(row.folder, row.name);
      const there = target === row.name ? null : namespace.entry(target);
      if (there && (there.folder || there.identity !== row.identity)) return fill(words.name_taken, { name: target });
    }
    return null;
  }

  return {
    // items: [{ name, title?, folder?, evidence: [kind], reason? }] -> { proposed, unchanged, refused: [{ index, name, reason }] }
    propose(items, producedBy = null) {
      const proposed = [], refused = [];
      let unchanged = 0;
      items.forEach((item, index) => {
        const refuse = reason => refused.push({ index, name: typeof item?.name === 'string' ? item.name : null, reason });
        const name = typeof item?.name === 'string' ? item.name.trim() : '';
        const file = name.startsWith('/') ? namespace.byName(name) : null;
        if (!file) return refuse(words.no_file);
        if (file.growing) return refuse(words.still_arriving);
        const title = item.title === undefined || item.title === null || item.title === '' ? null : item.title;
        if (title !== null && (!oneLine(title) || title.trim().length > config.max_title_chars)) return refuse(fill(words.bad_title, { max: config.max_title_chars }));
        const asked = item.folder === undefined || item.folder === null || item.folder === '' ? null : folderPath(item.folder, config.max_folder_chars);
        if (item.folder && asked === null) return refuse(fill(words.bad_folder, { max: config.max_folder_chars }));
        // A folder the file is already in is no move.
        const folder = asked === parentOf(name) ? null : asked;
        if (!title && !folder) return refuse(words.nothing_suggested);
        const kinds = Array.isArray(item.evidence) ? [...new Set(item.evidence.filter(kind => typeof kind === 'string' && kind))] : [];
        if (!kinds.length) return refuse(words.no_evidence_named);
        const cited = results.evidence(file.identity, kinds);
        const missing = kinds.find(kind => !cited.some(result => result.kind === kind));
        if (missing) return refuse(fill(words.evidence_missing, { kind: missing }));
        const text = textOf(cited.map(result => result.value), config.evidence_chars);
        if (!text.trim()) return refuse(words.evidence_empty);
        const mentioned = check.mentioned(text);
        const unsupported = title ? check.titleMissing(title, mentioned) : null;
        if (unsupported) return refuse(fill(words.title_ungrounded, { missing: unsupported.join(', ') }));
        const place = folder ? namespace.entry(folder) : null;
        if (place && !place.folder) return refuse(fill(words.bad_folder, { max: config.max_folder_chars }));
        if (folder && !place && check.unsupported(baseOf(folder), mentioned)) return refuse(fill(words.folder_ungrounded, { folder }));
        const evidence = cited.map(result => ({ kind: result.kind, value_identity: result.value_identity }));
        const cleanTitle = title?.trim() ?? null;
        const id = `tidy:${bytesToHex(blake3(utf8ToBytes(JSON.stringify([name, file.identity, cleanTitle, folder, evidence])))).slice(0, 24)}`;
        const held = one('SELECT * FROM namespace_tidy_proposals LEFT JOIN namespace_tidy_batches ON seq = batch WHERE id = ?', id);
        if (held) { unchanged += 1; proposed.push(shown(held)); return; }
        // A newer suggestion for the same file replaces one still waiting; applied ones stay in the history.
        sql.exec('DELETE FROM namespace_tidy_proposals WHERE name = ? AND state IN (SELECT value FROM json_each(?))', name, openStates);
        const reason = typeof item.reason === 'string' ? item.reason.trim().slice(0, config.max_reason_chars) || null : null;
        sql.exec('INSERT INTO namespace_tidy_proposals (id, name, identity, title, folder, reason, evidence, produced_by, state, problem, batch, proposed_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)',
          id, name, file.identity, cleanTitle, folder, reason, JSON.stringify(evidence), typeof producedBy === 'string' ? producedBy.slice(0, 200) : null, 'review', now());
        proposed.push(shown(one('SELECT * FROM namespace_tidy_proposals LEFT JOIN namespace_tidy_batches ON seq = batch WHERE id = ?', id)));
      });
      return { proposed, unchanged, refused, said: fill(words.said_proposed, { proposed: proposed.length, refused: refused.length }) };
    },

    // Suggestions newest first (only those in `state` when given), and how many are in each state.
    list({ state = null } = {}) {
      const rows = state
        ? all('SELECT * FROM namespace_tidy_proposals LEFT JOIN namespace_tidy_batches ON seq = batch WHERE state = ? ORDER BY proposed_at DESC, id LIMIT ?', state, config.list_limit)
        : all('SELECT * FROM namespace_tidy_proposals LEFT JOIN namespace_tidy_batches ON seq = batch ORDER BY proposed_at DESC, id LIMIT ?', config.list_limit);
      const counts = Object.fromEntries(all('SELECT state, COUNT(*) AS count FROM namespace_tidy_proposals GROUP BY state').map(row => [row.state, row.count]));
      const latest = one('SELECT seq FROM namespace_tidy_batches WHERE undone_at IS NULL ORDER BY seq DESC LIMIT 1');
      return { proposals: rows.map(shown), counts, can_undo: latest ? batchId(latest.seq) : null, said: fill(words.said_list, { review: counts.review ?? 0, accepted: counts.accepted ?? 0 }) };
    },

    // [{ id, choice: accept | reject }] -> { decided, refused: [{ id, reason }] }
    decide(decisions) {
      const choices = { accept: 'accepted', reject: 'rejected' };
      let decided = 0;
      const refused = [];
      for (const decision of decisions) {
        const state = choices[decision?.choice];
        if (!state) { refused.push({ id: decision?.id ?? null, reason: words.bad_choice }); continue; }
        const row = one('SELECT state FROM namespace_tidy_proposals WHERE id = ?', String(decision.id ?? ''));
        if (!row || !config.decidable_states.includes(row.state)) { refused.push({ id: decision.id ?? null, reason: words.not_decidable }); continue; }
        sql.exec('UPDATE namespace_tidy_proposals SET state = ?, decided_at = ? WHERE id = ?', state, now(), decision.id);
        decided += 1;
      }
      return { decided, refused };
    },

    // Every accepted suggestion (or those of `ids`) applied as one NAMED tidy-up (a transaction: each file's before and
    // after kept together) -> { tidy_up, name, applied, refused: [{ id, name, reason }] }
    apply(ids = null, name = null) {
      if (name !== null && name !== undefined && !oneLine(name)) return { error: fill(words.name_needed, { max: config.max_name_chars }) };
      if (typeof name === 'string' && name.trim().length > config.max_name_chars) return { error: fill(words.name_needed, { max: config.max_name_chars }) };
      const accepted = all("SELECT * FROM namespace_tidy_proposals WHERE state = 'accepted' ORDER BY proposed_at, id")
        .filter(row => !Array.isArray(ids) || ids.includes(row.id));
      if (!accepted.length) return { error: words.nothing_accepted };
      const changes = [], refused = [], applied = [];
      const titles = new Map();
      for (const row of accepted) {
        const problem = problemOf(row);
        if (problem) {
          sql.exec("UPDATE namespace_tidy_proposals SET state = 'stale', problem = ? WHERE id = ?", problem, row.id);
          refused.push({ id: row.id, name: row.name, reason: problem });
          continue;
        }
        const change = { proposal: row.id, identity: row.identity, name_before: row.name, name_after: row.name, title_before: null, title_after: null };
        if (row.title) {
          const before = titles.get(row.identity);
          titles.set(row.identity, { change: before?.change ?? change,
            before: before ? before.before : titleNow(row.identity)?.value ?? null,
            value: { title: row.title }, produced_by: row.produced_by ?? 'tidy-up' });
        }
        if (row.folder) {
          const target = placeIn(row.folder, row.name);
          if (target !== row.name) {
            const entry = namespace.entry(row.name);
            namespace.putNames([{ name: target, identity: row.identity, byte_length: entry.byte_length, modified_at_ms: entry.modified_at_ms }, { name: row.name, remove: true }]);
            change.name_after = target;
          }
        }
        changes.push(change);
        applied.push(row.id);
      }
      // A title belongs to the bytes, while moves belong to each name. Aliases share one final title write and one
      // true pre-batch value, so undo never compares or restores an intermediate title from its own batch.
      for (const [identity, title] of titles) {
        results.put([{ identity, kind: config.title_kind, value: title.value, produced_by: title.produced_by }]);
        title.change.title_before = title.before;
        title.change.title_after = titleNow(identity).value_identity;
      }
      // What is said names only what happened: the refused count only when something was refused.
      const said = [changes.length ? fill(words.said_applied, { applied: changes.length }) : '', refused.length ? fill(words.said_not_applied, { refused: refused.length }) : ''].filter(Boolean).join(' ');
      if (!changes.length) return { tidy_up: null, applied: 0, refused, said };
      const batchName = typeof name === 'string' && name.trim() ? name.trim() : fill(words.default_tidy_up_name, { count: changes.length });
      const { seq } = one('INSERT INTO namespace_tidy_batches (applied_at, changes, undone_at, tidy_up_name) VALUES (?, ?, NULL, ?) RETURNING seq', now(), JSON.stringify(changes), batchName);
      sql.exec("UPDATE namespace_tidy_proposals SET state = 'applied', problem = NULL, batch = ? WHERE id IN (SELECT value FROM json_each(?))", seq, JSON.stringify(applied));
      return { tidy_up: batchId(seq), name: batchName, applied: changes.length, refused, said };
    },

    // Applied tidy-ups, newest first, each with what changed for each file and whether it is the one undo reverses.
    history(limit = config.history_limit) {
      const rows = all('SELECT * FROM namespace_tidy_batches ORDER BY seq DESC LIMIT ?', Math.max(1, Math.min(Number(limit) || config.history_limit, config.history_limit)));
      const latest = one('SELECT seq FROM namespace_tidy_batches WHERE undone_at IS NULL ORDER BY seq DESC LIMIT 1');
      return { said: fill(words.said_history, { count: one('SELECT COUNT(*) AS count FROM namespace_tidy_batches').count }), tidy_ups: rows.map(row => ({ id: batchId(row.seq), name: row.tidy_up_name, applied_at: row.applied_at, undone_at: row.undone_at, can_undo: row.seq === latest?.seq, changes: JSON.parse(row.changes) })) };
    },

    // A tidy-up not undone (`id` names it; the latest when none), reversed as one, only when every file it touched is
    // still as it left them: one undo restores the whole folder operation, from the before payloads it kept.
    undo(id = null) {
      const named = id === null || id === undefined ? null : /^tidy-up:(\d+)$/.exec(String(id));
      if (named === null && id !== null && id !== undefined) return { error: fill(words.tidy_up_unknown, { id }) };
      const batch = named
        ? one('SELECT * FROM namespace_tidy_batches WHERE seq = ?', Number(named[1]))
        : one('SELECT * FROM namespace_tidy_batches WHERE undone_at IS NULL ORDER BY seq DESC LIMIT 1');
      if (!batch) return { error: named ? fill(words.tidy_up_unknown, { id }) : words.nothing_to_undo };
      if (batch.undone_at) return { error: fill(words.already_undone, { name: batch.tidy_up_name ?? batchId(batch.seq) }) };
      const changes = JSON.parse(batch.changes);
      const moved = change => change.name_after !== change.name_before;
      const titles = new Map();
      for (const change of changes) {
        if (!change.title_after) continue;
        const before = titles.get(change.identity);
        titles.set(change.identity, { ...change, title_before: before ? before.title_before : change.title_before });
      }
      const changedSince = changes.filter(change =>
        moved(change) && (namespace.byName(change.name_after)?.identity !== change.identity || namespace.entry(change.name_before)));
      changedSince.push(...[...titles.values()].filter(change => titleNow(change.identity)?.value_identity !== change.title_after));
      if (changedSince.length) return { error: fill(words.undo_changed, { names: changedSince.map(change => change.name_after).join(', ') }) };
      for (const change of titles.values()) {
        if (change.title_before === null) results.remove(change.identity, config.title_kind);
        else results.put([{ identity: change.identity, kind: config.title_kind, value: change.title_before, produced_by: 'tidy-up undone' }]);
      }
      for (const change of changes) {
        if (moved(change)) {
          const entry = namespace.entry(change.name_after);
          namespace.putNames([{ name: change.name_before, identity: change.identity, byte_length: entry.byte_length, modified_at_ms: entry.modified_at_ms }, { name: change.name_after, remove: true }]);
        }
      }
      sql.exec('UPDATE namespace_tidy_batches SET undone_at = ? WHERE seq = ?', now(), batch.seq);
      sql.exec("UPDATE namespace_tidy_proposals SET state = 'undone' WHERE batch = ?", batch.seq);
      return { undone: batchId(batch.seq), name: batch.tidy_up_name, changes: changes.length, said: fill(words.said_undone, { changes: changes.length }) };
    },
  };
}

const json = (value, status = 200) => Response.json(value, { status });
const fail = (status, error) => json({ error }, status);
const answered = value => (value?.error ? fail(409, value.error) : json(value));

// `person` answers namespaceTidy(verb, ...args) from its tidyStore; `app` is who is asking (an AI app's name).
export async function handleTidyApi(request, person, path, url, app = null) {
  const body = request.method === 'POST' ? await request.json().catch(() => null) : null;
  if (request.method === 'GET' && path === '/namespace/tidy') {
    const state = url.searchParams.get('state');
    if (state && !Object.hasOwn(settings.states, state)) return fail(400, `state is one of ${Object.keys(settings.states).join(', ')}.`);
    return json(await person.namespaceTidy('list', { state }));
  }
  if (request.method === 'GET' && path === '/namespace/tidy/history') return json(await person.namespaceTidy('history', url.searchParams.get('limit')));
  if (request.method !== 'POST') return fail(405, 'Read with GET, change with POST.');
  if (path === '/namespace/tidy') {
    if (!Array.isArray(body?.items) || !body.items.length || body.items.length > settings.max_items) return fail(400, `Send items as a list of 1 to ${settings.max_items} { name, title?, folder?, evidence }.`);
    return json(await person.namespaceTidy('propose', body.items, typeof body.produced_by === 'string' && body.produced_by ? body.produced_by : app));
  }
  if (path === '/namespace/tidy/decisions') {
    if (!Array.isArray(body?.decisions) || !body.decisions.length || body.decisions.length > settings.list_limit) return fail(400, `Send decisions as a list of 1 to ${settings.list_limit} { id, choice }.`);
    return json(await person.namespaceTidy('decide', body.decisions));
  }
  if (path === '/namespace/tidy/apply') {
    const ids = body?.ids;
    if (ids !== undefined && ids !== null && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) return fail(400, 'ids is a list of suggestion ids, or left out to apply every accepted one.');
    return answered(await person.namespaceTidy('apply', Array.isArray(ids) ? ids : null, typeof body?.name === 'string' && body.name ? body.name : null));
  }
  if (path === '/namespace/tidy/undo') return answered(await person.namespaceTidy('undo', typeof body?.id === 'string' && body.id ? body.id : null));
  return fail(404, 'Not found');
}

/** The Workshop account actions (records/workshop-file-tidy-tool-records.json), run in the person's own store. */
export const fileTidyActions = run => {
  const asTool = answer => { if (answer?.error) throw new Error(answer.error); return answer; };
  return {
    'propose-file-tidy': async ({ items, produced_by = null } = {}) => asTool(await run('propose', Array.isArray(items) ? items.slice(0, settings.max_items) : [], produced_by)),
    'list-file-tidy': async ({ state = null } = {}) => asTool(await run('list', { state })),
    'apply-file-tidy': async ({ ids = null, name = null } = {}) => asTool(await run('apply', Array.isArray(ids) ? ids : null, name)),
    'undo-file-tidy': async ({ id = null } = {}) => asTool(await run('undo', id)),
    'file-tidy-history': async ({ limit } = {}) => asTool(await run('history', limit)),
  };
};
