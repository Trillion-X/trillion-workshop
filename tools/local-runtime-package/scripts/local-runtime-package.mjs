// The build-time package of the existing local launcher, not another runtime,
// state store, installer or code-admission owner. Never archive the working tree.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localNetworkProfile } from '../../shared-code/scripts/local-only-options.mjs';
import { localRuntimeTree } from './local-runtime-tree.mjs';
export { localRuntimeTree } from './local-runtime-tree.mjs';

const git = (source, args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', maxBuffer: 4 << 20 }).trim();
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const safeRelative = name => typeof name === 'string' && name.length > 0 && !path.isAbsolute(name)
  && name.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
const receiptName = 'local-runtime-build-receipt.json';

function packageRules(source, commit) {
  const rules = JSON.parse(git(source, ['show', `${commit}:macos/local-runtime-package.json`]));
  const excluded = new Set(['operator-account.json', 'test', 'proof', 'dev', 'docs']);
  if (rules.version !== 'trillion.local-runtime-package/v1'
    || !Array.isArray(rules.source_roots) || !rules.source_roots.length
    || !rules.source_roots.every(name => safeRelative(name) && !name.includes('/') && !excluded.has(name))
    || new Set(rules.source_roots).size !== rules.source_roots.length
    || !Array.isArray(rules.required_outputs) || !rules.required_outputs.every(name => safeRelative(name) && name.startsWith('built/'))
    || !Array.isArray(rules.dependency_exclusions) || !rules.dependency_exclusions.every(name => /^\.[a-z-]+$/.test(name) && !['.bin', '.package-lock.json'].includes(name))
    || !['max_files', 'max_bytes', 'reserve_bytes', 'build_timeout_ms'].every(name => Number.isSafeInteger(rules[name]) && rules[name] > 0))
    throw new Error('Declare the bounded product source package.');
  return rules;
}

function checkInstalledLock(dependencies, expected, rules) {
  const installed = JSON.parse(fs.readFileSync(path.join(dependencies, '.package-lock.json'), 'utf8'));
  if (installed.lockfileVersion !== expected.lockfileVersion || !installed.packages || !expected.packages)
    throw new Error('The installed dependencies do not match this source lock.');
  for (const [name, actual] of Object.entries(installed.packages)) {
    const wanted = expected.packages[name];
    if (!name.startsWith('node_modules/') || !wanted || ['version', 'resolved', 'integrity', 'link'].some(field => actual[field] !== wanted[field]))
      throw new Error('The installed dependencies do not match this source lock.');
  }
  // Refuse extra top-level content absent from npm's installed tree. Package
  // file bytes are pinned below; lock metadata alone is not registry verification.
  for (const name of fs.readdirSync(dependencies)) {
    if (rules.dependency_exclusions.includes(name)) continue;
    if (name === '.bin' || name === '.package-lock.json') continue;
    const names = name.startsWith('@') ? fs.readdirSync(path.join(dependencies, name)).map(child => `${name}/${child}`) : [name];
    if (names.some(name => !Object.hasOwn(installed.packages, `node_modules/${name}`)))
      throw new Error('The installed dependency tree contains undeclared content.');
  }
  return { count: Object.keys(installed.packages).length,
    selected: fs.readdirSync(dependencies).filter(name => !rules.dependency_exclusions.includes(name)) };
}

export function prepareLocalRuntimePackage({ source, ref, output, dependencies = path.join(source, 'node_modules') }) {
  source = fs.realpathSync(source); dependencies = fs.realpathSync(dependencies); output = path.resolve(output);
  const commit = git(source, ['rev-parse', '--verify', `${ref}^{commit}`]), rules = packageRules(source, commit);
  if (fs.existsSync(output) || inside(dependencies, output) || inside(output, dependencies))
    throw new Error('Use a new independent local runtime package folder.');
  const lock = JSON.parse(git(source, ['show', `${commit}:package-lock.json`]));
  const installed = checkInstalledLock(dependencies, lock, rules), dependencyBefore = localRuntimeTree(dependencies, rules, installed.selected);
  const tracked = git(source, ['ls-tree', '-rl', commit, '--', ...rules.source_roots]).split('\n');
  let sourceBytes = 0;
  for (const line of tracked) {
    const match = /^\d+ blob [a-f0-9]+\s+(\d+)\t/.exec(line);
    if (!match) throw new Error('The archived source contains an unsupported entry.');
    sourceBytes += Number(match[1]);
  }
  if (tracked.length + dependencyBefore.entries > rules.max_files || sourceBytes + dependencyBefore.bytes > rules.max_bytes)
    throw new Error('The complete local runtime package exceeds its bounds.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const free = fs.statfsSync(path.dirname(output));
  if (Number(free.bavail) * Number(free.bsize) < dependencyBefore.bytes + sourceBytes * 2 + rules.reserve_bytes)
    throw new Error('The local runtime package would consume the disk reserve.');
  fs.mkdirSync(output, { mode: 0o700 });
  // Keep a failed candidate for diagnosis. Never replace an existing package or
  // touch the source checkout, installed app, original state or another chat.
  const archiveFolder = fs.mkdtempSync(path.join(path.dirname(output), '.runtime-source-'));
  const archive = path.join(archiveFolder, 'source.tar');
  try {
    execFileSync('git', ['-C', source, 'archive', '--format=tar', `--output=${archive}`, commit, '--', ...rules.source_roots], { stdio: 'pipe' });
    execFileSync('/usr/bin/tar', ['-xf', archive, '-C', output], { stdio: 'pipe' });
  } finally { fs.rmSync(archiveFolder, { recursive: true, force: true }); }
  const sourceTree = localRuntimeTree(output, rules);
  fs.cpSync(dependencies, path.join(output, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false,
    filter: file => file === dependencies || !rules.dependency_exclusions.includes(path.relative(dependencies, file).split(path.sep)[0]) });
  const dependencyCopy = localRuntimeTree(path.join(output, 'node_modules'), rules);
  if (dependencyCopy.identity !== dependencyBefore.identity || localRuntimeTree(dependencies, rules, installed.selected).identity !== dependencyBefore.identity)
    throw new Error('The installed dependency bytes changed during packaging.');
  const receipt = { version: rules.version, state: 'source-prepared', source_commit: commit,
    source: sourceTree, dependencies: dependencyCopy, installed_packages: installed.count,
    source_roots: rules.source_roots, built: null, signature_qualified: false, workload_qualified: false };
  fs.writeFileSync(path.join(output, receiptName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { output, rules, receipt };
}

/** Build from that same archived source and its pinned dependency bytes, using
 * the existing network sandbox and build owners. No serving or account state. */
export function buildLocalRuntimePackage(prepared) {
  const { output, rules, receipt } = prepared;
  if (receipt.state !== 'source-prepared' || process.platform !== 'darwin') throw new Error('Use a prepared package on its Mac build host.');
  const scratch = fs.mkdtempSync(path.join(path.dirname(output), '.runtime-build-'));
  try {
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
    const built = spawnSync('/usr/bin/sandbox-exec', ['-p', localNetworkProfile, process.execPath,
      path.join(output, 'scripts/run-local.mjs'), '--local-build-only', '--out', 'built', '--state', path.join(scratch, 'state')],
    { cwd: output, env: { ...env, TRILLION_LOCAL_SANDBOXED: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: 'inherit', timeout: rules.build_timeout_ms });
    if (built.error || built.status !== 0) throw new Error('The archived local runtime build did not pass.');
    if (rules.required_outputs.some(name => !fs.statSync(path.join(output, name)).isFile())) throw new Error('The archived local runtime build lacks a required output.');
    if (localRuntimeTree(output, rules, rules.source_roots).identity !== receipt.source.identity
      || localRuntimeTree(path.join(output, 'node_modules'), rules).identity !== receipt.dependencies.identity)
      throw new Error('The local runtime build changed its archived inputs.');
    receipt.built = localRuntimeTree(path.join(output, 'built'), rules); receipt.state = 'built';
    fs.writeFileSync(path.join(output, receiptName), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    return receipt;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2), value = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const source = value('--source') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!value('--ref') || !value('--out')) throw new Error('Name the immutable source ref and a new output folder.');
  const prepared = prepareLocalRuntimePackage({ source, ref: value('--ref'), output: value('--out'), dependencies: value('--dependencies') ?? path.join(source, 'node_modules') });
  if (args.includes('--build')) buildLocalRuntimePackage(prepared);
  console.log(JSON.stringify({ state: prepared.receipt.state, source_commit: prepared.receipt.source_commit, output: prepared.output,
    signature_qualified: false, workload_qualified: false }));
}
