//! The release feed's own rules, with no network: a signature over exactly the signed fields by a listed key; a body
//! whose length and BLAKE3 are the entry's; the newest signed release for this target above this binary's sequence; a
//! spread that is the same every time, within its bound, shorter when urgent; and a switch that never lets an older
//! release win. The fetch is a table of bodies by URL (`Table`), the transport left out.

use super::*;
use std::collections::HashMap;

const TARGET: &str = "x86_64-unknown-linux-gnu";
const PRIVATE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_PRIVATE: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn public(private: &str) -> String {
    content_crypto::Ed25519Signature::public_key_from_private(private).unwrap()
}

fn commit(byte: char) -> String {
    std::iter::repeat_n(byte, 40).collect()
}

/// A tar.gz holding `trillion-local` and `product/data.json`, plus any `extra` (path, bytes).
fn body(binary: &[u8], extra: &[(&str, &[u8])]) -> Vec<u8> {
    body_named("trillion-local", binary, extra)
}

/// The feed the test rows read, whose folder holds every test body (a relative entry `url` is answered under it).
fn feeds() -> Vec<String> {
    vec!["https://releases.test/feed.json".to_owned()]
}

/// `body` with the program's binary named `name`.
fn body_named(name: &str, binary: &[u8], extra: &[(&str, &[u8])]) -> Vec<u8> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
    let mut add = |path: &str, bytes: &[u8]| {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_entry_type(tar::EntryType::Regular);
        builder.append_data(&mut header, path, bytes).unwrap();
    };
    add(name, binary);
    add("product/data.json", b"{}");
    for (path, bytes) in extra {
        add(path, bytes);
    }
    builder.into_inner().unwrap().finish().unwrap()
}

/// An entry for `body`, signed by `private`.
fn entry(commit: &str, sequence: u64, target: &str, body: &[u8], urgent: bool, private: &str) -> Entry {
    let mut entry = Entry {
        commit: commit.to_owned(),
        sequence,
        target: target.to_owned(),
        url: format!("{commit}.tar.gz"),
        content: format!("1f:{}", content_crypto::advanced::blake3::hash(body).to_hex()),
        bytes: body.len() as u64,
        urgent,
        signature: String::new(),
    };
    entry.signature = content_crypto::Ed25519Signature::sign(&entry.signed_bytes_bound(&numbers().release_domain), private).unwrap();
    entry
}

/// The engine's row of the test feed, signed by `keys` (releases.json's domain and intervals).
fn row(keys: &[String]) -> Row {
    Row {
        urls: vec!["https://releases.test/feed.json".to_owned()], public_keys: keys.to_vec(), domain: numbers().release_domain.clone(),
        target: TARGET.to_owned(), poll_ms: numbers().release_check_every_ms, spread_ms: numbers().release_spread_ms,
        urgent_spread_ms: numbers().release_urgent_spread_ms,
        keep_newest: numbers().release_keep_newest,
        binary: BINARY.to_owned(),
    }
}

fn running(sequence: u64) -> Running {
    Running { commit: commit('0'), sequence, target: TARGET.to_owned() }
}

/// Bodies by URL, or by the path under a feed's folder (a relative `url` is answered at any host of the feed); a URL not in
/// the table does not answer.
#[derive(Default)]
struct Table(Mutex<HashMap<String, Vec<u8>>>);

impl Table {
    fn put(&self, url: &str, bytes: Vec<u8>) {
        self.0.lock().unwrap().insert(url.to_owned(), bytes);
    }
}

impl Fetch for Table {
    fn get(&self, url: &str, limit: u64, into: &mut dyn Write, _stop: &AtomicBool) -> io::Result<u64> {
        let bytes = crate::io_operation!((self.0.lock().unwrap().iter()
            .find(|(key, _)| url == key.as_str() || url.ends_with(&format!("/{key}")))
            .map(|(_, bytes)| bytes.clone())
            .ok_or_else(|| io::Error::other("no answer"))).map_err(std::io::Error::from))?;
        let bytes = &bytes[..bytes.len().min(usize::try_from(limit).unwrap_or(usize::MAX).saturating_add(1))];
        if bytes.len() as u64 > limit {
            return crate::io_operation!(Err(io::Error::other("over its bound")));
        }
        crate::io_operation!((into.write_all(bytes)).map_err(std::io::Error::from))?;
        Ok(bytes.len() as u64)
    }
}

