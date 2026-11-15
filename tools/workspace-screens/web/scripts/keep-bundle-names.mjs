// A bundler's short name need not identify its final emitted bytes: esbuild has
// emitted the same name with different bytes (a re-export stub whose imported
// chunk names changed kept its own name). Rename every emitted file by its final
// bytes before writing it: dependencies first, so a file's name covers the final
// names it imports. Files that import each other (a cycle) are named together by
// the bytes of the whole cycle. An unchanged file keeps its name across builds,
// a changed one gets a new name, and a name never stands for two contents.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const contentName = bytes => bytesToHex(blake3(bytes)).slice(0, 16);
const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder().decode(bytes);
// Files whose words can carry another emitted file's address; binary assets are named by their bytes alone.
const carriesAddresses = path => /\.(?:m?js|css|json|map)$/.test(path);
// The bundler's own name hash ('[name]-[hash]') is dropped; the meaning before it stays readable.
const stemOf = path => path.replace(/-[A-Z0-9]{8}(?=\.[^./]+$)/, '');

/** Files that import each other, dependencies first (Tarjan's order), over `edges`: path → paths it names. */
function cyclesDependenciesFirst(paths, edges) {
  const index = new Map(), low = new Map(), stack = [], onStack = new Set(), groups = [];
  let next = 0;
  const visit = start => {
    // Iterative, so a deep import chain cannot exhaust the call stack.
    const work = [[start, 0]];
    index.set(start, next); low.set(start, next); next += 1; stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const [path] = frame;
      const targets = edges.get(path);
      if (frame[1] < targets.length) {
        const target = targets[frame[1]++];
        if (!index.has(target)) {
          index.set(target, next); low.set(target, next); next += 1; stack.push(target); onStack.add(target);
          work.push([target, 0]);
        } else if (onStack.has(target)) low.set(path, Math.min(low.get(path), index.get(target)));
        continue;
      }
      work.pop();
      if (work.length) { const parent = work[work.length - 1][0]; low.set(parent, Math.min(low.get(parent), low.get(path))); }
      if (low.get(path) === index.get(path)) {
        const group = [];
        let member;
        do { member = stack.pop(); onStack.delete(member); group.push(member); } while (member !== path);
        groups.push(group.sort());
      }
    }
  };
  for (const path of paths) if (!index.has(path)) visit(path);
  return groups;
}

