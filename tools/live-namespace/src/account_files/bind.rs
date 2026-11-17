// src/account_files/bind.rs
//
// Purpose: Bind an account's real stores to the account files they belong to, on purpose. A store that is not on this
// computer's loopback takes new bytes only from an account's files whose own binding its origin record names
// (`Origin::bound_to`, checked in `AccountFiles::write_file`). The binding is a random id kept INSIDE the account files, in
// its one `@namespace/home` record, and the origin names it tied to the account (`tie`). This is the one step that
// says "this account files is the real one for these stores": run it once when the store file is installed, and again for
// a store file whose origins were never bound (or were bound under the old way, a folder's inode). It is trillion-local's
// own subcommand (`account-files-bind`, src/main.rs), so the install ships no second program. `show` only prints each
// origin and whether it is bound to this account files.
//
// The threat it answers, and the one it no longer answers:
// - Guarded: an account's files that is not the account's own writing new bytes into the account's real bucket. That is a
//   store file built or edited to point at a real bucket (an origin record copied in, an import, a test fixture), an
//   origin record taken from another account or from an older binding, and a record never bound at all. None of these
//   holds a home record whose binding the origin names for this account, so the write is refused before any byte is
//   sent (`account_files_origin_not_bound`).
// - No longer a refusal: a copy of the account's whole folder (placement copying it to another computer, a restore). The
//   old check read the folder's inode and creation time from the file system, so every copy was refused, including
//   the legitimate copies a computer makes. The binding travels with the account files, so a copy or restore still opens and
//   writes. What a copy cannot do is write for another account or without the binding. A copy made only to try
//   something (a proof) is not told apart by identity any more: it must point its origins at a loopback stand-in
//   (examples/account_files_standin.rs), as the README says. There is no step yet that gives a copy a binding of its own.
// Non-Negotiable Invariants:
// - The binding is read from the account files' own record and checked against the origin's record; it is never read
//   from the file system or from a path, so it survives any copy of the folder.
// - The binding is random, made once, and never changed by a later bind; `tie` joins it to the account, so another
//   account's origin record never fits it.
// - Only origins that take new bytes and are off loopback are bound; a loopback origin (the stand-in) needs none.
// - Each record is written naming the version read, so a change made meanwhile is never overwritten. No request
//   reaches any store.
// - It refuses (except `show`) a folder holding a `local-runtime.lock`: an app may be serving that state, so bind
//   with the app quit.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{objects::{Origin, Source}, FILES, HOME, HOME_KIND, ORIGINS};
use crate::{
    records::{Mutation, Records, MAX_PAGE_ITEMS},
    sqlite_work::WorkMeter,
    storage::record_store_resources,
};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::json;
use std::{io::Write, path::Path};

type Failure = Box<dyn std::error::Error>;

/// The id of the account files' one home record.
const HOME_ID: &str = "this";
/// The bytes of a new binding.
const BINDING_BYTES: usize = 16;

