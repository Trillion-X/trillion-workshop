// tools/start-a-computer/test/apply-a-computer-row.test.mjs
//
// Changing a computer's row and applying it: edits by path selector, compare-and-set before anything is written, links put back
// when the apply fails, the apply's exit code passed through, a Workshop commit that never goes back to before the one the row was
// last applied from, and a dry run that writes nothing. The row store, the unpacking, the probe and the apply are made up; the links
// are real symlinks in a temporary folder, and the ancestry reader runs on real git repositories in one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { applyARow, applyEdits, checkApplyProtocol, heldNamesOf, hostsOf, isAncestorIn, parsePath, runFolder, setLinks, sqlRowStore, startApplyProbe } from '../do-work/apply-a-computer-row.mjs';
import { ROW_APPLY_RESULT_PROTOCOL, SLOT_SWITCH_UNCONFIRMED_EXIT } from '../do-work/start-a-computer.mjs';

const OLD = '1'.repeat(40), NEW = '2'.repeat(40), TREE = '3'.repeat(40);
const row = () => ({
  _what: 'An example computer.', name: 'example-box', address: '192.0.2.7', os: 'linux', arch: 'x86_64',
  runs: {
    units: [
      { unit: 'one.example.service', source: { commit: OLD, credential: 'example-key' }, tags: ['a'], accepts_hosts: ['one.example.com'] },
      { unit: 'two.example.service', source: { commit: OLD }, secret_vault_key: 'example-secret', host_name: 'two.example.com' },
    ],
    names: [{ provider: { vault_key: 'example-dns' } }],
  },
});
const edit = { at: 'runs.units[unit=two.example.service].source.commit', from: OLD, to: NEW };

test('a path steps through keys and selects an array element by field or position', () => {
  assert.deepEqual(parsePath('runs.units[unit=a.b.service].source.commit'), [{ key: 'runs' }, { key: 'units', field: 'unit', value: 'a.b.service' }, { key: 'source' }, { key: 'commit' }]);
  assert.deepEqual(parsePath('runs.units[1]'), [{ key: 'runs' }, { key: 'units', index: 1 }]);
  assert.throws(() => parsePath('runs..units'), /empty step/);
  assert.throws(() => parsePath('runs.units[x]'), /neither/);
});

test('an edit by selector changes only the selected element and leaves the input row alone', () => {
  const input = row();
  const { row: edited, changes } = applyEdits(input, [edit]);
  assert.equal(edited.runs.units[1].source.commit, NEW);
  assert.equal(edited.runs.units[0].source.commit, OLD);
  assert.equal(input.runs.units[1].source.commit, OLD);
  assert.deepEqual(changes, [{ at: edit.at, op: 'to', before: OLD, after: NEW }]);
});

test('a from that does not match refuses the whole request, whichever edit it is', () => {
  assert.throws(() => applyEdits(row(), [edit, { at: 'runs.units[0].source.commit', from: NEW, to: OLD }]), /holds "1{40}", not "2{40}"/);
  assert.throws(() => applyEdits(row(), [{ at: 'runs.nothing', from: 1, to: 2 }]), /holds nothing/);
});

test('add appends once and remove deletes a key or an array element', () => {
  const { row: edited } = applyEdits(row(), [
    { at: 'runs.units[0].tags', add: 'b' }, { at: 'runs.units[0].tags', add: 'b' },
    { at: 'runs.units[unit=one.example.service].source.credential', remove: true },
    { at: 'runs.units[unit=two.example.service]', remove: true },
  ]);
  assert.deepEqual(edited.runs.units[0].tags, ['a', 'b']);
  assert.equal(edited.runs.units[0].source.credential, undefined);
  assert.equal(edited.runs.units.length, 1);
  assert.throws(() => applyEdits(row(), [{ at: 'runs.units[0].source.nothing', remove: true }]), /nothing is there/);
  assert.throws(() => applyEdits(row(), [{ at: 'runs.units[0].source', add: 'x' }]), /add needs an array/);
});

test('an unclear selector, a rename and an edit with two operations are refused', () => {
  assert.throws(() => applyEdits(row(), [{ at: 'runs.units[source=nothing].x', to: 1 }]), /no element/);
  assert.throws(() => applyEdits(row(), [{ at: 'name', to: 'other' }]), /rename/);
  assert.throws(() => applyEdits(row(), [{ at: 'os', to: 'a', remove: true }]), /exactly one/);
});

