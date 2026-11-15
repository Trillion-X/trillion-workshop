//! The pre-push gate runs this module with computer_forwarder, including ignored
//! tests. Event deadlines are bounds, not delays. Sleep calls require an exact,
//! counted debt entry; this suite itself has no such exception.
use serde::Deserialize;
use std::{collections::BTreeMap, path::Path, process::Command};

type Inventory = BTreeMap<(String, String), usize>;

#[derive(Deserialize)]
struct Debt {
    path: String,
    call: String,
    count: usize,
    reason: String,
}
#[derive(Deserialize)]
struct Debts {
    baseline_revision: String,
    waits: Vec<Debt>,
}

fn mask(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut result = bytes.to_vec();
    let mut at = 0;
    while at < bytes.len() {
        let start = at;
        if bytes[at..].starts_with(b"//") {
            while at < bytes.len() && bytes[at] != b'\n' {
                at += 1;
            }
        } else if bytes[at..].starts_with(b"/*") {
            at += 2;
            let mut depth = 1;
            while at < bytes.len() && depth > 0 {
                if bytes[at..].starts_with(b"/*") {
                    depth += 1;
                    at += 2;
                } else if bytes[at..].starts_with(b"*/") {
                    depth -= 1;
                    at += 2;
                } else {
                    at += 1;
                }
            }
        } else if bytes[at] == b'r' && bytes.get(at + 1).is_some_and(|b| *b == b'#' || *b == b'"') {
            let mut quote = at + 1;
            while bytes.get(quote) == Some(&b'#') {
                quote += 1;
            }
            if bytes.get(quote) != Some(&b'"') {
                at += 1;
                continue;
            }
            let hashes = quote - at - 1;
            at = quote + 1;
            while at < bytes.len() {
                if bytes[at] == b'"'
                    && bytes
                        .get(at + 1..at + 1 + hashes)
                        .is_some_and(|s| s.iter().all(|b| *b == b'#'))
                {
                    at += 1 + hashes;
                    break;
                }
                at += 1;
            }
        } else if bytes[at] == b'"'
            || (bytes[at] == b'\''
                && (bytes.get(at + 2) == Some(&b'\'') || bytes.get(at + 1) == Some(&b'\\')))
        {
            let quote = bytes[at];
            at += 1;
            while at < bytes.len() {
                if bytes[at] == b'\\' {
                    at = (at + 2).min(bytes.len());
                } else if bytes[at] == quote {
                    at += 1;
                    break;
                } else {
                    at += 1;
                }
            }
        } else {
            at += 1;
            continue;
        }
        for byte in &mut result[start..at] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    }
    String::from_utf8(result).unwrap()
}

fn calls(source: &str) -> Vec<String> {
    let code = mask(source);
    let mut names = vec![
        "sleep".to_string(),
        "sleep_until".to_string(),
        "park_timeout".to_string(),
        "interval".to_string(),
        "interval_at".to_string(),
    ];
    let aliases = regex::Regex::new(
        r"\b(?:sleep|sleep_until|park_timeout|interval|interval_at)\s+as\s+(\w+)",
    )
    .unwrap();
    names.extend(
        aliases
            .captures_iter(&code)
            .map(|alias| alias[1].to_owned()),
    );
    let bindings = regex::Regex::new(
        r"\blet\s+(\w+)\s*(?::[^=;]+)?=\s*(?:\w+::)*(?:sleep|sleep_until|park_timeout)\s*;",
    )
    .unwrap();
    names.extend(
        bindings
            .captures_iter(&code)
            .map(|binding| binding[1].to_owned()),
    );
    let pattern = regex::Regex::new(&format!(r"\b(?:\w+::)*(?:{})\s*\(", names.join("|"))).unwrap();
    let mut found = Vec::new();
    for call in pattern.find_iter(&code) {
        // A Tokio test that starts paused proves this sleep uses its virtual clock.
        // The attribute must belong to the enclosing function, not another test.
        if let Some(attribute) = code[..call.start()].rfind("#[tokio::test") {
            let tail = &code[attribute..call.start()];
            if let Some(close) = tail.find(']') {
                let attribute = tail[..close]
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect::<String>();
                let body = &tail[close + 1..];
                let braces = body.bytes().fold(0_i64, |depth, byte| {
                    depth + i64::from(byte == b'{') - i64::from(byte == b'}')
                });
                if attribute.contains("start_paused=true")
                    && braces > 0
                    && code[call.start()..].starts_with("tokio::time::")
                {
                    continue;
                }
            }
        }
        let mut end = call.end();
        let mut depth = 1;
        while end < code.len() && depth != 0 {
            match code.as_bytes()[end] {
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            end += 1;
        }
        found.push(
            code[call.start()..end]
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect(),
        );
    }
    found
}

fn visit(root: &Path, path: &Path, inventory: &mut Inventory) {
    for entry in std::fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            visit(root, &path, inventory);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            for call in calls(&std::fs::read_to_string(&path).unwrap()) {
                *inventory.entry((name.clone(), call)).or_default() += 1;
            }
        }
    }
}

