#!/usr/bin/env node
// Inspect, apply, update and remove this account's local harness setup. The same manifest drives installation,
// execution and verification. Existing settings and permission choices stay with their host. A downloaded pair
// (this file + setup.json) can use an older signed Trillion Mac app's existing harness payload.
//
// node setup.mjs --action inspect|apply|remove --harness claude-code|codex [--trust-hooks]
// node setup.mjs --action mcp-inspect|mcp-preview|mcp-register|mcp-unregister --client claude-code,codex,... [--reviewed <hash>]
//   (harness/mcp-registration.mjs: the person's own explicit action is the only road that writes an MCP entry into
//   another AI's config; preview writes nothing.)
// An explicitly supplied source payload also requires --payload <checkout>/harness --source-commit <full SHA>.
// The hook dispatcher is an internal entry point written into the selected host's config by apply. It forwards the
// real hook's stdout, stderr and exit code, and keeps only event/definition/result evidence, never a transcript.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RECEIPT_SCHEMA, SETUP_ROUTE, runPath, scriptHash } from './hook-run-receipt.mjs';
import { hash, json, read, writeConfig } from './config-file.mjs';
import { MCP_ACTIONS, registerMcp } from './mcp-registration.mjs';

export { writeConfig } from './config-file.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
export const settings = JSON.parse(readFileSync(join(HERE, 'setup.json'), 'utf8'));
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
const expand = (path, home) => path.replace(/^~(?=\/|$)/, home);
const readJson = path => { const raw = read(path); return raw === null ? null : JSON.parse(raw); };
function readRetiredDispatchers(home, rules) {
  const path = join(home, rules.state_folder, rules.retired_dispatchers_file ?? 'retired-dispatchers.json');
  const rows = readJson(path) ?? [];
  const declaredHooks = new Set([...rules.hooks, ...(rules.retired_hooks ?? [])].map(hook => `${hook.id}:${hook.event}`));
  if (!Array.isArray(rows) || rows.some(row => !object(row) || !isAbsolute(row.installer) || !isAbsolute(row.payload)
    || row.schema !== rules.schema || row.mac_app?.identifier !== rules.mac_app.identifier || row.mac_app?.team !== rules.mac_app.team
    || !Array.isArray(row.hooks) || row.hooks.some(hook => !object(hook) || !declaredHooks.has(`${hook.id}:${hook.event}`)
      || (hook.args !== undefined && (!Array.isArray(hook.args) || hook.args.some(arg => typeof arg !== 'string')))))) {
    throw new Error(`The retired dispatcher data is invalid: ${path}`);
  }
  return rows;
}
const result = (id, status, reason, evidence = {}) => ({ id, status, reason, evidence });
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
const okay = answer => !answer.error && answer.status === 0;

export function hostFor(id, rules = settings) {
  return rules.hosts.find(host => host.id === id) ?? null;
}

export function configPath(host, { home = homedir(), env = process.env } = {}) {
  return join(env[host.home_variable] ? resolve(expand(env[host.home_variable], home)) : join(home, host.folder), host.config);
}

