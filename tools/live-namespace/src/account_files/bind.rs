// src/account_files/bind.rs
//
// Purpose: Bind an account's real stores to the account files they belong to, on purpose. A store that is not on this
// computer's loopback takes new bytes only from an account's files whose own binding its origin record names
// (`Origin::bound_to`, checked in `AccountFiles::write_file`). The binding is a random id kept INSIDE the account files, in
// its one `@namespace/home` record, and the origin names it tied to the account (`tie`). This is the one step that
// says "this account files is the real one for these stores": run it once when the rows are made, and again for
// rows whose origins were never bound (or were bound under the old way, a folder's inode). It is this tool's own subcommand
// (`account-files-bind`, src/main.rs). `show` only prints each origin and whether it is bound to this account files.
//
// The threat it answers, and the one it no longer answers:
// - Guarded: an account's files that is not the account's own writing new bytes into the account's real bucket. That is a
//   database built or edited to point at a real bucket (an origin record copied in, an import, a test fixture), an
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
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{objects::{Origin, Source}, HOME, HOME_KIND, ORIGINS};
use crate::store::{Mutation, Store, MAX_PAGE_ITEMS};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::json;
use std::io::Write;

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

/// The binding the account files in `store` hold, when they were bound.
pub fn binding_in(store: &Store) -> Option<String> {
    let record = store.get(HOME, HOME_ID).ok()?.record?;
    record.value.get("binding").and_then(|binding| binding.as_str()).filter(|binding| binding.len() == BINDING_BYTES * 2).map(str::to_owned)
}

/// Bind (or, with `show`, only report) the origins of `account` in `store`, printing one JSON line per origin to `out`.
pub fn run(store: &Store, account: &str, show: bool, out: &mut dyn Write) -> Result<(), Failure> {
    let binding = match binding_in(store) {
        Some(binding) => binding,
        None if show => String::new(),
        None => new_home(store)?,
    };
    let identity = tie(account, &binding);
    let origins: Vec<(String, Origin)> = store
        .list_page(ORIGINS, "", MAX_PAGE_ITEMS)?
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
        let (version, _) = store.held_record_with_version(ORIGINS, &id)?;
        let request_key = format!("{id}@{version}@{identity}");
        let change = store.mutate(ORIGINS, Mutation { id: id.clone(), expected_version: version, request_key, deleted: false, value })?;
        crate::io_operation!(writeln!(out, "{}", json!({ "origin": id, "bound": true, "version_before": version, "version": change.version })))?;
    }
    Ok(())
}

/// Write the account files' one home record with a fresh random binding into `store`, which holds none yet (version 0), and
/// answer the binding.
fn new_home(store: &Store) -> Result<String, Failure> {
    let mut bytes = [0u8; BINDING_BYTES];
    SystemRandom::new().fill(&mut bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause("the operating system's random source did not answer", crate::refusal_cause::Caused::cause(&error)))?;
    let binding: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let value = json!({ "kind": HOME_KIND, "binding": binding });
    store.mutate(HOME, Mutation { id: HOME_ID.into(), expected_version: 0, request_key: format!("home@{binding}"), deleted: false, value })?;
    Ok(binding)
}