test('the hosts and the held names a row says are read from the row', () => {
  assert.deepEqual(hostsOf(row()), ['one.example.com', 'two.example.com']);
  assert.deepEqual(heldNamesOf(row()), ['example-key', 'example-secret', 'example-dns']);
});

test('an IP address or a .localhost name is never a host a row answers, so it is never a probe URL', () => {
  const units = [{ settings: { internal: { host: '127.0.0.1' }, doors: [{ accepts_hosts: ['app.example.com', '10.0.0.5', 'db.localhost'] }] } }, { host: '::1' }];
  assert.deepEqual(hostsOf({ runs: { names: [{ host_name: 'one.example.com' }], units } }), ['one.example.com', 'app.example.com']);
});

test('a host named beside a port that is not 80 or 443 is a target the row reaches, never a probe URL', () => {
  const units = [{ settings: { doors: [{ accepts_hosts: ['app.example.com'] }], report: { private_targets: [{ host: 'db.example.com', port: 5432 }] } } },
    { settings: { site: { host: 'www.example.com', port: 443 } } }, { settings: { site: { host: 'plain.example.com', port: '80' } } }];
  assert.deepEqual(hostsOf({ runs: { units } }), ['app.example.com', 'www.example.com', 'plain.example.com']);
});

const applyReceipt = exit => {
  const candidate = 'two.example-b.service', incumbent = 'two.example-a.service';
  const proof = { row_apply_protocol: ROW_APPLY_RESULT_PROTOCOL };
  switch (exit) {
    case 0: return { ...proof, written: [], restarted: [] };
    case 1: return { ...proof, slot_not_switched: { candidate, incumbent, candidate_stopped: true } };
    case 4: return { ...proof, written: [], restarted: [], names_unconfirmed: 'fixture provider refusal' };
    case SLOT_SWITCH_UNCONFIRMED_EXIT: return { ...proof, slot_switch_unconfirmed: { candidate, affected_unit: incumbent, phase: 'retire' } };
  }
};
const probeTotals = { started: '2026-11-22T06:00:00Z', stopped: '2026-11-22T06:00:01Z', sent: 3, ok: 3, failed: 0, retried: 0, slow: 0 };

// A whole run with everything outside made up. `store` keeps what was written; `exit` selects the apply's receipt.
const world = ({ exit = 0, written = true, recorded, after = true } = {}) => {
  const stored = row();
  if (recorded) stored.runs.rendered_from_workshop = recorded;
  const log = mkdtempSync(join(tmpdir(), 'apply-row-test-'));
  const seen = { writes: [], applied: [], probes: [], stopped: 0, archived: [], stored, ancestry: [] };
  const deps = {
    store: { read: async () => ({ computer: structuredClone(stored), siteSetting: null }), write: async (name, computer) => { seen.writes.push({ name, computer }); if (written) Object.assign(stored, structuredClone(computer)); return { read_back_equal: written }; } },
    targets: { machines: { '192.0.2.7': { ssh: { known_hosts: '/hosts', identity_file: '/key' }, pages_folder: '/pages' } }, probe: {} },
    heldValues: async names => Object.fromEntries(names.map(name => [name, 'v'])),
    runFolder: () => log,
    archive: async (commit, folder) => { seen.archived.push(commit); mkdirSync(folder, { recursive: true }); },
    checkApplyProtocol: async () => {},
    startProbe: async args => {
      seen.probes.push(args);
      return { stop: async () => { seen.stopped++; return { ...probeTotals, failures: [], slow_requests: [], urls: args.urls }; } };
    },
    runApply: async ({ requestFile, held }) => { seen.applied.push({ request: JSON.parse(readFileSync(requestFile, 'utf8')), held }); return { exit, receipt: applyReceipt(exit) }; },
    addressesOf: async () => ['192.0.2.7'],
    isAncestor: async (older, newer) => { seen.ancestry.push([older, newer]); return after; },
    sleep: async () => {}, now: () => Date.parse('2026-11-22T06:00:00Z'),
  };
  return { deps, seen, log };
};
const request = extra => ({ computer: 'example-box', workshop_commit: TREE, edits: [edit], ...extra });
const withLinks = () => {
  const folder = mkdtempSync(join(tmpdir(), 'apply-row-links-'));
  const present = join(folder, 'present.example.com'), fresh = join(folder, 'fresh.example.com');
  symlinkSync('old-target', present);
  const input = request({ links: { folder, set: { 'present.example.com': 'new-target', 'fresh.example.com': 'new-target' } } });
  const checkUnchanged = () => {
    assert.equal(readlinkSync(present), 'old-target');
    assert.throws(() => lstatSync(fresh), { code: 'ENOENT' });
  };
  return { input, present, fresh, checkUnchanged };
};
test('a run writes the row, applies it with the machine\'s identity and held values, and passes the exit code through', async () => {
  const { deps, seen, log } = world({ exit: 1 });
  const { code, summary } = await applyARow(request(), {}, deps);
  assert.equal(code, 1);
  assert.equal(summary.apply_exit, 1);
  assert.equal(seen.writes.length, 2);
  assert.equal(seen.writes[0].computer.runs.units[1].source.commit, NEW);
  assert.deepEqual(seen.archived, [TREE]);
  assert.equal(seen.applied[0].request.ssh.identity_file, '/key');
  assert.equal(seen.applied[0].request.pages_folder, '/pages');
  assert.deepEqual(Object.keys(seen.applied[0].held), ['example-key', 'example-secret', 'example-dns']);
  assert.equal(JSON.parse(readFileSync(join(log, 'row/computer.json'), 'utf8')).runs.units[1].source.commit, NEW);
  assert.equal(seen.stopped, 1);
  assert.deepEqual(summary.probe.urls, ['https://one.example.com/', 'https://two.example.com/']);
  assert.equal(summary.probe.failures, undefined);
  assert.equal(summary.log_folder, log);
  assert.match(summary.started, /\d+:\d\d:\d\d [AP]M/);
});

