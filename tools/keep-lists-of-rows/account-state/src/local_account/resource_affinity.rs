//! Resolve the addressed resource for one explicitly identified piece of own work.
//!
//! The historical account-control owner kept one durable affinity per typed
//! identity (`{kind,id}`), plus a directory cell for each caller-declared
//! relationship group. A point owner projected the single-identity binding;
//! the group directory remained canonical and repaired point projections after
//! interruption. This module is the pure decision contract for that owner. Its
//! caller must persist `Resolution::writes` under the selected generation at
//! the affinity directory/point owners; a returned route is not itself a
//! durable binding. The source record owner separately checks record effects.
//!
//! Placement is never guessed from arbitrary record kinds, ids, or values.
//! Callers derive typed identities from their actual domain owner and name a
//! relationship group only when that owner proves the members must stay
//! together. A write containing unrelated records is not partitioned here.
//!
//! Non-Negotiable Invariants:
//! - An existing bound route wins even if it is no longer a growth target.
//! - Conflicting or tombstoned bindings refuse. Recovery is explicit; this
//!   resolver never merges, moves, or rebinds existing work.
//! - A relationship group and every newly bound member resolve to one route.
//! - New selection uses only installed same-owner targets that accept growth.
//! - The caller commits canonical directory bindings and publication state in
//!   the directory owner's transaction. Identity-point rows are separate
//!   projections repaired idempotently from that canonical decision.
//! - Source record effects and cross-owner destination publication require
//!   their own source check and recovery protocol.
//!
//! Key Concepts: owner, generation, typed identity, explicit relationship
//! group, installed growth target, durable binding, and recovery refusal.
//!
//! Security Considerations: an identity or target cannot name another owner;
//! caller input is not proof of identity membership, current rights, target
//! installation, or current generation. The mounting owner proves each before
//! this decision is persisted or a destination is written.
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};

#[path = "../storage/resource_affinity.rs"]
pub mod store;

const MAX_TEXT: usize = 2048;
const MAX_IDENTITIES: usize = 1000;

/// A stable domain identity, never inferred from an untyped record batch.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct Identity {
    pub kind: String,
    pub id: String,
}

/// An addressed physical resource owned by one account.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResourceAddress {
    pub owner: String,
    pub resource: String,
}

/// A catalogue entry. Only installed targets that do not refuse growth are
/// eligible for new work; retained affinity is not checked against this list.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GrowthTarget {
    pub address: ResourceAddress,
    pub installed: bool,
    pub refuses_growth: bool,
}

/// The durable point binding read from the account's affinity owner.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IdentityBinding {
    pub owner: String,
    pub generation: String,
    pub identity: Identity,
    pub address: ResourceAddress,
    pub group: Option<String>,
    pub tombstone: bool,
}

/// The durable canonical route for an explicit relationship group.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GroupBinding {
    pub owner: String,
    pub generation: String,
    pub group: String,
    pub address: ResourceAddress,
    pub tombstone: bool,
}

/// Request derived by a trusted operation/domain owner.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResolveRequest {
    pub owner: String,
    pub generation: String,
    pub identities: Vec<Identity>,
    /// Opaque source-owned relationship id. No grouping is inferred when absent.
    pub group: Option<String>,
}

/// Canonical directory rows and independently addressed point projections.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct AffinityWrites {
    pub canonical_identities: Vec<IdentityBinding>,
    pub point_identities: Vec<IdentityBinding>,
    pub group: Option<GroupBinding>,
}

/// A route plus idempotent writes needed to make it durable.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Resolution {
    pub address: ResourceAddress,
    pub generation: String,
    pub group: Option<String>,
    pub identities: Vec<Identity>,
    pub writes: AffinityWrites,
}