fn kept(debts: Debts) -> Inventory {
    let mut inventory = Inventory::new();
    for debt in debts.waits {
        assert!(
            !debt.path.starts_with("tests/computer_forwarder"),
            "the forwarder suite has no real-clock exception"
        );
        assert!(
            debt.count > 0 && !debt.reason.is_empty(),
            "every debt needs a measured reason"
        );
        assert!(
            inventory
                .insert((debt.path, debt.call), debt.count)
                .is_none(),
            "duplicate wait debt"
        );
    }
    inventory
}

fn git(root: &Path, object: &str) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["show", object])
        .output()
        .unwrap();
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).unwrap())
}

#[test]
fn real_clock_waits_in_tests_only_shrink() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let debts: Debts = serde_json::from_str(include_str!("../real-clock-waits.json")).unwrap();
    let baseline = debts.baseline_revision.clone();
    assert!(baseline.len() == 40 && baseline.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let allowed = kept(debts);
    let mut actual = Inventory::new();
    visit(root, &root.join("tests"), &mut actual);
    assert_eq!(
        actual, allowed,
        "new real-clock waits are banned; remove retired debt entries too"
    );
    let previous = git(root, "HEAD^:tests/real-clock-waits.json");
    let previous = previous.map(|source| kept(serde_json::from_str(&source).unwrap()));
    for ((path, call), count) in &allowed {
        let limit = match &previous {
            Some(previous) => *previous.get(&(path.clone(), call.clone())).unwrap_or(&0),
            None => calls(
                &git(root, &format!("{baseline}:{path}")).unwrap_or_else(|| {
                    panic!("git history unavailable for {baseline}:{path}: run from a git checkout or set GIT_DIR")
                }),
            )
            .iter()
            .filter(|old| *old == call)
            .count(),
        };
        assert!(*count <= limit, "wait debt may only shrink: {path}: {call}");
    }
}

#[test]
fn the_wait_guard_recognizes_qualified_imported_and_aliased_delays() {
    for source in [
        "std::thread::sleep(Duration::from_secs(9));",
        "tokio::time::sleep(Duration::from_secs(9)).await;",
        "use std::thread::sleep as nap; nap(bound);",
        "let nap = std::thread::sleep; nap(bound);",
        "thread::park_timeout(bound);",
        "tokio::time::interval(bound);",
    ] {
        assert_eq!(calls(source).len(), 1, "{source}");
    }
    assert!(calls("#[tokio::test(start_paused = true)] async fn virtual_delay() { tokio::time::sleep(bound).await; }").is_empty());
    assert_eq!(
        calls(
            "#[tokio::test(start_paused = true)] async fn paused() { std::thread::sleep(bound); }"
        )
        .len(),
        1
    );
    assert_eq!(calls("#[tokio::test(start_paused = true)] async fn paused() {} #[test] fn real() { std::thread::sleep(bound); }").len(), 1);
    assert!(calls("// thread::sleep(bound)\nlet example = r##\"sleep(bound)\"##; receiver.recv_timeout(bound); condition.wait_timeout(guard, bound);").is_empty());
}
