// Every behaviour of the engine, with no fixture on disk, because the engine takes its readers as
// arguments. The last block runs the identical engine against a subject with no filesystem in it at
// all, which is the test that the package is generic rather than a git checker in a costume.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  placesIn, resolvedPlaces, retentionAt, retentionReport,
} from '../do-work/check-declared-places-keep-what-is-written-there.mjs';

const joinWith = (...parts) => parts.filter((part) => part !== '').join('/').replace(/\/+/g, '/');

test('places are found by KEY at any depth, not at a fixed path', () => {
  const declaration = {
    authoring: { nested: { deeper: { may_write_here: [
      { path_contains: '/one/', holds: 'anything' },
      { path_contains: '/two/', holds: 'documents_and_data' },
    ] } } },
  };
  const found = placesIn(declaration, { placesKey: 'may_write_here', idKey: 'path_contains' });
  assert.deepEqual(found.map((row) => row.id), ['/one/', '/two/']);
  assert.equal(found[1].declared.holds, 'documents_and_data');
});

test('a row with no identifier is skipped rather than becoming an empty place', () => {
  const declaration = { may_write_here: [{ holds: 'anything' }, { path_contains: '' }, { path_contains: '/real/' }] };
  const found = placesIn(declaration, { placesKey: 'may_write_here', idKey: 'path_contains' });
  assert.deepEqual(found.map((row) => row.id), ['/real/']);
});

test('placesIn refuses without both keys, because a default key is a guess about someone else document', () => {
  assert.throws(() => placesIn({}, { placesKey: 'x' }), /needs placesKey and idKey/);
  assert.throws(() => placesIn({}, { idKey: 'y' }), /needs placesKey and idKey/);
});

test('a key that matches nothing returns zero places rather than throwing, so the caller can refuse', () => {
  const found = placesIn({ some_other_key: [{ path_contains: '/x/' }] }, { placesKey: 'may_write_here', idKey: 'path_contains' });
  assert.deepEqual(found, []);
});

test('a place resolves under every base where it exists', () => {
  const onDisk = new Set(['/home/a/thing', '/home/dev/thing']);
  const resolved = resolvedPlaces([{ id: 'thing' }], {
    bases: ['a', 'dev'], home: '/home', join: joinWith, isDirectory: (p) => onDisk.has(p),
  });
  assert.deepEqual(resolved[0].directories, ['/home/a/thing', '/home/dev/thing']);
});

test('two bases naming the same directory produce ONE entry, or both counts inflate', () => {
  const resolved = resolvedPlaces([{ id: 'thing' }], {
    bases: ['', ''], home: '/home', join: joinWith, isDirectory: () => true,
  });
  assert.deepEqual(resolved[0].directories, ['/home/thing']);
});

test('a place that exists nowhere resolves to no directories rather than to a guess', () => {
  const resolved = resolvedPlaces([{ id: 'absent' }], {
    bases: ['dev'], home: '/home', join: joinWith, isDirectory: () => false,
  });
  assert.deepEqual(resolved[0].directories, []);
});

test('resolvedPlaces refuses with no bases, since resolving without one means resolving against the process cwd', () => {
  assert.throws(() => resolvedPlaces([], { bases: [], home: '/home', join: joinWith, isDirectory: () => true }),
    /needs bases/);
});

test('a marker AT the directory counts, and so does one at an ancestor', () => {
  const markers = new Set(['/home/dev/repo/.git']);
  const marker = (dir, name) => markers.has(`${dir}/${name}`);
  const ancestorsOf = (dir) => (dir === '/home/dev/repo/inside' ? ['/home/dev/repo', '/home/dev'] : []);
  const kinds = [{ kind: 'git', marker: '.git' }];
  assert.deepEqual(retentionAt('/home/dev/repo', { kinds, marker, ancestorsOf: () => [] }), ['git']);
  assert.deepEqual(retentionAt('/home/dev/repo/inside', { kinds, marker, ancestorsOf }), ['git']);
});

test('a second retention kind is a ROW, and both can hold at once', () => {
  const markers = new Set(['/x/.git', '/x/.snapshots']);
  const kinds = [{ kind: 'git', marker: '.git' }, { kind: 'snapshots', marker: '.snapshots' }];
  const kept = retentionAt('/x', { kinds, marker: (d, n) => markers.has(`${d}/${n}`), ancestorsOf: () => [] });
  assert.deepEqual(kept, ['git', 'snapshots']);
});

