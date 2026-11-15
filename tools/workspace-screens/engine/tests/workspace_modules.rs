// tests/workspace_modules.rs
//
// Purpose: Qualify bounded parsing and positive-only lookup of public saved-screen archives.
//
// Non-Negotiable Invariants: A matching identity is not publication authority; the injected test source represents
// the existing public-content owner and never a real account store.
//
// Key Concepts: Archives published while it runs can appear after a reader starts; one reader must serve each newly admitted identity.
//
// Security Considerations: Exercise integrity, traversal, duplicate, link, trailing-data and size refusals without
// extracting or executing an archive. These tests do not qualify workspace routing or an actual storage source.
//
// AI Assistant Directive:
// Exercise the production workspace::saved_modules module through its public test seam.

mod workspace {
    pub use trillion_local::workspace::{saved_modules::*, SupplyFuture, WorkspaceError};
}

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use content_crypto::advanced::blake3;
use tar::EntryType;
use tokio::sync::Semaphore;
use workspace::{
    parse_screen_archive, PublicScreenArchiveSource, SavedScreenModules, ScreenBundleIdentity,
    SupplyFuture, WorkspaceError,
};

struct ActiveRead {
    active: Arc<AtomicUsize>,
}

impl ActiveRead {
    fn new(active: Arc<AtomicUsize>, peak: &AtomicUsize) -> Self {
        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
        peak.fetch_max(now, Ordering::SeqCst);
        Self { active }
    }
}

impl Drop for ActiveRead {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Source {
    archives: Mutex<HashMap<String, Vec<u8>>>,
    reads: AtomicUsize,
    fail_next: AtomicUsize,
    active: Arc<AtomicUsize>,
    peak_active: AtomicUsize,
    source_started: Arc<Semaphore>,
    source_release: Arc<Semaphore>,
    block_reads: AtomicBool,
}

impl Source {
    fn new() -> Self {
        Self {
            archives: Mutex::new(HashMap::new()),
            reads: AtomicUsize::new(0),
            fail_next: AtomicUsize::new(0),
            active: Arc::new(AtomicUsize::new(0)),
            peak_active: AtomicUsize::new(0),
            source_started: Arc::new(Semaphore::new(0)),
            source_release: Arc::new(Semaphore::new(0)),
            block_reads: AtomicBool::new(false),
        }
    }
    fn insert(&self, archive: Vec<u8>) -> String {
        let id = format!("1f:{}", blake3::hash(&archive).to_hex());
        self.archives.lock().unwrap().insert(id.clone(), archive);
        id
    }
}

impl PublicScreenArchiveSource for Source {
    fn read_admitted_public_screen_archive(
        &self,
        identity: ScreenBundleIdentity,
        max_compressed_bytes: usize,
    ) -> SupplyFuture<Option<Vec<u8>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let fail = self
            .fail_next
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok();
        let active = ActiveRead::new(Arc::clone(&self.active), &self.peak_active);
        let blocked = self.block_reads.load(Ordering::SeqCst);
        let source_started = Arc::clone(&self.source_started);
        let source_release = Arc::clone(&self.source_release);
        let archives = self.archives.lock().unwrap();
        let oversized = archives
            .get(identity.as_str())
            .is_some_and(|bytes| bytes.len() > max_compressed_bytes);
        let bytes = if oversized {
            None
        } else {
            archives.get(identity.as_str()).cloned()
        };
        Box::pin(async move {
            let _active = active;
            source_started.add_permits(1);
            if blocked {
                source_release
                    .acquire()
                    .await
                    .expect("test source release semaphore remains open")
                    .forget();
            }
            if fail {
                Err(trillion_local::cause!(WorkspaceError::Unavailable))
            } else if oversized {
                Err(trillion_local::cause!(WorkspaceError::TooLarge))
            } else {
                Ok(bytes)
            }
        })
    }
}