/// Why no safe new resource decision could be returned.
#[derive(Clone, Debug)]
pub enum Error {
    Invalid(&'static str, crate::refusal_cause::Cause),
    OwnerMismatch(crate::refusal_cause::Cause),
    GenerationMismatch(crate::refusal_cause::Cause),
    Tombstoned(crate::refusal_cause::Cause),
    Conflict(crate::refusal_cause::Cause),
    NoGrowthTarget(crate::refusal_cause::Cause),
    Corrupt(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Invalid(_, cause) => cause,
            Self::OwnerMismatch(cause) => cause,
            Self::GenerationMismatch(cause) => cause,
            Self::Tombstoned(cause) => cause,
            Self::Conflict(cause) => cause,
            Self::NoGrowthTarget(cause) => cause,
            Self::Corrupt(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);


impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        match (self,other) {
            (Self::Invalid(a0, _),Self::Invalid(b0, _)) => a0 == b0,
            (Self::OwnerMismatch(_),Self::OwnerMismatch(_)) => true,
            (Self::GenerationMismatch(_),Self::GenerationMismatch(_)) => true,
            (Self::Tombstoned(_),Self::Tombstoned(_)) => true,
            (Self::Conflict(_),Self::Conflict(_)) => true,
            (Self::NoGrowthTarget(_),Self::NoGrowthTarget(_)) => true,
            (Self::Corrupt(_),Self::Corrupt(_)) => true,
            _ => false,
        }
    }
}
impl Eq for Error {}


impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid(reason, _) => reason,
            Self::OwnerMismatch(_) => "an affinity row names another owner",
            Self::GenerationMismatch(_) => "an affinity row belongs to another generation",
            Self::Tombstoned(_) => "a tombstoned identity or group cannot be rebound",
            Self::Conflict(_) => {
                "related identities already have incompatible routes; explicit recovery is required"
            }
            Self::NoGrowthTarget(_) => "no installed resource currently accepts growth",
            Self::Corrupt(_) => "the affinity directory contains an invalid or duplicate row",
        })
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// Native record binding rules that sit beside the affinity resolver: command receipts get their own typed route
/// identity, while the RecordBook remains the authority for whether an own-record identity is fresh to an internal
/// work resource. The resolver above remains a pure placement contract; this adapter reads the native record owner.
pub(crate) mod native_binding {
    use super::{blake3, Error, Identity, ResourceAddress, store::{AffinityDirectory, StoreError}};
    use crate::local_account::own_records;

    const OWN_RECORD_IDENTITY: &str = "own-record";
    const OWN_COMMAND_KIND: &str = "own-command";

    /// A command has a separate route identity; it is never another member of the record group.
    pub(crate) fn own_command_identity(permit_id: &str) -> Result<Identity, Error> {
        if permit_id.trim().is_empty() || permit_id.len() > 2048 {
            return Err(Error::Invalid("an own-command permit id is invalid", crate::cause!()));
        }
        let bytes = serde_json::to_vec(&("native-own-command-route/v1", permit_id)).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
        Ok(Identity {
            kind: OWN_COMMAND_KIND.into(),
            id: format!("own-command:{}", blake3::hash(&bytes).to_hex()),
        })
    }

    /// Only record identities belong to a record group's canonical membership.
    pub(crate) fn own_record_route_identities(record_ids: &[String]) -> Result<Vec<Identity>, Error> {
        if record_ids.is_empty() || record_ids.len() > 1000 {
            return Err(Error::Invalid("an own-record route requires a bounded record group", crate::cause!()));
        }
        let mut identities = Vec::with_capacity(record_ids.len());
        for id in record_ids {
            if id.trim().is_empty() || id.len() > 2048 {
                return Err(Error::Invalid("an own-record route identity is invalid", crate::cause!()));
            }
            identities.push(Identity { kind: OWN_RECORD_IDENTITY.into(), id: id.clone() });
        }
        Ok(identities)
    }

    /// Find an earlier permit's route before selecting a group for its current input. Historical canonical
    /// commands predate route reservations: their command row (including a tombstone) still pins the original
    /// RecordBook even when every currently requested record id is fresh. The receipt owner decides whether the
    /// input is an exact retry. This function neither changes that receipt nor binds newly requested records.
    /// `verify` must prove the actual target and current rights, including original-file readiness or an internal
    /// complete group/association. Address text alone is never installation or admission evidence.
    pub(crate) fn existing_own_command_route(
        directory: &AffinityDirectory,
        original: &mut own_records::OwnStore,
        owner: &str,
        permit_id: &str,
        mut verify: impl FnMut(&ResourceAddress) -> Result<(), StoreError>,
    ) -> Result<Option<ResourceAddress>, StoreError> {
        let identity = own_command_identity(permit_id)?;
        let legacy = ResourceAddress { owner: owner.into(), resource: "@own-records".into() };
        verify(&legacy)?;
        let historical = original.held_version(owner, own_records::COMMANDS, permit_id)? > 0;
        if let Some(held) = directory.resolve_reserved_identity_route(&identity, &mut verify)? {
            if historical && held != legacy { return Err(crate::cause!(StoreError::Conflict)); }
            return Ok(Some(held));
        }
        if historical {
            return directory.reserve_identity_route(&identity, &legacy, &mut verify).map(Some);
        }
        verify(&legacy)?;
        Ok(None)
    }

