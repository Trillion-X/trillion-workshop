// test/signed-manifest.test.mjs
//
// A download list counts only when a trusted, live Ed25519 key signed its exact bytes (computer/signed-manifest.mjs);
// the newest entry for the channel is chosen without going backwards, and the file must hash as the list says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { checkArtifact, chooseUpdate, compareVersions, manifestSettings, verifyManifest } from '../signed-manifest.mjs';

const publisher = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return { raw, signs: text => sign(null, Buffer.from(text), privateKey).toString('base64') };
};
const ARTIFACT = Buffer.from('app bytes');
const entry = (version, extra = {}) => ({ version, url: 'https://example.invalid/app', size: ARTIFACT.length, blake3: makeHashCodeHexFromBytes(ARTIFACT).slice(3), ...extra });
const text = JSON.stringify({ entries: [entry('1.2.0'), entry('1.10.0'), entry('2.0.0', { channel: 'beta' })] });

test('the shipped data trusts nobody, so nothing is used', () => {
  assert.deepEqual(manifestSettings().keys, []);
  assert.throws(() => verifyManifest({ text, signature: 'AAAA' }), /trusts no update publisher/);
});

test('only a live trusted key over the exact bytes verifies; every other case is refused, with retry false', () => {
  const good = publisher(), other = publisher();
  const settings = { ...manifestSettings(), keys: [{ id: 'main', public_key: good.raw }, { id: 'old', public_key: other.raw, retired_at: '2026-01-01T00:00:00Z' }] };
  const now = () => Date.parse('2026-10-19T00:00:00Z');
  assert.equal(verifyManifest({ text, signature: good.signs(text), settings, now }).entries.length, 3);
  assert.equal(verifyManifest({ text: Buffer.from(text), signature: good.signs(text), settings, now }).entries.length, 3, 'bytes work too');
  for (const [name, signature, body, words] of [['no signature', '', text, /no signature/], ['tampered text', good.signs(text), `${text} `, /does not match/],
    ['retired key', other.signs(text), text, /does not match/], ['unknown key', publisher().signs(text), text, /does not match/], ['garbage', 'not base64 !!', text, /does not match/]]) {
    assert.throws(() => verifyManifest({ text: body, signature, settings, now }), error => { assert.match(error.message, words, name); assert.equal(error.retry, false); return true; });
  }
  const notJson = 'not json';
  assert.throws(() => verifyManifest({ text: notJson, signature: good.signs(notJson), settings, now }), /not readable/);
  assert.throws(() => verifyManifest({ text, signature: good.signs(text), settings: { ...settings, keys: [{ ...settings.keys[1] }] }, now }), /trusts no update publisher/, 'a retired key alone is no key');
});

test('versions compare by number, the newest of the channel is chosen, and the Mac never goes back or to the same', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  const manifest = JSON.parse(text);
  const stable = chooseUpdate(manifest, { current: '1.2.0' });
  assert.equal(stable.entry.version, '1.10.0');
  assert.match(stable.said, /1\.10\.0 is available on stable/);
  assert.equal(chooseUpdate(manifest, { current: '1.2.0', channel: 'beta' }).entry.version, '2.0.0');
  assert.equal(chooseUpdate(manifest, { current: '1.10.0' }).entry, null);
  assert.match(chooseUpdate(manifest, { current: '1.10.0' }).said, /Nothing newer than 1\.10\.0 is listed for stable/);
  assert.match(chooseUpdate(manifest, { current: '3.0.0' }).said, /older than 3\.0\.0/);
  assert.match(chooseUpdate({ entries: [] }, { current: '1.0.0' }).said, /Nothing newer/);
});

test('the downloaded file must be the size and BLAKE3 the signed entry names', () => {
  assert.equal(checkArtifact(ARTIFACT, entry('1.0.0')), true);
  assert.throws(() => checkArtifact(Buffer.from('app byteX'), entry('1.0.0')), /does not match the size and hash/);
  assert.throws(() => checkArtifact(Buffer.from('app bytes!'), entry('1.0.0')), /does not match the size and hash/);
});