#[test]
fn a_target_with_its_own_feed_reads_that_feed_and_the_rest_read_the_shared_one() {
    // The Workshop's entries live in their own feed, so an engine reader that reads the shared feed never sees one.
    let own: Target = serde_json::from_str(r#"{"target":"workshop-tools","poll_ms":60000,"spread_ms":300000,"urgent_spread_ms":30000,"urls":["https://engine-releases.gettrillion.ai/engine-releases/workshop-feed.json"]}"#).unwrap();
    assert_eq!(own.row().urls, vec!["https://engine-releases.gettrillion.ai/engine-releases/workshop-feed.json".to_owned()]);
    let shared: Target = serde_json::from_str(r#"{"target":"workshop-tools","poll_ms":60000,"spread_ms":300000,"urgent_spread_ms":30000}"#).unwrap();
    assert_eq!(shared.row().urls, numbers().feed_urls);
}

#[test]
fn the_numbers_are_the_settings_files() {
    let numbers = numbers();
    // 3184a5914 changed the shipped timing to five-second polls and a thirty-second spread.
    assert_eq!(numbers.release_check_every_ms, 5_000);
    assert_eq!(numbers.release_spread_ms, 30_000);
    assert_eq!(numbers.release_urgent_spread_ms, 30_000);
    assert_eq!(numbers.release_body_max_bytes, 268_435_456);
    assert_eq!((numbers.release_boot_attempts, numbers.release_ready_after_ms, numbers.release_ready_check_ms), (5, 60_000, 1_000));
    assert_eq!(numbers.release_domain, "trillion-engine-release-v2");
    assert_eq!(numbers.release_domain_before, "trillion-engine-release-v1");
}

#[test]
fn the_engine_domain_signs_a_path_under_the_feed_and_hosts_come_from_the_feed_at_fetch_time() {
    let bytes = body(b"engine", &[]);
    let signed = entry(&commit('a'), 7, TARGET, &bytes, false, PRIVATE);
    assert_eq!(signed.url, format!("{}.tar.gz", commit('a')), "the signed url is the path under the feed");
    assert!(signed.signed_by(&row(&[public(PRIVATE)])));
    // A host named in the entry is not a release of this domain: the path is what it signs.
    for url in ["https://mirror.test/a.tar.gz", "/a.tar.gz", "../a.tar.gz", "a/../b.tar.gz", "a?b", "a//b.tar.gz", ""] {
        let mut changed = signed.clone();
        changed.url = url.to_owned();
        assert!(!changed.signed_by(&row(&[public(PRIVATE)])), "{url:?} is not a path under the feed");
    }
    // Each feed's folder answers the path: the first feed, then the next.
    let feeds = vec!["https://one.test/engine-releases/feed.json".to_owned(), "https://two.test/mirror/feed.json".to_owned()];
    assert_eq!(
        body_urls(&signed, &feeds),
        vec![format!("https://one.test/engine-releases/{}.tar.gz", commit('a')), format!("https://two.test/mirror/{}.tar.gz", commit('a'))],
    );
}

#[test]
fn a_signature_counts_only_over_exactly_the_signed_fields_by_a_listed_key() {
    let bytes = body(b"engine", &[]);
    let signed = entry(&commit('a'), 7, TARGET, &bytes, false, PRIVATE);
    assert_eq!(
        String::from_utf8(signed.signed_bytes_bound(&numbers().release_domain)).unwrap(),
        format!("trillion-engine-release-v2\n{}\n7\n{TARGET}\n{}\n{}\n{}\nfalse", commit('a'), signed.url, signed.content, bytes.len()),
    );
    assert!(signed.signed_by(&row(&[public(PRIVATE)])));
    assert!(signed.signed_by(&row(&[public(OTHER_PRIVATE), public(PRIVATE)])), "any listed key");
    assert!(!signed.signed_by(&row(&[public(OTHER_PRIVATE)])), "a key not listed");
    // Each signed field changed after signing is refused.
    let changes: Vec<Box<dyn Fn(&mut Entry)>> = vec![
        Box::new(|entry| entry.commit = commit('b')),
        Box::new(|entry| entry.sequence += 1),
        Box::new(|entry| entry.target = "aarch64-apple-darwin".to_owned()),
        Box::new(|entry| entry.url = "https://mirror.test/elsewhere.tar.gz".to_owned()),
        Box::new(|entry| entry.content = format!("1f:{}", "0".repeat(64))),
        Box::new(|entry| entry.bytes += 1),
        Box::new(|entry| entry.urgent = true),
    ];
    for change in changes {
        let mut changed = signed.clone();
        change(&mut changed);
        assert!(!changed.signed_by(&row(&[public(PRIVATE)])), "{changed:?}");
    }
    // An entry signed under the previous domain (before the URL was bound) is still accepted with its absolute URL, and that
    // URL is not checked against the signature.
    let before = Entry {
        url: format!("https://releases.test/{}.tar.gz", commit('a')),
        signature: content_crypto::Ed25519Signature::sign(&signed.signed_bytes(&numbers().release_domain_before), PRIVATE).unwrap(),
        ..signed.clone()
    };
    assert!(before.signed_by(&row(&[public(PRIVATE)])));
    let mut moved_before = before.clone();
    moved_before.url = "https://mirror.test/elsewhere.tar.gz".to_owned();
    assert!(moved_before.signed_by(&row(&[public(PRIVATE)])), "the previous domain did not bind the URL");
    // No signature, or a signature of the wrong shape, is refused.
    for signature in ["", "zz", &"0".repeat(128)] {
        let mut unsigned = signed.clone();
        unsigned.signature = signature.to_owned();
        assert!(!unsigned.signed_by(&row(&[public(PRIVATE)])));
    }
    // A plain http URL is not a release, signed or not.
    let mut plain = signed.clone();
    plain.url = "http://releases.test/a.tar.gz".to_owned();
    assert!(!plain.signed_by(&row(&[public(PRIVATE)])));
}

#[test]
fn the_newest_signed_release_for_this_target_above_this_sequence_is_chosen() {
    let bytes = body(b"engine", &[]);
    let keys = [public(PRIVATE)];
    let entries = vec![
        entry(&commit('1'), 3, TARGET, &bytes, false, PRIVATE),
        entry(&commit('2'), 8, TARGET, &bytes, false, PRIVATE),
        entry(&commit('3'), 9, TARGET, &bytes, false, OTHER_PRIVATE),
        entry(&commit('4'), 12, "aarch64-apple-darwin", &bytes, false, PRIVATE),
        entry(&commit('5'), 6, TARGET, &bytes, false, PRIVATE),
    ];
    let choice = choose(&entries, &running(5), &row(&keys));
    assert_eq!(choice.take.as_ref().map(|entry| entry.commit.clone()), Some(commit('2')), "the newest signed one above 5");
    assert_eq!(choice.refused, vec![(crate::cause!(Refusal::Older), commit('1')), (crate::cause!(Refusal::SignatureRefused), commit('3'))]);
    // At 8 already: nothing newer; the release it runs is not refused as older.
    let mut at_eight = running(8);
    at_eight.commit = commit('2');
    let choice = choose(&entries, &at_eight, &row(&keys));
    assert_eq!(choice.take, None);
    assert!(!choice.refused.contains(&(crate::cause!(Refusal::Older), commit('2'))));
    assert!(choice.refused.contains(&(crate::cause!(Refusal::Older), commit('5'))));
    // No entry for this target at all.
    let other = running(0);
    let choice = choose(&entries[3..4], &other, &row(&keys));
    assert_eq!(choice.take, None);
    assert_eq!(choice.refused, vec![(crate::cause!(Refusal::TargetAbsent), TARGET.to_owned())]);
    // An unknown build (sequence 0) takes the newest signed one.
    assert_eq!(choose(&entries, &running(0), &row(&keys)).take.map(|entry| entry.sequence), Some(8));
}

#[test]
fn each_computer_waits_its_own_spread_the_same_every_time_and_less_when_urgent() {
    let numbers = numbers();
    let release = commit('c');
    let computers: Vec<String> = (0..64).map(|at| format!("{at:064x}")).collect();
    let waits: Vec<u64> = computers.iter().map(|computer| spread_ms(&row(&[]), computer, &release, false)).collect();
    assert!(waits.iter().all(|wait| *wait < numbers.release_spread_ms));
    assert_eq!(waits, computers.iter().map(|computer| spread_ms(&row(&[]), computer, &release, false)).collect::<Vec<_>>(), "the same every time");
    let distinct: std::collections::HashSet<&u64> = waits.iter().collect();
    assert!(distinct.len() > 60, "the computers of one account restart apart");
    assert!(waits.iter().any(|wait| *wait > numbers.release_spread_ms / 2), "spread over the whole window");
    assert!(computers.iter().all(|computer| spread_ms(&row(&[]), computer, &release, true) < numbers.release_urgent_spread_ms));
    // The wait is BLAKE3(computer id || commit), first eight bytes little-endian, mod the spread.
    let digest = content_crypto::advanced::blake3::hash(format!("{}{release}", computers[0]).as_bytes());
    let first = u64::from_le_bytes(digest.as_bytes()[..8].try_into().unwrap());
    assert_eq!(waits[0], first % numbers.release_spread_ms);
    // Another release spreads the same computer elsewhere.
    assert_ne!(spread_ms(&row(&[]), &computers[0], &commit('d'), false), waits[0]);
}

#[test]
fn a_body_whose_length_or_content_is_not_the_entrys_is_refused_and_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let stop = AtomicBool::new(false);
    let table = Table::default();
    let good = body(b"engine-v2", &[]);
    let release = entry(&commit('a'), 2, TARGET, &good, false, PRIVATE);
    // Same length, other bytes.
    let mut other = good.clone();
    let last = other.len() - 1;
    other[last] ^= 1;
    table.put(&release.url, other);
    assert_eq!(adopt(&release, &feeds(), &releases, &table, &stop), Err(crate::cause!(Refusal::ContentMismatch)));
    // One byte longer than the entry says.
    let mut longer = good.clone();
    longer.push(0);
    table.put(&release.url, longer);
    assert_ne!(adopt(&release, &feeds(), &releases, &table, &stop), Ok(()));
    // Shorter.
    table.put(&release.url, good[..good.len() - 1].to_vec());
    assert_eq!(adopt(&release, &feeds(), &releases, &table, &stop), Err(crate::cause!(Refusal::ContentMismatch)));
    // A signed body that holds more than the engine and product/ is not a release.
    let odd = body(b"engine", &[("elsewhere/run.sh", b"#!/bin/sh")]);
    let odd_release = entry(&commit('e'), 2, TARGET, &odd, false, PRIVATE);
    table.put(&odd_release.url, odd);
    assert_eq!(adopt(&odd_release, &feeds(), &releases, &table, &stop), Err(crate::cause!(Refusal::ContentMismatch)));
    // No body answers.
    let absent = entry(&commit('f'), 2, TARGET, &good, false, PRIVATE);
    assert_eq!(adopt(&absent, &feeds(), &releases, &table, &stop), Err(crate::cause!(Refusal::FeedUnreachable)));
    let left: Vec<String> = fs::read_dir(&releases).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(left.is_empty(), "nothing partial is left: {left:?}");
    assert_eq!(current_commit(&releases), None, "current is not touched");
}

#[cfg(owner_files = "posix")]
#[test]
fn a_program_the_release_carries_under_product_stays_runnable_and_a_data_file_does_not_become_one() {
    use std::os::unix::fs::PermissionsExt as _;
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
    for (path, bytes, mode) in [("trillion-local", &b"engine-v6"[..], 0o755), ("product/data.json", &b"{}"[..], 0o644), ("product/bin/door", &b"door-v6"[..], 0o755)] {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(mode);
        header.set_entry_type(tar::EntryType::Regular);
        builder.append_data(&mut header, path, bytes).unwrap();
    }
    let body = builder.into_inner().unwrap().finish().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let table = Table::default();
    let release = entry(&commit('6'), 6, TARGET, &body, false, PRIVATE);
    table.put(&release.url, body);
    adopt(&release, &feeds(), &releases, &table, &AtomicBool::new(false)).unwrap();
    let mode = |path: &str| fs::metadata(releases.join("current").join(path)).unwrap().permissions().mode() & 0o111;
    assert_eq!(fs::read(releases.join("current").join("product/bin/door")).unwrap(), b"door-v6");
    assert_eq!(mode("product/bin/door"), 0o111, "the door program the release carries can be started");
    assert_eq!(mode("product/data.json"), 0, "a data file is not made a program");
    assert_eq!(mode("trillion-local"), 0o111);
}

#[cfg(owner_files = "posix")]
#[test]
fn a_release_unpacks_switches_current_atomically_and_an_older_one_never_wins() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let stop = AtomicBool::new(false);
    let table = Table::default();
    let first_body = body(b"engine-v5", &[]);
    let first = entry(&commit('5'), 5, TARGET, &first_body, false, PRIVATE);
    table.put(&first.url, first_body);
    adopt(&first, &feeds(), &releases, &table, &stop).unwrap();
    assert_eq!(current_commit(&releases), Some(commit('5')));
    assert_eq!(fs::read(releases.join("current").join("trillion-local")).unwrap(), b"engine-v5");
    assert_eq!(fs::read(releases.join("current").join("product/data.json")).unwrap(), b"{}");
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(fs::metadata(releases.join(commit('5')).join("trillion-local")).unwrap().permissions().mode() & 0o111, 0o111);
    }
    assert_eq!(fs::read_link(releases.join("current")).unwrap(), Path::new(&commit('5')), "a relative link to the commit");
    assert!(!releases.join("current.next").exists());
    // An older signed release, taken by another reader of the release feed that is behind: current keeps the newer one.
    let older_body = body(b"engine-v4", &[]);
    let older = entry(&commit('4'), 4, TARGET, &older_body, false, PRIVATE);
    table.put(&older.url, older_body);
    assert_eq!(adopt(&older, &feeds(), &releases, &table, &stop), Err(crate::cause!(Refusal::Older)));
    assert_eq!(current_commit(&releases), Some(commit('5')), "an older commit never wins");
    // A newer one switches.
    let newer_body = body(b"engine-v6", &[]);
    let newer = entry(&commit('6'), 6, TARGET, &newer_body, true, PRIVATE);
    table.put(&newer.url, newer_body);
    adopt(&newer, &feeds(), &releases, &table, &stop).unwrap();
    assert_eq!(current_commit(&releases), Some(commit('6')));
    assert_eq!(current_sequence(&releases), Some(6));
    assert_eq!(fs::read(releases.join(commit('5')).join("trillion-local")).unwrap(), b"engine-v5", "the release before stays for a rollback");
}

