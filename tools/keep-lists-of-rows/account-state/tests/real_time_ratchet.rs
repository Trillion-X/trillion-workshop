// tests/real_time_ratchet.rs
//
// Purpose: keep the modules the simulation reaches free of new real-time reads. `tests/real-time-ratchet.json` lists the
// roots and each file's allowed count of `Instant::now`, `SystemTime::now` and `thread::sleep`. A count may only go down:
// a new file, a higher count, or a count that dropped without the DATA being lowered fails this test.
// Why a test and not clippy: `clippy.toml` `disallowed-methods` is crate-wide, and these modules hold legitimate
// real-time I/O (TLS handshakes, socket deadlines) that a crate-wide deny would break.
use std::{fs, path::Path};

const PATTERNS: [&str; 3] = ["Instant::now", "SystemTime::now", "thread::sleep"];

fn count(text: &str) -> usize {
    PATTERNS.iter().map(|pattern| text.matches(pattern).count()).sum()
}

fn rust_files(root: &Path, out: &mut Vec<String>) {
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path.to_string_lossy().into_owned());
        }
    }
}

#[test]
fn real_time_reads_in_simulated_modules_only_go_down() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let data: serde_json::Value = serde_json::from_str(&fs::read_to_string(format!("{manifest}/tests/real-time-ratchet.json")).unwrap()).unwrap();
    let allowed: std::collections::BTreeMap<String, usize> = data["allowed"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(file, n)| (file.clone(), n.as_u64().unwrap() as usize))
        .collect();
    let mut failures = Vec::new();
    for root in data["roots"].as_array().unwrap() {
        let mut files = Vec::new();
        rust_files(&Path::new(manifest).join(root.as_str().unwrap()), &mut files);
        for file in files {
            let rel = file.strip_prefix(&format!("{manifest}/")).unwrap().to_owned();
            let found = count(&fs::read_to_string(&file).unwrap());
            let bound = allowed.get(&rel).copied().unwrap_or(0);
            if found > bound {
                failures.push(format!("{rel}: {found} real-time reads, allowed {bound}"));
            } else if found < bound {
                failures.push(format!("{rel}: {found} real-time reads, allowed {bound}; lower it in tests/real-time-ratchet.json"));
            }
        }
    }
    assert!(failures.is_empty(), "real-time reads in simulated modules:\n{}", failures.join("\n"));
}
