import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newsletterAudience, subscriberLinks, subscriberTags } from '../do-work/subscriber-audience.mjs';

const secret = 'x'.repeat(40);
const origin = 'https://example.test';
const row = { id: 'reader-1', email: 'Reader@Example.test', status: 'confirmed', tags: '["guide","updates"]' };
const audience = (subscribers = [row], other = {}) => newsletterAudience({ subscribers, origin, secret, ...other });

test('tags are normalized, deduplicated and ordered from either store shape', () => {
  assert.deepEqual(subscriberTags('[" updates ","guide","guide"]'), ['guide', 'updates']);
  assert.deepEqual(subscriberTags(['guide', 'updates']), ['guide', 'updates']);
  for (const bad of ['not json', '{}', '[null]', [''], [4], null]) assert.throws(() => subscriberTags(bad));
});

test('the audience returns the site signer\'s one-click link, not a link invented by its caller', () => {
  const result = audience();
  assert.equal(result.count, 1);
  assert.equal(result.audience[0].email, 'reader@example.test');
  const link = new URL(result.audience[0].unsubscribe_url);
  assert.equal(link.origin, origin);
  assert.equal(link.pathname, '/unsubscribe');
  assert.equal(link.searchParams.get('s'), row.id);
  assert.equal(link.searchParams.get('t'), createHmac('sha256', secret).update(`unsubscribe\n${row.id}`).digest('base64url'));
  assert.equal(result.audience[0].unsubscribe_url.includes(secret), false);
});

test('tag routing requires every selected tag and excludes any excluded tag', () => {
  assert.equal(audience([row], { required_tags: ['guide', 'updates'] }).count, 1);
  assert.equal(audience([row], { required_tags: ['guide', 'other'] }).count, 0);
  assert.equal(audience([row], { excluded_tags: ['guide'] }).count, 0);
  assert.equal(audience([row], { excluded_tags: ['other'] }).count, 1);
});

test('no state other than confirmed enters the audience, even with matching tags', () => {
  const states = ['pending', 'unsubscribed', 'suppressed', 'bounced', 'complained', 'dormant', 'not-seen-before', ''];
  const subscribers = states.map((status, i) => ({ ...row, id: `other-${i}`, email: `reader-${i}@example.test`, status }));
  const result = audience(subscribers, { required_tags: ['guide'] });
  assert.equal(result.count, 0);
  assert.equal(result.excluded, states.length);
});

test('an empty page is empty; exact duplicate rows do not make duplicate sends', () => {
  assert.deepEqual(audience([]), { audience: [], count: 0, excluded: 0 });
  assert.equal(audience([row, { ...row }]).count, 1);
});

test('conflicting identities, states or tags refuse the entire page before a send can be prepared', () => {
  for (const conflicting of [
    { ...row, email: 'another@example.test' },
    { ...row, id: 'other' },
    { ...row, status: 'suppressed' },
    { ...row, tags: '["blocked"]' },
  ]) assert.throws(() => audience([row, conflicting]), /conflicting/);
});

test('malformed stored tags refuse a page instead of treating unknown tags as untagged', () => {
  assert.throws(() => audience([{ ...row, tags: 'broken' }]));
  assert.throws(() => audience([row], { required_tags: [null] }));
});

test('a link escapes the id, binds it to one site secret, and cannot be moved to a second installation', () => {
  const id = 'with & ? and /';
  const one = subscriberLinks({ origin, secret })(id);
  const two = subscriberLinks({ origin: 'https://other.test', secret: 'y'.repeat(40) })(id);
  assert.equal(new URL(one).searchParams.get('s'), id);
  assert.notEqual(new URL(one).searchParams.get('t'), new URL(two).searchParams.get('t'));
});

test('origins cannot redirect a subscriber link to HTTP, a path or embedded credentials', () => {
  for (const bad of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?query=x', 'https://example.test/#x']) {
    assert.throws(() => subscriberLinks({ origin: bad, secret }));
  }
  assert.throws(() => subscriberLinks({ origin, secret: 'short' }));
  assert.throws(() => subscriberLinks({ origin, secret })(''));
});

test('the audience command reads its key from descriptor 3 and never prints it', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../do-work/prepare-audience.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (bytes) => { stdout += bytes; });
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdio[3].end(secret);
    child.stdin.end(JSON.stringify({ subscribers: [row], origin, key_name: 'example-site-link-key' }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).count, 1);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr, '');
});

test('the audience tool mounts the named site key only on descriptor 3 and sends nothing', () => {
  const { records: [{ payload: tool }] } = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url)));
  assert.equal(tool.id, 'tool:prepare-a-newsletter-audience');
  assert.equal(tool.invoke.may_reach, undefined);
  assert.equal(tool.read_only, true);
  assert.deepEqual(tool.invoke.key, [{ secret_name_from_input: 'key_name', fd: 3 }]);
  assert.ok(tool.input_schema.required.includes('key_name'));
  assert.equal(tool.input_schema.properties.secret, undefined);
});
