// apply-a-computer-row.mjs [--dry-run] --targets FILE REQUEST_FILE   (the database connection string on descriptor 3)
//
// Verify the selected child's result contract and a completed response from every probe URL before a row or link write.
// Missing machine results need readback; missing final probe evidence is separate and never rolls back a verified switch.
// Changes a computer's row in its database and applies it to that computer, in one run: read the row, make the request's
// compare-and-set edits, write it back (read back equal), unpack the Workshop commit whose start-a-computer applies, probe the
// computer's public addresses while the apply runs, run the apply, and print one JSON summary. The exit code is the apply's.
//
// The request file: { computer, workshop_commit, edits: [{ at, from?, to?, remove?, add? }], links?: { folder, set: { name: target } } }.
//  - `at` is a path of dotted keys whose array steps may select an element by one of its fields, runs.units[unit=example.service].source.commit,
//    or by position, runs.units[0]. `from` is compared (deep equal) with what is at `at` before `to` is written or `remove` deletes
//    it; `add` appends its value to the array at `at` unless an equal element is there. One edit that cannot be made, a `from`
//    that does not match, a selector that matches none or several, refuses the whole request before anything is written.
//  - `links.set` names the symlinks of `links.folder` an apply carries (a site's pages folder; `{home}` in the folder or a target is this
//    computer's home): they are set after the row is
//    written, before the apply reads them, and put back as they were when the apply fails.
//  - A failed apply puts the row back to exactly what was read, by the same compare-and-set (it changes the row only while it still
//    is what this run wrote): the computer keeps serving what it served, so the row must keep saying so. The summary says
//    `row_put_back` and whether the database read back what was put. The apply's receipt says when that holds: it refused before
//    changing the computer (`apply_not_started`), or a boot check failed and its rollback put back everything it changed
//    (`put_back`, with what `rolled_back` did). A failure whose receipt says neither keeps the row for readback.
//  - The row keeps the Workshop commit its computer was last applied from, `runs.rendered_from_workshop`, written by the same
//    compare-and-set as the edits. Every unit renders from the request's commit, so a commit that is not that one or one after it
//    renders an older kit over the computer (Nov 22 2026, 6:15 AM CST: an apply from a commit made before the web server kit learned
//    to send each www name to its first name took that away for ten minutes). Such a request is refused before anything is written;
//    a commit not found here is fetched once first. A row that records no commit yet is applied and then records one.
// The machine's ssh identity, known_hosts and pages folder, by the row's address, and the program that reads a held value by vault
// name are the person's own: they come from the file `--targets` names (its `machines` and `held_value_reader`), laid over the
// defaults of read-data/apply-a-computer-row.json (the SQL process, the probe's timings). A shared tool names no one's machine. The row is read and written by the SQL
// tool's own process (the connection string on its descriptor 3). Values the row's units name by vault name are handed to the apply on
// descriptor 5, as start-a-computer takes them; none is in argv, a file or the summary. `--dry-run` stops after the edits and the commit
// check, says what the check found, and writes nothing.
// One apply of a row at a time: a run holds the row (an advisory lock on a database session of its own, do-work/hold-a-computer-row.mjs)
// from before it reads it until after its last write-back, and a second run of the same row is refused at once with who holds it and
// since when (exit 3). A dry run takes no hold.
import { spawn, execFile } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { engineScopeForEdit, engineScopeSiteFile, readEngineScope, ROW_ENGINE_SCOPE_PROTOCOL } from './start-a-computer.mjs';
import { withSlots } from './render-what-a-computer-runs.mjs';
import { holdComputerRow } from './hold-a-computer-row.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const refused = message => Object.assign(new Error(message), { exit: 2 });
const COMMIT = /^[0-9a-f]{40}$/;
const APPLY_PROTOCOL = 1;
const SWITCH_UNCONFIRMED = 5;
const PROBE_EVIDENCE_UNCONFIRMED = 7;

