// The unit template started the way systemd starts it, on a computer that has never run it: the computer has made the unit's
// state folder and its empty Workshop folder (the row's `folders`), and nothing else. systemd enters the working folder first
// (a folder that is not there stops the unit with 200/CHDIR before anything else runs), then runs each ExecStartPre in order
// (each must exit 0), then ExecStart; the program must answer 200 on both of its sockets. The Workshop it fetches is a
// throwaway repository holding the tool folders the program reads from this checkout (the folders its code imports, found
// by bundling it, and the shared looks it reads by path), so the template and the program tested are the ones here.
// npm is a stand-in that links this checkout's installed packages (the test is about the start order, not the registry), and
// flock, which macOS lacks, is a stand-in with the same kernel lock (perl's flock on the descriptor the unit names).
// Three starts: a new computer; a Workshop copy a killed fetch left with git's lock files; a door that lacks a tool a setting
// names, whose first real run must stop the start with the door's own words. The start asks the door nothing but tool runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { build } from 'esbuild';

const TOOL = join(import.meta.dirname, '..');
const TOOL_FOLDER = 'tools/serve-a-sites-pages-from-its-rows';
const TOP = join(TOOL, '..', '..');
const TEMPLATE = readFileSync(join(TOOL, 'on-a-computer', 'serve-a-sites-pages.service'), 'utf8');
const TEXT = 'ui/show/text/Text.tsx';
// Read by path, not imported: Screen Look's styles and fonts, and the Workshop's starting looks.
const READ_BY_PATH = ['tools/screen-look', 'tools/workspace-screens'];

/** The Workshop's tool folders the program's code imports (its server, its page document and the Text part), by bundling them. */
async function importedFolders(): Promise<string[]> {
  const { metafile } = await build({
    entryPoints: [join(TOOL, 'do-work', 'serve.ts'), join(TOOL, 'show', 'PageDocument.tsx'), join(TOP, 'tools', TEXT)],
    bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', packages: 'external', outdir: 'unused', logLevel: 'silent',
    loader: { '.css': 'empty' },
  });
  return [...new Set(Object.keys(metafile.inputs).map(input => relative(TOP, join(process.cwd(), input)).split('/').slice(0, 2).join('/')).filter(folder => folder.startsWith('tools/')))];
}