/** Only the known signed app or a clean, explicitly pinned checkout can supply executable payload. */
export function verifyPayload({ payload, sourceCommit, rules = settings, execute = run, runtime = process.execPath } = {}) {
  const app = rules.mac_app;
  const bundled = resolve(app.path, app.payload);
  const path = resolve(payload ?? bundled);
  const appSuffix = `/${app.payload}`;
  const appPath = path.endsWith(appSuffix) && path.slice(0, -appSuffix.length).endsWith('.app') ? path.slice(0, -appSuffix.length) : null;
  let identity;
  if (path === bundled || appPath) {
    const installedApp = appPath ?? app.path;
    if (!existsSync(path)) return { ...result('payload', 'missing', 'Install the published Trillion Mac app before applying local setup.'), path };
    const signed = execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', installedApp]);
    const described = execute('/usr/bin/codesign', ['-dv', installedApp]);
    const description = `${described.stdout ?? ''}\n${described.stderr ?? ''}`;
    if (!okay(signed) || !okay(described) || !description.split('\n').includes(`Identifier=${app.identifier}`) || !description.split('\n').includes(`TeamIdentifier=${app.team}`)) {
      return { ...result('payload', 'blocked', 'The installed app did not pass the Trillion identity and signature check. Reinstall from the published download.'), path };
    }
    runtime = join(installedApp, app.runtime);
    identity = { kind: 'signed-mac-app', app: installedApp, identifier: app.identifier, team: app.team };
  } else {
    if (!/^[a-f0-9]{40}$/i.test(sourceCommit ?? '') || basename(path) !== 'harness') return { ...result('payload', 'blocked', 'A source payload requires its harness folder and an explicit full source commit.'), path };
    const checkout = dirname(path);
    // A Git hook can hand over another repository's routing variables. The supplied
    // checkout owns this check; inherited Git routing must not validate a different tree.
    const gitOptions = { env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))) };
    const head = execute('git', ['-C', checkout, '--work-tree', checkout, 'rev-parse', 'HEAD'], gitOptions);
    const changed = execute('git', ['-C', checkout, '--work-tree', checkout, 'status', '--porcelain', '--untracked-files=normal', '--', 'harness', 'computer', 'src', 'parts', 'records', 'package.json', 'package-lock.json'], gitOptions);
    if (!okay(head) || head.stdout.trim() !== sourceCommit || !okay(changed) || changed.stdout.trim()) return { ...result('payload', 'blocked', 'The supplied checkout must match the pinned commit with no changed payload or dependency files.'), path };
    identity = { kind: 'pinned-checkout', checkout, commit: sourceCommit };
  }
  const missing = rules.payload.required.filter(file => !existsSync(join(path, file)));
  if (missing.length) return { ...result('payload', 'missing', 'The payload is incomplete. Repair the app or pinned checkout, then retry.', { missing }), path, runtime };
  const version = execute(runtime, ['--version']);
  const major = Number(String(version.stdout ?? '').match(/^v(\d+)/)?.[1]);
  if (!okay(version) || !(major >= rules.payload.minimum_node_major)) return { ...result('payload', 'blocked', `The payload requires Node ${rules.payload.minimum_node_major} or newer.`, { version: String(version.stdout ?? '').trim() }), path, runtime };
  // These modules guard their CLI entry points. Importing them checks their real dependency graph without starting
  // readers, sessions, models or network calls. register-session itself is checked by its imported wake owner.
  let dynamic = [];
  try { dynamic = (rules.payload.import_lists ?? []).flatMap(row => readJson(join(path, row.file))?.[row.field] ?? []); }
  catch { return { ...result('payload', 'blocked', 'The helper dependency manifest could not be read.'), path, runtime }; }
  const urls = [...new Set([...rules.payload.import_checks, ...dynamic])].map(file => pathToFileURL(join(path, file)).href);
  const imported = execute(runtime, ['--input-type=module', '-e', 'for (const path of JSON.parse(process.argv[1])) await import(path)', JSON.stringify(urls)]);
  if (!okay(imported)) return { ...result('payload', 'blocked', 'The payload cannot load its hook dependencies. Repair the signed app or install the pinned checkout dependencies.', { dependency_check: 'failed' }), path, runtime };
  return { ...result('payload', 'ready', 'The selected payload and its actual dependencies load.', identity), path, runtime };
}

export function desiredHooks({ harness, payload, runtime = process.execPath, installer = SELF, rules = settings, forRemoval = false }) {
  return rules.hooks.map(row => {
    if (!/^[a-z0-9][a-z0-9.-]*\.mjs$/.test(row.script)) throw new Error('A setup hook must name one payload script.');
    if (row.on_failure !== undefined && !['allow', 'block'].includes(row.on_failure)) throw new Error('A setup hook\'s on_failure is allow (a crash or timeout lets the action go on, the default) or block.');
    const args = row.args.map(arg => arg.replace('{harness}', harness));
    const argv = [runtime, installer, '--run-hook', row.id, '--harness', harness, '--payload', payload];
    const hook = { type: 'command', command: argv.map(quote).join(' '), timeout: row.timeout, ...(row.async ? { async: true } : {}) };
    let group = { hooks: [hook] };
    if (row.matcher_from && !forRemoval) {
      const match = readJson(join(payload, row.matcher_from));
      const names = [...new Set([...match.file_tools, ...match.shell_tools])];
      group = { matcher: names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), ...group };
    }
    return { ...row, harness, args, group, hook, definition_hash: forRemoval ? null : hash(JSON.stringify({ row, group, payload, script: readFileSync(join(payload, row.script), 'utf8') })) };
  });
}