function confirmedApplyExit({ exit, receipt } = {}) {
  if (receipt?.row_apply_protocol === APPLY_PROTOCOL) {
    if (exit === SWITCH_UNCONFIRMED && isObject(receipt.slot_switch_unconfirmed)) return exit;
    const failed = exit === 1 || exit === 2;
    if (failed && receipt.apply_not_started === true && typeof receipt.error === 'string') return exit;
    if (failed && receipt.put_back === true && Array.isArray(receipt.apply_checked) && isObject(receipt.rolled_back) &&
        Array.isArray(receipt.rolled_back.restored) && !Object.hasOwn(receipt.rolled_back, 'failed') && typeof receipt.error === 'string') return exit;
    const stopped = receipt.slot_not_switched;
    if ((exit === 1 || exit === 2) && stopped?.candidate_stopped === true &&
        typeof stopped.incumbent === 'string' && typeof stopped.candidate === 'string' && stopped.incumbent !== stopped.candidate) return exit;
    const validUnits = !Object.hasOwn(receipt, 'error') && Array.isArray(receipt.written) && receipt.written.every(path => typeof path === 'string') &&
      Array.isArray(receipt.restarted) && receipt.restarted.every(unit => typeof unit === 'string');
    const validNames = receipt.names === undefined || (Array.isArray(receipt.names) && receipt.names.every(isObject));
    if (validUnits && validNames && (receipt.names_unconfirmed === undefined || typeof receipt.names_unconfirmed === 'string')) {
      const namesPending = receipt.names_unconfirmed !== undefined || (receipt.names ?? []).some(name => name.unanswered);
      if (exit === (namesPending ? 4 : 0)) return exit;
    }
  }
  throw Object.assign(new Error(`the apply ${Number.isInteger(exit) ? `exited ${exit}` : 'did not report an exit'} without a matching machine result.`), {
    exit: exit || 1, child_exit: exit,
  });
}

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

