use super::*;
use crate::native_entry::computer::releases::{numbers, ReleaseFeed};
use std::collections::HashMap;
use std::sync::Mutex;

const PRIVATE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_PRIVATE: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const FEED: &str = "https://engine-releases.test/engine-releases/product-settings-feed.json";

fn public(private: &str) -> String {
    content_crypto::Ed25519Signature::public_key_from_private(private).unwrap()
}

fn commit(byte: char) -> String {
    byte.to_string().repeat(40)
}

/// The served settings bodies by URL, or by the path under a feed's folder (a relative `url` is answered at any feed host).
#[derive(Default)]
struct Served(Mutex<HashMap<String, Vec<u8>>>);

impl Served {
    fn put(&self, url: &str, bytes: &[u8]) {
        self.0.lock().unwrap().insert(url.to_owned(), bytes.to_vec());
    }
}

impl releases::Fetch for Served {
    fn get(&self, url: &str, limit: u64, into: &mut dyn io::Write, _stop: &AtomicBool) -> io::Result<u64> {
        let bytes = self.0.lock().unwrap().iter()
            .find(|(key, _)| url == key.as_str() || url.ends_with(&format!("/{key}")))
            .map(|(_, bytes)| bytes.clone())
            .ok_or_else(|| io::Error::other("no answer"))?;
        if bytes.len() as u64 > limit {
            return Err(io::Error::other("over its bound"));
        }
        into.write_all(&bytes)?;
        Ok(bytes.len() as u64)
    }
}

/// A place's restart that records each restart and answers ready from a script: `ready` is the answer for each call in order,
/// then the last answer is repeated.
struct Place {
    ready: Mutex<Vec<bool>>,
    restarts: Mutex<usize>,
}

impl Place {
    fn new(ready: &[bool]) -> Self {
        Self { ready: Mutex::new(ready.to_vec()), restarts: Mutex::new(0) }
    }
    fn restarts(&self) -> usize {
        *self.restarts.lock().unwrap()
    }
}

impl Restart for Place {
    fn restart(&self) -> Result<(), CodedError<&'static str>> {
        *self.restarts.lock().unwrap() += 1;
        Ok(())
    }
    fn ready(&self, _stop: &AtomicBool) -> bool {
        let mut ready = self.ready.lock().unwrap();
        if ready.len() > 1 { ready.remove(0) } else { ready[0] }
    }
}

fn settings_entry(body: &[u8], private: &str) -> Entry {
    let mut entry = Entry {
        commit: commit('a'),
        sequence: 3,
        target: TARGET.to_owned(),
        url: format!("{TARGET}/{}.json", content_crypto::advanced::blake3::hash(body).to_hex()),
        content: format!("1f:{}", content_crypto::advanced::blake3::hash(body).to_hex()),
        bytes: body.len() as u64,
        urgent: false,
        signature: String::new(),
    };
    entry.signature = content_crypto::Ed25519Signature::sign(&entry.signed_bytes_bound(&numbers().release_domain), private).unwrap();
    entry
}

fn row() -> Row {
    ReleaseFeed { urls: vec![FEED.to_owned()], public_keys: vec![public(PRIVATE)], releases: PathBuf::new() }.row(TARGET)
}

/// A place's settings file in a temporary folder, holding `previous` (or nothing), and the served bodies.
fn place_with(previous: Option<&[u8]>) -> (tempfile::TempDir, PathBuf, Served) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("product-settings.json");
    if let Some(bytes) = previous {
        fs::write(&path, bytes).unwrap();
    }
    (dir, path, Served::default())
}