test('a failed apply puts the row back to exactly what was read, and says so', async () => {
  const { deps, seen } = world({ exit: 1 });
  const { code, summary } = await applyARow(request(), {}, deps);
  assert.equal(code, 1);
  assert.equal(seen.writes.length, 2);
  assert.equal(summary.row_written, true);
  assert.equal(summary.row_put_back, true);
  assert.deepEqual(seen.stored, row());
});

test('a row that someone else changed while the apply ran is not written over, and the summary says it was not put back', async () => {
  const { deps, seen } = world({ exit: 1 });
  const write = deps.store.write;
  deps.store.write = async (name, computer) => { if (seen.writes.length) throw new Error('the row changed since it was read'); return write(name, computer); };
  const { summary } = await applyARow(request(), {}, deps);
  assert.equal(summary.row_put_back, false);
  assert.match(summary.row_put_back_error, /changed since it was read/);
});

test('a name that a fresh lookup finds answering with a second address fails the run with exit 6 and names it; a failed apply is not looked up', async () => {
  const withNames = addressesOf => {
    const named = world({ exit: 0 });
    const read = named.deps.store.read;
    named.deps.store.read = async () => { const answer = await read(); answer.computer.runs.names = [{ host_name: 'one.example.com', provider: {} }, { host_name: 'two.example.com', provider: {} }]; return answer; };
    named.deps.addressesOf = addressesOf;
    return named.deps;
  };
  const { code, summary } = await applyARow(request(), {}, withNames(async host => (host === 'one.example.com' ? ['192.0.2.7', '198.51.100.9', '192.0.2.7'] : ['192.0.2.7'])));
  assert.equal(code, 6);
  assert.equal(summary.apply_exit, 0);
  assert.deepEqual(summary.names_answering_elsewhere, [{ host_name: 'one.example.com', addresses: ['192.0.2.7', '198.51.100.9'] }]);
  const unfound = await applyARow(request(), {}, withNames(async () => { throw Object.assign(new Error('gone'), { code: 'ENOTFOUND' }); }));
  assert.deepEqual(unfound.summary.names_answering_elsewhere.map(name => name.addresses), [['not found: ENOTFOUND'], ['not found: ENOTFOUND']]);
  const clean = await applyARow(request(), {}, withNames(async () => ['192.0.2.7']));
  assert.deepEqual([clean.code, clean.summary.names_answering_elsewhere], [0, undefined]);
  const failed = world({ exit: 1 });
  failed.deps.addressesOf = async () => { throw new Error('a failed apply must not look names up'); };
  assert.equal((await applyARow(request(), {}, failed.deps)).code, 1);
});

test('a successful apply keeps the row as written', async () => {
  const { deps, seen } = world({ exit: 0 });
  const { summary } = await applyARow(request(), {}, deps);
  assert.equal(seen.writes.length, 1);
  assert.equal(summary.row_put_back, undefined);
  assert.equal(seen.stored.runs.units[1].source.commit, NEW);
});

test('a from that does not match writes nothing and applies nothing', async () => {
  const { deps, seen } = world();
  await assert.rejects(applyARow(request({ edits: [{ ...edit, from: NEW }] }), {}, deps), /not "2{40}"/);
  assert.deepEqual([seen.writes.length, seen.applied.length, seen.archived.length], [0, 0, 0]);
});

