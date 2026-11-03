// tools/move-code-between-trees/read-data/plan-move.mjs
//
// What a move would do, worked out before anything is written: for each group, the files its owner rows name and every
// file they import (the import closure), the tests that move with them, where each file lands (its group's folder, or
// the shared folder when more than one group needs it), how each import must then be written, which provider calls are
// swapped by which row, which remain, and which files of the source keep importing a moved file. Every choice comes
// from the move row; nothing here names a repository, a group or a provider.
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { filesOf, globMatches, MoveRefusal } from './code-tree.mjs';
import { aliasesOf, isCode, isRelative, requestFor, requestsIn, targetOf } from './imports.mjs';
import { swapCalls, providerCallsLeft } from './swap-calls.mjs';

const TEST_FILE = /\.test\.(?:mjs|cjs|js|ts|tsx|mts)$/;
export const packageOf = name => name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/');

/** The groups a move row names: its own `groups`, plus one per row of the source's owner index that names a destination. */
export function groupsOf(row, tree) {
  const groups = [...(row.groups ?? [])];
  const from = row.groups_from;
  if (from) {
    const index = JSON.parse(tree.read(from.index).toString('utf8'));
    for (const item of index[from.rows] ?? []) {
      const to = item[from.to];
      if (typeof to !== 'string' || !to) continue;
      groups.push({ id: to.split('/').pop(), owner: item[from.owner], to, capability: item[from.label ?? 'capability'] });
    }
  }
  const only = row.only ? new Set(row.only) : null;
  return groups.filter(group => !only || only.has(group.id) || only.has(group.to));
}

