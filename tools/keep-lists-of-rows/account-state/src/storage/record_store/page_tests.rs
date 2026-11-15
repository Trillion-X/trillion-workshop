// src/storage/record_store/page_tests.rs
//
// Purpose: Lane (d) of the storage audit (2026-11-03): measure the record-size distribution of a synthetic copy of an
// account's own records and the bytes on disk per 100,000 records at SQLite's 4 KiB page and at the page size the
// shipped settings choose (`settings.json` `page_bytes`). In a WITHOUT ROWID table a record keeps at most about a
// quarter of a page in its leaf ((page - 12) * 64 / 255 - 23 bytes: 1,002 at 4 KiB) and spills the rest to overflow
// pages of its own, so at 4 KiB every record above about 1 KB takes a fresh, mostly empty 4 KiB overflow page.
//
// The synthetic copy: record values whose JSON size is log-normal with the mean measured on the October 27, 2026 clone
// of the account (4.19 GB of stored forms over 2,404,438 records: 1,742 bytes; src/storage/record_store/README.md), median
// about 1.2 KB, capped at 64 KiB; kind `record:library`, text in a `text` field, written by `import` in pages of 1,000.
// No account data is read.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{settings, RecordStore, RealClock};
use crate::{
    sqlite_work::WorkMeter,
    storage::{record_store::settings::Limits, sqlite, Storage},
};
use serde_json::{json, Value};

/// The mean stored form of the measured clone, and the spread of the synthetic copy's log-normal sizes.
const MEAN_BYTES: f64 = 1742.0;
const SIGMA: f64 = 0.85;

/// A small deterministic generator (xorshift64*), so every run measures the same copy.
struct Draw(u64);
impl Draw {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
    /// One size from the log-normal whose mean is `MEAN_BYTES` (Box-Muller).
    fn size(&mut self) -> usize {
        let mu = MEAN_BYTES.ln() - SIGMA * SIGMA / 2.0;
        let (a, b) = (self.next().max(f64::MIN_POSITIVE), self.next());
        let normal = (-2.0 * a.ln()).sqrt() * (2.0 * std::f64::consts::PI * b).cos();
        ((mu + SIGMA * normal).exp() as usize).clamp(64, 64 * 1024)
    }
}

/// The synthetic copy's values: `count` records, each of about its drawn size as JSON.
fn copy(count: usize) -> Vec<(String, Value)> {
    let mut draw = Draw(0x9E37_79B9_7F4A_7C15);
    let words = ["transcript", "line", "said", "the", "and", "library", "note", "a", "of", "to"];
    (0..count)
        .map(|at| {
            let size = draw.size();
            let mut text = String::with_capacity(size);
            let mut word = at;
            while text.len() + 48 < size {
                text.push_str(words[word % words.len()]);
                text.push(' ');
                word = word.wrapping_mul(31).wrapping_add(7);
            }
            // The native seam's shape (src/storage/record_store/native.rs): the stored form as exact JSON text under `stored`,
            // so no declared search field is read, as for the account's own records.
            let stored = json!({"id": format!("transcript-{at:08}"), "type": "record:library", "value": {"line": text}}).to_string();
            (format!("transcript-{at:08}"), json!({"kind": "record:library", "stored": stored}))
        })
        .collect()
}

/// Bytes on disk of a fresh store holding `records`, made with `page_bytes` (None: SQLite's own 4 KiB).
fn bytes_on_disk(records: &[(String, Value)], page_bytes: Option<u32>) -> u64 {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("copy.sqlite");
    let supply = sqlite::open_owned_observed_paged(&path, "record_store", crate::storage::record_store_resources::bounds(), WorkMeter::new(), page_bytes).unwrap();
    let mut store = RecordStore::new(supply, Box::new(RealClock), Limits::fixed(1 << 20, 1 << 40)).unwrap();
    for page in records.chunks(1000) {
        store.import("account", "notes", page).unwrap();
    }
    store.storage().allocated_bytes().unwrap()
}

/// The size of each record's stored value (its JSON), sorted.
fn sizes(records: &[(String, Value)]) -> Vec<usize> {
    let mut sizes: Vec<usize> = records.iter().map(|(_, value)| serde_json::to_vec(value).unwrap().len()).collect();
    sizes.sort_unstable();
    sizes
}

fn measure(count: usize) -> (Vec<usize>, u64, u64, u32) {
    let records = copy(count);
    let chosen = settings::shipped().unwrap().page_bytes;
    let before = bytes_on_disk(&records, None);
    for other in [4096, 8192, 16384, 32768, 65536] {
        let (empty, one) = (bytes_on_disk(&[], Some(other)), bytes_on_disk(&records[..1], Some(other)));
        eprintln!("page-waste: {count} records at {other} B pages: {} bytes; an empty store {empty}, one record {one}", bytes_on_disk(&records, Some(other)));
    }
    (sizes(&records), before, bytes_on_disk(&records, Some(chosen)), chosen)
}

fn report(count: usize, sizes: &[usize], before: u64, after: u64, chosen: u32) {
    let at = |share: f64| sizes[((sizes.len() - 1) as f64 * share) as usize];
    let mean = sizes.iter().sum::<usize>() as f64 / sizes.len() as f64;
    let over = |limit: usize| sizes.iter().filter(|size| **size > limit).count() as f64 * 100.0 / sizes.len() as f64;
    let local = |page: usize| (page - 12) * 64 / 255 - 23;
    let per = |bytes: u64| bytes as f64 * 100_000.0 / count as f64;
    eprintln!(
        "page-waste: {count} synthetic records; value bytes p10 {} p50 {} p90 {} p99 {} max {} mean {mean:.0}; \
         over the 4 KiB leaf share ({} B): {:.1}%, over the {chosen} B leaf share ({} B): {:.1}%",
        at(0.10), at(0.50), at(0.90), at(0.99), at(1.0), local(4096), over(local(4096)), local(chosen as usize), over(local(chosen as usize)),
    );
    eprintln!(
        "page-waste: bytes on disk per 100,000 records: 4096 B pages {:.0} ({:.1} MB), {chosen} B pages {:.0} ({:.1} MB); \
         {:.1}% less; raw values {:.1} MB",
        per(before), per(before) / 1e6, per(after), per(after) / 1e6, (1.0 - after as f64 / before as f64) * 100.0,
        sizes.iter().sum::<usize>() as f64 * 100_000.0 / count as f64 / 1e6,
    );
}

/// The shipped page size keeps a synthetic copy's 1-2 KB records in their leaves: fewer bytes on disk than 4 KiB pages.
#[test]
fn the_shipped_page_size_stores_a_synthetic_copy_in_fewer_bytes_than_4_kib_pages() {
    let count = 10_000;
    let (sizes, before, after, chosen) = measure(count);
    report(count, &sizes, before, after, chosen);
    assert!(after * 10 < before * 9, "the chosen page size saves at least 10%: {after} vs {before}");
}

/// The full measurement for the report: 100,000 records. `cargo test --lib page_waste_per_100k -- --ignored --nocapture`.
#[test]
#[ignore = "a measurement of 100,000 records for the storage audit's report"]
fn page_waste_per_100k() {
    let count = 100_000;
    let (sizes, before, after, chosen) = measure(count);
    report(count, &sizes, before, after, chosen);
}