/** Set the links and return their undo. If installation fails partway through, undo the links already set. */
export function setLinks(folder, set) {
  const readTarget = path => {
    try { return readlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  };
  const changes = Object.entries(set).map(([name, to]) => {
    const path = join(folder, name);
    return { path, from: readTarget(path), to };
  }).filter(({ from, to }) => from !== to);
  const remove = path => { try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  const point = (path, target) => {
    const staged = `${path}.apply-${process.pid}`;
    symlinkSync(target, staged);
    try { renameSync(staged, path); } catch (error) { remove(staged); throw error; }
  };
  const installed = [];
  const put = () => {
    const errors = [];
    for (const { path, from, to } of installed) {
      try {
        const current = readTarget(path);
        if (current === from) continue;
        if (current !== to) throw new Error(`${path} changed since this run set it`);
        if (from === null) remove(path); else point(path, from);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
  };
  try {
    for (const change of changes) {
      point(change.path, change.to);
      installed.push(change);
    }
  } catch (error) {
    try { put(); } catch (restoreError) { throw new Error(`${error.message}; could not restore links: ${restoreError.message}`, { cause: error }); }
    throw error;
  }
  return put;
}

/** The host names a row says it answers (`host_name`, `host`, `hosts`, `accepts_hosts` anywhere in it), in the order found. An IP
 *  address or a .localhost name is never one (Nov 24 2026: a unit's internal host 127.0.0.1 became a probe URL and the apply refused),
 *  and neither is a `host` named beside a `port` that is not 80 or 443: that is a target the row reaches (a database), not a page it
 *  serves (Nov 25 2026, 10:55 AM CST: an engine's report.private_targets {host, port: 5432} became a probe URL; the name answered
 *  Elestio's self-signed default once another pipeline was made, and the apply refused before writing anything). */
export function hostsOf(row) {
  const found = [];
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!isObject(value)) return;
    const reached = value.port !== undefined && ![80, 443, '80', '443'].includes(value.port);
    for (const [key, inner] of Object.entries(value)) {
      if (['host_name', 'host'].includes(key) && typeof inner === 'string') { if (!reached) found.push(inner); }
      else if (['hosts', 'accepts_hosts'].includes(key) && Array.isArray(inner)) found.push(...inner.filter(host => typeof host === 'string'));
      else walk(inner);
    }
  };
  walk(row);
  return [...new Set(found.filter(host => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !isIP(host) && !host.endsWith('.localhost')))];
}


/** A scoped engine probe uses the existing front door's exact engine route and slot pool, never its root redirect. */
export function engineProbeOf(row, scope) {
  const units = row.runs.units;
  const engines = units.filter(unit => unit.unit === scope.unit);
  if (engines.length !== 1) throw refused('the engine probe needs its one declared engine.');
  const engine = engines[0], slots = withSlots({ units: [engine] }).units;
  const listen = slots.map(slot => slot.health_listen).sort();
  const accepted = (engine.settings?.doors ?? []).flatMap(door => door.accepts_hosts ?? []);
  const path = '/.well-known/oauth-protected-resource';
  const doors = units.filter(unit => unit.prepare === 'tools/keep-a-caddy-front-door-on-a-computer/prepare-a-caddy-site.mjs' &&
    unit.site?.site_file === 'single-name-front-door' &&
    unit.site.engine_routes?.includes('tools/keep-an-engine-on-a-computer/caddy-route-engine.caddy') &&
    unit.site.engine_paths?.includes(path) &&
    Array.isArray(unit.site.pools?.engine?.listen) &&
    isDeepStrictEqual([...unit.site.pools.engine.listen].sort(), listen));
  if (doors.length !== 1 || listen.length !== 2 || new Set(listen).size !== 2) {
    throw refused('the engine probe needs one declared front door with the exact engine pool and metadata path.');
  }
  const host = doors[0].site.door_host;
  if (typeof host !== 'string' || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || !accepted.includes(host)) {
    throw refused('the engine probe host must be a public name the selected engine accepts.');
  }
  return { url: `https://${host}${path}`, expectedResource: `https://${host}/mcp` };
}

/** The vault names a row's units and names ask for: sealed secrets, credentials, a source's key and a name provider's key. A
 *  credential that says `held_on: "computer"` is read on the computer from its own vault, so it is never asked of the reader here. */
export function heldNamesOf(row) {
  const names = [];
  for (const unit of row.runs.units ?? []) {
    names.push(unit.secret_vault_key, unit.source?.credential, ...(unit.credentials ?? []).filter(credential => credential.held_on === undefined).map(credential => credential.vault_key));
  }
  names.push(...(row.runs.names ?? []).map(name => name.provider?.vault_key));
  return [...new Set(names.filter(name => typeof name === 'string' && name))];
}

const timeOf = ms => new Date(ms).toLocaleTimeString('en-US', { timeZoneName: 'short' });

/** The request, checked: every field it may carry and nothing the program would have to guess. */
export function checkRequest(request) {
  if (!isObject(request)) throw refused('the request is one JSON object.');
  const unknown = Object.keys(request).find(key => !['computer', 'workshop_commit', 'edits', 'links', 'scope'].includes(key));
  if (unknown) throw refused(`unknown apply request field: ${unknown}.`);
  const scope = Object.hasOwn(request, 'scope') ? readEngineScope(request.scope) : undefined;
  if (scope && Object.hasOwn(request, 'links')) throw refused('the engine scope does not accept page links.');
  if (typeof request.computer !== 'string' || !request.computer) throw refused('the request needs `computer`, the row name.');
  if (!COMMIT.test(request.workshop_commit ?? '')) throw refused('the request needs `workshop_commit`, a full commit id.');
  if (request.edits !== undefined && !Array.isArray(request.edits)) throw refused('`edits` is an array.');
  const links = request.links;
  if (links !== undefined && (!isObject(links) || typeof links.folder !== 'string' || !isObject(links.set) || Object.values(links.set).some(target => typeof target !== 'string'))) {
    throw refused('`links` is { folder, set: { name: target } }.');
  }
  if (links && Object.keys(links.set).some(name => !name || name.includes('/'))) throw refused('a link name is one folder entry, with no "/".');
  return { computer: request.computer, workshop_commit: request.workshop_commit, edits: request.edits ?? [], links, scope };
}

/**
 * One whole run. `deps` is everything outside the program's own logic: `store` (read(name) answers { computer, siteSetting },
 * write(name, computer) answers { read_back_equal }), `targets` (read-data/apply-a-computer-row.json), `heldValues(names)`,
 * `archive(commit, folder)`, `runFolder(name)`, `startProbe({ tree, urls, log })` (answers `stop()`), `runApply({ tree, requestFile, held, out, err })`
 * (answers the exit code), `addressesOf(host)` (a fresh lookup of a name's addresses), `isAncestor(older, newer)` (true, false, or
 * null when either commit is not known even after one fetch), `sleep(ms)`, `now()`, and `holdRow(name)` (do-work/hold-a-computer-row.mjs:
 * the row held from before it is read until after its last write-back, or a refusal naming who holds it; a dry run takes none).
 */
export async function applyARow(rawRequest, { dryRun = false }, deps) {
  const request = checkRequest(rawRequest);
  if (dryRun || !deps.holdRow) return applyHeld(request, { dryRun }, deps, null);
  const hold = await deps.holdRow(request.computer);
  try { return await applyHeld(request, { dryRun }, deps, hold); } finally { await hold.release(); }
}

/** The run of one request, with the row held (`hold`, null for a dry run, which writes nothing). */
async function applyHeld(request, { dryRun }, deps, hold) {
  const { computer, siteSetting } = await deps.store.read(request.computer);
  const { row, changes } = applyEdits(computer, request.edits);
  const scope = request.scope ? engineScopeForEdit(computer, row, request.scope) : undefined;
  const engineProbe = scope ? engineProbeOf(row, scope) : undefined;
  const machine = deps.targets.machines?.[row.address];
  if (!machine) throw refused(`${row.name} is at ${row.address}, which the targets file names no ssh identity for.`);
  const workshopCheck = await checkWorkshopCommit(computer, request.workshop_commit, deps.isAncestor);
  if (dryRun) return { code: 0, summary: { dry_run: true, computer: row.name, workshop_check: workshopCheck, changes, ...(scope && { scope: scope.unit, renderer: request.workshop_commit }) } };

  if (!scope) row.runs.rendered_from_workshop = request.workshop_commit;
  const held = scope ? {} : await deps.heldValues(heldNamesOf(row));
  const changed = !isDeepStrictEqual(row, computer);

  const siteFile = scope ? engineScopeSiteFile(row, scope) : (row.runs.units ?? []).map(unit => unit.parts?.['/settings/site']?.file).find(Boolean);
  if (scope && siteFile) {
    let owned;
    try { if (typeof siteSetting === 'string') owned = JSON.parse(siteSetting); } catch { /* no readable site setting */ }
    if (!isObject(owned)) throw refused('the selected engine needs the owner’s site setting from the same row-store read.');
  }
  const log = deps.runFolder(row.name);
  const rowFolder = join(log, 'row'), tree = join(log, 'tree');
  mkdirSync(rowFolder, { recursive: true });
  writeFileSync(join(rowFolder, 'computer.json'), `${JSON.stringify(row, null, 1)}\n`);
  if (siteFile && siteSetting) {
    mkdirSync(dirname(join(rowFolder, siteFile)), { recursive: true });
    writeFileSync(join(rowFolder, siteFile), `${siteSetting}\n`);
  }
  await deps.archive(request.workshop_commit, tree);
  const renderer = await deps.checkApplyProtocol(tree, scope);
  const applyRequest = join(log, 'request.json');
  writeFileSync(applyRequest, `${JSON.stringify({
    machine: { address: row.address },
    ssh: { known_hosts: placed(machine.ssh.known_hosts), identity_file: placed(machine.ssh.identity_file) },
    computer_row_file: join(rowFolder, 'computer.json'),
    ...(scope ? { scope } : machine.pages_folder && { pages_folder: placed(machine.pages_folder) }),
  }, null, 1)}\n`);

  const preflight = scope ? await renderer.checkScopedEngine(renderer.readRequest(applyRequest)) : undefined;
  const hosts = hostsOf(row).slice(0, deps.targets.probe?.max_urls ?? 6);
  const urls = engineProbe ? [engineProbe.url] : hosts.length ? hosts.map(host => `https://${host}/`) : [`https://${row.address}/`];
  const started = deps.now();
  const probe = await deps.startProbe({ tree, urls, log: join(log, 'probe-requests.jsonl'), deadlineMs: deps.targets.probe?.startup_deadline_ms, ...(engineProbe && { expectedResource: engineProbe.expectedResource }) });
  if (typeof probe?.stop !== 'function') throw refused('the apply probe did not confirm startup; no row was written.');
  let written = false, applyStarted = false, put, code, ended, probed, putBack, failure, probeFailure, engineProof, refusal;
  const problems = [];
  try {
    await hold?.check();
    written = changed && (await deps.store.write(row.name, row)).read_back_equal === true;
    if (changed && !written) throw new Error('the database did not read back what was written; no apply was run.');
    if (request.links) put = setLinks(placed(request.links.folder), Object.fromEntries(Object.entries(request.links.set).map(([name, target]) => [name, placed(target)])));
    applyStarted = true;
    const report = await deps.runApply({ tree, requestFile: applyRequest, held, out: join(log, 'apply.out'), err: join(log, 'apply.err') });
    const verified = confirmedApplyExit(report);
    if (scope) {
      if (verified === 0) {
        engineProof = report.receipt.engine_scope;
        const { candidate } = engineProof ?? {};
        if (engineProof?.unit !== scope.unit || !isDeepStrictEqual(engineProof.incumbent, preflight.incumbent) ||
            candidate?.unit !== preflight.candidate.unit || candidate.commit !== preflight.candidate.commit || candidate.blake3 !== preflight.candidate.blake3 ||
            !Number.isSafeInteger(candidate.pid) || candidate.pid < 1 || !/^(?!0{32}$)[0-9a-f]{32}$/.test(candidate.invocation) ||
            report.receipt.written.length || report.receipt.restarted.length) throw new Error('the scoped apply did not return its exact engine readback.');
      } else if (verified === 1 || verified === 2) {
        const stopped = report.receipt.slot_not_switched;
        if (stopped.incumbent !== preflight.incumbent.unit || stopped.candidate !== preflight.candidate.unit) throw new Error('the scoped refusal does not identify the preflight slots.');
      } else if (verified !== SWITCH_UNCONFIRMED) throw new Error('the scoped apply returned an unrelated result.');
    }
    code = verified;
    if ((code === 1 || code === 2) && (report.receipt.apply_not_started === true || report.receipt.put_back === true)) {
      refusal = { apply_error: report.receipt.error, ...(report.receipt.apply_not_started === true ? { apply_not_started: true } : { rolled_back: report.receipt.rolled_back }) };
    }
  } catch (error) {
    failure = error;
    if (error?.apply_not_started === true) applyStarted = false;
    if (applyStarted && code === undefined) problems.push(`The apply outcome is unknown; the row and links were not put back. Read back the machine before retrying; logs are in ${log}.`);
  } finally {
    ended = deps.now();
    if (!applyStarted || code === 1 || code === 2) {
      try { put?.(); } catch (error) { problems.push(`Links were not all put back: ${error.message}`); }
      if (written) {
        try {
          const { read_back_equal } = await deps.store.write(row.name, computer);
          putBack = { row_put_back: read_back_equal };
        } catch (error) { putBack = { row_put_back: false, row_put_back_error: error.message }; }
      }
    }
    try { if (applyStarted) await deps.sleep(deps.targets.probe?.stop_after_ms ?? 0); }
    catch (error) { probeFailure = `The probe's after-apply wait failed: ${error.message}`; }
    try {
      probed = await probe.stop();
      if (!completeProbeSummary(probed)) throw new Error('the probe did not report complete measurement totals.');
      if (engineProbe && (probed.ok !== probed.sent || probed.failed || probed.retried || probed.resource_checked !== probed.sent)) {
        probeFailure = 'The engine probe window was not clean: every dispatched request must report matching resource metadata, without a failure or retry.';
      }
    } catch (error) { probeFailure = [probeFailure, error.message].filter(Boolean).join(' '); }
  }
  if (failure || problems.length) {
    if (!problems.length) throw failure;
    throw Object.assign(new Error([failure?.message, ...problems].filter(Boolean).join(' '), { cause: failure }), {
      exit: failure?.exit ?? (code || 1),
      ...(applyStarted && code === undefined && { apply_outcome: 'unknown_needs_readback', child_exit: failure?.child_exit, log_folder: log }),
    });
  }
  const { failures, slow_requests, ...totals } = completeProbeSummary(probed) ? probed : {};
  const elsewhere = !scope && code === 0 && !probeFailure ? await namesAnsweringElsewhere(row, deps.addressesOf) : [];
  return {
    code: elsewhere.length ? 6 : code || (probeFailure ? PROBE_EVIDENCE_UNCONFIRMED : 0),
    summary: {
      computer: row.name, workshop_commit: request.workshop_commit, workshop_check: workshopCheck, row_written: written, ...putBack, ...refusal,
      ...(hold && { row_held_since: hold.holder.since }),
      started: timeOf(started), ended: timeOf(ended), apply_exit: code,
      ...(code === SWITCH_UNCONFIRMED && { apply_outcome: 'slot_switch_unconfirmed' }),
      ...(request.links && { links: code === 1 || code === 2 ? 'put back' : 'set' }),
      ...(elsewhere.length && { names_answering_elsewhere: elsewhere }),
      ...(probeFailure && { probe_outcome: 'evidence_unconfirmed', probe_error: probeFailure }),
      ...(scope && { unit: scope.unit, renderer: request.workshop_commit, last_whole_render: row.runs.rendered_from_workshop, engine_scope: engineProof }),
      probe: { urls, ...totals },
      log_folder: log,
    },
  };
}

/** Whether `commit` may render `computer`: it is the commit the row records as last applied (`runs.rendered_from_workshop`), one after
 *  it, or the row records none. Answers what was found, in words; refuses an older commit, or one whose ancestry cannot be read. */
export async function checkWorkshopCommit(computer, commit, isAncestor) {
  const recorded = computer.runs.rendered_from_workshop;
  if (recorded === undefined) return 'the row records no commit yet';
  if (recorded === commit) return 'the commit the row was last applied from';
  const after = await isAncestor(recorded, commit);
  if (after === true) return `after ${recorded}, the commit the row was last applied from`;
  if (after === null) throw refused(`${computer.name} was last applied from Workshop commit ${recorded}; ${commit} or ${recorded} is not in the Workshop repository here, even after a fetch, so whether ${commit} comes after it cannot be read. Nothing was written.`);
  throw refused(`${computer.name} was last applied from Workshop commit ${recorded}; ${commit} is not that commit or one after it, so applying it would render an older kit over the computer. Ask with ${recorded} or a later commit. Nothing was written.`);
}

/** Whether commit `older` is `newer` or before it in the Workshop repository at `workshop`: null when either is not there, even after
 *  one fetch of its default remote. */
export const isAncestorIn = workshop => async (older, newer) => {
  const git = args => run('git', ['-C', workshop, ...args]);
  const known = async () => (await Promise.all([older, newer].map(commit => git(['cat-file', '-e', `${commit}^{commit}`]).then(() => true, () => false)))).every(Boolean);
  if (!(await known())) {
    await git(['fetch', '--quiet']);
    if (!(await known())) return null;
  }
  return git(['merge-base', '--is-ancestor', older, newer]).then(() => true, error => { if (error.code === 1) return false; throw error; });
};

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
  const valuesOf = ({ address, os, arch, libc, what_this_is, runs }) => [address, os, arch, libc, what_this_is, runs];
  return {
    async read(name) {
      const [row] = objectsOf(await sql("select name, address, os, arch, libc, what_this_is, runs::text as runs, (select value::text from setting where name = 'site') as site from computer where name = $1", [name]));
      if (!row) throw refused(`no computer row named ${name}`);
      readAs.set(name, valuesOf(row));
      const computer = { _what: row.what_this_is, name: row.name, address: row.address, os: row.os, arch: row.arch, ...(row.libc ? { libc: row.libc } : {}), runs: JSON.parse(row.runs) };
      return { computer, siteSetting: row.site ?? null };
    },
    async write(name, computer) {
      const was = readAs.get(name);
      const next = [computer.address, computer.os, computer.arch, computer.libc ?? null, computer._what, JSON.stringify(computer.runs)];
      const [now] = objectsOf(await sql(`update computer set address = $2, os = $3, arch = $4, libc = $5, what_this_is = $6, runs = $7
        where name = $1 and address is not distinct from $8 and os is not distinct from $9 and arch is not distinct from $10
        and libc is not distinct from $11 and what_this_is is not distinct from $12 and runs::text = $13
        returning address, os, arch, libc, what_this_is, runs::text as runs`, [name, ...next, ...was]));
      if (!now) throw new Error(`the ${name} row changed since it was read; read it again and redo the edit`);
      const read_back_equal = isDeepStrictEqual(valuesOf(now), next);
      if (read_back_equal) readAs.set(name, next);
      return { read_back_equal };
    },
  };
}

async function pipe(fd) {
  let text = '';
  try { for await (const bytes of createReadStream(null, { fd, autoClose: false })) { text += bytes; if (text.length > 65536) throw new Error(`Descriptor ${fd} exceeds its private input bound.`); } }
  catch (error) { if (error.code === 'EBADF') return ''; throw error; }
  return text.trim();
}

/** One statement run by the SQL tool's own process (argv from the DATA; the statement on its stdin, the connection on its descriptor 3).
 * The SQL tool refuses a request that names no connection (Nov 21 2026), so each one names the held connection the targets file says
 * this run was handed (`row_connection_name`). */
export const sqlBy = (argv, connection, connectionName) => (statement, params) => new Promise((done, fail) => {
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.on('error', fail).on('close', code => {
    if (code !== 0) fail(new Error(err.trim() || `the SQL process exited ${code}`));
    else done(JSON.parse(out));
  });
  child.stdio[3].end(connection);
  child.stdin.end(JSON.stringify({ credential_name: connectionName, sql: statement, params }));
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

const computerEntry = tree => join(tree, 'tools/start-a-computer/do-work/start-a-computer.mjs');

/** Importing the pinned module verifies its declaration. The apply child is started only after the row CAS. */
export async function checkApplyProtocol(tree, scope) {
  const entry = computerEntry(tree);
  if (!existsSync(entry)) throw refused('the selected Workshop commit has no computer apply program.');
  const owner = await import(pathToFileURL(entry).href);
  if (owner.ROW_APPLY_RESULT_PROTOCOL !== APPLY_PROTOCOL) throw refused('the selected Workshop commit cannot report the required computer apply result; no changes were made.');
  if (scope && (owner.ROW_ENGINE_SCOPE_PROTOCOL !== ROW_ENGINE_SCOPE_PROTOCOL || typeof owner.checkScopedEngine !== 'function' || typeof owner.readRequest !== 'function')) {
    throw refused('the selected Workshop commit does not support the requested engine scope; no changes were made.');
  }
  return owner;
}

function completeProbeSummary(value) {
  return isObject(value) && ['sent', 'ok', 'failed', 'retried', 'slow'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    value.sent > 0 && value.ok + value.failed <= value.sent && value.retried <= value.sent && value.slow <= value.sent &&
    typeof value.started === 'string' && typeof value.stopped === 'string' &&
    Number.isFinite(Date.parse(value.started)) && Date.parse(value.stopped) >= Date.parse(value.started);
}

/** Admit the apply only after each URL produces a clean, completed response in this run's own probe log. Clean is the probe's own
 * rule for an answer that is up (probe-while-applying.mjs: no error and under 500): a name with no page at / answers 404 and is up,
 * and refusing it kept every apply of a computer that serves one from starting (Nov 24 2026). */
export async function startApplyProbe({ tree, urls, log, deadlineMs, expectedResource }) {
  const script = join(tree, 'tools/start-a-computer/do-work/probe-while-applying.mjs');
  if (!existsSync(script)) throw new Error('the archived Workshop commit has no apply probe.');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || !urls.length) {
    throw refused('the apply probe needs a positive startup deadline and at least one URL.');
  }
  const until = performance.now() + deadlineMs;
  // Exclusive create makes stale lines unusable even if a caller accidentally reuses the run folder.
  const fd = openSync(log, 'wx+', 0o600);
  let child, closed, out = '';
  try {
    child = spawn(process.execPath, [script, '--log', log, ...(expectedResource === undefined ? [] : ['--expected-resource', expectedResource]), ...urls], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', chunk => { out += chunk; });
    closed = new Promise(done => child.once('close', (code, signal) => done({ code, signal })));
    await new Promise((done, fail) => child.once('spawn', done).on('error', fail));
    const required = new Set(urls), pending = new Set(required);
    const bytes = Buffer.alloc(4096), decode = new StringDecoder('utf8');
    let rest = '';
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`the probe exited (${child.signalCode ?? child.exitCode}) before each URL completed a clean response; see ${log}.`);
      }
      if (performance.now() >= until) throw new Error(`the probe did not complete a clean response before its startup deadline for: ${[...pending].join(', ')}; see ${log}.`);
      const count = readSync(fd, bytes, 0, bytes.length, null);
      rest += decode.write(bytes.subarray(0, count));
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const line of lines) {
        let sample;
        try { sample = JSON.parse(line); } catch { continue; }
        if (!isObject(sample) || !required.has(sample.url) || typeof sample.at !== 'string' || !Number.isFinite(Date.parse(sample.at)) ||
            !Number.isFinite(sample.ms) || sample.ms < 0 || !Number.isFinite(sample.lag_ms) || sample.lag_ms < 0) continue;
        if (Number.isInteger(sample.status) && sample.status >= 200 && sample.status < 500 &&
            !Object.hasOwn(sample, 'error') && !Object.hasOwn(sample, 'retried') &&
            (expectedResource === undefined || (sample.status === 200 && sample.resource_ok === true))) pending.delete(sample.url);
        else pending.add(sample.url);
      }
      if (rest.length > 65536) throw new Error(`the probe log has an oversized unfinished line; see ${log}.`);
      if (!pending.size && count < bytes.length) break;
      if (count < bytes.length) await delay(Math.max(0, Math.min(25, until - performance.now())));
    }
  } catch (error) {
    if (child) child.kill('SIGKILL');
    await closed;
    throw error;
  } finally { closeSync(fd); }
  return { async stop() {
    const asked = child.kill('SIGTERM');
    // A last request can take two five-second attempts; do not wait forever when the child cannot finish.
    const bounded = setTimeout(() => child.kill('SIGKILL'), 12000);
    let result;
    try { result = await closed; } finally { clearTimeout(bounded); }
    const { code, signal } = result;
    if (!asked || code !== 0 || signal !== null) throw new Error(`the probe closed without a normal measurement finish (${signal ?? code}); see ${log}.`);
    let summary;
    try { summary = JSON.parse(out); } catch { throw new Error(`the probe produced no valid final summary; see ${log}.`); }
    if (!completeProbeSummary(summary)) throw new Error(`the probe did not report complete measurement totals; see ${log}.`);
    return summary;
  } };
}

