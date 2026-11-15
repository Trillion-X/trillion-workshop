//! A complete record-domain identity selects one independently executed
//! resource. Addresses are canonical tuples, never labels, paths or a lookup
//! of a placement note. The account owner supplies namespace and generation;
//! the caller carries the stable id and incarnation on every operation.
//!
//! Old trillion src/placed-lists.mjs:10-41 separated a list's authoritative
//! operations from its physical supply. This moves that selection below the
//! generic record seam without importing its per-list placement catalogue.
//! Physical policy remains the existing DATA resource family and opener.
#[cfg(not(hosted_records))]
use super::{resource_of, Readers, StateResources, Writer};
use crate::records::Error;
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
#[cfg(not(hosted_records))]
use std::sync::Arc;

/// Logical history identity, independent of its supply or computer.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub id: String,
    pub incarnation: String,
    pub generation: i64,
}

impl Identity {
    /// Stable metadata slot for the currently admitted replica history.
    #[cfg(not(hosted_records))]
    pub(crate) fn copy_namespace(&self, account: &str) -> Result<String,Error> {
        let bytes = serde_json::to_vec(&("record-domain-copy/v1",account,&self.id)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(blake3::hash(&bytes).to_hex().to_string())
    }

    /// The physical resource address is selected from account and stable id.
    /// The complete incarnation/generation remains a mandatory stored-header
    /// check, never a way to open a different empty replacement.
    #[cfg(not(hosted_records))]
    pub fn resource(&self, account: &str) -> Result<String, Error> {
        if !self.valid() || account.trim().is_empty() || account.chars().any(char::is_control) { return Err(crate::cause!(Error::Conflict)); }
        let framed = serde_json::to_vec(&("record-domain/v1", account, &self.id)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let prefix = resource_of(file!()).ok_or(crate::cause!(Error::Unavailable))?;
        Ok(format!("{prefix}{}", blake3::hash(&framed).to_hex()))
    }

    /// The physical address of this identity's history in the store of volume `order` (`books.rs`): order 0 is the
    /// primary store and answers exactly what `resource` answers, so every existing address is unchanged; a further
    /// store (order N > 0) names its own address, so its writer and lock are its own.
    #[cfg(not(hosted_records))]
    pub fn resource_at(&self, account: &str, order: usize) -> Result<String, Error> {
        if order == 0 {
            return self.resource(account);
        }
        if !self.valid() || account.trim().is_empty() || account.chars().any(char::is_control) { return Err(crate::cause!(Error::Conflict)); }
        let framed = serde_json::to_vec(&("record-domain/v1", account, &self.id, order)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let prefix = resource_of(file!()).ok_or(crate::cause!(Error::Unavailable))?;
        Ok(format!("{prefix}{}", blake3::hash(&framed).to_hex()))
    }

    /// The copy key of this identity's history in the store of volume `order`: order 0 is `copy_namespace`, unchanged.
    #[cfg(not(hosted_records))]
    pub(crate) fn copy_namespace_at(&self, account: &str, order: usize) -> Result<String, Error> {
        if order == 0 {
            return self.copy_namespace(account);
        }
        let bytes = serde_json::to_vec(&("record-domain-copy/v1", account, &self.id, order)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(blake3::hash(&bytes).to_hex().to_string())
    }

    /// A local version cannot compare equal in a different admitted history,
    /// account, record or kind, even when both supplies return the same stamp.
    pub fn root_identity(&self, account: &str, id: &str, kind: &str, stamp: &str) -> Result<String, Error> {
        let framed = serde_json::to_vec(&("record-root/v1", account, self, id, kind, stamp))
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(format!("1f:{}", blake3::hash(&framed).to_hex()))
    }

    fn valid(&self) -> bool {
        let Some(settings) = crate::storage::record_store::settings::shipped() else { return false; };
        [&self.id, &self.incarnation]
            .iter()
            .all(|value| value.len() <= settings.identity_text_bytes && !value.trim().is_empty() && !value.chars().any(char::is_control))
            && (1..=9_007_199_254_740_991).contains(&self.generation)
    }
}

/// Creation is explicit. An ordinary read/write never turns a missing domain
/// into an empty replacement. A retry carries this exact same selection.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub id: String,
    pub incarnation: String,
    pub generation: i64,
    #[serde(default)]
    pub create: bool,
}
impl Selection {
    pub fn from_input(input: &serde_json::Value) -> Result<Option<Self>, Error> {
        input
            .get("scope")
            .map(|value| {
                let selected: Self = serde_json::from_value(value.clone())
                    .map_err(|_| Error::Invalid("invalid record scope", crate::cause!()))?;
                if !selected.identity().valid() {
                    return Err(Error::Invalid("invalid record scope", crate::cause!()));
                }
                Ok(selected)
            })
            .transpose()
    }
    pub fn identity(&self) -> Identity {
        Identity {
            id: self.id.clone(),
            incarnation: self.incarnation.clone(),
            generation: self.generation,
        }
    }
}

/// The admitted account binds a complete logical identity to its existing
/// resource opener. No account database, directory or placement record is read
/// to compute the address. A stored header must still verify the full identity.
#[derive(Clone)]
#[cfg(not(hosted_records))]
pub struct Bound {
    selection: Selection,
    resources: Arc<StateResources>,
    resource: String,
}
#[cfg(not(hosted_records))]
impl Bound {
    pub fn new(
        resources: Arc<StateResources>,
        account: &str,
        selected: Selection,
        generation: i64,
    ) -> Result<Self, Error> {
        if account.trim().is_empty()
            || account.chars().any(char::is_control)
            || !selected.identity().valid()
            || selected.generation != generation
        {
            return Err(crate::cause!(Error::Conflict));
        }
        // Incarnation/generation are verified in the resource header, rather
        // than hashed into another filename which could silently open empty.
        let resource = selected.identity().resource(account)?;
        Ok(Self {
            selection: selected,
            resources,
            resource,
        })
    }
    pub fn selection(&self) -> &Selection {
        &self.selection
    }

    pub fn writer(&self) -> Result<Arc<Writer>, Error> {
        if self.selection.create {
            self.resources.writer(&self.resource)
        } else {
            self.resources.existing_writer(&self.resource)
        }
    }
    /// Verify the full stored history header before any effect or disclosure.
    /// Computing an address grants no rights and cannot establish incarnation.
    pub fn verify(&self, stored: &Identity) -> Result<(), Error> {
        if stored == &self.selection.identity() {
            Ok(())
        } else {
            Err(crate::cause!(Error::Conflict))
        }
    }

    pub fn resource(&self) -> &str {
        &self.resource
    }

    pub fn readers(&self) -> Result<Arc<Readers>, Error> {
        self.resources.readers(&self.resource)
    }
}

/// Bounded recovery discovery, separate from ordinary addressed reads/writes.
/// One iterator serves the account; no worker or retained handle is installed
/// for an inactive history. Dropping it starts a new sweep, while durable
/// outbox records and request keys retain the work between sweeps/restarts.
#[cfg(not(hosted_records))]
pub struct Inventory {
    resources: Arc<StateResources>,
    account: String,
    generation: i64,
    copies: bool,
    entries: Option<std::fs::ReadDir>,
    candidate: Option<(std::path::PathBuf,Option<String>)>,
}
#[cfg(not(hosted_records))]
impl Inventory {
    pub fn new(resources: Arc<StateResources>, account: String, generation: i64) -> Result<Self,Error> {
        if account.trim().is_empty() || generation < 1 { return Err(crate::cause!(Error::Conflict)); }
        Ok(Self { resources, account, generation, copies:false, entries:None, candidate:None })
    }
    /// Copy discovery may find encrypted-only streams. This context grants
    /// no ordinary read, Ready state or admitted account generation.
    pub(crate) fn copies(resources: Arc<StateResources>, account: String) -> Result<Self,Error> {
        if account.trim().is_empty() { return Err(crate::cause!(Error::Conflict)); }
        Ok(Self { resources, account, generation:0, copies:true, entries:None, candidate:None })
    }
    pub fn generation(&self) -> i64 { self.generation }
    /// `limit` bounds examined directory entries, including non-candidates.
    /// Ordinary selection never calls this operation. Every emitted context
    /// matches a regular file, its account/generation header and canonical path.
    pub fn page(&mut self, limit: usize, cancel: Arc<std::sync::atomic::AtomicBool>, until: std::time::Instant)
        -> Result<(Vec<Identity>,bool),Error> {
        if limit == 0 { return Err(Error::Invalid("empty inventory page", crate::cause!())); }
        let family = resource_of(file!()).ok_or(crate::cause!(Error::Unavailable))?;
        let placed = super::placement(family).ok_or(crate::cause!(Error::Unavailable))?;
        let super::FileOf::StateResource { prefix,suffix } = &placed.file else { return Err(crate::cause!(Error::Unavailable)); };
        if self.entries.is_none() { self.entries = Some(std::fs::read_dir(&self.resources.state).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?); }
        let mut histories = Vec::new();
        for _ in 0..limit {
            if cancel.load(std::sync::atomic::Ordering::Acquire) || std::time::Instant::now() >= until { return Err(crate::cause!(Error::Unavailable)); }
            let (path,cursor) = if let Some(candidate) = self.candidate.take() { candidate } else {
                let Some(entry) = self.entries.as_mut().and_then(Iterator::next) else {
                    self.entries = None;
                    return Ok((histories,true));
                };
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => { self.entries = None; return Err(crate::cause!(Error::Unavailable)); }
                };
                let filename = entry.file_name();
                let Some(filename) = filename.to_str() else { continue; };
                if !filename.starts_with(prefix) || !filename.ends_with(suffix)
                    || !entry.file_type().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_file() { continue; }
                (entry.path(),None)
            };
            let reader = super::Readers::new(path.clone(),self.resources.meter.clone());
            let outcome = reader.read_bounded(cancel.clone(),until,|store| {
                if self.copies { return copy_identity(&store, &self.account,cursor.as_deref()); }
                let (_,header) = store.held_record_with_version(&self.account,
                    crate::local_account::own_records::IDENTITY,"command-domain")?;
                let Some(header) = header else { return Ok((None,None)); };
                let identity: Identity = serde_json::from_value(header.value).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
                if !identity.valid() { return Err(crate::cause!(Error::Conflict)); }
                // Retired account generations are not this sweep's work.
                if identity.generation != self.generation { return Ok((None,None)); }
                if !crate::local_account::own_records::domain_current(&store,&self.account,&identity)? { return Err(crate::cause!(Error::Conflict)); }
                Ok((Some(identity),None))
            });
            let (identity,next) = match outcome {
                Ok(page) => page,
                Err(error) => { self.candidate = Some((path,cursor)); return Err(error); }
            };
            if next.is_some() { self.candidate = Some((path.clone(),next)); }
            let Some(identity) = identity else { continue; };
            let bound = Bound::new(self.resources.clone(),&self.account,Selection {
                id:identity.id.clone(),incarnation:identity.incarnation.clone(),generation:identity.generation,create:false
            },if self.copies { identity.generation } else { self.generation })?;
            if bound.readers()?.path() != path { return Err(crate::cause!(Error::Conflict)); }
            histories.push(identity);
        }
        Ok((histories,false))
    }
}

/// Copy metadata is routing only. Its identity never establishes ordinary
/// rights or generation authority, and an unmaterialized stream remains opaque.
#[cfg(not(hosted_records))]
fn copy_identity<S: crate::storage::Storage>(store: &crate::storage::record_store::RecordStore<S>, account: &str, after: Option<&str>) -> Result<(Option<Identity>,Option<String>),Error> {
    let storage = store.storage();
    if let Some(header) = store.current_record(account,crate::local_account::own_records::IDENTITY,"command-domain")? {
        let identity: Identity = serde_json::from_value(header.value).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        if !identity.valid() { return Err(crate::cause!(Error::Conflict)); }
        let slot = super::carry::live_adopt::command_slot(account,&serde_json::to_value(&identity).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if super::carry::live_adopt::command_access(storage,&slot).is_err() { return Ok((None,None)); }
        return Ok((Some(identity),None));
    }
    let limits = crate::storage::record_store::settings::shipped().ok_or(crate::cause!(Error::Unavailable))?.live_adoption;
    let page = super::carry::commit_log::bindings_after(storage,after,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let mut identity = None;
    for binding in page.bindings {
        let (held_account, scope): (String,Identity) = serde_json::from_slice(&binding.binding).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        if held_account != account { continue; }
        if !scope.valid() { return Err(crate::cause!(Error::Conflict)); }
        let expected = super::carry::live_adopt::command_slot(account,&serde_json::to_value(&scope).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if expected != binding.stream { continue; }
        let bound = super::carry::commit_log::stream_binding(storage,&scope.copy_namespace(account)?,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if bound.as_deref() != Some(binding.binding.as_slice()) { return Err(crate::cause!(Error::Conflict)); }
        if identity.as_ref().is_some_and(|held| held != &scope) { return Err(crate::cause!(Error::Conflict)); }
        identity = Some(scope);
    }
    if identity.is_some() { Ok((identity,None)) } else { Ok((None,page.next)) }
}

#[cfg(all(test, not(hosted_records)))]
mod tests {
    use super::*;
    use crate::sqlite_work::WorkMeter;
    fn selected(id: &str) -> Selection {
        Selection {
            id: id.into(),
            incarnation: "first".into(),
            generation: 1,
            create: true,
        }
    }

    #[test]
    fn recovery_inventory_is_bounded_and_keeps_complete_current_histories_only() {
        use crate::local_account::own_records::InCommand;
        use std::{sync::atomic::AtomicBool,time::{Duration,Instant}};
        let folder=tempfile::tempdir().unwrap();
        let resources=Arc::new(StateResources::new(folder.path(),WorkMeter::new()).unwrap());
        let mut expected=Vec::new();
        for (account,id,generation) in [("account","a",2),("account","b",2),("account","retired",1),("other","other",2)] {
            let mut selection=selected(id); selection.generation=generation;
            let bound=Bound::new(resources.clone(),account,selection.clone(),generation).unwrap();
            let writer=bound.writer().unwrap();
            let lent=writer.lend(Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(30)).unwrap();
            let tx=lent.begin(crate::storage::sqlite::TransactionBehavior::Immediate).unwrap();
            let mut command=InCommand::lend(&tx,account,InCommand::limits(&tx,writer.path()).unwrap()).unwrap();
            command.command_domain(&selection).unwrap(); drop(command); tx.commit().unwrap();
            if account=="account" && generation==2 { expected.push(selection.identity()); }
        }
        std::fs::write(folder.path().join("unrelated"),b"not a record supply").unwrap();
        let mut inventory=Inventory::new(resources.clone(),"account".into(),2).unwrap();
        let mut found=Vec::new();
        let mut pages=0;
        loop {
            let (page,done)=inventory.page(1,Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(30)).unwrap();
            assert!(page.len()<=1,"one examined entry cannot yield two histories");
            found.extend(page); pages+=1;
            if done { break; } assert!(pages<100);
        }
        found.sort(); expected.sort(); assert_eq!(found,expected); assert!(pages>=5);
        let mut cancelled=Inventory::new(resources,"account".into(),2).unwrap();
        assert!(matches!(cancelled.page(1,Arc::new(AtomicBool::new(true)),Instant::now()+Duration::from_secs(30)),Err(Error::Unavailable(_))));
    }

    #[test]
    fn identical_local_stamps_cannot_cross_account_history_record_or_kind() {
        let domain = selected("scope-a").identity();
        let stamp = "same-local-stamp";
        let root = domain.root_identity("account-a", "row-a", "kind-a", stamp).unwrap();
        for other in [
            domain.root_identity("account-b", "row-a", "kind-a", stamp).unwrap(),
            domain.root_identity("account-a", "row-b", "kind-a", stamp).unwrap(),
            domain.root_identity("account-a", "row-a", "kind-b", stamp).unwrap(),
            Identity { id: "scope-b".into(), ..domain.clone() }.root_identity("account-a", "row-a", "kind-a", stamp).unwrap(),
            Identity { incarnation: "next".into(), ..domain.clone() }.root_identity("account-a", "row-a", "kind-a", stamp).unwrap(),
            Identity { generation: 2, ..domain.clone() }.root_identity("account-a", "row-a", "kind-a", stamp).unwrap(),
        ] { assert_ne!(root, other); }
        assert_eq!(root, domain.root_identity("account-a", "row-a", "kind-a", stamp).unwrap());
    }

    #[test]
    fn complete_context_is_explicit_validated_and_not_created_by_ordinary_calls() {
        use serde_json::json;
        assert!(Selection::from_input(&json!({})).unwrap().is_none());
        for scope in [
            json!(null),
            json!({"id":"a"}),
            json!({"id":"a","incarnation":"i","generation":0}),
            json!({"id":"a","incarnation":"i","generation":1,"placement":"other"}),
            json!({"id":"a\u{0000}","incarnation":"i","generation":1}),
        ] {
            assert!(Selection::from_input(&json!({"scope":scope})).is_err());
        }
        let selection =
            Selection::from_input(&json!({"scope":{"id":"a","incarnation":"i","generation":1}}))
                .unwrap()
                .unwrap();
        assert!(!selection.create);
        let folder = tempfile::tempdir().unwrap();
        let resources = Arc::new(StateResources::new(folder.path(), WorkMeter::new()).unwrap());
        let bound = Bound::new(resources, "account", selection, 1).unwrap();
        assert!(bound.writer().is_err());
        assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 0);
        assert!(bound.verify(&bound.selection.identity()).is_ok());
        for identity in [
            Identity {
                incarnation: "wrong".into(),
                ..bound.selection.identity()
            },
            Identity {
                generation: 2,
                ..bound.selection.identity()
            },
            Identity {
                id: "wrong".into(),
                ..bound.selection.identity()
            },
        ] {
            assert_eq!(bound.verify(&identity), Err(crate::cause!(Error::Conflict)));
        }
    }

    #[test]
    fn ordinary_binding_has_zero_directory_reads_cold_and_warm() {
        let folder = tempfile::tempdir().unwrap();
        let meter = WorkMeter::new();
        let resources = Arc::new(StateResources::new(folder.path(), meter.clone()).unwrap());
        let before = serde_json::to_value(meter.snapshot().unwrap().work).unwrap();
        let bound = Bound::new(resources.clone(), "account", selected("list"), 1).unwrap();
        assert_eq!(
            before,
            serde_json::to_value(meter.snapshot().unwrap().work).unwrap()
        );
        let writer = bound.writer().unwrap();
        let before = serde_json::to_value(meter.snapshot().unwrap().work).unwrap();
        let mut ordinary = bound.selection.clone();
        ordinary.create = false;
        for _ in 0..3 {
            let bound = Bound::new(resources.clone(), "account", ordinary.clone(), 1).unwrap();
            assert!(Arc::ptr_eq(&writer, &bound.writer().unwrap()));
            bound.readers().unwrap();
        }
        assert_eq!(
            before,
            serde_json::to_value(meter.snapshot().unwrap().work).unwrap(),
            "ordinary selection/retained handles read no placement or affinity state"
        );
        let reopened = Arc::new(StateResources::new(folder.path(), meter.clone()).unwrap());
        let cold = Bound::new(reopened, "account", ordinary, 1).unwrap();
        assert_eq!(cold.writer().unwrap().path(), writer.path());
        cold.readers().unwrap();
        assert_eq!(
            before,
            serde_json::to_value(meter.snapshot().unwrap().work).unwrap(),
            "cold reopening an existing domain performs no placement or affinity query"
        );
        assert!(std::fs::read_dir(folder.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("directory")));
    }

    #[test]
    fn held_domain_does_not_block_another_domains_commit_and_fresh_read_cold_or_warm() {
        use crate::{
            records::Mutation,
            storage::{
                record_store::RecordStore,
                sqlite::{self, Access},
            },
        };
        use std::{
            sync::{atomic::AtomicBool, mpsc},
            time::{Duration, Instant},
        };
        for warm in [false, true] {
            let folder = tempfile::tempdir().unwrap();
            let resources = Arc::new(StateResources::new(folder.path(), WorkMeter::new()).unwrap());
            let a = Bound::new(resources.clone(), "account", selected("a"), 1).unwrap();
            let b = Bound::new(resources.clone(), "account", selected("b"), 1).unwrap();
            let a_writer = a.writer().unwrap();
            if warm {
                let writer = b.writer().unwrap();
                let primed = writer
                    .lend(
                        Arc::new(AtomicBool::new(false)),
                        Instant::now() + Duration::from_secs(5),
                    )
                    .unwrap();
                // Prime the real retained connection as well as its registry.
                drop(primed);
                assert!(writer.kept.lock().unwrap().is_some());
            }
            let a_lent = a_writer
                .lend(
                    Arc::new(AtomicBool::new(false)),
                    Instant::now() + Duration::from_secs(10),
                )
                .unwrap();
            let a_tx = a_lent
                .begin(rusqlite::TransactionBehavior::Immediate)
                .unwrap();
            let (send, recv) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                let writer = b.writer().unwrap();
                let lent = writer
                    .lend(
                        Arc::new(AtomicBool::new(false)),
                        Instant::now() + Duration::from_secs(5),
                    )
                    .unwrap();
                let tx = lent
                    .begin(rusqlite::TransactionBehavior::Immediate)
                    .unwrap();
                let supply = sqlite::lend(&tx, super::super::SCHEMA, Access::Write).unwrap();
                let limits = super::super::computer_limits(&supply, writer.path()).unwrap();
                let mut store = RecordStore::new(
                    supply,
                    Box::new(crate::storage::record_store::RealClock),
                    limits,
                )
                .unwrap();
                store
                    .mutate_local_with_check(
                        "account",
                        "own-records",
                        Mutation {
                            id: "same-row".into(),
                            expected_version: 0,
                            request_key: "commit-b".into(),
                            deleted: false,
                            value: serde_json::json!({"value":"committed-b"}),
                        },
                        || Ok(()),
                    )
                    .unwrap();
                drop(store);
                tx.commit().unwrap();
                drop(lent);
                b.readers()
                    .unwrap()
                    .read::<_, Error>(|store| {
                        assert_eq!(
                            store
                                .current_record("account", "own-records", "same-row")?
                                .unwrap()
                                .value,
                            serde_json::json!({"value":"committed-b"})
                        );
                        Ok(())
                    })
                    .unwrap();
                send.send(()).unwrap();
            });
            // A's real writer transaction is established synchronously before B
            // starts. This bounded receive is a failure guard, never a schedule.
            let completed = recv.recv_timeout(Duration::from_secs(5));
            a_tx.rollback().unwrap();
            drop(a_lent);
            worker.join().unwrap();
            completed.expect("B must commit and read before A is released");
        }
    }

    #[test]
    fn framing_separates_namespaces_and_retains_one_path_across_incarnations() {
        let folder = tempfile::tempdir().unwrap();
        let resources = Arc::new(StateResources::new(folder.path(), WorkMeter::new()).unwrap());
        let selected = Selection {
            id: "c".into(),
            incarnation: "first".into(),
            generation: 1,
            create: true,
        };
        let a = Bound::new(resources.clone(), "a:b", selected.clone(), 1).unwrap();
        assert_eq!(
            a.resource(),
            "@own-work/601ffd8a0c78238a177284899a1f49eadc50aae92ab40c17e5e862df31e636db",
            "the v1 canonical tuple has a stable cross-computer address"
        );
        let mut other = selected.clone();
        other.id = "b:c".into();
        let b = Bound::new(resources.clone(), "a", other, 1).unwrap();
        assert_ne!(a.resource, b.resource);
        let b = Bound::new(resources.clone(), "other-account", selected.clone(), 1).unwrap();
        assert_ne!(a.resource, b.resource);
        let mut next = selected.clone();
        next.incarnation = "next".into();
        assert_eq!(
            a.resource,
            Bound::new(resources.clone(), "a:b", next, 1)
                .unwrap()
                .resource
        );
        assert!(Bound::new(resources, "a:b", selected, 2).is_err());
    }
}

#[cfg(all(test, not(hosted_records)))]
mod book_address_tests {
    use super::*;

    fn list() -> Identity {
        Identity { id: "list-1".into(), incarnation: "first".into(), generation: 1 }
    }

    /// Captured from the code before the book order existed (2026-11-12): order 0 must keep these exact addresses, so no
    /// history that exists today moves.
    #[test]
    fn order_zero_keeps_every_existing_address_byte_for_byte() {
        assert_eq!(list().resource_at("account-under-test", 0).unwrap(), "@own-work/7de43904031d98e44939171f08af70bef6a57ac9e3f5f1375236b78e06dcfcaf");
        assert_eq!(list().copy_namespace_at("account-under-test", 0).unwrap(), "d007eeff30e0db3c9fa0130b936a5fa683d17eda7aa71ebade86b65942f17635");
        assert_eq!(list().resource_at("account-under-test", 0).unwrap(), list().resource("account-under-test").unwrap());
        assert_eq!(list().copy_namespace_at("account-under-test", 0).unwrap(), list().copy_namespace("account-under-test").unwrap());
    }

    /// A further store's history has its own address and copy key, distinct from the primary's and from every other
    /// order's, and stable for the same order.
    #[test]
    fn a_further_store_has_its_own_address_and_copy_key() {
        let primary = list().resource_at("account-under-test", 0).unwrap();
        let first = list().resource_at("account-under-test", 1).unwrap();
        let second = list().resource_at("account-under-test", 2).unwrap();
        assert_ne!(first, primary);
        assert_ne!(first, second);
        assert_eq!(first, list().resource_at("account-under-test", 1).unwrap(), "the same order names the same address");
        assert_ne!(list().copy_namespace_at("account-under-test", 1).unwrap(), list().copy_namespace_at("account-under-test", 0).unwrap());
    }
}