test('a write that does not read back equal stops before the apply', async () => {
  const { deps, seen } = world({ written: false });
  await assert.rejects(applyARow(request(), {}, deps), /did not read back/);
  assert.equal(seen.applied.length, 0);
});

test('a computer with no machine entry in the DATA is refused before a write', async () => {
  const { deps, seen } = world();
  deps.targets.machines = {};
  await assert.rejects(applyARow(request(), {}, deps), /names no ssh identity/);
  assert.equal(seen.writes.length, 0);
});

test('a dry run prints the changes and writes, unpacks and applies nothing', async () => {
  const { deps, seen } = world();
  const { code, summary } = await applyARow(request(), { dryRun: true }, deps);
  assert.equal(code, 0);
  assert.deepEqual(summary.changes.map(({ at, before, after }) => ({ at, before, after })), [{ at: edit.at, before: OLD, after: NEW }]);
  assert.deepEqual([seen.writes.length, seen.applied.length, seen.archived.length], [0, 0, 0]);
});

test('a row that records no commit is applied and then records the commit it was rendered from, in the same write', async () => {
  const { deps, seen, log } = world({ exit: 0 });
  const { summary } = await applyARow(request(), {}, deps);
  assert.equal(seen.writes.length, 1);
  assert.equal(seen.writes[0].computer.runs.rendered_from_workshop, TREE);
  assert.equal(seen.writes[0].computer.runs.units[1].source.commit, NEW);
  assert.equal(seen.stored.runs.rendered_from_workshop, TREE);
  assert.equal(JSON.parse(readFileSync(join(log, 'row/computer.json'), 'utf8')).runs.rendered_from_workshop, TREE);
  assert.equal(summary.workshop_check, 'the row records no commit yet');
  assert.deepEqual(seen.ancestry, []);
});

test('the same commit is applied without an ancestry read, and with no edits writes nothing', async () => {
  const { deps, seen } = world({ exit: 0, recorded: TREE });
  const { code, summary } = await applyARow(request({ edits: [] }), {}, deps);
  assert.deepEqual([code, seen.writes.length, seen.applied.length, seen.ancestry.length], [0, 0, 1, 0]);
  assert.equal(summary.workshop_check, 'the commit the row was last applied from');
  assert.equal(seen.stored.runs.rendered_from_workshop, TREE);
});

test('a commit after the recorded one is applied and recorded', async () => {
  const { deps, seen } = world({ exit: 0, recorded: OLD });
  const { code, summary } = await applyARow(request(), {}, deps);
  assert.equal(code, 0);
  assert.deepEqual(seen.ancestry, [[OLD, TREE]]);
  assert.equal(seen.stored.runs.rendered_from_workshop, TREE);
  assert.equal(summary.workshop_check, `after ${OLD}, the commit the row was last applied from`);
});

test('a commit before the recorded one, or one whose ancestry cannot be read, is refused with nothing written or applied', async () => {
  for (const [after, words] of [[false, /example-box was last applied from Workshop commit 1{40}; 3{40} is not that commit or one after it, so applying it would render an older kit/], [null, /3{40} or 1{40} is not in the Workshop repository here, even after a fetch/]]) {
    for (const dryRun of [false, true]) {
      const { deps, seen } = world({ exit: 0, recorded: OLD, after });
      await assert.rejects(applyARow(request(), { dryRun }, deps), error => words.test(error.message) && /Nothing was written\.$/.test(error.message) && error.exit === 2);
      assert.deepEqual([seen.writes.length, seen.applied.length, seen.archived.length], [0, 0, 0]);
      assert.equal(seen.stored.runs.rendered_from_workshop, OLD);
    }
  }
});

test('a failed apply leaves the recorded commit as it was', async () => {
  const { deps, seen } = world({ exit: 1, recorded: OLD });
  const { summary } = await applyARow(request(), {}, deps);
  assert.equal(seen.writes[0].computer.runs.rendered_from_workshop, TREE);
  assert.equal(summary.row_put_back, true);
  assert.equal(seen.stored.runs.rendered_from_workshop, OLD);
});

test('a dry run says what the commit check found and writes nothing', async () => {
  const { deps, seen } = world({ recorded: OLD });
  const { summary } = await applyARow(request(), { dryRun: true }, deps);
  assert.equal(summary.workshop_check, `after ${OLD}, the commit the row was last applied from`);
  assert.deepEqual([seen.writes.length, seen.applied.length, seen.archived.length], [0, 0, 0]);
});

