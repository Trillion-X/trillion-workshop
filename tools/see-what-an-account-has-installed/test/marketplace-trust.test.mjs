// A published version's trust disposition is recorded on each install, and the install policy (DATA) can refuse some.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installedConfiguration, publicConfiguration } from '../src/marketplace-configurations.mjs';
import trust from '../src/marketplace-trust.json' with { type: 'json' };

const row = (disposition, extra = {}) => ({ id: 'tidy@abc', version: '1f:v1', title: 'Tidy', description: 'd', components: [{ kind: 'tool', id: 't', version: 'v' }], ...(disposition ? { disposition } : {}), ...extra });
const install = (item, policy) => installedConfiguration(item, 'private', 'person', '2026-10-19T00:00:00Z', null, policy ? { policy } : {});

test('the disposition of the exact version is recorded on the install, and a version with none is recorded unrated', () => {
  for (const disposition of ['clean', 'review-recommended', 'review-required']) assert.equal(install(row(disposition)).disposition, disposition);
  assert.equal(install(row()).disposition, 'unrated');
  assert.equal(install(row('made-up')).disposition, 'unrated', 'a disposition the DATA does not list is not trusted');
  assert.equal(publicConfiguration(row('clean'), 'https://x').disposition, 'clean');
});

test('shipped, only a blocked version is refused; a stricter policy refuses more and says which disposition and why', () => {
  assert.deepEqual(trust.install_policy, { refuse: ['blocked'] });
  assert.throws(() => install(row('blocked')), /Tidy 1f:v1 was blocked, so it cannot be installed/);
  assert.equal(install(row('review-required')).disposition, 'review-required', 'open by default');
  assert.throws(() => install(row('review-required'), { refuse: ['blocked', 'review-required'] }), /marked review-required, which this install policy refuses/);
  assert.equal(install(row('clean'), { refuse: ['blocked', 'review-required'] }).disposition, 'clean');
});