/// Make the account's own files in `store`: the home record with its own random binding, and with `files` (`NewAccountFiles`) its
/// first byte store: one origin record that takes new bytes, under its own key prefix in the store, bound to these files (`tie`),
/// its secret named by its held value (`secrets::Held`), which never leaves the run (`Secrets::plain` refuses it; only a day key is
/// made, for the engine's own request). Without one, `write_file_piece` answers "the account has no store that takes new bytes".
/// Refuses when `store` already holds files: an account's files are never made twice.
pub fn make_new(store: &Store, account: &str, files: Option<&NewAccountFiles>) -> Result<(), Failure> {
    if binding_in(store).is_some() {
        return Err(crate::refusal_cause::CodedError::new("the database already holds these files").into());
    }
    let binding = new_home(store)?;
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
        store.mutate(ORIGINS, Mutation { id: names.origin_id.clone(), expected_version: 0,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_files::objects::{Reach, Source};
    use crate::store::SqlStore;
    use std::sync::Arc;

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

    /// A store holding a real origin, a drained one and a loopback one.
    fn state() -> Store {
        let store: Store = Arc::new(SqlStore::memory().unwrap());
        for (id, origin) in [("real", origin("https://s3.example.test", true)), ("drained", origin("https://old.example.test", false)), ("local", origin("http://127.0.0.1:9", true))] {
            let value = serde_json::to_value(&origin).unwrap();
            store.mutate(ORIGINS, Mutation { id: id.into(), expected_version: 0, request_key: format!("prefill-{id}"), deleted: false, value }).unwrap();
        }
        store
    }

    fn lines(store: &Store, show: bool) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        run(store, "a", show, &mut out).unwrap();
        String::from_utf8(out).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn bound_to(store: &Store, id: &str) -> Option<String> {
        let record = store.get(ORIGINS, id).unwrap().record.unwrap();
        serde_json::from_value::<Origin>(record.value).unwrap().bound_to
    }

    #[test]
    fn bind_binds_only_the_real_store_that_takes_new_bytes_to_its_own_account_files_and_is_repeatable() {
        let store = state();
        let shown = lines(&store, true);
        assert!(shown.iter().all(|line| line["bound_to_this_namespace"] == false), "{shown:?}");
        assert_eq!(bound_to(&store, "real"), None, "show wrote nothing");
        assert_eq!(binding_in(&store), None, "show made no binding");
        let done = lines(&store, false);
        assert_eq!(done.iter().filter(|line| line["bound"] == true).count(), 1, "{done:?}");
        let made = binding_in(&store).expect("bind made the account files' binding");
        assert_eq!(made.len(), 32);
        assert_eq!(bound_to(&store, "real"), Some(tie("a", &made)));
        assert_eq!(bound_to(&store, "drained"), None);
        assert_eq!(bound_to(&store, "local"), None);
        assert!(lines(&store, false).iter().any(|line| line["already_bound"] == true), "a second bind changes nothing");
        assert_eq!(binding_in(&store), Some(made), "a second bind keeps the binding");
    }

    /// The binding is inside the rows, so the same rows read from another handle are bound exactly as the first was.
    #[test]
    fn a_second_handle_on_the_same_rows_sees_the_same_binding() {
        let first = Arc::new(SqlStore::memory().unwrap());
        let store: Store = first.clone();
        for (id, origin) in [("real", origin("https://s3.example.test", true))] {
            store.mutate(ORIGINS, Mutation { id: id.into(), expected_version: 0, request_key: format!("prefill-{id}"), deleted: false, value: serde_json::to_value(&origin).unwrap() }).unwrap();
        }
        lines(&store, false);
        let other: Store = Arc::new(first.same_database());
        assert_eq!(binding_in(&other), binding_in(&store));
        let shown = lines(&other, true);
        assert!(shown.iter().any(|line| line["origin"] == "real" && line["bound_to_this_namespace"] == true), "{shown:?}");
    }

    /// What is refused: an origin bound under the old way (a folder's inode), for another account, or for another
    /// account files' binding is not bound to these files, and a bind makes it so only on purpose.
    #[test]
    fn an_origin_bound_the_old_way_or_for_another_account_or_account_files_is_not_bound_here() {
        let store = state();
        lines(&store, false);
        let mine = binding_in(&store).unwrap();
        assert_ne!(tie("a", &mine), tie("b", &mine), "a binding never fits another account");
        assert_ne!(tie("a", &mine), tie("a", &"0".repeat(32)), "another account files' binding does not fit");
        assert_ne!(tie("a", ""), tie("a", &mine));
        for wrong in ["12345:1700000000.000000001".to_owned(), tie("b", &mine), tie("a", &"0".repeat(32))] {
            let (version, record) = store.held_record_with_version(ORIGINS, "real").unwrap();
            let mut origin: Origin = serde_json::from_value(record.unwrap().value).unwrap();
            origin.bound_to = Some(wrong.clone());
            let value = serde_json::to_value(&origin).unwrap();
            store.mutate(ORIGINS, Mutation { id: "real".into(), expected_version: version, request_key: format!("wrong-{wrong}"), deleted: false, value }).unwrap();
            let shown = lines(&store, true);
            assert!(shown.iter().any(|line| line["origin"] == "real" && line["bound_to_this_namespace"] == false), "{wrong}: {shown:?}");
            assert_eq!(binding_in(&store), Some(mine.clone()), "show keeps the binding");
            assert!(lines(&store, false).iter().any(|line| line["origin"] == "real" && line["bound"] == true));
            assert_eq!(bound_to(&store, "real"), Some(tie("a", &mine)));
        }
    }

    #[test]
    fn files_are_made_once() {
        let store: Store = Arc::new(SqlStore::memory().unwrap());
        make_new(&store, "a", None).unwrap();
        assert!(binding_in(&store).is_some());
        assert!(make_new(&store, "a", None).is_err(), "an account's files are never made twice");
    }
}