test('ancestry is read from the Workshop repository, fetching once a commit it does not have yet', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'apply-row-git-'));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Example', '-c', 'user.email=example', ...args], { encoding: 'utf8' }).trim();
  const origin = join(folder, 'origin'), here = join(folder, 'here');
  execFileSync('git', ['init', '--quiet', origin]);
  const commit = words => { git(origin, 'commit', '--quiet', '--allow-empty', '-m', words); return git(origin, 'rev-parse', 'HEAD'); };
  const first = commit('first'), second = commit('second');
  execFileSync('git', ['clone', '--quiet', origin, here]);
  const third = commit('third');
  const isAncestor = isAncestorIn(here);
  assert.equal(await isAncestor(first, second), true);
  assert.equal(await isAncestor(second, first), false);
  assert.equal(await isAncestor(first, third), true);
  assert.equal(await isAncestor('f'.repeat(40), third), null);
});

test('links are set before the apply reads them and put back when it fails', async () => {
  for (const [exit, want] of [[0, 'new-target'], [1, 'old-target']]) {
    const folder = mkdtempSync(join(tmpdir(), 'apply-row-links-'));
    symlinkSync('old-target', join(folder, 'present.example.com'));
    const { deps, seen } = world({ exit });
    let during = null;
    const run = deps.runApply;
    deps.runApply = async args => { during = [readlinkSync(join(folder, 'present.example.com')), readlinkSync(join(folder, 'fresh.example.com'))]; return run(args); };
    const { summary } = await applyARow(request({ links: { folder, set: { 'present.example.com': 'new-target', 'fresh.example.com': 'new-target' } } }), {}, deps);
    assert.deepEqual(during, ['new-target', 'new-target']);
    assert.equal(readlinkSync(join(folder, 'present.example.com')), want);
    assert.equal(summary.links, exit ? 'put back' : 'set');
    if (exit) assert.throws(() => lstatSync(join(folder, 'fresh.example.com')), { code: 'ENOENT' });
    assert.equal(seen.applied.length, 1);
  }
});

test('an archive failure writes no row or links, starts no probe and runs no apply', async () => {
  const { deps, seen } = world({ recorded: OLD });
  const { input, checkUnchanged } = withLinks();
  const original = structuredClone(seen.stored);
  deps.archive = async () => { throw new Error('archive refused the commit'); };
  await assert.rejects(applyARow(input, {}, deps), /archive refused the commit/);
  assert.deepEqual(seen.stored, original);
  assert.deepEqual([seen.writes.length, seen.probes.length, seen.applied.length], [0, 0, 0]);
  checkUnchanged();
});

test('probe startup sees the prepared request and archive, and its failure leaves the row and links untouched', async () => {
  const { deps, seen, log } = world({ recorded: OLD });
  const { input, checkUnchanged } = withLinks();
  const original = structuredClone(seen.stored);
  deps.targets.probe.startup_deadline_ms = 2000;
  deps.startProbe = async ({ tree, deadlineMs }) => {
    assert.equal(tree, join(log, 'tree'));
    assert.equal(deadlineMs, 2000);
    assert.deepEqual(seen.archived, [TREE]);
    assert.equal(seen.writes.length, 0);
    const prepared = JSON.parse(readFileSync(join(log, 'request.json'), 'utf8'));
    const computer = JSON.parse(readFileSync(prepared.computer_row_file, 'utf8'));
    assert.equal(computer.runs.rendered_from_workshop, TREE);
    assert.equal(computer.runs.units[1].source.commit, NEW);
    checkUnchanged();
    throw new Error('probe could not start');
  };
  await assert.rejects(applyARow(input, {}, deps), /probe could not start/);
  assert.deepEqual(seen.stored, original);
  assert.deepEqual([seen.writes.length, seen.applied.length], [0, 0]);
  checkUnchanged();
});

const probeEntry = tree => join(tree, 'tools/start-a-computer/do-work/probe-while-applying.mjs');

