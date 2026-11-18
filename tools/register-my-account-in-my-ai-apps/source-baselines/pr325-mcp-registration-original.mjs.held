// harness/mcp-registration.mjs
//
// Purpose
//   Puts Trillion's MCP server entry into other AI apps' own config files, and takes it out again, only when the person
//   runs the explicit setup action for the apps they name (harness/setup.mjs --action mcp-inspect | mcp-preview |
//   mcp-register | mcp-unregister --client <ids>). Each app's file, format and entry is a row of harness/setup.json
//   `mcp_registration`; nothing here names an app.
//
// Non-negotiable invariants
//   1. Applying hooks never calls this; an entry is written only by mcp-register, the person's own explicit action.
//   2. mcp-preview is its own action and writes nothing: it answers each file's exact before/after lines and a BLAKE3
//      `review_hash` of the whole plan. mcp-register with --reviewed <hash> refuses every write when the plan changed.
//   3. An entry under the same name that matches none of its declared Trillion signatures is the person's own
//      (custom): never changed and never removed. Every other key in the file and every non-transport field of an
//      owned entry is kept; a local transport migration may remove only the row's named legacy fields.
//   4. An app that is not on this computer is answered not_installed; no folder or file is created for it.
//   5. Writes go through harness/config-file.mjs writeConfig: locked, backed up, refused when the file changed meanwhile
//      or is a symbolic link, and read back.
//   6. An entry is not a signed-in connection: each result names the sign-in still to do in that app.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { JSON_CODEC, hash, json, read, writeConfig } from './config-file.mjs';
import { localDoorAddress } from './local-door.mjs';

export const MCP_ACTIONS = ['mcp-inspect', 'mcp-preview', 'mcp-register', 'mcp-unregister'];
const SCHEMA = 'trillion.mcp-registration-report/v1';
const TEXT_CODEC = { empty: () => '', parse: text => text, format: text => text };
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const expand = (path, home) => path.replace(/^~(?=\/|$)/, home);
const loopbackHttp = parsed => parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname);
const fillEntry = (entry, replacements) => Object.fromEntries(Object.entries(entry).map(([key, value]) => [key,
  typeof value === 'string' ? replaceTokens(value, replacements)
    : Array.isArray(value) ? value.map(item => typeof item === 'string' ? replaceTokens(item, replacements) : item)
      : value]));
const replaceTokens = (value, replacements) => Object.entries(replacements).reduce((next, [name, replacement]) => next.replaceAll(`{${name}}`, replacement), value);

function registrationValues(row, settings, { home, url }) {
  const appPath = resolve(expand(settings.mac_app.path, home));
  const runtime = join(appPath, settings.mac_app.runtime);
  let localMcp = '';
  try { localMcp = localDoorAddress({ runtime, home }); } catch { /* An absent local app does not make remote rows unreadable. */ }
  const replacements = {
    mcp: url,
    runtime,
    bridge: join(appPath, settings.mac_app.payload, 'keychain-mcp-bridge.mjs'),
    ...(localMcp ? { local_mcp: localMcp } : {}),
  };
  return { entry: fillEntry(row.entry, replacements), replacements };
}

function ownedEntry(row, current, replacements) {
  const signatures = Array.isArray(row.same_when) ? row.same_when : [{ [row.same_when]: '{mcp}' }];
  return signatures.some(signature => Object.entries(fillEntry(signature, replacements))
    .every(([field, value]) => isDeepStrictEqual(current[field], value)));
}

/** The config file an app row names: under the folder its home variable names when set, else under the home folder. */
export function clientConfigPath(row, { home = homedir(), env = process.env } = {}) {
  return row.home_variable && env[row.home_variable] ? join(resolve(expand(env[row.home_variable], home)), row.home_file) : join(home, row.file);
}

/** The lines that change between two texts: the part between their common first and last lines. */
export function lineDiff(before, after) {
  const a = before === '' ? [] : before.split('\n'), b = after === '' ? [] : after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  return { at_line: head + 1, removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) };
}

