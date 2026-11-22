// apply-a-computer-row.mjs [--dry-run] --targets FILE REQUEST_FILE   (the database connection string on descriptor 3)
//
// Changes a computer's row in its database and applies it to that computer, in one run: read the row, make the request's
// compare-and-set edits, write it back (read back equal), unpack the Workshop commit whose start-a-computer applies, probe the
// computer's public addresses while the apply runs, run the apply, and print one JSON summary. The exit code is the apply's.
//
// The request file: { computer, workshop_commit, edits: [{ at, from?, to?, remove?, add? }], links?: { folder, set: { name: target } } }.
//  - `at` is a path of dotted keys whose array steps may select an element by one of its fields, runs.units[unit=example.service].source.commit,
//    or by position, runs.units[0]. `from` is compared (deep equal) with what is at `at` before `to` is written or `remove` deletes
//    it; `add` appends its value to the array at `at` unless an equal element is there. One edit that cannot be made, a `from`
//    that does not match, a selector that matches none or several, refuses the whole request before anything is written.
//  - `links.set` names the symlinks of `links.folder` an apply carries (a site's pages folder): they are set after the row is
//    written, before the apply reads them, and put back as they were when the apply fails.
//  - A failed apply puts the row back to exactly what was read, by the same compare-and-set (it changes the row only while it still
//    is what this run wrote): the computer keeps serving what it served, so the row must keep saying so. The summary says
//    `row_put_back` and whether the database read back what was put.
// The machine's ssh identity, known_hosts and pages folder, by the row's address, and the program that reads a held value by vault
// name are the person's own: they come from the file `--targets` names (its `machines` and `held_value_reader`), laid over the
// defaults of read-data/apply-a-computer-row.json (the SQL process, the probe's timings). A shared tool names no one's machine. The row is read and written by the SQL
// tool's own process (the connection string on its descriptor 3). Values the row's units name by vault name are handed to the apply on
// descriptor 5, as start-a-computer takes them; none is in argv, a file or the summary. `--dry-run` stops after the edits and writes nothing.
import { spawn, execFile } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const refused = message => Object.assign(new Error(message), { exit: 2 });
const COMMIT = /^[0-9a-f]{40}$/;

/** A path of the DATA: `{home}` is the home of whoever runs this, read at run time. */
const placed = (path, tokens = {}) => Object.entries({ home: homedir(), ...tokens }).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), path);

