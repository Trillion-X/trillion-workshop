//! Search-variant and receipt-growth report over a storage-sim run root.
//!
//! Usage: `search-receipt-report <run-root> [<out.md>]`, where `<run-root>`
//! holds one folder per candidate, each with `runs/<candidate>--<workload>.json`
//! (the layout of `--out <run-root>/<candidate>`). Every number is read from
//! the runs' JSON; per-operation figures divide by (acked + failed), as
//! `table.txt` does.

use serde_json::Value;
use std::{collections::BTreeMap, fs, path::Path, process::ExitCode};

const MODEL: &str = "cloudflare-do-sqlite";
const WRITES: [&str; 3] = ["table_rows_written", "index_entries_written", "alarms_set"];
/// The workloads of the October 27 baseline matrix (comparable sums).
const ORIGINAL: [&str; 15] = [
    "u01-edit-delete",
    "u01-save-small-record",
    "u02-point-read",
    "u04-decision-step",
    "u05-hot-record-edits",
    "u06-list-newest",
    "u07-search-all-kinds",
    "u08-open-workspace",
    "u11-ai-builds-context",
    "u12-erase-person",
    "u15-idle-week",
    "u16-twenty-stores-hourly",
    "u17-bulk-import",
    "u28-hundred-ai-writers",
    "u34-fact-log",
];

type Runs = BTreeMap<String, BTreeMap<String, Value>>;

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
fn count(m: &Value, name: &str) -> f64 {
    num(&m["counts"][name])
}
fn caused(m: &Value, name: &str, cause: &str) -> f64 {
    num(&m["causes"][name][cause])
}
fn occurrences(s: &Value) -> f64 {
    num(&s["acked"]) + num(&s["failed"])
}
fn written(m: &Value) -> f64 {
    WRITES.iter().map(|k| count(m, k)).sum()
}
fn f(v: f64, d: usize) -> String {
    format!("{v:.d$}")
}
fn per(n: f64, s: &Value) -> Option<f64> {
    let o = occurrences(s);
    (o > 0.0).then(|| n / o)
}
fn opt(v: Option<f64>) -> String {
    v.map_or("-".into(), |x| f(x, 2))
}

/// $ of one run under the Cloudflare model: operations + alarm wakes +
/// storage per store-month x stores; and whether any operation was unpriced.
fn dollars(r: &Value) -> (f64, bool) {
    let mut usd = 0.0;
    let mut unknown = false;
    for s in r["totals"].as_object().into_iter().flat_map(|t| t.values()) {
        match s["priced"][MODEL]["cost"]["total"].as_f64() {
            Some(x) => usd += x,
            None => unknown |= num(&s["unsupported"]) > 0.0,
        }
    }
    usd += num(&r["alarm_totals"]["priced"][MODEL]["cost"]["total"]);
    let stores = r["stores"].as_f64().unwrap_or(1.0);
    usd += num(&r["per_store_month"][MODEL]["storage"]) * stores;
    (usd, unknown)
}

fn load(root: &Path) -> Result<Runs, String> {
    let mut out = BTreeMap::new();
    let mut dirs: Vec<_> = fs::read_dir(root)
        .map_err(|e| format!("{}: {e}", root.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("runs").is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let candidate = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_owned();
        let mut runs = BTreeMap::new();
        for e in fs::read_dir(dir.join("runs")).map_err(|e| e.to_string())? {
            let path = e.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let r: Value =
                serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
            let w = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.split("--").nth(1))
                .unwrap_or_default()
                .to_owned();
            runs.insert(w, r);
        }
        out.insert(candidate, runs);
    }
    Ok(out)
}

fn variants(data: &Runs, o: &mut Vec<String>) {
    o.push("## Candidate x search variant\n".into());
    o.push("| Candidate | rows/create (search part) | rows/edit (search part) | search rows read/op (search, record) | tail entries/search | persisted lag ms/search | search+list results wrong / checked | erasure residue + still readable / erasures | $/month all workloads | $/month original 15 |".into());
    o.push("| --- | ---: | ---: | --- | ---: | ---: | --- | --- | ---: | ---: |".into());
    for (c, runs) in data {
        let u01 = runs.get("u01-save-small-record");
        let cell = |name: &str| -> String {
            u01.map(|r| &r["totals"][name])
                .filter(|s| s.is_object())
                .map_or("-".into(), |s| {
                    let m = &s["meters"];
                    format!(
                        "{} ({})",
                        opt(per(written(m), s)),
                        opt(per(caused(m, "table_rows_written", "search"), s))
                    )
                })
        };
        let (mut n, mut sv, mut ss, mut sr, mut tail, mut lag) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        if let Some(r) = runs.get("u07-search-all-kinds") {
            for name in ["search all kinds", "search pages only"] {
                let s = &r["totals"][name];
                if !s.is_object() {
                    continue;
                }
                let m = &s["meters"];
                n += occurrences(s);
                sv += count(m, "scan_visits");
                ss += caused(m, "scan_visits", "search");
                sr += caused(m, "scan_visits", "record");
                tail += count(m, "search_tail_entries");
                lag += count(m, "search_index_lag_ms");
            }
        }
        let (mut wrong, mut checked, mut residue, mut erasures) = (0.0, 0.0, 0.0, 0.0);
        let (mut all, mut orig, mut unknown) = (0.0, 0.0, false);
        for (w, r) in runs {
            let i = &r["invariants"];
            wrong += num(&i["lists_wrong"]);
            checked += num(&i["lists_checked"]);
            residue += num(&i["erasure_residue_markers"]) + num(&i["erased_still_readable"]);
            erasures += num(&i["erasures_checked"]);
            let (usd, u) = dollars(r);
            all += usd;
            unknown |= u;
            if ORIGINAL.contains(&w.as_str()) {
                orig += usd;
            }
        }
        let avg = |x: f64, d: usize| {
            if n > 0.0 {
                f(x / n, d)
            } else {
                "-".into()
            }
        };
        let search = if n > 0.0 {
            format!("{} ({}, {})", f(sv / n, 2), f(ss / n, 2), f(sr / n, 2))
        } else {
            "-".into()
        };
        o.push(format!(
            "| {c} | {} | {} | {search} | {} | {} | {wrong} / {checked} | {residue} / {erasures} | {}{} | {} |",
            cell("save new note"),
            cell("edit recent note"),
            avg(tail, 1),
            avg(lag, 0),
            f(all, 4),
            if unknown { " (+unsupported)" } else { "" },
            f(orig, 4)
        ));
    }
}