#[cfg(owner_files = "posix")]
#[test]
fn a_copy_older_than_current_starts_current_and_never_an_older_unsigned_other_target_or_already_started_one() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let keys = vec![public(PRIVATE)];
    let stop = AtomicBool::new(false);
    let table = Table::default();
    // No `current` yet: nothing to start.
    assert_eq!(newer_current(&releases, &running(5), &row(&keys), None), None);
    let six_body = body(b"engine-v6", &[]);
    let six = entry(&commit('6'), 6, TARGET, &six_body, false, PRIVATE);
    table.put(&six.url, six_body);
    adopt(&six, &feeds(), &releases, &table, &stop).unwrap();
    let program = releases.join(commit('6')).join("trillion-local");
    // An older copy starts current; the copy that is current, or a newer one, does not.
    assert_eq!(newer_current(&releases, &running(5), &row(&keys), None), Some(program.clone()));
    assert_eq!(newer_current(&releases, &running(6), &row(&keys), None), None);
    assert_eq!(newer_current(&releases, &running(7), &row(&keys), None), None);
    // A copy that was itself started as current never starts it again (a release whose build sequence is not its
    // entry's would otherwise start itself forever).
    assert_eq!(newer_current(&releases, &running(5), &row(&keys), Some(&commit('6'))), None);
    assert_eq!(newer_current(&releases, &running(5), &row(&keys), Some(&commit('5'))), Some(program.clone()));
    // Keys the kept entry is not signed by: not started.
    assert_eq!(newer_current(&releases, &running(5), &row(&[public(OTHER_PRIVATE)]), None), None);
    // Another build target: not started.
    let other_target = Running { target: "aarch64-apple-darwin".to_owned(), ..running(5) };
    assert_eq!(newer_current(&releases, &other_target, &row(&keys), None), None);
    // Its program gone: not started.
    fs::remove_file(&program).unwrap();
    assert_eq!(newer_current(&releases, &running(5), &row(&keys), None), None);
}

#[cfg(owner_files = "posix")]
#[test]
fn a_feed_watch_logs_each_refusal_once_and_switches_to_the_newest_signed_release() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let stop = AtomicBool::new(false);
    let table = Arc::new(Table::default());
    let newer_body = body(b"engine-v9", &[]);
    let newer = entry(&commit('9'), 9, TARGET, &newer_body, false, PRIVATE);
    let unsigned = entry(&commit('8'), 10, TARGET, &newer_body, false, OTHER_PRIVATE);
    let older = entry(&commit('3'), 3, TARGET, &newer_body, false, PRIVATE);
    table.put(&newer.url, newer_body);
    let feed = ReleaseFeed {
        urls: vec!["https://feed.test/a.json".to_owned(), "https://feed.test/down.json".to_owned()],
        public_keys: vec![public(PRIVATE)],
        releases: releases.clone(),
    };
    assert_eq!(feed.check(), Ok(()));
    let logged = Arc::new(Logged::default());
    let mut computer = None;
    // A computer whose spread for this commit is short, so the test does not wait minutes.
    for at in 0u32.. {
        let id = format!("{at:064x}");
        if spread_ms(&row(&[]), &id, &newer.commit, false) < 200 {
            computer = Some(id);
            break;
        }
    }
    let feed_watch = Follower::new(feed.row(TARGET), feed.releases.clone(), running(5), computer.unwrap(), table.clone(), logged.clone(), Duration::from_millis(5));
    // First only the unsigned and the older one: the current release stays.
    table.put("https://feed.test/a.json", serde_json::to_vec(&json_feed(&[&unsigned, &older])).unwrap());
    assert_eq!(feed_watch.step(&stop), Step::Kept);
    assert_eq!(feed_watch.step(&stop), Step::Kept);
    let codes: Vec<(Refusal, String)> = logged.all();
    assert_eq!(codes, vec![
        (crate::cause!(Refusal::FeedUnreachable), "url-1".to_owned()),
        (crate::cause!(Refusal::SignatureRefused), commit('8')),
    ], "each once, though two steps saw them; the older entry is the normal state, not logged");
    assert_eq!(current_commit(&releases), None);
    // Then the newer signed one too: it is taken.
    table.put("https://feed.test/a.json", serde_json::to_vec(&json_feed(&[&unsigned, &older, &newer])).unwrap());
    // The newer one is chosen and waits its spread (short here) before it is adopted.
    assert_eq!(feed_watch.step(&stop), Step::Kept);
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(feed_watch.step(&stop), Step::Switched(commit('9')));
    assert_eq!(current_commit(&releases), Some(commit('9')));
    assert_eq!(logged.all().len(), 2, "nothing new refused");
    // A feed longer than the old count of 32 is read whole: its bytes are the bound, and the publisher keeps the count.
    let many: Vec<&Entry> = std::iter::repeat_n(&older, 40).collect();
    table.put("https://feed.test/a.json", serde_json::to_vec(&json_feed(&many)).unwrap());
    assert_eq!(feed_watch.step(&stop), Step::Kept);
    assert!(!logged.all().iter().any(|(_, named)| named == "url-0"), "a long feed is not refused by its count");
}

fn json_feed(entries: &[&Entry]) -> serde_json::Value {
    serde_json::json!({"releases": entries})
}

#[test]
fn a_feed_config_needs_https_urls_listed_keys_and_an_absolute_folder() {
    let good = ReleaseFeed { urls: vec!["https://feed.test/f.json".to_owned()], public_keys: vec![public(PRIVATE)], releases: PathBuf::from("/srv/releases") };
    assert_eq!(good.check(), Ok(()));
    let mut bad = good.clone();
    bad.urls = vec!["http://feed.test/f.json".to_owned()];
    assert!(bad.check().is_err());
    let mut bad = good.clone();
    bad.urls.clear();
    assert!(bad.check().is_err());
    let mut bad = good.clone();
    bad.public_keys = vec!["AB".repeat(32)];
    assert!(bad.check().is_err());
    let mut bad = good.clone();
    bad.releases = PathBuf::from("releases");
    assert!(bad.check().is_err());
    let mut bad = good;
    bad.releases = PathBuf::from("/srv/../releases");
    assert!(bad.check().is_err());
}

#[test]
fn a_release_the_mac_app_rolled_back_is_never_taken_again_and_the_next_newest_is() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    fs::create_dir_all(&releases).unwrap();
    let stop = AtomicBool::new(false);
    let table = Arc::new(Table::default());
    let (failed_body, kept_body) = (body(b"engine-v9", &[]), body(b"engine-v8", &[]));
    let failed = entry(&commit('9'), 9, TARGET, &failed_body, false, PRIVATE);
    let kept = entry(&commit('8'), 8, TARGET, &kept_body, false, PRIVATE);
    table.put(&failed.url, failed_body);
    table.put(&kept.url, kept_body);
    table.put("https://feed.test/a.json", serde_json::to_vec(&json_feed(&[&failed, &kept])).unwrap());
    // The app marked the newest one refused after it failed its readiness probe (EngineReleases.rollBack).
    fs::write(releases.join(format!("{}.{REFUSED}", commit('9'))), b"").unwrap();
    assert!(rolled_back(&releases, &commit('9')) && !rolled_back(&releases, &commit('8')));
    let feed = ReleaseFeed { urls: vec!["https://feed.test/a.json".to_owned()], public_keys: vec![public(PRIVATE)], releases: releases.clone() };
    let logged = Arc::new(Logged::default());
    let computer = (0u32..).map(|at| format!("{at:064x}")).find(|id| spread_ms(&row(&[]), id, &kept.commit, false) < 200).unwrap();
    let feed_watch = Follower::new(feed.row(TARGET), feed.releases.clone(), running(5), computer, table, logged.clone(), Duration::from_millis(5));
    // The next newest is chosen and waits its spread (short here) before it is adopted.
    assert_eq!(feed_watch.step(&stop), Step::Kept);
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(feed_watch.step(&stop), Step::Switched(commit('8')), "the rolled-back release is passed over for the next newest");
    assert_eq!(current_commit(&releases), Some(commit('8')));
    assert_eq!(logged.all(), vec![(crate::cause!(Refusal::RolledBack), commit('9'))]);
    assert_eq!(crate::cause!(Refusal::RolledBack).code(), "release_rolled_back");
    assert!(!releases.join(commit('9')).exists(), "a rolled-back release is not downloaded again");
}

