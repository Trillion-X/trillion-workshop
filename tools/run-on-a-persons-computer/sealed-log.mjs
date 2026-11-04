// computer/sealed-log.mjs
//
// PURPOSE
//   A local log that the computer can only write: every flushed batch is sealed to a reader's public key with a fresh
//   ephemeral key, then the ephemeral private key is dropped. Nothing on this Mac (another program of the same user, a
//   backup, a person who finds the file) can read the batch again; the holder of the reader's private key can read all of
//   them. A crash costs only the torn last chunk, which the next open cuts off, so appending across launches is safe.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: the magic, sizes, limits and words are computer/sealed-log.json; no log, key or reader is named here.
//   2. Per chunk: ephemeral X25519 key, HKDF-SHA256 of the shared secret salted with the ephemeral public key, AES-256-GCM
//      with the whole plain header as additional data (a changed header fails to open). Optionally deflated first.
//   3. A chunk is self-contained and its header says its length, so chunks are skipped, counted and a torn tail is found
//      without any key. Appending never rewrites earlier bytes.
//   4. The reader's private key is never in this file's writer path; the writer takes the public key only.
//
import { createCipheriv, createDecipheriv, createPublicKey, createPrivateKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const sealedSettings = () => JSON.parse(readFileSync(join(HERE, 'sealed-log.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (message, status = 400) => Object.assign(new Error(message), { status, retry: false });
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const FLAG_DEFLATED = 1;

const sizes = settings => ({ magic: Buffer.byteLength(settings.magic), key_id: 8, fixed: Buffer.byteLength(settings.magic) + 1 + 8 + 1 + 4 + 32 + 12 });

/** A reader's key pair as raw 32-byte buffers, made where the log will be read (never on the writing Mac). */
export function generateReaderKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32) };
}

const derive = (shared, salt, settings) => Buffer.from(hkdfSync('sha256', shared, salt, settings.kdf_info, 32));

/** One sealed chunk of `plaintext` for the reader whose raw public key is given; `keyId` names which reader key (8 bytes). */
export function sealChunk({ publicKey, keyId, plaintext, settings = sealedSettings() }) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) throw refusal(settings.words.bad_key);
  const body = Buffer.from(plaintext);
  if (body.length > settings.max_plaintext_bytes) throw refusal(fill(settings.words.too_big, { bytes: body.length, limit: settings.max_plaintext_bytes }));
  const deflated = body.length >= settings.deflate_over_bytes ? deflateRawSync(body) : null;
  const flags = deflated && deflated.length < body.length ? FLAG_DEFLATED : 0;
  const payload = flags ? deflated : body;
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = ephemeral.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, publicKey]), format: 'der', type: 'spki' }) });
  const nonce = randomBytes(12);
  const header = Buffer.concat([Buffer.from(settings.magic), Buffer.from([settings.version]), Buffer.from(keyId ?? Buffer.alloc(8)).subarray(0, 8), Buffer.from([flags]),
    Buffer.alloc(4), ephemeralPublic, nonce]);
  header.writeUInt32BE(payload.length + 16, Buffer.byteLength(settings.magic) + 1 + 8 + 1);
  const cipher = createCipheriv('aes-256-gcm', derive(shared, ephemeralPublic, settings), nonce);
  cipher.setAAD(header);
  const sealed = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, sealed]);
}

/** Where the chunks of `bytes` end, with no key: { chunks: [{ offset, length, keyId }], torn: bytes left after the last whole chunk }. */
export function scanChunks(bytes, settings = sealedSettings()) {
  const { fixed, magic } = sizes(settings);
  const chunks = [];
  let offset = 0;
  while (offset + fixed <= bytes.length) {
    if (bytes.subarray(offset, offset + magic).toString() !== settings.magic) throw refusal(fill(settings.words.not_a_chunk, { offset }));
    const length = bytes.readUInt32BE(offset + magic + 1 + 8 + 1);
    if (offset + fixed + length > bytes.length) break;
    chunks.push({ offset, length: fixed + length, key_id: bytes.subarray(offset + magic + 1, offset + magic + 9).toString('hex') });
    offset += fixed + length;
  }
  // A tail too short to be a header must still begin like one: bytes that are something else are not a torn chunk.
  const rest = bytes.subarray(offset, offset + magic);
  if (rest.length && rest.toString() !== settings.magic.slice(0, rest.length)) throw refusal(fill(settings.words.not_a_chunk, { offset }));
  return { chunks, torn: bytes.length - offset, end: offset };
}

/** Opens every whole chunk of `bytes` with the reader's raw private key; a torn tail is reported, never invented. */
export function openAll({ privateKey, bytes, settings = sealedSettings() }) {
  const { fixed } = sizes(settings);
  const { chunks, torn } = scanChunks(bytes, settings);
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privateKey]), format: 'der', type: 'pkcs8' });
  const batches = chunks.map(chunk => {
    const header = bytes.subarray(chunk.offset, chunk.offset + fixed);
    const ephemeralPublic = header.subarray(fixed - 12 - 32, fixed - 12), nonce = header.subarray(fixed - 12);
    const shared = diffieHellman({ privateKey: key, publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, ephemeralPublic]), format: 'der', type: 'spki' }) });
    const sealed = bytes.subarray(chunk.offset + fixed, chunk.offset + chunk.length);
    const decipher = createDecipheriv('aes-256-gcm', derive(shared, ephemeralPublic, settings), nonce);
    decipher.setAAD(header);
    decipher.setAuthTag(sealed.subarray(-16));
    let payload;
    try { payload = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]); } catch { throw refusal(settings.words.wrong_key, 403); }
    return (header[settings.magic.length + 1 + 8] & FLAG_DEFLATED) ? inflateRawSync(payload) : payload;
  });
  return { batches, torn };
}

/** The writer over a file: lines are buffered and sealed as one chunk when `flush_bytes` is reached or `flush()` is called.
 *  Opening cuts a torn last chunk off first, so the file holds only whole chunks. */
export function createSealedLog({ file, publicKey, keyId, settings = sealedSettings() }) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) throw refusal(settings.words.bad_key);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const descriptor = openSync(file, 'a+', parseInt(settings.file_mode, 8));
  const { end } = scanChunks(readFileSync(file), settings);
  if (end < statSync(file).size) ftruncateSync(descriptor, end);
  let pending = [], pendingBytes = 0;
  const flush = () => {
    if (!pending.length) return { written: 0 };
    const chunk = sealChunk({ publicKey, keyId, plaintext: Buffer.concat(pending), settings });
    writeSync(descriptor, chunk, 0, chunk.length, null);
    fsyncSync(descriptor);
    const lines = pending.length;
    pending = []; pendingBytes = 0;
    return { written: chunk.length, lines };
  };
  return {
    append(line) {
      const bytes = Buffer.from(String(line).endsWith('\n') ? String(line) : `${line}\n`);
      if (pendingBytes + bytes.length > settings.max_plaintext_bytes) flush();
      pending.push(bytes); pendingBytes += bytes.length;
      if (pendingBytes >= settings.flush_bytes) flush();
    },
    flush,
    close() { flush(); closeSync(descriptor); },
  };
}
