// tools/paid-access/read-data/encrypt-private-object.mjs
//
// Seals a plaintext private file (a book PDF, an audiobook, any file) into the ciphertext that is kept in the
// person's files, plus the `paid-file` row the delivery tools read.
//
// The cipher is AES-256-CTR, byte-for-byte the shell's seekable decryptor (`ctr::Ctr128BE<Aes256>`), proven by the
// shared known-answer vector in this folder's test. Node CTR uses the 16-byte IV as a 128-bit big-endian counter,
// exactly matching Ctr128BE.
//
// Ported from bitfield-packages packages/material-delivery tools/encrypt-private-object.mjs. The cipher function is
// unchanged. Changed: the package made a fresh random key per file and wrote the key into the row (`enc_key`). Here
// the key is the person's own held value, handed in by the caller (a run gets it on a private pipe), and the row
// carries only its NAME (`enc_key_ref`). A fresh random nonce per file keeps one key safe across many files: each
// file's counter starts at an independent random 128-bit point. The file's CLI is replaced by
// do-work/seal-a-paid-file.mjs, which never prints the key.

import { createCipheriv, randomBytes } from 'node:crypto';

export const ENC_ALG = 'aes-256-ctr';

/**
 * Encrypt plaintext bytes with AES-256-CTR. Pure given (plaintext, key, nonce).
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} key   32 bytes
 * @param {Uint8Array} nonce 16 bytes (initial CTR counter)
 * @returns {Buffer} ciphertext (same length as plaintext)
 */
export function encryptPrivateObjectCtr(plaintext, key, nonce) {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  if (nonce.length !== 16) throw new Error('nonce must be 16 bytes');
  const cipher = createCipheriv(ENC_ALG, Buffer.from(key), Buffer.from(nonce));
  return Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
}

/**
 * Build the `paid-file` row for an encrypted object. It names the key (`keyRef`), never holds it. `cas_hash` is the
 * ciphertext's identity, or empty when the caller fills it later.
 */
export function buildObjectStoreRow({ objectKey, objectStoreRef, keyRef, nonceHex, requiredAccessRefs, mime, ttlSeconds, casHash }) {
  return {
    object_key: objectKey,
    object_store_ref: objectStoreRef,
    cas_hash: casHash ?? '',
    enc_alg: ENC_ALG,
    enc_key_ref: keyRef,
    enc_nonce: nonceHex,
    required_access_refs: requiredAccessRefs,
    ...(mime ? { mime } : {}),
    ...(ttlSeconds ? { ttl_seconds: ttlSeconds } : {}),
  };
}

/** Encrypt a file with the person's key and a fresh random nonce; returns ciphertext + the row (no key in it). */
export function encryptObjectFile(plaintext, key, { objectKey, objectStoreRef, keyRef, requiredAccessRefs, mime, ttlSeconds }) {
  const nonce = randomBytes(16);
  const ciphertext = encryptPrivateObjectCtr(plaintext, key, nonce);
  const row = buildObjectStoreRow({
    objectKey,
    objectStoreRef,
    keyRef,
    nonceHex: nonce.toString('hex'),
    requiredAccessRefs,
    mime,
    ttlSeconds,
  });
  return { ciphertext, row };
}