#[test]
fn the_mac_app_hands_its_engine_the_same_feed_checked_the_same_way() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let settings = dir.path().join("engine-releases.json");
    let write = |value: serde_json::Value| fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    write(serde_json::json!({"_what": "app DATA", "release_domain": numbers().release_domain, "releases_folder": "Trillion/engine-releases",
        "feed_urls": ["https://feed.test/a.json"], "public_keys": [public(PRIVATE)], "targets": {}}));
    assert_eq!(app_feed(&settings, &releases),
        Ok(ReleaseFeed { urls: vec!["https://feed.test/a.json".to_owned()], public_keys: vec![public(PRIVATE)], releases: releases.clone() }));
    write(serde_json::json!({"release_domain": "trillion-engine-release-v0", "feed_urls": ["https://feed.test/a.json"], "public_keys": [public(PRIVATE)]}));
    write(serde_json::json!({"release_domain": numbers().release_domain_before, "feed_urls": ["https://feed.test/a.json"], "public_keys": [public(PRIVATE)]}));
    assert!(app_feed(&settings, &releases).is_ok(), "the previous domain is still read");
    write(serde_json::json!({"release_domain": "trillion-engine-release-v3", "feed_urls": ["https://feed.test/a.json"], "public_keys": [public(PRIVATE)]}));
    assert!(app_feed(&settings, &releases).is_err(), "another domain");
    write(serde_json::json!({"release_domain": numbers().release_domain, "feed_urls": [], "public_keys": [public(PRIVATE)]}));
    assert!(app_feed(&settings, &releases).is_err(), "no feed: the app runs its bundled engine only");
    write(serde_json::json!({"release_domain": numbers().release_domain, "feed_urls": ["http://feed.test/a.json"], "public_keys": [public(PRIVATE)]}));
    assert!(app_feed(&settings, &releases).is_err(), "not https");
    write(serde_json::json!({"release_domain": numbers().release_domain, "feed_urls": ["https://feed.test/a.json"], "public_keys": []}));
    assert!(app_feed(&settings, &releases).is_err(), "no key");
    assert!(app_feed(&settings, Path::new("relative")).is_err(), "a relative folder");
    assert!(app_feed(&dir.path().join("missing.json"), &releases).is_err());
}


/// Mark a candidate refused after feed selection, while its body is in flight.
struct RefuseDuringDownload {
    table: Table,
    releases: PathBuf,
    candidate: Entry,
}
impl Fetch for RefuseDuringDownload {
    fn get(&self, url: &str, limit: u64, into: &mut dyn Write, stop: &AtomicBool) -> io::Result<u64> {
        if url.ends_with(&format!("/{}", self.candidate.url)) {
            fs::write(self.releases.join(format!("{}.{REFUSED}", self.candidate.commit)), b"")?;
        }
        self.table.get(url, limit, into, stop)
    }
}

#[cfg(owner_files = "posix")]
#[test]
fn a_release_refused_while_its_body_downloads_never_replaces_current() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let stop = AtomicBool::new(false);
    let table = Table::default();
    let kept_body = body(b"engine-v5", &[]);
    let kept = entry(&commit('5'), 5, TARGET, &kept_body, false, PRIVATE);
    table.put(&kept.url, kept_body);
    adopt(&kept, &feeds(), &releases, &table, &stop).unwrap();
    let failed_body = body(b"engine-v9", &[]);
    let failed = entry(&commit('9'), 9, TARGET, &failed_body, false, PRIVATE);
    table.put(&failed.url, failed_body);
    table.put("https://feed.test/a.json", serde_json::to_vec(&json_feed(&[&failed])).unwrap());
    let fetch = Arc::new(RefuseDuringDownload { table, releases: releases.clone(), candidate: failed.clone() });
    let feed = ReleaseFeed { urls: vec!["https://feed.test/a.json".to_owned()], public_keys: vec![public(PRIVATE)], releases: releases.clone() };
    let logged = Arc::new(Logged::default());
    let computer = (0u32..).map(|at| format!("{at:064x}")).find(|id| spread_ms(&row(&[]), id, &failed.commit, false) < 200).unwrap();
    let follower = Follower::new(feed.row(TARGET), feed.releases.clone(), running(5), computer, fetch, logged.clone(), Duration::from_millis(5));
    // The newest is chosen and waits its spread (short here) before its download is refused.
    assert_eq!(follower.step(&stop), Step::Kept);
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(follower.step(&stop), Step::Kept);
    assert_eq!(current_commit(&releases), Some(kept.commit));
    assert_eq!(logged.all(), vec![(crate::cause!(Refusal::RolledBack), failed.commit)]);
    let cause = logged.all()[0].0.cause();
    assert_eq!(cause.file(), "src/native_entry/computer/releases.rs");
    assert_eq!(cause.condition(), stringify!(Refusal::RolledBack));
    assert!(cause.line() > 0);
    assert!(!releases.join("current.next").exists());
}

#[cfg(owner_files = "posix")]
#[test]
fn a_cached_release_marked_refused_cannot_be_adopted_or_started() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let stop = AtomicBool::new(false);
    let table = Table::default();
    let bytes = body(b"engine-v9", &[]);
    let failed = entry(&commit('9'), 9, TARGET, &bytes, false, PRIVATE);
    table.put(&failed.url, bytes);
    adopt(&failed, &feeds(), &releases, &table, &stop).unwrap();
    fs::write(releases.join(format!("{}.{REFUSED}", failed.commit)), b"").unwrap();
    assert_eq!(
        (newer_current(&releases, &running(5), &row(&[public(PRIVATE)]), None), adopt(&failed, &feeds(), &releases, &table, &stop)),
        (None, Err(crate::cause!(Refusal::RolledBack))),
        "neither startup nor adoption may accept a cached refused release",
    );
    // An app rollback leaves the failed release cached but the previous pointer intact.
    fs::remove_file(releases.join("current")).unwrap();
    assert_eq!(adopt(&failed, &feeds(), &releases, &table, &stop), Err(crate::cause!(Refusal::RolledBack)));
    let cause = adopt(&failed, &feeds(), &releases, &table, &stop).unwrap_err().cause();
    assert_eq!(cause.file(), "src/native_entry/computer/releases.rs");
    assert_eq!(cause.condition(), stringify!(Refusal::RolledBack));
    assert!(cause.line() > 0);
    assert_eq!(current_commit(&releases), None);
}

#[test]
fn release_logs_keep_each_exact_cause_and_deduplicate_only_the_same_origin() {
    let logged = Logged::default();
    let first = crate::cause!(Refusal::RolledBack);
    let second = crate::cause!(Refusal::RolledBack);
    assert_ne!(first.cause(), second.cause());
    assert!(logged.once(first.clone(), "candidate"));
    assert!(logged.once(second.clone(), "candidate"));
    assert!(!logged.once(first.clone(), "candidate"));
    let rows = logged.all();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0.cause(), first.cause());
    assert_eq!(rows[1].0.cause(), second.cause());
}

/// A computer id whose wait for `commit` is short, so the test does not wait minutes.
fn short_spread_computer(commit: &str) -> String {
    (0u32..).map(|at| format!("{at:064x}")).find(|id| spread_ms(&row(&[]), id, commit, false) < 200).unwrap()
}

#[test]
fn a_follower_that_has_switched_is_started_again_on_each_newer_signed_release_it_is_given() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let stop = AtomicBool::new(false);
    let table = Arc::new(Table::default());
    let nine_body = body(b"engine-v9", &[]);
    let nine = entry(&commit('9'), 9, TARGET, &nine_body, false, PRIVATE);
    let ten_body = body(b"engine-v10", &[]);
    let ten = entry(&commit('a'), 10, TARGET, &ten_body, false, PRIVATE);
    table.put(&nine.url, nine_body);
    table.put(&ten.url, ten_body);
    table.put("https://feed.test/a.json", serde_json::to_vec(&json_feed(&[&nine])).unwrap());
    let feed = ReleaseFeed {
        urls: vec!["https://feed.test/a.json".to_owned()],
        public_keys: vec![public(PRIVATE)],
        releases: releases.clone(),
    };
    let computer = short_spread_computer(&commit('9'));
    // This process runs sequence 5 and switches to 9; it returns the commit so the process can end for its app to start it.
    let first = Follower::new(feed.row(TARGET), feed.releases.clone(), running(5), computer.clone(), table.clone(), Arc::new(Logged::default()), Duration::from_millis(5));
    assert_eq!(first.follow(&stop), Some(commit('9')));
    assert_eq!(current_commit(&releases), Some(commit('9')));
    // The next process runs 9, and the feed now names 10: it switches again. Each newer signed release is taken.
    table.put("https://feed.test/a.json", serde_json::to_vec(&json_feed(&[&nine, &ten])).unwrap());
    let computer = short_spread_computer(&commit('a'));
    let second = Follower::new(feed.row(TARGET), feed.releases.clone(), running(9), computer, table.clone(), Arc::new(Logged::default()), Duration::from_millis(5));
    assert_eq!(second.follow(&stop), Some(commit('a')));
    assert_eq!(current_commit(&releases), Some(commit('a')));
    // Nothing newer, and a stop: the loop ends without a switch.
    let third = Follower::new(feed.row(TARGET), feed.releases.clone(), running(10), short_spread_computer(&commit('a')), table, Arc::new(Logged::default()), Duration::from_millis(5));
    stop.store(true, Ordering::Release);
    assert_eq!(third.follow(&stop), None);
}

