//! Durable record store owner for own-work resource affinity.
//!
//! The directory record is the canonical decision and publication journal. It
//! lives in one declared `@own-work-directory/<key>` resource. Each point
//! projection lives in its own `@own-work-point/<identity-key>` resource, and
//! each installed work resource remains a separate `@own-work/<key>` RecordBook.
//! These files do not share a transaction: a pending directory publication is
//! repaired from its canonical rows until every point can be read back exactly.
//!
//! This owner stores ordinary resource metadata in record store. It does not read or
//! write `policy.sqlite`, infer identities from record bodies, or prove source
//! rights. Its caller supplies identities from the trusted domain owner and a
//! generation/current-rights check that is checked before each durable stage.

use super::{
    group_key, identity_key, resolve, Error as ResolveError, GroupBinding, GrowthTarget, Identity,
    IdentityBinding, Resolution, ResolveRequest, ResourceAddress,
};
use crate::{
    records::{Mutation, Records},
    sqlite_work::WorkMeter,
    storage::{
        record_store_resources::{self, StateResources},
        sqlite::{self, Access, Supply},
    },
};
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fmt, path::Path, sync::Arc};

const CATALOGUE_RESOURCE: &str = "@own-work-directory/catalogue";
const CATALOGUE_ID: &str = "installed";
const LEGACY_MIGRATION_ID: &str = "legacy-migration";
const INSTALL_ROW_PREFIX: &str = "install:";
const DIRECTORY_ID: &str = "canonical";
const POINT_ID: &str = "binding";
const ASSOCIATION_ID: &str = "association";
const ROUTE_RESERVATION_ID: &str = "route-reservation";

#[derive(Clone, Debug)]
pub enum StoreError {
    Resolve(ResolveError, crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
    Conflict(crate::refusal_cause::Cause),
    Corrupt(crate::refusal_cause::Cause),
    GenerationChanged(crate::refusal_cause::Cause),
}
impl StoreError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Resolve(_, cause) => cause,
            Self::Unavailable(cause) => cause,
            Self::Conflict(cause) => cause,
            Self::Corrupt(cause) => cause,
            Self::GenerationChanged(cause) => cause,
        }
    }
}
crate::impl_caused!(StoreError);


impl PartialEq for StoreError {
    fn eq(&self, other: &Self) -> bool {
        match (self,other) {
            (Self::Resolve(a0, _),Self::Resolve(b0, _)) => a0 == b0,
            (Self::Unavailable(_),Self::Unavailable(_)) => true,
            (Self::Conflict(_),Self::Conflict(_)) => true,
            (Self::Corrupt(_),Self::Corrupt(_)) => true,
            (Self::GenerationChanged(_),Self::GenerationChanged(_)) => true,
            _ => false,
        }
    }
}
impl Eq for StoreError {}


impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Resolve(error, _) => return write!(f, "{error}"),
            Self::Unavailable(_) => "own-work affinity storage is unavailable",
            Self::Conflict(_) => "own-work affinity changed concurrently; retry the same operation",
            Self::Corrupt(_) => "own-work affinity metadata is unreadable",
            Self::GenerationChanged(_) => "the account generation or current rights changed",
        })
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

impl From<ResolveError> for StoreError {
    fn from(error: ResolveError) -> Self {
        let cause = error.cause();
        Self::Resolve(error, cause)
    }
}

impl From<crate::records::Error> for StoreError {
    fn from(error: crate::records::Error) -> Self {
        map_records_error(error)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Catalogue {
    owner: String,
    generation: String,
    resources: BTreeMap<String, InstallState>,
}

/// One durable step of the old singleton-to-install-row migration. `after`
/// is a strict resource-name cursor; `legacy_version` pins every replay to
/// the exact source value whose complete JSON body was decoded.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LegacyMigration {
    owner: String,
    generation: String,
    legacy_version: i64,
    after: Option<String>,
    complete: bool,
}

/// One independently addressed install witness. Unlike the historical
/// singleton catalogue, the serialized value stays constant as the account
/// gains more work resources.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct InstallRecord {
    owner: String,
    generation: String,
    resource: String,
    state: InstallState,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct AssociatedIdentity {
    owner: String,
    generation: String,
    identity: Identity,
    group: String,
    address: ResourceAddress,
}

/// An immutable route for an operation identity, independent of relationship
/// membership. In particular, a legacy route requires no invented work group.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct IdentityRouteReservation {
    owner: String,
    generation: String,
    identity: Identity,
    address: ResourceAddress,
}

/// A constant-size identity association to a previously completed group.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssociatedRoute {
    pub group: String,
    pub resource: String,
}

