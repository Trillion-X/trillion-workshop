import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { addRelease, checkEntry, checkFeedTarget, newSigningKey, productSettingsEntry, publicKeyHex, relativeUrlOf, settings, signedText, verifyEntry } from '../do-work/release-feed.mjs';

const COMMIT = '3413e12b' + 'a'.repeat(32);
const BYTES = Buffer.from('{"word":"trillion","new_accounts":{}}\n');
const key = newSigningKey();
const publicHex = publicKeyHex(key);

test('a product settings entry names its bytes by BLAKE3 identity and a relative url', () => {
  const entry = productSettingsEntry({ commit: COMMIT, sequence: 1794430000, bytes: BYTES }, key);
  assert.equal(entry.target, 'product-settings');
  assert.equal(entry.content, makeHashCodeHexFromBytes(BYTES));
  assert.equal(entry.url, relativeUrlOf('product-settings', entry.content));
  assert.equal(entry.bytes, BYTES.length);
  assert.equal(entry.urgent, false);
  assert.ok(verifyEntry(entry, publicHex), 'the signature verifies with the signing key');
});

test('the signature is over the engine v2 text, with the relative url bound', () => {
  const entry = productSettingsEntry({ commit: COMMIT, sequence: 1794430000, bytes: BYTES }, key);
  assert.equal(signedText(entry), [settings.signing_domain_bound, COMMIT, 1794430000, 'product-settings', entry.url, entry.content, BYTES.length, 'false'].join('\n'));
  assert.equal(settings.signing_domain_bound, 'trillion-engine-release-v2');
});

test('a tampered entry fails its signature or its identity check', () => {
  const entry = productSettingsEntry({ commit: COMMIT, sequence: 1794430000, bytes: BYTES }, key);
  assert.equal(verifyEntry({ ...entry, bytes: entry.bytes + 1 }, publicHex), false);
  assert.equal(verifyEntry({ ...entry, url: `product-settings/${'c'.repeat(64)}.json` }, publicHex), false, 'the url is inside the signature');
  assert.notEqual(makeHashCodeHexFromBytes(Buffer.from('{"word":"other"}\n')), entry.content);
});

test('a relative url must be the one its content identity names', () => {
  const entry = productSettingsEntry({ commit: COMMIT, sequence: 1794430000, bytes: BYTES }, key);
  assert.throws(() => checkEntry({ ...entry, url: `product-settings/${'a'.repeat(64)}.json` }), /named by its content identity/);
  assert.throws(() => checkEntry({ ...entry, url: `https://example.test/${entry.url}` }), /named by its content identity/);
});

test('an engine target still needs an https url', () => {
  const entry = productSettingsEntry({ commit: COMMIT, sequence: 1794430000, bytes: BYTES }, key);
  assert.throws(() => checkEntry({ ...entry, target: 'x86_64-unknown-linux-gnu' }), /not https/);
});

test('product settings entries live in their own feed, not the engine feed', () => {
  const entry = productSettingsEntry({ commit: COMMIT, sequence: 1794430000, bytes: BYTES }, key);
  assert.throws(() => checkFeedTarget('feed.json', 'product-settings'), /belongs in product-settings-feed.json/);
  const { feed, added } = addRelease({ releases: [] }, entry, 32, 'product-settings-feed.json');
  assert.equal(added, true);
  assert.deepEqual(feed.releases, [entry]);
});
