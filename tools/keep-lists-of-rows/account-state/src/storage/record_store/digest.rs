// src/storage/record_store/digest.rs
//
// AN ORDER-FREE CHECKSUM OF A WHOLE STORE, KEPT UP TO DATE ONE CHANGED RECORD AT A TIME.
//
// Purpose
//   A one to one port of old trillion `parts/record-log/do-work/record-digest.mjs` (Trillion-X/trillion origin/main).
//   Two copies of one person's records are equal when their checksums are equal, and where they differ the checksum
//   says which of `BUCKETS` groups of records to compare. Each record field is hashed with its record id (`id`,
//   `field`, the field's JSON text), each record's kind with its id, and the hashes are added into the record's bucket,
//   two 32-bit lanes added separately. Addition does not care about order, so a changed record costs: subtract its old
//   hashes, add its new ones; nothing else is read or hashed again, and two copies that hold the same fields agree
//   however their writes arrived.
//
// Non-Negotiable Invariants
//   1. This is a checksum for comparing the person's own copies, never an identity, a signature or a security check:
//      a copy that wants to lie can. Content identities stay BLAKE3 where the system keys content.
//   2. The sum of a store is a function of what it holds now (ids, kinds, top-level fields and their JSON text, and
//      each record's stamps), never of the order fields were written in or of the time.
//   3. Buckets are a fixed count (`BUCKETS`); a record's bucket comes from its id alone.
//   4. Byte-identical with old trillion: the hash runs over UTF-16 code units exactly as `charCodeAt` reads them, the
//      JSON text is `JSON.stringify`'s (`json_text`: ECMA number text, the same escapes), and the bucket text and the
//      root are the same hex. `record_sync_tests.rs` holds roots the old implementation computed for the same rows.
//      One difference is named, not hidden: a nested object's members are written in key order here (serde_json keeps
//      a map sorted), where `JSON.stringify` keeps insertion order, so a field holding an object whose keys were not
//      inserted in sorted order hashes differently from old trillion. Top-level field order never matters (each field
//      is hashed on its own).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::Value;

/// How many buckets a store's checksum keeps (old trillion `BUCKETS`).
pub const BUCKETS: usize = 256;
const MASK: u32 = BUCKETS as u32 - 1;
/// Characters of one bucket in `Sums::text` (two lanes of 8 hex digits).
pub const BUCKET_CHARS: usize = 16;

// The murmur3 finish, so every input bit reaches every output bit.
fn fmix(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

/// Two 32-bit hashes of a text's UTF-16 code units (old trillion `textHash`).
pub fn text_hash(text: &str) -> [u32; 2] {
    let mut a: u32 = 0x811c_9dc5;
    let mut b: u32 = 0x9747_b28c;
    let mut length: u32 = 0;
    for code in text.encode_utf16() {
        let code = u32::from(code);
        a = (a ^ code).wrapping_mul(0x0100_0193);
        // JS: Math.imul((b ^ code) + ((b << 5) | 0), 0x5bd1e995): the sum is a double, ToInt32 inside imul wraps it.
        b = (b ^ code).wrapping_add(b << 5).wrapping_mul(0x5bd1_e995);
        length = length.wrapping_add(1);
    }
    [fmix(a ^ length), fmix(b ^ length.wrapping_mul(0x9e37_79b1))]
}

/// The bucket of a record id (old trillion `bucketOf`).
pub fn bucket_of(id: &str) -> usize {
    (text_hash(id)[0] & MASK) as usize
}

/// `JSON.stringify(value)` of a JSON value: ECMA number text (serde's float text differs, so a value holding a
/// non-integer number goes through `ecma_json`), the same string escapes as serde's writer for everything else.
pub fn json_text(value: &Value) -> String {
    fn has_float(value: &Value) -> bool {
        match value {
            Value::Number(number) => number.is_f64(),
            Value::Array(items) => items.iter().any(has_float),
            Value::Object(members) => members.values().any(has_float),
            _ => false,
        }
    }
    let plain = serde_json::to_string(value).unwrap_or_else(|_| "null".into());
    if !has_float(value) {
        return plain;
    }
    let limits = crate::ecma_json::Limits {
        input_bytes: crate::ecma_json::HARD_BYTES,
        output_bytes: crate::ecma_json::HARD_BYTES,
        depth: crate::ecma_json::HARD_DEPTH,
        nodes: crate::ecma_json::HARD_NODES,
        string_units: crate::ecma_json::HARD_BYTES,
        total_string_units: crate::ecma_json::HARD_BYTES,
        container_entries: crate::ecma_json::HARD_NODES,
        number_bytes: crate::ecma_json::HARD_NUMBER_BYTES,
    };
    crate::ecma_json::parse(plain.as_bytes(), limits)
        .and_then(|parsed| crate::ecma_json::stringify(&parsed, limits))
        .unwrap_or(plain)
}

/// `JSON.stringify` of a text (a JSON string literal).
pub fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

const KIND: &str = "\u{0}kind";
const STAMPS: &str = "\u{0}stamps";

fn field_text(id: &str, field: &str, value: &Value) -> String {
    format!("{id}\u{0}{field}\u{0}{}", json_text(value))
}

/// The sums of one store (old trillion `storeSums`): 256 buckets of two 32-bit lanes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sums {
    lanes: Vec<u32>,
}