/// One bounded page of installed work targets. `next` is the strict record store
/// record-id cursor for the next page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledResourcesPage {
    pub resources: Vec<String>,
    pub next: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum InstallState {
    Reserved,
    Installed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct DirectoryEntry {
    owner: String,
    generation: String,
    directory_key: String,
    publication: Publication,
    canonical_identities: Vec<IdentityBinding>,
    group: Option<GroupBinding>,
    resolution: Resolution,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Publication {
    Reserved,
    Pending,
    Complete,
}

/// A route returned only after the canonical directory is complete and every
/// independently addressed point projection has been read back exactly.
#[derive(Clone, Debug)]
pub struct DurableResolution {
    pub resolution: Resolution,
    /// The physical own-work resource name the command must use for this
    /// complete source-proved unit.
    pub resource: String,
}

/// The account-local affinity owner. `owner` and `generation` are snapshots
/// supplied by the selected account owner; every operation also calls the
/// current-rights/generation check before it mutates or discloses a route.
pub struct AffinityDirectory {
    resources: Arc<StateResources>,
    state: std::path::PathBuf,
    meter: WorkMeter,
    owner: String,
    generation: String,
}

impl AffinityDirectory {
    pub fn new(
        state: &Path,
        meter: WorkMeter,
        owner: impl Into<String>,
        generation: impl Into<String>,
    ) -> Result<Self, StoreError> {
        let owner = owner.into();
        let generation = generation.into();
        if owner.trim().is_empty() || generation.trim().is_empty() {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        let state = state.canonicalize().map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        let resources =
            StateResources::new(&state, meter.clone()).map_err(|error| StoreError::Unavailable(error.cause()))?;
        Ok(Self {
            resources: Arc::new(resources),
            state,
            meter,
            owner,
            generation,
        })
    }

    /// Resolve and durably publish one source-proved request. Existing point
    /// and group bindings win. With no installed target, this owner reserves a
    /// deterministic opaque resource name in its catalogue, creates the record store
    /// file and installation marker, and only then makes that target eligible.
    /// The canonical directory commit is a single record mutation; point
    /// projections are independently repaired and checked before completion.
    pub fn install_and_resolve(
        &self,
        request: &ResolveRequest,
        mut assert_current: impl FnMut() -> Result<(), StoreError>,
    ) -> Result<DurableResolution, StoreError> {
        self.check_request(request)?;
        assert_current()?;
        let mut effective = request.clone();
        let initial_key = directory_key(request)?;
        let mut previous = self.read_directory(&format!("@own-work-directory/{initial_key}"))?;
        if request.group.is_none() {
            let points = self.read_points(request, &None)?;
            let prior_groups = points
                .iter()
                .filter_map(|binding| binding.group.clone())
                .collect::<std::collections::BTreeSet<_>>();
            if prior_groups.len() > 1 {
                return Err(StoreError::from(crate::cause!(ResolveError::Conflict)));
            }
            if let Some(group) = prior_groups.into_iter().next() {
                let requested = request
                    .identities
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>();
                let found = points
                    .iter()
                    .map(|binding| &binding.identity)
                    .collect::<std::collections::BTreeSet<_>>();
                if requested != found {
                    return Err(StoreError::from(crate::cause!(ResolveError::Conflict)));
                }
                effective.group = Some(group.clone());
                let key = group_key(&group)?;
                previous = self.read_directory(&format!("@own-work-directory/{key}"))?;
                if previous.is_none() {
                    return Err(crate::cause!(StoreError::Corrupt));
                }
            }
        }
        let request = &effective;
        let directory_key = directory_key(request)?;
        let directory_resource = format!("@own-work-directory/{directory_key}");
        if let Some(entry) = &previous {
            self.check_directory_entry(entry, &directory_key)?;
        }

        let mut targets = Vec::new();
        let mut bindings = self.read_points(request, &previous)?;
        let groups = previous
            .as_ref()
            .and_then(|entry| entry.group.clone())
            .into_iter()
            .collect::<Vec<_>>();

        let mut selected;
        if previous
            .as_ref()
            .is_some_and(|entry| entry.publication == Publication::Reserved)
        {
            let reserved_resource = previous
                .as_ref()
                .expect("reserved entry is present")
                .resolution
                .address
                .resource
                .clone();
            if self
                .read_install_record(&reserved_resource, &mut assert_current)?
                .as_ref()
                .map(|row| &row.state)
                != Some(&InstallState::Installed)
            {
                self.reserve_target(&reserved_resource, &mut assert_current)?;
                self.install_target(&reserved_resource, &mut assert_current)?;
            }
            targets.push(GrowthTarget {
                address: ResourceAddress {
                    owner: self.owner.clone(),
                    resource: reserved_resource,
                },
                installed: true,
                refuses_growth: false,
            });
            bindings = self.read_points(request, &previous)?;
            selected = resolve(request, &bindings, &groups, &targets)?;
        } else if !has_existing_route(&bindings, &groups) {
            // The installed catalogue is an inventory of existing route
            // owners, not a shared bucket for unrelated new work. Every new
            // source-proved group reserves its own content-addressed target;
            // only existing bindings or explicit group membership can reuse
            // another group's physical RecordBook.
            let work_resource = format!(
                "@own-work/{}",
                opaque_key(&self.owner, &self.generation, &directory_key)
            );
            let candidate = GrowthTarget {
                address: ResourceAddress {
                    owner: self.owner.clone(),
                    resource: work_resource.clone(),
                },
                installed: true,
                refuses_growth: false,
            };
            selected = resolve(request, &bindings, &groups, &[candidate.clone()])?;
            let reserved = directory_entry(
                &self.owner,
                &self.generation,
                &directory_key,
                Publication::Reserved,
                &selected,
            );
            assert_current()?;
            self.write_directory(
                &directory_resource,
                previous.as_ref(),
                &reserved,
                &mut assert_current,
            )?;
            previous = Some(reserved);
            self.reserve_target(&work_resource, &mut assert_current)?;
            self.install_target(&work_resource, &mut assert_current)?;
            bindings = self.read_points(request, &previous)?;
            selected = resolve(request, &bindings, &groups, &[candidate])?;
        } else {
            selected = resolve(request, &bindings, &groups, &targets)?;
        }

        // Retained affinities may point at a resource removed from the growth
        // catalogue. Every selected route must still pass its own install
        // proof before it is handed to the command owner.
        self.verify_target(&selected.address.resource, &mut assert_current)?;

        let pending = directory_entry(
            &self.owner,
            &self.generation,
            &directory_key,
            Publication::Pending,
            &selected,
        );
        assert_current()?;
        self.write_directory(
            &directory_resource,
            previous.as_ref(),
            &pending,
            &mut assert_current,
        )?;

        // Repair every member of a retry's complete canonical group, not only
        // the identities in the latest operation.
        for point in &selected.writes.point_identities {
            self.repair_point(point, &mut assert_current)?;
        }
        for canonical in &selected.writes.canonical_identities {
            self.verify_point(canonical)?;
        }

        let complete = DirectoryEntry {
            publication: Publication::Complete,
            ..pending.clone()
        };
        assert_current()?;
        self.write_directory(
            &directory_resource,
            Some(&pending),
            &complete,
            &mut assert_current,
        )?;
        assert_current()?;

        Ok(DurableResolution {
            resource: selected.address.resource.clone(),
            resolution: selected,
        })
    }

    /// Read a completed, currently checked route without changing affinity.
    /// Pending group publications are repaired by `install_and_resolve` and
    /// are never disclosed here.
    pub fn resolve_existing(
        &self,
        request: &ResolveRequest,
        mut assert_current: impl FnMut() -> Result<(), StoreError>,
    ) -> Result<Option<DurableResolution>, StoreError> {
        self.check_request(request)?;
        assert_current()?;
        let key = directory_key(request)?;
        let resource = format!("@own-work-directory/{key}");
        let Some(entry) = self.read_directory(&resource)? else {
            return Ok(None);
        };
        self.check_directory_entry(&entry, &key)?;
        if entry.publication != Publication::Complete {
            return Ok(None);
        }
        for point in &entry.resolution.writes.point_identities {
            self.verify_point(point)?;
        }
        assert_current()?;
        Ok(Some(DurableResolution {
            resource: entry.resolution.address.resource.clone(),
            resolution: entry.resolution,
        }))
    }

    /// Read one bounded page of installed physical work resources. Each
    /// target is proved against its own install row and file header. Reserved
    /// resources are omitted; a missing or changed installed target refuses.
    pub fn installed_resources_page(
        &self,
        after: Option<&str>,
        limit: usize,
        mut assert_current: impl FnMut() -> Result<(), StoreError>,
    ) -> Result<InstalledResourcesPage, StoreError> {
        if limit == 0 || limit > crate::records::MAX_PAGE_ITEMS {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        assert_current()?;
        if self.migrate_legacy_catalogue(limit, &mut assert_current)? > 0 {
            // Migration rows consume this call's target-work allowance. Do
            // not also verify and return a page of installed targets.
            return Err(crate::cause!(StoreError::Unavailable));
        }
        let page = self.with_store(CATALOGUE_RESOURCE, |store| {
            let (ids, next) = store
                .ids(&self.owner, CATALOGUE_RESOURCE, after, limit)
                .map_err(map_records_error)?;
            let mut items = Vec::with_capacity(ids.len());
            for id in ids {
                let (_, record) = store
                    .held_record_with_version(&self.owner, CATALOGUE_RESOURCE, &id)
                    .map_err(map_records_error)?;
                items.push((id, record.ok_or(crate::cause!(StoreError::Corrupt))?.value));
            }
            Ok((items, next))
        })?;
        let (items, next) = page;
        let resources = self.installed_resources_in_rows(items)?;
        for resource in &resources {
            self.verify_target(resource, &mut assert_current)?;
        }
        assert_current()?;
        Ok(InstalledResourcesPage { resources, next })
    }

    /// The installed catalogue on its actual read-only handles. A missing
    /// catalogue is empty; a legacy singleton or pending migration refuses
    /// until the writer completes that work. Inspection never creates a file,
    /// initializes its tables, migrates a catalogue, or repairs a target.
    pub fn installed_resources_page_read_only(
        &self,
        after: Option<&str>,
        limit: usize,
        mut assert_current: impl FnMut() -> Result<(), StoreError>,
    ) -> Result<InstalledResourcesPage, StoreError> {
        if limit == 0 || limit > crate::records::MAX_PAGE_ITEMS {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        assert_current()?;
        let page = self.with_read_store(CATALOGUE_RESOURCE, |store| {
            self.check_read_only_catalogue(&store)?;
            let (ids, next) = store.ids(&self.owner, CATALOGUE_RESOURCE, after, limit).map_err(map_records_error)?;
            let mut items = Vec::with_capacity(ids.len());
            for id in ids {
                let (_, record) = store.held_record_with_version(&self.owner, CATALOGUE_RESOURCE, &id).map_err(map_records_error)?;
                items.push((id, record.ok_or(crate::cause!(StoreError::Corrupt))?.value));
            }
            Ok((items, next))
        })?;
        let (items, next) = page.unwrap_or_default();
        let resources = self.installed_resources_in_rows(items)?;
        for resource in &resources {
            self.verify_target_read_only(resource, &mut assert_current)?;
        }
        assert_current()?;
        Ok(InstalledResourcesPage { resources, next })
    }

    /// Both catalogue readers validate the exact same row shape and identity;
    /// only the caller's maintenance authority differs.
    fn installed_resources_in_rows(&self, items: Vec<(String, Value)>) -> Result<Vec<String>, StoreError> {
        let mut resources = Vec::with_capacity(items.len());
        for (id, value) in items {
            if id == LEGACY_MIGRATION_ID {
                continue;
            }
            if !id.starts_with(INSTALL_ROW_PREFIX) {
                return Err(crate::cause!(StoreError::Corrupt));
            }
            let row: InstallRecord =
                serde_json::from_value(value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
            if row.owner != self.owner
                || row.generation != self.generation
                || install_row_id(&row.resource) != id
            {
                return Err(crate::cause!(StoreError::GenerationChanged));
            }
            if row.state == InstallState::Installed {
                resources.push(row.resource);
            }
        }
        Ok(resources)
    }

    /// Compatibility collector for existing internal callers. New listing
    /// callers should keep the page boundary and continue with `next`.
    pub fn installed_resources(
        &self,
        mut assert_current: impl FnMut() -> Result<(), StoreError>,
    ) -> Result<Vec<String>, StoreError> {
        let mut resources = Vec::new();
        let mut after = None;
        loop {
            let page = self.installed_resources_page(after.as_deref(), 128, &mut assert_current)?;
            resources.extend(page.resources);
            after = page.next;
            if after.is_none() {
                break;
            }
        }
        resources.sort();
        Ok(resources)
    }

    /// Reserve one operation identity's route before its effect. Exact replay
    /// keeps the original address even when no effect receipt exists yet;
    /// rebinding and recreation of a deleted reservation refuse. The caller
    /// proves the selected target and fresh rights through `assert_current`,
    /// including inside the durable write check. No group is created here.
    pub fn reserve_identity_route(
        &self,
        identity: &Identity,
        address: &ResourceAddress,
        mut assert_current: impl FnMut(&ResourceAddress) -> Result<(), StoreError>,
    ) -> Result<ResourceAddress, StoreError> {
        let resource = association_resource(identity)?;
        let reservation = IdentityRouteReservation {
            owner: self.owner.clone(),
            generation: self.generation.clone(),
            identity: identity.clone(),
            address: address.clone(),
        };
        self.check_identity_route(&reservation, identity)?;
        assert_current(address)?;
        let (version, current) = self.held(&resource, ROUTE_RESERVATION_ID)?;
        if let Some(record) = current {
            let held: IdentityRouteReservation =
                serde_json::from_value(record.value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
            self.check_identity_route(&held, identity)?;
            if held != reservation {
                return Err(crate::cause!(StoreError::Conflict));
            }
        } else {
            if version != 0 {
                return Err(crate::cause!(StoreError::Conflict));
            }
            self.write_value_at(
                &resource,
                ROUTE_RESERVATION_ID,
                &reservation,
                0,
                &mut || assert_current(address),
            )?;
        }
        let held = self
            .read_value(&resource, ROUTE_RESERVATION_ID)?
            .ok_or(crate::cause!(StoreError::Corrupt))?;
        let held: IdentityRouteReservation =
            serde_json::from_value(held).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
        self.check_identity_route(&held, identity)?;
        if held != reservation {
            return Err(crate::cause!(StoreError::Conflict));
        }
        assert_current(&held.address)?;
        Ok(held.address)
    }

    /// Recover the original route before choosing a new destination or
    /// looking for an effect receipt. Target proof is supplied by the caller:
    /// a legacy identity owner or an installed complete internal association.
    pub fn resolve_reserved_identity_route(
        &self,
        identity: &Identity,
        mut assert_current: impl FnMut(&ResourceAddress) -> Result<(), StoreError>,
    ) -> Result<Option<ResourceAddress>, StoreError> {
        let resource = association_resource(identity)?;
        let (version, record) = self.held(&resource, ROUTE_RESERVATION_ID)?;
        let Some(record) = record else {
            return if version == 0 { Ok(None) } else { Err(crate::cause!(StoreError::Conflict)) };
        };
        let reservation: IdentityRouteReservation =
            serde_json::from_value(record.value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
        self.check_identity_route(&reservation, identity)?;
        assert_current(&reservation.address)?;
        let (current_version, current) = self.held(&resource, ROUTE_RESERVATION_ID)?;
        if current_version != version
            || current.map(|record| record.value)
                != Some(serde_json::to_value(&reservation).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?)
        {
            return Err(crate::cause!(StoreError::Conflict));
        }
        assert_current(&reservation.address)?;
        Ok(Some(reservation.address))
    }

    fn check_identity_route(
        &self,
        reservation: &IdentityRouteReservation,
        identity: &Identity,
    ) -> Result<(), StoreError> {
        if reservation.owner != self.owner || reservation.generation != self.generation {
            return Err(crate::cause!(StoreError::GenerationChanged));
        }
        if reservation.address.owner != self.owner {
            return Err(StoreError::from(crate::cause!(ResolveError::OwnerMismatch)));
        }
        if reservation.identity != *identity {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        super::resource_key(&reservation.address)?;
        Ok(())
    }

    /// Associate one independent identity with an already complete group.
    /// The group membership stays unchanged; an existing association is
    /// idempotent only when every bound field still matches.
    pub fn associate_identity_with_group(
        &self,
        identity: &Identity,
        group: &str,
        mut assert_current: impl FnMut() -> Result<(), StoreError>,
    ) -> Result<AssociatedRoute, StoreError> {
        assert_current()?;
        let association =
            self.association_for_current_group(identity, group, &mut assert_current)?;
        let resource = association_resource(identity)?;
        let (version, current) = self.held(&resource, ASSOCIATION_ID)?;
        if let Some(record) = current {
            let held: AssociatedIdentity =
                serde_json::from_value(record.value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
            if held != association {
                return Err(StoreError::from(crate::cause!(ResolveError::Conflict)));
            }
        } else {
            self.write_value_at(
                &resource,
                ASSOCIATION_ID,
                &association,
                version,
                &mut assert_current,
            )?;
        }
        self.verify_association(&association, &mut assert_current)?;
        Ok(AssociatedRoute {
            group: association.group,
            resource: association.address.resource,
        })
    }

    /// Read an existing independent association without creating or repairing
    /// it. The named group and target are revalidated before disclosing route.
    pub fn resolve_associated_identity(
        &self,
        identity: &Identity,
        mut assert_current: impl FnMut() -> Result<(), StoreError>,
    ) -> Result<Option<AssociatedRoute>, StoreError> {
        assert_current()?;
        let resource = association_resource(identity)?;
        let Some(value) = self.read_value(&resource, ASSOCIATION_ID)? else {
            return Ok(None);
        };
        let association: AssociatedIdentity =
            serde_json::from_value(value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
        if association.identity != *identity
            || association.owner != self.owner
            || association.generation != self.generation
        {
            return Err(crate::cause!(StoreError::GenerationChanged));
        }
        self.verify_association(&association, &mut assert_current)?;
        assert_current()?;
        Ok(Some(AssociatedRoute {
            group: association.group,
            resource: association.address.resource,
        }))
    }

    fn association_for_current_group(
        &self,
        identity: &Identity,
        group: &str,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<AssociatedIdentity, StoreError> {
        let key = group_key(group)?;
        let directory_resource = format!("@own-work-directory/{key}");
        let entry = self
            .read_directory(&directory_resource)?
            .ok_or(crate::cause!(StoreError::Corrupt))?;
        self.check_directory_entry(&entry, &key)?;
        let canonical_members = entry
            .canonical_identities
            .iter()
            .map(|binding| binding.identity.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let resolved_members = entry
            .resolution
            .identities
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        if entry.publication != Publication::Complete
            || entry.group.as_ref().is_none_or(|binding| {
                binding.group != group
                    || binding.address != entry.resolution.address
                    || binding.tombstone
            })
            || entry.resolution.group.as_deref() != Some(group)
            || canonical_members.is_empty()
            || canonical_members.len() != entry.canonical_identities.len()
            || canonical_members != resolved_members
            || entry.canonical_identities.iter().any(|binding| {
                binding.owner != self.owner
                    || binding.generation != self.generation
                    || binding.address != entry.resolution.address
                    || binding.group.as_deref() != Some(group)
                    || binding.tombstone
            })
        {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        self.verify_target(&entry.resolution.address.resource, assert_current)?;
        Ok(AssociatedIdentity {
            owner: self.owner.clone(),
            generation: self.generation.clone(),
            identity: identity.clone(),
            group: group.to_owned(),
            address: entry.resolution.address,
        })
    }

    fn verify_association(
        &self,
        association: &AssociatedIdentity,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        let canonical = self.association_for_current_group(
            &association.identity,
            &association.group,
            assert_current,
        )?;
        if canonical != *association {
            return Err(StoreError::from(crate::cause!(ResolveError::Conflict)));
        }
        let resource = association_resource(&association.identity)?;
        let value = self
            .read_value(&resource, ASSOCIATION_ID)?
            .ok_or(crate::cause!(StoreError::Corrupt))?;
        let held: AssociatedIdentity =
            serde_json::from_value(value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
        if held != *association {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        Ok(())
    }

    /// Follow already-published point bindings for a request identity subset.
    /// If a point names a relationship group, its canonical directory is the
    /// authority: the entire canonical membership is validated and returned.
    /// A caller can use this before deciding whether an unbound source record
    /// remains in the legacy RecordBook or needs a new installed work resource.
    pub fn resolve_points(
        &self,
        identities: &[Identity],
        mut assert_current: impl FnMut() -> Result<(), StoreError>,
    ) -> Result<Option<DurableResolution>, StoreError> {
        self.resolve_points_with_maintenance(identities, true, &mut assert_current)
    }

    /// Follow the same published route calculation without maintaining it.
    /// A missing or mismatched group point is refused, never repaired during
    /// inspection; the selected target's install witness is read-only too.
    pub fn resolve_points_read_only(
        &self,
        identities: &[Identity],
        mut assert_current: impl FnMut() -> Result<(), StoreError>,
    ) -> Result<Option<DurableResolution>, StoreError> {
        let answer = self.resolve_points_with_maintenance(identities, false, &mut assert_current)?;
        // A missing or pending route also discloses a current result. Keep
        // the caller's check on the shared calculation's early-None paths.
        assert_current()?;
        Ok(answer)
    }

    fn resolve_points_with_maintenance(
        &self,
        identities: &[Identity],
        repair: bool,
        mut assert_current: impl FnMut() -> Result<(), StoreError>,
    ) -> Result<Option<DurableResolution>, StoreError> {
        if identities.is_empty() {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        assert_current()?;
        let request = ResolveRequest {
            owner: self.owner.clone(),
            generation: self.generation.clone(),
            identities: identities.to_vec(),
            group: None,
        };
        let point_bindings = self.read_points(&request, &None)?;
        if point_bindings.is_empty() {
            return Ok(None);
        }
        let groups = point_bindings
            .iter()
            .filter_map(|binding| binding.group.clone())
            .collect::<std::collections::BTreeSet<_>>();
        if groups.len() > 1 {
            return Err(StoreError::from(crate::cause!(ResolveError::Conflict)));
        }

        if let Some(group) = groups.into_iter().next() {
            let key = group_key(&group)?;
            let resource = format!("@own-work-directory/{key}");
            let Some(entry) = self.read_directory(&resource)? else {
                return Err(crate::cause!(StoreError::Corrupt));
            };
            self.check_directory_entry(&entry, &key)?;
            if entry.publication != Publication::Complete {
                return Ok(None);
            }
            let group_binding = entry.group.as_ref().ok_or(crate::cause!(StoreError::Corrupt))?;
            if group_binding.group != group || group_binding.address != entry.resolution.address {
                return Err(crate::cause!(StoreError::Corrupt));
            }
            if entry.resolution.group.as_deref() != Some(group.as_str()) {
                return Err(crate::cause!(StoreError::Corrupt));
            }
            let canonical_members = entry
                .canonical_identities
                .iter()
                .map(|binding| binding.identity.clone())
                .collect::<std::collections::BTreeSet<_>>();
            let resolved_members = entry
                .resolution
                .identities
                .iter()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>();
            if canonical_members.is_empty() || canonical_members != resolved_members {
                return Err(crate::cause!(StoreError::Corrupt));
            }
            if identities
                .iter()
                .any(|identity| !canonical_members.contains(identity))
            {
                return Ok(None);
            }
            for binding in &point_bindings {
                let canonical = entry
                    .canonical_identities
                    .iter()
                    .find(|canonical| canonical.identity == binding.identity)
                    .ok_or(crate::cause!(StoreError::Corrupt))?;
                if canonical != binding {
                    return Err(StoreError::from(crate::cause!(ResolveError::Conflict)));
                }
            }
            let request = ResolveRequest {
                owner: self.owner.clone(),
                generation: self.generation.clone(),
                identities: identities.to_vec(),
                group: Some(group),
            };
            let resolution = resolve(
                &request,
                &entry.canonical_identities,
                &[group_binding.clone()],
                &[],
            )?;
            if resolution.address != entry.resolution.address {
                return Err(StoreError::from(crate::cause!(ResolveError::Conflict)));
            }
            for point in &resolution.writes.point_identities {
                if repair { self.repair_point(point, &mut assert_current)?; }
                self.verify_point(point)?;
            }
            if repair { self.verify_target(&resolution.address.resource, &mut assert_current)?; }
            else { self.verify_target_read_only(&resolution.address.resource, &mut assert_current)?; }
            assert_current()?;
            return Ok(Some(DurableResolution {
                resource: resolution.address.resource.clone(),
                resolution,
            }));
        }

        let requested = identities.iter().collect::<std::collections::BTreeSet<_>>();
        let found = point_bindings
            .iter()
            .map(|binding| &binding.identity)
            .collect::<std::collections::BTreeSet<_>>();
        if requested != found {
            return Ok(None);
        }
        let route = point_bindings
            .first()
            .ok_or(crate::cause!(StoreError::Corrupt))?
            .address
            .clone();
        if point_bindings
            .iter()
            .any(|binding| binding.address != route)
        {
            return Err(StoreError::from(crate::cause!(ResolveError::Conflict)));
        }
        let resolution = resolve(&request, &point_bindings, &[], &[])?;
        for point in &resolution.writes.point_identities {
            self.verify_point(point)?;
        }
        if repair { self.verify_target(&resolution.address.resource, &mut assert_current)?; }
        else { self.verify_target_read_only(&resolution.address.resource, &mut assert_current)?; }
        assert_current()?;
        Ok(Some(DurableResolution {
            resource: resolution.address.resource.clone(),
            resolution,
        }))
    }

    fn check_request(&self, request: &ResolveRequest) -> Result<(), StoreError> {
        if request.owner != self.owner {
            return Err(StoreError::from(crate::cause!(ResolveError::OwnerMismatch)));
        }
        if request.generation != self.generation {
            return Err(crate::cause!(StoreError::GenerationChanged));
        }
        Ok(())
    }

    fn check_directory_entry(&self, entry: &DirectoryEntry, key: &str) -> Result<(), StoreError> {
        if entry.owner != self.owner || entry.resolution.address.owner != self.owner {
            return Err(StoreError::from(crate::cause!(ResolveError::OwnerMismatch)));
        }
        if entry.generation != self.generation || entry.resolution.generation != self.generation {
            return Err(crate::cause!(StoreError::GenerationChanged));
        }
        if entry.directory_key != key {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        Ok(())
    }

    fn read_install_record(
        &self,
        resource: &str,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<Option<InstallRecord>, StoreError> {
        assert_current()?;
        let id = install_row_id(resource);
        if let Some(value) = self.read_value(CATALOGUE_RESOURCE, &id)? {
            let row: InstallRecord =
                serde_json::from_value(value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
            self.check_install_record(&row, resource)?;
            return Ok(Some(row));
        }
        // A point miss never decodes or advances the legacy singleton. If it
        // still exists, its membership is unknown without decoding the whole
        // map, so fail closed instead of treating an old installed target as
        // a new one.
        if self.current_exists(CATALOGUE_RESOURCE, CATALOGUE_ID)? {
            return Err(crate::cause!(StoreError::Unavailable));
        }
        if let Some(value) = self.read_value(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID)? {
            let progress: LegacyMigration = serde_json::from_value(value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
            if progress.owner != self.owner || progress.generation != self.generation {
                return Err(crate::cause!(StoreError::GenerationChanged));
            }
            if !progress.complete {
                return Err(crate::cause!(StoreError::Corrupt));
            }
        }
        Ok(None)
    }

    fn check_read_only_catalogue<S: crate::storage::Storage>(
        &self,
        store: &crate::storage::record_store::RecordStore<S>,
    ) -> Result<(), StoreError> {
        // This point probe does not decode the former unpaged singleton.
        if store.has_live_record(&self.owner, CATALOGUE_RESOURCE, CATALOGUE_ID).map_err(map_records_error)? {
            return Err(crate::cause!(StoreError::Unavailable));
        }
        let (_, progress) = store.held_record_with_version(&self.owner, CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID)
            .map_err(map_records_error)?;
        if let Some(progress) = progress {
            let progress: LegacyMigration = serde_json::from_value(progress.value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
            if progress.owner != self.owner || progress.generation != self.generation {
                return Err(crate::cause!(StoreError::GenerationChanged));
            }
            if progress.legacy_version <= 0 { return Err(crate::cause!(StoreError::Corrupt)); }
            if !progress.complete { return Err(crate::cause!(StoreError::Unavailable)); }
        }
        Ok(())
    }

    fn read_install_record_read_only(&self, resource: &str) -> Result<Option<InstallRecord>, StoreError> {
        self.with_read_store(CATALOGUE_RESOURCE, |store| {
            self.check_read_only_catalogue(&store)?;
            let (_, record) = store.held_record_with_version(&self.owner, CATALOGUE_RESOURCE, &install_row_id(resource))
                .map_err(map_records_error)?;
            record.map(|record| {
                let row: InstallRecord = serde_json::from_value(record.value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
                self.check_install_record(&row, resource)?;
                Ok(row)
            }).transpose()
        }).map(Option::flatten)
    }

    fn check_install_record(&self, row: &InstallRecord, resource: &str) -> Result<(), StoreError> {
        if row.owner != self.owner || row.generation != self.generation {
            return Err(crate::cause!(StoreError::GenerationChanged));
        }
        if row.resource != resource {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        Ok(())
    }

    /// Advance the former `installed` singleton by at most `limit` target
    /// rows. The legacy value is still decoded as one bounded record store record
    /// (up to the existing 8 MiB record limit); this is not page-sized
    /// streaming. Exact target-row replay is accepted after a lost reply, but
    /// a different row, owner, generation, source version or incomplete
    /// progress without its pinned source refuses. The completion marker is
    /// durable before the legacy singleton is erased.
    fn migrate_legacy_catalogue(
        &self,
        limit: usize,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<usize, StoreError> {
        if limit == 0 || limit > crate::records::MAX_PAGE_ITEMS {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        assert_current()?;

        let (_, progress_value) = self.held(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID)?;
        let mut progress = progress_value
            .map(|record| serde_json::from_value::<LegacyMigration>(record.value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error)))
            .transpose()?;
        if let Some(progress) = &progress {
            if progress.owner != self.owner || progress.generation != self.generation {
                return Err(crate::cause!(StoreError::GenerationChanged));
            }
            if progress.legacy_version <= 0 {
                return Err(crate::cause!(StoreError::Corrupt));
            }
        }

        let legacy_present = self.current_exists(CATALOGUE_RESOURCE, CATALOGUE_ID)?;
        if !legacy_present {
            return match progress {
                Some(progress) if progress.complete => Ok(0),
                Some(_) => Err(crate::cause!(StoreError::Corrupt)),
                None => Ok(0),
            };
        }

        // Existence above reads only the declared `deleted` field. Materialize
        // the singleton body only when it exists, retaining record store's 8 MiB
        // record bound as the largest decode this migration can perform.
        let (legacy_version, legacy_record) = self.held(CATALOGUE_RESOURCE, CATALOGUE_ID)?;
        let legacy_record = legacy_record.ok_or(crate::cause!(StoreError::Corrupt))?;
        if legacy_record.version != legacy_version || legacy_version <= 0 {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        if let Some(progress) = &progress {
            if progress.legacy_version != legacy_version {
                return Err(crate::cause!(StoreError::Conflict));
            }
        }
        let catalogue: Catalogue =
            serde_json::from_value(legacy_record.value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
        if catalogue.owner != self.owner || catalogue.generation != self.generation {
            return Err(crate::cause!(StoreError::GenerationChanged));
        }

        if progress.as_ref().is_some_and(|progress| progress.complete) {
            assert_current()?;
            self.erase_value_at(CATALOGUE_RESOURCE, CATALOGUE_ID, legacy_version, assert_current)?;
            return Ok(0);
        }

        if progress.is_none() {
            let initial = LegacyMigration {
                owner: self.owner.clone(),
                generation: self.generation.clone(),
                legacy_version,
                after: None,
                complete: false,
            };
            self.write_value_at(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID, &initial, 0, assert_current)?;
            let (_, held) = self.held(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID)?;
            let held: LegacyMigration = serde_json::from_value(held.ok_or(crate::cause!(StoreError::Corrupt))?.value)
                .map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
            if held != initial {
                return Err(crate::cause!(StoreError::Conflict));
            }
            progress = Some(held);
        }
        let progress = progress.expect("initialized progress is present");
        if progress.after.as_ref().is_some_and(|after| !catalogue.resources.contains_key(after)) {
            return Err(crate::cause!(StoreError::Corrupt));
        }

        let start = progress.after.as_deref().map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded);
        let mut following = catalogue.resources.range::<str, _>((start, std::ops::Bound::Unbounded));
        let rows: Vec<(String, InstallState)> = following
            .by_ref()
            .take(limit)
            .map(|(resource, state)| (resource.clone(), state.clone()))
            .collect();
        let has_more = following.next().is_some();
        let mut after = progress.after.clone();
        for (resource, state) in &rows {
            if resource.is_empty() {
                return Err(crate::cause!(StoreError::Corrupt));
            }
            assert_current()?;
            let id = install_row_id(resource);
            let row = InstallRecord {
                owner: self.owner.clone(),
                generation: self.generation.clone(),
                resource: resource.clone(),
                state: state.clone(),
            };
            let (version, current) = self.held(CATALOGUE_RESOURCE, &id)?;
            if let Some(current) = current {
                let held: InstallRecord = serde_json::from_value(current.value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
                self.check_install_record(&held, resource)?;
                if held != row {
                    return Err(crate::cause!(StoreError::Conflict));
                }
            } else {
                self.write_value_at(CATALOGUE_RESOURCE, &id, &row, version, assert_current)?;
            }
            after = Some(resource.clone());
        }

        let complete = !has_more;
        let next = LegacyMigration { after, complete, ..progress.clone() };
        let (progress_version, current) = self.held(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID)?;
        let current: LegacyMigration = serde_json::from_value(current.ok_or(crate::cause!(StoreError::Corrupt))?.value)
            .map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
        if current != progress {
            return Err(crate::cause!(StoreError::Conflict));
        }
        self.write_value_at(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID, &next, progress_version, assert_current)?;
        if complete {
            // The completion marker is now durable. A crash before this
            // retirement is replayed by the complete-marker branch above.
            assert_current()?;
            self.erase_value_at(CATALOGUE_RESOURCE, CATALOGUE_ID, legacy_version, assert_current)?;
        }
        Ok(rows.len())
    }

    fn read_directory(&self, resource: &str) -> Result<Option<DirectoryEntry>, StoreError> {
        self.read_value(resource, DIRECTORY_ID)?
            .map(|value| serde_json::from_value(value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error)))
            .transpose()
    }

    fn read_points(
        &self,
        request: &ResolveRequest,
        previous: &Option<DirectoryEntry>,
    ) -> Result<Vec<IdentityBinding>, StoreError> {
        let mut wanted = BTreeMap::<String, Identity>::new();
        for identity in &request.identities {
            let key = identity_key(identity)?;
            if wanted
                .insert(key, identity.clone())
                .is_some_and(|prior| prior != *identity)
            {
                return Err(crate::cause!(StoreError::Corrupt));
            }
        }
        if let Some(entry) = previous {
            for identity in &entry.resolution.identities {
                let key = identity_key(identity)?;
                if wanted
                    .insert(key, identity.clone())
                    .is_some_and(|prior| prior != *identity)
                {
                    return Err(crate::cause!(StoreError::Corrupt));
                }
            }
        }
        let mut bindings = Vec::new();
        for (key, identity) in wanted {
            let resource = format!("@own-work-point/{key}");
            if let Some(value) = self.read_value(&resource, POINT_ID)? {
                let binding: IdentityBinding =
                    serde_json::from_value(value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
                if binding.identity != identity
                    || binding.owner != self.owner
                    || binding.generation != self.generation
                {
                    return Err(crate::cause!(StoreError::Corrupt));
                }
                bindings.push(binding);
            }
        }
        if let Some(entry) = previous {
            for row in &entry.canonical_identities {
                if !bindings
                    .iter()
                    .any(|binding| binding.identity == row.identity)
                {
                    bindings.push(row.clone());
                }
            }
        }
        Ok(bindings)
    }

    fn reserve_target(
        &self,
        resource: &str,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        let id = install_row_id(resource);
        let (version, held) = self.held(CATALOGUE_RESOURCE, &id)?;
        let current = held
            .map(|record| {
                serde_json::from_value::<InstallRecord>(record.value)
                    .map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))
            })
            .transpose()?;
        if let Some(row) = &current {
            self.check_install_record(row, resource)?;
        }
        if current
            .as_ref()
            .is_some_and(|row| row.state == InstallState::Installed)
        {
            return Ok(());
        }
        let row = InstallRecord {
            owner: self.owner.clone(),
            generation: self.generation.clone(),
            resource: resource.to_owned(),
            state: InstallState::Reserved,
        };
        assert_current()?;
        self.write_value_at(CATALOGUE_RESOURCE, &id, &row, version, assert_current)
    }

    fn install_target(
        &self,
        resource: &str,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        assert_current()?;
        // Opening through the DATA resolver creates the declared record store family
        // at the one physical file selected by the target resource name.
        let writer = self
            .resources
            .writer(resource)
            .map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        let path = writer.path().to_path_buf();
        let generation = self
            .generation
            .parse::<i64>()
            .map_err(|error| crate::carry_cause!(StoreError::GenerationChanged, error))?;
        assert_current()?;
        let lent = writer
            .lend(
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
                std::time::Instant::now() + std::time::Duration::from_secs(2),
            )
            .map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        let transaction = lent
            .begin(crate::storage::sqlite::TransactionBehavior::Immediate)
            .map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        let limits = crate::local_account::own_records::InCommand::limits(lent.connection(), &path)
            .map_err(map_records_error)?;
        let settings = self.resources.settings().map_err(map_records_error)?;
        let mut command = crate::local_account::own_records::InCommand::lend_with(
            lent.connection(),
            &self.owner,
            limits,
            settings,
        )
        .map_err(map_records_error)?;
        command
            .install_new_work_resource(generation)
            .map_err(map_records_error)?;
        assert_current()?;
        drop(command);
        transaction.commit().map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        drop(lent);
        let id = install_row_id(resource);
        let (version, held) = self.held(CATALOGUE_RESOURCE, &id)?;
        let held = held.ok_or(crate::cause!(StoreError::Corrupt))?;
        let mut row: InstallRecord =
            serde_json::from_value(held.value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
        self.check_install_record(&row, resource)?;
        row.state = InstallState::Installed;
        self.write_value_at(CATALOGUE_RESOURCE, &id, &row, version, assert_current)
    }

    fn verify_target(
        &self,
        resource: &str,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        assert_current()?;
        // Legacy own records are intentionally retained until an explicit
        // source-owned carry publishes a new route. Their current record store header
        // is checked by the selected source owner, because that resource is
        // placed in the restored RecordBook object rather than the state folder.
        if resource == "@own-records" {
            return Ok(());
        }
        if self
            .read_install_record(resource, assert_current)?
            .as_ref()
            .map(|row| &row.state)
            != Some(&InstallState::Installed)
        {
            return Err(crate::cause!(StoreError::Unavailable));
        }
        self.verify_target_header(resource)
    }

    fn verify_target_read_only(
        &self,
        resource: &str,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        assert_current()?;
        if resource == "@own-records" { return Ok(()); }
        if self.read_install_record_read_only(resource)?.as_ref().map(|row| &row.state) != Some(&InstallState::Installed) {
            return Err(crate::cause!(StoreError::Unavailable));
        }
        self.verify_target_header(resource)
    }

    fn verify_target_header(&self, resource: &str) -> Result<(), StoreError> {
        let generation = self
            .generation
            .parse::<i64>()
            .map_err(|error| crate::carry_cause!(StoreError::GenerationChanged, error))?;
        let (_, held) = self.held_in_file(resource, "own-resource-identity", "1")?;
        let value = held.ok_or(crate::cause!(StoreError::Unavailable))?.value;
        let expected = json!({"singleton": 1, "owner": self.owner, "resource": "@own-records", "generation": generation, "ready": 1});
        if value != expected {
            return Err(crate::cause!(StoreError::GenerationChanged));
        }
        Ok(())
    }

    fn write_directory(
        &self,
        resource: &str,
        previous: Option<&DirectoryEntry>,
        entry: &DirectoryEntry,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        let expected = match previous {
            Some(previous) => {
                let (version, held) = self.held(resource, DIRECTORY_ID)?;
                let held: DirectoryEntry =
                    serde_json::from_value(held.ok_or(crate::cause!(StoreError::Conflict))?.value)
                        .map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
                if &held != previous {
                    return Err(crate::cause!(StoreError::Conflict));
                }
                version
            }
            None => {
                let (version, held) = self.held(resource, DIRECTORY_ID)?;
                if held.is_some() {
                    return Err(crate::cause!(StoreError::Conflict));
                }
                version
            }
        };
        self.write_value_at(resource, DIRECTORY_ID, entry, expected, assert_current)
    }

    fn repair_point(
        &self,
        binding: &IdentityBinding,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        let key = identity_key(&binding.identity)?;
        let resource = format!("@own-work-point/{key}");
        let value = serde_json::to_value(binding).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
        let (version, current) = self.held(&resource, POINT_ID)?;
        if current.as_ref().is_some_and(|record| record.value == value) {
            return Ok(());
        }
        if let Some(record) = &current {
            let old: IdentityBinding =
                serde_json::from_value(record.value.clone()).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
            if old.owner != binding.owner
                || old.generation != binding.generation
                || old.identity != binding.identity
                || old.address != binding.address
            {
                return Err(StoreError::from(crate::cause!(ResolveError::Conflict)));
            }
        }
        assert_current()?;
        self.write_value_at(&resource, POINT_ID, binding, version, assert_current)?;
        self.verify_point(binding)
    }

    fn verify_point(&self, binding: &IdentityBinding) -> Result<(), StoreError> {
        let resource = format!("@own-work-point/{}", identity_key(&binding.identity)?);
        let value = self
            .read_value(&resource, POINT_ID)?
            .ok_or(crate::cause!(StoreError::Corrupt))?;
        let held: IdentityBinding =
            serde_json::from_value(value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
        if held != *binding {
            return Err(crate::cause!(StoreError::Corrupt));
        }
        Ok(())
    }

    fn read_value(&self, resource: &str, id: &str) -> Result<Option<Value>, StoreError> {
        Ok(self.held(resource, id)?.1.map(|record| record.value))
    }

    fn current_exists(&self, resource: &str, id: &str) -> Result<bool, StoreError> {
        self.with_store(resource, |store| store.has_live_record(&self.owner, resource, id).map_err(map_records_error))
    }

    fn held(
        &self,
        resource: &str,
        id: &str,
    ) -> Result<(i64, Option<crate::records::Record>), StoreError> {
        self.held_in_file(resource, resource, id)
    }

    fn held_in_file(
        &self,
        physical_resource: &str,
        record_resource: &str,
        id: &str,
    ) -> Result<(i64, Option<crate::records::Record>), StoreError> {
        let readers = self
            .resources
            .readers(physical_resource)
            .map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        if !readers.path().exists() {
            return Ok((0, None));
        }
        readers
            .read(|store| {
                store
                    .held_record_with_version(&self.owner, record_resource, id)
                    .map_err(map_records_error)
            })
            .map_err(Into::into)
    }

    fn with_read_store<T>(
        &self,
        resource: &str,
        operation: impl for<'c> FnOnce(crate::storage::record_store::RecordStore<Supply<&'c sqlite::Connection>>) -> Result<T, StoreError>,
    ) -> Result<Option<T>, StoreError> {
        let readers = self.resources.readers(resource).map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        if !readers.path().try_exists().map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))? { return Ok(None); }
        readers.read(operation).map(Some)
    }

    fn write_value_at<T: Serialize>(
        &self,
        resource: &str,
        id: &str,
        value: &T,
        expected_version: i64,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        assert_current()?;
        let value = serde_json::to_value(value).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
        self.with_store(resource, |store| {
            let (_, held) = store
                .held_record_with_version(&self.owner, resource, id)
                .map_err(map_records_error)?;
            if held.as_ref().is_some_and(|record| record.value == value) {
                return Ok(());
            }
            let mutation = Mutation {
                id: id.to_owned(),
                expected_version,
                request_key: mutation_key(id, expected_version, &value)?,
                deleted: false,
                value: value.clone(),
            };
            let mut check_error = None;
            store
                .mutate_local_with_check(&self.owner, resource, mutation, || {
                    if let Err(error) = assert_current() {
                        check_error = Some(error);
                        return Err(crate::cause!(crate::records::Error::Unavailable));
                    }
                    Ok(())
                })
                .map_err(|error| check_error.unwrap_or_else(|| map_records_error(error)))?;
            let (_, readback) = store
                .held_record_with_version(&self.owner, resource, id)
                .map_err(map_records_error)?;
            if readback.map(|record| record.value) != Some(value) {
                return Err(crate::cause!(StoreError::Corrupt));
            }
            Ok(())
        })
    }

    fn erase_value_at(
        &self,
        resource: &str,
        id: &str,
        expected_version: i64,
        assert_current: &mut impl FnMut() -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        assert_current()?;
        self.with_store(resource, |store| {
            let (version, held) = store
                .held_record_with_version(&self.owner, resource, id)
                .map_err(map_records_error)?;
            let Some(held) = held else {
                return Ok(());
            };
            if version != expected_version {
                return Err(crate::cause!(StoreError::Conflict));
            }
            let mutation = Mutation {
                id: id.to_owned(),
                expected_version,
                request_key: mutation_key(id, expected_version, &Value::Null)?,
                deleted: true,
                value: Value::Null,
            };
            let mut check_error = None;
            store
                .mutate_local_with_check(&self.owner, resource, mutation, || {
                    if let Err(error) = assert_current() {
                        check_error = Some(error);
                        return Err(crate::cause!(crate::records::Error::Unavailable));
                    }
                    Ok(())
                })
                .map_err(|error| check_error.unwrap_or_else(|| map_records_error(error)))?;
            let (_, readback) = store
                .held_record_with_version(&self.owner, resource, id)
                .map_err(map_records_error)?;
            if readback.is_some() || held.version != expected_version {
                return Err(crate::cause!(StoreError::Corrupt));
            }
            Ok(())
        })
    }

    fn with_store<T>(
        &self,
        resource: &str,
        operation: impl FnOnce(
            &mut crate::storage::record_store::RecordStore<Supply<&rusqlite::Connection>>,
        ) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let writer = self
            .resources
            .writer(resource)
            .map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let lent = writer
            .lend(cancel, deadline)
            .map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        let supply = sqlite::lend(lent.connection(), "record_store", Access::Write)
            .map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        let mut store =
            record_store_resources::native(supply, writer.path()).map_err(|error| crate::carry_cause!(StoreError::Unavailable, error))?;
        operation(&mut store)
    }
}

fn install_row_id(resource: &str) -> String {
    format!(
        "{INSTALL_ROW_PREFIX}{}",
        blake3::hash(resource.as_bytes()).to_hex()
    )
}

fn association_resource(identity: &Identity) -> Result<String, StoreError> {
    // Reuse the declared per-identity point file; association identity has a
    // distinct record id and therefore never enters the group's canonical row.
    Ok(format!("@own-work-point/{}", identity_key(identity)?))
}

fn directory_entry(
    owner: &str,
    generation: &str,
    directory_key: &str,
    publication: Publication,
    resolution: &Resolution,
) -> DirectoryEntry {
    DirectoryEntry {
        owner: owner.to_owned(),
        generation: generation.to_owned(),
        directory_key: directory_key.to_owned(),
        publication,
        canonical_identities: resolution
            .identities
            .iter()
            .map(|identity| IdentityBinding {
                owner: owner.to_owned(),
                generation: generation.to_owned(),
                identity: identity.clone(),
                address: resolution.address.clone(),
                group: resolution.group.clone(),
                tombstone: false,
            })
            .collect(),
        group: resolution.group.as_ref().map(|group| GroupBinding {
            owner: owner.to_owned(),
            generation: generation.to_owned(),
            group: group.clone(),
            address: resolution.address.clone(),
            tombstone: false,
        }),
        resolution: resolution.clone(),
    }
}

fn directory_key(request: &ResolveRequest) -> Result<String, StoreError> {
    if let Some(group) = request.group.as_deref() {
        return Ok(group_key(group)?);
    }
    let mut keys = request
        .identities
        .iter()
        .map(identity_key)
        .collect::<Result<Vec<_>, _>>()?;
    keys.sort();
    let encoded = serde_json::to_vec(&(request.owner.as_str(), request.generation.as_str(), keys))
        .map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
    Ok(format!("1f:{}", blake3::hash(&encoded).to_hex()))
}

fn opaque_key(owner: &str, generation: &str, directory_key: &str) -> String {
    let bytes =
        serde_json::to_vec(&(owner, generation, directory_key)).expect("string tuple serializes");
    format!("1f-{}", blake3::hash(&bytes).to_hex())
}

fn mutation_key(id: &str, version: i64, value: &Value) -> Result<String, StoreError> {
    let bytes = serde_json::to_vec(&(id, version, value)).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
    Ok(format!("affinity:{}", blake3::hash(&bytes).to_hex()))
}

fn has_existing_route(bindings: &[IdentityBinding], groups: &[GroupBinding]) -> bool {
    bindings.iter().any(|binding| !binding.tombstone) || groups.iter().any(|group| !group.tombstone)
}

fn map_records_error(error: crate::records::Error) -> StoreError {
    let cause = error.cause();
    match error {
        crate::records::Error::Conflict(_) => StoreError::Conflict(cause),
        crate::records::Error::Invalid(_, _) => StoreError::Corrupt(cause),
        _ => StoreError::Unavailable(cause),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::Mutation;

    fn request() -> ResolveRequest {
        ResolveRequest {
            owner: "account:test".into(),
            generation: "1".into(),
            identities: vec![
                Identity {
                    kind: "own-record".into(),
                    id: "record:a".into(),
                },
                Identity {
                    kind: "own-record".into(),
                    id: "record:b".into(),
                },
            ],
            group: Some("atomic:batch-1".into()),
        }
    }

    fn delete_point(state: &Path, owner: &str, identity: &Identity) {
        let resource = format!("@own-work-point/{}", identity_key(identity).unwrap());
        let (_path, mut store) =
            record_store_resources::open_state_resource(&resource, state, WorkMeter::new()).unwrap();
        let (version, held) = store
            .held_record_with_version(owner, &resource, POINT_ID)
            .unwrap();
        assert!(
            held.is_some(),
            "the point projection exists before deletion"
        );
        store
            .mutate(
                owner,
                &resource,
                Mutation {
                    id: POINT_ID.into(),
                    expected_version: version,
                    request_key: format!("test-delete-point-{version}"),
                    deleted: true,
                    value: Value::Null,
                },
            )
            .unwrap();
    }

    /// Exact durable files of a synthetic state folder. SQLite's read-lock
    /// index (`-shm`) is coordination, not record data. An absent/empty WAL is
    /// the same no-log-page state (`sqlite::LogKeeper::empty`); every nonempty
    /// WAL and main database still compare byte for byte. This keeps schema,
    /// record, migration and repair writes visible without treating a reader's
    /// lock bookkeeping as a managed mutation.
    fn affinity_source_bytes(state: &Path) -> BTreeMap<std::path::PathBuf, Vec<u8>> {
        fn walk(root: &Path, at: &Path, files: &mut BTreeMap<std::path::PathBuf, Vec<u8>>) {
            for entry in std::fs::read_dir(at).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() { walk(root, &entry.path(), files); }
                else {
                    assert!(entry.file_type().unwrap().is_file());
                    let path = entry.path();
                    let bytes = std::fs::read(&path).unwrap();
                    let name = path.file_name().unwrap().to_str().unwrap();
                    let coordination = name.strip_suffix(".sqlite-shm").is_some_and(|base| path.with_file_name(format!("{base}.sqlite")).is_file());
                    let empty_log = bytes.is_empty() && name.strip_suffix(".sqlite-wal").is_some_and(|base| path.with_file_name(format!("{base}.sqlite")).is_file());
                    if !coordination && !empty_log {
                        files.insert(path.strip_prefix(root).unwrap().to_owned(), bytes);
                    }
                }
            }
        }
        let mut files = BTreeMap::new();
        walk(state, state, &mut files);
        files
    }

    fn assert_affinity_source_bytes(state: &Path, expected: &BTreeMap<std::path::PathBuf, Vec<u8>>) {
        let actual = affinity_source_bytes(state);
        if &actual != expected {
            let digest = |bytes: Option<&Vec<u8>>| bytes.map(|bytes| (bytes.len(), blake3::hash(bytes).to_hex().to_string()));
            let paths = actual.keys().chain(expected.keys()).collect::<std::collections::BTreeSet<_>>();
            let changed = paths.into_iter().filter(|path| actual.get(*path) != expected.get(*path))
                .map(|path| (path, digest(expected.get(path)), digest(actual.get(path)))).collect::<Vec<_>>();
            panic!("affinity source bytes changed (path, before length/BLAKE3, after length/BLAKE3): {changed:?}");
        }
    }

    #[test]
    fn read_only_affinity_constructor_does_not_create_missing_catalogue_or_point_files() {
        let state = tempfile::tempdir().unwrap();
        let before = affinity_source_bytes(state.path());
        let directory = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let page = directory.installed_resources_page_read_only(None, 1, || Ok(())).unwrap();
        assert!(page.resources.is_empty());
        assert!(page.next.is_none());
        assert!(directory.resolve_points_read_only(&request().identities, || Ok(())).unwrap().is_none());
        let mut checks = 0;
        assert!(matches!(directory.resolve_points_read_only(&request().identities, || {
            checks += 1;
            if checks > 1 { Err(crate::cause!(StoreError::GenerationChanged)) } else { Ok(()) }
        }), Err(StoreError::GenerationChanged(_))));
        assert_affinity_source_bytes(state.path(), &before);
        drop(directory);
        assert_affinity_source_bytes(state.path(), &before);
    }

    #[test]
    fn read_only_affinity_page_refuses_legacy_and_pending_migration_without_changing_files() {
        for legacy in [true, false] {
            let state = tempfile::tempdir().unwrap();
            let writer = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
            if legacy {
                prefill_legacy_catalogue(&writer, [("@own-records".into(), InstallState::Installed)].into_iter().collect());
            } else {
                writer.write_value_at(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID, &LegacyMigration {
                    owner: "account:test".into(), generation: "1".into(), legacy_version: 1, after: None, complete: false,
                }, 0, &mut || Ok(())).unwrap();
            }
            drop(writer);
            let before = affinity_source_bytes(state.path());
            let reader = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
            assert_eq!(reader.installed_resources_page_read_only(None, 1, || Ok(())), Err(crate::cause!(StoreError::Unavailable)));
            drop(reader);
            assert_affinity_source_bytes(state.path(), &before);
        }
    }

    #[test]
    fn read_only_affinity_pages_and_group_points_verify_existing_state_without_repair() {
        let state = tempfile::tempdir().unwrap();
        let request = request();
        let writer = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let created = writer.install_and_resolve(&request, || Ok(())).unwrap();
        let mut second = request.clone(); second.group = Some("atomic:other-group".into());
        second.identities = vec![Identity { kind: "own-record".into(), id: "record:other".into() }];
        let other = writer.install_and_resolve(&second, || Ok(())).unwrap();
        drop(writer);
        let before = affinity_source_bytes(state.path());
        let reader = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let mut after = None;
        let mut observed = Vec::new();
        loop {
            let page = reader.installed_resources_page_read_only(after.as_deref(), 1, || Ok(())).unwrap();
            assert!(page.resources.len() <= 1);
            observed.extend(page.resources); after = page.next;
            if after.is_none() { break; }
        }
        observed.sort();
        let mut expected = vec![created.resource.clone(), other.resource]; expected.sort();
        assert_eq!(observed, expected);
        let route = reader.resolve_points_read_only(&[request.identities[0].clone()], || Ok(())).unwrap().unwrap();
        assert_eq!(route.resource, created.resource);
        assert_eq!(route.resolution.identities, request.identities);
        let changed = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "2").unwrap();
        assert_eq!(changed.installed_resources_page_read_only(None, 1, || Ok(())), Err(crate::cause!(StoreError::GenerationChanged)));
        drop(changed); drop(reader);
        assert_affinity_source_bytes(state.path(), &before);

        delete_point(state.path(), &request.owner, &request.identities[1]);
        let before_missing = affinity_source_bytes(state.path());
        let reader = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        assert!(matches!(reader.resolve_points_read_only(&[request.identities[0].clone()], || Ok(())), Err(StoreError::Corrupt(_))));
        drop(reader);
        assert_affinity_source_bytes(state.path(), &before_missing);
        let writer = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        assert_eq!(writer.resolve_points(&request.identities, || Ok(())).unwrap().unwrap().resource, created.resource,
            "the explicit maintenance path still repairs the point");
    }

    #[test]
    fn installed_group_route_survives_owner_restart_and_subset_lookup() {
        let state = tempfile::tempdir().unwrap();
        let request = request();
        let first =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let created = first.install_and_resolve(&request, || Ok(())).unwrap();
        assert!(created.resource.starts_with("@own-work/"));
        assert_eq!(created.resolution.identities.len(), 2);

        let restarted =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let resumed = restarted
            .resolve_points(&[request.identities[0].clone()], || Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(resumed.resource, created.resource);
        assert_eq!(resumed.resolution.identities, request.identities);
    }

    #[test]
    fn unrelated_fresh_groups_get_distinct_files_and_same_group_reuses_its_file() {
        let state = tempfile::tempdir().unwrap();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let first_request = request();
        let first = directory
            .install_and_resolve(&first_request, || Ok(()))
            .unwrap();

        let second_request = ResolveRequest {
            owner: "account:test".into(),
            generation: "1".into(),
            identities: vec![Identity {
                kind: "own-record".into(),
                id: "record:c".into(),
            }],
            group: Some("atomic:batch-2".into()),
        };
        let second = directory
            .install_and_resolve(&second_request, || Ok(()))
            .unwrap();
        assert_ne!(first.resource, second.resource);

        let subset_request = ResolveRequest {
            owner: first_request.owner.clone(),
            generation: first_request.generation.clone(),
            identities: vec![first_request.identities[0].clone()],
            group: first_request.group.clone(),
        };
        let subset = directory
            .install_and_resolve(&subset_request, || Ok(()))
            .unwrap();
        assert_eq!(subset.resource, first.resource);
        assert_eq!(subset.resolution.identities, first_request.identities);

        let routes = StateResources::new(state.path(), WorkMeter::new()).unwrap();
        let first_writer = routes.writer(&first.resource).unwrap();
        let first_again = routes.writer(&subset.resource).unwrap();
        let second_writer = routes.writer(&second.resource).unwrap();
        assert!(Arc::ptr_eq(&first_writer, &first_again));
        assert_ne!(first_writer.path(), second_writer.path());
        assert_eq!(directory.installed_resources(|| Ok(())).unwrap().len(), 2);
    }

    #[test]
    fn install_catalogue_uses_constant_rows_and_complete_bounded_pages() {
        let state = tempfile::tempdir().unwrap();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let mut expected = Vec::new();
        for index in 0..9 {
            let request = ResolveRequest {
                owner: "account:test".into(),
                generation: "1".into(),
                identities: vec![Identity {
                    kind: "own-record".into(),
                    id: format!("catalogue-{index}"),
                }],
                group: Some(format!("atomic:catalogue-{index}")),
            };
            expected.push(
                directory
                    .install_and_resolve(&request, || Ok(()))
                    .unwrap()
                    .resource,
            );
        }

        let mut after = None;
        let mut observed = Vec::new();
        let mut pages = 0;
        loop {
            let page = directory
                .installed_resources_page(after.as_deref(), 2, || Ok(()))
                .unwrap();
            assert!(page.resources.len() <= 2);
            observed.extend(page.resources);
            pages += 1;
            after = page.next;
            if after.is_none() {
                break;
            }
        }
        assert!(pages >= 5, "the cursor advances through bounded pages");
        observed.sort();
        expected.sort();
        assert_eq!(observed, expected);
        assert!(
            directory
                .read_value(CATALOGUE_RESOURCE, CATALOGUE_ID)
                .unwrap()
                .is_none(),
            "new installs do not write a growing singleton catalogue"
        );

        let first = directory
            .read_install_record(&expected[0], &mut || Ok(()))
            .unwrap()
            .unwrap();
        let encoded = serde_json::to_vec(&first).unwrap();
        assert!(
            encoded.len() < 512,
            "each install witness is constant-sized"
        );

        let restarted =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        assert_eq!(
            restarted
                .installed_resources_page(None, 2, || Ok(()))
                .unwrap()
                .resources
                .len(),
            2
        );
        assert!(matches!(
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "2")
                .unwrap()
                .installed_resources_page(None, 2, || Ok(())),
            Err(StoreError::GenerationChanged(_))
        ));
    }

    #[test]
    fn independent_associations_do_not_extend_group_membership_and_refuse_rebinding() {
        let state = tempfile::tempdir().unwrap();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let request = request();
        let route = directory.install_and_resolve(&request, || Ok(())).unwrap();
        let group_members = directory
            .read_directory(&format!(
                "@own-work-directory/{}",
                directory_key(&request).unwrap()
            ))
            .unwrap()
            .unwrap()
            .canonical_identities
            .len();
        let mut first = None;
        for index in 0..12 {
            let identity = Identity {
                kind: "own-command".into(),
                id: format!("permit-{index}"),
            };
            let association = directory
                .associate_identity_with_group(&identity, request.group.as_deref().unwrap(), || {
                    Ok(())
                })
                .unwrap();
            assert_eq!(association.resource, route.resource);
            assert_eq!(
                directory
                    .resolve_associated_identity(&identity, || Ok(()))
                    .unwrap(),
                Some(association.clone())
            );
            if index == 0 {
                first = Some(identity);
            }
        }
        let held_group = directory
            .read_directory(&format!(
                "@own-work-directory/{}",
                directory_key(&request).unwrap()
            ))
            .unwrap()
            .unwrap();
        assert_eq!(held_group.canonical_identities.len(), group_members);
        let second_request = ResolveRequest {
            owner: request.owner.clone(),
            generation: request.generation.clone(),
            identities: vec![Identity {
                kind: "own-record".into(),
                id: "another-record".into(),
            }],
            group: Some("atomic:another-group".into()),
        };
        directory
            .install_and_resolve(&second_request, || Ok(()))
            .unwrap();
        assert!(matches!(
            directory.associate_identity_with_group(
                first.as_ref().unwrap(),
                second_request.group.as_deref().unwrap(),
                || Ok(())
            ),
            Err(StoreError::Resolve(ResolveError::Conflict(_), _))
        ));
        let restarted =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        assert_eq!(
            restarted
                .resolve_associated_identity(first.as_ref().unwrap(), || Ok(()))
                .unwrap()
                .unwrap()
                .resource,
            route.resource
        );
        assert!(matches!(
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "2")
                .unwrap()
                .resolve_associated_identity(first.as_ref().unwrap(), || Ok(())),
            Err(StoreError::GenerationChanged(_))
        ));
    }

    #[test]
    fn legacy_catalogue_migrates_once_and_missing_installed_file_refuses_listing() {
        let state = tempfile::tempdir().unwrap();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let request = request();
        let route = directory.install_and_resolve(&request, || Ok(())).unwrap();
        let id = install_row_id(&route.resource);
        let (version, held) = directory.held(CATALOGUE_RESOURCE, &id).unwrap();
        let held = held.unwrap();
        directory
            .erase_value_at(CATALOGUE_RESOURCE, &id, version, &mut || Ok(()))
            .unwrap();
        let legacy = Catalogue {
            owner: "account:test".into(),
            generation: "1".into(),
            resources: [(route.resource.clone(), InstallState::Installed)]
                .into_iter()
                .collect(),
        };
        directory
            .write_value_at(CATALOGUE_RESOURCE, CATALOGUE_ID, &legacy, 0, &mut || Ok(()))
            .unwrap();
        assert!(held.version > 0);

        assert!(
            matches!(directory.installed_resources_page(None, 2, || Ok(())), Err(StoreError::Unavailable(_))),
            "the migration chunk consumes the full target-work allowance"
        );
        assert_eq!(
            directory
                .installed_resources_page(None, 2, || Ok(()))
                .unwrap()
                .resources,
            vec![route.resource.clone()]
        );
        assert!(directory
            .read_value(CATALOGUE_RESOURCE, CATALOGUE_ID)
            .unwrap()
            .is_none());
        assert!(directory
            .read_value(CATALOGUE_RESOURCE, &id)
            .unwrap()
            .is_some());

        let writer = directory.resources.writer(&route.resource).unwrap();
        let path = writer.path().to_path_buf();
        drop(writer);
        drop(directory);
        std::fs::remove_file(path).unwrap();
        let restarted =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        assert!(matches!(
            restarted.installed_resources_page(None, 2, || Ok(())),
            Err(StoreError::Unavailable(_))
        ));
    }

    fn prefill_legacy_catalogue(
        directory: &AffinityDirectory,
        resources: BTreeMap<String, InstallState>,
    ) -> i64 {
        let catalogue = Catalogue {
            owner: directory.owner.clone(),
            generation: directory.generation.clone(),
            resources,
        };
        directory
            .write_value_at(CATALOGUE_RESOURCE, CATALOGUE_ID, &catalogue, 0, &mut || Ok(()))
            .unwrap();
        directory.held(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().1.unwrap().version
    }

    fn legacy_install_count(directory: &AffinityDirectory) -> usize {
        directory
            .with_store(CATALOGUE_RESOURCE, |store| {
                let (ids, _) = store
                    .ids(&directory.owner, CATALOGUE_RESOURCE, None, crate::records::MAX_PAGE_ITEMS)
                    .map_err(map_records_error)?;
                Ok(ids.iter().filter(|id| id.starts_with(INSTALL_ROW_PREFIX)).count())
            })
            .unwrap()
    }

    #[test]
    fn legacy_catalogue_migration_advances_at_most_limit_rows_across_restarts_and_cleans_up() {
        let state = tempfile::tempdir().unwrap();
        let mut directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let resources = (0..5)
            .map(|index| (format!("legacy-resource-{index}"), InstallState::Reserved))
            .chain([("@own-records".into(), InstallState::Installed)])
            .collect::<BTreeMap<_, _>>();
        prefill_legacy_catalogue(&directory, resources);

        for expected in [2, 4, 6] {
            assert!(
                matches!(directory.installed_resources_page(None, 2, || Ok(())), Err(StoreError::Unavailable(_))),
                "a nonempty migration page never leaks an empty or partial inventory"
            );
            assert_eq!(legacy_install_count(&directory), expected);
            directory =
                AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        }

        let progress: LegacyMigration = serde_json::from_value(
            directory.read_value(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID).unwrap().unwrap(),
        )
        .unwrap();
        assert!(progress.complete);
        assert!(directory.read_value(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().is_none());

        let mut after = None;
        let mut installed = Vec::new();
        loop {
            let page = directory.installed_resources_page(after.as_deref(), 2, || Ok(())).unwrap();
            assert!(page.resources.len() <= 2);
            installed.extend(page.resources);
            after = page.next;
            if after.is_none() {
                break;
            }
        }
        assert_eq!(installed, vec!["@own-records"]);
    }

    #[test]
    fn migration_replays_an_exact_row_and_refuses_a_colliding_row() {
        for collision in [false, true] {
            let state = tempfile::tempdir().unwrap();
            let directory =
                AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
            let resource = "@own-records".to_owned();
            let state_in_source = InstallState::Reserved;
            let legacy_version = prefill_legacy_catalogue(
                &directory,
                [(resource.clone(), state_in_source.clone())].into_iter().collect(),
            );
            let progress = LegacyMigration {
                owner: "account:test".into(),
                generation: "1".into(),
                legacy_version,
                after: None,
                complete: false,
            };
            directory.write_value_at(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID, &progress, 0, &mut || Ok(())).unwrap();
            let existing = InstallRecord {
                owner: "account:test".into(),
                generation: "1".into(),
                resource: resource.clone(),
                state: if collision { InstallState::Installed } else { state_in_source },
            };
            directory
                .write_value_at(CATALOGUE_RESOURCE, &install_row_id(&resource), &existing, 0, &mut || Ok(()))
                .unwrap();

            let result = directory.migrate_legacy_catalogue(1, &mut || Ok(()));
            if collision {
                assert!(matches!(result, Err(StoreError::Conflict(_))));
                let held: LegacyMigration = serde_json::from_value(
                    directory.read_value(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID).unwrap().unwrap(),
                )
                .unwrap();
                assert_eq!(held.after, None);
                assert!(directory.read_value(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().is_some());
            } else {
                assert_eq!(result.unwrap(), 1, "an exact replay is accepted and advances progress");
                assert!(directory.read_value(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().is_none());
            }
        }
    }

    #[test]
    fn legacy_point_miss_does_not_decode_or_advance_the_singleton() {
        let state = tempfile::tempdir().unwrap();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        prefill_legacy_catalogue(
            &directory,
            [("@own-records".into(), InstallState::Installed)].into_iter().collect(),
        );
        let (version, _) = directory.held(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap();

        assert!(
            matches!(directory.read_install_record("@own-work/not-installed", &mut || Ok(())), Err(StoreError::Unavailable(_))),
            "membership is unknown until the explicit bounded migration finishes"
        );
        assert!(directory.read_value(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID).unwrap().is_none());
        assert_eq!(directory.held(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().0, version);

        // A point miss does not inspect malformed legacy bytes or turn them
        // into a migration error; the explicit inventory path remains the
        // only owner of singleton decoding.
        let malformed = json!({"not": "a legacy catalogue"});
        let (source_version, _) = directory.held(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap();
        directory.write_value_at(CATALOGUE_RESOURCE, CATALOGUE_ID, &malformed, source_version, &mut || Ok(())).unwrap();
        assert!(
            matches!(directory.read_install_record("@own-work/still-not-installed", &mut || Ok(())), Err(StoreError::Unavailable(_))),
            "a metadata existence probe refuses without decoding malformed legacy bytes"
        );
    }

    #[test]
    fn migration_replays_after_rights_fail_before_cursor_and_generation_change_refuses_resume() {
        let state = tempfile::tempdir().unwrap();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        prefill_legacy_catalogue(
            &directory,
            [("@own-records".into(), InstallState::Reserved)].into_iter().collect(),
        );
        let interrupted = directory.migrate_legacy_catalogue(1, &mut || {
            // Refuse on the durable boundary, independent of check-call
            // counts: the destination committed, its cursor has not.
            if directory.read_value(CATALOGUE_RESOURCE, &install_row_id("@own-records"))?.is_some() {
                let progress: LegacyMigration = serde_json::from_value(
                    directory.read_value(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID)?.ok_or(crate::cause!(StoreError::Corrupt))?,
                ).map_err(|error| crate::carry_cause!(StoreError::Corrupt, error))?;
                if progress.after.is_none() {
                    return Err(crate::cause!(StoreError::GenerationChanged));
                }
            }
            Ok(())
        });
        assert!(matches!(interrupted, Err(StoreError::GenerationChanged(_))));
        assert_eq!(legacy_install_count(&directory), 1, "the row write survived before its progress cursor");
        let progress: LegacyMigration = serde_json::from_value(
            directory.read_value(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID).unwrap().unwrap(),
        )
        .unwrap();
        assert_eq!(progress.after, None, "the cursor did not pass a row whose reply was lost");

        let changed =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "2").unwrap();
        assert!(matches!(
            changed.migrate_legacy_catalogue(1, &mut || Ok(())),
            Err(StoreError::GenerationChanged(_))
        ));
        let changed_owner =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:other", "1").unwrap();
        assert_eq!(
            changed_owner.migrate_legacy_catalogue(1, &mut || Ok(())).unwrap(),
            0,
            "another owner sees only its own catalogue namespace"
        );
        assert!(changed.read_value(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().is_some());

        let restarted =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        assert_eq!(restarted.migrate_legacy_catalogue(1, &mut || Ok(())).unwrap(), 1);
        assert!(restarted.read_value(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().is_none());
    }

    #[test]
    fn pending_migration_without_its_legacy_source_refuses_but_completed_cleanup_replays() {
        let state = tempfile::tempdir().unwrap();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let source_version = prefill_legacy_catalogue(
            &directory,
            [
                ("legacy-a".into(), InstallState::Reserved),
                ("legacy-b".into(), InstallState::Reserved),
            ]
            .into_iter()
            .collect(),
        );
        assert!(matches!(
            directory.installed_resources_page(None, 1, || Ok(())),
            Err(StoreError::Unavailable(_))
        ));
        directory
            .erase_value_at(CATALOGUE_RESOURCE, CATALOGUE_ID, source_version, &mut || Ok(()))
            .unwrap();
        assert!(matches!(
            directory.installed_resources_page(None, 1, || Ok(())),
            Err(StoreError::Corrupt(_))
        ));

        // A complete marker is the only state allowed to observe the retired
        // source as absent; it is safe to resume cleanup and then list.
        let cleanup = tempfile::tempdir().unwrap();
        let finished =
            AffinityDirectory::new(cleanup.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let completed_source_version = prefill_legacy_catalogue(
            &finished,
            [("legacy-a".into(), InstallState::Reserved)].into_iter().collect(),
        );
        let complete = LegacyMigration {
            owner: "account:test".into(),
            generation: "1".into(),
            legacy_version: completed_source_version,
            after: Some("legacy-a".into()),
            complete: true,
        };
        finished
            .write_value_at(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID, &complete, 0, &mut || Ok(()))
            .unwrap();
        assert_eq!(finished.migrate_legacy_catalogue(1, &mut || Ok(())).unwrap(), 0);
        assert!(finished.read_value(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().is_none());
        assert!(finished.installed_resources_page(None, 1, || Ok(())).unwrap().resources.is_empty());
    }

    #[test]
    fn current_rights_are_rechecked_before_legacy_source_retirement() {
        let state = tempfile::tempdir().unwrap();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let source_version = prefill_legacy_catalogue(
            &directory,
            [("legacy-a".into(), InstallState::Reserved)].into_iter().collect(),
        );
        let complete = LegacyMigration {
            owner: "account:test".into(),
            generation: "1".into(),
            legacy_version: source_version,
            after: Some("legacy-a".into()),
            complete: true,
        };
        directory
            .write_value_at(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID, &complete, 0, &mut || Ok(()))
            .unwrap();

        let mut checks = 0;
        let result = directory.migrate_legacy_catalogue(1, &mut || {
            checks += 1;
            if checks == 2 { Err(crate::cause!(StoreError::GenerationChanged)) } else { Ok(()) }
        });
        assert!(matches!(result, Err(StoreError::GenerationChanged(_))));
        assert!(directory.read_value(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().is_some());
        assert_eq!(directory.migrate_legacy_catalogue(1, &mut || Ok(())).unwrap(), 0);
        assert!(directory.read_value(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().is_none());
    }

    #[test]
    fn legacy_migration_refuses_a_replaced_source_before_advancing_its_cursor() {
        let state = tempfile::tempdir().unwrap();
        let directory = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        prefill_legacy_catalogue(&directory, [
            ("legacy-a".into(), InstallState::Reserved),
            ("legacy-b".into(), InstallState::Reserved),
        ].into_iter().collect());
        assert!(matches!(directory.installed_resources_page(None, 1, || Ok(())), Err(StoreError::Unavailable(_))));
        let progress = directory.read_value(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID).unwrap().unwrap();
        let (version, source) = directory.held(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap();
        let mut source: Catalogue = serde_json::from_value(source.unwrap().value).unwrap();
        source.resources.insert("legacy-c".into(), InstallState::Reserved);
        directory.write_value_at(CATALOGUE_RESOURCE, CATALOGUE_ID, &source, version, &mut || Ok(())).unwrap();
        assert!(matches!(directory.installed_resources_page(None, 1, || Ok(())), Err(StoreError::Conflict(_))));
        assert_eq!(directory.read_value(CATALOGUE_RESOURCE, LEGACY_MIGRATION_ID).unwrap(), Some(progress));
        assert!(directory.read_value(CATALOGUE_RESOURCE, &install_row_id("legacy-b")).unwrap().is_none());
        assert!(directory.read_value(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().is_some());
    }

    #[test]
    fn route_reservation_survives_restart_without_receipt_or_group_and_refuses_rebinding() {
        let state = tempfile::tempdir().unwrap();
        let directory = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let identity = Identity { kind: "own-command".into(), id: "before-any-receipt".into() };
        let legacy = ResourceAddress { owner: "account:test".into(), resource: "@own-records".into() };
        assert!(directory.resolve_reserved_identity_route(&identity, |_| Ok(())).unwrap().is_none());
        assert_eq!(directory.reserve_identity_route(&identity, &legacy, |address| {
            assert_eq!(address, &legacy);
            Ok(())
        }).unwrap(), legacy);
        assert!(directory.read_value(CATALOGUE_RESOURCE, CATALOGUE_ID).unwrap().is_none());
        assert!(directory.read_value(&association_resource(&identity).unwrap(), ASSOCIATION_ID).unwrap().is_none());
        drop(directory);

        let reopened = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        assert_eq!(reopened.resolve_reserved_identity_route(&identity, |address| {
            assert_eq!(address, &legacy);
            Ok(())
        }).unwrap(), Some(legacy.clone()));
        assert_eq!(reopened.reserve_identity_route(&identity, &legacy, |_| Ok(())).unwrap(), legacy);
        let other = ResourceAddress { owner: "account:test".into(), resource: "@own-work/different".into() };
        assert!(matches!(reopened.reserve_identity_route(&identity, &other, |_| Ok(())), Err(StoreError::Conflict(_))));
        assert_eq!(reopened.resolve_reserved_identity_route(&identity, |_| Ok(())).unwrap(), Some(legacy));
    }

    #[test]
    fn route_reservation_rechecks_rights_at_commit_and_recovery_and_rejects_generation_changes() {
        let state = tempfile::tempdir().unwrap();
        let directory = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let identity = Identity { kind: "own-command".into(), id: "rights-fence".into() };
        let address = ResourceAddress { owner: "account:test".into(), resource: "@own-records".into() };
        let mut checks = 0;
        let refused = directory.reserve_identity_route(&identity, &address, |_| {
            checks += 1;
            if checks >= 3 { Err(crate::cause!(StoreError::GenerationChanged)) } else { Ok(()) }
        });
        assert!(matches!(refused, Err(StoreError::GenerationChanged(_))));
        assert!(directory.resolve_reserved_identity_route(&identity, |_| Ok(())).unwrap().is_none());
        directory.reserve_identity_route(&identity, &address, |_| Ok(())).unwrap();
        assert!(matches!(directory.resolve_reserved_identity_route(&identity, |_| Err(crate::cause!(StoreError::GenerationChanged))), Err(StoreError::GenerationChanged(_))));
        assert!(matches!(directory.reserve_identity_route(&identity, &address, |_| Err(crate::cause!(StoreError::GenerationChanged))), Err(StoreError::GenerationChanged(_))));
        let changed = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "2").unwrap();
        assert!(matches!(changed.resolve_reserved_identity_route(&identity, |_| Ok(())), Err(StoreError::GenerationChanged(_))));
        let foreign = ResourceAddress { owner: "account:foreign".into(), resource: "@own-records".into() };
        assert!(matches!(directory.reserve_identity_route(&identity, &foreign, |_| Ok(())), Err(StoreError::Resolve(ResolveError::OwnerMismatch(_), _))));
    }

    #[test]
    fn route_reservation_refuses_deleted_identity_and_a_changed_readback() {
        let state = tempfile::tempdir().unwrap();
        let directory = AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let identity = Identity { kind: "own-command".into(), id: "immutable-readback".into() };
        let address = ResourceAddress { owner: "account:test".into(), resource: "@own-records".into() };
        directory.reserve_identity_route(&identity, &address, |_| Ok(())).unwrap();
        let resource = association_resource(&identity).unwrap();
        let mut replaced = false;
        let result = directory.resolve_reserved_identity_route(&identity, |_| {
            if !replaced {
                replaced = true;
                let (version, record) = directory.held(&resource, ROUTE_RESERVATION_ID)?;
                let mut forged: IdentityRouteReservation = serde_json::from_value(record.unwrap().value).unwrap();
                forged.address.resource = "@own-work/changed-during-target-check".into();
                directory.write_value_at(&resource, ROUTE_RESERVATION_ID, &forged, version, &mut || Ok(()))?;
            }
            Ok(())
        });
        assert!(matches!(result, Err(StoreError::Conflict(_))));
        let (version, _) = directory.held(&resource, ROUTE_RESERVATION_ID).unwrap();
        directory.erase_value_at(&resource, ROUTE_RESERVATION_ID, version, &mut || Ok(())).unwrap();
        assert!(matches!(directory.resolve_reserved_identity_route(&identity, |_| Ok(())), Err(StoreError::Conflict(_))));
        assert!(matches!(directory.reserve_identity_route(&identity, &address, |_| Ok(())), Err(StoreError::Conflict(_))));
    }

    #[test]
    fn association_write_stops_when_current_rights_change_before_commit() {
        let state = tempfile::tempdir().unwrap();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let request = request();
        directory.install_and_resolve(&request, || Ok(())).unwrap();
        let identity = Identity {
            kind: "own-command".into(),
            id: "permit-current-rights".into(),
        };
        let mut checks = 0;
        let result = directory.associate_identity_with_group(
            &identity,
            request.group.as_deref().unwrap(),
            || {
                checks += 1;
                if checks >= 2 {
                    Err(crate::cause!(StoreError::GenerationChanged))
                } else {
                    Ok(())
                }
            },
        );
        assert!(matches!(result, Err(StoreError::GenerationChanged(_))));
        assert!(directory
            .resolve_associated_identity(&identity, || Ok(()))
            .unwrap()
            .is_none());
    }

    #[test]
    fn point_lookup_repairs_a_missing_projection_from_the_complete_group_directory() {
        let state = tempfile::tempdir().unwrap();
        let request = request();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let created = directory.install_and_resolve(&request, || Ok(())).unwrap();
        delete_point(state.path(), &request.owner, &request.identities[1]);

        let restarted =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let repaired = restarted
            .resolve_points(&request.identities, || Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(repaired.resource, created.resource);
        assert_eq!(repaired.resolution.identities, request.identities);
        let expected = repaired
            .resolution
            .writes
            .point_identities
            .iter()
            .find(|binding| binding.identity == request.identities[1])
            .unwrap();
        restarted.verify_point(expected).unwrap();
    }

    #[test]
    fn interrupted_pending_publication_repairs_points_before_completion() {
        let state = tempfile::tempdir().unwrap();
        let request = request();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let created = directory.install_and_resolve(&request, || Ok(())).unwrap();
        let key = directory_key(&request).unwrap();
        let directory_resource = format!("@own-work-directory/{key}");
        let complete = directory
            .read_directory(&directory_resource)
            .unwrap()
            .unwrap();
        let pending = DirectoryEntry {
            publication: Publication::Pending,
            ..complete.clone()
        };
        directory
            .write_directory(&directory_resource, Some(&complete), &pending, &mut || {
                Ok(())
            })
            .unwrap();
        delete_point(state.path(), &request.owner, &request.identities[1]);

        let restarted =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        assert!(
            restarted
                .resolve_points(&request.identities, || Ok(()))
                .unwrap()
                .is_none(),
            "a pending canonical route is not disclosed"
        );
        let resumed = restarted.install_and_resolve(&request, || Ok(())).unwrap();
        assert_eq!(resumed.resource, created.resource);
        assert!(restarted
            .resolve_existing(&request, || Ok(()))
            .unwrap()
            .is_some());
    }

    #[test]
    fn point_repair_refuses_when_current_rights_change_before_write() {
        let state = tempfile::tempdir().unwrap();
        let request = request();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        directory.install_and_resolve(&request, || Ok(())).unwrap();
        delete_point(state.path(), &request.owner, &request.identities[1]);

        let restarted =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let mut checks = 0;
        let result = restarted.resolve_points(&request.identities, || {
            checks += 1;
            if checks >= 3 {
                Err(crate::cause!(StoreError::GenerationChanged))
            } else {
                Ok(())
            }
        });
        assert!(matches!(result, Err(StoreError::GenerationChanged(_))));
        let point_resource = format!(
            "@own-work-point/{}",
            identity_key(&request.identities[1]).unwrap()
        );
        let (version, held) = restarted.held(&point_resource, POINT_ID).unwrap();
        assert!(version > 0, "the deletion tombstone remains held");
        assert!(
            held.is_none(),
            "the stale callback did not recreate the projection"
        );
    }

    #[test]
    fn retries_a_reserved_target_after_restart_without_reselecting() {
        let state = tempfile::tempdir().unwrap();
        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let request = request();
        let key = directory_key(&request).unwrap();
        let directory_resource = format!("@own-work-directory/{key}");
        let reserved_resource = "@own-work/reserved-after-crash";
        let resolution = resolve(
            &request,
            &[],
            &[],
            &[GrowthTarget {
                address: ResourceAddress {
                    owner: "account:test".into(),
                    resource: reserved_resource.into(),
                },
                installed: true,
                refuses_growth: false,
            }],
        )
        .unwrap();
        let reservation = directory_entry(
            "account:test",
            "1",
            &key,
            Publication::Reserved,
            &resolution,
        );
        directory
            .write_directory(&directory_resource, None, &reservation, &mut || Ok(()))
            .unwrap();
        directory
            .reserve_target(reserved_resource, &mut || Ok(()))
            .unwrap();
        assert!(
            directory.installed_resources(|| Ok(())).unwrap().is_empty(),
            "reserved targets are not exposed as readable routes"
        );

        let restarted =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let resumed = restarted.install_and_resolve(&request, || Ok(())).unwrap();
        assert_eq!(resumed.resource, reserved_resource);
        assert_eq!(
            restarted.installed_resources(|| Ok(())).unwrap(),
            vec![reserved_resource.to_owned()]
        );
        assert!(restarted
            .resolve_points(&request.identities, || Ok(()))
            .unwrap()
            .is_some());
    }

    #[test]
    fn refuses_to_install_into_a_nonempty_unidentified_target() {
        let state = tempfile::tempdir().unwrap();
        let resource = "@own-work/preexisting";
        let (_path, mut store) =
            record_store_resources::open_state_resource(resource, state.path(), WorkMeter::new()).unwrap();
        store
            .mutate(
                "account:test",
                "own-records",
                Mutation {
                    id: "already-held".into(),
                    expected_version: 0,
                    request_key: "prefill-existing-target".into(),
                    deleted: false,
                    value: json!({"kind":"own-record","id":"already-held"}),
                },
            )
            .unwrap();
        drop(store);

        let directory =
            AffinityDirectory::new(state.path(), WorkMeter::new(), "account:test", "1").unwrap();
        let refused = directory.install_target(resource, &mut || Ok(()));
        assert!(refused.is_err());
    }
}
