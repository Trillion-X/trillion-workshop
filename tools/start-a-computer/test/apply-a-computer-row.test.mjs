// tools/start-a-computer/test/apply-a-computer-row.test.mjs
//
// Changing a computer's row and applying it: edits by path selector, compare-and-set before anything is written, links put back
// when the apply fails, the apply's exit code passed through, and a dry run that writes nothing. The row store, the unpacking,
// the probe and the apply are made up; the links are real symlinks in a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyARow, applyEdits, heldNamesOf, hostsOf, parsePath, runFolder, setLinks, sqlRowStore } from '../do-work/apply-a-computer-row.mjs';

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

// A whole run with everything outside made up. `store` keeps what was written; `exit` is what the apply answers.
const world = ({ exit = 0, written = true } = {}) => {
  const log = mkdtempSync(join(tmpdir(), 'apply-row-test-'));
  const seen = { writes: [], applied: [], stopped: 0, archived: [] };
  const deps = {
    store: { read: async () => ({ computer: row(), siteSetting: null }), write: async (name, computer) => { seen.writes.push({ name, computer }); return { read_back_equal: written }; } },
    targets: { machines: { '192.0.2.7': { ssh: { known_hosts: '/hosts', identity_file: '/key' }, pages_folder: '/pages' } }, probe: {} },
    heldValues: async names => Object.fromEntries(names.map(name => [name, 'v'])),
    runFolder: () => log,
    archive: async (commit, folder) => { seen.archived.push(commit); mkdirSync(folder, { recursive: true }); },
    startProbe: async ({ urls }) => ({ stop: async () => { seen.stopped++; return { requests: 3, failed: 0, failures: [], slow_requests: [], urls }; } }),
    runApply: async ({ requestFile, held }) => { seen.applied.push({ request: JSON.parse(readFileSync(requestFile, 'utf8')), held }); return exit; },
    sleep: async () => {}, now: () => Date.parse('2026-11-22T06:00:00Z'),
  };
  return { deps, seen, log };
};
const request = extra => ({ computer: 'example-box', workshop_commit: TREE, edits: [edit], ...extra });

test('a run writes the row once, applies it with the machine\'s identity and held values, and passes the exit code through', async () => {
  const { deps, seen, log } = world({ exit: 7 });
  const { code, summary } = await applyARow(request(), {}, deps);
  assert.equal(code, 7);
  assert.equal(summary.apply_exit, 7);
  assert.equal(seen.writes.length, 1);
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

test('setLinks puts every link back to its old target, or removes one that was not there', () => {
  const folder = mkdtempSync(join(tmpdir(), 'apply-row-links-'));
  symlinkSync('a', join(folder, 'x'));
  const put = setLinks(folder, { x: 'b', y: 'c' });
  assert.equal(readlinkSync(join(folder, 'x')), 'b');
  put();
  assert.equal(readlinkSync(join(folder, 'x')), 'a');
  assert.throws(() => lstatSync(join(folder, 'y')), { code: 'ENOENT' });
});

test('the row store writes only a row still as it was read, and answers what the database holds', async () => {
  const stored = row(), calls = [];
  const sql = async (statement, params) => {
    calls.push(statement.split(' ')[0]);
    if (statement.startsWith('select')) return { columns: ['name', 'address', 'os', 'arch', 'libc', 'what_this_is', 'runs', 'site'], rows: [['example-box', stored.address, 'linux', 'x86_64', null, stored._what, JSON.stringify(stored.runs), null]] };
    return params[7] === JSON.stringify(stored.runs) ? { columns: ['runs'], rows: [[params[6]]] } : { columns: ['runs'], rows: [] };
  };
  const store = sqlRowStore(sql);
  const { computer } = await store.read('example-box');
  assert.deepEqual(computer, stored);
  assert.deepEqual(await store.write('example-box', computer), { read_back_equal: true });
  stored.runs.units.pop();
  await assert.rejects(store.write('example-box', computer), /changed since it was read/);
  assert.deepEqual(calls, ['select', 'update', 'update']);
});

test('a run folder is named by its real path, so a program unpacked in it sees its argv equal to its own module path', () => {
  const folder = runFolder('example-box');
  assert.equal(folder, realpathSync(folder));
});
