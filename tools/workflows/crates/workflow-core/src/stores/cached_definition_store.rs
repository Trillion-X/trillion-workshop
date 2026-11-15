// crates/workflow-core/src/stores/cached_definition_store.rs
//
// Purpose:
//   Workflow-owned in-memory definition cache hydrated from package-record live
//   state. Source owners hand workflow already-assembled Definition records.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::RwLock;

use crate::domain::errors::WorkflowResult;
use crate::domain::types::{Definition, EntityId};
use crate::domain::DefinitionStore;

#[derive(Default)]
struct DefinitionCacheState {
    by_id: HashMap<String, Arc<Definition>>,
    owner_by_address: HashMap<String, DefinitionOwner>,
    next_sequence: u64,
}

struct DefinitionOwner {
    id: String,
    definition: Arc<Definition>,
    payload_hash: Option<String>,
    source_rank: DefinitionSourceRank,
    sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefinitionHydration {
    pub id: String,
    pub payload_hash: Option<String>,
}

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
struct DefinitionSourceRank(u8);

fn definition_source_rank(address: &str) -> DefinitionSourceRank {
    if address.starts_with("attribute_fact|") && address.contains("|prop:action:workflow_steps|") {
        DefinitionSourceRank(0)
    } else {
        DefinitionSourceRank(1)
    }
}

pub struct CachedDefinitionStore {
    state: RwLock<DefinitionCacheState>,
}

impl CachedDefinitionStore {
    pub fn new() -> Self {
        Self {
            state: RwLock::new(DefinitionCacheState::default()),
        }
    }

    pub fn replace_definitions(&self, definitions: Vec<Definition>) {
        let mut next_state = DefinitionCacheState {
            by_id: HashMap::with_capacity(definitions.len()),
            owner_by_address: HashMap::with_capacity(definitions.len()),
            next_sequence: 0,
        };
        for definition in definitions {
            insert_definition_owner(&mut next_state, definition.id.clone(), definition, None);
        }
        if let Ok(mut state) = self.state.write() {
            *state = next_state;
        }
    }

    pub fn insert_definition(&self, definition: Definition) {
        self.insert_definition_for_address(definition.id.clone(), definition);
    }

    pub fn insert_definition_for_address(&self, address: String, definition: Definition) {
        self.insert_definition_for_address_with_payload_hash(address, definition, None);
    }

    pub fn insert_definition_for_address_with_payload_hash(
        &self,
        address: String,
        definition: Definition,
        payload_hash: Option<String>,
    ) {
        if let Ok(mut state) = self.state.write() {
            insert_definition_owner(&mut state, address, definition, payload_hash);
        }
    }

    /// Reconcile ALL cached owners of one definition id against the fold's
    /// CURRENT owner set (as returned by a live current-items query).
    ///
    /// This is the freshness mechanism the cache itself cannot provide: local
    /// `sequence` is insertion order and `source_rank` is priority policy —
    /// neither knows what the fold currently holds. A stale owner (its record
    /// retracted before this process booted, or on a plane the delta feed did
    /// not cover) survives forever without this and can shadow a repaired
    /// definition (the proven poisoned-registration mechanism).
    ///
    /// Semantics:
    /// - every cached owner of `id` whose address is ABSENT from
    ///   `current_owners` is removed;
    /// - each current owner is inserted/updated ONLY when its payload hash
    ///   differs from the cached one (no churn on unchanged content);
    /// - active selection is refreshed once at the end.
    ///
    /// Owners of OTHER ids are untouched, so an address whose current record
    /// now carries a different id is handled by that id's own reconcile.
    pub fn reconcile_id(
        &self,
        id: &str,
        current_owners: Vec<(String, Option<String>, Definition)>,
    ) {
        let Ok(mut state) = self.state.write() else {
            return;
        };
        let current_addresses: std::collections::HashSet<&str> = current_owners
            .iter()
            .map(|(address, _, _)| address.as_str())
            .collect();
        let stale: Vec<String> = state
            .owner_by_address
            .iter()
            .filter(|(address, owner)| {
                owner.id == id && !current_addresses.contains(address.as_str())
            })
            .map(|(address, _)| address.clone())
            .collect();
        for address in stale {
            state.owner_by_address.remove(&address);
        }
        for (address, payload_hash, definition) in current_owners {
            let unchanged = state
                .owner_by_address
                .get(&address)
                .is_some_and(|owner| owner.payload_hash == payload_hash && owner.id == id);
            if unchanged {
                continue;
            }
            insert_definition_owner(&mut state, address, definition, payload_hash);
        }
        refresh_active_definition(&mut state, id);
    }

    pub fn remove_definition_address(&self, address: &str) -> bool {
        if let Ok(mut state) = self.state.write() {
            let Some(owner) = state.owner_by_address.remove(address) else {
                return false;
            };
            refresh_active_definition(&mut state, &owner.id);
            true
        } else {
            false
        }
    }