#[cfg(owner_files = "posix")]
#[test]
fn a_body_is_taken_from_the_next_feed_host_when_the_first_is_dead_or_holds_other_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let stop = AtomicBool::new(false);
    let table = Table::default();
    let good = body(b"engine-v7", &[]);
    let release = entry(&commit('7'), 7, TARGET, &good, false, PRIVATE);
    let mut other = good.clone();
    let last = other.len() - 1;
    other[last] ^= 1;
    table.put(&format!("https://wrong.test/{}.tar.gz", commit('7')), other);
    table.put(&format!("https://live.test/{}.tar.gz", commit('7')), good.clone());
    let feeds = [
        "https://dead.test/feed.json".to_owned(),
        "https://wrong.test/feed.json".to_owned(),
        "https://live.test/feed.json".to_owned(),
    ];
    adopt(&release, &feeds, &releases, &table, &stop).unwrap();
    assert_eq!(current_commit(&releases), Some(commit('7')));
    assert_eq!(fs::read(releases.join("current").join("trillion-local")).unwrap(), b"engine-v7");
    assert_eq!(
        adopt(&release, &feeds[..2], &dir.path().join("only-dead"), &table, &stop),
        Err(crate::cause!(Refusal::ContentMismatch)),
        "the hosts that answer hold other bytes, so nothing is taken"
    );
}

/// A release folder as `adopt` leaves it: the program and the kept entry, nothing else.
fn kept_by_hand(releases: &Path, entry: &Entry, program: &[u8]) {
    let folder = releases.join(&entry.commit);
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join(BINARY), program).unwrap();
    fs::write(folder.join(ENTRY_KEPT), serde_json::to_vec(entry).unwrap()).unwrap();
}

#[cfg(owner_files = "posix")]
#[test]
fn the_app_verbs_choose_mark_ready_and_roll_back_through_the_one_check() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    fs::create_dir_all(&releases).unwrap();
    let five = entry(&commit('5'), 5, TARGET, &body(b"engine-v5", &[]), false, PRIVATE);
    let six = entry(&commit('6'), 6, TARGET, &body(b"engine-v6", &[]), false, PRIVATE);
    kept_by_hand(&releases, &five, b"engine-v5");
    kept_by_hand(&releases, &six, b"engine-v6");
    let keys = vec![public(PRIVATE)];
    let run = running(4);
    assert!(choose_current(&releases, &run, &row(&keys)).is_err(), "no current: the bundled engine runs");
    assert!(!mark_ready(&releases, "not-a-commit"));
    assert!(mark_ready(&releases, &commit('5')));
    assert_eq!(linked_commit(&releases, READY), Some(commit('5')));
    assert!(point(&releases, CURRENT, &commit('6')));
    assert_eq!(choose_current(&releases, &run, &row(&keys)).map(|chosen| chosen.commit).ok(), Some(commit('6')));
    assert!(choose_current(&releases, &run, &row(&[public(OTHER_PRIVATE)])).is_err(), "a key the feed does not list refuses it");
    assert_eq!(roll_back(&releases, &commit('6'), &run, &row(&keys)).unwrap(), Some(commit('5')), "current goes back to ready");
    assert!(rolled_back(&releases, &commit('6')));
    assert_eq!(current_commit(&releases), Some(commit('5')));
    assert_eq!(roll_back(&releases, &commit('5'), &run, &row(&keys)).unwrap(), None, "ready is the failed release: current is removed");
    assert_eq!(current_commit(&releases), None);
    let mut none = Vec::new();
    choose_command(&mut none, &releases, &keys).unwrap();
    assert_eq!(String::from_utf8(none).unwrap(), "{\"reason\":\"release_none\",\"verified\":false}\n");
    assert!(choose_command(&mut Vec::new(), &releases, &[]).is_err(), "a choice needs a feed key");
}

#[cfg(owner_files = "posix")]
#[test]
fn a_refused_choice_names_the_first_check_that_failed_and_verify_judges_an_entry_file_alone() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    fs::create_dir_all(&releases).unwrap();
    let run = running(4);
    let keys = vec![public(PRIVATE)];
    let reason = |releases: &Path, keys: &[String]| match choose_current(releases, &run, &row(keys)) {
        Ok(_) => String::new(),
        Err(refusal) => refusal.code().to_owned(),
    };
    let signed = entry(&commit('5'), 5, TARGET, &body(b"engine-v5", &[]), false, PRIVATE);
    kept_by_hand(&releases, &signed, b"engine-v5");
    point(&releases, "current", &commit('5'));
    assert_eq!(reason(&releases, &[public(OTHER_PRIVATE)]), "release_signature_refused");
    assert_eq!(reason(&releases, &keys), "", "a verified choice has no reason");
    let other_target = entry(&commit('6'), 6, "aarch64-apple-test", &body(b"engine-v6", &[]), false, PRIVATE);
    kept_by_hand(&releases, &other_target, b"engine-v6");
    point(&releases, "current", &commit('6'));
    assert_eq!(reason(&releases, &keys), "release_target_absent");
    let older = entry(&commit('3'), 3, TARGET, &body(b"engine-v3", &[]), false, PRIVATE);
    kept_by_hand(&releases, &older, b"engine-v3");
    point(&releases, "current", &commit('3'));
    assert_eq!(reason(&releases, &keys), "release_older");
    fs::write(releases.join(format!("{}.{REFUSED}", commit('3'))), b"").unwrap();
    assert_eq!(reason(&releases, &keys), "release_rolled_back");
    fs::remove_file(releases.join(format!("{}.{REFUSED}", commit('3')))).unwrap();
    fs::remove_file(releases.join(commit('3')).join(BINARY)).unwrap();
    assert_eq!(reason(&releases, &keys), "release_content_mismatch");
    let file = dir.path().join("entry.json");
    fs::write(&file, serde_json::to_vec(&signed).unwrap()).unwrap();
    let mut out = Vec::new();
    verify_command(&mut out, &file, &keys).unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), "{\"verified\":true}\n");
    let mut out = Vec::new();
    verify_command(&mut out, &file, &[public(OTHER_PRIVATE)]).unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), "{\"verified\":false}\n");
    assert!(verify_command(&mut Vec::new(), &file, &[]).is_err(), "a verdict needs a feed key");
}

#[test]
fn a_row_takes_only_entries_signed_over_its_own_domain_and_its_own_keys() {
    let body = body(b"engine", &[]);
    let signed_for_engine = entry(&commit('a'), 3, TARGET, &body, false, PRIVATE);
    let mut workshop = row(&[public(PRIVATE)]);
    workshop.domain = "trillion-workshop-release-v1".to_owned();
    let choice = choose(std::slice::from_ref(&signed_for_engine), &running(0), &workshop);
    assert_eq!(choice.take, None, "an engine signature is not a Workshop one");
    assert_eq!(choice.refused[0].0.code(), "release_signature_refused");
    assert_eq!(choose(std::slice::from_ref(&signed_for_engine), &running(0), &row(&[public(PRIVATE)])).take.map(|entry| entry.sequence), Some(3));
}

#[test]
fn a_switch_removes_the_releases_the_row_does_not_keep_and_keeps_current_ready_running_and_the_newest() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    fs::create_dir_all(&releases).unwrap();
    for sequence in 1..=6u64 {
        let released = entry(&commit(char::from_digit(sequence as u32, 16).unwrap()), sequence, TARGET, &body(b"engine", &[]), false, PRIVATE);
        kept_by_hand(&releases, &released, b"engine");
    }
    assert!(point(&releases, CURRENT, &commit('6')));
    assert!(mark_ready(&releases, &commit('2')));
    fs::write(releases.join(format!("{}.{REFUSED}", commit('1'))), b"").unwrap();
    let mut row = row(&[public(PRIVATE)]);
    row.keep_newest = 1;
    prune(&releases, &row, &Running { commit: commit('3'), sequence: 0, target: TARGET.to_owned() });
    let remaining: Vec<String> = { let mut names: Vec<String> = fs::read_dir(&releases).unwrap().flatten().map(|folder| folder.file_name().to_string_lossy().into_owned())
        .filter(|name| lower_hex(name, 40)).collect(); names.sort(); names };
    assert_eq!(remaining, [commit('2'), commit('3'), commit('6')], "current, ready, the running one and the newest kept; 1, 4 and 5 are removed");
    assert!(releases.join(format!("{}.{REFUSED}", commit('1'))).exists(), "a refused mark stays, so the release is never taken again");
    // With none of the newest kept, current and ready still stay, and a running release that is not here is no concern.
    row.keep_newest = 0;
    prune(&releases, &row, &Running { commit: commit('9'), sequence: 0, target: TARGET.to_owned() });
    assert_eq!(fs::read_dir(&releases).unwrap().flatten().filter(|folder| lower_hex(&folder.file_name().to_string_lossy(), 40)).count(), 2);
}

/// A place that holds nothing and records each take it is given.
struct Recording {
    running: Running,
    taken: Mutex<Vec<String>>,
    ends: bool,
}