fn code(result: Result<(), CodedError<&'static str>>) -> &'static str {
    *result.expect_err("refused")
}

#[test]
fn a_signed_settings_entry_is_kept_when_the_place_answers_ready_and_the_previous_file_is_kept_beside_it() {
    let (_dir, path, served) = place_with(Some(b"{\"word\":\"old\"}"));
    let body = b"{\"word\":\"new\"}".to_vec();
    let entry = settings_entry(&body, PRIVATE);
    served.put(&entry.url, &body);
    let place = Place::new(&[true]);

    adopt(&entry, &row(), &path, &served, &place, &AtomicBool::new(false)).unwrap();

    assert_eq!(fs::read(&path).unwrap(), body, "the new settings are in place");
    assert_eq!(fs::read(sibling(&path, PREVIOUS)).unwrap(), b"{\"word\":\"old\"}", "the previous file is kept beside it");
    use std::os::unix::fs::PermissionsExt as _;
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600, "owner only");
    assert_eq!(place.restarts(), 1, "one restart, on the new settings");
}

#[test]
fn a_place_that_does_not_come_back_ready_gets_the_previous_settings_back_and_is_restarted_on_them() {
    let previous = b"{\"word\":\"old\"}".to_vec();
    let (_dir, path, served) = place_with(Some(&previous));
    let body = b"{\"word\":\"new\"}".to_vec();
    let entry = settings_entry(&body, PRIVATE);
    served.put(&entry.url, &body);
    let place = Place::new(&[false, true]);

    assert_eq!(code(adopt(&entry, &row(), &path, &served, &place, &AtomicBool::new(false))), "settings_reverted");
    assert_eq!(fs::read(&path).unwrap(), previous, "the previous settings are back");
    assert_eq!(place.restarts(), 2, "restarted on the new settings, then on the previous ones");
}

#[test]
fn a_place_that_does_not_come_back_ready_on_the_previous_settings_either_is_named_as_not_restored() {
    let previous = b"{\"word\":\"old\"}".to_vec();
    let (_dir, path, served) = place_with(Some(&previous));
    let body = b"{\"word\":\"new\"}".to_vec();
    let entry = settings_entry(&body, PRIVATE);
    served.put(&entry.url, &body);
    let place = Place::new(&[false]);

    assert_eq!(code(adopt(&entry, &row(), &path, &served, &place, &AtomicBool::new(false))), "settings_restore_failed");
    assert_eq!(fs::read(&path).unwrap(), previous, "the previous file is still written back");
}

#[test]
fn a_settings_entry_signed_by_another_key_or_for_another_target_changes_nothing() {
    let previous = b"{\"word\":\"old\"}".to_vec();
    let (_dir, path, served) = place_with(Some(&previous));
    let body = b"{\"word\":\"new\"}".to_vec();
    let other_key = settings_entry(&body, OTHER_PRIVATE);
    served.put(&other_key.url, &body);
    let place = Place::new(&[true]);
    assert_eq!(code(adopt(&other_key, &row(), &path, &served, &place, &AtomicBool::new(false))), "settings_signature_refused");

    let mut other_target = settings_entry(&body, PRIVATE);
    other_target.target = "engine".to_owned();
    assert_eq!(code(adopt(&other_target, &row(), &path, &served, &place, &AtomicBool::new(false))), "settings_target_refused");

    assert_eq!(fs::read(&path).unwrap(), previous, "nothing is written");
    assert_eq!(place.restarts(), 0, "nothing restarts");
}

#[test]
fn a_host_that_serves_other_bytes_is_passed_over_and_no_settings_change_when_no_host_holds_them() {
    let previous = b"{\"word\":\"old\"}".to_vec();
    let (_dir, path, served) = place_with(Some(&previous));
    let body = b"{\"word\":\"new\"}".to_vec();
    let entry = settings_entry(&body, PRIVATE);
    served.put(&entry.url, b"{\"word\":\"tampered\"}");
    let place = Place::new(&[true]);

    assert_eq!(code(adopt(&entry, &row(), &path, &served, &place, &AtomicBool::new(false))), "settings_unreachable");
    assert_eq!(fs::read(&path).unwrap(), previous, "the file the place has is still the one it had");
    assert_eq!(place.restarts(), 0);
}

