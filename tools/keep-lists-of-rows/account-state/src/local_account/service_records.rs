//! The operator account's records every account reads, published by their one owner into the APP_KV its readers
//! read (`service-record:{label}`, read by `show_rule_service_record` in show_rules.rs).
//!
//! Original owners: old trillion src/service-records.mjs `publishServiceRecords` and
//! src/service-record-publication.mjs (at 6eba138637~1).
//!
//! Non-Negotiable Invariants:
//!   1. Only the account whose user id is the selected OPERATOR_ACCOUNT_ID publishes; the check is the account the
//!      owner was opened for, never a request value. Any other account publishes nothing.
//!   2. What is published is DATA (the installed tools' service-records.json, show_rules/data.json): a workspace record is published as itself when its
//!      label is named by `labels` (or starts with one of `prefixes`), it is not `derived`, and `own_record_sources`
//!      names that label (or prefix) as its own workspace source. No label is named here.
//!   3. One record is one versioned key, `service-record:{label}` holding { label, value, identity, at }. A
//!      publication no newer than the kept one (kept `at` greater), or with the same identity, writes nothing, so a
//!      late arrival never brings back an older value.
//!   4. The owner publishes whenever such a record is written (after the write is durable) and once when it starts. A
//!      failed publication is tried again by the next write or start; it never fails the write.
//!   5. The KV written is the same Miniflare-layout APP_KV a reader reads (index `_mf_entries`, immutable blobs),
//!      written only through its storage owner (src/storage/original_kv.rs). The values are public rule and setup
//!      DATA, never a credential.
//!
//! Where it lands: an account reads its own selected APP_KV. The computer that serves several accounts names each
//! one's KV (`serve`), so the operator's publication reaches every account the computer serves; absent that list the
//! operator publishes into its own KV only.
use super::*;
use crate::{
    ecma_json::{self, Value as Js},
    storage::{self, sqlite, Intent, Scope},
    workspace_store::Selection,
};
use std::{sync::{atomic::AtomicBool, Mutex, OnceLock}, time::{Duration, Instant}};

const KEY: &str = "service-record:";

/// One account's APP_KV, as its reader reads it: the index file and its blob folder, inside the account's own root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceRecordKv {
    sqlite: PathBuf,
    blobs: PathBuf,
}
impl ServiceRecordKv {
    /// The APP_KV a selected account reads (the same paths `LocalAccountObserver::open_source` opens).
    pub fn of_selected(selected: &SelectedLocalState) -> AccountResult<Self> {
        let root = fs::canonicalize(&selected.root).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if selected.app_kv_store.is_empty()
            || !selected
                .app_kv_store
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        Ok(Self {
            sqlite: contained(&root, &selected.app_kv_sqlite)?,
            blobs: contained(
                &root,
                &PathBuf::from("storage/kv")
                    .join(&selected.app_kv_store)
                    .join("blobs"),
            )?,
        })
    }
}

/// The APP_KVs of the accounts this process serves, named by the computer at its start (`serve`).
fn served() -> &'static Mutex<Vec<ServiceRecordKv>> {
    static SERVED: OnceLock<Mutex<Vec<ServiceRecordKv>>> = OnceLock::new();
    SERVED.get_or_init(|| Mutex::new(Vec::new()))
}
/// Name the APP_KV of every account this process serves: where the operator's publications go.
pub fn serve(kvs: Vec<ServiceRecordKv>) {
    if let Ok(mut served) = served().lock() {
        *served = kvs;
    }
}

/// Name the APP_KV of one more account this process serves: an account opened after the start (a skipped one that opened on
/// a later try, `computer.rs` `start_skipped`).
pub fn serve_one(kv: ServiceRecordKv) {
    if let Ok(mut served) = served().lock() {
        served.push(kv);
    }
}