test('a place that keeps nothing is a finding, and the report carries its denominator', () => {
  const places = [
    { id: '/kept/', directories: ['/home/kept'] },
    { id: '/bare/', directories: ['/home/bare'] },
  ];
  const markers = new Set(['/home/kept/.git']);
  const report = retentionReport(places, {
    kinds: [{ kind: 'git', marker: '.git' }],
    marker: (d, n) => markers.has(`${d}/${n}`),
    ancestorsOf: () => [],
  });
  assert.equal(report.keepsNothingCount, 1);
  assert.equal(report.examinedCount, 2);
  assert.equal(report.keepsNothing[0].place, '/bare/');
});

test('an exempt place is EXAMINED and reported with its reason, never omitted', () => {
  const places = [{ id: '/scratch/', directories: ['/home/scratch'] }];
  const report = retentionReport(places, {
    kinds: [{ kind: 'git', marker: '.git' }],
    marker: () => false,
    ancestorsOf: () => [],
    exemptions: [{ place: '/scratch/', why: 'declared scratch' }],
  });
  assert.equal(report.keepsNothingCount, 0);
  assert.equal(report.examinedCount, 1, 'an exempt place must still be counted, or the denominator lies');
  assert.equal(report.examined[0].exemptFor, 'declared scratch');
});

test('a place present nowhere is UNRESOLVED, not a finding, so a fresh clone is not red', () => {
  const places = [{ id: '/not-here/', directories: [] }];
  const report = retentionReport(places, {
    kinds: [{ kind: 'git', marker: '.git' }], marker: () => false, ancestorsOf: () => [],
  });
  assert.equal(report.keepsNothingCount, 0);
  assert.equal(report.examinedCount, 0);
  assert.deepEqual(report.unresolved, ['/not-here/']);
});

test('a clean corpus and an EMPTY input are distinguishable, which is the whole reason for the denominator', () => {
  const clean = retentionReport([{ id: '/a/', directories: ['/home/a'] }], {
    kinds: [{ kind: 'git', marker: '.git' }], marker: () => true, ancestorsOf: () => [],
  });
  const empty = retentionReport([], {
    kinds: [{ kind: 'git', marker: '.git' }], marker: () => true, ancestorsOf: () => [],
  });
  assert.equal(clean.keepsNothingCount, 0);
  assert.equal(empty.keepsNothingCount, 0);
  assert.notEqual(clean.examinedCount, empty.examinedCount,
    'both report zero findings; only the denominator tells them apart');
});

test('one place resolving to two directories is judged per directory, since one can be covered and the other not', () => {
  const places = [{ id: '/twin/', directories: ['/home/twin', '/home/dev/twin'] }];
  const markers = new Set(['/home/twin/.git']);
  const report = retentionReport(places, {
    kinds: [{ kind: 'git', marker: '.git' }],
    marker: (d, n) => markers.has(`${d}/${n}`),
    ancestorsOf: () => [],
  });
  assert.equal(report.examinedCount, 2);
  assert.equal(report.keepsNothingCount, 1);
  assert.equal(report.keepsNothing[0].directory, '/home/dev/twin');
});

// THE SAME ENGINE, A COMPLETELY DIFFERENT JOB. No filesystem, no repository, no agent, no write
// root. Shipping containers are declared as accepting cargo on the promise that something records
// what went in, and the question is which of them record nothing. If this needed one line changed,
// the package would be a git checker in a costume.
test('the same engine answers for shipping containers and a manifest that proves loading', () => {
  const declaration = { terminal: { accepts_cargo_at: [
    { bay_code: 'north-quay', holds: 'anything' },
    { bay_code: 'cold-store', holds: 'perishables' },
    { bay_code: 'overflow-yard', holds: 'anything' },
  ] } };
  const bays = placesIn(declaration, { placesKey: 'accepts_cargo_at', idKey: 'bay_code' });
  assert.equal(bays.length, 3);

  const built = new Set(['/port/north-quay', '/port/cold-store', '/port/overflow-yard']);
  const resolved = resolvedPlaces(bays, {
    bases: [''], home: '/port', join: joinWith, isDirectory: (p) => built.has(p),
  });

  const papers = new Set(['/port/north-quay/loading-manifest', '/port/cold-store/loading-manifest']);
  const report = retentionReport(resolved, {
    kinds: [{ kind: 'loading-manifest', marker: 'loading-manifest' }],
    marker: (bay, paper) => papers.has(`${bay}/${paper}`),
    ancestorsOf: () => [],
    exemptions: [],
  });

  assert.equal(report.examinedCount, 3);
  assert.equal(report.keepsNothingCount, 1);
  assert.equal(report.keepsNothing[0].place, 'overflow-yard');
  assert.deepEqual(report.examined[0].kept, ['loading-manifest']);
});
