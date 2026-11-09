// Actual caller boundaries over fake names and injected DNS answers only: no sockets,
// device observation, account reads, provider calls or real DNS requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decideOpen, egressRelaySettings } from '../tools/run-on-a-persons-computer/egress-relay.mjs';
import { observationVerdict } from '../tools/run-on-a-persons-computer/observation-rules.mjs';
import { acceptOffered } from '../tools/run-on-a-persons-computer/offered-endpoints.mjs';

const relay = egressRelaySettings();
const publicAnswer = [{ address: '93.184.216.34' }];
const observation = { default_application: 'observe', default_website: 'observe', applications: [], websites: [] };

test('relay host policy follows canonical whole labels before consulting DNS', async () => {
  const settings = { ...relay, allowed_hosts: ['EXAMPLE.TEST.'] };
  const asked = [];
  const resolve = async host => { asked.push(host); return publicAnswer; };
  for (const host of ['example.test', 'sub.Example.test.']) {
    assert.equal((await decideOpen({ host, port: 443 }, settings, resolve)).ok, true, host);
  }
  assert.deepEqual(asked, ['example.test', 'sub.Example.test.'], 'the actual target spelling reaches the existing DNS owner');
  for (const host of ['evilexample.test', 'example.test.evil.test', 'exаmple.test']) {
    const before = asked.length;
    assert.equal((await decideOpen({ host, port: 443 }, settings, resolve)).ok, false, host);
    assert.equal(asked.length, before, 'a refused host never reaches DNS');
  }
});

test('relay preserves unresolved, any-private-address, empty-allowlist and explicit-private policy', async () => {
  const settings = { ...relay, allowed_hosts: ['example.test'] };
  const target = { host: 'api.example.test', port: 443 };
  assert.equal((await decideOpen(target, settings, async () => [])).ok, false);
  assert.equal((await decideOpen(target, settings, async () => [...publicAnswer, { address: '192.168.1.2' }])).ok, false);
  const allowed = await decideOpen(target, { ...settings, allow_private_targets: true }, async () => [{ address: '192.168.1.2' }]);
  assert.deepEqual(allowed, { ok: true, address: '192.168.1.2', port: 443 });
  assert.equal((await decideOpen({ host: 'other.test', port: 443 }, { ...relay, allowed_hosts: [] }, async () => publicAnswer)).ok, true);
  assert.equal((await decideOpen({ host: 'other.test', port: 443 }, { ...relay, allowed_hosts: [] }, async () => [{ address: '127.0.0.1' }])).ok, false);
});

test('observation keeps private/application/block precedence and website defaults with canonical hosts', () => {
  const subject = { identities: ['example.app'], domain: 'Sub.Example.test.' };
  const allow = { ...observation, default_website: 'do_not_observe', websites: [{ domain: 'EXAMPLE.TEST', mode: 'allow' }] };
  assert.deepEqual(observationVerdict(allow, subject), { observe: true, why: null });
  assert.deepEqual(observationVerdict(allow, { ...subject, private: true }), { observe: false, why: 'private' });
  assert.deepEqual(observationVerdict({ ...allow, applications: [{ app: 'EXAMPLE.APP', mode: 'block' }] }, subject), { observe: false, why: 'application' });
  const blocked = { ...allow, websites: [...allow.websites, { domain: 'sub.example.test', mode: 'block' }] };
  assert.deepEqual(observationVerdict(blocked, subject), { observe: false, why: 'website' });
  for (const domain of ['evilexample.test', 'example.test.evil.test', 'exаmple.test']) assert.equal(observationVerdict(allow, { ...subject, domain }).observe, false, domain);
  assert.equal(observationVerdict(observation, subject).observe, true);
  assert.equal(observationVerdict({ ...observation, default_website: 'do_not_observe' }, subject).observe, false);
  assert.equal(observationVerdict({ ...observation, default_website: 'do_not_observe' }, { identities: ['example.app'] }).observe, true, 'a subject without a website still uses its application policy');
});

test('offered endpoint exact and wildcard policies retain their different apex/descendant boundaries', () => {
  const exact = acceptOffered('http://example.test:8000/v1\nhttp://api.example.test:8000/v1', { allowed_hosts: ['EXAMPLE.TEST.'] });
  assert.deepEqual(exact.accepted, ['http://example.test:8000/v1']);
  assert.equal(exact.refused.length, 1);
  const wildcard = acceptOffered([
    'https://api.example.test./v1', 'https://example.test/v1', 'https://EXAMPLE.TEST./v1',
    'https://evilexample.test/v1', 'https://api.example.test.evil.test/v1', 'ftp://api.example.test/v1',
  ].join('\n'), { allowed_hosts: ['*.EXAMPLE.TEST.'] });
  assert.deepEqual(wildcard.accepted, ['https://api.example.test./v1']);
  assert.equal(wildcard.refused.length, 5);
  assert.equal(acceptOffered('http://other.test/v1', {}).accepted.length, 0, 'an empty personal set retains the local-only default');
});

test('offered endpoints retain the existing default IPv6 loopback policy', () => {
  assert.deepEqual(acceptOffered('http://[::1]:8000/v1', {}).accepted, ['http://[::1]:8000/v1']);
});

test('observation retains an explicit IPv6 website block', () => {
  assert.deepEqual(observationVerdict({ ...observation, websites: [{ domain: '::1', mode: 'block' }] }, { domain: '::1' }), { observe: false, why: 'website' });
});

test('relay retains an explicitly allowed IPv6 literal without consulting DNS', async () => {
  const explicit = await decideOpen({ host: '::1', port: 8000 }, { ...relay, allowed_hosts: ['::1'], allow_private_targets: true }, async () => { throw new Error('an IP literal never needs DNS'); });
  assert.deepEqual(explicit, { ok: true, address: '::1', port: 8000 });
});
