//! Real-data seeding from a CLONE of the restored account (never the live
//! account, never the pristine tree). The caller clones selected objects
//! with the existing owner (`cloneRestoreFile` in
//! trillion-cloudflare-stop/scripts/local-restore-clone.mjs) into a scratch
//! directory and passes that directory here.
//!
//! Each `*.sqlite` that carries a record-log projection (`record_keys_runs`)
//! is opened read-only and immutable. Current records are the `i\0<id>` keys
//! of its kept runs, selected through the existing `kept_runs` winner rules
//! (newest run wins, tombstones hide). Both projection layouts are accepted:
//! the original `[type, sequence, value, meta]` array and the Rust
//! `{kind, sequence, fields:[[k,v]..], meta}` object. Only values that are
//! JSON objects become seed records. Record ids, timestamps and file paths
//! never enter the result; only counts, kinds and sizes do. The first
//! `limit` records become seed records; EVERY current record of every file
//! enters the profile: per kind, the record count and the value-size
//! distribution (mean, p50, p90, p99, max bytes of the JSON fields), which
//! workload DATA cites for its shapes (`--seed-limit 0` = profile only).

use local_engine::kept_runs::{KeptRuns, Range, ReadBudget, Settings};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};
use workload_simulation::{report::SeedSource, SeedRecord, SimError};

const PAGE: usize = 256;
/// kept_runs' upper bound for `cache_bytes` (128 MiB).
const CURSOR_WORKSPACE: usize = 128 * 1024 * 1024;

fn decode(value: &Value) -> Option<(String, Map<String, Value>)> {
    match value {
        Value::Array(a) => {
            let kind = a.first()?.as_str()?.to_owned();
            let fields = a.get(2)?.as_object()?.clone();
            Some((kind, fields))
        }
        Value::Object(o) => {
            let kind = o.get("kind")?.as_str()?.to_owned();
            let fields = o
                .get("fields")?
                .as_array()?
                .iter()
                .filter_map(|p| Some((p.get(0)?.as_str()?.to_owned(), p.get(1)?.clone())))
                .collect();
            Some((kind, fields))
        }
        _ => None,
    }
}

pub fn load(dir: &Path, limit: usize) -> Result<(Vec<SeedRecord>, SeedSource), SimError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "sqlite"))
        .collect();
    files.sort();
    let mut out = Vec::new();
    let mut per_file = Vec::new();
    let mut sizes: BTreeMap<String, Vec<u64>> = BTreeMap::new();
    for file in &files {
        let uri = format!("file:{}?immutable=1", file.display());
        let db = Connection::open_with_flags(
            uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| SimError::Data(format!("{}: {e}", file.display())))?;
        let has_runs: bool = db
            .query_row(
                "SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'record_keys_runs'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| SimError::Data(e.to_string()))?;
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !has_runs {
            per_file.push(json!({"file": name, "skipped": "no record_keys_runs table"}));
            continue;
        }
        // A clone of a busy store holds dozens of runs; the range cursors
        // need the largest workspace the kept-runs bounds allow.
        let settings = Settings {
            cache_bytes: CURSOR_WORKSPACE,
            ..Settings::default()
        };
        let mut keys = KeptRuns::open(&db, "record_keys", settings)
            .map_err(|e| SimError::Data(format!("{name}: kept runs refused: {e}")))?;
        let (mut profiled, mut seeded, mut not_object) = (0u64, 0u64, 0u64);
        let mut after: Option<String> = None;
        loop {
            let budget = ReadBudget {
                elapsed: Duration::from_secs(60),
                ..ReadBudget::default()
            };
            let page = keys
                .range(
                    &db,
                    Range {
                        lo: "i\u{0}",
                        hi: "i\u{1}",
                        after: after.as_deref(),
                        reverse: false,
                        limit: PAGE,
                    },
                    budget,
                )
                .map_err(|e| SimError::Data(format!("{name}: range refused: {e}")))?;
            for (_, value) in &page.entries {
                let Some((kind, fields)) = decode(value) else {
                    not_object += 1;
                    continue;
                };
                let size = serde_json::to_vec(&fields)
                    .map(|v| v.len() as u64)
                    .unwrap_or(0);
                sizes.entry(kind.clone()).or_default().push(size);
                profiled += 1;
                if out.len() < limit {
                    out.push(SeedRecord {
                        kind,
                        value: fields,
                    });
                    seeded += 1;
                }
            }
            if page.complete || page.next.is_none() {
                break;
            }
            after = page.next;
        }
        per_file.push(json!({
            "file": name,
            "records": profiled,
            "seeded": seeded,
            "not_object_values": not_object,
        }));
    }
    let bytes: u64 = sizes.values().flatten().sum();
    let kinds: BTreeMap<String, Value> = sizes
        .into_iter()
        .map(|(kind, mut v)| {
            v.sort_unstable();
            let at = |q: f64| v[((q * v.len() as f64).ceil() as usize).clamp(1, v.len()) - 1];
            let total: u64 = v.iter().sum();
            let row = json!({
                "records": v.len(),
                "value_bytes": {
                    "mean": total / v.len() as u64,
                    "p50": at(0.50),
                    "p90": at(0.90),
                    "p99": at(0.99),
                    "max": v[v.len() - 1],
                },
            });
            (kind, row)
        })
        .collect();
    let source = SeedSource {
        kind: "restored-copy-clone".into(),
        records: out.len() as u64,
        detail: json!({
            "files": per_file,
            "record_value_bytes": bytes,
            "kinds": kinds,
            "limit": limit,
        }),
    };
    Ok((out, source))
}
