// tools/paid-access/do-work/seal-a-paid-file.mjs
//
// tool:seal-a-paid-file: seals one of the person's files for sale. It reads the plaintext file, encrypts it with the
// person's paid-files key and a fresh nonce, writes the ciphertext to --out (the row keeps it in the person's files),
// and writes the file's `paid-file` record through the records door: its object key, the ciphertext's identity, the
// cipher, the nonce, the key's NAME and the access refs a buyer must hold. A buyer can then be given the file only
// through tool:give-a-buyer-a-paid-file-link and tool:open-a-paid-file-for-a-buyer.
//
//   node do-work/seal-a-paid-file.mjs --out <ciphertext path> --key-ref <the key's name>   < input.json
//   input: { file, object_key, required_access_refs, mime?, ttl_seconds?, object_store_ref? }
//
// The key is never in the request, argv, a file, a record or the answer: the person's held key reaches this one
// process on a private pipe, descriptor 4 (the row's invoke.credential_mounts), as 64 hex digits. The records door is
// on descriptor 3. The answer is the row (which names the key) and the ciphertext's size: never the key.
import { readFileSync, writeFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { encryptObjectFile } from '../read-data/encrypt-private-object.mjs';
import { PAID_FILE_TYPE } from '../read-data/resolve-private-delivery.ts';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';

const KEY_DESCRIPTOR = 4;
const words = value => typeof value === 'string' && value.trim() !== '';

/** The person's key from its private pipe, as 32 bytes; a refusal that says what to do otherwise. */
export function keyFromPipe(read = () => readFileSync(KEY_DESCRIPTOR, 'utf8')) {
  let hex = '';
  try { hex = String(read()).trim(); } catch { hex = ''; }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('No paid-files key was handed to this run. Keep a 32-byte key (64 hex digits) in your held values under the name this tool asks for, then seal again.');
  return Buffer.from(hex, 'hex');
}

function checked(input) {
  const problems = [];
  if (!words(input?.file)) problems.push('file must be one of your files (its identity, as find_file or list_files gives it)');
  if (!words(input?.object_key)) problems.push('object_key must name the file for buyers, like "chapter-one.pdf"');
  const refs = Array.isArray(input?.required_access_refs) ? input.required_access_refs.filter(words) : [];
  if (!refs.length) problems.push('required_access_refs must list at least one access ref a buyer must hold, like ["access:course-a"]; a file anyone may open is not a paid file');
  if (input?.ttl_seconds !== undefined && !(Number.isInteger(input.ttl_seconds) && input.ttl_seconds > 0)) problems.push('ttl_seconds must be a whole number of seconds above 0');
  if (problems.length) throw new Error(`${problems.join('; ')}.`);
  return refs;
}

/** Seal one file: read it, encrypt it, write the ciphertext and the `paid-file` record. */
export async function sealAPaidFile(input, { key, keyRef, out, door, fetchImpl = fetch }) {
  const refs = checked(input);
  const response = await fetchImpl(input.file);
  if (!response.ok) throw new Error(`Your file could not be read (${response.status}). Check the file identity and try again.`);
  const plaintext = new Uint8Array(await response.arrayBuffer());
  const { ciphertext, row } = encryptObjectFile(plaintext, key, {
    objectKey: input.object_key.trim(),
    objectStoreRef: words(input.object_store_ref) ? input.object_store_ref.trim() : 'object-store:paid-files',
    keyRef,
    requiredAccessRefs: [...new Set(refs.map(ref => ref.trim()))].sort(),
    mime: words(input.mime) ? input.mime.trim() : undefined,
    ttlSeconds: input.ttl_seconds,
  });
  row.cas_hash = makeHashCodeHexFromBytes(new Uint8Array(ciphertext));
  writeFileSync(out, ciphertext);
  await door.write([{ id: row.object_key, type: PAID_FILE_TYPE, value: row }], { key: `seal-a-paid-file:${row.object_key}:${row.cas_hash}` });
  return { row, sealed_bytes: ciphertext.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = name => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
  try {
    const out = flag('out');
    const keyRef = flag('key-ref');
    if (!words(out) || !words(keyRef)) throw new Error('usage: seal-a-paid-file.mjs --out <ciphertext path> --key-ref <key name> < input.json');
    const input = JSON.parse((await text(process.stdin)) || '{}');
    const key = keyFromPipe();
    console.log(JSON.stringify({ result: await sealAPaidFile(input, { key, keyRef, out, door: openRecordsDoor() }) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
