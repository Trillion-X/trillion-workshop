// tools/tell-a-repeated-capture-from-a-new-one/read-data/capture-dedupe.mjs (moved from Trillion computer/capture-dedupe.mjs)
//
// Purpose
//   A two-tier memory in front of upload for repeated captures (screen text, transcripts): an exact tier (BLAKE3 of the
//   normalised text) and a near tier (64-bit SimHash, Hamming distance), bounded in size and time, and erasable by
//   time span so that erasing a capture also erases the memory that would have hidden a later one.
//
// Non-negotiable invariants
//   1. Normalisation, shingle size, distance, limits and age are DATA (capture-dedupe.json).
//   2. The exact tier is checked first; the near tier only for texts of at least `least_words_for_near` words, since short
//      texts differ by one word and are different things.
//   3. A text that is new is remembered with the time it was first seen; `erase(from, to)` forgets every entry first seen in
//      the span, in both tiers, and nothing else.
//   4. Hashes are BLAKE3 (identity) and a SimHash made from BLAKE3 words; no SHA-256.
//   5. The memory is the caller's: it comes in as `entries` and goes back out as `entries`; nothing is written here.
//
// USAGE
//   node /opt/records-door/do-work/run-an-export.mjs /opt/tell-a-repeated-capture-from-a-new-one/read-data/capture-dedupe.mjs dedupe
//
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

/** BLAKE3-256 of the bytes as 64 hex digits, from the one content-identity owner (its `1f:` prefix dropped). */
const blake3Hex = bytes => makeHashCodeHexFromBytes(bytes).slice(3);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const dedupeSettings = () => JSON.parse(readFileSync(path.join(HERE, 'capture-dedupe.json'), 'utf8'));

export function normalise(text, settings = dedupeSettings()) {
  let out = String(text ?? '');
  if (settings.normalize.lowercase) out = out.toLowerCase();
  if (settings.normalize.strip_digits) out = out.replace(/\d+/g, '#');
  if (settings.normalize.collapse_whitespace) out = out.replace(/\s+/g, ' ');
  return out.trim();
}
export const exactOf = (text, settings = dedupeSettings()) => blake3Hex(new TextEncoder().encode(normalise(text, settings))).slice(0, 32);

/** The 64-bit SimHash of a text as a BigInt: each word group votes on each bit through its BLAKE3 word. */
export function simhash(text, settings = dedupeSettings()) {
  const words = normalise(text, settings).split(' ').filter(Boolean);
  const size = Math.min(settings.shingle_words, Math.max(1, words.length));
  const votes = new Array(64).fill(0);
  for (let i = 0; i + size <= words.length; i += 1) {
    const hash = BigInt(`0x${blake3Hex(new TextEncoder().encode(words.slice(i, i + size).join(' '))).slice(0, 16)}`);
    for (let bit = 0; bit < 64; bit += 1) votes[bit] += (hash >> BigInt(bit)) & 1n ? 1 : -1;
  }
  return votes.reduce((value, vote, bit) => (vote > 0 ? value | (1n << BigInt(bit)) : value), 0n);
}
export const distance = (a, b) => { let x = a ^ b; let count = 0; while (x) { count += Number(x & 1n); x >>= 1n; } return count; };

/** The memory: seen(text, at) -> { duplicate: false } | { duplicate: 'exact' | 'near', of }; erase(from, to) -> how many entries were forgotten. */
export function createDedupe(settings = dedupeSettings(), start = []) {
  let entries = start.map(entry => ({ ...entry, near: entry.near === null ? null : BigInt(`0x${entry.near}`) }));
  const prune = at => { entries = entries.filter(entry => at - entry.at <= settings.remember_seconds * 1000).slice(-settings.most_entries); };
  return {
    seen(text, at) {
      prune(at);
      const exact = exactOf(text, settings);
      const found = entries.find(entry => entry.exact === exact);
      if (found) return { duplicate: 'exact', of: found.exact };
      const words = normalise(text, settings).split(' ').filter(Boolean).length;
      const near = words >= settings.least_words_for_near ? simhash(text, settings) : null;
      const close = near === null ? null : entries.find(entry => entry.near !== null && distance(entry.near, near) <= settings.near_bits);
      if (close) return { duplicate: 'near', of: close.exact };
      entries.push({ exact, near, at });
      entries = entries.slice(-settings.most_entries);
      return { duplicate: false };
    },
    erase(from, to) { const before = entries.length; entries = entries.filter(entry => entry.at < from || entry.at > to); return before - entries.length; },
    size: () => entries.length,
    /** The memory as plain JSON, to keep between runs. */
    entries: () => entries.map(entry => ({ ...entry, near: entry.near === null ? null : entry.near.toString(16) })),
  };
}

export const dedupeTools = {
  /** { action: seen | erase, text?, at?, from?, to?, entries? } -> { duplicate, of } or { forgotten }, with the memory as `entries` to give back next run. */
  async dedupe(input) {
    const settings = dedupeSettings();
    const start = Array.isArray(input.entries) ? input.entries : [];
    const memory = createDedupe(settings, start);
    const answer = input.action === 'erase' ? { forgotten: memory.erase(Date.parse(input.from), Date.parse(input.to)) } : memory.seen(input.text, input.at ? Date.parse(input.at) : Date.now());
    return { ...answer, entries: memory.entries() };
  },
};

/** The tool-table entry as a named function, for run-an-export.mjs. */
export const { dedupe } = dedupeTools;
