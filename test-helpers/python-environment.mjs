// Declared, hash-pinned wheel environments. Never modify PATH, the system Python, source folders or model caches.
// Setup publishes only after versions/import origins verify and removes only its own failed staging projection.
// Tests never install implicitly: run this owned entrypoint with `setup` before the test gate.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromChunks } from '../tools/content-identity/read-data/identity.mjs';
import { placeCacheFolder } from '../tools/process-session/do-work/place-cache-folder.mjs';

const configurationPath = fileURLToPath(new URL('./python-environment.json', import.meta.url));
const probe = fileURLToPath(new URL('./python-environment-probe.py', import.meta.url));
const configurationBytes = readFileSync(configurationPath);
export const configuration = JSON.parse(configurationBytes);
const profiles = JSON.parse(readFileSync(new URL('./python-environment-profiles.json', import.meta.url)));
const ready = new Map();
const pythonIn = folder => join(folder, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
function run(program, args, env = process.env) {
  const result = spawnSync(program, args, { env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 ** 2 });
  if (result.error || result.status !== 0) {
    const output = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n').slice(-6000);
    throw new Error(`${program} did not finish: ${result.error?.message ?? result.status}${output ? `\n${output}` : ''}`);
  }
  return result.stdout.trim();
}
export function pythonProfile(name = 'default') {
  const row = Object.hasOwn(profiles, name) && profiles[name];
  if (!row || !/^[a-z0-9-]+\.json$/.test(row.file ?? '') || !Array.isArray(row.runtimes)
      || !row.runtimes.length || row.runtimes.some(command => !/^[A-Za-z0-9_.+-]+$/.test(command))) throw new Error(`Unknown or invalid Python test profile: ${name}`);
  const path = fileURLToPath(new URL(row.file, import.meta.url));
  const bytes = readFileSync(path);
  const selected = JSON.parse(bytes);
  if (selected.platform && (selected.platform !== process.platform || selected.architecture !== process.arch)) throw new Error(`Python profile ${name} requires ${selected.platform}/${selected.architecture}`);
  return { name, path, bytes, configuration: selected, runtimes: row.runtimes };
}
export function pythonRuntime(profile = 'default') {
  const selected = pythonProfile(profile);
  const failures = [];
  for (const command of selected.runtimes) {
    try {
      const runtime = JSON.parse(run(command, ['-I', '-B', probe, 'identity']).split('\n').at(-1));
      if (selected.configuration.python.every((part, index) => runtime.version[index] === part)) return runtime;
      failures.push(`${command}: ${runtime.version.join('.')}`);
    } catch (error) { failures.push(`${command}: ${error.message}`); }
  }
  throw new Error(`Python profile ${profile} needs CPython ${selected.configuration.python.join('.')}: ${failures.join('; ')}`);
}
export function verifyPythonEnvironment(python, folder, path = configurationPath) {
  const result = spawnSync(python, ['-I', '-B', probe, 'verify', path, folder], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 ** 2 });
  if (result.error) return { ok: false, wrong: [result.error.message] };
  try {
    const answer = JSON.parse(result.stdout.trim().split('\n').at(-1));
    return answer.ok && result.status !== 0 ? { ok: false, wrong: ['readiness exited unsuccessfully'] } : answer;
  } catch { return { ok: false, wrong: ['readiness returned no valid answer'] }; }
}
function location(profile) {
  const selected = pythonProfile(profile);
  const runtime = pythonRuntime(profile);
  const identity = makeHashCodeHexFromChunks([selected.bytes, Buffer.from(JSON.stringify(runtime)), readFileSync(probe)]);
  return { ...selected, runtime, identity, folder: join(placeCacheFolder(), 'workshop-python-tests', identity.slice(3)) };
}
export function pythonForTests(profile = 'default') {
  if (ready.has(profile)) return ready.get(profile);
  const { folder, path } = location(profile);
  const python = pythonIn(folder);
  const checked = verifyPythonEnvironment(python, folder, path);
  if (!checked.ok) throw new Error(`Python test environment unavailable: ${checked.wrong.join('; ')}. Run node test-helpers/python-environment.mjs setup ${profile}.`);
  ready.set(profile, python);
  return python;
}
export function setupPythonEnvironment(profile = 'default') {
  const { runtime, identity, folder, path, configuration: selected } = location(profile);
  const python = pythonIn(folder);
  const existing = verifyPythonEnvironment(python, folder, path);
  if (existing.ok) return { python, identity, versions: existing.versions, reused: true };
  if (existsSync(folder)) throw new Error(`Existing Python cache failed readiness: ${existing.wrong.join('; ')}. Preserved for recovery.`);
  mkdirSync(dirname(folder), { recursive: true });
  const stage = mkdtempSync(`${folder}.building-`);
  try {
    run(runtime.executable, ['-I', '-B', '-m', 'venv', stage]);
    const stagedPython = pythonIn(stage);
    const requirements = selected.packages.map(item => {
      if (!/^[A-Za-z0-9_.-]+$/.test(item.name) || !/^[A-Za-z0-9_.+!-]+$/.test(item.version)
          || !item.hashes.length || item.hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid Python dependency pin');
      return `${item.name}==${item.version} ${item.hashes.map(hash => `--hash=sha256:${hash}`).join(' ')}`;
    }).join('\n');
    const pinned = join(stage, 'requirements.txt');
    writeFileSync(pinned, `${requirements}\n`);
    run(stagedPython, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-input', '--no-cache-dir', '--index-url', 'https://pypi.org/simple', '--only-binary=:all:', '--require-hashes', '--no-deps', '-r', pinned],
      { ...process.env, PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null', PIP_KEYRING_PROVIDER: 'disabled' });
    run(stagedPython, ['-I', '-B', '-m', 'pip', 'check']);
    const checked = verifyPythonEnvironment(stagedPython, stage, path);
    if (!checked.ok) throw new Error(`Prepared Python environment failed readiness: ${checked.wrong.join('; ')}`);
    try { renameSync(stage, folder); }
    catch (error) { if (!existsSync(folder) || !verifyPythonEnvironment(python, folder, path).ok) throw error; }
    const published = verifyPythonEnvironment(python, folder, path);
    if (!published.ok) throw new Error(`Published Python environment failed readiness: ${published.wrong.join('; ')}`);
    ready.set(profile, python);
    return { python, identity, versions: published.versions, reused: false };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'setup' || process.argv.length > 4) throw new Error('Use setup [profile] to prepare a declared Python test environment');
  console.log(JSON.stringify(setupPythonEnvironment(process.argv[3] ?? 'default')));
}
