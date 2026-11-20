// tools/write-public-share-files/do-work/write-share-files.mjs
//
// The thin shell around share-files.mjs: takes the person's sharing rows, the Lists they share and those Lists' rows as
// the records the caller read from the person's own store and handed in (input.records), reads the files the shown
// rows name from the files the caller handed in (input.stored.files), hands them to the pure core, and writes the public files into
// the folder the caller names, at the paths the public server serves under /share/. It then writes manifest.json: every
// file with its BLAKE3 content identity (tools/content-identity), and which files of the last run it removed because
// their link was revoked, expired, narrowed or changed. It holds no records method: the store is never read here.
//
//   writeShareFiles({ input: { origin, row_kind, records, stored?: { files?: { name: text | { base64, media_type? } } } }, folder },
//                   { now?, filterRows? })
//     → { written, unchanged, removed, published, left_out, ended, next_change_at, wake_effects, host_files }
//
// NON-NEGOTIABLE INVARIANTS
//   1. Records are the ones handed in as input.records; files are the ones handed in as input.stored.files. Nothing
//      else of the person's is read: a file that was not given is not there.
//   2. A file is written whole under a temporary name and renamed into place, and the bytes of a shared file must
//      have the identity the row names, or the run stops before the manifest changes.
//   3. Every path the last manifest names that this run did not write is removed: no stale copy of an ended link or a
//      hidden row is kept. The manifest is written last, so a run cut short is finished by the next.
//   4. A link that will expire is woken again at its expiry through the engine's wake (wake_effects), so its files
//      are removed then; nothing here waits or polls.
import { mkdir, readFile, rename, rm, writeFile, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { filterRecords } from './formula-engine.mjs';
import data from '../read-data/share-files.json' with { type: 'json' };
import { partOf, shareFiles } from './share-files.mjs';

const MANIFEST = 'manifest.json';
const SCHEMA = 'trillion.public-share-files/v1';
const TOOL = 'tool:write-public-share-files';
const say = (code, words) => Object.assign(new Error(words), { code });
const enc = new TextEncoder();
const defaultFilter = ({ tree, fields, rows }) => {
  const answer = filterRecords({ tree, fields, records: rows });
  return { matches: answer.matches, incomplete: answer.incomplete };
};

/** A path inside the folder, or a refusal: nothing is written outside it. */
function inside(folder, path) {
  const target = resolve(folder, path);
  if (!target.startsWith(resolve(folder) + sep)) throw say('bad_path', `${path} is not inside the folder.`);
  return target;
}

async function readManifest(folder) {
  try { return JSON.parse(await readFile(join(folder, MANIFEST), 'utf8')); } catch { return null; }
}

async function writeWhole(target, bytes) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.writing`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

// The files the caller handed in as input.stored.files ({ name: text | { base64, media_type? } }), each with its BLAKE3
// identity, so a row may name a file by its name or its identity.
function givenFiles(files = {}) {
  const given = Object.entries(files).map(([name, held]) => {
    const bytes = Buffer.from(typeof held === 'string' ? held : held?.base64 ?? '', typeof held === 'string' ? 'utf8' : 'base64');
    return { name, bytes, identity: makeHashCodeHexFromBytes(bytes), media_type: held?.media_type ?? null };
  });
  const byKey = new Map(given.flatMap(file => [[file.name, file], [file.identity, file]]));
  return key => byKey.get(key) ?? null;
}

// The bytes of one shared file, checked against the identity a shown row named.
function fileBytes(fileOf, identity) {
  const file = fileOf(identity);
  if (!file) throw say('file_missing', `${identity} was not given to this run.`);
  if (file.identity !== identity) throw say('file_changed', `${identity} does not hold the bytes its identity names.`);
  return file.bytes;
}

// The records of one type the caller handed in as input.records: { id, type, value }.
const recordsOf = (records, type) => records.filter(record => record?.type === type && record.value && typeof record.value === 'object');

// The shares as the core takes them: each link grant with the List (or the List of the row) it shares and its rows.
function readShares(records, rowKind, given) {
  const shares = [];
  const lists = new Map();
  const listOf = ref => {
    if (!lists.has(ref)) {
      const found = recordsOf(records, data.list_kind).find(record => record.id === ref);
      const list = found ? found.value : null;
      let rows = [];
      if (list?.row_type && `record:${list.row_type}` !== rowKind) rows = null;
      else if (list?.row_type) {
        const type = `record:${list.row_type}`;
        for (const record of recordsOf(records, type)) {
          const id = String(record.id).startsWith(`${type}:`) ? String(record.id).slice(type.length + 1) : String(record.id);
          const title = record.value[list.title_field] ?? record.value[list.fields?.[0]?.id] ?? null;
          rows.push({ id, title: typeof title === 'string' ? title : null, values: record.value });
        }
      }
      lists.set(ref, { list: list ? { ...list, id: ref } : null, rows });
    }
    return lists.get(ref);
  };
  const fileOf = async name => {
    const file = given(name);
    return file && { identity: file.identity, media_type: file.media_type, name: name.startsWith('/') ? name : null };
  };
  for (const record of recordsOf(records, 'sharing')) {
    const sharing = record.value;
    if (!sharing?.record || !Array.isArray(sharing.link_grants) || !sharing.link_grants.length) continue;
    const ref = partOf(sharing.record)?.whole ?? sharing.record;
    const { list, rows } = ref.startsWith(`${data.list_kind}:`) ? listOf(ref) : { list: null, rows: [] };
    for (const grant of sharing.link_grants) shares.push({ sharing, grant, list, rows, fileOf });
  }
  return shares;
}

export async function writeShareFiles({ input = {}, folder } = {}, { now = Date.now(), filterRows = defaultFilter } = {}) {
  if (typeof folder !== 'string' || !folder) throw say('bad_input', 'Name the folder the public share files are written to.');
  if (typeof input.row_kind !== 'string' || !input.row_kind.startsWith('record:')) throw say('bad_input', 'row_kind is the record kind of the shared Lists\' rows, record:<the List\'s row_type>.');
  // The records are never read here: a run without them is refused, so it never publishes or removes from a partial view.
  if (!Array.isArray(input.records)) throw say('bad_input', 'records are required: the caller reads the sharing, List and row records from the person\'s own store and hands them in.');
  const given = givenFiles(input.stored?.files);
  const result = await shareFiles({ origin: input.origin, now, shares: readShares(input.records, input.row_kind, given), filterRows });
  const before = await readManifest(folder);
  const held = new Map((before?.files ?? []).map(file => [file.path, file.identity]));
  const files = [];
  let written = 0, unchanged = 0;
  for (const item of result.files) {
    const target = inside(folder, item.path);
    let bytes = item.text === undefined ? null : enc.encode(item.text);
    const identity = item.identity ?? makeHashCodeHexFromBytes(bytes);
    const kept = held.get(item.path) === identity && await readFile(target).then(found => makeHashCodeHexFromBytes(found) === identity, () => false);
    if (kept) unchanged += 1;
    else {
      bytes ??= fileBytes(given, identity);
      await writeWhole(target, bytes);
      written += 1;
    }
    files.push({ path: item.path, identity, media_type: item.media_type });
  }
  const now_written = new Set(files.map(file => file.path));
  const removed = [...held.keys()].filter(path => !now_written.has(path)).sort();
  for (const path of removed) {
    const target = inside(folder, path);
    await rm(target, { force: true });
    // Folders a removed page leaves empty go with it, up to the folder itself.
    for (let at = dirname(target); at.startsWith(resolve(folder) + sep); at = dirname(at)) {
      try { await rmdir(at); } catch { break; }
    }
  }
  await writeWhole(join(folder, MANIFEST), enc.encode(`${JSON.stringify({ schema: SCHEMA, origin: input.origin, written_at: new Date(now).toISOString(),
    files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), removed }, null, 2)}\n`));
  const at = result.next_change_at ? Date.parse(result.next_change_at) : null;
  return { written, unchanged, removed, published: result.published, left_out: result.left_out, ended: result.ended, next_change_at: result.next_change_at,
    // The wake carries no records: it must be given fresh ones from the person's store, never this run's snapshot.
    wake_effects: at === null ? [] : [{ wake: { tool: TOOL, at_ms: at, input: { origin: input.origin, row_kind: input.row_kind } } }],
    // A caller composing export + host configuration uses the same current file
    // list, including types for content identities which have no extension. This
    // is desired DATA, not a claim that nginx received it or that a remote host
    // can read this folder. Apply through the existing host owner only after the
    // folder is proved to be its dedicated public export tree.
    host_files: { path: '/share/', folder: resolve(folder), index: 'index.html', exclude: [MANIFEST],
      media_types: Object.fromEntries(files.filter(file => !file.path.split('/').at(-1).includes('.')).map(file => [file.path, file.media_type])) } };
}