/** A connected pg client on a session of its own, with the pg the SQL tool ships, through the run's proxy when there is one. */
const ownSession = (workshop, connection) => async () => {
  const sqlTool = join(workshop, 'tools/run-sql-in-my-database');
  const pg = createRequire(join(sqlTool, 'package.json'))('pg');
  const proxy = process.env.HTTPS_PROXY;
  const stream = proxy ? (await import(pathToFileURL(join(sqlTool, 'do-work/through-the-run-proxy.mjs')).href)).throughProxy(proxy) : undefined;
  const client = new pg.Client({ connectionString: connection, keepAlive: true, ...(stream ? { stream } : {}) });
  await client.connect();
  return client;
};

const realDeps = ({ store, targets, workshop, connection }) => ({
  store, targets,
  holdRow: name => holdComputerRow(name, { connect: ownSession(workshop, connection), holder: { by: targets.applied_by ?? userInfo().username, pid: process.pid, host: hostname() } }),
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
  checkApplyProtocol,
  startProbe: startApplyProbe,
  async runApply({ tree, requestFile, held, out, err }) {
    let outFd, errFd, child;
    try {
      try {
        outFd = openSync(out, 'w');
        errFd = openSync(err, 'w');
        child = spawn(process.execPath, [computerEntry(tree), 'apply', requestFile], { cwd: tree, stdio: ['ignore', outFd, errFd, 'ignore', 'ignore', 'pipe'] });
      } catch (error) { throw Object.assign(error, { apply_not_started: true }); }
      return await new Promise((done, fail) => {
        let spawned = false;
        child.once('spawn', () => { spawned = true; }).on('error', error => fail(Object.assign(error, { apply_not_started: !spawned })));
        child.once('close', (exit, signal) => {
          if (exit === null) {
            fail(Object.assign(new Error(`the apply exited on ${signal} without reporting a result.`), { exit: 128 }));
            return;
          }
          let receipt;
          try { receipt = JSON.parse(readFileSync(out, 'utf8')); } catch { /* An absent or invalid receipt cannot attest to host effects. */ }
          done({ exit, receipt });
        });
        // An apply that does not need held values may close its input without reading it. The child's result still decides.
        child.stdio[5].on('error', () => {}).end(JSON.stringify(held));
      });
    } finally {
      if (outFd !== undefined) closeSync(outFd);
      if (errFd !== undefined) closeSync(errFd);
    }
  },
  addressesOf: host => resolve4(host),
  isAncestor: isAncestorIn(workshop),
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
    if (typeof targets.row_connection_name !== 'string' || !targets.row_connection_name) throw refused(`${targetsFile} names no row_connection_name (the vault name of the connection on descriptor 3).`);
    const workshop = (await run('git', ['-C', here, 'rev-parse', '--show-toplevel'])).stdout.trim();
    const sql = sqlBy(targets.sql_runner.map(part => placed(part, { workshop })), connection, targets.row_connection_name);
    const { code, summary } = await applyARow(JSON.parse(readFileSync(file, 'utf8')), { dryRun }, realDeps({ store: sqlRowStore(sql), targets, workshop, connection }));
    process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
    process.exitCode = code;
  } catch (error) {
    const { apply_outcome, child_exit, log_folder } = error;
    if (apply_outcome) process.stdout.write(`${JSON.stringify({ apply_outcome, child_exit, log_folder })}\n`);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