fn archive(entries: &[(&str, EntryType, &[u8])]) -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    for (name, kind, body) in entries {
        let mut header = tar::Header::new_ustar();
        header.set_mode(0o644);
        header.set_size(body.len() as u64);
        header.set_mtime(0);
        header.set_entry_type(*kind);
        assert!(name.len() < 100, "fixture uses only direct ustar names");
        header.as_mut_bytes()[..100].fill(0);
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        if kind.is_symlink() || kind.is_hard_link() {
            header.set_link_name("../outside").unwrap();
        }
        header.set_cksum();
        tar.append(&header, *body).unwrap();
    }
    let bytes = tar.into_inner().unwrap();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&bytes).unwrap();
    gzip.finish().unwrap()
}

fn oversized_pax_archive() -> Vec<u8> {
    let mut header = tar::Header::new_ustar();
    header.set_mode(0o644);
    header.set_size(64 * 1024 * 1024 + 1);
    header.set_mtime(0);
    header.set_entry_type(EntryType::XHeader);
    header.as_mut_bytes()[..100].fill(0);
    header.as_mut_bytes()[..15].copy_from_slice(b"PaxHeaders/file");
    header.set_cksum();

    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(header.as_bytes()).unwrap();
    let zeroes = [0_u8; 64 * 1024];
    let mut remaining = 64 * 1024 * 1024 + 1;
    while remaining > 0 {
        let chunk = remaining.min(zeroes.len());
        gzip.write_all(&zeroes[..chunk]).unwrap();
        remaining -= chunk;
    }
    let padding = (512 - ((64 * 1024 * 1024 + 1) % 512)) % 512;
    gzip.write_all(&zeroes[..padding]).unwrap();
    gzip.write_all(&[0_u8; 1024]).unwrap();
    gzip.finish().unwrap()
}

fn path(identity: &str, name: &str) -> String {
    format!("/workshop/modules/{}/{name}", identity.replace(':', "%3A"))
}

#[tokio::test]
async fn one_reader_observes_later_missing_and_distinct_public_archives() {
    let source = Arc::new(Source::new());
    let reader = SavedScreenModules::new(source.clone());
    let first = archive(&[(
        "public/first.mjs",
        EntryType::Regular,
        b"export const page = 'first';",
    )]);
    let first_id = format!("1f:{}", blake3::hash(&first).to_hex());

    assert!(matches!(
        reader.read(&path(&first_id, "public/first.mjs")).await,
        Err(WorkspaceError::NotFound(_))
    ));
    source.insert(first);
    assert_eq!(
        reader
            .read(&path(&first_id, "public/first.mjs"))
            .await
            .unwrap(),
        b"export const page = 'first';"
    );

    let second = archive(&[(
        "public/second.js",
        EntryType::Regular,
        b"export const page = 'second';",
    )]);
    let second_id = source.insert(second);
    assert_eq!(
        reader
            .read(&path(&second_id, "public/second.js"))
            .await
            .unwrap(),
        b"export const page = 'second';"
    );
    assert_eq!(
        reader
            .read(&path(&first_id, "public/first.mjs"))
            .await
            .unwrap(),
        b"export const page = 'first';"
    );
    assert_eq!(
        source.reads.load(Ordering::SeqCst),
        3,
        "only successful immutable archives are cached"
    );
}