export function keepBundleNames(bundle, { root, outdir, publicPath }) {
  if (!bundle.outputFiles?.length || !bundle.metafile) throw new Error('Naming a bundle requires its unwritten files and graph.');
  const files = [...bundle.outputFiles].sort((a, b) => a.path.localeCompare(b.path));
  const pathOf = file => relative(resolve(outdir), file.path).split('\\').join('/');
  // Compared by segment, not as the literal parent path: a guard reaching this file would read that as the whole
  // repository (scripts/guard-selection.mjs), and every guard list edit would rerun it.
  if (files.some(file => pathOf(file).split('/')[0] === '..')) throw new Error('A bundle output leaves its declared folder.');
  const prefix = publicPath.endsWith('/') ? publicPath : `${publicPath}/`;
  const byPath = new Map(files.map(file => [pathOf(file), file]));
  // Every emitted file's address as the bundler wrote it; one pattern finds them all, longest first.
  const pattern = new RegExp([...byPath.keys()].map(path => prefix + path).sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const texts = new Map(files.filter(file => carriesAddresses(file.path)).map(file => [pathOf(file), decode(file.contents)]));
  const edges = new Map([...byPath.keys()].map(path => [path,
    texts.has(path) ? [...new Set([...texts.get(path).matchAll(pattern)].map(match => match[0].slice(prefix.length)))].sort() : []]));
  // Final name of each emitted file, decided dependencies first.
  const finalNames = new Map();
  const finalBytes = new Map();
  const rewrite = (path, inCycle) => texts.get(path).replace(pattern, address => {
    const target = address.slice(prefix.length);
    // Inside a cycle a member's own name is not known yet; its bundler address stands for it while the cycle is named.
    return inCycle.has(target) ? address : prefix + finalNames.get(target);
  });
  for (const group of cyclesDependenciesFirst([...byPath.keys()], edges)) {
    const members = new Set(group);
    const cyclic = group.length > 1 || edges.get(group[0]).includes(group[0]);
    if (!cyclic) {
      const [path] = group;
      const bytes = texts.has(path) ? encode(rewrite(path, members)) : byPath.get(path).contents;
      finalBytes.set(path, bytes);
      finalNames.set(path, stemOf(path).replace(/(\.[^./]+)$/, `-${contentName(bytes)}$1`));
      continue;
    }
    // A cycle is named by all its members' bytes (outside imports already final) and each member's place in it, so
    // a name still fixes its bytes: the same cycle bytes give the same names and the same final bytes.
    const digest = blake3.create();
    for (const path of group) {
      const bytes = texts.has(path) ? encode(rewrite(path, members)) : byPath.get(path).contents;
      digest.update(encode(JSON.stringify([path, bytes.length]) + '\n'));
      digest.update(bytes);
    }
    const cycle = bytesToHex(digest.digest());
    for (const path of group) finalNames.set(path, stemOf(path).replace(/(\.[^./]+)$/, `-${contentName(encode(`${cycle}\n${path}`))}$1`));
    for (const path of group) finalBytes.set(path, texts.has(path) ? encode(rewrite(path, new Set())) : byPath.get(path).contents);
  }
  // Two outputs may share a name only when their bytes are the same (two barrels that re-export only, say, both emit an
  // empty chunk): the name still fixes the bytes, and the one file serves both.
  const taken = new Map();
  const sameBytes = (a, b) => a.length === b.length && a.every((byte, at) => byte === b[at]);
  for (const [path, name] of finalNames) {
    if (taken.has(name) && !sameBytes(finalBytes.get(path), finalBytes.get(taken.get(name)))) throw new Error(`${path} and ${taken.get(name)} would both be named ${name}.`);
    if (!taken.has(name)) taken.set(name, path);
  }
  // Metafile paths may be relative to the bundler service's working directory
  // rather than absWorkingDir. Bind every metadata output to exactly one actual
  // emitted path, then return paths relative to this graph's declared root.
  const originalPaths = Object.keys(bundle.metafile.outputs);
  const originalOf = file => {
    const local = relative(root, file.path).split('\\').join('/');
    const matches = originalPaths.filter(path => path === local || path.endsWith('/' + local));
    if (matches.length !== 1) throw new Error(`The bundle does not identify one graph output for ${local}.`);
    return matches[0];
  };
  const names = new Map(files.map(file => [originalOf(file),
    relative(root, resolve(outdir, finalNames.get(pathOf(file)))).split('\\').join('/')]));
  const outputFiles = files.map(file => {
    const bytes = finalBytes.get(pathOf(file));
    const path = resolve(root, names.get(originalOf(file)));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return { path, contents: bytes, get text() { return decode(bytes); } };
  });
  const written = new Map(outputFiles.map(file => [relative(root, file.path).split('\\').join('/'), file]));
  const outputs = {};
  for (const [path, output] of Object.entries(bundle.metafile.outputs)) {
    const named = names.get(path);
    if (!named) throw new Error(`The bundle graph has no emitted bytes for ${path}.`);
    const row = { ...output, bytes: written.get(named).contents.length,
      imports: output.imports.map(row => ({ ...row, path: names.get(row.path) ?? row.path })),
      ...(output.cssBundle ? { cssBundle: names.get(output.cssBundle) ?? output.cssBundle } : {}) };
    // Outputs that share a name (the same bytes) are one file whose inputs are both outputs' inputs.
    const before = outputs[named];
    outputs[named] = before ? { ...row, inputs: { ...before.inputs, ...row.inputs },
      imports: [...before.imports, ...row.imports.filter(next => !before.imports.some(seen => seen.path === next.path && seen.kind === next.kind))],
      exports: [...new Set([...(before.exports ?? []), ...(row.exports ?? [])])] } : row;
  }
  return { ...bundle, outputFiles, metafile: { ...bundle.metafile, outputs } };
}