impl Place for Recording {
    fn key(&self) -> String {
        format!("recording:{:p}", self)
    }
    fn held(&self) -> bool {
        false
    }

    fn running(&self, _row: &Row) -> Running {
        self.running.clone()
    }

    fn refused(&self, _commit: &str) -> bool {
        false
    }

    fn adopt(&self, entry: &Entry, _row: &Row, _fetch: &dyn Fetch, _stop: &AtomicBool) -> Result<(), Refusal> {
        self.taken.lock().unwrap().push(entry.commit.clone());
        Ok(())
    }

    fn ends_on_switch(&self) -> bool {
        self.ends
    }
}

#[test]
fn one_follower_looks_at_every_row_and_only_a_switch_that_ends_it_stops_the_loop() {
    let keys = vec![public(PRIVATE)];
    let table = Arc::new(Table::default());
    let a = entry(&commit('a'), 2, TARGET, &body(b"a", &[]), false, PRIVATE);
    let b = entry(&commit('b'), 3, TARGET, &body(b"b", &[]), false, PRIVATE);
    table.put("https://feed.test/a.json", serde_json::to_vec(&serde_json::json!({"releases": [a]})).unwrap());
    table.put("https://feed.test/b.json", serde_json::to_vec(&serde_json::json!({"releases": [b]})).unwrap());
    // A row's spread is zero here, so each take is immediate; the test's rows read their own feed URL.
    let row_at = |url: &str| Row { urls: vec![url.to_owned()], spread_ms: 0, urgent_spread_ms: 0, ..row(&keys) };
    let workshop_like = Arc::new(Recording { running: running(0), taken: Mutex::new(Vec::new()), ends: false });
    let engine_like = Arc::new(Recording { running: running(0), taken: Mutex::new(Vec::new()), ends: true });
    let follower = Follower::empty("computer".to_owned(), Arc::new(Logged::default()), Duration::from_millis(5));
    follower.add(Watch { row: row_at("https://feed.test/a.json"), place: workshop_like.clone(), fetch: table.clone() });
    follower.add(Watch { row: row_at("https://feed.test/b.json"), place: engine_like.clone(), fetch: table.clone() });
    assert_eq!(follower.follow(&AtomicBool::new(false)), Some(commit('b')), "the engine's switch ends the loop");
    assert_eq!(workshop_like.taken.lock().unwrap().as_slice(), [commit('a')], "a Workshop row takes its release and the loop goes on");
    assert_eq!(engine_like.taken.lock().unwrap().as_slice(), [commit('b')]);
}

#[test]
fn a_row_waiting_out_its_spread_never_holds_up_another_row_and_a_foreign_target_is_never_its_release() {
    let keys = vec![public(PRIVATE)];
    let table = Arc::new(Table::default());
    let workshop_target = "workshop-tools";
    // The Workshop row's newer entry is for its own target; it waits a long spread, which must not block the engine row.
    let tools = entry(&commit('t'), 9, workshop_target, &body(b"tools", &[]), false, PRIVATE);
    let engine = entry(&commit('e'), 3, TARGET, &body(b"engine", &[]), false, PRIVATE);
    table.put("https://feed.test/tools.json", serde_json::to_vec(&serde_json::json!({"releases": [tools]})).unwrap());
    table.put("https://feed.test/engine.json", serde_json::to_vec(&serde_json::json!({"releases": [engine]})).unwrap());
    let tools_row = Row { target: workshop_target.to_owned(), urls: vec!["https://feed.test/tools.json".to_owned()], spread_ms: 600_000, urgent_spread_ms: 600_000, ..row(&keys) };
    let long_wait = (0u32..).map(|at| format!("{at:064x}")).find(|id| spread_ms(&tools_row, id, &commit('t'), false) > 60_000).unwrap();
    let workshop_like = Arc::new(Recording { running: Running { commit: commit('0'), sequence: 0, target: workshop_target.to_owned() }, taken: Mutex::new(Vec::new()), ends: false });
    let engine_like = Arc::new(Recording { running: running(0), taken: Mutex::new(Vec::new()), ends: true });
    let follower = Follower::empty(long_wait, Arc::new(Logged::default()), Duration::from_millis(5));
    follower.add(Watch { row: tools_row, place: workshop_like.clone(), fetch: table.clone() });
    follower.add(Watch { row: Row { urls: vec!["https://feed.test/engine.json".to_owned()], spread_ms: 0, urgent_spread_ms: 0, ..row(&keys) }, place: engine_like.clone(), fetch: table.clone() });
    let started = std::time::Instant::now();
    assert_eq!(follower.follow(&AtomicBool::new(false)), Some(commit('e')), "the engine row switches while the Workshop row waits");
    assert!(started.elapsed() < Duration::from_secs(20), "no row waits behind another");
    assert!(workshop_like.taken.lock().unwrap().is_empty(), "the Workshop row has not reached its spread's end");
}

#[test]
fn a_place_added_again_keeps_one_watch_and_its_chosen_wait_across_looks() {
    // Each connection of an account adds its Workshop place again. The place keeps one row, and the commit it chose keeps the
    // time it may be adopted, so a later look never starts the wait over (it logged the same choice each second).
    let keys = vec![public(PRIVATE)];
    let table = Arc::new(Table::default());
    let tools = entry(&commit('c'), 9, "workshop-tools", &body(b"tools", &[]), false, PRIVATE);
    table.put("https://feed.test/tools.json", serde_json::to_vec(&serde_json::json!({"releases": [tools]})).unwrap());
    let tools_row = Row { target: "workshop-tools".to_owned(), urls: vec!["https://feed.test/tools.json".to_owned()], spread_ms: 600_000, urgent_spread_ms: 600_000, ..row(&keys) };
    let place = Arc::new(Recording { running: Running { commit: commit('0'), sequence: 0, target: "workshop-tools".to_owned() }, taken: Mutex::new(Vec::new()), ends: false });
    let follower = Follower::empty("computer".to_owned(), Arc::new(Logged::default()), Duration::from_millis(5));
    follower.add(Watch { row: tools_row.clone(), place: place.clone(), fetch: table.clone() });
    follower.add(Watch { row: tools_row, place: place.clone(), fetch: table.clone() });
    assert_eq!(follower.snapshot().len(), 1, "a place added again replaces its watch");
    let stop = AtomicBool::new(false);
    let watch = follower.snapshot()[0].clone();
    assert!(matches!(follower.look(&watch, &stop), Step::Kept));
    let first = follower.waiting.lock().unwrap().get(&place.key()).cloned().expect("the chosen commit waits");
    assert!(matches!(follower.look(&watch, &stop), Step::Kept));
    let second = follower.waiting.lock().unwrap().get(&place.key()).cloned().expect("it still waits");
    assert_eq!(first, second, "the chosen commit keeps its ready time across looks");
    assert_eq!(first.0, commit('c'));
    assert!(place.taken.lock().unwrap().is_empty(), "the spread has not ended, so nothing is taken");
}

#[test]
fn a_chosen_commit_is_announced_once_until_another_is_chosen() {
    let follower = Follower::empty("computer".to_owned(), Arc::new(Logged::default()), Duration::from_millis(5));
    assert!(follower.announce("place", &commit('c')), "the first choice is logged");
    assert!(!follower.announce("place", &commit('c')), "the same choice again, after a restarted wait, is not logged");
    assert!(follower.announce("place", &commit('d')), "a new choice is logged");
    assert!(follower.announce("place", &commit('c')), "a choice that returns after another is logged again");
}

#[test]
fn an_entry_older_than_the_running_release_is_not_logged_as_a_refusal() {
    // Every older release in a feed is refused by each look; that is the normal state, so it is not one log line per entry.
    let keys = vec![public(PRIVATE)];
    let table = Arc::new(Table::default());
    let older = entry(&commit('c'), 9, "workshop-tools", &body(b"tools", &[]), false, PRIVATE);
    table.put("https://feed.test/tools.json", serde_json::to_vec(&serde_json::json!({"releases": [older]})).unwrap());
    let tools_row = Row { target: "workshop-tools".to_owned(), urls: vec!["https://feed.test/tools.json".to_owned()], ..row(&keys) };
    let place = Arc::new(Recording { running: Running { commit: commit('0'), sequence: 50, target: "workshop-tools".to_owned() }, taken: Mutex::new(Vec::new()), ends: false });
    let follower = Follower::empty("computer".to_owned(), Arc::new(Logged::default()), Duration::from_millis(5));
    follower.add(Watch { row: tools_row, place: place.clone(), fetch: table.clone() });
    let watch = follower.snapshot()[0].clone();
    let stop = AtomicBool::new(false);
    assert!(matches!(follower.look(&watch, &stop), Step::Kept));
    assert!(follower.logged.all().iter().all(|(refusal, _)| !matches!(refusal, Refusal::Older(_))), "no older entry is logged");
    assert!(place.taken.lock().unwrap().is_empty(), "an older release is never taken");
}