/** The steps of a path: `{ key }`, or `{ key, field, value }` / `{ key, index }` when the key's array is entered by selector. */
export function parsePath(at) {
  if (typeof at !== 'string' || !at) throw refused('an edit needs `at`, the path it changes.');
  const steps = [];
  let i = 0;
  while (i < at.length) {
    let j = i;
    while (j < at.length && at[j] !== '.' && at[j] !== '[') j++;
    const step = { key: at.slice(i, j) };
    if (!step.key) throw refused(`"${at}" has an empty step at character ${i}.`);
    if (at[j] === '[') {
      const close = at.indexOf(']', j);
      const inner = close < 0 ? '' : at.slice(j + 1, close);
      const equals = inner.indexOf('=');
      if (/^\d+$/.test(inner)) step.index = Number(inner);
      else if (equals > 0) Object.assign(step, { field: inner.slice(0, equals), value: inner.slice(equals + 1) });
      else throw refused(`"${at}" has a selector that is neither [field=value] nor [position].`);
      j = close + 1;
    }
    steps.push(step);
    if (j < at.length) {
      if (at[j] !== '.' || j + 1 >= at.length) throw refused(`"${at}" has a misplaced "${at[j]}" at character ${j}.`);
      j++;
    }
    i = j;
  }
  return steps;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Where `at` is in `root`: the object or array that holds it, its key there, and whether it is there. */
function locate(root, at) {
  const steps = parsePath(at);
  let container = root;
  for (const [position, step] of steps.entries()) {
    const last = position === steps.length - 1;
    if (!isObject(container)) throw refused(`${at}: ${step.key} is not under an object.`);
    if (step.field === undefined && step.index === undefined) {
      if (last) return { container, key: step.key, found: Object.hasOwn(container, step.key) };
      if (!Object.hasOwn(container, step.key)) throw refused(`${at}: no ${step.key} to enter.`);
      container = container[step.key];
      continue;
    }
    const list = container[step.key];
    if (!Array.isArray(list)) throw refused(`${at}: ${step.key} is not an array.`);
    const matches = step.index !== undefined ? (step.index < list.length ? [step.index] : [])
      : list.flatMap((element, index) => (isObject(element) && String(element[step.field]) === step.value ? [index] : []));
    if (matches.length > 1) throw refused(`${at}: ${step.field}=${step.value} matches ${matches.length} elements of ${step.key}; name one.`);
    if (!matches.length) {
      if (last) return { container: list, key: -1, found: false };
      throw refused(`${at}: no element of ${step.key} has ${step.field}=${step.value}.`);
    }
    if (last) return { container: list, key: matches[0], found: true };
    container = list[matches[0]];
  }
  throw refused(`${at} names no path.`);
}

const operationOf = (edit, where) => {
  if (!isObject(edit)) throw refused(`${where} is no edit object.`);
  const named = ['to', 'remove', 'add'].filter(name => Object.hasOwn(edit, name));
  if (named.length !== 1) throw refused(`${where} needs exactly one of to, remove, add.`);
  if (named[0] === 'remove' && edit.remove !== true) throw refused(`${where} remove is true.`);
  if (named[0] === 'add' && Object.hasOwn(edit, 'from')) throw refused(`${where} add checks nothing with from; it appends only when absent.`);
  return named[0];
};

/**
 * `row` with every edit made, in order, and what each changed ({ at, op, before, after }). `row` itself is not touched. An edit that
 * cannot be made, or whose `from` is not what is there, throws: nothing is half-applied.
 */
export function applyEdits(row, edits) {
  const edited = structuredClone(row), changes = [];
  for (const [index, edit] of edits.entries()) {
    const where = `edits[${index}] (${edit?.at})`;
    const op = operationOf(edit, where);
    const { container, key, found } = locate(edited, edit.at);
    const before = found ? structuredClone(container[key]) : undefined;
    if (Object.hasOwn(edit, 'from') && !isDeepStrictEqual(before, edit.from)) {
      throw refused(`${where}: it holds ${before === undefined ? 'nothing' : JSON.stringify(before)}, not ${JSON.stringify(edit.from)}. The row changed or the request is stale; nothing was written.`);
    }
    if (op === 'to') {
      if (!found && Array.isArray(container)) throw refused(`${where}: no element is there to replace.`);
      container[key] = structuredClone(edit.to);
    } else if (op === 'remove') {
      if (!found) throw refused(`${where}: nothing is there to remove.`);
      if (Array.isArray(container)) container.splice(key, 1); else delete container[key];
    } else {
      if (!found || !Array.isArray(container[key])) throw refused(`${where}: add needs an array there.`);
      if (!container[key].some(element => isDeepStrictEqual(element, edit.add))) container[key].push(structuredClone(edit.add));
    }
    changes.push({ at: edit.at, op, before, after: op === 'remove' ? undefined : structuredClone(container[key]) });
  }
  if (edited.name !== row.name) throw refused('an edit changed the row name; a rename is not an apply.');
  if (!isObject(edited.runs)) throw refused('the edited row has no runs object.');
  return { row: edited, changes };
}

/** The symlinks of `folder` set to `set` (name to target); the returned function puts each back as it was (absent, or its old target). */
export function setLinks(folder, set) {
  const before = Object.keys(set).map(name => {
    const path = join(folder, name);
    let target = null;
    try { target = readlinkSync(path); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EINVAL') throw error; }
    return { path, target };
  });
  const remove = path => { try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  const point = (path, target) => {
    const staged = `${path}.apply-${process.pid}`;
    remove(staged);
    symlinkSync(target, staged);
    renameSync(staged, path);
  };
  for (const [name, target] of Object.entries(set)) point(join(folder, name), target);
  return () => {
    for (const { path, target } of before) { if (target === null) remove(path); else point(path, target); }
  };
}

/** The host names a row says it answers (`host_name`, `host`, `hosts`, `accepts_hosts` anywhere in it), in the order found. */
export function hostsOf(row) {
  const found = [];
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!isObject(value)) return;
    for (const [key, inner] of Object.entries(value)) {
      if (['host_name', 'host'].includes(key) && typeof inner === 'string') found.push(inner);
      else if (['hosts', 'accepts_hosts'].includes(key) && Array.isArray(inner)) found.push(...inner.filter(host => typeof host === 'string'));
      else walk(inner);
    }
  };
  walk(row);
  return [...new Set(found.filter(host => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)))];
}

/** The vault names a row's units and names ask for: sealed secrets, credentials, a source's key and a name provider's key. */
export function heldNamesOf(row) {
  const names = [];
  for (const unit of row.runs.units ?? []) {
    names.push(unit.secret_vault_key, unit.source?.credential, ...(unit.credentials ?? []).map(credential => credential.vault_key));
  }
  names.push(...(row.runs.names ?? []).map(name => name.provider?.vault_key));
  return [...new Set(names.filter(name => typeof name === 'string' && name))];
}

