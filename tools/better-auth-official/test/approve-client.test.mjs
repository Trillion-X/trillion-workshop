// tools/better-auth-official/test/approve-client.test.mjs
//
// /approve's root signature: a fingerprint that does not depend on key order, a challenge that binds the chain position, the
// signature object a passkey's assertion makes, and the plain words for a change. The authenticator here is a held ES256 key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { base64url, canonical, challengeOf, changeOf, firstRoot, fingerprintOf, fromBase64url, signRoot } from '../pages/approve-client.mjs';
import { verifyRootSignature } from '../test-fixtures/root-signature-verify.mjs';
import words from '../pages/words.json' with { type: 'json' };
import approveRules from '../pages/approve.json' with { type: 'json' };

const origin = 'https://app.example.test';
const rpId = 'app.example.test';

// An authenticator that holds one ES256 passkey and signs as the WebAuthn assertion says (flags: user present and verified).
const asked = [];
function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cbor = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')]);
  const rawId = randomBytes(16);
  const credentialID = base64url(rawId);
  const passkeys = [{ credentialID, publicKey: cbor.toString('base64') }];
  const credentials = {
    async get({ publicKey: options }) {
      assert.equal(options.userVerification, 'required');
      assert.equal(options.rpId, rpId);
      assert.equal(options.challenge.length, 32, 'the challenge is 32 bytes, longer than the 16 the spec asks for');
      asked.push(options);
      const authenticatorData = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: base64url(options.challenge), origin, crossOrigin: false }));
      const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), { key: privateKey, dsaEncoding: 'der' });
      return { rawId: rawId.buffer.slice(rawId.byteOffset, rawId.byteOffset + rawId.length), response: { authenticatorData, clientDataJSON, signature } };
    },
  };
  return { passkeys, credentials };
}

const rootOne = firstRoot({ host: 'app.example.test', issuer: origin });
const rootTwo = { ...rootOne, computers: [{ kind: 'computer', name: 'Desk Mac' }] };

test('a root\'s fingerprint is the BLAKE3 of its canonical bytes, whatever order its keys were written in', () => {
  assert.equal(canonical({ b: [2, { d: 1, c: null }], a: 'x' }), '{"a":"x","b":[2,{"c":null,"d":1}]}');
  assert.equal(fingerprintOf({ a: 1, b: 2 }), fingerprintOf({ b: 2, a: 1 }));
  assert.match(fingerprintOf(rootOne), /^[0-9a-f]{64}$/);
  assert.notEqual(fingerprintOf(rootOne), fingerprintOf(rootTwo));
  assert.throws(() => canonical({ a: undefined }), /JSON values/);
});

test('the passkey signs a statement that binds the chain position, so one signature is not good for another position', () => {
  const fingerprint = fingerprintOf(rootOne);
  const here = challengeOf({ fingerprint, previous: null, signed_at: 1 });
  assert.equal(here.length, 32);
  assert.notDeepEqual(here, challengeOf({ fingerprint, previous: fingerprintOf(rootTwo), signed_at: 1 }));
  assert.notDeepEqual(here, challengeOf({ fingerprint, previous: null, signed_at: 2 }));
  assert.notDeepEqual(here, fromBase64url(base64url(Buffer.from(fingerprint, 'hex'))), 'not the bare fingerprint, which anyone holding one signature could replay');
});

test('the signature object a passkey makes verifies for its root, its RP ID and its origin, and for nothing else', async () => {
  const { passkeys, credentials } = authenticator();
  const signature = await signRoot({ root: rootOne, previous: null, issuer: origin, sub: 'user-1', rpId, passkeys, credentials, now: 1763350000000 });
  assert.deepEqual(Object.keys(signature), ['fingerprint', 'previous', 'signed_at', 'signer', 'assertion']);
  assert.deepEqual(Object.keys(signature.signer), ['issuer', 'sub', 'credential_id', 'public_key_cose']);
  assert.deepEqual(Object.keys(signature.assertion), ['authenticatorData', 'clientDataJSON', 'signature']);
  assert.equal(signature.previous, null);
  assert.equal(signature.signed_at, 1763350000000);
  assert.equal(signature.signer.credential_id, passkeys[0].credentialID);
  verifyRootSignature(signature, rootOne, { rpId, origin });
  assert.throws(() => verifyRootSignature(signature, rootTwo, { rpId, origin }), /fingerprint/);
  assert.throws(() => verifyRootSignature({ ...signature, previous: fingerprintOf(rootTwo) }, rootOne, { rpId, origin }), /challenge/);
  assert.throws(() => verifyRootSignature({ ...signature, signed_at: signature.signed_at + 1 }, rootOne, { rpId, origin }), /challenge/);
  assert.throws(() => verifyRootSignature(signature, rootOne, { rpId: 'other.example.test', origin }), /RP ID/);
  assert.throws(() => verifyRootSignature(signature, rootOne, { rpId, origin: 'https://other.example.test' }), /issuer/);
  const forged = { ...signature, assertion: { ...signature.assertion, signature: base64url(Buffer.alloc(70, 1)) } };
  assert.throws(() => verifyRootSignature(forged, rootOne, { rpId, origin }));
});

test('a second root chains to the first by its fingerprint', async () => {
  const { passkeys, credentials } = authenticator();
  const first = await signRoot({ root: rootOne, previous: null, issuer: origin, sub: 'u', rpId, passkeys, credentials });
  const second = await signRoot({ root: rootTwo, previous: first.fingerprint, issuer: origin, sub: 'u', rpId, passkeys, credentials });
  verifyRootSignature(second, rootTwo, { rpId, origin });
  assert.equal(second.previous, first.fingerprint);
});

test('a passkey the person does not hold is refused', async () => {
  const mine = authenticator(), other = authenticator();
  await assert.rejects(signRoot({ root: rootOne, previous: null, issuer: origin, sub: 'u', rpId, passkeys: mine.passkeys, credentials: other.credentials }), /not one of the person/);
  assert.deepEqual(asked.at(-1).allowCredentials.map(({ id }) => base64url(id)), mine.passkeys.map(({ credentialID }) => credentialID), 'only the person\'s own passkeys are offered');
});

test('a change is said in plain words from the rows it adds and removes, with no kind of row named in the code', () => {
  const rules = { kinds: words.kinds, summaryFields: approveRules.summary_fields };
  assert.deepEqual(changeOf(null, rootOne, rules), [
    { verb: 'adds', kind: 'a way in', name: 'app.example.test' },
    { verb: 'adds', kind: 'a place you sign in', name: origin },
  ]);
  assert.deepEqual(changeOf(rootOne, rootTwo, rules), [{ verb: 'adds', kind: 'a computer', name: 'Desk Mac' }]);
  assert.deepEqual(changeOf(rootTwo, rootOne, rules), [{ verb: 'removes', kind: 'a computer', name: 'Desk Mac' }]);
  assert.deepEqual(changeOf(rootOne, rootOne, rules), []);
  assert.deepEqual(changeOf(null, { x: [{ kind: 'unheard-of', id: 7 }] }, rules), [{ verb: 'adds', kind: 'unheard-of', name: '7' }], 'a kind with no words is shown as itself');
});