#[cfg(owner_files = "posix")]
#[test]
fn a_full_volume_prunes_to_the_keep_rule_before_any_download_and_refuses_when_still_no_room() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    fs::create_dir_all(&releases).unwrap();
    for sequence in 1..=5u64 {
        let released = entry(&commit(char::from_digit(sequence as u32, 16).unwrap()), sequence, TARGET, &body(b"engine", &[]), false, PRIVATE);
        kept_by_hand(&releases, &released, b"engine");
    }
    let stop = AtomicBool::new(false);
    let table = Table::default();
    let next_body = body(b"engine-6", &[]);
    let next = entry(&commit('6'), 6, TARGET, &next_body, false, PRIVATE);
    table.put(&next.url, next_body);
    let place = EnginePlace { releases: releases.clone(), running: Running { commit: commit('f'), sequence: 0, target: TARGET.to_owned() } };
    let row = row(&[public(PRIVATE)]);
    let folders = |releases: &Path| -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(releases).unwrap().flatten().map(|folder| folder.file_name().to_string_lossy().into_owned())
            .filter(|name| lower_hex(name, 40)).collect();
        names.sort();
        names
    };
    set_free_for_test(Some(0));
    assert_eq!(place.adopt(&next, &row, &table, &stop), Err(crate::cause!(Refusal::NoRoom)));
    assert_eq!(folders(&releases), [commit('3'), commit('4'), commit('5')], "the row's keep rule frees room first; the new release is not downloaded");
    assert!(!releases.join(format!("{}.{DOWNLOADING}", commit('6'))).exists());
    set_free_for_test(None);
    set_free_for_test(Some(u64::MAX));
    place.adopt(&next, &row, &table, &stop).unwrap();
    assert_eq!(folders(&releases), [commit('4'), commit('5'), commit('6')], "after a switch the keep rule holds again");
    set_free_for_test(None);
}

#[cfg(owner_files = "posix")]
#[test]
fn a_symlink_named_as_a_release_is_never_removed() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    fs::create_dir_all(&releases).unwrap();
    let released = entry(&commit('1'), 1, TARGET, &body(b"engine", &[]), false, PRIVATE);
    kept_by_hand(&releases, &released, b"engine");
    let elsewhere = dir.path().join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, releases.join(commit('2'))).unwrap();
    let mut row = row(&[public(PRIVATE)]);
    row.keep_newest = 0;
    prune(&releases, &row, &Running { commit: commit('9'), sequence: 0, target: TARGET.to_owned() });
    assert!(releases.join(commit('2')).symlink_metadata().is_ok(), "a link is not a release folder");
    assert!(elsewhere.is_dir(), "the link's target is untouched");
    assert!(!releases.join(commit('1')).exists(), "the kept release is pruned as the rule says");
}

#[cfg(owner_files = "posix")]
#[test]
fn a_program_row_adopts_its_own_binary_into_its_own_folder_and_a_body_without_it_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("relay");
    let stop = AtomicBool::new(false);
    let table = Table::default();
    let program = body_named("trillion-mcp-forwarder", b"forwarder-v9", &[]);
    let release = entry(&commit('9'), 9, TARGET, &program, false, PRIVATE);
    table.put(&release.url, program);
    adopt_program(&release, &feeds(), &releases, &table, &stop, "trillion-mcp-forwarder").unwrap();
    assert_eq!(fs::read(releases.join("current").join("trillion-mcp-forwarder")).unwrap(), b"forwarder-v9");
    assert!(!releases.join(commit('9')).join("trillion-local").exists());
    let engine = body(b"engine-v10", &[]);
    let engine_release = entry(&commit('a'), 10, TARGET, &engine, false, PRIVATE);
    table.put(&engine_release.url, engine);
    assert!(adopt_program(&engine_release, &feeds(), &releases, &table, &stop, "trillion-mcp-forwarder").is_err(), "a body without its program is refused");
    assert_eq!(current_commit(&releases), Some(commit('9')), "a refused body never switches current");
}

#[cfg(owner_files = "posix")]
#[test]
fn a_taken_release_keeps_its_verified_body_and_the_feed_serves_the_newest_kept_entries() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let stop = AtomicBool::new(false);
    let table = Table::default();
    let place = EnginePlace { releases: releases.clone(), running: Running { commit: commit('f'), sequence: 0, target: TARGET.to_owned() } };
    let mut row = row(&[public(PRIVATE)]);
    row.keep_newest = 2;
    let mut taken = Vec::new();
    for sequence in 1..=3u64 {
        let released_body = body(format!("engine-{sequence}").as_bytes(), &[]);
        let released = entry(&commit(char::from_digit(sequence as u32, 16).unwrap()), sequence, TARGET, &released_body, false, PRIVATE);
        table.put(&released.url, released_body.clone());
        place.adopt(&released, &row, &table, &stop).unwrap();
        taken.push((released, released_body));
    }
    let served_feed: serde_json::Value = serde_json::from_slice(&fs::read(releases.join(FEED)).unwrap()).unwrap();
    let served: Vec<Entry> = serde_json::from_value(served_feed["releases"].clone()).unwrap();
    assert_eq!(served, vec![taken[2].0.clone(), taken[1].0.clone()], "the newest keep_newest kept entries, unchanged, newest first");
    for (released, released_body) in &taken[1..] {
        assert_eq!(fs::read(releases.join(served_body(&released.commit))).unwrap(), *released_body, "the verified body is kept as served");
    }
    use std::os::unix::fs::PermissionsExt as _;
    for served_file in [releases.join(FEED), releases.join(served_body(&taken[2].0.commit))] {
        assert_eq!(fs::metadata(&served_file).unwrap().permissions().mode() & 0o777, 0o644, "the place's web server reads it");
    }
    assert!(!releases.join(served_body(&commit('1'))).exists(), "a pruned release's body goes with its folder");
    assert!(!releases.join(commit('1')).exists());
}

#[test]
fn a_feed_alone_takes_the_newer_signed_release_and_answers_its_commit_for_a_computer_that_cannot_start() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let stop = AtomicBool::new(false);
    let table = Arc::new(Table::default());
    let nine_body = body(b"engine-v9", &[]);
    let nine = entry(&commit('9'), 9, TARGET, &nine_body, false, PRIVATE);
    table.put(&nine.url, nine_body);
    table.put("https://feed.test/a.json", serde_json::to_vec(&json_feed(&[&nine])).unwrap());
    let feed = ReleaseFeed {
        urls: vec!["https://feed.test/a.json".to_owned()],
        public_keys: vec![public(PRIVATE)],
        releases: releases.clone(),
    };
    let computer = short_spread_computer(&commit('9'));
    let switched = follow_feed_alone(&feed, running(5), computer, table.clone(), Duration::from_millis(5), &stop);
    assert_eq!(switched, Some(commit('9')));
    assert_eq!(current_commit(&releases), Some(commit('9')));
    // A stop with nothing newer ends the follow without a switch.
    stop.store(true, Ordering::Release);
    assert_eq!(follow_feed_alone(&feed, running(9), short_spread_computer(&commit('a')), table, Duration::from_millis(5), &stop), None);
}

// ---- incident 17 (a feed carries another product's newer release): the follower takes only its own product's entry ----

/// Incident 17: one feed holds a newer release for another product (the Workshop, signed over its own domain and keys).
/// The engine's follower must not choose it; it takes the newest engine release above its own.
fn feed_newer_entry_for_another_product_is_not_chosen_body() -> std::result::Result<(), String> {
    let bytes = body(b"engine", &[]);
    let engine_row = row(&[public(PRIVATE)]);
    let mut workshop_entry = entry(&commit('9'), 40, TARGET, &bytes, false, OTHER_PRIVATE);
    workshop_entry.signature = content_crypto::Ed25519Signature::sign(&workshop_entry.signed_bytes("trillion-workshop-release-v1"), OTHER_PRIVATE)
        .map_err(|error| format!("the Workshop entry could not be signed: {error:?}"))?;
    let entries = vec![entry(&commit('4'), 6, TARGET, &bytes, false, PRIVATE), workshop_entry];
    match choose(&entries, &running(5), &engine_row).take {
        Some(taken) if taken.commit == commit('4') => Ok(()),
        Some(taken) => Err(format!("the follower took {} (sequence {}), another product's release", taken.commit, taken.sequence)),
        None => Err("the follower took nothing, though the engine's release is above its own".into()),
    }
}

#[test]
fn feed_newer_entry_for_another_product_is_not_chosen() {
    crate::simulation::verdict("feed-newer-entry-for-another-product-is-not-chosen", feed_newer_entry_for_another_product_is_not_chosen_body);
}

// ---- incident 9 (served release files at mode 0600 answer 403): the feed a web server reads is world-readable ----

/// Incident 9: `feed.json` is published for the place's web server, which reads it as another user. A file a service
/// writes at 0600 answers 403 there, so the health check that reads it can never pass.
fn served_feed_file_is_world_readable_body() -> std::result::Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    publish_feed(dir.path(), 1, &[]);
    let mode = fs::metadata(dir.path().join(FEED)).map_err(|error| error.to_string())?.permissions().mode() & 0o777;
    if mode & 0o044 == 0o044 {
        Ok(())
    } else {
        Err(format!("feed.json is mode {mode:o}: a web server reading it as another user answers 403"))
    }
}