#[tokio::test]
async fn source_errors_and_misses_are_not_sticky_but_success_is_cached() {
    let source = Arc::new(Source::new());
    let reader = SavedScreenModules::new(source.clone());
    let bytes = archive(&[(
        "screen.mjs",
        EntryType::Regular,
        b"export function mount() {}",
    )]);
    let identity = source.insert(bytes);
    source.fail_next.store(1, Ordering::SeqCst);

    assert!(matches!(
        reader.read(&path(&identity, "screen.mjs")).await,
        Err(WorkspaceError::Unavailable(_))
    ));
    assert_eq!(
        reader.read(&path(&identity, "screen.mjs")).await.unwrap(),
        b"export function mount() {}"
    );
    assert_eq!(
        reader.read(&path(&identity, "screen.mjs")).await.unwrap(),
        b"export function mount() {}"
    );
    assert_eq!(source.reads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn concurrent_distinct_misses_share_one_active_source_load() {
    let source = Arc::new(Source::new());
    source.block_reads.store(true, Ordering::SeqCst);
    let reader = Arc::new(SavedScreenModules::new(source.clone()));
    let first_id = source.insert(archive(&[("first.js", EntryType::Regular, b"first")]));
    let second_id = source.insert(archive(&[("second.js", EntryType::Regular, b"second")]));

    let first_reader = Arc::clone(&reader);
    let first_path = path(&first_id, "first.js");
    let first = tokio::spawn(async move { first_reader.read(&first_path).await });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        source.source_started.acquire(),
    )
    .await
    .expect("first source lookup should start")
    .unwrap()
    .forget();

    let second_reader = Arc::clone(&reader);
    let second_path = path(&second_id, "second.js");
    let second_attempted = Arc::new(Semaphore::new(0));
    let second_signal = Arc::clone(&second_attempted);
    let second = tokio::spawn(async move {
        second_signal.add_permits(1);
        second_reader.read(&second_path).await
    });
    second_attempted.acquire().await.unwrap().forget();
    assert_eq!(source.reads.load(Ordering::SeqCst), 1);
    assert_eq!(source.active.load(Ordering::SeqCst), 1);
    assert_eq!(source.peak_active.load(Ordering::SeqCst), 1);

    source.source_release.add_permits(1);
    assert_eq!(first.await.unwrap().unwrap(), b"first");
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        source.source_started.acquire(),
    )
    .await
    .expect("second distinct source lookup should start after the first")
    .unwrap()
    .forget();
    source.source_release.add_permits(1);
    assert_eq!(second.await.unwrap().unwrap(), b"second");
    assert_eq!(source.reads.load(Ordering::SeqCst), 2);
    assert_eq!(source.peak_active.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn concurrent_same_identity_misses_coalesce_to_one_source_read() {
    let source = Arc::new(Source::new());
    source.block_reads.store(true, Ordering::SeqCst);
    let reader = Arc::new(SavedScreenModules::new(source.clone()));
    let identity = source.insert(archive(&[("screen.js", EntryType::Regular, b"screen")]));
    let requested_path = path(&identity, "screen.js");

    let first_reader = Arc::clone(&reader);
    let first_path = requested_path.clone();
    let first = tokio::spawn(async move { first_reader.read(&first_path).await });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        source.source_started.acquire(),
    )
    .await
    .expect("first source lookup should start")
    .unwrap()
    .forget();

    let second_reader = Arc::clone(&reader);
    let second_attempted = Arc::new(Semaphore::new(0));
    let second_signal = Arc::clone(&second_attempted);
    let second = tokio::spawn(async move {
        second_signal.add_permits(1);
        second_reader.read(&requested_path).await
    });
    second_attempted.acquire().await.unwrap().forget();
    assert_eq!(source.reads.load(Ordering::SeqCst), 1);

    source.source_release.add_permits(1);
    assert_eq!(first.await.unwrap().unwrap(), b"screen");
    assert_eq!(second.await.unwrap().unwrap(), b"screen");
    assert_eq!(source.reads.load(Ordering::SeqCst), 1);
    assert_eq!(source.peak_active.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelling_a_blocked_source_read_releases_the_load_gate() {
    let source = Arc::new(Source::new());
    source.block_reads.store(true, Ordering::SeqCst);
    let reader = Arc::new(SavedScreenModules::new(source.clone()));
    let first_id = source.insert(archive(&[("first.js", EntryType::Regular, b"first")]));
    let next_id = source.insert(archive(&[("next.js", EntryType::Regular, b"next")]));

    let first_reader = Arc::clone(&reader);
    let first_path = path(&first_id, "first.js");
    let first = tokio::spawn(async move { first_reader.read(&first_path).await });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        source.source_started.acquire(),
    )
    .await
    .expect("blocked source lookup should start")
    .unwrap()
    .forget();
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    assert_eq!(source.active.load(Ordering::SeqCst), 0);

    let next_reader = Arc::clone(&reader);
    let next_path = path(&next_id, "next.js");
    let next = tokio::spawn(async move { next_reader.read(&next_path).await });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        source.source_started.acquire(),
    )
    .await
    .expect("next read should acquire the released load gate")
    .unwrap()
    .forget();
    source.source_release.add_permits(1);
    assert_eq!(next.await.unwrap().unwrap(), b"next");
    assert_eq!(source.reads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn malformed_and_encoded_separator_paths_do_not_reach_the_source() {
    let source = Arc::new(Source::new());
    let reader = SavedScreenModules::new(source.clone());
    let identity = format!("1f:{}", "a".repeat(64));

    for malformed in [
        path(&identity, "../escape.js"),
        path(&identity, "safe%2Fchild.js"),
        path(&identity, "safe%5Cchild.js"),
        "/workshop/modules/not-a-digest/file.js".to_owned(),
    ] {
        assert!(matches!(
            reader.read(&malformed).await,
            Err(WorkspaceError::Invalid(_))
        ));
    }
    assert_eq!(source.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn lru_evicts_the_oldest_archive_after_sixteen_entries() {
    let source = Arc::new(Source::new());
    let reader = SavedScreenModules::new(source.clone());
    let mut identities = Vec::new();

    for index in 0..17 {
        let body = format!("module-{index}");
        let identity = source.insert(archive(&[(
            "module.js",
            EntryType::Regular,
            body.as_bytes(),
        )]));
        assert_eq!(
            reader.read(&path(&identity, "module.js")).await.unwrap(),
            body.as_bytes()
        );
        identities.push(identity);
    }
    assert_eq!(source.reads.load(Ordering::SeqCst), 17);

    assert_eq!(
        reader
            .read(&path(&identities[0], "module.js"))
            .await
            .unwrap(),
        b"module-0"
    );
    assert_eq!(source.reads.load(Ordering::SeqCst), 18);
}

#[test]
fn shared_parser_checks_content_identity_and_archive_structure() {
    let valid = archive(&[("public/entry.js", EntryType::Regular, b"export const x=1;")]);
    let identity =
        ScreenBundleIdentity::parse(&format!("1f:{}", blake3::hash(&valid).to_hex())).unwrap();
    let parsed = parse_screen_archive(identity, &valid).unwrap();
    assert_eq!(parsed.member_count(), 1);
    let mut expanded = Vec::new();
    flate2::read::GzDecoder::new(valid.as_slice())
        .read_to_end(&mut expanded)
        .unwrap();
    assert_eq!(parsed.expanded_bytes(), expanded.len());
    assert!(
        parsed.expanded_bytes() > parsed.text_bytes() + 512,
        "expanded archive count includes tar headers, padding and end blocks"
    );
    assert_eq!(
        parsed.read("public/entry.js").unwrap(),
        b"export const x=1;"
    );

    let other = archive(&[("public/entry.js", EntryType::Regular, b"different")]);
    let wrong =
        ScreenBundleIdentity::parse(&format!("1f:{}", blake3::hash(&valid).to_hex())).unwrap();
    assert!(matches!(
        parse_screen_archive(wrong, &other),
        Err(WorkspaceError::Integrity(_))
    ));

    for bad in [
        archive(&[("../entry.js", EntryType::Regular, b"bad")]),
        archive(&[("/entry.js", EntryType::Regular, b"bad")]),
        archive(&[("a/../entry.js", EntryType::Regular, b"bad")]),
        archive(&[("entry.js", EntryType::Symlink, b"")]),
        archive(&[("entry.js", EntryType::Link, b"")]),
        archive(&[
            ("entry.js", EntryType::Regular, b"one"),
            ("entry.js", EntryType::Regular, b"two"),
        ]),
    ] {
        let id =
            ScreenBundleIdentity::parse(&format!("1f:{}", blake3::hash(&bad).to_hex())).unwrap();
        assert!(matches!(
            parse_screen_archive(id, &bad),
            Err(WorkspaceError::Invalid(_) | WorkspaceError::Integrity(_))
        ));
    }

    let binary = archive(&[("binary.mjs", EntryType::Regular, &[0xff, 0xfe])]);
    let id =
        ScreenBundleIdentity::parse(&format!("1f:{}", blake3::hash(&binary).to_hex())).unwrap();
    assert!(matches!(
        parse_screen_archive(id, &binary)
            .unwrap()
            .read("binary.mjs"),
        Err(WorkspaceError::NotFound(_))
    ));
}

#[test]
fn parses_one_retained_canonical_distribution_module() {
    let package = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/retired-snapshot/canonical-dist");
    let identity = ScreenBundleIdentity::parse(
        "1f:bfcbc10ca6234fd4c26f7c4f7b379a06188f10bfb24e8e3aed82b0c6747fd269",
    )
    .unwrap();
    let compressed = std::fs::read(package.join("screen-modules").join(format!(
        "{}.tar.gz",
        identity.as_str().trim_start_matches("1f:")
    )))
    .unwrap();
    let parsed = parse_screen_archive(identity, &compressed).unwrap();
    let body = parsed.read("look-over-time-screen-IXVRVHL7.js").unwrap();
    assert_eq!(
        blake3::hash(&body).to_hex().as_str(),
        "d9e20dcc115193398c5ce3712a8a9077084563c81ada3a0969e08b8b4177405d"
    );
}

#[test]
fn rejects_member_bounds_bad_gzip_and_nonzero_trailing_bytes() {
    let too_large = vec![b'x'; 8 * 1024 * 1024 + 1];
    let large = archive(&[("large.js", EntryType::Regular, &too_large)]);
    let id = ScreenBundleIdentity::parse(&format!("1f:{}", blake3::hash(&large).to_hex())).unwrap();
    assert!(matches!(
        parse_screen_archive(id, &large),
        Err(WorkspaceError::TooLarge(_))
    ));

    let valid = archive(&[("entry.js", EntryType::Regular, b"x")]);
    let mut junk = valid.clone();
    junk.extend_from_slice(b"junk");
    let junk_id =
        ScreenBundleIdentity::parse(&format!("1f:{}", blake3::hash(&junk).to_hex())).unwrap();
    assert!(matches!(
        parse_screen_archive(junk_id, &junk),
        Err(WorkspaceError::Integrity(_))
    ));

    let mut concatenated = valid.clone();
    concatenated.extend_from_slice(&valid);
    let concatenated_id =
        ScreenBundleIdentity::parse(&format!("1f:{}", blake3::hash(&concatenated).to_hex()))
            .unwrap();
    assert!(matches!(
        parse_screen_archive(concatenated_id, &concatenated),
        Err(WorkspaceError::Integrity(_))
    ));

    let mut corrupt = valid.clone();
    let last_index = corrupt.len() - 1;
    corrupt[last_index] ^= 0xff;
    let corrupt_id =
        ScreenBundleIdentity::parse(&format!("1f:{}", blake3::hash(&corrupt).to_hex())).unwrap();
    assert!(matches!(
        parse_screen_archive(corrupt_id, &corrupt),
        Err(WorkspaceError::Integrity(_))
    ));

    let compressed_bound = vec![0_u8; 16 * 1024 * 1024 + 1];
    let compressed_id =
        ScreenBundleIdentity::parse(&format!("1f:{}", blake3::hash(&compressed_bound).to_hex()))
            .unwrap();
    assert!(matches!(
        parse_screen_archive(compressed_id, &compressed_bound),
        Err(WorkspaceError::TooLarge(_))
    ));

    let pax = oversized_pax_archive();
    let pax_id =
        ScreenBundleIdentity::parse(&format!("1f:{}", blake3::hash(&pax).to_hex())).unwrap();
    assert!(matches!(
        parse_screen_archive(pax_id, &pax),
        Err(WorkspaceError::TooLarge(_))
    ));
}