    /// Persist a fresh command's selected route before any record effect. A crash before the receipt exists still
    /// retries on this route; a concurrent conflicting selection refuses. No permit is added to group membership.
    pub(crate) fn reserve_own_command_route(
        directory: &AffinityDirectory,
        original: &mut own_records::OwnStore,
        owner: &str,
        permit_id: &str,
        selected: &ResourceAddress,
        mut verify: impl FnMut(&ResourceAddress) -> Result<(), StoreError>,
    ) -> Result<ResourceAddress, StoreError> {
        if let Some(held) = existing_own_command_route(directory, original, owner, permit_id, &mut verify)? {
            if &held != selected { return Err(crate::cause!(StoreError::Conflict)); }
            return Ok(held);
        }
        directory.reserve_identity_route(&own_command_identity(permit_id)?, selected, &mut verify)
    }

    /// Whether any own-record identity has ever had record or key history in the original RecordBook; tombstones count.
    /// The command identity is a route witness only and never enters the source record history lookup.
    pub(crate) fn has_original_history(
        store: &mut own_records::OwnStore,
        owner: &str,
        identities: &[Identity],
    ) -> Result<bool, Error> {
        let record_identities = identities.iter().filter(|identity| identity.kind == OWN_RECORD_IDENTITY).collect::<Vec<_>>();
        if record_identities.is_empty() {
            return Err(Error::Invalid("an own-record route has no record identity", crate::cause!()));
        }
        for identity in record_identities {
            if identity.id.is_empty() || identity.id.len() > 2048 {
                return Err(Error::Invalid("an own-record route identity is invalid", crate::cause!()));
            }
            let record_history = store.held_version(owner, own_records::RESOURCE, &identity.id).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
            let key_history = store.held_version(owner, own_records::KEYS, &identity.id).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
            if record_history > 0 || key_history > 0 { return Ok(true); }
        }
        Ok(false)
    }

