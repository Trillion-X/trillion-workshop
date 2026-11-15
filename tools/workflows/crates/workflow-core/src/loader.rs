// crates/workflow-core/src/loader.rs
//
// Purpose:
//   Load Definition (action/workflow/any kind) from the DefinitionStore.
//   DefinitionStore returns assembled Definition objects directly.
//   This module provides convenience functions for common lookup patterns.
//
// Non-Negotiable Invariants:
//   1. ZERO source-owner property constants — assembly is the source owner's job.
//   2. ZERO database dependencies — pure DefinitionStore trait usage.
//   3. DefinitionStore returns Definition directly — no deserialization needed.

use crate::domain::errors::WorkflowResult;
use crate::domain::types::Definition;
use crate::domain::DefinitionStore;
use std::sync::Arc;

// ============================================================================
// LOADER FUNCTIONS — Delegate to DefinitionStore
// ============================================================================

/// Load a definition by its entity ID.
pub fn load_definition_by_id(
    store: &dyn DefinitionStore,
    entity_id: &str,
    partition_key: &str,
) -> WorkflowResult<Option<Definition>> {
    store.get_by_id(entity_id, partition_key)
}

/// Load a shared definition by its entity ID.
pub fn load_definition_by_id_shared(
    store: &dyn DefinitionStore,
    entity_id: &str,
    partition_key: &str,
) -> WorkflowResult<Option<Arc<Definition>>> {
    store.get_by_id_shared(entity_id, partition_key)
}

/// Load a definition by its slug.
pub fn load_definition_by_slug(
    store: &dyn DefinitionStore,
    slug: &str,
    partition_key: &str,
) -> WorkflowResult<Option<Definition>> {
    store.get_by_slug(slug, partition_key)
}

/// Load active definitions, optionally filtered by kind.
pub fn load_definitions_by_kind(
    store: &dyn DefinitionStore,
    category: &str,
    partition_key: &str,
) -> WorkflowResult<Vec<Definition>> {
    store.get_active(partition_key, Some(category))
}

/// Load all active definitions.
pub fn load_active_definitions(
    store: &dyn DefinitionStore,
    partition_key: &str,
) -> WorkflowResult<Vec<Definition>> {
    store.get_active(partition_key, None)
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// In-memory DefinitionStore for testing.
    struct MockDefinitionStore {
        definitions: HashMap<String, Definition>,
    }

    impl MockDefinitionStore {
        fn new() -> Self {
            Self {
                definitions: HashMap::new(),
            }
        }

        fn register(&mut self, id: &str, name: &str) {
            self.definitions.insert(
                id.to_string(),
                Definition {
                    id: id.to_string(),
                    partition_key: "partition:test".to_string(),
                    name: name.to_string(),
                    is_active: true,
                    ..Default::default()
                },
            );
        }
    }

    impl DefinitionStore for MockDefinitionStore {
        fn get_by_id(&self, id: &str, _pk: &str) -> WorkflowResult<Option<Definition>> {
            Ok(self.definitions.get(id).cloned())
        }
        fn get_by_slug(&self, slug: &str, _pk: &str) -> WorkflowResult<Option<Definition>> {
            Ok(self.definitions.values().find(|d| d.name == slug).cloned())
        }
        fn get_active(&self, _pk: &str, _kind: Option<&str>) -> WorkflowResult<Vec<Definition>> {
            Ok(self
                .definitions
                .values()
                .filter(|d| d.is_active)
                .cloned()
                .collect())
        }
        fn get_by_trigger(&self, _src: &str, _pk: &str) -> WorkflowResult<Vec<Definition>> {
            Ok(vec![])
        }
    }

    #[test]
    fn load_by_id() {
        let mut store = MockDefinitionStore::new();
        store.register("action:test", "focusNode");
        let def = load_definition_by_id(&store, "action:test", "partition:test")
            .unwrap()
            .unwrap();
        assert_eq!(def.name, "focusNode");
    }

    #[test]
    fn load_returns_none_for_missing() {
        let store = MockDefinitionStore::new();
        assert!(load_definition_by_id(&store, "nope", "partition:test")
            .unwrap()
            .is_none());
    }

    #[test]
    fn load_by_slug() {
        let mut store = MockDefinitionStore::new();
        store.register("action:1", "mySlug");
        let def = load_definition_by_slug(&store, "mySlug", "partition:test")
            .unwrap()
            .unwrap();
        assert_eq!(def.name, "mySlug");
    }

    #[test]
    fn load_active() {
        let mut store = MockDefinitionStore::new();
        store.register("action:1", "active");
        assert_eq!(
            load_active_definitions(&store, "partition:test")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn definition_store_is_object_safe() {
        let store = MockDefinitionStore::new();
        let _dyn_store: &dyn DefinitionStore = &store;
    }
}