/// What service-records.json says the operator publishes as its own workspace records.
struct Published {
    labels: Vec<String>,
    prefixes: Vec<String>,
    publish_most: usize,
}
fn texts(value: Option<&Js>) -> Vec<String> {
    match value {
        Some(Js::Array(items)) => items
            .iter()
            .filter_map(|v| match v {
                Js::String(s) => s.to_rust_string().ok(),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}
fn member<'a>(value: &'a Js, key: &str) -> Option<&'a Js> {
    match value {
        Js::Object(o) => o.get(&ecma_json::JsString::from(key)),
        _ => None,
    }
}
/// The service records DATA the account at `root` reads from its installed tools (show_rules/data.json).
fn published(root: &Path) -> AccountResult<Published> {
    let data = super::show_rules::tools_json(root, "service-records")?;
    let derived = member(&data, "derived");
    let sources = member(&data, "own_record_sources").ok_or(crate::cause!(AccountError::SourceUnavailable))?;
    let own = |label: &str, family: &str| {
        member(sources, label).is_some_and(|source| texts(member(source, family)).iter().any(|l| l == label))
    };
    let labels = texts(member(&data, "labels"))
        .into_iter()
        .filter(|label| derived.and_then(|d| member(d, label)).is_none() && own(label, "workspace_labels"))
        .collect();
    let prefixes = texts(member(&data, "prefixes"))
        .into_iter()
        .filter(|prefix| own(prefix, "workspace_prefixes"))
        .collect();
    let publish_most = match member(&data, "publish_most") {
        Some(Js::Number(n)) if *n >= 1.0 && n.fract() == 0.0 => *n as usize,
        _ => return Err(crate::cause!(AccountError::SourceUnavailable)),
    };
    Ok(Published { labels, prefixes, publish_most })
}
impl Published {
    fn names(&self, label: &str) -> bool {
        self.labels.iter().any(|l| l == label) || self.prefixes.iter().any(|p| label.starts_with(p.as_str()))
    }
}

/// `publishServiceRecords(kv, [{ label, value, at }])`: write each record whose kept publication is older and has
/// another identity; the labels written. `root` is the publishing account's state folder, whose installed tools
/// carries the service records DATA that names what may be published.
pub fn publish_service_records(
    root: &Path,
    kv: &ServiceRecordKv,
    records: &[(String, Js)],
    at: u64,
) -> AccountResult<Vec<String>> {
    let settings = published(root)?;
    if records.is_empty() || records.len() > settings.publish_most {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    if records.iter().any(|(label, _)| !settings.names(label)) {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    let handle = sqlite::open_selected(
        &kv.sqlite,
        "original_app_kv",
        sqlite::Selected {
            access: sqlite::Access::Write,
            trusted_schema: false,
            meter: None,
            bounds: sqlite::Bounds {
                value_bytes: MAX_JSON,
                work: 100_000,
                deadline: Duration::from_secs(5),
                spend: sqlite::Spend::WholeHandle,
                cancel: None,
                busy: Duration::from_millis(500),
            },
        },
    )
    .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    let tx = Scope::begin(&handle, Intent::Write).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    let mut written = Vec::new();
    for (label, value) in records {
        let key = format!("{KEY}{label}");
        let identity = super::record_writer::native_command_context::workspace_value_identity(value)
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let before = storage::original_kv::read_at_most(
            &*tx,
            &kv.blobs,
            &key,
            at,
            storage::original_kv::MOST_PUBLISHED,
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if let Some(before) = before {
            // A kept publication that cannot be read as one is replaced, as the old `kv.get` of a broken value was.
            if let Ok(before) = serde_json::from_slice::<serde_json::Value>(&before) {
                let newer = before.get("at").and_then(serde_json::Value::as_f64).is_some_and(|kept| kept > at as f64);
                let same = before.get("identity").and_then(serde_json::Value::as_str) == Some(identity.as_str());
                if newer || same {
                    continue;
                }
            }
        }
        let value = ecma_json::stringify(value, Default::default()).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let envelope = format!(
            r#"{{"label":{},"value":{value},"identity":{},"at":{at}}}"#,
            serde_json::to_string(label).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?,
            serde_json::to_string(&identity).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?,
        );
        storage::original_kv::replace_public(&*tx, &kv.blobs, &key, envelope.as_bytes()).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        written.push(label.clone());
    }
    tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    Ok(written)
}

impl LocalAccount {
    /// Whether this owner is the selected operator account (invariant 1).
    fn is_operator(&self) -> AccountResult<bool> {
        let operator = self.startup_service_setting("OPERATOR_ACCOUNT_ID")?;
        Ok(operator.is_some_and(|operator| operator == self.account().user_id))
    }
    /// The KVs the operator publishes into: every account this process serves, else its own.
    fn service_record_kvs(&self) -> AccountResult<Vec<ServiceRecordKv>> {
        let served = served().lock().map(|kvs| kvs.clone()).unwrap_or_default();
        if !served.is_empty() {
            return Ok(served);
        }
        Ok(vec![ServiceRecordKv {
            sqlite: self.source.kv.path.clone(),
            blobs: self.source.blob_root.clone(),
        }])
    }
    /// Publish the operator's own service records: those among `written` (workspace labels a durable write just
    /// changed), or every one service-records.json names (`None`: when the owner starts). The labels any KV took.
    /// Not the operator, or nothing named among `written`: nothing is read or written.
    pub fn publish_own_service_records(
        &mut self,
        written: Option<&[String]>,
        cancel: Arc<AtomicBool>,
    ) -> AccountResult<Vec<String>> {
        if !self.is_operator()? {
            return Ok(Vec::new());
        }
        let settings = published(&self.source.selected.root)?;
        let selection = match written {
            Some(written) => {
                let mut labels: Vec<String> = written.iter().filter(|l| settings.names(l)).cloned().collect();
                labels.sort();
                labels.dedup();
                if labels.is_empty() {
                    return Ok(Vec::new());
                }
                Selection { labels, prefixes: Vec::new() }
            }
            None => Selection { labels: settings.labels.clone(), prefixes: settings.prefixes.clone() },
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let at = self.source.clock()?;
        let snapshot = self
            .read_workspace_store(Some(&selection), None, cancel, deadline)
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let mut records: Vec<(String, Js)> = snapshot.records;
        // A named label the operator keeps no record of is published as none, as the old reader's null was.
        for label in &selection.labels {
            if !records.iter().any(|(l, _)| l == label) {
                records.push((label.clone(), Js::Null));
            }
        }
        // One account's KV refusing does not keep the others from the publication; it is tried again next time.
        let mut taken = Vec::new();
        let mut refusal = None;
        for kv in self.service_record_kvs()? {
            for chunk in records.chunks(settings.publish_most) {
                match publish_service_records(&self.source.selected.root, &kv, chunk, at) {
                    Ok(labels) => {
                        for label in labels {
                            if !taken.contains(&label) {
                                taken.push(label);
                            }
                        }
                    }
                    Err(error) => refusal = Some(error),
                }
            }
        }
        self.assert_owned()?;
        match refusal {
            Some(error) if taken.is_empty() => Err(error),
            _ => Ok(taken),
        }
    }
}