/** The unit's [Service] settings, in order, as systemd reads them: each key's values, a line's "$$" read as "$". */
function serviceOf(unit: string): { key: string; value: string }[] {
  const body = unit.split(/^\[Service\]$/m)[1]?.split(/^\[/m)[0] ?? '';
  return body.split('\n').filter(line => /^[A-Za-z]+=/.test(line)).map(line => {
    const at = line.indexOf('=');
    return { key: line.slice(0, at), value: line.slice(at + 1).replaceAll('$$', '$') };
  });
}

/** A command line as systemd splits it: "/bin/sh -c '<words>'" keeps the quoted words whole; anything else splits on spaces. */
function argvOf(command: string): string[] {
  const quoted = /^(\S+) -c '([\s\S]*)'$/.exec(command);
  return quoted ? [quoted[1], '-c', quoted[2]] : command.split(/\s+/).filter(Boolean);
}

/** A loopback engine door that answers the site's row reads (one public page, no look rows) and the site head; `lacks` are the
 * tools it has not got, refused as the engine refuses them. Any method but tools:run is refused as a pass with no right to it. */
async function door(lacks: string[] = []): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const { method, input } = JSON.parse(body).params.arguments as { method: string; input: { tool: string; input: { sql?: string } } };
      const reply = (result: unknown) => {
        response.setHeader('content-type', 'text/event-stream');
        response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`);
      };
      if (method !== 'tools:run') return reply({ isError: true, structuredContent: { code: 'current_workspace_rights_refused', detail: 'This pass has no right to do that.' } });
      if (lacks.includes(input.tool)) return reply({ isError: true, structuredContent: { code: 'tools_tool_unknown', detail: 'No tool has this id on this computer.' } });
      const sql = String(input.input.sql ?? '');
      const rows = sql.includes('FROM pages')
        ? [{ path: '/', title: 'Started', access: 'public', tool: null, input: {}, collection: null, updated_at: null, layout: { part: TEXT, export: 'Text', props: { as: 'main' }, children: [{ text: 'Started' }] } }]
        : [];
      const result = input.tool === 'tool:read-the-site-head' ? { head: '', body_start: '' } : { rows };
      reply({ structuredContent: { tool: input.tool, exit_code: 0, result } });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** The status one socket answers for "/", or null while nothing listens there. */
function statusAt(socketPath: string): Promise<number | null> {
  return new Promise(resolve => {
    const asked = http.get({ socketPath, path: '/', headers: { host: 'site.example.test' }, timeout: 20_000 }, answer => { answer.resume(); resolve(answer.statusCode ?? null); });
    asked.on('error', () => resolve(null));
    asked.on('timeout', () => { asked.destroy(); resolve(null); });
  });
}

const holder = mkdtempSync(join(tmpdir(), 'su-'));
let source = '';
let commit = '';
test.before(async () => {
  // The Workshop the unit fetches: a throwaway repository of the folders the program reads and the package files, one commit.
  source = join(holder, 'source.git');
  const folders = [...new Set([...(await importedFolders()), ...READ_BY_PATH])].sort();
  assert.ok(folders.includes(TOOL_FOLDER));
  const git = (args: string[], env: Record<string, string> = {}) => execFileSync('git', args, { cwd: TOP, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
  git(['init', '-q', '--bare', source]);
  const into = { GIT_DIR: source, GIT_WORK_TREE: TOP };
  git(['add', '-A', '--', ...folders, 'package.json', 'package-lock.json', ':(exclude,glob)**/node_modules/**'], into);
  git(['-c', 'user.name=unit start', '-c', 'user.email=unit-start@example.test', 'commit', '-q', '-m', 'the Workshop as this checkout holds it'], into);
  commit = git(['rev-parse', 'HEAD'], { GIT_DIR: source });
});
test.after(() => rmSync(holder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/**
 * Starts the rendered unit in systemd's order on a new machine folder (`before` may leave things in its Workshop copy first,
 * as an earlier start would have) with a door that lacks `lacks`, and answers how it went: the program's exit code (null while
 * it runs), what both sockets answered, what it said, and the Workshop copy's folder.
 */
async function startUnit({ before = () => {}, lacks = [] as string[], siteHead = false } = {}) {
  const machine = mkdtempSync(join(holder, 'm-'));
  const doorServer = await door(lacks);
  let program: ChildProcess | null = null;
  try {
    // What the computer made at set-up: the unit's state folder and its Workshop folder; a node; npm's and flock's stand-ins.
    const state = join(machine, 'var', 'state');
    const workshop = join(machine, 'opt', 'workshop');
    const bin = join(machine, 'bin');
    for (const folder of [state, workshop, bin]) mkdirSync(folder, { recursive: true });
    before(workshop);
    symlinkSync(process.execPath, join(bin, 'node'));
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\n# npm ci, standing in: the packages this checkout installed, linked where npm ci would put them.\n[ "$1" = ci ] && ln -sfn '${join(TOP, 'node_modules')}' node_modules\n`);
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\n# flock FD, standing in: an exclusive kernel lock on that open descriptor, held until every holder of it ends.\nexec perl -MFcntl=:flock -e \'open(my $fh, ">&=", $ARGV[0]) or die "flock: $!"; flock($fh, LOCK_EX) or die "flock: $!"\' "$1"\n');
    for (const name of ['npm', 'flock']) chmodSync(join(bin, name), 0o755);
    const credentials = join(machine, 'credentials');
    mkdirSync(credentials);
    writeFileSync(join(credentials, 'site-door-pass'), 'a-door-pass-for-the-test');
    const run = join(machine, 'run');
    // Short folder names: a socket's whole path must fit the system's limit (104 bytes on macOS).
    const sockets = ['sites/a', 'sites/b'];
    const settingsFile = join(state, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({
      listen: sockets.map(folder => `unix:${join(run, folder, 'http.sock')}`), hosts: ['app.site.example.test'], origin: 'https://site.example.test', lang: 'en',
      door: { address: `http://127.0.0.1:${(doorServer.address() as AddressInfo).port}`, pass_credential: 'site-door-pass' },
      pages: { database: 'a_site_for_who_uses_it', refresh_seconds: 60, answer_seconds: 60 },
      sign_in: { address: 'http://127.0.0.1:1', page: '/sign-in', issuer: 'https://sign-in.example.test', audience: 'https://site.example.test', team_claim: 'team_ids', members_team: 'team-members' },
      ...(siteHead ? { site_head: { tool: 'tool:read-the-site-head', input: {} } } : {}),
    }));

    const values: Record<string, string> = {
      description: 'A site served from its rows', credential_lines: '', node_bin: bin, workshop, workshop_commit: commit, repository: source,
      tool_folder: TOOL_FOLDER, user: 'site', group: 'web', runtime_directory: sockets.join(' '), stop_seconds: '5', writable: `${workshop} ${state}`,
      settings_file: settingsFile, state,
    };
    const unit = TEMPLATE.replace(/\{([a-z_]+)\}/g, (whole, name: string) => values[name] ?? whole);
    assert.doesNotMatch(unit, /\{[a-z_]+\}/, 'every placeholder is one the row gives');

    // systemd's order: its own folders under /run, the environment, the working folder, each ExecStartPre, then ExecStart.
    const service = serviceOf(unit);
    for (const folder of service.find(s => s.key === 'RuntimeDirectory')!.value.split(/\s+/)) mkdirSync(join(run, folder), { recursive: true });
    const env: Record<string, string> = { HOME: state, CREDENTIALS_DIRECTORY: credentials, RUNTIME_DIRECTORY: sockets.map(folder => join(run, folder)).join(':') };
    for (const { value } of service.filter(s => s.key === 'Environment')) {
      const at = value.indexOf('=');
      env[value.slice(0, at)] = value.slice(at + 1);
    }
    const cwd = service.find(s => s.key === 'WorkingDirectory')?.value ?? '/';
    assert.ok(existsSync(cwd), `200/CHDIR: the working folder ${cwd} is not there when the unit starts, before any ExecStartPre has run`);
    for (const { value } of service.filter(s => s.key === 'ExecStartPre')) {
      const [file, ...args] = argvOf(value);
      const ran = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout: 300_000 });
      assert.equal(ran.status, 0, `ExecStartPre ${value} exited ${ran.status}: ${ran.stderr}`);
    }
    const [file, ...args] = argvOf(service.find(s => s.key === 'ExecStart')!.value);
    let said = '';
    program = spawn(file, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    program.stderr!.on('data', chunk => { said += chunk; });
    const ended = new Promise(resolve => program!.once('exit', resolve));

    const deadline = Date.now() + 120_000;
    let statuses: (number | null)[] = [];
    while (Date.now() < deadline && program.exitCode === null) {
      statuses = await Promise.all(sockets.map(folder => statusAt(join(run, folder, 'http.sock'))));
      if (statuses.every(status => status !== null)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (program.exitCode === null && statuses.some(status => status === null)) await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 1000))]);
    return { exitCode: program.exitCode, statuses, said, workshop };
  } finally {
    if (program && program.exitCode === null) {
      const stopped = new Promise(resolve => program!.once('exit', resolve));
      program.kill('SIGTERM');
      await stopped;
    }
    doorServer.close();
  }
}