    /// Refuse a route that would make a legacy record or erased key unreachable before a proved carry completes.
    pub(crate) fn reject_internal_route_with_legacy_history(
        store: &mut own_records::OwnStore,
        owner: &str,
        canonical_identities: &[Identity],
    ) -> Result<(), Error> {
        if has_original_history(store, owner, canonical_identities)? { return Err(crate::cause!(Error::Conflict)); }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::{
            local_account::own_records::{KEYS, OwnRecords, RESOURCE},
            records::{Mutation, Records},
            sqlite_work::WorkMeter,
            storage::{record_store::native, record_store_resources},
        };
        use serde_json::json;

        fn identity(id: &str) -> Identity { Identity { kind: OWN_RECORD_IDENTITY.into(), id: id.into() } }

        #[test]
        fn permit_identity_is_typed_and_separate_from_record_membership() {
            let ids = vec!["record-a".to_owned(), "record-b".to_owned()];
            let route_ids = own_record_route_identities(&ids).unwrap();
            assert_eq!(route_ids.len(), 2);
            assert_eq!(route_ids[0], identity("record-a"));
            assert_eq!(route_ids[1], identity("record-b"));
            let command = own_command_identity("permit-1").unwrap();
            assert_eq!(command.kind, OWN_COMMAND_KIND);
            assert!(command.id.starts_with("own-command:"));
            assert!(!route_ids.contains(&command));
            assert!(own_command_identity("").is_err());
            assert!(own_record_route_identities(&[]).is_err());
        }

        fn put(store: &mut own_records::OwnStore, owner: &str, resource: &str, id: &str, value: serde_json::Value, request_key: &str) {
            let version = store.held_record_with_version(owner, resource, id).unwrap().0;
            store.mutate(owner, resource, Mutation { id: id.into(), expected_version: version, request_key: request_key.into(), deleted: false, value }).unwrap();
        }

        #[test]
        fn internal_route_refuses_legacy_record_tombstone_and_key_only_erasure() {
            let state = tempfile::tempdir().unwrap();
            let owner = "account:legacy-route-fence";
            let meter = WorkMeter::new();
            let base_path = state.path().canonicalize().unwrap().join("record-book.sqlite");
            drop(crate::storage::sqlite::Connection::open(&base_path).unwrap());
            let mut original = record_store_resources::open(&base_path, meter.clone()).unwrap();
            OwnRecords::initialize_new_work_store(&mut original, owner, 1).unwrap();
            let record = native::body(&crate::legacy_records::StoredRecord { id: "legacy-record".into(), record_type: "note".into(), sequence: "2026-10-31T00:00:00Z".into(), value_json: r#"{"text":"kept"}"#.into(), meta_json: None, protected_key_present: false });
            put(&mut original, owner, RESOURCE, "legacy-record", record.clone(), "legacy-record-live");
            let version = original.held_record_with_version(owner, RESOURCE, "legacy-record").unwrap().0;
            original.mutate(owner, RESOURCE, Mutation { id: "legacy-record".into(), expected_version: version, request_key: "legacy-record-delete".into(), deleted: true, value: serde_json::Value::Null }).unwrap();
            put(&mut original, owner, KEYS, "key-only", json!({"erased": true}), "legacy-key-erased");
            let mut identities = vec![identity("legacy-record"), identity("key-only")];
            identities.push(own_command_identity("legacy-permit").unwrap());
            let request = crate::local_account::resource_affinity::ResolveRequest { owner: owner.into(), generation: "1".into(), identities: identities.clone(), group: Some("atomic:legacy-duplicate".into()) };
            let route = crate::local_account::resource_affinity::store::AffinityDirectory::new(state.path(), meter.clone(), owner, "1").unwrap().install_and_resolve(&request, || Ok(())).unwrap();
            assert_ne!(route.resource, "@own-records");
            let (_, mut routed) = record_store_resources::open_state_resource(&route.resource, state.path(), meter).unwrap();
            put(&mut routed, owner, RESOURCE, "legacy-record", record, "routed-record-live");
            put(&mut routed, owner, KEYS, "key-only", json!({"key": "not-a-real-secret"}), "routed-key-live");
            assert!(has_original_history(&mut original, owner, &identities).unwrap());
            assert_eq!(reject_internal_route_with_legacy_history(&mut original, owner, &route.resolution.identities), Err(crate::cause!(Error::Conflict)));
        }

        #[test]
        fn an_unbound_identity_with_only_legacy_key_history_is_not_fresh() {
            let state = tempfile::tempdir().unwrap();
            let owner = "account:legacy-key-route-fence";
            let path = state.path().canonicalize().unwrap().join("record-book.sqlite");
            drop(crate::storage::sqlite::Connection::open(&path).unwrap());
            let mut original = record_store_resources::open(&path, WorkMeter::new()).unwrap();
            OwnRecords::initialize_new_work_store(&mut original, owner, 1).unwrap();
            put(&mut original, owner, KEYS, "erased-without-record", json!({"erased": true}), "key-erasure-only");
            assert!(has_original_history(&mut original, owner, &[identity("erased-without-record")]).unwrap());
        }

        #[test]
        fn own_command_identity_is_not_checked_as_a_record_or_key_history() {
            let state = tempfile::tempdir().unwrap();
            let owner = "account:command-route-fence";
            let path = state.path().canonicalize().unwrap().join("record-book.sqlite");
            drop(crate::storage::sqlite::Connection::open(&path).unwrap());
            let mut original = record_store_resources::open(&path, WorkMeter::new()).unwrap();
            OwnRecords::initialize_new_work_store(&mut original, owner, 1).unwrap();
            let identities = vec![identity("fresh-record"), own_command_identity("permit-2").unwrap()];
            assert!(!has_original_history(&mut original, owner, &identities).unwrap());
            assert!(has_original_history(&mut original, owner, &[own_command_identity("permit-2").unwrap()]).is_err());
        }

        #[test]
        fn permit_identity_reuses_record_group_and_refuses_cross_bound_group() {
            let state = tempfile::tempdir().unwrap();
            let owner = "account:own-command-affinity";
            let directory = crate::local_account::resource_affinity::store::AffinityDirectory::new(state.path(), WorkMeter::new(), owner, "1").unwrap();
            let request = |record_ids: &[&str], group: &str| {
                let records = record_ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
                crate::local_account::resource_affinity::ResolveRequest { owner: owner.into(), generation: "1".into(), identities: own_record_route_identities(&records).unwrap(), group: Some(group.into()) }
            };
            let first = directory.install_and_resolve(&request(&["record-a", "record-b"], "records-ab"), || Ok(())).unwrap();
            directory.associate_identity_with_group(&own_command_identity("permit-1").unwrap(), "records-ab", || Ok(())).unwrap();
            let changed_permit = directory.resolve_associated_identity(&own_command_identity("permit-1").unwrap(), || Ok(())).unwrap().unwrap();
            assert_eq!(changed_permit.resource, first.resource);
            assert!(directory.resolve_points(&[identity("unrelated-new-record")], || Ok(())).unwrap().is_none());
            let second = directory.install_and_resolve(&request(&["record-a", "record-b"], "records-ab"), || Ok(())).unwrap();
            directory.associate_identity_with_group(&own_command_identity("permit-2").unwrap(), "records-ab", || Ok(())).unwrap();
            assert_eq!(first.resource, second.resource);
            assert_eq!(second.resolution.identities.len(), 2);
            directory.install_and_resolve(&request(&["record-other"], "records-c"), || Ok(())).unwrap();
            assert!(directory.associate_identity_with_group(&own_command_identity("permit-2").unwrap(), "records-c", || Ok(())).is_err());
            assert!(directory.resolve_points(&[identity("record-c")], || Ok(())).unwrap().is_none());
        }
    }
}

fn valid(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_TEXT && !value.bytes().any(|byte| byte < 0x20)
}

fn identity_key(identity: &Identity) -> Result<String, Error> {
    if !valid(&identity.kind) || !valid(&identity.id) {
        return Err(Error::Invalid(
            "identity kind and id must be bounded non-empty text",
         crate::cause!()));
    }
    let bytes = serde_json::to_vec(&(&identity.kind, &identity.id)).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
    Ok(format!("1f:{}", blake3::hash(&bytes).to_hex()))
}

fn group_key(group: &str) -> Result<String, Error> {
    if !valid(group) {
        return Err(Error::Invalid(
            "relationship group must be bounded non-empty text",
         crate::cause!()));
    }
    let bytes = serde_json::to_vec(group).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
    Ok(format!("1f:{}", blake3::hash(&bytes).to_hex()))
}

fn resource_key(address: &ResourceAddress) -> Result<String, Error> {
    if !valid(&address.owner) || !valid(&address.resource) {
        return Err(Error::Invalid(
            "resource owner and address must be bounded non-empty text",
         crate::cause!()));
    }
    serde_json::to_string(&(&address.owner, &address.resource)).map_err(|error| crate::carry_cause!(Error::Corrupt, error))
}

fn deterministic_target(
    owner: &str,
    generation: &str,
    group: Option<&str>,
    identity_keys: &[String],
    targets: &[GrowthTarget],
) -> Result<ResourceAddress, Error> {
    let mut unique = BTreeMap::<String, ResourceAddress>::new();
    for target in targets {
        let key = resource_key(&target.address)?;
        if target.address.owner != owner {
            return Err(crate::cause!(Error::OwnerMismatch));
        }
        if target.installed && !target.refuses_growth {
            unique.insert(key, target.address.clone());
        }
    }
    let candidates: Vec<_> = unique.into_values().collect();
    if candidates.is_empty() {
        return Err(crate::cause!(Error::NoGrowthTarget));
    }

    // Match the historical selector: hash compact JSON [owner, generation,
    // group-key-or-sorted-identity-keys], take its first 12 hex digits, then
    // index the lexically sorted addressed-resource candidates.
    let selection = match group {
        Some(group) => serde_json::to_value(group_key(group)?).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?,
        None => serde_json::to_value(identity_keys).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?,
    };
    let bytes = serde_json::to_vec(&(owner, generation, selection)).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
    let hex = blake3::hash(&bytes).to_hex().to_string();
    let index =
        usize::from_str_radix(&hex[..12], 16).map_err(|error| crate::carry_cause!(Error::Corrupt, error))? % candidates.len();
    Ok(candidates[index].clone())
}

/// Resolve an explicit identity set against durable affinity and eligible
/// installed growth targets. Persist canonical rows by compare-and-set in the
/// directory transaction, mark group publication pending, then repair point
/// projections and mark publication complete after exact readback.
///
/// `bindings` and `groups` are bounded snapshots from the actual affinity
/// owner. The owner must check their revision/generation around this pure
/// calculation and commit; a stale snapshot cannot safely route a write.
pub fn resolve(
    request: &ResolveRequest,
    bindings: &[IdentityBinding],
    groups: &[GroupBinding],
    targets: &[GrowthTarget],
) -> Result<Resolution, Error> {
    if !valid(&request.owner) || !valid(&request.generation) {
        return Err(Error::Invalid(
            "owner and generation must be bounded non-empty text",
         crate::cause!()));
    }
    if request.identities.is_empty() || request.identities.len() > MAX_IDENTITIES {
        return Err(Error::Invalid(
            "one to 1000 explicit identities are required",
         crate::cause!()));
    }
    let wanted_group_key = request.group.as_deref().map(group_key).transpose()?;

    let mut unique = BTreeMap::<String, Identity>::new();
    for identity in &request.identities {
        let key = identity_key(identity)?;
        if unique.get(&key).is_some_and(|prior| prior != identity) {
            return Err(crate::cause!(Error::Corrupt));
        }
        unique.entry(key).or_insert_with(|| identity.clone());
    }
    let mut existing_by_key = BTreeMap::<String, &IdentityBinding>::new();
    for row in bindings {
        if row.owner != request.owner {
            return Err(crate::cause!(Error::OwnerMismatch));
        }
        if row.generation != request.generation {
            return Err(crate::cause!(Error::GenerationMismatch));
        }
        let key = identity_key(&row.identity)?;
        if existing_by_key.insert(key.clone(), row).is_some() {
            return Err(crate::cause!(Error::Corrupt));
        }
        if row.tombstone {
            continue;
        }
        if row.address.owner != request.owner {
            return Err(crate::cause!(Error::OwnerMismatch));
        }
        resource_key(&row.address)?;
    }
    if let Some(group) = request.group.as_deref() {
        // A caller may retry with one member of an older group. Reconstruct
        // the full canonical membership from the affinity directory before
        // publishing or repairing any point projections.
        for row in bindings
            .iter()
            .filter(|row| row.group.as_deref() == Some(group))
        {
            if row.tombstone {
                return Err(crate::cause!(Error::Tombstoned));
            }
            let key = identity_key(&row.identity)?;
            if unique.get(&key).is_some_and(|prior| prior != &row.identity) {
                return Err(crate::cause!(Error::Corrupt));
            }
            unique.entry(key).or_insert_with(|| row.identity.clone());
        }
    }
    let identities: Vec<_> = unique.values().cloned().collect();
    let identity_keys: Vec<_> = unique.keys().cloned().collect();
    let mut existing_group: Option<&GroupBinding> = None;
    if let Some(group) = request.group.as_deref() {
        for row in groups {
            if row.owner != request.owner {
                return Err(crate::cause!(Error::OwnerMismatch));
            }
            if row.generation != request.generation {
                return Err(crate::cause!(Error::GenerationMismatch));
            }
            if group_key(&row.group)? == wanted_group_key.as_deref().unwrap_or_default() {
                if existing_group.replace(row).is_some() {
                    return Err(crate::cause!(Error::Corrupt));
                }
                if row.tombstone {
                    return Err(crate::cause!(Error::Tombstoned));
                }
                if row.address.owner != request.owner {
                    return Err(crate::cause!(Error::OwnerMismatch));
                }
                resource_key(&row.address)?;
            }
        }
    }

    let mut known_addresses = BTreeMap::<String, ResourceAddress>::new();
    if let Some(row) = existing_group {
        known_addresses.insert(resource_key(&row.address)?, row.address.clone());
    }
    for key in &identity_keys {
        if let Some(row) = existing_by_key.get(key) {
            if row.tombstone {
                return Err(crate::cause!(Error::Tombstoned));
            }
            if let (Some(requested), Some(prior)) = (request.group.as_deref(), row.group.as_deref())
            {
                if requested != prior {
                    return Err(crate::cause!(Error::Conflict));
                }
            }
            known_addresses.insert(resource_key(&row.address)?, row.address.clone());
        }
    }
    if known_addresses.len() > 1 {
        return Err(crate::cause!(Error::Conflict));
    }

    let address = match known_addresses.into_values().next() {
        Some(address) => address,
        None => deterministic_target(
            &request.owner,
            &request.generation,
            request.group.as_deref(),
            &identity_keys,
            targets,
        )?,
    };

    let group_write = if let Some(group) = request.group.as_ref() {
        match existing_group {
            Some(row) if row.address == address => None,
            Some(_) => return Err(crate::cause!(Error::Conflict)),
            None => Some(GroupBinding {
                owner: request.owner.clone(),
                generation: request.generation.clone(),
                group: group.clone(),
                address: address.clone(),
                tombstone: false,
            }),
        }
    } else {
        None
    };
    let mut canonical_identity_writes = Vec::new();
    for identity in &identities {
        let key = identity_key(identity)?;
        match existing_by_key.get(&key) {
            Some(row)
                if !row.tombstone
                    && row.address == address
                    && (request.group.is_none() || row.group == request.group) => {}
            Some(row)
                if !row.tombstone
                    && row.address == address
                    && row.group.is_none()
                    && request.group.is_some() =>
            {
                canonical_identity_writes.push(IdentityBinding {
                    owner: request.owner.clone(),
                    generation: request.generation.clone(),
                    identity: identity.clone(),
                    address: address.clone(),
                    group: request.group.clone(),
                    tombstone: false,
                })
            }
            Some(_) => return Err(crate::cause!(Error::Conflict)),
            None => canonical_identity_writes.push(IdentityBinding {
                owner: request.owner.clone(),
                generation: request.generation.clone(),
                identity: identity.clone(),
                address: address.clone(),
                group: request.group.clone(),
                tombstone: false,
            }),
        }
    }
    let mut point_identities = identities
        .iter()
        .map(|identity| IdentityBinding {
            owner: request.owner.clone(),
            generation: request.generation.clone(),
            identity: identity.clone(),
            address: address.clone(),
            group: request.group.clone(),
            tombstone: false,
        })
        .collect::<Vec<_>>();
    if let Some(group) = request.group.as_ref() {
        // Historical readers use an independently addressed atomic-group
        // point as a projection. The directory group row stays canonical;
        // this point is repaired from that row after an interrupted publish.
        let group_identity = Identity {
            kind: "atomic-group".into(),
            id: group.clone(),
        };
        point_identities.push(IdentityBinding {
            owner: request.owner.clone(),
            generation: request.generation.clone(),
            identity: group_identity,
            address: address.clone(),
            group: Some(group.clone()),
            tombstone: false,
        });
    }
    Ok(Resolution {
        address,
        generation: request.generation.clone(),
        group: request.group.clone(),
        identities,
        writes: AffinityWrites {
            canonical_identities: canonical_identity_writes,
            point_identities,
            group: group_write,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(kind: &str, id: &str) -> Identity {
        Identity {
            kind: kind.into(),
            id: id.into(),
        }
    }
    fn address(resource: &str) -> ResourceAddress {
        ResourceAddress {
            owner: "account:one".into(),
            resource: resource.into(),
        }
    }
    fn target(resource: &str, refuses_growth: bool) -> GrowthTarget {
        GrowthTarget {
            address: address(resource),
            installed: true,
            refuses_growth,
        }
    }
    fn request(identities: Vec<Identity>, group: Option<&str>) -> ResolveRequest {
        ResolveRequest {
            owner: "account:one".into(),
            generation: "generation:1".into(),
            identities,
            group: group.map(str::to_owned),
        }
    }

    #[test]
    fn duplicate_identities_collapse_and_first_route_is_stable() {
        let ids = vec![
            identity("task", "t1"),
            identity("input", "i1"),
            identity("task", "t1"),
        ];
        let first = resolve(
            &request(ids.clone(), None),
            &[],
            &[],
            &[target("book:a", false), target("book:b", false)],
        )
        .unwrap();
        let repeated = resolve(
            &request(ids, None),
            &first.writes.canonical_identities,
            &[],
            &[target("book:b", false)],
        )
        .unwrap();
        assert_eq!(first.identities.len(), 2);
        assert_eq!(first.address, repeated.address);
        assert!(repeated.writes.canonical_identities.is_empty());
        assert_eq!(repeated.writes.point_identities.len(), 2);
    }

    #[test]
    fn explicit_group_binds_every_member_and_remains_canonical() {
        let selected = resolve(
            &request(
                vec![identity("input", "i1"), identity("list", "l1")],
                Some("task:t1/import"),
            ),
            &[],
            &[],
            &[target("book:a", false), target("book:b", false)],
        )
        .unwrap();
        assert_eq!(selected.writes.canonical_identities.len(), 2);
        assert_eq!(selected.writes.point_identities.len(), 3);
        assert_eq!(
            selected.writes.group.as_ref().unwrap().address,
            selected.address
        );
        let next = resolve(
            &request(vec![identity("list", "l2")], Some("task:t1/import")),
            &selected.writes.canonical_identities,
            &[selected.writes.group.unwrap()],
            &[target("book:other", false)],
        )
        .unwrap();
        assert_eq!(next.address, selected.address);
        assert_eq!(
            next.identities.len(),
            3,
            "retry exposes the whole canonical group"
        );
        assert_eq!(
            next.writes.point_identities.len(),
            4,
            "two members, the new member, and the group point are repairable"
        );
        assert!(next.writes.group.is_none());
    }

    #[test]
    fn incompatible_existing_routes_refuse_instead_of_merging() {
        let left = IdentityBinding {
            owner: "account:one".into(),
            generation: "generation:1".into(),
            identity: identity("input", "left"),
            address: address("book:a"),
            group: None,
            tombstone: false,
        };
        let right = IdentityBinding {
            owner: "account:one".into(),
            generation: "generation:1".into(),
            identity: identity("list", "right"),
            address: address("book:b"),
            group: None,
            tombstone: false,
        };
        assert_eq!(
            resolve(
                &request(
                    vec![left.identity.clone(), right.identity.clone()],
                    Some("unsafe-merge")
                ),
                &[left, right],
                &[],
                &[target("book:c", false)]
            )
            .unwrap_err(),
            crate::cause!(Error::Conflict)
        );
    }

    #[test]
    fn retained_affinity_survives_growth_refusal_and_absent_candidates() {
        let binding = IdentityBinding {
            owner: "account:one".into(),
            generation: "generation:1".into(),
            identity: identity("task", "t1"),
            address: address("book:full"),
            group: None,
            tombstone: false,
        };
        let found = resolve(
            &request(vec![binding.identity.clone()], None),
            &[binding],
            &[],
            &[target("book:full", true)],
        )
        .unwrap();
        assert_eq!(found.address.resource, "book:full");
        assert!(found.writes.canonical_identities.is_empty());
        assert_eq!(found.writes.point_identities.len(), 1);
        assert!(matches!(
            resolve(
                &request(vec![identity("task", "new")], None),
                &[],
                &[],
                &[target("book:full", true)]
            ),
            Err(Error::NoGrowthTarget(_))
        ));
    }

    #[test]
    fn generation_owner_and_tombstones_are_hard_boundaries() {
        let request = request(vec![identity("task", "t1")], None);
        let mut wrong = IdentityBinding {
            owner: "account:one".into(),
            generation: "old".into(),
            identity: identity("task", "t1"),
            address: address("book:a"),
            group: None,
            tombstone: false,
        };
        assert_eq!(
            resolve(&request, &[wrong.clone()], &[], &[]).unwrap_err(),
            crate::cause!(Error::GenerationMismatch)
        );
        wrong.generation = "generation:1".into();
        wrong.tombstone = true;
        assert_eq!(
            resolve(&request, &[wrong], &[], &[]).unwrap_err(),
            crate::cause!(Error::Tombstoned)
        );
        let mut other_owner = request.clone();
        other_owner.owner = "account:two".into();
        assert_eq!(
            resolve(&other_owner, &[], &[], &[target("book:a", false)]).unwrap_err(),
            crate::cause!(Error::OwnerMismatch)
        );
    }
}