const timeOf = ms => new Date(ms).toLocaleTimeString('en-US', { timeZoneName: 'short' });

/** The request, checked: every field it may carry and nothing the program would have to guess. */
export function checkRequest(request) {
  if (!isObject(request)) throw refused('the request is one JSON object.');
  if (typeof request.computer !== 'string' || !request.computer) throw refused('the request needs `computer`, the row name.');
  if (!COMMIT.test(request.workshop_commit ?? '')) throw refused('the request needs `workshop_commit`, a full commit id.');
  if (request.edits !== undefined && !Array.isArray(request.edits)) throw refused('`edits` is an array.');
  const links = request.links;
  if (links !== undefined && (!isObject(links) || typeof links.folder !== 'string' || !isObject(links.set) || Object.values(links.set).some(target => typeof target !== 'string'))) {
    throw refused('`links` is { folder, set: { name: target } }.');
  }
  if (links && Object.keys(links.set).some(name => !name || name.includes('/'))) throw refused('a link name is one folder entry, with no "/".');
  return { computer: request.computer, workshop_commit: request.workshop_commit, edits: request.edits ?? [], links };
}

/**
 * One whole run. `deps` is everything outside the program's own logic: `store` (read(name) answers { computer, siteSetting },
 * write(name, computer) answers { read_back_equal }), `targets` (read-data/apply-a-computer-row.json), `heldValues(names)`,
 * `archive(commit, folder)`, `runFolder(name)`, `startProbe({ tree, urls, log })` (answers `stop()`), `runApply({ tree, requestFile, held, out, err })`
 * (answers the exit code), `addressesOf(host)` (a fresh lookup of a name's addresses), `sleep(ms)` and `now()`.
 */
export async function applyARow(rawRequest, { dryRun = false }, deps) {
  const request = checkRequest(rawRequest);
  const { computer, siteSetting } = await deps.store.read(request.computer);
  const { row, changes } = applyEdits(computer, request.edits);
  const machine = deps.targets.machines?.[row.address];
  if (!machine) throw refused(`${row.name} is at ${row.address}, which the targets file names no ssh identity for.`);
  if (dryRun) return { code: 0, summary: { dry_run: true, computer: row.name, changes } };

  const held = await deps.heldValues(heldNamesOf(row));
  const changed = changes.some(change => !isDeepStrictEqual(change.before, change.after));
  const written = changed && (await deps.store.write(row.name, row)).read_back_equal === true;
  if (changed && !written) throw new Error('the database did not read back what was written; no apply was run.');

  const log = deps.runFolder(row.name);
  const rowFolder = join(log, 'row'), tree = join(log, 'tree');
  mkdirSync(rowFolder, { recursive: true });
  writeFileSync(join(rowFolder, 'computer.json'), `${JSON.stringify(row, null, 1)}\n`);
  const siteFile = (row.runs.units ?? []).map(unit => unit.parts?.['/settings/site']?.file).find(Boolean);
  if (siteFile && siteSetting) {
    mkdirSync(dirname(join(rowFolder, siteFile)), { recursive: true });
    writeFileSync(join(rowFolder, siteFile), `${siteSetting}\n`);
  }
  await deps.archive(request.workshop_commit, tree);
  const applyRequest = join(log, 'request.json');
  writeFileSync(applyRequest, `${JSON.stringify({
    machine: { address: row.address },
    ssh: { known_hosts: placed(machine.ssh.known_hosts), identity_file: placed(machine.ssh.identity_file) },
    computer_row_file: join(rowFolder, 'computer.json'),
    ...(machine.pages_folder && { pages_folder: placed(machine.pages_folder) }),
  }, null, 1)}\n`);

  const put = request.links ? setLinks(placed(request.links.folder), request.links.set) : () => {};
  const hosts = hostsOf(row).slice(0, deps.targets.probe?.max_urls ?? 6);
  const urls = hosts.length ? hosts.map(host => `https://${host}/`) : [`https://${row.address}/`];
  const probe = await deps.startProbe({ tree, urls, log: join(log, 'probe-requests.jsonl') });
  const started = deps.now();
  let code = 1, ended = started, probed = null, putBack = null;
  try {
    await deps.sleep(deps.targets.probe?.start_wait_ms ?? 0);
    code = await deps.runApply({ tree, requestFile: applyRequest, held, out: join(log, 'apply.out'), err: join(log, 'apply.err') });
  } finally {
    ended = deps.now();
    if (code !== 0) {
      put();
      if (written) putBack = await deps.store.write(row.name, computer).then(({ read_back_equal }) => ({ row_put_back: read_back_equal }), error => ({ row_put_back: false, row_put_back_error: error.message }));
    }
    await deps.sleep(deps.targets.probe?.stop_after_ms ?? 0);
    probed = await probe.stop();
  }
  const { failures, slow_requests, ...totals } = probed ?? {};
  // The probe keeps its connections open, so it never sees a second address a name answers with; each name is looked up fresh.
  const elsewhere = code === 0 ? await namesAnsweringElsewhere(row, deps.addressesOf) : [];
  return {
    code: elsewhere.length ? 6 : code,
    summary: {
      computer: row.name, workshop_commit: request.workshop_commit, row_written: written, ...putBack,
      started: timeOf(started), ended: timeOf(ended), apply_exit: code,
      ...(request.links && { links: code === 0 ? 'set' : 'put back' }),
      ...(elsewhere.length && { names_answering_elsewhere: elsewhere }),
      probe: { urls, ...totals }, log_folder: log,
    },
  };
}

