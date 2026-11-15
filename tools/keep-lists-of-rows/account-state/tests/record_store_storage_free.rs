// tests/record_store_storage_free.rs
//
// Purpose: Keep the record store (src/storage/record_store/) free of SQLite for good. The store talks to the `Storage`
// trait only; SQLite is one supply behind that trait (src/storage/sqlite.rs), beside memory, and both pass the same
// conformance suite (tests/records_conformance.rs). This test fails the moment any record store source file names the SQLite
// library, a database connection, or carries SQL text in code.
//
// Non-Negotiable Invariants:
// - Every `.rs` file under src/storage/record_store/ is read, at any depth; a new file is covered without editing this test.
// - Only code is judged: line comments, doc comments and block comments are removed first, so the documentation may
//   explain what the store replaced. String literals are code and are judged (SQL text lives in strings).
// - The judge is itself checked against known-bad and known-good samples, so it cannot pass by matching nothing.
//
// Key Concepts:
// - Forbidden in code: `rusqlite`, `Connection`, a `sqlite::` path, and SQL statements (SELECT, PRAGMA, INSERT INTO,
//   DELETE FROM, UPDATE .. SET, CREATE/DROP/ALTER TABLE/INDEX/VIEW/TRIGGER, WITHOUT ROWID), matched as whole words.
// - The one-time migration's old-engine reader, which does read the old engine's tables, is the tool
//   examples/record_store_migrate.rs (`migrate::Source`), outside the store.
//
// Security Considerations:
// - Reads the repository's own source files only.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use regex::Regex;
use std::path::{Path, PathBuf};

/// Whole-word patterns no record store code may contain.
const FORBIDDEN: &[&str] = &[
    r"\brusqlite\b",
    r"\bConnection\b",
    r"\bsqlite::",
    r"\b(SELECT|PRAGMA)\b",
    r"\bINSERT\s+(OR\s+[A-Z]+\s+)?INTO\b",
    r"\bDELETE\s+FROM\b",
    r"\bUPDATE\s+\w+\s+SET\b",
    r"\b(CREATE|DROP|ALTER)\s+(UNIQUE\s+)?(TABLE|INDEX|VIEW|TRIGGER)\b",
    r"\bWITHOUT\s+ROWID\b",
];

/// The source text with every comment removed (line, doc and block comments), string and char literals kept.
fn code_of(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut code = String::with_capacity(source.len());
    let mut at = 0;
    let mut in_string = false;
    while at < bytes.len() {
        let rest = &source[at..];
        if in_string {
            let c = rest.chars().next().unwrap_or_default();
            if c == '\\' {
                let escaped: String = rest.chars().take(2).collect();
                code.push_str(&escaped);
                at += escaped.len();
                continue;
            }
            if c == '"' {
                in_string = false;
            }
            code.push(c);
            at += c.len_utf8();
        } else if rest.starts_with("//") {
            at += rest.find('\n').unwrap_or(rest.len());
        } else if rest.starts_with("/*") {
            // Rust block comments nest.
            let mut depth = 0usize;
            let mut end = 0;
            while end < rest.len() {
                if rest[end..].starts_with("/*") {
                    depth += 1;
                    end += 2;
                } else if rest[end..].starts_with("*/") {
                    depth -= 1;
                    end += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    end += rest[end..].chars().next().map_or(1, char::len_utf8);
                }
            }
            code.push(' ');
            at += end;
        } else if rest.starts_with("'\"'") {
            // The char literal of a quote does not open a string.
            code.push_str("'\"'");
            at += 3;
        } else {
            let c = rest.chars().next().unwrap_or_default();
            if c == '"' {
                in_string = true;
            }
            code.push(c);
            at += c.len_utf8();
        }
    }
    code
}

/// The forbidden matches in one source text, as (line, matched text).
fn violations(source: &str, patterns: &[Regex]) -> Vec<(usize, String)> {
    let code = code_of(source);
    let mut found = Vec::new();
    for pattern in patterns {
        for hit in pattern.find_iter(&code) {
            let line = code[..hit.start()].matches('\n').count() + 1;
            found.push((line, hit.as_str().to_owned()));
        }
    }
    found
}

fn patterns() -> Vec<Regex> {
    FORBIDDEN.iter().map(|pattern| Regex::new(pattern).expect("forbidden pattern")).collect()
}

fn rust_files(folder: &Path, into: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(folder).expect("read src/storage/record_store") {
        let path = entry.expect("folder entry").path();
        if path.is_dir() {
            rust_files(&path, into);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            into.push(path);
        }
    }
}

#[test]
fn the_judge_finds_sqlite_in_code_and_ignores_it_in_comments() {
    let patterns = patterns();
    let bad = [
        "use rusqlite::types::Value;",
        "fn f(c: &Connection) {}",
        "use crate::storage::sqlite::open_owned;",
        "let q = \"SELECT value FROM t WHERE k=?\";",
        "let q = \"insert\"; let r = \"INSERT OR REPLACE INTO t VALUES (?)\";",
        "const D: &str = \"DELETE FROM versions\";",
        "const U: &str = \"UPDATE versions SET valid_to=?\";",
        "const C: &str = \"CREATE UNIQUE INDEX i ON t(k)\";",
        "const P: &str = \"PRAGMA journal_mode=WAL\";",
        "const W: &str = \"CREATE TABLE t (k) WITHOUT ROWID\";",
        "let a = '\"'; let q = \"SELECT 1\";",
    ];
    for sample in bad {
        assert!(!violations(sample, &patterns).is_empty(), "missed: {sample}");
    }
    let good = [
        "// The old engine ran SELECT over record_log through rusqlite.",
        "/// A `Connection` used to hold the store; now `Storage` does.",
        "/* outer /* nested SELECT */ still a comment: DELETE FROM t */ let x = 1;",
        "index.tail.insert(id, entry); hasher.update(bytes); let selected = 1;",
        "let url = \"https://example.com/select\"; // SELECT in a comment after a string",
    ];
    for sample in good {
        assert!(violations(sample, &patterns).is_empty(), "false hit: {sample}");
    }
}

#[test]
fn the_record_store_holds_no_sqlite_type_and_no_sql_text() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/storage/record_store");
    let mut files = Vec::new();
    rust_files(&root, &mut files);
    files.sort();
    assert!(files.iter().any(|path| path.ends_with("mod.rs")), "no record store source found under {}", root.display());
    let patterns = patterns();
    let mut report = Vec::new();
    for path in &files {
        let source = std::fs::read_to_string(path).expect("read record store source");
        for (line, text) in violations(&source, &patterns) {
            report.push(format!("{}:{line}: {text}", path.strip_prefix(&root).unwrap_or(path).display()));
        }
    }
    assert!(
        report.is_empty(),
        "the record store must reach storage through the Storage trait only; SQLite in src/storage/record_store:\n{}",
        report.join("\n")
    );
}
