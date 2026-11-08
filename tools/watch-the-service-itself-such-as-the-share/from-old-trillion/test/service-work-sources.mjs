// The retained guard's own test-source audit. The canonical Git inventory supplies exact objects, including in a non-worktree pushed
// candidate. Missing owners/history, symlink entries, empty scopes and failed reads are errors, never zero calls.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import configuration from './service-work-sources.json' with { type: 'json' };

const git = (root, args, input) => execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  input, timeout: 60_000, maxBuffer: 256 * 1024 ** 2, stdio: ['pipe', 'pipe', 'pipe'],
});
const identity = text => String(text).trim().replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
const live = path => !path.split('/').some(part => configuration.excluded_parts.includes(part))
  && !/\.test\./.test(path) && /\.(?:mjs|js|ts|tsx|json|rs)$/.test(path);

function packageRoot(start) {
  for (let folder = resolve(start);;) {
    const file = join(folder, 'package.json');
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === configuration.current_package) return realpathSync(folder);
    const parent = dirname(folder);
    if (parent === folder) throw new Error('The guard has no declared source package');
    folder = parent;
  }
}
function context(start) {
  const sourceRoot = packageRoot(start);
  try { return { root: git(sourceRoot, ['rev-parse', '--show-toplevel']).toString().trim() }; }
  catch (error) {
    for (let folder = sourceRoot; dirname(folder) !== folder; folder = dirname(folder)) {
      if (basename(folder) !== '.git') continue;
      const root = dirname(folder);
      const inside = relative(realpathSync(folder), sourceRoot);
      const marker = join(dirname(sourceRoot), 'last-synced-tree');
      if (inside.startsWith(`..${sep}`) || isAbsolute(inside) || basename(sourceRoot) !== 'tree' || !existsSync(marker)) break;
      const tree = readFileSync(marker, 'utf8').trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree) || git(root, ['rev-parse', `${tree}^{tree}`]).toString().trim() !== tree) throw new Error('The candidate has no canonical tree descriptor');
      return { root, tree };
    }
    throw new Error(`Source is neither a checkout nor a canonical candidate: ${error.message}`);
  }
}
function sourceRoot(base, repository) {
  const root = join(dirname(base), repository.split('/').at(-1));
  if (!existsSync(join(root, '.git')) || identity(git(root, ['remote', 'get-url', 'origin']).toString()) !== repository) throw new Error(`The declared source owner is unavailable: ${repository}`);
  return root;
}
function recordsFor(owner) {
  if (identity(git(owner.root, ['remote', 'get-url', 'origin']).toString()) !== owner.repository) throw new Error(`The source root is not ${owner.repository}`);
  const tree = owner.tree ?? git(owner.root, ['rev-parse', 'HEAD^{tree}']).toString().trim();
  const entries = git(owner.root, ['ls-tree', '-rz', '--full-tree', tree, '--', ...owner.folders]).toString().split('\0').filter(Boolean).map(line => {
    const match = line.match(/^(\d+) blob ([a-f0-9]+)\t(.+)$/s);
    if (!match) throw new Error('A source inventory entry is not a blob');
    return { mode: match[1], blob: match[2], path: match[3] };
  }).filter(entry => live(entry.path));
  if (!entries.length) throw new Error(`The maintained source scope is empty: ${owner.repository}`);
  if (entries.some(entry => !['100644', '100755'].includes(entry.mode))) throw new Error('A live source entry is a symlink or unsupported mode');
  for (const anchor of owner.anchors) if (!entries.some(entry => entry.path === anchor)) throw new Error(`The source anchor is unavailable: ${owner.repository}:${anchor}`);
  if (owner.capabilities) {
    const registry = JSON.parse(git(owner.root, ['show', `${tree}:${owner.capabilities}`]).toString());
    const declared = [];
    const entrypoints = [];
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value.owner)) declared.push(...value.owner.filter(path => typeof path === 'string'));
      if (typeof value.entry === 'string' && Array.isArray(value.owner) && value.owner.some(path => value.entry === path.replace(/\/$/, '') || value.entry.startsWith(`${path.replace(/\/$/, '')}/`))) entrypoints.push(value.entry);
      for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
    };
    visit(registry);
    if (owner.require_entry && !entrypoints.some(path => /\.(?:mjs|js|ts|tsx|rs)$/.test(path) && entries.some(entry => entry.path === path))) throw new Error(`The source has no maintained capability entrypoint: ${owner.repository}`);
    for (const anchor of owner.anchors) if (!declared.some(path => anchor === path.replace(/\/$/, '') || anchor.startsWith(`${path.replace(/\/$/, '')}/`))) throw new Error(`The capability registry does not own ${owner.repository}:${anchor}`);
  }
  const output = git(owner.root, ['cat-file', '--batch'], entries.map(entry => entry.blob).join('\n') + '\n');
  let offset = 0;
  return entries.map(entry => {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString().match(/^([a-f0-9]+) blob (\d+)$/);
    if (!header || header[1] !== entry.blob) throw new Error('A canonical source blob could not be read');
    const size = Number(header[2]);
    const bytes = output.subarray(end + 1, end + 1 + size);
    if (bytes.length !== size || output[end + 1 + size] !== 10) throw new Error('A canonical source blob was truncated');
    offset = end + 2 + size;
    return { ...entry, text: bytes.toString('utf8'), key: owner.legacy_keys?.[entry.path] ?? `${owner.repository}:${entry.path}`, repository: owner.repository, revision: tree };
  });
}

export function maintainedServiceSources(start = fileURLToPath(new URL('..', import.meta.url))) {
  const selected = context(start);
  return configuration.sources.flatMap(source => recordsFor({ ...source,
    ...(source.repository === configuration.current_repository ? selected : { root: sourceRoot(selected.root, source.repository) }),
  }));
}
export function serviceWorkHistory(args, start = fileURLToPath(new URL('..', import.meta.url))) {
  const selected = context(start);
  return git(sourceRoot(selected.root, configuration.history_repository), args).toString();
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'audit') throw new Error('Use audit with an optional canonical package root');
  const sources = maintainedServiceSources(process.argv[3]);
  console.log(JSON.stringify({ files: sources.length, revisions: Object.fromEntries(sources.map(source => [source.repository, source.revision])) }));
}