/// What an origin of `account` names in `bound_to` when it is bound to the account files whose binding is `binding`: the
/// BLAKE3 of the account and the binding, so a binding never fits another account.
pub fn tie(account: &str, binding: &str) -> String {
    let mut bytes = Vec::new();
    for part in [HOME_KIND, account, binding] {
        bytes.extend_from_slice(&(part.len() as u64).to_be_bytes());
        bytes.extend_from_slice(part.as_bytes());
    }
    content_crypto::hash(&bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The binding `account`'s account files in `store` holds, when it was bound.
pub fn binding_in<R: Records>(store: &R, account: &str) -> Option<String> {
    let record = store.get(account, HOME, HOME_ID).ok()?.record?;
    record.value.get("binding").and_then(|binding| binding.as_str()).filter(|binding| binding.len() == BINDING_BYTES * 2).map(str::to_owned)
}

/// Bind (or, with `show`, only report) the origins of `account` in the account files store file `store`, printing one JSON
/// line per origin to `out`.
pub fn run(store: &Path, account: &str, show: bool, out: &mut dyn Write) -> Result<(), Failure> {
    let path = crate::io_operation!(std::fs::canonicalize(store))?;
    let folder = path.parent().ok_or(crate::refusal_cause::CodedError::new("a store file has a folder"))?;
    if !show && folder.join("local-runtime.lock").exists() {
        return Err(crate::refusal_cause::CodedError::new("the folder holds a local-runtime.lock: an app may be serving it; quit the app first").into());
    }
    let mut records = record_store_resources::open(&path, WorkMeter::new())?;
    let binding = match binding_in(&records, account) {
        Some(binding) => binding,
        None if show => String::new(),
        None => new_home(&mut records, account)?,
    };
    let identity = tie(account, &binding);
    let origins: Vec<(String, Origin)> = records
        .list_page(account, ORIGINS, "", MAX_PAGE_ITEMS)?
        .items
        .into_iter()
        .map(|record| Ok((record.id, serde_json::from_value(record.value).map_err(|error| { let cause = crate::refusal_cause::Caused::cause(&error); crate::refusal_cause::CodedError::with_cause(error, cause) })?)))
        .collect::<Result<_, crate::refusal_cause::CodedError<serde_json::Error>>>()?;
    for (id, mut origin) in origins {
        let bound_here = !binding.is_empty() && origin.bound_to.as_deref() == Some(identity.as_str());
        if show || !origin.takes_new_bytes || origin.is_loopback() {
            crate::io_operation!(writeln!(out, "{}", json!({ "origin": id, "takes_new_bytes": origin.takes_new_bytes, "loopback": origin.is_loopback(), "bound_to_this_namespace": bound_here })))?;
            continue;
        }
        if bound_here {
            crate::io_operation!(writeln!(out, "{}", json!({ "origin": id, "already_bound": true })))?;
            continue;
        }
        origin.bound_to = Some(identity.clone());
        let value = serde_json::to_value(&origin).map_err(|error| { let cause = crate::refusal_cause::Caused::cause(&error); crate::refusal_cause::CodedError::with_cause(error, cause) })?;
        let (version, _) = records.held_record_with_version(account, ORIGINS, &id)?;
        let request_key = format!("{id}@{version}@{identity}");
        let change = records.mutate(account, ORIGINS, Mutation { id: id.clone(), expected_version: version, request_key, deleted: false, value })?;
        crate::io_operation!(writeln!(out, "{}", json!({ "origin": id, "bound": true, "version_before": version, "version": change.version })))?;
    }
    Ok(())
}

/// Write `account`'s one home record with a fresh random binding into `records`, which holds none yet (version 0), and
/// answer the binding.
fn new_home<R: Records>(records: &mut R, account: &str) -> Result<String, Failure> {
    let mut bytes = [0u8; BINDING_BYTES];
    SystemRandom::new().fill(&mut bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause("the operating system's random source did not answer", crate::refusal_cause::Caused::cause(&error)))?;
    let binding: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let value = json!({ "kind": HOME_KIND, "binding": binding });
    records.mutate(account, HOME, Mutation { id: HOME_ID.into(), expected_version: 0, request_key: format!("home@{binding}"), deleted: false, value })?;
    Ok(binding)
}

/// Make a new account's own files store in the state folder `state`, at the file the files are placed in there
/// (src/storage/record_store_resources.json), the way its records store is made (src/account/create.rs `write_records`):
/// empty, with its home record and its own random binding, and no origin yet (an origin the account adds later is bound
/// with `run`). A new account made at a computer (`trillion-local account create`, a sign-up) answered its files
/// unavailable (step `no_store_file`) until someone ran `install` by hand (measured on place-fsn1, 2026-11-04). Old
/// trillion gave every account its files with no step of its own (Trillion-X/trillion tag old-trillion-before-worker-retire,
/// src/namespace-book-resource.mjs:1-2, the account's RecordBook is started on demand, and :243, the
/// account's files store is mounted on its first use, `mounted ??= makeNativeNamespaceMount(...)`).
/// Refuses when the state folder already holds a files store: an account's files are never made twice.
///
/// With `files` (the making computer's config `new_accounts.files`, `NewAccountFiles`), the account also gets its first
/// byte store: one origin record that takes new bytes, under its own key prefix in the computer's store, bound to this
/// account's files (`tie`), its secret held in the account's vault (`vault`) as a SigV4 signing root, which never
/// leaves the vault (src/secrets.rs `Secrets::plain` refuses it; only a day key is made, for the engine's own request).
/// Without one, a new account's `write_file_piece` answered "the account has no store that takes new bytes" (measured
/// on place-fsn1, 2026-11-04). Old trillion kept every account's bytes in one store under the account's own prefix
/// (Trillion-X/trillion tag old-trillion-before-worker-retire, src/resource-placement.json:42,
/// the one bytes binding every account's files used); here each computer names its own store.
pub fn make_new(state: &Path, account: &str, files: Option<&NewAccountFiles>) -> Result<(), Failure> {
    let target = record_store_resources::placement(FILES).and_then(|placement| placement.in_state(state)).ok_or(crate::refusal_cause::CodedError::new("the namespace has no placement in a state folder"))?;
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(crate::refusal_cause::CodedError::new("the state folder already holds a namespace store").into());
    }
    let mut records = record_store_resources::open(&target, WorkMeter::new())?;
    let binding = new_home(&mut records, account)?;
    if let Some(files) = files {
        let names = &super::settings::settings().new_account_files;
        let held = crate::secrets::held_name(&names.secret_service, &names.secret_field)?;
        let origin = Origin {
            kind: super::ORIGIN_KIND.to_owned(),
            rank: names.rank,
            takes_new_bytes: true,
            file_key_prefix: format!("{}{account}/", files.key_prefix),
            reach: super::objects::Reach {
                key_id: Source::Value(files.key_id.clone()),
                secret: Source::Held(held),
                bucket: Source::Value(files.bucket.clone()),
                endpoint: Source::Value(files.endpoint.clone()),
                region: Source::Value(files.region.clone()),
            },
            bound_to: Some(tie(account, &binding)),
        };
        let value = serde_json::to_value(&origin).map_err(|error| { let cause = crate::refusal_cause::Caused::cause(&error); crate::refusal_cause::CodedError::with_cause(error, cause) })?;
        records.mutate(account, ORIGINS, Mutation { id: names.origin_id.clone(), expected_version: 0,
            request_key: format!("first-origin@{binding}"), deleted: false, value })?;
    }
    Ok(())
}

/// The byte store a computer gives each account it makes (its config's `new_accounts.files`): an S3-compatible store
/// (`endpoint`, `bucket`, `region`), the key id it signs with, the prefix every account's own prefix starts with (the
/// account's owner id and a `/` follow). The store's secret is never in this row: the engine attaches it to the run as the
/// `files-store` connection's `secret` field (`secrets::Held`), and the origin record names it by vault name.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct NewAccountFiles {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub key_id: String,
    pub key_prefix: String,
}