/** The plan. `source` and `destination` are trees read at a commit (code-tree.mjs openTreeAt). */
export function planMove(row, source, destination) {
  const keep = row.keep ?? [];
  const kept = path => keep.find(glob => globMatches(path, glob));
  // Content a moved file imports that becomes rows of the person's lists: it stays in the source, is not followed or
  // moved, and holds nothing; the moved file reads those rows from its caller once adapted.
  const asRows = row.read_as_rows ?? [];
  const readAsRows = path => asRows.some(glob => globMatches(path, glob));
  const swaps = row.calls ?? [];
  const detectors = row.provider_calls ?? [];
  const shared = row.destination?.shared_folder;
  if (!shared) throw new MoveRefusal('row_incomplete', 'The move row names no destination.shared_folder: say which folder holds files more than one group imports.');
  const packageName = row.destination?.package;
  const testFolders = row.source?.test_folders ?? [];

  source.readMany([...source.files].filter(isCode));
  const text = path => source.read(path).toString('utf8');
  const alias = aliasesOf(source.exists('package.json') ? JSON.parse(text('package.json')) : {});
  const requests = new Map();
  const requestsOf = path => {
    if (!requests.has(path)) requests.set(path, isCode(path) ? requestsIn(text(path)).map(item => ({ ...item, target: targetOf(path, item.specifier, source.exists, alias) })) : []);
    return requests.get(path);
  };
  const closureOf = roots => {
    const found = new Set();
    const stack = [...roots];
    while (stack.length) {
      const path = stack.pop();
      if (found.has(path) || !source.exists(path) || readAsRows(path)) continue;
      found.add(path);
      for (const item of requestsOf(path)) if (item.target) stack.push(item.target);
    }
    return found;
  };

  // 1. Each group's files and closure, and whether it reaches a file that must stay.
  const groups = groupsOf(row, source).map(group => {
    const roots = filesOf(source, group.owner ?? []);
    const held = [];
    if (!roots.length) held.push(`its owner rows name no file at ${source.commit.slice(0, 10)}: it has moved already or its rows are stale`);
    const closure = closureOf(roots);
    // A destination folder that is already a tool holds this feature in its own shape: a second copy is not made.
    if (destination.exists(posix.join(group.to, 'tool-rows.json'))) held.push(`${group.to} is already a tool in the destination; delete the source's copy where that tool replaces it, instead of moving a second copy`);
    for (const path of closure) {
      const glob = kept(path);
      if (glob) held.push(`${roots.includes(path) ? 'it owns' : 'it imports'} ${path}, which stays in the source (keep row ${glob})`);
    }
    const readsRows = [...closure].flatMap(path => requestsOf(path).filter(item => item.target && readAsRows(item.target)).map(item => ({ file: item.target, by: path })));
    return { ...group, roots, closure, tests: [], held, readsRows };
  });
  const moving = () => groups.filter(group => !group.held.length);

  // 2. Tests that move: every file they reach moves, or is test help in a test folder; they reach a moving group's file.
  const inTestFolder = path => testFolders.some(folder => path.startsWith(`${folder.replace(/\/+$/, '')}/`));
  const movingFiles = new Set(moving().flatMap(group => [...group.closure]));
  for (const path of [...source.files].filter(file => TEST_FILE.test(file) && inTestFolder(file)).sort()) {
    if (movingFiles.has(path)) continue;
    const reach = closureOf([path]);
    const owner = moving().find(group => group.roots.some(root => reach.has(root)));
    if (!owner) continue;
    if ([...reach].every(file => movingFiles.has(file) || (inTestFolder(file) && !kept(file)))) owner.tests.push({ path, reach });
  }
  for (const group of moving()) for (const test of group.tests) for (const file of test.reach) group.closure.add(file);

  // 3. Where each file lands, once: a file only one group needs goes in that group's folder, else in the shared one.
  const needed = new Map();
  for (const group of moving()) for (const path of group.closure) needed.set(path, [...(needed.get(path) ?? []), group.id]);
  const byId = new Map(groups.map(group => [group.id, group]));
  const landing = new Map();
  for (const [path, ids] of needed) landing.set(path, posix.join(ids.length === 1 ? byId.get(ids[0]).to : shared, path));

  // A file the destination already holds byte for byte, and that imports nothing of its own, is not copied again.
  const reused = new Map();
  const destinationByIdentity = new Map();
  const leaves = [...landing.keys()].filter(path => !requestsOf(path).some(item => isRelative(item.specifier)));
  const leafNames = new Set(leaves.map(path => posix.basename(path)));
  const candidates = [...destination.files].filter(path => leafNames.has(posix.basename(path)));
  destination.readMany(candidates);
  for (const path of candidates) {
    const identity = makeHashCodeHexFromBytes(new Uint8Array(destination.read(path)));
    if (!destinationByIdentity.has(identity)) destinationByIdentity.set(identity, path);
  }
  for (const path of leaves) {
    const there = destinationByIdentity.get(makeHashCodeHexFromBytes(new Uint8Array(source.read(path))));
    if (there) { reused.set(path, there); landing.set(path, there); }
  }

  // 4. Each moved file's new bytes: imports written for the new places, and provider calls swapped.
  const files = new Map();
  const destinationPackage = destination.exists('package.json') ? JSON.parse(destination.read('package.json').toString('utf8')) : {};
  const declared = { ...destinationPackage.dependencies, ...destinationPackage.devDependencies, ...destinationPackage.peerDependencies };
  const sourcePackage = source.exists('package.json') ? JSON.parse(text('package.json')) : {};
  const sourceVersions = { ...sourcePackage.devDependencies, ...sourcePackage.dependencies };
  const packagesToAdd = new Map();
  for (const [path, to] of landing) {
    const owners = needed.get(path);
    const plan = { from: path, to, groups: owners, reused: reused.has(path), source_identity: makeHashCodeHexFromBytes(new Uint8Array(source.read(path))) };
    if (!reused.has(path) && destination.exists(to)) {
      for (const id of owners) byId.get(id).held.push(`${to} is already in the destination with other bytes`);
    }
    if (isCode(path) && !reused.has(path)) {
      const changes = [];
      for (const item of requestsOf(path)) {
        if (item.target && landing.has(item.target)) {
          // A tree's own import name means nothing in the other tree: it becomes the path, ending and all.
          const written = item.specifier.startsWith('#') ? item.target : item.specifier;
          const specifier = requestFor(to, landing.get(item.target), written, item.target);
          if (specifier !== item.specifier) changes.push({ start: item.start, end: item.end, specifier, was: item.specifier });
        } else if (packageName && item.specifier.startsWith(`${packageName}/`) && destination.exists(item.specifier.slice(packageName.length + 1))) {
          // A file that already imports a moved file through the destination package imports it by path once it is there too.
          const there = item.specifier.slice(packageName.length + 1);
          changes.push({ start: item.start, end: item.end, specifier: requestFor(to, there, there, there), was: item.specifier });
        } else if (!isRelative(item.specifier) && !item.specifier.startsWith('#') && !item.specifier.startsWith('node:') && !builtinModules.includes(item.specifier) && item.how !== 'url') {
          const name = packageOf(item.specifier);
          if (!declared[name] && name !== packageName) packagesToAdd.set(name, sourceVersions[name] ?? null);
        }
      }
      plan.import_changes = changes;
      const rowsRead = requestsOf(path).filter(item => item.target && readAsRows(item.target)).map(item => item.target);
      if (rowsRead.length) plan.reads_rows = [...new Set(rowsRead)];
      const swapped = swapCalls(text(path), swaps);
      plan.swaps = swapped.hits;
      const left = providerCallsLeft(swapped.text, detectors);
      for (const hit of left) for (const id of owners) byId.get(id).held.push(`${to}:${hit.line} still calls ${hit.id} (${hit.found}); add a swap row for it in calls`);
    }
    files.set(path, plan);
  }
  for (const [name, version] of packagesToAdd) {
    if (version === null) for (const group of moving()) if ([...group.closure].some(path => requestsOf(path).some(item => packageOf(item.specifier) === name))) group.held.push(`it imports the package ${name}, which neither tree declares`);
  }

  // 5. Files that stay in the source and import a moved file: they import it from the destination package instead.
  const movedSet = new Set(landing.keys());
  const importers = [];
  const names = new Set([...movedSet].map(path => posix.basename(path).replace(/\.[^.]+$/, '')));
  for (const path of [...source.files].filter(isCode)) {
    if (movedSet.has(path)) continue;
    const body = text(path);
    if (![...names].some(name => body.includes(name))) continue;
    const changes = [];
    for (const item of requestsOf(path)) {
      if (!item.target || !movedSet.has(item.target)) continue;
      if (!packageName) {
        for (const group of moving()) if (group.closure.has(item.target)) group.held.push(`${path} stays and imports ${item.target}, and the row names no destination.package to import it from`);
        continue;
      }
      const named = `${packageName}/${landing.get(item.target)}`;
      // A file read by its address beside this one (new URL('<path>', import.meta.url)) is found through the package.
      if (item.how === 'url') changes.push({ start: item.whole[0], end: item.whole[1], specifier: `new URL(import.meta.resolve('${named}'))`, was: item.specifier, target: item.target });
      else changes.push({ start: item.start, end: item.end, specifier: named, was: item.specifier, target: item.target });
    }
    if (changes.length) importers.push({ path, changes });
  }

  const result = {
    move: row.id,
    source: { commit: source.commit },
    destination: { commit: destination.commit, shared_folder: shared, package: packageName ?? null },
    groups: groups.map(summary),
    files: [...files.values()].sort((a, b) => a.from.localeCompare(b.from)),
    importers,
    packages_to_add: Object.fromEntries([...packagesToAdd].filter(([, version]) => version !== null)),
  };
  // A group held after placement (a collision, a provider call left, a staying reader) gives back its files: planning
  // again without it settles which files the shared folder still needs. Each pass holds at least one more group.
  if (result.files.some(file => file.groups.some(id => byId.get(id).held.length))) {
    const narrowed = { ...row, groups: groups.filter(group => !group.held.length).map(({ id, owner, to, capability }) => ({ id, owner, to, capability })), groups_from: undefined, only: undefined };
    const again = planMove(narrowed, source, destination);
    again.groups.push(...groups.filter(group => group.held.length).map(summary));
    return again;
  }
  return result;
}

function summary(group) {
  return {
    id: group.id,
    to: group.to,
    ...(group.capability ? { capability: group.capability } : {}),
    owner_files: group.roots,
    closure_count: group.closure.size,
    tests: group.tests.map(test => test.path),
    ...(group.readsRows?.length ? { reads_rows: group.readsRows } : {}),
    held: [...new Set(group.held)],
  };
}