    pub fn clear(&self) {
        if let Ok(mut state) = self.state.write() {
            state.by_id.clear();
            state.owner_by_address.clear();
            state.next_sequence = 0;
        }
    }

    pub fn hydration_for_address(&self, address: &str) -> Option<DefinitionHydration> {
        self.state.read().ok().and_then(|state| {
            state
                .owner_by_address
                .get(address)
                .map(|owner| DefinitionHydration {
                    id: owner.id.clone(),
                    payload_hash: owner.payload_hash.clone(),
                })
        })
    }

    fn snapshot(&self) -> Vec<Definition> {
        self.state
            .read()
            .map(|state| {
                state
                    .by_id
                    .values()
                    .map(|definition| definition.as_ref().clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn insert_definition_owner(
    state: &mut DefinitionCacheState,
    address: String,
    definition: Definition,
    payload_hash: Option<String>,
) {
    let previous_id = state
        .owner_by_address
        .get(&address)
        .map(|owner| owner.id.clone());
    let definition_id = definition.id.clone();
    let owner = DefinitionOwner {
        id: definition_id.clone(),
        definition: Arc::new(definition),
        payload_hash,
        source_rank: definition_source_rank(&address),
        sequence: state.next_sequence,
    };
    state.next_sequence += 1;
    state.owner_by_address.insert(address, owner);

    refresh_active_definition(state, &definition_id);
    if let Some(previous_id) = previous_id {
        if previous_id != definition_id {
            refresh_active_definition(state, &previous_id);
        }
    }
}

fn refresh_active_definition(state: &mut DefinitionCacheState, id: &str) {
    let best = state
        .owner_by_address
        .values()
        .filter(|owner| owner.id == id)
        .max_by(|left, right| {
            left.source_rank
                .cmp(&right.source_rank)
                .then_with(|| left.sequence.cmp(&right.sequence))
        })
        .map(|owner| Arc::clone(&owner.definition));
    if let Some(definition) = best {
        state.by_id.insert(id.to_string(), definition);
    } else {
        state.by_id.remove(id);
    }
}

impl Default for CachedDefinitionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl DefinitionStore for CachedDefinitionStore {
    fn get_by_id(&self, id: &str, _partition_key: &str) -> WorkflowResult<Option<Definition>> {
        Ok(self
            .get_by_id_shared(id, _partition_key)?
            .map(|definition| definition.as_ref().clone()))
    }

    fn get_by_id_shared(
        &self,
        id: &str,
        _partition_key: &str,
    ) -> WorkflowResult<Option<Arc<Definition>>> {
        Ok(self
            .state
            .read()
            .ok()
            .and_then(|state| state.by_id.get(id).cloned()))
    }

    fn get_by_slug(&self, slug: &str, _partition_key: &str) -> WorkflowResult<Option<Definition>> {
        Ok(self.snapshot().into_iter().find(|definition| {
            definition.name == slug
                || definition
                    .extra_properties
                    .get("slug")
                    .map(|value| value == slug)
                    .unwrap_or(false)
        }))
    }

    fn get_active(
        &self,
        _partition_key: &str,
        kind: Option<&str>,
    ) -> WorkflowResult<Vec<Definition>> {
        Ok(self
            .snapshot()
            .into_iter()
            .filter(|definition| definition.is_active)
            .filter(|definition| kind.map(|kind| definition.kind == kind).unwrap_or(true))
            .collect())
    }

    fn get_by_trigger(
        &self,
        trigger_source: &str,
        _partition_key: &str,
    ) -> WorkflowResult<Vec<Definition>> {
        Ok(self
            .snapshot()
            .into_iter()
            .filter(|definition| {
                definition.is_active && definition.trigger_source == trigger_source
            })
            .collect())
    }

    fn get_participant_ids(
        &self,
        _interaction_id: &str,
        _partition_key: &str,
    ) -> WorkflowResult<Vec<EntityId>> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::TriggerType;

    fn definition(id: &str, kind: &str, name: &str) -> Definition {
        Definition {
            id: id.to_string(),
            partition_key: "partition:test".to_string(),
            kind: kind.to_string(),
            name: name.to_string(),
            description: String::new(),
            input_schema: serde_json::json!({}),
            steps: Vec::new(),
            edges: Vec::new(),
            trigger_type: TriggerType::Manual,
            trigger_source: String::new(),
            is_active: true,
            version: 0,
            extra: serde_json::Value::Null,
            extra_properties: HashMap::new(),
        }
    }

    #[test]
    fn replace_definitions_replaces_lookup_state() {
        let store = CachedDefinitionStore::new();
        store.replace_definitions(vec![definition("action:test", "action", "test-action")]);

        let loaded = store
            .get_by_id("action:test", "partition:test")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.name, "test-action");

        store.replace_definitions(vec![definition(
            "workflow:test",
            "workflow",
            "test-workflow",
        )]);

        assert!(store
            .get_by_id("action:test", "partition:test")
            .unwrap()
            .is_none());
        assert!(store
            .get_by_id("workflow:test", "partition:test")
            .unwrap()
            .is_some());
    }

    #[test]
    fn get_active_and_by_trigger_filter_cached_definitions() {
        let store = CachedDefinitionStore::new();
        let mut evented = definition("workflow:event", "workflow", "evented");
        evented.trigger_source = "PaymentReceived".to_string();
        evented.trigger_type = TriggerType::Event;
        let mut inactive = definition("action:inactive", "action", "inactive");
        inactive.is_active = false;

        store.replace_definitions(vec![evented.clone(), inactive]);

        assert_eq!(
            store
                .get_active("partition:test", Some("workflow"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .get_by_trigger("PaymentReceived", "partition:test")
                .unwrap(),
            vec![evented]
        );
    }

    #[test]
    fn address_retraction_removes_only_the_matching_definition() {
        let store = CachedDefinitionStore::new();
        store.insert_definition_for_address(
            "address:one".to_string(),
            definition("action:one", "action", "one"),
        );
        store.insert_definition_for_address(
            "address:two".to_string(),
            definition("action:two", "action", "two"),
        );

        assert!(store.remove_definition_address("address:one"));
        assert!(store
            .get_by_id("action:one", "partition:test")
            .unwrap()
            .is_none());
        assert!(store
            .get_by_id("action:two", "partition:test")
            .unwrap()
            .is_some());
        assert!(!store.remove_definition_address("address:unknown"));
        assert!(store
            .get_by_id("action:two", "partition:test")
            .unwrap()
            .is_some());
    }

    #[test]
    fn address_retraction_preserves_definition_while_another_address_owns_same_id() {
        let store = CachedDefinitionStore::new();
        store.insert_definition_for_address(
            "address:one".to_string(),
            definition("action:shared", "action", "shared-one"),
        );
        store.insert_definition_for_address(
            "address:two".to_string(),
            definition("action:shared", "action", "shared-two"),
        );

        assert!(store.remove_definition_address("address:one"));
        let loaded = store
            .get_by_id("action:shared", "partition:test")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.name, "shared-two");

        assert!(store.remove_definition_address("address:two"));
        assert!(store
            .get_by_id("action:shared", "partition:test")
            .unwrap()
            .is_none());
    }

    #[test]
    fn direct_definition_address_has_priority_over_legacy_action_fact() {
        let store = CachedDefinitionStore::new();
        store.insert_definition_for_address(
            "attribute_fact|action:shared|prop:action:workflow_steps|type:action".to_string(),
            definition("action:shared", "action", "legacy"),
        );
        store.insert_definition_for_address(
            "package::journal::workflow-action::shared".to_string(),
            definition("action:shared", "action", "direct"),
        );
        store.insert_definition_for_address(
            "attribute_fact|action:shared|prop:action:workflow_steps|type:action".to_string(),
            definition("action:shared", "action", "legacy-updated"),
        );

        let loaded = store
            .get_by_id("action:shared", "partition:test")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.name, "direct");

        assert!(store.remove_definition_address("package::journal::workflow-action::shared",));
        let loaded = store
            .get_by_id("action:shared", "partition:test")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.name, "legacy-updated");
    }

    #[test]
    fn replacing_an_address_moves_ownership_between_definition_ids() {
        let store = CachedDefinitionStore::new();
        store.insert_definition_for_address(
            "address:one".to_string(),
            definition("action:old", "action", "old"),
        );
        store.insert_definition_for_address(
            "address:one".to_string(),
            definition("action:new", "action", "new"),
        );

        assert!(store
            .get_by_id("action:old", "partition:test")
            .unwrap()
            .is_none());
        assert!(store
            .get_by_id("action:new", "partition:test")
            .unwrap()
            .is_some());
    }

    #[test]
    fn hydration_evidence_is_keyed_by_live_record_address() {
        let store = CachedDefinitionStore::new();
        store.insert_definition_for_address_with_payload_hash(
            "address:one".to_string(),
            definition("action:one", "action", "one"),
            Some("hash:one".to_string()),
        );

        let hydration = store
            .hydration_for_address("address:one")
            .expect("address is hydrated");

        assert_eq!(hydration.id, "action:one");
        assert_eq!(hydration.payload_hash.as_deref(), Some("hash:one"));
        assert!(store.hydration_for_address("address:missing").is_none());

        assert!(store.remove_definition_address("address:one"));
        assert!(store.hydration_for_address("address:one").is_none());
    }

    // ---- HARDEN-10: reconcile_id (freshness-verified prehydration) ----

    /// A stale owner (address absent from the current owner set) is removed and
    /// the repaired definition wins — same-id repair WITHOUT restart. This is
    /// the poisoned-registration revival, in-process.
    #[test]
    fn reconcile_removes_stale_owner_so_repaired_definition_wins() {
        let store = CachedDefinitionStore::new();
        // The poisoned era: a stale owner claims the id...
        store.insert_definition_for_address_with_payload_hash(
            "address:stale".to_string(),
            definition("action:poisoned", "action", "stale"),
            Some("hash:stale".to_string()),
        );
        // ...and a later repair at a different address is shadow-prone
        // (source_rank ties, higher local sequence would win here, but the
        // point is the STALE owner must not survive reconcile at all).
        assert_eq!(
            store
                .get_by_id("action:poisoned", "partition:test")
                .unwrap()
                .unwrap()
                .name,
            "stale"
        );

        // Fold current truth: only the repaired record exists.
        store.reconcile_id(
            "action:poisoned",
            vec![(
                "address:repaired".to_string(),
                Some("hash:repaired".to_string()),
                definition("action:poisoned", "action", "repaired"),
            )],
        );

        let active = store
            .get_by_id("action:poisoned", "partition:test")
            .unwrap()
            .unwrap();
        assert_eq!(active.name, "repaired");
        assert!(store.hydration_for_address("address:stale").is_none());
    }

    /// An id whose every record was retracted loses ALL cached owners on a
    /// successful-but-empty reconcile.
    #[test]
    fn reconcile_with_empty_current_set_removes_the_id() {
        let store = CachedDefinitionStore::new();
        store.insert_definition_for_address(
            "address:only".to_string(),
            definition("action:gone", "action", "only"),
        );
        store.reconcile_id("action:gone", Vec::new());
        assert!(store
            .get_by_id("action:gone", "partition:test")
            .unwrap()
            .is_none());
    }

    /// Content-hash-unchanged owners are not re-inserted: their local sequence
    /// is stable across reconciles (no churn — a repeated reconcile is a no-op).
    #[test]
    fn reconcile_does_not_churn_unchanged_owners() {
        let store = CachedDefinitionStore::new();
        store.insert_definition_for_address_with_payload_hash(
            "address:steady".to_string(),
            definition("action:steady", "action", "steady"),
            Some("hash:steady".to_string()),
        );
        // Two owners with equal rank: if reconcile re-inserted the steady one,
        // its sequence would advance past the competitor's and flip selection.
        store.insert_definition_for_address_with_payload_hash(
            "address:competitor".to_string(),
            definition("action:steady", "action", "competitor"),
            Some("hash:competitor".to_string()),
        );
        assert_eq!(
            store
                .get_by_id("action:steady", "partition:test")
                .unwrap()
                .unwrap()
                .name,
            "competitor"
        );

        // Reconcile with both owners current and unchanged — selection must
        // NOT flip back to steady (proof neither was re-inserted).
        store.reconcile_id(
            "action:steady",
            vec![
                (
                    "address:steady".to_string(),
                    Some("hash:steady".to_string()),
                    definition("action:steady", "action", "steady"),
                ),
                (
                    "address:competitor".to_string(),
                    Some("hash:competitor".to_string()),
                    definition("action:steady", "action", "competitor"),
                ),
            ],
        );
        assert_eq!(
            store
                .get_by_id("action:steady", "partition:test")
                .unwrap()
                .unwrap()
                .name,
            "competitor"
        );
    }

    /// A changed content hash at a current address IS upserted (repair-in-place
    /// at the same address also works).
    #[test]
    fn reconcile_upserts_changed_content_at_same_address() {
        let store = CachedDefinitionStore::new();
        store.insert_definition_for_address_with_payload_hash(
            "address:same".to_string(),
            definition("action:evolving", "action", "v1"),
            Some("hash:v1".to_string()),
        );
        store.reconcile_id(
            "action:evolving",
            vec![(
                "address:same".to_string(),
                Some("hash:v2".to_string()),
                definition("action:evolving", "action", "v2"),
            )],
        );
        assert_eq!(
            store
                .get_by_id("action:evolving", "partition:test")
                .unwrap()
                .unwrap()
                .name,
            "v2"
        );
    }

    /// Owners of OTHER ids at unrelated addresses are untouched by a reconcile.
    #[test]
    fn reconcile_leaves_other_ids_alone() {
        let store = CachedDefinitionStore::new();
        store.insert_definition_for_address(
            "address:other".to_string(),
            definition("action:other", "action", "other"),
        );
        store.reconcile_id("action:poisoned", Vec::new());
        assert_eq!(
            store
                .get_by_id("action:other", "partition:test")
                .unwrap()
                .unwrap()
                .name,
            "other"
        );
    }
}
