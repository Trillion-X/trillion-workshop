// Runs a Workshop row that runs a program the way the engine's container runner does, on this computer: the files its
// invoke.files.package_files packs are laid at their `at` places under one folder that stands for `/`, its argv,
// workdir and stdin are filled from the request (and a task no page started), a row that reads records gets the
// stand-in records door (tools/records-door/test/fake-door.mjs) with exactly its rights and the records the sample
// seeds, a row with internet: true reaches only the stand-in egress (stand-in-egress.mjs) answering from the sample's
// recorded replies, and each held value a row mounts is a made-up one (on a descriptor, on a pipe, as the engine hands
// it). Answers the exit code, the output, the parsed
// last line of standard output that is JSON (what a row's result_selector picks from), the records the door holds
// afterwards and its calls, and any request the stand-in egress had no reply for. Read by
// test/every-process-row-selector.test.mjs and by tool folders' own tests. Nothing here names a tool.
//
// A row the runner cannot run here answers `{ cannot: <why> }` and is not started: one with a fill this runner does
// not read (a fetch), or one whose program is not on this computer.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { root, tools } from './tool-rows.mjs';
import { settings as egress, startStandInEgress } from './stand-in-egress.mjs';
import { startFakeDoor } from '../tools/records-door/test/fake-door.mjs';
import { createServer } from 'node:http';

// A stand-in model server on loopback answering Ollama's embedding replies with one made-up `vector`: POST
// /api/embeddings answers { embedding }, POST /api/embed answers { embeddings } with one vector per input. Anything
// else is a 404. Answers { endpoint, requests, close }.
export async function startStandInModelServer({ vector }) {
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) throw new Error('model_server needs a vector of numbers');
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let asked = {};
      try { asked = JSON.parse(body || '{}'); } catch { /* not JSON: answered as an empty ask */ }
      requests.push({ method: request.method, path: request.url, body: asked });
      const reply = request.method !== 'POST' ? null
        : request.url === '/api/embeddings' ? { embedding: vector }
        : request.url === '/api/embed' ? { embeddings: [asked.input ?? []].flat().map(() => vector) } : null;
      response.writeHead(reply ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply ?? { error: `the stand-in model server answers no ${request.method} ${request.url}` }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(done => server.close(done)) };
}

// The fact at a dotted path ("a.b", "list.0") of a value.
const at = (value, path) => (path ? String(path).split('.').reduce((node, key) => node?.[key], value) : value);

// The parsed last line of `text` that is JSON, or undefined.
export const lastJsonLine = text => {
  for (const line of String(text).trim().split('\n').reverse()) {
    try { return JSON.parse(line.trim()); } catch { /* not JSON: the line before it */ }
  }
  return undefined;
};

// "$" or "$.a.b": the value at that path of `value`, or undefined; the engine's select (workshop.rs `select`): each
// key is a field of an object, and nothing else is a selector.
export const select = (value, selector) => {
  if (typeof selector !== 'string' || !/^\$(\.|$)/.test(selector)) return undefined;
  return selector.split('.').slice(1)
    .reduce((node, key) => (node !== null && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, key) ? node[key] : undefined), value);
};

class Unfillable extends Error {}

// The template filled the way fill.rs reads it: {"fill":{from,field}}, and inside a zone {"const"}, {"from"} with
// optional/otherwise, {"$when"} and {"$time"}; everything else is copied as written. A left-out leaf is undefined.
function fill(template, sources) {
  if (Array.isArray(template)) return template.map(item => fill(item, sources)).filter(item => item !== undefined);
  if (template === null || typeof template !== 'object') return template;
  if (template.fill) {
    if (template.fill.fetch) throw new Unfillable('it fetches an input file, which this runner does not');
    const value = at(sources[template.fill.from], template.fill.field);
    if (value === undefined) throw new Unfillable(`the sample has no ${template.fill.from}.${template.fill.field ?? ''}`);
    return value;
  }
  if ('const' in template && Object.keys(template).length === 1) return template.const;
  if (typeof template.from === 'string') {
    const value = at(sources.input, template.from);
    if (value !== undefined && (value !== null || template.allow_null)) return value;
    if ('otherwise' in template) return fill(template.otherwise, sources);
    if (template.optional) return undefined;
    throw new Unfillable(`the sample has no input.${template.from}`);
  }
  if (typeof template.$when === 'string') return at(sources.input, template.$when) === undefined ? undefined : fill(template.value, sources);
  if (template.$time) return new Date().toISOString();
  return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, fill(item, sources)]).filter(([, item]) => item !== undefined));
}