#[test]
fn served_feed_file_is_world_readable() {
    crate::simulation::verdict("served-release-file-is-world-readable", served_feed_file_is_world_readable_body);
}

#[test]
fn a_release_that_never_becomes_ready_falls_back_to_the_ready_one_once_its_starts_are_spent() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let stop = AtomicBool::new(false);
    let table = Table::default();
    let ready_body = body(b"engine-v5", &[]);
    let ready_entry = entry(&commit('5'), 5, TARGET, &ready_body, false, PRIVATE);
    table.put(&ready_entry.url, ready_body);
    adopt(&ready_entry, &feeds(), &releases, &table, &stop).unwrap();
    assert!(mark_ready(&releases, &commit('5')));
    let bad_body = body(b"engine-v9", &[]);
    let bad_entry = entry(&commit('9'), 9, TARGET, &bad_body, false, PRIVATE);
    table.put(&bad_entry.url, bad_body);
    adopt(&bad_entry, &feeds(), &releases, &table, &stop).unwrap();
    assert!(point(&releases, CURRENT, &commit('9')));
    let row = row(&[public(PRIVATE)]);
    let running = Running { commit: commit('9'), sequence: 9, target: TARGET.to_owned() };
    // Two starts that never became ready are allowed; the third goes back to the ready release.
    assert_eq!(fall_back_when_spent(&releases, &running, &row, 2), None);
    assert_eq!(fall_back_when_spent(&releases, &running, &row, 2), None);
    assert_eq!(fall_back_when_spent(&releases, &running, &row, 2), Some(commit('5')));
    assert_eq!(current_commit(&releases), Some(commit('5')));
    assert!(releases.join(format!("{}.{REFUSED}", commit('9'))).exists(), "the release that failed is never taken again");
    // The ready release itself counts nothing.
    let ready_running = Running { commit: commit('5'), sequence: 5, target: TARGET.to_owned() };
    assert_eq!(fall_back_when_spent(&releases, &ready_running, &row, 2), None);
    assert!(!releases.join(ATTEMPTS).exists(), "a ready release leaves no count");
}

/// A program's release kept by hand, as `kept_by_hand` keeps the engine's: its own binary and its entry.
fn kept_program_by_hand(releases: &Path, entry: &Entry, binary: &str) {
    let folder = releases.join(&entry.commit);
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join(binary), b"relay-program").unwrap();
    fs::write(folder.join(ENTRY_KEPT), serde_json::to_vec(entry).unwrap()).unwrap();
}

#[cfg(owner_files = "posix")]
#[test]
fn a_relays_program_marks_ready_switches_and_rolls_back_through_the_same_check_over_its_own_binary() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("trillion-mcp-forwarder");
    fs::create_dir_all(&releases).unwrap();
    let target = Running::this_binary().target;
    let five = entry(&commit('5'), 5, &target, &body_named("trillion-mcp-forwarder", b"v5", &[]), false, PRIVATE);
    let six = entry(&commit('6'), 6, &target, &body_named("trillion-mcp-forwarder", b"v6", &[]), false, PRIVATE);
    kept_program_by_hand(&releases, &five, "trillion-mcp-forwarder");
    kept_program_by_hand(&releases, &six, "trillion-mcp-forwarder");
    let keys = vec![public(PRIVATE)];
    let said = |args: Vec<String>| {
        let mut out = Vec::new();
        let answer = program_command("trillion-mcp-forwarder", &args, &mut out);
        (answer.map_err(|refusal| refusal.to_string()), String::from_utf8(out).unwrap())
    };
    let folder = releases.display().to_string();
    assert!(said(vec!["ready".into(), folder.clone(), commit('5')]).0.is_ok());
    assert!(said(vec!["switch".into(), folder.clone(), commit('6')]).0.is_ok());
    assert_eq!(current_commit(&releases), Some(commit('6')));
    // The program's own verb checks `ready` for the program's own binary, so `current` goes back to it.
    let back = said(vec!["roll-back".into(), folder.clone(), commit('6'), keys[0].clone()]);
    assert!(back.0.is_ok(), "{:?}", back.0);
    assert_eq!(back.1.trim(), format!("{{\"current\":\"{}\"}}", commit('5')));
    assert_eq!(current_commit(&releases), Some(commit('5')));
    assert!(rolled_back(&releases, &commit('6')), "the release that was rolled back is never taken again");
    assert!(said(vec!["switch".into(), folder.clone(), commit('6')]).0.is_err(), "a refused release is not switched to");
    assert!(said(vec!["roll-back".into(), folder, commit('5')]).0.is_err(), "a roll-back needs a feed key");
    assert!(said(vec!["unknown".into()]).0.is_err());
    let bare = said(Vec::new());
    assert!(bare.0.is_ok() && bare.1.contains("sequence "), "no verb prints this release");
}

/// A place whose adoption is always refused for want of room.
struct NoRoomPlace;

impl Place for NoRoomPlace {
    fn key(&self) -> String {
        format!("no-room:{:p}", self)
    }
    fn held(&self) -> bool {
        false
    }

    fn running(&self, _row: &Row) -> Running {
        running(0)
    }

    fn refused(&self, _commit: &str) -> bool {
        false
    }

    fn adopt(&self, _entry: &Entry, _row: &Row, _fetch: &dyn Fetch, _stop: &AtomicBool) -> Result<(), Refusal> {
        Err(crate::cause!(Refusal::NoRoom))
    }

    fn ends_on_switch(&self) -> bool {
        true
    }
}

#[test]
fn a_release_refused_for_want_of_room_stays_named_in_the_follower_until_one_is_taken() {
    let keys = vec![public(PRIVATE)];
    let table = Arc::new(Table::default());
    let newer = entry(&commit('a'), 3, TARGET, &body(b"a", &[]), false, PRIVATE);
    table.put("https://feed.test/a.json", serde_json::to_vec(&serde_json::json!({"releases": [newer]})).unwrap());
    let follower = Follower::empty("computer".to_owned(), Arc::new(Logged::default()), Duration::from_millis(5));
    follower.add(Watch {
        row: Row { urls: vec!["https://feed.test/a.json".to_owned()], spread_ms: 0, urgent_spread_ms: 0, ..row(&keys) },
        place: Arc::new(NoRoomPlace),
        fetch: table,
    });
    assert_eq!(follower.room_refused(), None);
    assert_eq!(follower.step(&AtomicBool::new(false)), Step::Kept);
    assert_eq!(follower.room_refused(), Some(commit('a')), "the refusal stays named for the computer's report");
}

#[test]
fn a_look_names_what_it_did_for_the_report_and_a_refusal_is_named_too() {
    let keys = vec![public(PRIVATE)];
    let table = Arc::new(Table::default());
    // Nothing newer than the running release (sequence 5): the row's outcome is nothing-newer.
    let older = entry(&commit('3'), 3, TARGET, &body(b"3", &[]), false, PRIVATE);
    table.put("https://feed.test/a.json", serde_json::to_vec(&serde_json::json!({"releases": [older]})).unwrap());
    let quiet = Follower::new(Row { urls: vec!["https://feed.test/a.json".to_owned()], ..row(&keys) }, PathBuf::from("/nonexistent"), running(5), "computer".to_owned(), table.clone(), Arc::new(Logged::default()), Duration::from_millis(5));
    assert!(quiet.outcomes().is_empty(), "no look yet, so no outcome");
    assert_eq!(quiet.step(&AtomicBool::new(false)), Step::Kept);
    assert_eq!(quiet.outcomes(), vec![(TARGET.to_owned(), Outcome::NothingNewer)]);
    // A newer release that the place refuses for room is named as refused by its check.
    let newer = entry(&commit('a'), 9, TARGET, &body(b"a", &[]), false, PRIVATE);
    table.put("https://feed.test/a.json", serde_json::to_vec(&serde_json::json!({"releases": [newer]})).unwrap());
    let refused = Follower::empty("computer".to_owned(), Arc::new(Logged::default()), Duration::from_millis(5));
    refused.add(Watch { row: Row { urls: vec!["https://feed.test/a.json".to_owned()], spread_ms: 0, urgent_spread_ms: 0, ..row(&keys) }, place: Arc::new(NoRoomPlace), fetch: table });
    assert_eq!(refused.step(&AtomicBool::new(false)), Step::Kept);
    assert_eq!(refused.outcomes(), vec![(TARGET.to_owned(), Outcome::Refused("release_no_room"))]);
}

#[test]
fn a_holder_walk_passes_over_an_unreachable_holder_then_wrong_bytes_and_keeps_the_third() {
    let mut asked = Vec::new();
    let walk = first_verified(
        ["down.example", "wrong.example", "good.example", "unasked.example"],
        |host| {
            asked.push(*host);
            match *host {
                "down.example" => Err("unreachable"),
                "wrong.example" => Ok(b"other".to_vec()),
                _ => Ok(b"mark".to_vec()),
            }
        },
        |_, bytes| if bytes == b"mark" { Ok(bytes) } else { Err("wrong bytes") },
    );
    assert_eq!(walk.verified, Some(b"mark".to_vec()));
    assert_eq!(asked, ["down.example", "wrong.example", "good.example"]);
    assert_eq!(walk.passed_over, ["unreachable", "wrong bytes"]);
}