// ---- toml-table: one [path.name] table, found and edited as lines ------------------------------------------------
const key = text => text.trim().replace(/^"(.*)"$/, '$1');
const headerOf = line => { const found = line.match(/^\s*\[\s*([^\][]+?)\s*\]\s*(?:#.*)?$/); return found ? found[1].split('.').map(key) : null; };
const samePrefix = (parts, prefix) => prefix.every((part, at) => parts[at] === part);

/** Where the table is: { state: 'absent' } | { state: 'found', from, to, mainTo, fields } | { state: 'blocked', why }.
 *  `to` ends the table with its own sub-tables, `mainTo` ends its own keys. */
export function tomlTable(text, path, name) {
  const lines = text.split('\n');
  const want = [...path, name];
  const within = parts => parts.length >= want.length && samePrefix(parts, want);
  let table = [], from = -1, to = -1, mainTo = -1, other = false;
  const fields = {};
  lines.forEach((line, at) => {
    const header = headerOf(line);
    if (header) {
      table = header;
      if (header.length === want.length && within(header)) { other ||= from !== -1; from = at; return; }
      if (from === -1) return;
      if (mainTo === -1) mainTo = at;
      if (within(header)) other ||= to !== -1; else if (to === -1) to = at;
      return;
    }
    const assign = line.match(/^\s*("[^"]*"|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!assign) return;
    if (!within(table)) { other ||= within([...table, ...assign[1].split('.').map(key)]); return; }
    if (table.length !== want.length) return;
    const value = assign[2].replace(/\s+#.*$/, '').trim();
    try { fields[key(assign[1])] = JSON.parse(value); } catch { fields[key(assign[1])] = value; }
  });
  if (other) return { state: 'blocked', why: `The ${want.join('.')} entry is written in a form setup does not edit (more than once, or as dotted or inline keys). Nothing was changed.` };
  if (from === -1) return { state: 'absent' };
  const end = to === -1 ? lines.length : to;
  return { state: 'found', from, to: end, mainTo: mainTo === -1 ? end : Math.min(mainTo, end), fields };
}

function tomlSet(text, path, name, entry, removeFields = []) {
  const found = tomlTable(text, path, name);
  const assignments = Object.entries(entry).map(([field, value]) => `${field} = ${JSON.stringify(value)}`);
  if (found.state === 'absent') {
    const lead = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${lead}[${[...path, name].join('.')}]\n${assignments.join('\n')}\n`;
  }
  const lines = text.split('\n');
  const main = lines.slice(found.from + 1, found.mainTo).filter(item => {
    const field = item.match(/^\s*("[^"]*"|[A-Za-z0-9_-]+)\s*=/);
    return !field || !removeFields.includes(key(field[1]));
  });
  for (const [field, value] of Object.entries(entry)) {
    const line = `${field} = ${JSON.stringify(value)}`;
    const at = main.findIndex(item => item.match(/^\s*("[^"]*"|[A-Za-z0-9_-]+)\s*=/) && key(item.split('=')[0]) === field);
    if (at === -1) main.unshift(line); else main[at] = line;
  }
  return [...lines.slice(0, found.from + 1), ...main, ...lines.slice(found.mainTo)].join('\n');
}

function tomlRemove(text, path, name) {
  const found = tomlTable(text, path, name);
  if (found.state !== 'found') return text;
  const lines = text.split('\n');
  const before = lines.slice(0, found.from), after = lines.slice(found.to);
  if (before.length && before.at(-1).trim() === '' && (after.length === 0 || after[0].trim() === '')) before.pop();
  const next = [...before, ...after].join('\n');
  return next.trim() === '' ? '' : next.endsWith('\n') ? next : `${next}\n`;
}

// ---- one app ------------------------------------------------------------------------------------------------------
/** The entry the file holds now under `name`, read without writing: { state, current?, why? }. */
function entryNow(row, text, name) {
  if (row.format === 'toml-table') {
    const found = tomlTable(text ?? '', row.path, name);
    return found.state === 'found' ? { state: 'found', current: found.fields } : found;
  }
  let parsed;
  try { parsed = text === null ? {} : JSON.parse(text); } catch { return { state: 'blocked', why: 'The config is not readable JSON. Nothing was changed.' }; }
  if (!object(parsed)) return { state: 'blocked', why: 'The config is not a JSON object. Nothing was changed.' };
  const holder = row.path.reduce((here, step) => (object(here) ? here[step] : undefined), parsed);
  if (holder !== undefined && !object(holder)) return { state: 'blocked', why: `${row.path.join('.')} is not an object. Nothing was changed.` };
  return holder?.[name] === undefined ? { state: 'absent' } : object(holder[name]) ? { state: 'found', current: holder[name] } : { state: 'blocked', why: `The ${name} entry is not an object. Nothing was changed.` };
}

function jsonChange(row, name, entry, action) {
  return current => {
    const next = structuredClone(current);
    let holder = next;
    for (const step of row.path) { if (holder[step] === undefined) { if (action === 'unregister') return next; holder[step] = {}; } holder = holder[step]; }
    if (action === 'register') {
      const previous = object(holder[name]) ? { ...holder[name] } : {};
      for (const field of row.remove_fields ?? []) delete previous[field];
      holder[name] = { ...previous, ...entry };
    }
    else delete holder[name];
    return next;
  };
}

function scopedJsonText(text, row, name) {
  let parsed = {};
  try { parsed = text === null ? {} : JSON.parse(text); } catch { return text; }
  const holder = row.path.reduce((here, step) => (object(here) ? here[step] : undefined), parsed);
  const entry = object(holder) ? holder[name] : undefined;
  return json(entry === undefined ? {} : { [name]: entry });
}

function planDiff(row, before, after, name) {
  return row.format === 'toml-table'
    ? lineDiff(before, after)
    : lineDiff(scopedJsonText(before, row, name), scopedJsonText(after, row, name));
}

/** What one app has now and what register / unregister would make of it, without writing. */
export function planClient(row, { home = homedir(), env = process.env, name, url, settings }) {
  const path = clientConfigPath(row, { home, env });
  // App-specific commands stay in the shared guide (src/ai-clients.json -> /docs), including in standalone setup payloads.
  const guide = object(row.sign_in) ? row.sign_in : null;
  const localTransportOnly = loopbackHttp(new URL(url));
  const signIn = row.transport === 'local-stdio'
    ? `Complete ${guide?.client ?? row.id} sign-in in Trillion's current guide at ${new URL(guide?.path ?? '/docs', settings?.mcp_registration?.url ?? url).href}; the local bridge reads the existing key from Keychain and uses this Mac's app-owned door. If the door is unavailable, the client receives an explicit error.`
    : localTransportOnly
      ? 'This action configures the local MCP transport only; it does not provide authentication or client proof.'
    : guide
      ? `Finish sign-in using the ${guide.client} instructions in Trillion's current guide: ${new URL(guide.path, url).href}`
      : row.sign_in;
  const base = { client: row.id, path, sign_in: signIn };
  if (!row.installed_when.some(folder => existsSync(join(home, folder))) && !(row.home_variable && env[row.home_variable])) return { ...base, now: 'not_installed' };
  const text = read(path);
  const now = entryNow(row, text, name);
  if (now.state === 'blocked') return { ...base, now: 'blocked', why: now.why };
  const { entry, replacements } = registrationValues(row, settings, { home, url });
  const ours = now.state === 'found' && ownedEntry(row, now.current, replacements);
  if (now.state === 'found' && !ours) return { ...base, now: 'custom', why: `A ${name} entry that points somewhere else is the person's own; it is never changed or removed.` };
  const current = ours && Object.entries(entry).every(([field, value]) => isDeepStrictEqual(now.current[field], value));
  const before = text ?? '';
  const register = row.format === 'toml-table' ? tomlSet(before, row.path, name, entry, row.remove_fields) : json(jsonChange(row, name, entry, 'register')(text === null ? {} : JSON.parse(text)));
  const unregister = now.state === 'absent' ? before : row.format === 'toml-table' ? tomlRemove(before, row.path, name) : json(jsonChange(row, name, entry, 'unregister')(JSON.parse(text)));
  const diffs = { register: planDiff(row, before, register, name), unregister: planDiff(row, before, unregister, name) };
  return { ...base, now: now.state === 'absent' ? 'absent' : current ? 'registered' : 'outdated', file_exists: text !== null, before, register, unregister, diffs };
}

const transformFor = (row, name, url, action, settings, home) => {
  const { entry } = registrationValues(row, settings, { home, url });
  return row.format === 'toml-table'
    ? (action === 'register' ? text => tomlSet(text, row.path, name, entry, row.remove_fields) : text => tomlRemove(text, row.path, name))
    : jsonChange(row, name, entry, action);
};

/**
 * registerMcp({ action, clients, url?, reviewed?, home?, env?, rules? }) -> report with one result per named app.
 * mcp-inspect and mcp-preview write nothing; mcp-register and mcp-unregister write only the named apps' files.
 */
export function registerMcp({ action, clients, url, reviewed, home = homedir(), env = process.env, rules, write = writeConfig }) {
  const settings = rules.mcp_registration;
  if (!MCP_ACTIONS.includes(action)) throw new Error(`Use --action ${MCP_ACTIONS.join(', ')}.`);
  const address = url ?? settings.url;
  const parsed = new URL(address);
  if ((parsed.protocol !== 'https:' && !loopbackHttp(parsed)) || parsed.username || parsed.password) {
    throw new Error('The MCP address must use https or http at the literal loopback host 127.0.0.1 or [::1], with no sign-in in it.');
  }
  const ids = String(clients ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!ids.length) throw new Error(`Name the AI apps with --client (any of ${settings.clients.map(row => row.id).join(', ')}).`);
  const unknown = ids.filter(id => !settings.clients.some(row => row.id === id));
  if (unknown.length) throw new Error(`No MCP registration row for ${unknown.join(', ')}. Supported: ${settings.clients.map(row => row.id).join(', ')}.`);
  if (reviewed !== undefined && action !== 'mcp-register') throw new Error('--reviewed belongs to mcp-register.');
  const rows = ids.map(id => settings.clients.find(row => row.id === id));
  if (url !== undefined && rows.some(row => row.transport === 'local-stdio')) {
    throw new Error('Claude Code and Codex use the installed Mac app\'s local bridge; do not set a fixed --mcp-url.');
  }
  const plans = rows.map(row => planClient(row, { home, env, name: settings.name, url: address, settings: rules }));
  const change = action === 'mcp-unregister' ? 'unregister' : 'register';
  const diffs = plans.map(plan => (plan.before === undefined ? null : { path: plan.path, before_blake3: hash(plan.before), after_blake3: hash(plan[change]) }));
  const localBridge = rows.some(row => row.transport === 'local-stdio');
  const transport = localBridge ? 'installed-local-bridge' : 'http';
  const review_hash = hash(JSON.stringify({ name: settings.name, transport, ...(localBridge ? {} : { url: address }), files: diffs }));
  const boundary = localBridge
    ? 'This entry uses the installed Mac app bridge, which reads its current local door address for each call, keeps the account key in Keychain and process memory, and returns an explicit error if the door is unavailable.'
    : loopbackHttp(parsed)
    ? 'This local MCP entry configures transport only; it does not authenticate the client or provide client proof.'
    : 'An entry is not a signed-in connection; complete each app\'s sign-in, then its Trillion round trip.';
  const report = { schema: SCHEMA, action, name: settings.name, ...(localBridge ? { transport } : { url: address, transport }), review_hash, boundary };
  const shown = plan => ({ client: plan.client, path: plan.path, now: plan.now, ...(plan.why ? { why: plan.why } : {}), sign_in: plan.sign_in });
  if (action === 'mcp-inspect') return { ...report, results: plans.map(shown) };
  if (action === 'mcp-preview') {
    return { ...report, change, results: plans.map(plan => ({ ...shown(plan), ...(plan.before === undefined ? {} : { would_change: plan.before !== plan[change], diff: plan.diffs[change] }) })) };
  }
  if (reviewed !== undefined && reviewed !== review_hash) {
    return { ...report, refused: 'The files or the entry changed since the reviewed preview. Run mcp-preview again; nothing was written.', results: plans.map(shown) };
  }
  const results = plans.map(plan => {
    if (['not_installed', 'blocked', 'custom'].includes(plan.now)) return { ...shown(plan), result: plan.now };
    const row = rows.find(item => item.id === plan.client);
    if (change === 'register' && plan.now === 'registered') return { ...shown(plan), result: 'already_registered' };
    if (change === 'unregister' && plan.now === 'absent') return { ...shown(plan), result: 'already_absent' };
    try {
      const written = write(plan.path, transformFor(row, settings.name, address, change, rules, home), { codec: row.format === 'toml-table' ? TEXT_CODEC : JSON_CODEC });
      const result = change === 'unregister' ? 'removed' : plan.now === 'absent' ? 'registered' : 'updated';
      return { ...shown(plan), result, diff: plan.diffs[change], ...(written.backup ? { backup: written.backup } : {}), after_blake3: written.after_blake3 ?? null };
    } catch (error) { return { ...shown(plan), result: 'blocked', why: error.message }; }
  });
  return { ...report, results };
}