test('the rendered unit starts on a computer that has never run it, and answers 200 on both sockets', { timeout: 600_000 }, async () => {
  const started = await startUnit();
  assert.equal(started.exitCode, null, `the program stopped (${started.exitCode}): ${started.said}`);
  assert.deepEqual(started.statuses, [200, 200], `both sockets answer the page: ${started.said}`);
});

test('a Workshop copy a killed fetch left with git\'s lock files starts all the same, and the leftovers are gone', { timeout: 600_000 }, async () => {
  const started = await startUnit({
    before: workshop => {
      execFileSync('git', ['init', '-q', workshop]);
      for (const leftover of ['shallow.lock', 'index.lock']) writeFileSync(join(workshop, '.git', leftover), '');
    },
  });
  assert.equal(started.exitCode, null, `the program stopped (${started.exitCode}): ${started.said}`);
  assert.deepEqual(started.statuses, [200, 200], `both sockets answer the page: ${started.said}`);
  for (const leftover of ['shallow.lock', 'index.lock']) assert.equal(existsSync(join(started.workshop, '.git', leftover)), false, `${leftover} is cleared under the fetch lock`);
});

test('a door that lacks a tool the settings name stops the start with the door\'s own words for that tool', { timeout: 600_000 }, async () => {
  const started = await startUnit({ siteHead: true, lacks: ['tool:read-the-site-head'] });
  assert.notEqual(started.exitCode, null, 'the program does not keep running');
  assert.match(started.said, /The engine door refused tool:read-the-site-head: tools_tool_unknown: No tool has this id on this computer\./);
  assert.deepEqual(started.statuses.filter(status => status !== null), [], 'no socket answers');
});

test('a start that keeps failing stops after a few tries: the start limit is in the unit\'s [Unit] section', () => {
  const unitSection = TEMPLATE.split(/^\[Service\]$/m)[0];
  assert.match(unitSection, /^StartLimitIntervalSec=\d+$/m);
  assert.match(unitSection, /^StartLimitBurst=\d+$/m);
  assert.match(TEMPLATE, /^Restart=always$/m, 'it still restarts after a crash, up to that limit');
});
