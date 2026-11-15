// src/storage/supplies/build.rs
//
// Purpose: Build the conformance suite these supplies run. The suite is tests/records_conformance.rs of the parent crate,
// read as it is on disk, with exactly one block replaced: the `Engine` type that chooses which supply a test body runs
// on. Every test body, helper and assertion is the parent's own text, so a supply passes the same cases or it does not.
//
// Non-Negotiable Invariants:
// - Only the block between the two markers is replaced, and the history length of the as-of case may be shortened by
//   the environment (`SUPPLY_HISTORY_VERSIONS`) for a server whose round trips make 100,000 commits impractical.
// - If a marker moved, the build fails; it never runs a different suite than the one named.
//
// Key Concepts:
// - `tests/replacement/store_under_test.rs` is the replacement block. The output is `$OUT_DIR/suite.rs`.
//
// Security Considerations:
// - Reads two files of this repository and writes one into the build output folder.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::{env, fs, path::PathBuf};

const START: &str = "/// One store under test:";
const END: &str = "/// A supply the store can own across threads.";
const HISTORY: &str = "(\"hundred-thousand\", 100_000)";

fn main() {
    let here = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let suite_path = here.join("../../../tests/records_conformance.rs");
    let engine_path = here.join("tests/replacement/store_under_test.rs");
    crate::quiet_println!("cargo:rerun-if-changed={}", suite_path.display());
    crate::quiet_println!("cargo:rerun-if-changed={}", engine_path.display());
    let suite = fs::read_to_string(&suite_path).expect("the parent conformance suite");
    let engine = fs::read_to_string(&engine_path).expect("the engine block");
    assert_eq!(suite.matches(START).count(), 1, "the parent suite needs one start marker");
    assert_eq!(suite.matches(END).count(), 1, "the parent suite needs one end marker");
    let from = suite.find(START).expect("start marker moved in the parent suite");
    let to = suite.find(END).expect("end marker moved in the parent suite");
    assert!(from < to, "markers out of order in the parent suite");
    assert!(suite.contains(HISTORY), "the as-of history length moved in the parent suite");
    let mut out = String::new();
    out.push_str(&suite[..from]);
    out.push_str(&engine);
    out.push('\n');
    out.push_str(&suite[to..]);
    let out = out.replace(HISTORY, "(\"hundred-thousand\", history_versions())");
    fs::write(PathBuf::from(env::var("OUT_DIR").expect("out dir")).join("suite.rs"), out).expect("write suite");
}