/** The names of `runs.names` that do not answer with the row's address alone, each with what a fresh lookup answered. A name with a
 *  second address beside the row's (a provider's redirect record that no remove call can name, kept beside an adopted A record)
 *  sends some fresh visitors to a host that may not serve the site, which a probe over kept connections cannot see: one fresh
 *  visit in two hung on such an address after an apply that passed (Nov 22 2026, 3:54 AM CST). Such a run exits 6. */
export async function namesAnsweringElsewhere(row, addressesOf) {
  const off = [];
  for (const name of row.runs?.names ?? []) {
    if (typeof name?.host_name !== 'string') continue;
    const addresses = await addressesOf(name.host_name).then(found => [...new Set(found)].sort(), error => [`not found: ${error.code ?? error.message}`]);
    if (addresses.length !== 1 || addresses[0] !== row.address) off.push({ host_name: name.host_name, addresses });
  }
  return off;
}

/** The rows of a SQL answer as objects, whichever shape the SQL process gave them. */
const objectsOf = ({ columns, rows }) => rows.map(row => (Array.isArray(row) ? Object.fromEntries(columns.map((column, index) => [column?.name ?? column, row[index]])) : row));

/**
 * The row store over a SQL process (`sql(statement, params)` answers the SQL tool's { columns, rows }): a row is read as it is
 * and written back by one statement that changes it only while it still is what was read, and answers what the database now holds.
 */
export function sqlRowStore(sql) {
  const readAs = new Map();
  return {
    async read(name) {
      const [row] = objectsOf(await sql("select name, address, os, arch, libc, what_this_is, runs::text as runs, (select value::text from setting where name = 'site') as site from computer where name = $1", [name]));
      if (!row) throw refused(`no computer row named ${name}`);
      readAs.set(name, { runs: row.runs, what_this_is: row.what_this_is });
      const computer = { _what: row.what_this_is, name: row.name, address: row.address, os: row.os, arch: row.arch, ...(row.libc ? { libc: row.libc } : {}), runs: JSON.parse(row.runs) };
      return { computer, siteSetting: row.site ?? null };
    },
    async write(name, computer) {
      const was = readAs.get(name);
      const [now] = objectsOf(await sql('update computer set address = $2, os = $3, arch = $4, libc = $5, what_this_is = $6, runs = $7 where name = $1 and runs::text = $8 and what_this_is is not distinct from $9 returning runs::text as runs',
        [name, computer.address, computer.os, computer.arch, computer.libc ?? null, computer._what, JSON.stringify(computer.runs), was.runs, was.what_this_is]));
      if (!now) throw new Error(`the ${name} row changed since it was read; read it again and redo the edit`);
      readAs.set(name, { runs: now.runs, what_this_is: computer._what });
      return { read_back_equal: now.runs === JSON.stringify(computer.runs) };
    },
  };
}

async function pipe(fd) {
  let text = '';
  try { for await (const bytes of createReadStream(null, { fd, autoClose: false })) { text += bytes; if (text.length > 65536) throw new Error(`Descriptor ${fd} exceeds its private input bound.`); } }
  catch (error) { if (error.code === 'EBADF') return ''; throw error; }
  return text.trim();
}

/** One statement run by the SQL tool's own process (argv from the DATA; the statement on its stdin, the connection on its descriptor 3). */
const sqlBy = (argv, connection) => (statement, params) => new Promise((done, fail) => {
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.on('error', fail).on('close', code => {
    if (code !== 0) fail(new Error(err.trim() || `the SQL process exited ${code}`));
    else done(JSON.parse(out));
  });
  child.stdio[3].end(connection);
  child.stdin.end(JSON.stringify({ sql: statement, params }));
});

