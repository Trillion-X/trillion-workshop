// tools/paid-access/test/encrypt-private-object.test.ts
//
// The sealing cipher matches the door's seekable decryptor, and a sealed file's row names its key and never holds it.
// Ported from bitfield-packages packages/material-delivery tools/encrypt-private-object.test.ts (5 cases, 5 here).
// Changed: the known-answer plaintext is made up (the package's named a real book), and its ciphertext was computed
// by OpenSSL (`openssl enc -aes-256-ctr`, zero key and IV), an implementation independent of Node, which also
// reproduces the package's original vector byte for byte; the row case names the key; the last case proves a fresh
// nonce per file under the person's one key and no key in the row, where the package proved a fresh random key.
import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { encryptPrivateObjectCtr, buildObjectStoreRow, ENC_ALG, encryptObjectFile } from '../read-data/encrypt-private-object.mjs';

const KNOWN_PLAINTEXT = 'A made-up paid chapter for a test — sample bytes #42.';
const KNOWN_CIPHERTEXT_HEX =
  '9db5ad19c625a4fcdd68d275fbe000e43b6efa8fa23716dfc6119490e4bf16f8ba87a2bdd940180f6a3ea9b69a91e46c171323e9039404';

describe('encrypt-private-object — the sealing cipher matches the door decryptor', () => {
  it('produces the exact known-answer ciphertext (AES-256-CTR, 128-bit big-endian counter)', () => {
    const key = Buffer.alloc(32, 0);
    const nonce = Buffer.alloc(16, 0);
    const ct = encryptPrivateObjectCtr(Buffer.from(KNOWN_PLAINTEXT, 'utf8'), key, nonce);
    expect(ct.toString('hex')).toBe(KNOWN_CIPHERTEXT_HEX);
  });

  it('roundtrips: CTR encrypt then encrypt again recovers plaintext (stream cipher)', () => {
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(16, 3);
    const pt = Buffer.from('any private object bytes — book, audiobook, video', 'utf8');
    const ct = encryptPrivateObjectCtr(pt, key, nonce);
    expect(ct.equals(pt)).toBe(false);
    const back = encryptPrivateObjectCtr(ct, key, nonce); // CTR is symmetric
    expect(back.equals(pt)).toBe(true);
  });

  it('rejects wrong key/nonce sizes (fail closed)', () => {
    expect(() => encryptPrivateObjectCtr(Buffer.from('x'), Buffer.alloc(16), Buffer.alloc(16))).toThrow();
    expect(() => encryptPrivateObjectCtr(Buffer.from('x'), Buffer.alloc(32), Buffer.alloc(12))).toThrow();
  });

  it('builds a paid-file row with all delivery fields, the key NAME and empty cas_hash', () => {
    const row = buildObjectStoreRow({
      objectKey: 'chapter-one.pdf',
      objectStoreRef: 'object-store:paid-files',
      keyRef: 'paid-files-key',
      nonceHex: '00'.repeat(16),
      requiredAccessRefs: ['access:course-a'],
      mime: 'application/pdf',
      ttlSeconds: 3600,
    });
    expect(row).toEqual({
      object_key: 'chapter-one.pdf',
      object_store_ref: 'object-store:paid-files',
      cas_hash: '',
      enc_alg: ENC_ALG,
      enc_key_ref: 'paid-files-key',
      enc_nonce: '00'.repeat(16),
      required_access_refs: ['access:course-a'],
      mime: 'application/pdf',
      ttl_seconds: 3600,
    });
  });

  it('encryptObjectFile uses a fresh random nonce each call under one key, and the row never carries the key', () => {
    const pt = Buffer.from('bytes', 'utf8');
    const key = Buffer.alloc(32, 9);
    const a = encryptObjectFile(pt, key, { objectKey: 'k', objectStoreRef: 's', keyRef: 'paid-files-key', requiredAccessRefs: ['r'] });
    const b = encryptObjectFile(pt, key, { objectKey: 'k', objectStoreRef: 's', keyRef: 'paid-files-key', requiredAccessRefs: ['r'] });
    expect(a.row.enc_nonce).not.toBe(b.row.enc_nonce);
    expect(a.row.enc_nonce).toHaveLength(32);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(JSON.stringify(a.row)).not.toContain(key.toString('hex'));
    expect(a.row).not.toHaveProperty('enc_key');
    expect(encryptPrivateObjectCtr(a.ciphertext, key, Buffer.from(a.row.enc_nonce, 'hex')).equals(pt)).toBe(true);
  });
});
