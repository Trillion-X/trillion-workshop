// A Marketplace tool's newest release that a Trillion runs (read-data/tool-releases.mjs). Moved from Trillion-X/trillion
// test/tool-release-compat.test.mjs, assertions unchanged. Its three tests that publish and run through src/workshop.mjs
// (makeWorkshop) stay in trillion with that caller.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions, compatibleRelease, withEarlierReleases } from '../read-data/tool-releases.mjs';
import settings from '../read-data/tool-releases.json' with { type: 'json' };

test('versions compare part by part; missing parts are zero', () => {
  assert.ok(compareVersions('2026.10.1', '2026.9.28') > 0);
  assert.equal(compareVersions('2026.10', '2026.10.0'), 0);
  assert.ok(compareVersions('2026.9', '2026.9.1') < 0);
});

test('earlier releases: one per minimum, only lower minimums, never another maker, at most keep_earlier', () => {
  const at = (model, minimum) => ({ id: 't', invoke: { model }, ...(minimum ? { minimum_host_version: minimum } : {}) });
  const previous = { ...at('c', '2026.2'), earlier_releases: [at('b', '2026.2'), at('a')] };
  const row = withEarlierReleases(at('d', '2026.3'), previous);
  assert.deepEqual(row.earlier_releases.map(one => one.invoke.model), ['c', 'a']);
  assert.equal(withEarlierReleases(at('e'), previous).earlier_releases, undefined);
  assert.equal(withEarlierReleases(at('f', '2026.2'), previous).earlier_releases.map(one => one.invoke.model).join(), 'a');
  const many = { ...at('x', '1.' + settings.keep_earlier + 5), earlier_releases: Array.from({ length: settings.keep_earlier + 5 }, (_, index) => at(`r${index}`, `1.${settings.keep_earlier + 4 - index}`)) };
  assert.equal(withEarlierReleases(at('y', '9'), many).earlier_releases.length, settings.keep_earlier);
  assert.equal(compatibleRelease(row, '2026.1').invoke.model, 'a');
  assert.equal(compatibleRelease({ ...at('z', '3') }, '2'), null);
});
