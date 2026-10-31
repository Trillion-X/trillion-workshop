// tools/pin-files-by-content/read-data/pins.mjs
//
// Purpose: keep a folder's pin file in step with its files. A pin file names each DATA file a program reads and
// records the file's byte count and BLAKE3, so the program can refuse a file whose bytes changed after it was pinned
// (an engine reading its product DATA, for one). `check` says what differs; `write` brings the pins up to the files.
//
// Non-Negotiable Invariants:
//   1. The hash is the content-identity owner's BLAKE3 of the exact bytes (tools/content-identity), written as the pin
//      file's shape says (bare hex by default, the way a b3sum or blake3 crate check compares it).
//   2. A write changes only the entries: every other key of the pin file is kept as it is, entries keep their order, and
//      new entries follow in name order, so a write changes only the lines of what changed.
//   3. Nothing outside `root` is read or written; every path is resolved and refused when it leaves `root`.
//   4. The pin file's shape is DATA (pin-shape.json, or the caller's `shape`): where the entries are, the keys of an
//      entry, how a file's name is made, and how the hash is written. No program or file is named here.
//
//   pinFiles({ root, pin_file, folder, match?, unpinned_ok?, shape?, write? })
//     → { ok, pinned, added: [name], changed: [name], gone: [name], unchanged, written }
import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import defaults from './pin-shape.json' with { type: 'json' };

const say = words => Object.assign(new Error(words), { code: 'bad_input' });

async function inside(root, path) {
  const base = await realpath(root);
  const real = await realpath(path).catch(() => join(base, relative(base, path)));
  if (real !== base && !real.startsWith(base + sep)) throw say(`${path} is not inside ${root}.`);
  return real;
}

// A glob over a path relative to the folder: `*` stays inside one folder, `**` crosses folders.
function globTest(glob) {
  if (!glob) return () => true;
  const pattern = glob.split('**').map(part => part.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  const expression = new RegExp(`^${pattern}$`);
  return path => expression.test(path);
}

// Every file under `folder`, as a path relative to it written with `/`, in name order. Folders whose names start
// with `.` are left out.
async function filesUnder(folder) {
  const found = [];
  const walk = async (path, prefix) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) found.push(`${prefix}${entry.name}`);
    }
  };
  await walk(folder, '');
  return found.sort();
}

const nameOf = (path, rule) => (rule.strip_extension ? path.replace(/\.[^./]+$/, '') : path);
const hashOf = (bytes, rule) => {
  const identity = makeHashCodeHexFromBytes(bytes);
  return rule.hash_form === 'identity' ? identity : identity.slice(identity.indexOf(':') + 1);
};

export async function pinFiles({ root, pin_file, folder, match, unpinned_ok = [], shape = {}, write = false } = {}) {
  if (typeof root !== 'string' || !root.startsWith('/')) throw say('root must be the absolute path of the folder.');
  if (typeof pin_file !== 'string' || typeof folder !== 'string') throw say('pin_file and folder are paths under root.');
  const rule = { ...defaults.shape, ...shape };
  const pinPath = await inside(root, join(root, pin_file));
  const folderPath = await inside(root, join(root, folder));
  const held = JSON.parse(await readFile(pinPath, 'utf8'));
  const entries = held[rule.entries_at] ?? {};
  const fits = globTest(match);
  const skip = new Set(unpinned_ok);
  const files = (await filesUnder(folderPath)).filter(path => fits(path) && !skip.has(path));
  const next = {}, added = [], changed = [];
  let unchanged = 0;
  for (const path of files) {
    const bytes = await readFile(join(folderPath, path));
    const name = nameOf(path, rule);
    const pin = { [rule.bytes_key]: bytes.length, [rule.hash_key]: hashOf(bytes, rule) };
    const before = entries[name];
    if (!before) added.push(name);
    else if (before[rule.path_key] !== path || before[rule.pin_key]?.[rule.bytes_key] !== pin[rule.bytes_key] || before[rule.pin_key]?.[rule.hash_key] !== pin[rule.hash_key]) changed.push(name);
    else unchanged += 1;
    next[name] = { ...(before ?? {}), [rule.path_key]: path, [rule.pin_key]: pin };
  }
  const gone = Object.keys(entries).filter(name => !(name in next)).sort();
  const ok = !added.length && !changed.length && !gone.length;
  let written = false;
  if (write && !ok) {
    // Entries keep the order the pin file has them in; new ones follow in name order, so a write changes only the lines
    // of what changed.
    const order = [...Object.keys(entries).filter(name => name in next), ...added.slice().sort()];
    const ordered = Object.fromEntries(order.map(name => [name, next[name]]));
    await writeFile(pinPath, `${JSON.stringify({ ...held, [rule.entries_at]: ordered }, null, rule.indent)}\n`);
    written = true;
  }
  return { ok, pinned: files.length, added, changed, gone, unchanged, written };
}