// Lay every packed file at its place under `there` (which stands for `/`): a package's paths from tools/<package>, a
// module's from this checkout's node_modules.
function lay(specs, there) {
  for (const spec of specs) {
    const from = spec.module !== undefined ? join(root, 'node_modules', spec.module) : join(tools, spec.package);
    for (const path of spec.paths ?? []) {
      const source = join(from, path);
      if (!existsSync(source)) continue;
      const target = join(there, spec.at, path);
      mkdirSync(statSync(source).isDirectory() ? target : dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }
  }
}

// The word as the run sees it: an absolute path inside a packed place, under `there`; node is this Node.
function placed(word, specs, there) {
  if (typeof word !== 'string') return typeof word === 'object' ? JSON.stringify(word) : String(word);
  if (word === 'node' || /\/node$/.test(word)) return process.execPath;
  const inside = specs.some(spec => typeof spec.at === 'string' && (word === spec.at || word.startsWith(`${spec.at.replace(/\/$/, '')}/`)));
  return inside ? join(there, word) : word;
}

// Why this row cannot run here, or null.
export function cannotRun(row) {
  const invoke = row.invoke ?? {};
  if (!Array.isArray(invoke.argv) || !invoke.argv.length) return 'it runs no program';
  const command = invoke.argv[0];
  if (typeof command === 'string' && !/(^|\/)node$/.test(command) && spawnSync('which', [command]).status !== 0) return `${command} is not on this computer`;
  return null;
}

// The made-up value of one credential_mounts item: the sample's `held` by its secret_name or field_id, else the canary.
const heldValue = (item, held) => {
  const name = item.secret_name ?? item.vault_key ?? item.field_id ?? 'held';
  return held[name] ?? egress.canary_value.replace('{name}', name);
};

// The read end of a pipe holding `value` and then its end, for a held value on a descriptor: the engine hands each one
// on its own pipe(2) (trillion-rust src/runtime.rs `private_pipe`, and each held descriptor's pipe in `start`), so the
// program sees a FIFO, as it would in a run. Node makes no anonymous pipe for a child's descriptor (its 'pipe' is a
// socket), so this is a named one at `path`, in the run's private held folder. A writing end is held open first, so the
// reading end opens at once and blocking, as a pipe(2) end is; the value is written whole and the writing end closed,
// so the program reads the value and then the end. The value must fit in the pipe's buffer, which every held value a
// sample makes up does.
function heldPipe(path, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > 16_384) throw new Error('a made-up held value on a descriptor must be at most 16 KiB');
  const made = spawnSync('mkfifo', ['-m', '600', path]);
  if (made.status !== 0) throw new Error(`mkfifo failed: ${String(made.stderr).trim()}`);
  const writing = openSync(path, constants.O_RDWR);
  let read;
  try {
    read = openSync(path, constants.O_RDONLY);
    writeSync(writing, bytes);
  } finally { closeSync(writing); }
  return read;
}

