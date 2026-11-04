// tools/move-code-between-trees/read-data/apply-move.mjs
//
// Carry out a plan (plan-move.mjs) on the two working copies: write each moved file in its new place (its bytes
// unchanged but for its import paths and swapped calls), delete it from the source so one copy remains, point the
// source files that stay at the destination package, move owner-index rows whose files all moved, and keep a receipt
// (moved-from.json) in every destination folder naming each file's source commit and both identities. Refuses before
// writing anything when a working copy's bytes differ from the commit the plan was made at.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { filesOf, MoveRefusal } from './code-tree.mjs';
import { aliasesOf, isCode, replaceRequests, requestsIn, targetOf } from './imports.mjs';
import { swapCalls } from './swap-calls.mjs';

const identity = bytes => makeHashCodeHexFromBytes(new Uint8Array(bytes));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

/** A moved file's new bytes from its source bytes: imports rewritten first (their places are in the source text), then calls swapped. */
export function movedBytes(sourceBytes, file, calls) {
  if (!file.import_changes && !file.swaps?.length) return sourceBytes;
  const text = replaceRequests(sourceBytes.toString('utf8'), file.import_changes ?? []);
  const used = new Set((file.swaps ?? []).map(hit => hit.id));
  return Buffer.from(swapCalls(text, calls.filter(row => used.has(row.id))).text, 'utf8');
}

// `only` names the groups to carry out now; the plan placed files over every group, so a file a later group shares
// still lands in the shared folder.
export function applyMove(plan, row, source, destination, { sourceFolder, destinationFolder, only = null }) {
  const moving = new Set(plan.groups.filter(group => !group.held.length).map(group => group.id));
  const chosen = only ? new Set(only.map(name => plan.groups.find(group => group.id === name || group.to === name)?.id ?? name)) : moving;
  const files = plan.files.filter(file => file.groups.every(id => moving.has(id)) && file.groups.some(id => chosen.has(id)));
  if (!files.length) return { moved: 0, reused: 0, deleted: 0, importers: 0, rows_moved: 0 };
  const landing = new Map(files.map(file => [file.from, file.to]));
  const calls = row.calls ?? [];

  // Nothing is written unless every file read from the source is unchanged in its working copy.
  const sameAsCommit = path => existsSync(join(sourceFolder, path)) && readFileSync(join(sourceFolder, path)).equals(source.read(path));
  const changed = [...files.map(file => file.from), ...plan.importers.map(item => item.path)].filter(path => !sameAsCommit(path));
  if (changed.length) throw new MoveRefusal('source_changed', `The source working copy differs from ${source.commit.slice(0, 10)} at ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''}: commit or set aside those changes, or plan at the working copy's commit.`);
  const taken = files.filter(file => !file.reused && existsSync(join(destinationFolder, file.to)));
  if (taken.length) throw new MoveRefusal('destination_taken', `The destination already has ${taken.map(file => file.to).slice(0, 5).join(', ')}: plan again against the destination's current commit.`);

  // 1. Each moved file in its new place, and its receipt.
  const receipts = new Map();
  for (const file of files) {
    const before = source.read(file.from);
    if (!file.reused) {
      const after = movedBytes(before, file, calls);
      const there = join(destinationFolder, file.to);
      mkdirSync(dirname(there), { recursive: true });
      writeFileSync(there, after);
      if (source.mode(file.from) === '100755') chmodSync(there, 0o755);
      file.identity = identity(after);
    } else file.identity = file.identity_here ?? file.source_identity;
    const folder = receiptFolder(file.to, plan, row);
    if (!receipts.has(folder)) receipts.set(folder, []);
    receipts.get(folder).push({ from: file.from, commit: source.commit, to: file.to, source_identity: file.source_identity, identity: file.identity, ...(file.reused ? { reused: true } : {}), ...(file.adapted ? { adapted: file.adapted } : {}), ...(file.swaps?.length ? { calls: file.swaps.map(hit => hit.id) } : {}), ...(file.reads_rows ? { reads_rows: file.reads_rows } : {}), ...(file.homes ? { homes: file.homes } : {}) });
  }
  for (const [folder, entries] of receipts) {
    const path = join(destinationFolder, folder, 'moved-from.json');
    const kept = existsSync(path) ? json(path) : { about: 'Files moved here byte for byte from another code tree by tools/move-code-between-trees: each names its source path and commit, the identity of its source bytes and of its bytes here. Only import paths and the listed calls differ.', source: row.source?.name ?? null, package: row.destination?.package ?? null, calls: [], files: [] };
    const usedCalls = new Set(entries.flatMap(entry => entry.calls ?? []));
    for (const call of calls.filter(item => usedCalls.has(item.id))) if (!kept.calls.some(item => item.id === call.id)) kept.calls.push(call);
    // A file written here replaces the entry for its place; a file found home already here (moved by an earlier move)
    // keeps that move's entry, and is named again only as what this move's files import.
    const keyOf = entry => (entry.reused ? `${entry.to}\u0000${entry.commit}\u0000${entry.from}` : entry.to);
    const byTo = new Map(kept.files.map(entry => [keyOf(entry), entry]));
    for (const entry of entries) {
      if (entry.reused && kept.files.some(other => other.to === entry.to && other.commit === entry.commit && other.from === entry.from)) continue;
      byTo.set(keyOf(entry), entry);
    }
    kept.files = [...byTo.values()].sort((a, b) => a.to.localeCompare(b.to));
    writeJson(path, kept);
    describeFolder(destinationFolder, folder, row, plan);
  }

  // 2. One copy: the originals leave the source.
  for (const file of files) rmSync(join(sourceFolder, file.from));

  // 3. Source files that stay import the moved files from the destination package.
  for (const item of plan.importers) {
    const changes = item.changes.filter(change => landing.has(change.target));
    if (!changes.length) continue;
    const path = join(sourceFolder, item.path);
    writeFileSync(path, replaceRequests(readFileSync(path, 'utf8'), changes));
  }

  // A planned file whose group waits for a later lane stays for now, and imports what moved from the package too.
  const alias = aliasesOf(source.exists('package.json') ? JSON.parse(source.read('package.json').toString('utf8')) : {});
  for (const file of plan.files.filter(item => !landing.has(item.from) && isCode(item.from))) {
    const path = join(sourceFolder, file.from);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const changes = requestsIn(text).map(item => ({ ...item, target: targetOf(file.from, item.specifier, source.exists, alias) }))
      .filter(item => item.target && landing.has(item.target))
      .map(item => item.how === 'url'
        ? { start: item.whole[0], end: item.whole[1], specifier: `new URL(import.meta.resolve('${plan.destination.package}/${landing.get(item.target)}'))` }
        : { start: item.start, end: item.end, specifier: `${plan.destination.package}/${landing.get(item.target)}` });
    if (changes.length) writeFileSync(path, replaceRequests(text, changes));
  }

  // 4. Owner-index rows follow their files.
  const rowsMoved = moveOwnerRows(row, source, landing, { sourceFolder, destinationFolder });

  // 5. Packages the moved files import that the destination does not declare yet.
  // Only the packages the files moved now import: a group that waits brings its own later.
  const wanted = new Set(files.flatMap(file => file.packages ?? []));
  const added = Object.entries(plan.packages_to_add ?? {}).filter(([name]) => wanted.has(name));
  if (added.length) {
    const path = join(destinationFolder, 'package.json');
    const manifest = json(path);
    manifest.dependencies = Object.fromEntries(Object.entries({ ...manifest.dependencies, ...Object.fromEntries(added) }).sort(([a], [b]) => a.localeCompare(b)));
    writeJson(path, manifest);
  }
  return { moved: files.filter(file => !file.reused).length, reused: files.filter(file => file.reused).length, deleted: files.length, importers: plan.importers.length, rows_moved: rowsMoved, packages_added: added.map(([name]) => name) };
}

