//! Every release that ran in production still reads with HEAD. Each folder under `tests/fixtures/releases/` holds the
//! starting rows one release shipped and the stored sign-in ways row an account made from them (captured from git, synthetic
//! only). The folder is named by the BLAKE3 of its commit, so a fixture cannot be replaced without renaming it. A field
//! HEAD requires that an older release never wrote fails here, so it needs a default before it ships.

use super::tokens::blake3_hex;
use super::{ways::WaysRow, StartingRows};
use std::path::{Path, PathBuf};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/releases");

fn read<T: serde::de::DeserializeOwned>(path: &Path) -> T {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("{} reads: {error}", path.display()));
    serde_json::from_slice(&bytes).unwrap_or_else(|error| panic!("{} decodes with HEAD: {error}", path.display()))
}

fn releases() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = std::fs::read_dir(FIXTURES)
        .expect("the release fixtures folder reads")
        .map(|entry| entry.expect("a fixture entry reads").path())
        .filter(|path| path.is_dir())
        .collect();
    folders.sort();
    folders
}

#[test]
fn every_production_release_decodes_with_head() {
    let folders = releases();
    assert!(folders.len() >= 6, "the corpus holds the production releases it names, found {}", folders.len());
    for folder in folders {
        let manifest: serde_json::Value = read(&folder.join("manifest.json"));
        let commit = manifest["commit"].as_str().expect("the manifest names its commit");
        let name = folder.file_name().and_then(|name| name.to_str()).expect("a fixture folder has a name");
        assert_eq!(name, blake3_hex(commit), "{} is named by the BLAKE3 of its commit", folder.display());
        let _: StartingRows = read(&folder.join("new-accounts.json"));
        let _: WaysRow = read(&folder.join("ways-row.json"));
    }
}
