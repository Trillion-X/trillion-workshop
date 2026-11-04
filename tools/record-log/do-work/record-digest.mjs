// parts/record-log/do-work/record-digest.mjs
//
// AN ORDER-FREE CHECKSUM OF A WHOLE STORE, KEPT UP TO DATE ONE CHANGED FIELD AT A TIME.
//
// Purpose
//   Two copies of one person's records (the hosted store and a device's copy) are equal when their checksums are equal,
//   and where they differ the checksum says which of BUCKETS groups of records to compare. Each record field is hashed
//   with its record id (`id`, `field`, the field's JSON text), each record's kind with its id, and the hashes are added
//   into the record's bucket, two 32-bit lanes added separately. Addition does not care about order, so a field changed
//   costs: subtract its old hash, add its new one; nothing else is read or hashed again, and two copies that hold the
//   same fields agree however their writes arrived.
//
// Non-negotiable invariants
//   1. This is a checksum for comparing the person's own copies, never an identity, a signature or a security check:
//      a copy that wants to lie can. Content identities stay BLAKE3 where the system keys content.
//   2. The sum of a store is a function of what it holds now (ids, kinds, top-level fields and their JSON text), never
//      of the order fields were written in or of the time.
//   3. Buckets are a fixed count (BUCKETS); a record's bucket comes from its id alone.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export const BUCKETS = 256;
const MASK = BUCKETS - 1;

// Two 32-bit hashes of a text's UTF-16 code units, each finished with the murmur3 mix so every input bit reaches
// every output bit.
function fmix(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
export function textHash(text) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul((b ^ code) + ((b << 5) | 0), 0x5bd1e995);
  }
  return [fmix(a ^ text.length), fmix(b ^ Math.imul(text.length, 0x9e3779b1))];
}
export const bucketOf = id => textHash(id)[0] & MASK;
const KIND = '\u0000kind';
const fieldText = (id, field, value) => `${id}\u0000${field}\u0000${JSON.stringify(value)}`;
const STAMPS = '\u0000stamps';
const stampsText = (id, meta) => `${id}${STAMPS}\u0000${JSON.stringify(meta)}`;

/** The sums of one store: { add(id, type, value), remove(id, type, value), change(id, before, after, fields), ... }. */
export function storeSums(from = null) {
  const lanes = new Uint32Array(BUCKETS * 2);
  if (from) lanes.set(from);
  function apply(id, text, sign) {
    const [a, b] = textHash(text);
    const at = bucketOf(id) * 2;
    lanes[at] = (lanes[at] + sign * a) >>> 0;
    lanes[at + 1] = (lanes[at + 1] + sign * b) >>> 0;
  }
  const record = (id, type, value, sign) => {
    apply(id, `${id}${KIND}\u0000${type}`, sign);
    for (const field of Object.keys(value)) if (value[field] !== undefined) apply(id, fieldText(id, field, value[field]), sign);
  };
  return {
    lanes,
    add(id, type, value) { record(id, type, value, 1); },
    /** A record's stamps (record-stamps.mjs) moved from `before` to `after` (either null): two copies are equal only
     *  when they hold the same stamps too, since the stamps decide every later merge. */
    stamps(id, before, after) {
      if (before) apply(id, stampsText(id, before), -1);
      if (after) apply(id, stampsText(id, after), 1);
    },
    remove(id, type, value) { record(id, type, value, -1); },
    /** A record of the same kind changed: only `fields` (or every field of either side) are hashed again. */
    change(id, before, after, fields = null) {
      for (const field of fields ?? new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[field] !== undefined) apply(id, fieldText(id, field, before[field]), -1);
        if (after[field] !== undefined) apply(id, fieldText(id, field, after[field]), 1);
      }
    },
    /** The buckets, as text (hex, 16 characters a bucket), for keeping or sending. */
    text() { let out = ''; for (let at = 0; at < lanes.length; at += 1) out += lanes[at].toString(16).padStart(8, '0'); return out; },
    /** One checksum of every bucket: equal stores have equal roots. */
    root() { const [a, b] = textHash(this.text()); return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'); },
  };
}
/** Buckets as kept by text(), back into lanes. */
export function lanesFrom(text) {
  const lanes = new Uint32Array(BUCKETS * 2);
  for (let at = 0; at < lanes.length; at += 1) lanes[at] = Number.parseInt(text.slice(at * 8, at * 8 + 8), 16);
  return lanes;
}
/** The buckets two copies disagree on, from the text each gave. */
export function bucketsThatDiffer(mine, theirs) {
  const out = [];
  for (let bucket = 0; bucket < BUCKETS; bucket += 1) if (mine.slice(bucket * 16, bucket * 16 + 16) !== theirs.slice(bucket * 16, bucket * 16 + 16)) out.push(bucket);
  return out;
}