// A deliberately narrow shell-word reader for recognizing our old direct commands. It never evaluates a command.
// Compound shell commands and expansions stay untouched and are reported as conflicts when they name our scripts.
export function commandWords(command) {
  if (typeof command !== 'string') return null;
  const words = []; let word = '', quoteMode = null, started = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quoteMode === "'") { if (char === "'") quoteMode = null; else word += char; started = true; continue; }
    if (char === '\\' && quoteMode !== "'") { if (++i >= command.length) return null; word += command[i]; started = true; continue; }
    if (char === '"') { quoteMode = quoteMode === '"' ? null : '"'; started = true; continue; }
    if (!quoteMode && char === "'") { quoteMode = "'"; started = true; continue; }
    if (!quoteMode && /\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } continue; }
    if (/[$`]/.test(char) || (!quoteMode && /[;&|<>\n]/.test(char))) return null;
    word += char; started = true;
  }
  if (quoteMode) return null;
  if (started) words.push(word);
  return words;
}

function managedHook(event, hook, desired, { home, payload, installer, retired = settings.retired_hooks ?? [], retiredDispatchers = [] }) {
  if (hook?.type !== 'command') return null;
  const words = commandWords(hook.command);
  if (!words || words.length < 2 || !/^(?:node|nodejs)$/.test(basename(words[0]))) return null;
  const target = resolve(expand(words[1], home));
  // A pinned checkout may replace the same installer's signed-app or former
  // checkout commands. Identify that dispatcher from its adjacent declaration,
  // never from the filename alone, and never execute the previous source.
  let previousDispatcher = false;
  if (basename(target) === 'setup.mjs' && basename(dirname(target)) === 'harness') {
    try {
      const prior = readJson(join(dirname(target), 'setup.json'));
      previousDispatcher = prior?.schema === settings.schema
        && prior.mac_app?.identifier === settings.mac_app.identifier
        && prior.mac_app?.team === settings.mac_app.team;
    } catch { /* Unknown commands remain with their owner. */ }
  }
  const harness = desired[0]?.harness;
  const retiredDispatcher = retiredDispatchers.find(row => target === resolve(row.installer)
    && words[7] === resolve(expand(row.payload, home))
    && row.schema === settings.schema
    && row.mac_app?.identifier === settings.mac_app.identifier
    && row.mac_app?.team === settings.mac_app.team);
  const rows = [...desired, ...retired.map(row => ({ ...row, harness, args: (row.args ?? []).map(arg => arg.replace('{harness}', harness)) })),
    ...(retiredDispatcher?.hooks ?? []).map(row => ({ ...row, harness, args: (row.args ?? []).map(arg => arg.replace('{harness}', harness)) }))];
  for (const row of rows.filter(row => row.event === event)) {
    if (target === resolve(installer) || previousDispatcher || retiredDispatcher) {
      if (words.length === 8 && words[2] === '--run-hook' && words[3] === row.id && words[4] === '--harness' && words[5] === row.harness && words[6] === '--payload' && isAbsolute(words[7])) return row.id;
    }
    if (![join(payload, row.script), join(home, '.trillion', 'hooks', row.script)].some(path => resolve(path) === target)) continue;
    if (JSON.stringify(words.slice(2)) === JSON.stringify(row.args)) return row.id;
    // Existing Stop recorders and SessionStart definitions can have the harness supplied explicitly.
    if (row.args.length === 0 && JSON.stringify(words.slice(2)) === JSON.stringify(['--harness', row.harness])) return row.id;
  }
  return null;
}

/** How many times the host settings carry each row in a form setup owns (its dispatcher or an old direct command). */
export function ownedCounts(config, desired, { home = homedir(), payload, installer = SELF, retiredDispatchers = [] } = {}) {
  const counts = new Map();
  for (const [event, groups] of Object.entries(object(config?.hooks) ? config.hooks : {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        const id = managedHook(event, hook, desired, { home, payload, installer, retiredDispatchers });
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** The rows another hook runner already runs with the current payload script, each with its own run receipt
 *  (harness/hook-run-receipt.mjs). Setup's own dispatcher runs, a run of another script version and a receipt older
 *  than `run_receipt_days` never count. */
export function hooksRunElsewhere({ desired, harness, payload, home = homedir(), rules = settings, now = Date.now() }) {
  const found = new Map();
  for (const row of desired) {
    let current; try { current = scriptHash(readFileSync(join(payload, row.script), 'utf8')); } catch { continue; }
    const template = row.args.map(arg => (arg === harness ? '{harness}' : arg));
    // As with an owned direct command, a runner may name the harness to a script whose row takes no arguments.
    for (const args of [template, ...(template.length ? [] : [['--harness', '{harness}']])]) {
      let kept; try { kept = readJson(runPath({ home, rules, harness, event: row.event, script: row.script, args })); } catch {}
      const age = now - Date.parse(kept?.at);
      if (kept?.schema !== RECEIPT_SCHEMA || kept.route !== 'other' || kept.event !== row.event || kept.script !== row.script
        || kept.script_hash !== current || !(age >= 0 && age <= rules.run_receipt_days * 86_400_000)) continue;
      found.set(row.id, { ...kept, definition_hash: hash(JSON.stringify({ id: row.id, event: row.event, script: row.script, args: kept.args, script_hash: current })) });
      break;
    }
  }
  return found;
}

/** One shared merge for create/update/remove. Only exact installer or old direct Trillion hook commands are owned. */
export function mergeHooks(config, desired, { action = 'apply', home = homedir(), payload, installer = SELF, retiredDispatchers = [] } = {}) {
  if (!object(config) || (config.hooks !== undefined && !object(config.hooks))) throw new Error('The existing host settings are not a JSON object with a hooks object. They were not changed.');
  const next = structuredClone(config); const retained = {};
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) throw new Error(`The existing ${event} hooks are not an array. They were not changed.`);
    retained[event] = [];
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) throw new Error(`The existing ${event} hook group is invalid. It was not changed.`);
      const kept = group.hooks.filter(hook => !managedHook(event, hook, desired, { home, payload, installer, retiredDispatchers }));
      if (kept.length || !group.hooks.length) retained[event].push({ ...group, hooks: kept });
    }
  }
  if (action === 'apply') for (const row of desired) (retained[row.event] ??= []).push(row.group);
  for (const event of Object.keys(retained)) if (!retained[event].length) delete retained[event];
  if (Object.keys(retained).length) next.hooks = retained; else delete next.hooks;
  return next;
}

// Preserve custom commands, but do not silently install a second copy of a hook hidden inside one. Report only
// locations and script names: a person's unrelated hook command may contain private values.
function customHookReferences(config, desired, { home, payload, installer, retiredDispatchers = [] }) {
  const references = [];
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!Array.isArray(group?.hooks)) return;
      group.hooks.forEach((hook, hookIndex) => {
        if (hook?.type !== 'command' || typeof hook.command !== 'string' || managedHook(event, hook, desired, { home, payload, installer, retiredDispatchers })) return;
        const scripts = [...new Set(desired.filter(row => hook.command.includes(row.script)).map(row => row.script))];
        if (scripts.length) references.push({ event, group: groupIndex, hook: hookIndex, scripts });
      });
    });
  }
  return references;
}

/** Codex's documented read API; no thread is started and no model or hook is executed. */
export async function codexClient({ command = 'codex', launch = spawn, env = process.env, timeout = 12000 } = {}) {
  const child = launch(command, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env });
  const pending = new Map(); let sequence = 0; let failure = null;
  const fail = reason => { failure = reason; for (const entry of pending.values()) entry.reject(reason); pending.clear(); };
  child.on('error', () => fail(new Error('The selected Codex app server could not start.')));
  child.on('exit', () => fail(new Error('The selected Codex app server ended before its setup read completed.')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`Codex ${entry.method} is unavailable (${message.error.code ?? 'error'}).`)); else entry.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolveCall, reject) => {
    if (failure) return reject(failure);
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeout);
    pending.set(id, { method, resolve: value => { clearTimeout(timer); resolveCall(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const close = () => { lines.close(); child.stdin.end(); child.kill(); };
  try {
    await call('initialize', { clientInfo: { name: 'trillion-setup', title: 'Trillion setup', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return { call, close };
  } catch (error) { close(); throw error; }
}

/** Exact source, event and command matches only. A disabled hook remains disabled even when trust is requested. */
export async function inspectCodex({ client, desired, path, cwd, trust = false }) {
  const list = async () => {
    const answer = await client.call('hooks/list', { cwds: [cwd] });
    const entry = answer?.data?.find(row => row.cwd === cwd);
    if (!entry || !Array.isArray(entry.hooks) || entry.errors?.length) throw new Error('Codex did not return a readable hook inventory for the selected configuration.');
    const eventNames = hostFor('codex')?.event_names ?? {};
    return desired.map(row => ({ row, found: entry.hooks.find(hook => hook.sourcePath === path && hook.eventName === (eventNames[row.event] ?? row.event) && hook.handlerType === 'command' && hook.command === row.hook.command && (hook.matcher ?? null) === (row.group.matcher ?? null) && Number(hook.timeoutSec) === row.timeout && hook.async === Boolean(row.async)) }));
  };
  let matched = await list();
  if (trust) {
    const updates = matched.filter(({ found }) => found?.enabled === true && found.isManaged !== true && ['untrusted', 'modified'].includes(found.trustStatus) && typeof found.currentHash === 'string' && found.currentHash && typeof found.key === 'string');
    if (updates.length) {
      await client.call('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value: Object.fromEntries(updates.map(({ found }) => [found.key, { trusted_hash: found.currentHash }])), mergeStrategy: 'upsert' }], reloadUserConfig: true });
      matched = await list();
    }
  }
  return matched.map(({ row, found }) => {
    const identified = typeof found?.key === 'string' && Boolean(found.key) && typeof found.currentHash === 'string' && Boolean(found.currentHash);
    const trusted = identified && found.enabled === true && ['trusted', 'managed'].includes(found.trustStatus);
    return result(`host-${row.id}`, trusted ? 'ready' : 'pending', !found || !identified ? 'The installed Codex did not identify this exact hook definition.' : found.enabled !== true ? 'This hook is disabled by the host configuration or policy; setup left that decision unchanged.' : trusted ? 'Codex reports this exact hook as enabled and trusted.' : 'The exact hook definition needs host trust review.', identified ? { key: found.key, current_hash: found.currentHash, trust: found.trustStatus, enabled: found.enabled } : {});
  });
}

const receiptPath = (home, rules, harness, id) => join(home, rules.state_folder, 'observed', harness, `${id}.json`);
function keepReceipt(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.${randomUUID()}.part`;
  writeFileSync(part, json(value), { mode: 0o600 }); renameSync(part, path);
}

export function hookEvidence({ desired, harness, home = homedir(), rules = settings }) {
  return desired.map(row => {
    let kept; try { kept = readJson(receiptPath(home, rules, harness, row.id)); } catch {}
    const valid = kept?.definition_hash === row.definition_hash && kept?.event === row.event;
    return result(`ran-${row.id}`, valid && kept.exit_code === 0 ? 'ready' : 'pending', valid && kept.exit_code === 0 ? 'This exact hook process returned successfully for the reported event. Its remote effect still needs account verification.' : valid ? 'This hook ran but did not complete successfully.' : 'This hook is configured but a matching execution has not been observed.', { definition_hash: row.definition_hash, ...(valid ? { at: kept.at, event: kept.event, exit_code: kept.exit_code, level: 'local-process-execution' } : {}) });
  });
}

/** The dispatcher never changes the real policy output or interprets a tool invocation itself. */
export function runConfiguredHook({ id, harness, payload, input, home = homedir(), rules = settings, runtime = process.execPath, installer = SELF, execute = run, now = () => new Date().toISOString() }) {
  if (!hostFor(harness, rules)) throw new Error('Unknown harness for setup hook.');
  const row = desiredHooks({ harness, payload, runtime, installer, rules: { ...rules, hooks: rules.hooks.filter(item => item.id === id) } })[0];
  if (!row) throw new Error('Unknown setup hook.');
  const answer = execute(runtime, [join(payload, row.script), ...row.args], { input, stdio: ['pipe', 'pipe', 'pipe'], timeout: row.timeout * 1000, env: { ...process.env, HOME: home, [SETUP_ROUTE]: id } });
  let event; try { event = JSON.parse(input); } catch {}
  const code = answer.error ? 1 : answer.status ?? 1;
  // A hook that did not finish (crash, kill, timeout) said nothing about the action. Hosts read exit 1 as "go on", so a row
  // that guards something says `on_failure: "block"` and the host is told no (exit 2) with the reason; every hook says
  // plainly that it timed out.
  const unfinished = Boolean(answer.error) || answer.status === null || answer.status === undefined;
  const timedOut = answer.error?.code === 'ETIMEDOUT' || answer.signal === 'SIGTERM';
  const failure = unfinished ? `The Trillion hook ${id} ${timedOut ? `did not finish in ${row.timeout} seconds` : 'did not finish'}${row.on_failure === 'block' ? ', and its row says the action stops when it fails.' : '.'}\n` : '';
  if (event?.hook_event_name === row.event) {
    try { keepReceipt(receiptPath(home, rules, harness, id), { schema: 'trillion.harness-hook-observation/v1', definition_hash: row.definition_hash, event: row.event, at: now(), exit_code: code }); } catch { /* evidence failure never changes a policy decision */ }
  }
  return { stdout: answer.stdout ?? '', stderr: `${answer.stderr ?? (answer.error ? 'The Trillion hook could not run. Inspect Trillion setup for its dependency status.\n' : '')}${failure}`, status: unfinished && row.on_failure === 'block' ? 2 : code };
}

export function localRuntimeChecks({ payload, home = homedir(), rules = settings, execute = run }) {
  const wake = readJson(join(payload, 'wake-sessions.json'));
  const work = readJson(join(payload, 'take-open-work.json'));
  const key = execute('/usr/bin/security', ['find-generic-password', '-s', wake.keychain_item], { stdio: 'ignore' });
  let chosen; try { chosen = readJson(join(expand(wake.folder, home), wake.settings_file)); } catch {}
  const selected = work.ais.find(ai => ai.id === chosen?.chosen_ai);
  const processes = execute('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
  const rows = okay(processes) ? String(processes.stdout).split('\n').flatMap(line => { const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/); return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : []; }) : [];
  const suffix = `/${rules.mac_app.payload}`;
  const appPath = payload.endsWith(suffix) && payload.slice(0, -suffix.length).endsWith('.app') ? payload.slice(0, -suffix.length) : rules.mac_app.path;
  const helperPath = join(appPath, rules.mac_app.payload, 'wake-sessions.mjs');
  const appExecutable = join(appPath, rules.mac_app.executable);
  const helpers = rows.filter(row => /^\S*\bnode\s/.test(row.command) && /\/harness\/wake-sessions\.mjs(?:\s|$)/.test(row.command));
  const owned = helpers.find(row => row.command.includes(helperPath) && rows.some(parent => parent.pid === row.parent && (parent.command === appExecutable || parent.command.startsWith(`${appExecutable} `))));
  return [
    result('account-key', okay(key) ? 'ready' : 'pending', okay(key) ? 'The native account key exists; its remote validity is checked by account setup.' : 'Sign in in the native Trillion app so its existing account-key owner can provision the key.'),
    result('chosen-ai', selected ? 'ready' : 'pending', selected ? 'The existing local AI choice is preserved. Setup did not start work.' : 'An AI for background work has not been selected. Complete the account\'s explicit AI and automation choice before activating work.', selected ? { id: selected.id } : {}),
    result('helper', !okay(processes) ? 'unknown' : helpers.length > 1 ? 'blocked' : owned ? 'ready' : 'pending', !okay(processes) ? 'The running helper could not be inspected.' : helpers.length > 1 ? 'More than one session helper is running. Resolve the duplicate owner before claiming setup is ready.' : owned ? 'One session helper is running as a child of the installed Trillion app. Its existing handlers own recurring intake and recovery.' : 'The installed Trillion app has not been observed running its session helper. Open and sign in in that app; do not install a second service.', owned ? { pid: owned.pid, parent_pid: owned.parent, owner: 'Trillion Mac app', delivery: 'not-tested' } : {}),
  ];
}

export async function setup({ action = 'inspect', harness, payload, sourceCommit, trustHooks = false, reviewedDefinitionHashes, home = homedir(), env = process.env, platform = process.platform, rules = settings, installer = SELF, execute = run, inspectPayload = verifyPayload, openCodex = codexClient, inspectRuntime = localRuntimeChecks } = {}) {
  const checks = []; const changes = [];
  const finish = () => ({ schema: 'trillion.harness-setup-report/v1', scope: 'local-harness', evidence_level: 'local-configuration-and-processes', action, harness, status: checks.every(check => check.status === 'ready') ? 'ready' : 'pending', ready: checks.every(check => check.status === 'ready'), checks, changes, boundaries: rules.boundaries });
  if (!['inspect', 'apply', 'remove'].includes(action)) throw new Error('Use --action inspect, apply or remove.');
  if (trustHooks && action !== 'apply') throw new Error('--trust-hooks is an explicit apply option.');
  if (reviewedDefinitionHashes !== undefined && (!trustHooks || action !== 'apply')) throw new Error('Reviewed definitions require explicit trust on apply.');
  const host = hostFor(harness, rules);
  if (!host) { checks.push(result('host', 'unsupported', 'Choose the current local harness explicitly. An unknown or cloud-only host is never replaced by a different installed AI.', { supported: rules.hosts.map(row => row.id) })); return finish(); }
  const path = configPath(host, { home, env });
  let retiredDispatchers;
  try { retiredDispatchers = readRetiredDispatchers(home, rules); }
  catch (error) { checks.push(result('retired-dispatchers', 'blocked', error.message)); return finish(); }
  // Removing broken integration must still work after the app or source checkout was removed. Match our exact
  // dispatcher definitions; no executable payload is loaded or trusted just to remove settings.
  if (action === 'remove') {
    const knownPayload = resolve(payload ?? join(rules.mac_app.path, rules.mac_app.payload));
    const desired = desiredHooks({ harness, payload: knownPayload, installer, rules, forRemoval: true });
    try {
      changes.push(writeConfig(path, current => mergeHooks(current, desired, { action, home, payload: knownPayload, installer, retiredDispatchers })));
      checks.push(result('configuration', 'ready', 'The installed Trillion hook definitions were removed. Other host settings remain with their owners.', { path }));
    } catch (error) { checks.push(result('configuration', 'blocked', error.message, { path })); }
    return finish();
  }
  if (!rules.platforms.includes(platform)) { checks.push(result('platform', 'unsupported', 'The full local hook suite currently uses the Mac app and macOS Keychain. Use account setup for this platform\'s supported capabilities.')); return finish(); }
  const source = inspectPayload({ payload, sourceCommit, rules, execute }); checks.push(source);
  if (source.status !== 'ready') return finish();
  const desired = desiredHooks({ harness, payload: source.path, runtime: source.runtime, installer, rules });
  const hostCheck = execute(host.command, ['--version']);
  if (action !== 'remove' && !okay(hostCheck)) { checks.push(result('host', 'missing', 'The explicitly selected harness command is not available. Install that chosen harness, then retry.')); return finish(); }
  let config;
  try { config = readJson(path) ?? {}; } catch { checks.push(result('configuration', 'blocked', 'The existing host configuration is unreadable JSON. Repair it without replacing its settings.', { path })); return finish(); }
  if (action === 'apply' && config.disableAllHooks === true) { checks.push(result('configuration', 'blocked', 'The host has disabled all hooks. Setup left that choice unchanged.', { path })); return finish(); }
  if (object(config) && object(config.hooks)) {
    const references = customHookReferences(config, desired, { home, payload: source.path, installer, retiredDispatchers });
    if (references.length) {
      checks.push(result('configuration', 'blocked', 'Custom hook commands refer to Trillion scripts. Review those preserved commands before applying this setup, so a second invocation is not installed.', { path, references }));
      return finish();
    }
  }
  // A hook another runner already runs with the current script is installed: it is listed from its run receipt and
  // never written into the host settings a second time, so no hook fires twice. A hook the settings carry stays
  // setup's to keep in its one dispatcher form.
  const owned = ownedCounts(config, desired, { home, payload: source.path, installer, retiredDispatchers });
  const elsewhere = hooksRunElsewhere({ desired, harness, payload: source.path, home, rules });
  for (const id of owned.keys()) elsewhere.delete(id);
  const install = desired.filter(row => !elsewhere.has(row.id));
  const listed = desired.map(row => elsewhere.has(row.id)
    ? { id: row.id, event: row.event, command: [join(source.path, row.script), ...elsewhere.get(row.id).args.map(arg => arg.replace('{harness}', harness))].join(' '), route: 'another-hook-runner', definition_hash: elsewhere.get(row.id).definition_hash }
    : { id: row.id, event: row.event, command: row.hook.command, definition_hash: row.definition_hash });
  // Review is checked against this invocation's actual definitions before any configuration write. A signed app
  // update between the earlier inspect and this apply cannot transfer approval to different hook commands.
  if (reviewedDefinitionHashes !== undefined && (!Array.isArray(reviewedDefinitionHashes) ||
    reviewedDefinitionHashes.length !== listed.length || new Set(reviewedDefinitionHashes).size !== listed.length ||
    !listed.every(row => reviewedDefinitionHashes.includes(row.definition_hash)))) {
    checks.push(result('host-review', 'blocked', 'The current hook definitions differ from the reviewed hashes. Inspect and review again; no trust or configuration change was made.'));
    return finish();
  }
  const merge = current => mergeHooks(current, install, { action, home, payload: source.path, installer, retiredDispatchers });
  if (action !== 'inspect') {
    try { changes.push(writeConfig(path, merge)); config = readJson(path); }
    catch (error) { checks.push(result('configuration', 'blocked', error.message, { path })); return finish(); }
  }
  let expected;
  try { expected = mergeHooks(config, install, { home, payload: source.path, installer, retiredDispatchers }); } catch (error) { checks.push(result('configuration', 'blocked', error.message, { path })); return finish(); }
  const configured = config.disableAllHooks !== true && JSON.stringify(config) === JSON.stringify(expected);
  const runElsewhere = elsewhere.size ? ` ${[...elsewhere.keys()].join(', ')} already run from another hook runner with the current script and were not written again.` : '';
  checks.push(result('configuration', configured ? 'ready' : 'pending', configured ? `All required hook events are configured once, preserving unrelated settings.${runElsewhere}` : `The complete hook set has not been installed. Run apply for the selected harness.${runElsewhere}`, { path, hooks: listed }));
  if (configured && host.trust === 'codex-app-server') {
    let client;
    try { client = await openCodex({ command: host.command, env }); checks.push(...await inspectCodex({ client, desired: install, path, cwd: home, trust: trustHooks })); }
    catch (error) { checks.push(result('host-trust', 'unknown', `${error.message} ${host.hook_review}`)); }
    finally { client?.close(); }
  }
  if (configured && host.trust === 'codex-app-server') {
    for (const id of elsewhere.keys()) checks.push(result(`host-${id}`, 'pending', 'This hook runs from another hook runner; the host reports trust for that runner\'s own hook, not for this one.'));
  }
  if (configured) checks.push(...hookEvidence({ desired: install, harness, home, rules }), ...[...elsewhere.entries()].map(([id, kept]) => result(`ran-${id}`, kept.exit_code === 0 ? 'ready' : 'pending',
    kept.exit_code === 0 ? 'Another hook runner ran this exact payload script successfully for the reported event. Its remote effect still needs account verification.' : 'Another hook runner ran this hook but it did not complete successfully.',
    { definition_hash: kept.definition_hash, at: kept.at, event: kept.event, exit_code: kept.exit_code, level: 'local-process-execution', route: 'another-hook-runner' })));
  try { checks.push(...inspectRuntime({ payload: source.path, home, rules, execute })); }
  catch { checks.push(result('runtime', 'unknown', 'The local runtime configuration changed or could not be read. Inspect it again; no runtime setting was changed.')); }
  return finish();
}

function parseArgs(argv) {
  const out = {};
  const flags = { '--action': 'action', '--harness': 'harness', '--payload': 'payload', '--source-commit': 'sourceCommit', '--run-hook': 'runHook', '--client': 'clients', '--mcp-url': 'url', '--reviewed': 'reviewed' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--trust-hooks') { out.trustHooks = true; continue; }
    const field = flags[argv[i]];
    if (!field || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Use --action inspect|apply|remove --harness <id> [--payload <path> --source-commit <SHA>] [--trust-hooks], or --action mcp-inspect|mcp-preview|mcp-register|mcp-unregister --client <ids> [--mcp-url <https or loopback HTTP for HTTP clients; Claude Code and Codex use the installed local bridge>] [--reviewed <review_hash>].');
    out[field] = argv[++i];
  }
  return out;
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.runHook) {
      const input = readFileSync(0, 'utf8');
      const answer = runConfiguredHook({ ...options, id: options.runHook, input });
      process.stdout.write(answer.stdout); process.stderr.write(answer.stderr); process.exitCode = answer.status;
    } else if (MCP_ACTIONS.includes(options.action)) {
      const { action, clients, url, reviewed } = options;
      const answer = registerMcp({ action, clients, url, reviewed, rules: settings });
      process.stdout.write(json(answer)); process.exitCode = answer.refused || answer.results.some(row => ['blocked', 'custom'].includes(row.result ?? row.now)) ? 2 : 0;
    } else {
      const answer = await setup(options); process.stdout.write(json(answer)); process.exitCode = answer.ready ? 0 : 2;
    }
  } catch (error) {
    process.stderr.write(`${json({ schema: 'trillion.harness-setup-error/v1', error: error.message })}`); process.exitCode = 1;
  }
}