// The destination folder whose receipt names a file: its group's folder, or the shared folder.
function receiptFolder(to, plan, row) {
  const shared = plan.destination.shared_folder;
  if (to.startsWith(`${shared}/`)) return shared;
  const group = plan.groups.find(item => to.startsWith(`${item.to}/`));
  return group ? group.to : posix.dirname(to);
}

// A destination folder that had no tool row and no part.json becomes a part another tree imports.
function describeFolder(destinationFolder, folder, row, plan) {
  const part = join(destinationFolder, folder, 'part.json');
  if (existsSync(join(destinationFolder, folder, 'tool-rows.json')) || existsSync(part)) return;
  writeJson(part, { imported_by: [row.source?.name ?? 'the source tree'] });
  const readme = join(destinationFolder, folder, 'README.md');
  if (existsSync(readme)) return;
  const group = plan.groups.find(item => item.to === folder);
  writeFileSync(readme, `# ${folder}/\n\n${group?.capability ? `${group.capability[0].toUpperCase()}${group.capability.slice(1)}.\n\n` : 'Files more than one moved group imports, kept once.\n\n'}`
    + `Moved here byte for byte from ${row.source?.name ?? 'another code tree'} by \`tools/move-code-between-trees\`; \`moved-from.json\` names each file's source path and commit and the identity of its bytes there and here. `
    + `${row.source?.name ?? 'The source tree'} imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.\n`);
}