impl NewAccountFiles {
    /// Whether the row holds together: an https endpoint (or http on loopback, a stand-in), names with no control
    /// character, and a prefix that is empty or ends with `/` and has no `..`.
    pub fn valid(&self) -> bool {
        let endpoint = url::Url::parse(&self.endpoint).ok();
        let loopback = |url: &url::Url| matches!(url.host(), Some(url::Host::Domain("localhost")))
            || matches!(url.host(), Some(url::Host::Ipv4(address)) if address.is_loopback());
        let endpoint_ok = endpoint.is_some_and(|url| url.scheme() == "https" || (url.scheme() == "http" && loopback(&url)));
        let plain = |text: &str| !text.is_empty() && text.len() <= 512 && !text.chars().any(char::is_control);
        endpoint_ok && plain(&self.bucket) && plain(&self.region) && plain(&self.key_id)
            && (self.key_prefix.is_empty() || (self.key_prefix.ends_with('/') && !self.key_prefix.split('/').any(|part| part == "..")))
            && !self.key_prefix.chars().any(char::is_control)
    }
}

/// Install the files store file `store` as the files store of the state folder `state`: bind it (as `run`), then move
/// it to the file the files store is put in there (src/storage/record_store_resources.json). The door never creates a store, so
/// until this an account answers that its files store is unavailable (step `no_store_file`). Refuses when the state folder
/// already holds a files store, and when a write-ahead log or journal is beside the store (a writer may still be
/// open). It is one rename, so the store must be on the state folder's volume; nothing is copied, and the folder it
/// leaves holds no second copy. The app may be serving the state folder: the door opens the files store for each call and
/// never creates one, so the next call simply finds it.
pub fn install(store: &Path, account: &str, state: &Path, out: &mut dyn Write) -> Result<(), Failure> {
    let store = crate::io_operation!(std::fs::canonicalize(store))?;
    let state = crate::io_operation!(std::fs::canonicalize(state))?;
    let target = record_store_resources::placement(FILES).and_then(|placement| placement.in_state(&state)).ok_or(crate::refusal_cause::CodedError::new("the namespace has no placement in a state folder"))?;
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(crate::refusal_cause::CodedError::new(format!("{} already holds a namespace store; nothing was changed", state.display())).into());
    }
    let beside = || ["-wal", "-journal"].iter().any(|suffix| {
        std::fs::metadata(format!("{}{suffix}", store.display())).is_ok_and(|metadata| metadata.len() > 0)
    });
    if beside() {
        return Err(crate::refusal_cause::CodedError::new("a write-ahead log or journal is beside the store: close every writer of it first").into());
    }
    run(&store, account, false, out)?;
    if beside() {
        return Err(crate::refusal_cause::CodedError::new("a writer of the store left a write-ahead log beside it: close it, then install again").into());
    }
    crate::io_operation!(std::fs::rename(&store, &target))?;
    crate::io_operation!(writeln!(out, "{}", json!({ "installed": target.display().to_string() })))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_files::objects::{Reach, Source};

    fn origin(endpoint: &str, takes: bool) -> Origin {
        Origin {
            kind: "namespace-origin".into(),
            rank: 1,
            takes_new_bytes: takes,
            file_key_prefix: "p/".into(),
            bound_to: None,
            reach: Reach {
                key_id: Source::Value("k".into()),
                secret: Source::Held("s".into()),
                bucket: Source::Value("b".into()),
                endpoint: Source::Value(endpoint.into()),
                region: Source::Value("r".into()),
            },
        }
    }

    /// A canonical state folder holding a store file with a real origin, a drained one and a loopback one.
    fn state() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let path = record_store_resources::placement(crate::account_files::FILES).and_then(|placement| placement.in_state(&root)).unwrap();
        let mut store = record_store_resources::open(&path, WorkMeter::new()).unwrap();
        for (id, origin) in [("real", origin("https://s3.example.test", true)), ("drained", origin("https://old.example.test", false)), ("local", origin("http://127.0.0.1:9", true))] {
            let value = serde_json::to_value(&origin).unwrap();
            store.mutate("a", ORIGINS, Mutation { id: id.into(), expected_version: 0, request_key: format!("prefill-{id}"), deleted: false, value }).unwrap();
        }
        (dir, path)
    }

    fn lines(path: &Path, show: bool) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        run(path, "a", show, &mut out).unwrap();
        String::from_utf8(out).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn bound_to(path: &Path, id: &str) -> Option<String> {
        let store = record_store_resources::open(path, WorkMeter::new()).unwrap();
        let record = store.get("a", ORIGINS, id).unwrap().record.unwrap();
        serde_json::from_value::<Origin>(record.value).unwrap().bound_to
    }

    fn binding(path: &Path) -> Option<String> {
        binding_in(&record_store_resources::open(path, WorkMeter::new()).unwrap(), "a")
    }

    #[test]
    fn install_binds_the_store_and_moves_it_into_an_empty_state_folder_once() {
        let (_from, path) = state();
        let live = tempfile::tempdir().unwrap();
        let mut out = Vec::new();
        install(&path, "a", live.path(), &mut out).unwrap();
        let target = record_store_resources::placement(FILES).and_then(|placement| placement.in_state(&std::fs::canonicalize(live.path()).unwrap())).unwrap();
        assert!(!path.exists(), "the store left its old place; no copy stays behind");
        let made = binding(&target).expect("installed bound");
        assert_eq!(bound_to(&target, "real"), Some(tie("a", &made)));
        assert!(String::from_utf8(out).unwrap().contains("installed"));
        let (_other, second) = state();
        assert!(install(&second, "a", live.path(), &mut Vec::new()).is_err(), "a state folder that holds a namespace is never replaced");
        assert!(second.exists());
        assert_eq!(binding(&target), Some(made));
    }

    #[test]
    fn bind_binds_only_the_real_store_that_takes_new_bytes_to_its_own_account_files_and_is_repeatable() {
        let (_dir, path) = state();
        let shown = lines(&path, true);
        assert!(shown.iter().all(|line| line["bound_to_this_namespace"] == false), "{shown:?}");
        assert_eq!(bound_to(&path, "real"), None, "show wrote nothing");
        assert_eq!(binding(&path), None, "show made no binding");
        let done = lines(&path, false);
        assert_eq!(done.iter().filter(|line| line["bound"] == true).count(), 1, "{done:?}");
        let made = binding(&path).expect("bind made the account files' binding");
        assert_eq!(made.len(), 32);
        assert_eq!(bound_to(&path, "real"), Some(tie("a", &made)));
        assert_eq!(bound_to(&path, "drained"), None);
        assert_eq!(bound_to(&path, "local"), None);
        assert!(lines(&path, false).iter().any(|line| line["already_bound"] == true), "a second bind changes nothing");
        assert_eq!(binding(&path), Some(made), "a second bind keeps the binding");
    }

    /// The case the folder's inode refused: the account's folder copied to another folder or computer, or restored. The binding is
    /// inside the account files, so the copy is bound exactly as the original was, with no step and nothing read from the
    /// file system.
    #[test]
    fn a_copy_or_restore_of_a_bound_account_files_is_still_bound() {
        let (_dir, path) = state();
        lines(&path, false);
        let copy = tempfile::tempdir().unwrap();
        let copied = std::fs::canonicalize(copy.path()).unwrap().join(path.file_name().unwrap());
        std::fs::copy(&path, &copied).unwrap();
        assert_eq!(binding(&copied), binding(&path));
        let shown = lines(&copied, true);
        assert!(shown.iter().any(|line| line["origin"] == "real" && line["bound_to_this_namespace"] == true), "{shown:?}");
        assert_eq!(bound_to(&copied, "real"), bound_to(&path, "real"));
    }

    /// What is still refused: an origin bound under the old way (a folder's inode), for another account, or for another
    /// account files' binding is not bound to this account files, and a bind makes it so only on purpose.
    #[test]
    fn an_origin_bound_the_old_way_or_for_another_account_or_account_files_is_not_bound_here() {
        let (_dir, path) = state();
        lines(&path, false);
        let mine = binding(&path).unwrap();
        assert_ne!(tie("a", &mine), tie("b", &mine), "a binding never fits another account");
        assert_ne!(tie("a", &mine), tie("a", &"0".repeat(32)), "another account files' binding does not fit");
        assert_ne!(tie("a", ""), tie("a", &mine));
        for wrong in ["12345:1700000000.000000001".to_owned(), tie("b", &mine), tie("a", &"0".repeat(32))] {
            let mut store = record_store_resources::open(&path, WorkMeter::new()).unwrap();
            let (version, record) = store.held_record_with_version("a", ORIGINS, "real").unwrap();
            let mut origin: Origin = serde_json::from_value(record.unwrap().value).unwrap();
            origin.bound_to = Some(wrong.clone());
            let value = serde_json::to_value(&origin).unwrap();
            store.mutate("a", ORIGINS, Mutation { id: "real".into(), expected_version: version, request_key: format!("wrong-{wrong}"), deleted: false, value }).unwrap();
            drop(store);
            let shown = lines(&path, true);
            assert!(shown.iter().any(|line| line["origin"] == "real" && line["bound_to_this_namespace"] == false), "{wrong}: {shown:?}");
            assert_eq!(binding(&path), Some(mine.clone()), "show keeps the binding");
            assert!(lines(&path, false).iter().any(|line| line["origin"] == "real" && line["bound"] == true));
            assert_eq!(bound_to(&path, "real"), Some(tie("a", &mine)));
        }
    }

    #[test]
    fn a_folder_with_a_running_apps_lock_is_not_bound() {
        let (_dir, path) = state();
        std::fs::write(path.parent().unwrap().join("local-runtime.lock"), b"{}").unwrap();
        assert!(run(&path, "a", false, &mut Vec::new()).is_err());
        assert!(run(&path, "a", true, &mut Vec::new()).is_ok(), "show only reads");
    }
}