fn receipts(data: &Runs, o: &mut Vec<String>) {
    o.push("\n## Receipt rows read per retried attempt, first and last retry day\n".into());
    o.push("| Candidate | Workload | Operation | first retry day | last retry day | max over days | retries |".into());
    o.push("| --- | --- | --- | --- | --- | ---: | ---: |".into());
    for (c, runs) in data {
        for (w, r) in runs {
            for name in r["totals"].as_object().into_iter().flat_map(|t| t.keys()) {
                let days: Vec<(u64, f64, f64)> = r["days"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|d| {
                        let s = &d["ops"][name];
                        let retries = num(&s["retries"]);
                        (retries > 0.0).then(|| {
                            (
                                d["day"].as_u64().unwrap_or(0),
                                caused(&s["meters"], "scan_visits", "receipt") / retries,
                                retries,
                            )
                        })
                    })
                    .collect();
                if days.len() < 2 || days.iter().all(|d| d.1 == 0.0) {
                    continue;
                }
                let (first, last) = (days[0], days[days.len() - 1]);
                let max = days.iter().map(|d| d.1).fold(0.0, f64::max);
                let retries: f64 = days.iter().map(|d| d.2).sum();
                o.push(format!(
                    "| {c} | {w} | {name} | day {}: {} | day {}: {} | {} | {retries} |",
                    first.0,
                    f(first.1, 2),
                    last.0,
                    f(last.1, 2),
                    f(max, 2)
                ));
            }
        }
    }
}

fn recovery(data: &Runs, o: &mut Vec<String>) {
    o.push("\n## Recovery rows read per crash (u07, search tail rebuild included)\n".into());
    o.push("| Candidate | crashes | recovery rows read per crash (search part) |".into());
    o.push("| --- | ---: | --- |".into());
    for (c, runs) in data {
        let Some(r) = runs.get("u07-search-all-kinds") else {
            continue;
        };
        let (mut sv, mut ss) = (0.0, 0.0);
        for d in r["days"].as_array().into_iter().flatten() {
            sv += count(&d["recovery"], "scan_visits");
            ss += caused(&d["recovery"], "scan_visits", "search");
        }
        let crashes = num(&r["faults"]["crashes"]);
        let cell = if crashes > 0.0 {
            format!("{} ({})", f(sv / crashes, 1), f(ss / crashes, 1))
        } else {
            "-".into()
        };
        o.push(format!("| {c} | {crashes} | {cell} |"));
    }
}

fn failures(data: &Runs, o: &mut Vec<String>) {
    o.push("\n## Failed operations by error, all workloads\n".into());
    o.push("| Candidate | failed | errors |".into());
    o.push("| --- | ---: | --- |".into());
    for (c, runs) in data {
        let mut failed = 0.0;
        let mut errors: BTreeMap<String, f64> = BTreeMap::new();
        for r in runs.values() {
            for s in r["totals"].as_object().into_iter().flat_map(|t| t.values()) {
                failed += num(&s["failed"]);
            }
            for d in r["days"].as_array().into_iter().flatten() {
                for s in d["ops"].as_object().into_iter().flat_map(|t| t.values()) {
                    for (e, k) in s["errors"].as_object().into_iter().flatten() {
                        *errors.entry(e.clone()).or_default() += num(k);
                    }
                }
            }
        }
        let text: Vec<String> = errors.iter().map(|(e, k)| format!("{e}: {k}")).collect();
        o.push(format!(
            "| {c} | {failed} | {} |",
            if text.is_empty() {
                "-".into()
            } else {
                text.join("; ")
            }
        ));
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(root) = args.first() else {
        eprintln!("usage: search-receipt-report <run-root> [<out.md>]");
        return ExitCode::from(2);
    };
    let data = match load(Path::new(root)) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("search-receipt-report: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut o = Vec::new();
    variants(&data, &mut o);
    receipts(&data, &mut o);
    recovery(&data, &mut o);
    failures(&data, &mut o);
    let md = o.join("\n") + "\n";
    if let Some(out) = args.get(1) {
        if let Err(e) = fs::write(out, &md) {
            eprintln!("{out}: {e}");
            return ExitCode::FAILURE;
        }
    }
    print!("{md}");
    ExitCode::SUCCESS
}