function moveOwnerRows(row, source, landing, { sourceFolder, destinationFolder }) {
  const from = row.source?.owner_index;
  const to = row.destination?.owner_index;
  if (!from) return 0;
  const sourcePath = join(sourceFolder, from.file);
  if (!existsSync(sourcePath)) return 0;
  const index = json(sourcePath);
  const ownerKey = from.owner ?? 'owner';
  const entryKey = from.entry ?? 'entry';
  const evidenceKey = from.evidence ?? 'evidence';
  const leaving = [];
  const staying = [];
  for (const item of index[from.rows]) {
    const owners = item[ownerKey] ?? [];
    const remaining = owners.filter(glob => { const matched = filesOf(source, [glob]); return !matched.length || matched.some(path => !landing.has(path)); });
    if (remaining.length === owners.length) { staying.push(item); continue; }
    if (!remaining.length) { leaving.push(item); continue; }
    const next = { ...item, [ownerKey]: remaining };
    if (landing.has(item[entryKey])) next[entryKey] = filesOf(source, remaining).find(path => !landing.has(path)) ?? remaining[0];
    next[evidenceKey] = evidenceAfter(item[evidenceKey], landing, row);
    staying.push(next);
  }
  if (!leaving.length && staying.every((item, at) => item === index[from.rows][at])) return 0;
  index[from.rows] = staying;
  writeIndex(sourcePath, index, from.rows);
  if (to && leaving.length) {
    const destinationPath = join(destinationFolder, to.file);
    const target = json(destinationPath);
    const allowed = to.fields ?? null;
    for (const item of leaving) {
      if (target[to.rows].some(other => other[ownerKey] && other.capability === item.capability)) continue;
      const files = filesOf(source, item[ownerKey]).map(path => landing.get(path)).filter(Boolean);
      const moved = { ...item, [ownerKey]: [...new Set(files)].sort(), [entryKey]: landing.get(item[entryKey]) ?? files[0], [evidenceKey]: evidenceAfter(item[evidenceKey], landing, row, true) };
      for (const field of from.drop_fields ?? []) delete moved[field];
      target[to.rows].push(allowed ? Object.fromEntries(Object.entries(moved).filter(([key]) => allowed.includes(key))) : moved);
    }
    writeIndex(destinationPath, target, to.rows);
  }
  return leaving.length;
}

// Evidence of the form `path:line` names the file where it now is; in the tree it left, it says so in words.
function evidenceAfter(evidence, landing, row, here = false) {
  const match = typeof evidence === 'string' && evidence.match(/^([^\s:]+):(\d+)$/);
  if (!match || !landing.has(match[1])) return evidence;
  return here ? `${landing.get(match[1])}:${match[2]}` : `It moved to ${row.destination?.package ?? 'the destination'} at ${landing.get(match[1])} line ${match[2]}.`;
}

// An owner index is written back in its own layout: each row that stays keeps its own text, rows that left go, a
// changed row and a new row are written on one line the way its one-line rows are, and every byte outside the rows
// stays. If its text cannot be read that way it is written as plain indented JSON.
function writeIndex(path, value, rowsKey) {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const spans = before ? rowSpans(before, rowsKey) : null;
  if (!spans) return writeJson(path, value);
  const { open, close, items, indent } = spans;
  const oneLine = items.filter(item => !item.text.includes('\n')).at(-1);
  const style = { pad: oneLine && /^\{ /.test(oneLine.text) ? ' ' : '' };
  const unused = new Map();
  for (const item of items) { const key = JSON.stringify(item.row); unused.set(key, [...(unused.get(key) ?? []), item]); }
  const out = value[rowsKey].map(row => {
    const same = unused.get(JSON.stringify(row))?.shift();
    return same ? same.text : inline(row, style);
  });
  const text = `${before.slice(0, open + 1)}${out.length ? `\n${out.map(item => `${indent}${item}`).join(',\n')}` : ''}${before.slice(close)}`;
  let check;
  try { check = JSON.parse(text); } catch { return writeJson(path, value); }
  if (JSON.stringify(check) !== JSON.stringify(value)) return writeJson(path, value);
  writeFileSync(path, text);
}

// Where the rows of `key` sit in the text: the array's [ and the whitespace before its ], and each row's own text.
function rowSpans(text, key) {
  const found = new RegExp(`^\\s*${JSON.stringify(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*\\[`, 'm').exec(text);
  if (!found) return null;
  const open = found.index + found[0].length - 1;
  const items = [];
  let at = open + 1;
  const space = () => { while (/\s/.test(text[at] ?? '')) at += 1; };
  for (;;) {
    space();
    if (text[at] === ']') break;
    const start = at;
    let depth = 0;
    for (; at < text.length; at += 1) {
      const ch = text[at];
      if (ch === '"') { for (at += 1; text[at] !== '"'; at += 1) if (text[at] === '\\') at += 1; continue; }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') { depth -= 1; if (depth === 0) { at += 1; break; } }
    }
    const piece = text.slice(start, at);
    let row;
    try { row = JSON.parse(piece); } catch { return null; }
    const lineStart = text.lastIndexOf('\n', start) + 1;
    items.push({ row, text: piece, indent: text.slice(lineStart, start), end: at });
    space();
    if (text[at] === ',') { at += 1; continue; }
    if (text[at] !== ']') return null;
    break;
  }
  if (!items.length) return null;
  return { open, close: items.at(-1).end, items, indent: /^\s*$/.test(items[0].indent) ? items[0].indent : '    ' };
}

const inline = (value, style) => {
  if (Array.isArray(value)) return `[${value.map(item => inline(item, style)).join(', ')}]`;
  if (value && typeof value === 'object') return `{${style.pad}${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${inline(item, style)}`).join(', ')}${style.pad}}`;
  return JSON.stringify(value);
};