/** The held value of each vault name, read by the program the DATA names (`held_value_reader` argv, the name last). A name that
 *  cannot be read is left out: the apply refuses the unit that needs it, and the value is never printed here. */
const heldValuesBy = reader => async names => {
  const held = {};
  for (const name of names) {
    try { held[name] = (await run(placed(reader[0]), [...reader.slice(1).map(part => placed(part)), name], { maxBuffer: 1 << 20 })).stdout; } catch { /* left out */ }
  }
  return held;
};

/** A new folder for one run, by its real path. A program in the unpacked tree runs its main block only when its argv path equals
 *  its module's own (real) path; under a temporary folder reached through a symlink (/var -> /private/var) the two differ, and
 *  start-a-computer exited 0 having done nothing (12:58 AM CST Nov 22). */
export const runFolder = name => realpathSync(mkdtempSync(join(tmpdir(), `row-${name}-`)));

const realDeps = ({ store, targets, workshop }) => ({
  store, targets,
  heldValues: heldValuesBy(targets.held_value_reader),
  runFolder,
  async archive(commit, folder) {
    mkdirSync(folder, { recursive: true });
    const tarball = (await run('git', ['-C', workshop, 'archive', commit], { encoding: 'buffer', maxBuffer: 1 << 30 })).stdout;
    await new Promise((done, fail) => {
      const tar = spawn('tar', ['-x', '-C', folder], { stdio: ['pipe', 'ignore', 'inherit'] });
      tar.on('error', fail).on('exit', code => (code === 0 ? done() : fail(new Error(`tar exited ${code}`))));
      tar.stdin.end(tarball);
    });
    if (existsSync(join(workshop, 'node_modules'))) symlinkSync(join(workshop, 'node_modules'), join(folder, 'node_modules'));
  },
  async startProbe({ tree, urls, log }) {
    const child = spawn(process.execPath, [join(tree, 'tools/start-a-computer/do-work/probe-while-applying.mjs'), '--log', log, ...urls], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    const exited = new Promise(done => child.on('exit', done));
    return { async stop() { child.kill('SIGTERM'); await exited; try { return JSON.parse(out); } catch { return null; } } };
  },
  async runApply({ tree, requestFile, held, out, err }) {
    const [outFd, errFd] = [openSync(out, 'w'), openSync(err, 'w')];
    try {
      const child = spawn(process.execPath, [join(tree, 'tools/start-a-computer/do-work/start-a-computer.mjs'), 'apply', requestFile], { cwd: tree, stdio: ['ignore', outFd, errFd, 'ignore', 'ignore', 'pipe'] });
      child.stdio[5].end(JSON.stringify(held));
      return await new Promise((done, fail) => child.on('error', fail).on('exit', (code, signal) => done(code ?? (signal ? 128 : 1))));
    } finally { closeSync(outFd); closeSync(errFd); }
  },
  addressesOf: host => resolve4(host),
  sleep: ms => new Promise(done => setTimeout(done, ms)),
  now: () => Date.now(),
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dryRun = args.includes('--dry-run');
  const flagAt = args.indexOf('--targets'), targetsFile = flagAt < 0 ? undefined : args[flagAt + 1];
  const [file, extra] = args.filter((arg, index) => arg !== '--dry-run' && arg !== '--targets' && index !== flagAt + 1);
  try {
    if (!file || extra || !targetsFile) throw refused('usage: apply-a-computer-row.mjs [--dry-run] --targets FILE REQUEST_FILE (the database connection string on descriptor 3)');
    const connection = await pipe(3);
    if (!connection) throw refused('the database connection string arrives on descriptor 3; none did.');
    const defaults = JSON.parse(readFileSync(join(here, '../read-data/apply-a-computer-row.json'), 'utf8'));
    const targets = { ...defaults, ...JSON.parse(readFileSync(targetsFile, 'utf8')) };
    if (!Array.isArray(targets.held_value_reader)) throw refused(`${targetsFile} names no held_value_reader (an argv).`);
    const workshop = (await run('git', ['-C', here, 'rev-parse', '--show-toplevel'])).stdout.trim();
    const sql = sqlBy(targets.sql_runner.map(part => placed(part, { workshop })), connection);
    const { code, summary } = await applyARow(JSON.parse(readFileSync(file, 'utf8')), { dryRun }, realDeps({ store: sqlRowStore(sql), targets, workshop }));
    process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