test('a real apply probe waits for both complete response bodies before the first row or link write', { timeout: 10000 }, async t => {
  const { deps, seen, log } = world({ recorded: OLD });
  const { input, present, checkUnchanged } = withLinks();
  t.after(() => {
    rmSync(log, { recursive: true, force: true });
    rmSync(input.links.folder, { recursive: true, force: true });
  });
  const waiting = new Set();
  let arrived, requests = 0, release = false;
  const firstRedirect = new Promise(done => { arrived = done; });
  const server = createServer((req, res) => {
    requests++;
    if (req.url === '/home') { res.end('answer'); return; }
    assert.equal(req.url, '/redirect', 'the probe must not follow redirects');
    res.writeHead(302, { location: '/not-the-probe-target' });
    res.write('start of the redirect body');
    arrived();
    if (release) res.end('end');
    else waiting.add(res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const urls = ['home', 'redirect'].map(path => `http://127.0.0.1:${server.address().port}/${path}`);
  const archive = deps.archive;
  deps.archive = async (commit, tree) => {
    await archive(commit, tree);
    const entry = probeEntry(tree);
    mkdirSync(dirname(entry), { recursive: true });
    symlinkSync(fileURLToPath(new URL('../do-work/probe-while-applying.mjs', import.meta.url)), entry);
  };
  deps.targets.probe.startup_deadline_ms = 6000;
  deps.startProbe = args => startApplyProbe({ ...args, urls });
  const probeLog = join(log, 'probe-requests.jsonl');
  const samples = () => readFileSync(probeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const write = deps.store.write;
  deps.store.write = async (...args) => {
    const kept = samples();
    assert.ok(kept.some(sample => sample.url === urls[0] && sample.status === 200));
    assert.ok(kept.some(sample => sample.url === urls[1] && sample.status === 302));
    checkUnchanged();
    return write(...args);
  };
  const applying = applyARow(input, {}, deps);
  await Promise.race([firstRedirect, applying]);
  // Outlast the previous two-second child-survival wait with headers but no complete body.
  await delay(2150);
  assert.ok(requests > 4, 'round-robin requests continue while an earlier response is open');
  assert.ok(samples().some(sample => sample.url === urls[0] && sample.status === 200));
  assert.ok(samples().every(sample => sample.url !== urls[1]));
  assert.deepEqual([seen.writes.length, seen.applied.length], [0, 0]);
  checkUnchanged();
  release = true;
  for (const res of waiting) res.end('end');
  assert.equal((await applying).code, 0);
  assert.deepEqual([seen.writes.length, seen.applied.length], [1, 1]);
  assert.equal(readlinkSync(present), 'new-target');
});

test('apply probe refuses an exited child, stale log, and unhealthy, retried or unfinished samples', async t => {
  const tree = mkdtempSync(join(tmpdir(), 'apply-probe-fixture-'));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const entry = probeEntry(tree);
  mkdirSync(dirname(entry), { recursive: true });
  const urls = ['status', 'error', 'retry', 'unfinished'].map(name => `https://${name}.example.test/`);
  const log = join(tree, 'requests.jsonl');
  writeFileSync(entry, 'process.exitCode = 17;\n');
  await assert.rejects(startApplyProbe({ tree, urls, log, deadlineMs: 2000 }), /probe exited \(17\)/);
  await assert.rejects(startApplyProbe({ tree, urls, log, deadlineMs: 2000 }), { code: 'EEXIST' });

  const sample = (url, result) => JSON.stringify({ at: '2026-11-22T06:00:00Z', ms: 12, lag_ms: 0, url, ...result });
  const invalid = [sample(urls[0], { status: 503 }), sample(urls[1], { error: 'TimeoutError' }),
    sample(urls[2], { status: 200, retried: 'UND_ERR_SOCKET' }), sample(urls[3], { status: 200 })].join('\n');
  writeFileSync(entry, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[3], ${JSON.stringify(invalid)});\nsetInterval(() => {}, 20);\n`);
  await assert.rejects(startApplyProbe({ tree, urls, log: join(tree, 'bad.jsonl'), deadlineMs: 500 }), error => {
    assert.match(error.message, /startup deadline/);
    for (const url of urls) assert.ok(error.message.includes(url));
    return true;
  });
});

test('apply probe admits a name that is up but has no page at / (404), as the probe itself counts it up', async t => {
  const tree = mkdtempSync(join(tmpdir(), 'apply-probe-fixture-'));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const entry = probeEntry(tree);
  mkdirSync(dirname(entry), { recursive: true });
  const urls = ['https://files.example.test/', 'https://site.example.test/'];
  const sample = (url, status) => JSON.stringify({ at: '2026-11-24T13:00:00Z', ms: 12, lag_ms: 0, url, status });
  const up = `${[sample(urls[0], 404), sample(urls[1], 200)].join('\n')}\n`;
  writeFileSync(entry, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[3], ${JSON.stringify(up)});\nsetInterval(() => {}, 20);\n`);
  const probe = await startApplyProbe({ tree, urls, log: join(tree, 'up.jsonl'), deadlineMs: 2000 });
  assert.ok(probe);
  await probe.stop().catch(() => {}); // the fixture writes no final summary; admission is what is checked here
});

test('a refused write or one that does not read back equal stops the probe and never sets links or applies', async () => {
  for (const exception of [false, true]) {
    const { deps, seen } = world({ written: false, recorded: OLD });
    const { input, checkUnchanged } = withLinks();
    const original = structuredClone(seen.stored);
    if (exception) deps.store.write = () => { throw new Error('row changed since it was read'); };
    await assert.rejects(applyARow(input, {}, deps), exception ? /row changed since it was read/ : /did not read back/);
    assert.deepEqual(seen.stored, original);
    assert.deepEqual([seen.probes.length, seen.stopped, seen.applied.length], [1, 1, 0]);
    checkUnchanged();
  }
});

test('a link failure after the write restores the row and links, stops the probe and does not apply', async () => {
  const { deps, seen } = world({ recorded: OLD });
  const { input, checkUnchanged } = withLinks();
  const original = structuredClone(seen.stored);
  input.links.set['fresh.example.com'] = 'x'.repeat(65536);
  await assert.rejects(applyARow(input, {}, deps), /symlink/);
  assert.deepEqual(seen.stored, original);
  assert.deepEqual([seen.writes.length, seen.stopped, seen.applied.length], [2, 1, 0]);
  checkUnchanged();
});

test('a confirmed launch failure restores the row and links, but a lost apply result does not', async () => {
  for (const notStarted of [true, false]) {
    const { deps, seen } = world({ recorded: OLD });
    const { input, present, fresh, checkUnchanged } = withLinks();
    const original = structuredClone(seen.stored);
    deps.runApply = async () => { throw Object.assign(new Error('apply process failed'), { apply_not_started: notStarted }); };
    await assert.rejects(applyARow(input, {}, deps), notStarted ? /^Error: apply process failed$/ : /apply outcome is unknown/);
    assert.equal(seen.stopped, 1);
    if (notStarted) {
      assert.deepEqual(seen.stored, original);
      assert.equal(seen.writes.length, 2);
      checkUnchanged();
    } else {
      assert.equal(seen.writes.length, 1);
      assert.equal(seen.stored.runs.rendered_from_workshop, TREE);
      assert.equal(seen.stored.runs.units[1].source.commit, NEW);
      assert.deepEqual([readlinkSync(present), readlinkSync(fresh)], ['new-target', 'new-target']);
    }
  }
});

test('an exit without a machine result, including zero, retains row and links for readback', async t => {
  for (const [exit, receipt] of [[0, undefined], [0, {}], [0, applyReceipt(4)], [1, undefined], [1, { apply_checked: [] }]]) {
    const { deps, seen, log } = world({ recorded: OLD });
    const { input, present, fresh } = withLinks();
    t.after(() => {
      rmSync(log, { recursive: true, force: true });
      rmSync(input.links.folder, { recursive: true, force: true });
    });
    deps.runApply = async () => ({ exit, receipt });
    await assert.rejects(applyARow(input, {}, deps), { exit: 1, child_exit: exit, apply_outcome: 'unknown_needs_readback', log_folder: log });
    assert.equal(seen.stopped, 1);
    assert.equal(seen.writes.length, 1);
    assert.equal(seen.stored.runs.units[1].source.commit, NEW);
    assert.deepEqual([readlinkSync(present), readlinkSync(fresh)], ['new-target', 'new-target']);
  }
});

test('an archive without the result protocol is refused before the probe, row, links or child launch', async t => {
  const { deps, seen, log } = world({ recorded: OLD });
  const { input, checkUnchanged } = withLinks();
  t.after(() => {
    rmSync(log, { recursive: true, force: true });
    rmSync(input.links.folder, { recursive: true, force: true });
  });
  const archive = deps.archive;
  deps.archive = async (commit, tree) => {
    await archive(commit, tree);
    const entry = join(dirname(probeEntry(tree)), 'start-a-computer.mjs');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'export const legacy = true;');
  };
  deps.checkApplyProtocol = checkApplyProtocol;
  await assert.rejects(applyARow(input, {}, deps), /cannot report the required computer apply result/);
  assert.deepEqual([seen.probes, seen.writes, seen.applied], [[], [], []]);
  checkUnchanged();
});

test('losing the final probe receipt does not undo a verified switched row and its links', async t => {
  for (const childExit of [0, 17]) {
    const { deps, seen, log } = world({ recorded: OLD });
    const { input, present, fresh } = withLinks();
    t.after(() => {
      rmSync(log, { recursive: true, force: true });
      rmSync(input.links.folder, { recursive: true, force: true });
    });
    const archive = deps.archive;
    deps.archive = async (commit, tree) => {
      await archive(commit, tree);
      const entry = probeEntry(tree);
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, `import { appendFileSync } from 'node:fs';
const timer = setInterval(() => {}, 25);
process.on('SIGTERM', () => { process.exitCode = ${childExit}; clearInterval(timer); });
for (const url of process.argv.slice(4)) appendFileSync(process.argv[3], JSON.stringify({ at: new Date().toISOString(), url, status: 200, ms: 1, lag_ms: 0 }) + '\\n');
`);
    };
    deps.startProbe = startApplyProbe;
    deps.targets.probe.startup_deadline_ms = 3000;
    const api = deps.runApply;
    let livePid = 101;
    deps.runApply = async args => {
      livePid = 202;
      const result = await api(args);
      result.receipt.switched = [{ to: 'two.example-b.service', from: ['two.example-a.service'] }];
      return result;
    };
    const { code, summary } = await applyARow(input, {}, deps);
    assert.deepEqual([code, summary.apply_exit, summary.probe_outcome], [7, 0, 'evidence_unconfirmed']);
    assert.match(summary.probe_error, childExit ? /without a normal measurement finish/ : /no valid final summary/);
    assert.equal(summary.probe.sent, undefined);
    assert.equal(summary.row_put_back, undefined);
    assert.deepEqual([seen.writes.length, seen.stored.runs.units[1].source.commit, livePid], [1, NEW, 202]);
    assert.deepEqual([readlinkSync(present), readlinkSync(fresh)], ['new-target', 'new-target']);
  }
});

test('setLinks puts every link back to its old target, or removes one that was not there', () => {
  const folder = mkdtempSync(join(tmpdir(), 'apply-row-links-'));
  symlinkSync('a', join(folder, 'x'));
  const put = setLinks(folder, { x: 'b', y: 'c' });
  assert.equal(readlinkSync(join(folder, 'x')), 'b');
  put();
  assert.equal(readlinkSync(join(folder, 'x')), 'a');
  assert.throws(() => lstatSync(join(folder, 'y')), { code: 'ENOENT' });
});

test('a link target may name {home}, this computer\'s home, as the folder may', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'apply-row-links-'));
  const { deps } = world({ exit: 0 });
  await applyARow(request({ links: { folder, set: { 'home.example.com': '{home}/pages' } } }), {}, deps);
  assert.equal(readlinkSync(join(folder, 'home.example.com')), join(homedir(), 'pages'));
});