impl Default for Sums {
    fn default() -> Self {
        Self { lanes: vec![0; BUCKETS * 2] }
    }
}

impl Sums {
    pub fn new() -> Self {
        Self::default()
    }

    /// Buckets as kept by `text`, back into lanes (old trillion `lanesFrom`). None for text that is not 4096 hex.
    pub fn from_text(text: &str) -> Option<Self> {
        if text.len() != BUCKETS * BUCKET_CHARS || !text.is_ascii() {
            return None;
        }
        let mut lanes = Vec::with_capacity(BUCKETS * 2);
        for at in 0..BUCKETS * 2 {
            lanes.push(u32::from_str_radix(&text[at * 8..at * 8 + 8], 16).ok()?);
        }
        Some(Self { lanes })
    }

    fn apply(&mut self, id: &str, text: &str, add: bool) {
        let [a, b] = text_hash(text);
        let at = bucket_of(id) * 2;
        if add {
            self.lanes[at] = self.lanes[at].wrapping_add(a);
            self.lanes[at + 1] = self.lanes[at + 1].wrapping_add(b);
        } else {
            self.lanes[at] = self.lanes[at].wrapping_sub(a);
            self.lanes[at + 1] = self.lanes[at + 1].wrapping_sub(b);
        }
    }

    fn record(&mut self, id: &str, kind: &str, value: &serde_json::Map<String, Value>, add: bool) {
        self.apply(id, &format!("{id}{KIND}\u{0}{kind}"), add);
        for (field, item) in value {
            self.apply(id, &field_text(id, field, item), add);
        }
    }

    /// A live record of kind `kind` and fields `value` is held.
    pub fn add(&mut self, id: &str, kind: &str, value: &serde_json::Map<String, Value>) {
        self.record(id, kind, value, true);
    }

    /// A live record is no longer held.
    pub fn remove(&mut self, id: &str, kind: &str, value: &serde_json::Map<String, Value>) {
        self.record(id, kind, value, false);
    }

    /// A record's stamps (`stamps.rs`, as their JSON text `Meta::text`) moved from `before` to `after` (either None):
    /// two copies are equal only when they hold the same stamps too, since the stamps decide every later merge.
    pub fn stamps(&mut self, id: &str, before: Option<&str>, after: Option<&str>) {
        if let Some(before) = before {
            self.apply(id, &format!("{id}{STAMPS}\u{0}{before}"), false);
        }
        if let Some(after) = after {
            self.apply(id, &format!("{id}{STAMPS}\u{0}{after}"), true);
        }
    }

    /// A record of the same kind changed: only `fields` are hashed again (old trillion `change`).
    pub fn change(&mut self, id: &str, before: &serde_json::Map<String, Value>, after: &serde_json::Map<String, Value>, fields: &[String]) {
        for field in fields {
            if let Some(item) = before.get(field) {
                self.apply(id, &field_text(id, field, item), false);
            }
            if let Some(item) = after.get(field) {
                self.apply(id, &field_text(id, field, item), true);
            }
        }
    }

    /// The buckets, as text (hex, 16 characters a bucket), for keeping or sending.
    pub fn text(&self) -> String {
        let mut out = String::with_capacity(BUCKETS * BUCKET_CHARS);
        for lane in &self.lanes {
            out.push_str(&format!("{lane:08x}"));
        }
        out
    }

    /// One checksum of every bucket: equal stores have equal roots.
    pub fn root(&self) -> String {
        root_of(&self.text())
    }
}

/// The root of a bucket text.
pub fn root_of(text: &str) -> String {
    let [a, b] = text_hash(text);
    format!("{a:08x}{b:08x}")
}

/// One bucket's text out of a whole bucket text ("" when the text is short).
pub fn bucket_text(buckets: &str, bucket: usize) -> &str {
    buckets.get(bucket * BUCKET_CHARS..bucket * BUCKET_CHARS + BUCKET_CHARS).unwrap_or("")
}

/// The buckets two copies disagree on, from the text each gave (old trillion `bucketsThatDiffer`).
pub fn buckets_that_differ(mine: &str, theirs: &str) -> Vec<usize> {
    (0..BUCKETS).filter(|bucket| bucket_text(mine, *bucket) != bucket_text(theirs, *bucket)).collect()
}
