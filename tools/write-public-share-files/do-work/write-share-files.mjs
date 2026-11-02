// tools/write-public-share-files/do-work/write-share-files.mjs
//
// The thin shell around share-files.mjs: reads the person's sharing rows, the Lists they share, those Lists' rows and
// the files the shown rows name through the run's records door (records:list, records:read, read_file), hands them to
// the pure core, and writes the public files into the folder the caller names, at the paths the public server serves
// under /share/. It then writes manifest.json: every file with its BLAKE3 content identity (tools/content-identity),
// and which files of the last run it removed because their link was revoked, expired, narrowed or changed.
//
//   writeShareFiles({ input: { origin, row_kind }, folder }, { door, now?, filterRows? })
//     → { written, unchanged, removed, published, left_out, ended, next_change_at, wake_effects }
//
// NON-NEGOTIABLE INVARIANTS
//   1. Records, rows and files are read only through the run's door; nothing else of the person's is read.
//   2. A file is written whole under a temporary name and renamed into place, and the bytes of a shared file must
//      have the identity the row names, or the run stops before the manifest changes.
//   3. Every path the last manifest names that this run did not write is removed: no stale copy of an ended link or a
//      hidden row is kept. The manifest is written last, so a run cut short is finished by the next.
//   4. A link that will expire is woken again at its expiry through the engine's wake (wake_effects), so its files
//      are removed then; nothing here waits or polls.
import { mkdir, readFile, rename, rm, writeFile, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import data from '../read-data/share-files.json' with { type: 'json' };
import { partOf, shareFiles } from './share-files.mjs';

const MANIFEST = 'manifest.json';
const SCHEMA = 'trillion.public-share-files/v1';
const READ_BYTES = 512 * 1024;
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

// The bytes of one shared file, page after page, checked against the identity a shown row named.
async function fileBytes(door, identity) {
  const parts = [];
  for (let offset = 0, total = null; total === null || offset < total;) {
    const page = await door.files('read_file', { name_or_identity: identity, offset, length: READ_BYTES });
    if (page.identity !== identity) throw say('file_changed', `${identity} changed while it was read.`);
    total = page.byte_length;
    const part = Buffer.from(page.content ?? '', page.encoding === 'base64' ? 'base64' : 'utf8');
    if (!page.bytes_returned && total > 0) throw say('file_short', `${identity} did not answer its bytes.`);
    parts.push(part); offset += part.length;
    if (!part.length) break;
  }
  const bytes = Buffer.concat(parts);
  if (makeHashCodeHexFromBytes(bytes) !== identity) throw say('file_changed', `${identity} does not hold the bytes its identity names.`);
  return bytes;
}

// The shares as the core takes them: each link grant with the List (or the List of the row) it shares and its rows.
async function readShares(door, rowKind) {
  const shares = [];
  const lists = new Map();
  const listOf = async ref => {
    if (!lists.has(ref)) {
      const list = await door.read(data.list_kind, ref);
      let rows = [];
      if (list?.row_type && `record:${list.row_type}` !== rowKind) rows = null;
      else if (list?.row_type) {
        const type = `record:${list.row_type}`;
        for await (const record of door.list({ type })) {
          if (!record?.value) continue;
          const id = String(record.id).startsWith(`${type}:`) ? String(record.id).slice(type.length + 1) : String(record.id);
          const title = record.value[list.title_field] ?? record.value[list.fields?.[0]?.id] ?? null;
          rows.push({ id, title: typeof title === 'string' ? title : null, values: record.value });
        }
      }
      lists.set(ref, { list: list ? { ...list, id: ref } : null, rows });
    }
    return lists.get(ref);
  };
  const facts = new Map();
  const fileOf = async name => {
    if (!facts.has(name)) {
      const page = await door.files('read_file', { name_or_identity: name, offset: 0, length: 0 }).catch(() => null);
      facts.set(name, page?.identity ? { identity: page.identity, media_type: page.media_type ?? null, name: page.name ?? (name.startsWith('/') ? name : null) } : null);
    }
    return facts.get(name);
  };
  for await (const record of door.list({ type: 'sharing' })) {
    const sharing = record?.value;
    if (!sharing?.record || !Array.isArray(sharing.link_grants) || !sharing.link_grants.length) continue;
    const ref = partOf(sharing.record)?.whole ?? sharing.record;
    const { list, rows } = ref.startsWith(`${data.list_kind}:`) ? await listOf(ref) : { list: null, rows: [] };
    for (const grant of sharing.link_grants) shares.push({ sharing, grant, list, rows, fileOf });
  }
  return shares;
}

export async function writeShareFiles({ input = {}, folder } = {}, { door, now = Date.now(), filterRows = defaultFilter } = {}) {
  if (typeof folder !== 'string' || !folder) throw say('bad_input', 'Name the folder the public share files are written to.');
  if (!door) throw say('bad_input', 'This tool reads the shares through the run\'s records door.');
  if (typeof input.row_kind !== 'string' || !input.row_kind.startsWith('record:')) throw say('bad_input', 'row_kind is the record kind of the shared Lists\' rows, record:<the List\'s row_type>.');
  const result = await shareFiles({ origin: input.origin, now, shares: await readShares(door, input.row_kind), filterRows });
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
      bytes ??= await fileBytes(door, identity);
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
    wake_effects: at === null ? [] : [{ wake: { tool: TOOL, at_ms: at, input } }] };
}
