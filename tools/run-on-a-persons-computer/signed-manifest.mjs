// computer/signed-manifest.mjs
//
// PURPOSE
//   The trust step for anything this Mac downloads from a list that somebody publishes (an app update, a helper, a model):
//   the list must carry a detached Ed25519 signature from a publisher the Mac trusts, the newest entry for the channel is
//   chosen without ever going backwards, and the file fetched must hash (BLAKE3) and measure as the signed list says.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: publishers, channels and every sentence are computer/signed-manifest.json; this file names none.
//   2. Fail closed: no trusted keys, no signature, a signature no trusted live key verifies, or text that is not JSON means
//      the list is not used. Nothing is chosen from an unverified list.
//   3. The signature covers the exact bytes of the list; the list is parsed only after it verifies.
//   4. A newer version is chosen only if it is strictly newer than the running one (numeric dot-separated comparison).
//
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../content-identity/read-data/identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const manifestSettings = () => JSON.parse(readFileSync(join(HERE, 'signed-manifest.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (message, status = 403) => Object.assign(new Error(message), { status, retry: false });
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** -1, 0 or 1 comparing dot-separated numeric versions; a missing part is 0. */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    const difference = (left[at] || 0) - (right[at] || 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** The parsed manifest when a live trusted key verifies `text` (string or bytes) against `signature` (base64); a refusal otherwise. */
export function verifyManifest({ text, signature, settings = manifestSettings(), now = () => Date.now() }) {
  const live = settings.keys.filter(key => !key.retired_at || Date.parse(key.retired_at) > now());
  if (!live.length) throw refusal(settings.words.no_keys);
  if (typeof signature !== 'string' || !signature) throw refusal(settings.words.unsigned);
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(typeof text === 'string' ? text : new Uint8Array(text));
  const sig = Buffer.from(signature, 'base64');
  const ok = live.some(key => {
    try {
      const raw = Buffer.from(key.public_key, 'base64');
      return raw.length === 32 && verify(null, bytes, createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' }), sig);
    } catch { return false; }
  });
  if (!ok) throw refusal(settings.words.bad_signature);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw refusal(settings.words.not_json, 422); }
}

/** The newest entry of the channel that is strictly newer than `current`, or null with the reason. */
export function chooseUpdate(manifest, { current, channel, settings = manifestSettings() }) {
  const wanted = channel ?? settings.default_channel;
  const entries = (manifest.entries ?? []).filter(entry => (entry.channel ?? settings.default_channel) === wanted);
  const newest = entries.reduce((best, entry) => (!best || compareVersions(entry.version, best.version) > 0 ? entry : best), null);
  if (!newest) return { entry: null, said: fill(settings.words.no_newer, { current, channel: wanted }) };
  const order = compareVersions(newest.version, current);
  if (order < 0) return { entry: null, said: fill(settings.words.downgrade, { version: newest.version, current }) };
  if (order === 0) return { entry: null, said: fill(settings.words.no_newer, { current, channel: wanted }) };
  return { entry: newest, said: fill(settings.words.chosen, { version: newest.version, channel: wanted }) };
}

/** Whether downloaded bytes are the artifact the signed entry names (size and BLAKE3). Throws a refusal when not. */
export function checkArtifact(bytes, entry, settings = manifestSettings()) {
  if (bytes.length !== entry.size || makeHashCodeHexFromBytes(bytes).slice(3) !== entry.blake3) throw refusal(settings.words.wrong_artifact);
  return true;
}