test('the row store writes only a row still as it was read, and answers what the database holds', async () => {
  const stored = row(), calls = [];
  const sql = async (statement, params) => {
    calls.push(statement.split(' ')[0]);
    if (statement.startsWith('select')) return { columns: ['name', 'address', 'os', 'arch', 'libc', 'what_this_is', 'runs', 'site'], rows: [['example-box', stored.address, 'linux', 'x86_64', null, stored._what, JSON.stringify(stored.runs), null]] };
    const fields = ['address', 'os', 'arch', 'libc', 'what_this_is', 'runs'];
    const current = [stored.address, stored.os, stored.arch, null, stored._what, JSON.stringify(stored.runs)];
    return JSON.stringify(params.slice(7)) === JSON.stringify(current) ? { columns: fields, rows: [params.slice(1, 7)] } : { columns: fields, rows: [] };
  };
  const store = sqlRowStore(sql);
  const { computer } = await store.read('example-box');
  assert.deepEqual(computer, stored);
  assert.deepEqual(await store.write('example-box', computer), { read_back_equal: true });
  stored.address = '192.0.2.8';
  await assert.rejects(store.write('example-box', computer), /changed since it was read/);
  assert.deepEqual(calls, ['select', 'update', 'update']);
});

test('a run folder is named by its real path, so a program unpacked in it sees its argv equal to its own module path', () => {
  const folder = runFolder('example-box');
  assert.equal(folder, realpathSync(folder));
});


test('an unknown or unsupported apply scope refuses before reading the computer row', async () => {
  for (const extra of [{ only_unit: 'engine.service' }, { scope: { kind: 'not-implemented', unit: 'engine.service' } }]) {
    const deps = { store: { read: () => assert.fail('scope was silently dropped before owner-row read') } };
    await assert.rejects(applyARow(request(extra), {}, deps), /unsupported apply scope|unknown apply request field/);
  }
});