#[test]
fn the_url_is_a_path_under_the_feed_so_a_host_named_inside_the_entry_is_never_asked() {
    let (_dir, path, served) = place_with(None);
    let body = b"{\"word\":\"new\"}".to_vec();
    let mut entry = settings_entry(&body, PRIVATE);
    entry.url = format!("https://elsewhere.test/{}.json", commit('b'));
    served.put(&entry.url, &body);
    let place = Place::new(&[true]);

    assert_eq!(code(adopt(&entry, &row(), &path, &served, &place, &AtomicBool::new(false))), "settings_signature_refused", "a url the signature does not cover is refused before any fetch");
}

/// An entry the publisher signed (trillion-workshop `productSettingsEntry`, the engine's v2 bound text), with its body and
/// the public key it verifies with: the engine's own check accepts it, so the publisher and the place agree on the text.
#[test]
fn a_publisher_signed_settings_entry_is_accepted_by_the_engine_check_and_adopted() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("settings_feed_fixture.json")).unwrap();
    let entry: Entry = serde_json::from_value(fixture["entry"].clone()).unwrap();
    let body = fixture["body"].as_str().unwrap().as_bytes().to_vec();
    let public_key = fixture["public_key"].as_str().unwrap().to_owned();
    let row = ReleaseFeed { urls: vec![FEED.to_owned()], public_keys: vec![public_key], releases: PathBuf::new() }.row(TARGET);
    let (_dir, path, served) = place_with(None);
    served.put(&entry.url, &body);
    let place = Place::new(&[true]);

    assert!(entry.signed_by(&row), "the engine's own check accepts the publisher's signature");
    adopt(&entry, &row, &path, &served, &place, &AtomicBool::new(false)).unwrap();
    assert_eq!(fs::read(&path).unwrap(), body, "the publisher's settings are kept");
}

#[test]
fn a_look_adopts_only_the_newest_signed_settings_entry_above_the_one_kept_and_then_nothing_newer() {
    let (_dir, path, served) = place_with(Some(b"{\"word\":\"old\"}"));
    let engine_feed = "https://engine-releases.test/engine-releases/feed.json";
    let row = ReleaseFeed { urls: vec![engine_feed.to_owned()], public_keys: vec![public(PRIVATE)], releases: PathBuf::new() }.row(TARGET);
    let older_body = b"{\"word\":\"two\"}".to_vec();
    let newer_body = b"{\"word\":\"three\"}".to_vec();
    let mut older = settings_entry(&older_body, PRIVATE);
    older.sequence = 2;
    older.signature = content_crypto::Ed25519Signature::sign(&older.signed_bytes_bound(&numbers().release_domain), PRIVATE).unwrap();
    let mut newer = settings_entry(&newer_body, PRIVATE);
    newer.sequence = 3;
    newer.signature = content_crypto::Ed25519Signature::sign(&newer.signed_bytes_bound(&numbers().release_domain), PRIVATE).unwrap();
    let mut forged = settings_entry(b"{\"word\":\"forged\"}", OTHER_PRIVATE);
    forged.sequence = 4;
    served.put(&older.url, &older_body);
    served.put(&newer.url, &newer_body);
    served.put("product-settings-feed.json", serde_json::to_vec(&serde_json::json!({"releases": [older, newer, forged]})).unwrap().as_slice());
    let place = Place::new(&[true]);
    let stop = AtomicBool::new(false);

    assert_eq!(look(&[engine_feed.to_owned()], &row, &path, &served, &place, &stop).unwrap(), Some(3), "the newest signed entry is kept");
    assert_eq!(fs::read(&path).unwrap(), newer_body);
    assert_eq!(look(&[engine_feed.to_owned()], &row, &path, &served, &place, &stop).unwrap(), None, "nothing newer is adopted twice");
    assert_eq!(place.restarts(), 1, "one restart for the one adoption");
}
