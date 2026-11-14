// packages/make-packages-match-their-source/tests/bundle-one-source-entry.test.mjs
//
// The bundler is exercised for real by the drift guards that compare a committed artifact to a
// fresh build, so what is worth testing HERE is the option reading, which is where the two ways in
// can silently disagree. Every case below is one an earlier draft got wrong or could have.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  argumentValue,
  argumentValues,
  bundleRequestFrom,
  bundleOneSourceEntry,
} from '../do-work/bundle-one-source-entry.mjs';

test('a repeatable flag collects every value, and the single reader takes the LAST', () => {
  const argv = ['--external', 'a', '--external', 'b'];
  assert.deepEqual(argumentValues(argv, '--external'), ['a', 'b']);
  // Last rather than first, so a wrapper appending an override wins over a default it inherited.
  assert.equal(argumentValue(['--format', 'esm', '--format', 'cjs'], '--format'), 'cjs');
});

test('a flag in the final position has no value and is not read as one', () => {
  // The loop stops at argv.length - 1 for exactly this. Reading past the end would hand back
  // undefined and make a truncated command line look like an absent flag.
  assert.deepEqual(argumentValues(['--entry'], '--entry'), []);
});

test('the converter environment WINS over --outfile, because it owns placement', () => {
  const request = bundleRequestFrom(
    ['--entry', 'a.ts', '--outfile', '/caller/said/here.cjs'],
    { BITFIELD_PACKAGE_BUILD_OUTPUT: '/converter/said/there.bytes' },
  );
  assert.equal(request.outfile, path.resolve('/converter/said/there.bytes'));
  assert.equal(request.placementOwnedByConverter, true);
});

test('without the environment the caller places the file, and says so', () => {
  const request = bundleRequestFrom(['--entry', 'a.ts', '--outfile', 'out.cjs'], {});
  assert.equal(request.outfile, path.resolve('out.cjs'));
  assert.equal(request.placementOwnedByConverter, false);
});

test('a missing entry and a missing destination each refuse by name', () => {
  assert.throws(() => bundleRequestFrom(['--outfile', 'x'], {}), /NO_ENTRY/);
  assert.throws(() => bundleRequestFrom(['--entry', 'a.ts'], {}), /NO_OUTFILE/);
});

test('minify is OFF unless asked, so a drift guard is never surprised by it', () => {
  // A default that minified would make committed bytes differ from a plain build for a reason
  // nothing in the command line stated, and the guard failing would name no cause.
  assert.equal(bundleRequestFrom(['--entry', 'a.ts', '--outfile', 'o'], {}).minify, false);
  assert.equal(bundleRequestFrom(['--entry', 'a.ts', '--outfile', 'o', '--minify'], {}).minify, true);
});

test('external is omitted entirely when none was given, never passed as an empty list', () => {
  const seen = [];
  const fakeBundle = async (options) => {
    seen.push(options);
    return { outputFiles: [{ contents: Buffer.from('x') }] };
  };
  const request = bundleRequestFrom(['--entry', 'a.ts', '--outfile', process.env.TMPDIR
    ? path.join(process.env.TMPDIR, 'bundle-one-source-entry-probe.bytes')
    : '/tmp/bundle-one-source-entry-probe.bytes'], {});
  return bundleOneSourceEntry(request, fakeBundle).then(() => {
    assert.equal('external' in seen[0], false);
    // The two that must never be caller-controlled: this exists to produce ONE self-contained
    // file, and `write: false` is what lets one write serve both ways in.
    assert.equal(seen[0].bundle, true);
    assert.equal(seen[0].write, false);
  });
});

test('a bundler that produced nothing is refused rather than writing an empty file', () => {
  const request = bundleRequestFrom(['--entry', 'a.ts', '--outfile', 'o'], {});
  return assert.rejects(
    () => bundleOneSourceEntry(request, async () => ({ outputFiles: [] })),
    /NO_OUTPUT_PRODUCED/,
  );
});