// Run `row` on the sample `input`, with the sample's seeded `records` and `door_files` (made-up files { name: text } the
// stand-in files door answers for a row with a files right), recorded `replies`, made-up `held` values, the
// made-up `files` it lays in a granted folder ([{ grant, path, text }], `grant` naming one of the row's capabilities)
// and `stand_in_programs` ({ name: shell script }) found first by name, so a program the row starts to act on this
// computer (a message, a print) answers from the sample instead: { code, stdout, stderr, last, kept, calls, unanswered }
// or { cannot }. `doorOptions` reach the stand-in records door. A string anywhere in the input or the sample may name
// a granted folder as {grant:<capability>}; it is that folder's path for this run. `laid_files` ([{ path, text }])
// replaces a file the row packs, at its absolute place, for this run only. `model_server` ({ vector }) starts a stand-in
// model server (startStandInModelServer) whose address any string names as {model_endpoint}.
export async function runRow(row, sampleInput, sample = {}) {
  const why = cannotRun(row);
  if (why) return { cannot: why };
  const { invoke } = row;
  const specs = [invoke.files?.package_files ?? []].flat();
  // The real path of the temp folder: on macOS it is reached through the /var link, and a program that runs only when
  // it is the started script (argv[1] equal to its own module path) would otherwise do nothing and print nothing.
  const there = mkdtempSync(join(realpathSync(tmpdir()), 'workshop-row-'));
  let fake = null, outside = null, heldFolder = null, modelServer = null;
  const piped = [];
  try {
    lay(specs, there);
    // A task no page started; a capability the row asks for is granted on a folder of its own.
    const grants = Object.fromEntries((invoke.capabilities ?? []).map(name => [name, { folder: mkdtempSync(join(there, 'granted-')) }]));
    // A sample names a granted folder it cannot know beforehand as {grant:<capability>}, in any string it holds.
    // A sample's `model_server: { vector }` is a stand-in model server on loopback that answers every embedding with
    // that made-up vector; any string of the sample names its address as {model_endpoint}.
    if (sample.model_server) modelServer = await startStandInModelServer(sample.model_server);
    const placedGrants = value => (typeof value === 'string' ? value.replace(/\{grant:([^}]+)\}/g, (whole, name) => grants[name]?.folder ?? whole)
        .replace(/\{model_endpoint\}/g, whole => modelServer?.endpoint ?? whole)
      : Array.isArray(value) ? value.map(placedGrants)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, placedGrants(item)])) : value);
    const input = placedGrants(sampleInput);
    const { records = [], door_files: doorFiles = {}, replies = [], held = {}, files = [], laid_files: laidFiles = [], stand_in_programs: standIns = {}, doorOptions = {} } = placedGrants(sample);
    // A packed file the sample replaces for this run (a settings file naming a program by a path a stand-in cannot
    // take): only a file the row itself packs, at its place under the folder that stands for `/`.
    for (const file of laidFiles) {
      const target = join(there, file.path);
      if (!existsSync(target) || !target.startsWith(`${there}/`)) return { cannot: `the sample replaces ${file.path}, which the row does not pack` };
      writeFileSync(target, file.text ?? '');
    }
    const task = { task_id: 'task-sample', request_key: 'sample', cause: { kind: 'sample-run' }, started_at: new Date().toISOString(), grants };
    for (const file of files) {
      const folder = grants[file.grant]?.folder;
      if (!folder) return { cannot: `the sample lays a file in ${file.grant}, which the row does not ask for` };
      const target = join(folder, file.path);
      if (!target.startsWith(`${folder}/`)) return { cannot: `the sample lays a file outside its granted folder: ${file.path}` };
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.text ?? '');
    }
    const standInFolder = Object.keys(standIns).length ? mkdtempSync(join(there, 'stand-in-programs-')) : null;
    for (const [name, script] of Object.entries(standIns)) writeFileSync(join(standInFolder, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    let argv, stdin, rights;
    try {
      argv = fill(invoke.argv, { input, task }).map(word => placed(word, specs, there));
      stdin = invoke.stdin === undefined ? undefined : fill(invoke.stdin, { input, task });
      rights = fill(invoke.records?.rights ?? [], { input, task });
    } catch (error) {
      if (error instanceof Unfillable) return { cannot: error.message };
      throw error;
    }
    if (invoke.records) fake = await startFakeDoor({ ...doorOptions, rights, mostWrites: invoke.records.most_writes ?? doorOptions.mostWrites, records, files: doorFiles });
    if (invoke.internet === true) outside = await startStandInEgress(replies);
    // Each held value the row mounts, made up: on its own descriptor, in its environment, or as a private file.
    const mounts = invoke.credential_mounts ?? [];
    const environment = { ...process.env, HOME: there, ...(outside?.environment ?? {}) };
    if (standInFolder) environment.PATH = `${standInFolder}:${environment.PATH}`;
    for (const item of mounts) {
      const value = heldValue(item, held);
      if (item.env) environment[item.env] = value;
      if (item.mount_path) {
        heldFolder ??= mkdtempSync(join(realpathSync(tmpdir()), 'workshop-held-'));
        const file = join(heldFolder, `value-${mounts.indexOf(item)}`);
        writeFileSync(file, value, { mode: 0o600 });
        argv = argv.map(word => (word === item.mount_path ? file : word));
      }
      if (Number.isInteger(item.fd)) {
        heldFolder ??= mkdtempSync(join(realpathSync(tmpdir()), 'workshop-held-'));
        piped.push([item.fd, heldPipe(join(heldFolder, `pipe-${mounts.indexOf(item)}`), value)]);
      }
    }
    const workdir = invoke.workdir ? join(there, invoke.workdir) : there;
    mkdirSync(workdir, { recursive: true });
    for (const output of invoke.outputs ?? []) mkdirSync(dirname(join(there, output.path)), { recursive: true });
    const stdio = ['pipe', 'pipe', 'pipe'];
    if (fake) stdio[invoke.records.fd ?? 3] = openSync(fake.descriptor, 'r');
    for (const [fd, read] of piped) stdio[fd] = read;
    // A descriptor no one is given is closed in the program, as the engine leaves it.
    for (let fd = 0; fd < stdio.length; fd++) stdio[fd] ??= 'ignore';
    return await new Promise((done, fail) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: workdir, stdio, env: environment });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), invoke.max_run_ms ?? 60_000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', fail);
      child.on('close', code => {
        clearTimeout(timer);
        done({ code, stdout, stderr, last: lastJsonLine(stdout), kept: fake ? [...fake.kept.values()] : [], calls: fake?.calls ?? [], unanswered: outside?.unanswered ?? [] });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(stdin === undefined ? '' : typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
    });
  } finally {
    for (const [, read] of piped) closeSync(read);
    await fake?.close();
    await outside?.close();
    await modelServer?.close();
    rmSync(there, { recursive: true, force: true });
    if (heldFolder) rmSync(heldFolder, { recursive: true, force: true });
  }
}

/** The row with this id in a tool-rows.json file. */
export const rowOf = (file, id) => file.records.find(record => record.payload.id === id).payload;

// A tool folder's own test reads one run as the answer it gives: the exit code as `status`, the fields of the parsed
// last JSON line, and the records the stand-in door holds afterwards (`kept`) and its calls. A run that cannot start
// here, or prints no JSON line, throws with why.
export async function answerOf(row, sampleInput, sample = {}) {
  const run = await runRow(row, sampleInput, sample);
  if (run.cannot) throw new Error(`${row.id} cannot run here: ${run.cannot}`);
  if (run.last === undefined || run.last === null || typeof run.last !== 'object') throw new Error(`${row.id} printed no JSON line (exit ${run.code}): ${run.stderr.trim().slice(-400)}`);
  return { status: run.code, ...run.last, kept: run.kept, calls: run.calls };
}
