//! crates/composition-engine-core/src/kernel/ambient.rs
//!
//! Ambient Context (KE1): nearest-scope resolution, selective invalidation, subtree isolation.
//! ADAPTED FOR IMMUTABLE ARCHITECTURE - uses path_to_root instead of parent pointers.
//!
//! Ported from: frontends/web/composition-engine/kernel/ambient.ts

use super::types::{ContextKey, SceneNode, ID};
use std::collections::HashMap;

// ============================================================================
// Pure Functional Ambient Context Operations
// ============================================================================

/// Compute ambient context cache for entire tree.
/// Returns Map<CtxKey, Map<NodeID, value>>
///
/// This is the pure functional version - computes context propagation
/// without maintaining any mutable state.
pub fn compute_ambient_cache(
    root: &SceneNode,
    providers: &HashMap<ContextKey, HashMap<ID, serde_json::Value>>,
) -> HashMap<ContextKey, HashMap<ID, serde_json::Value>> {
    let mut cache: HashMap<ContextKey, HashMap<ID, serde_json::Value>> = HashMap::new();

    // For each context key
    for (key, provider_map) in providers {
        let mut node_cache: HashMap<ID, serde_json::Value> = HashMap::new();

        // Walk tree and propagate context down
        propagate_context(root, provider_map, &mut node_cache, None);

        cache.insert(*key, node_cache);
    }

    cache
}

/// Recursively propagate context values down the tree
fn propagate_context(
    node: &SceneNode,
    provider_map: &HashMap<ID, serde_json::Value>,
    node_cache: &mut HashMap<ID, serde_json::Value>,
    inherited_value: Option<&serde_json::Value>,
) {
    // Check if this node provides the context
    let provided_value = provider_map.get(&node.id);

    // The effective value is either this node's provided value or inherited
    let effective_value = provided_value.or(inherited_value);

    if let Some(value) = effective_value {
        node_cache.insert(node.id.clone(), value.clone());
    }

    // Recurse to children with the effective value
    for child in &node.children {
        propagate_context(child, provider_map, node_cache, effective_value);
    }
}

/// Get context value for a node from the cache
pub fn get_context(
    cache: &HashMap<ContextKey, HashMap<ID, serde_json::Value>>,
    key: ContextKey,
    node_id: &ID,
) -> Option<serde_json::Value> {
    cache.get(&key)?.get(node_id).cloned()
}

/// Find path from target node to root (returns node IDs from target to root)
pub fn path_to_root(root: &SceneNode, target_id: &ID) -> Vec<ID> {
    let mut result = Vec::new();
    find_path_recursive(root, target_id, &mut result);
    // Result is already target -> root order from the recursive building
    result
}

fn find_path_recursive(node: &SceneNode, target_id: &ID, path: &mut Vec<ID>) -> bool {
    if &node.id == target_id {
        path.push(node.id.clone());
        return true;
    }

    for child in &node.children {
        if find_path_recursive(child, target_id, path) {
            path.push(node.id.clone());
            return true;
        }
    }

    false
}

/// Check if ancestor_id is an ancestor of descendant_id in the tree
pub fn is_ancestor(root: &SceneNode, ancestor_id: &ID, descendant_id: &ID) -> bool {
    let path = path_to_root(root, descendant_id);
    path.contains(ancestor_id)
}

/// Find the nearest provider for a context key by walking up from node
pub fn find_nearest_provider(
    root: &SceneNode,
    providers: &HashMap<ID, serde_json::Value>,
    node_id: &ID,
) -> Option<serde_json::Value> {
    let path = path_to_root(root, node_id);

    // Walk from node to root looking for a provider
    for ancestor_id in &path {
        if let Some(value) = providers.get(ancestor_id) {
            return Some(value.clone());
        }
    }

    None
}

// ============================================================================
// Stateful Ambient Context (for compatibility)
// ============================================================================

/// Subscriber for context changes (placeholder for reactive updates)
#[allow(dead_code)]
#[derive(Debug)]
struct Subscriber {
    node_id: ID,
    key: ContextKey,
    selector_cache: Option<serde_json::Value>,
}

/// Stateful ambient context manager
///
/// This maintains subscribers and triggers invalidations.
/// Core computation is pure functional via compute_ambient_cache.
#[derive(Debug)]
pub struct AmbientContext {
    root_tree: Option<SceneNode>,
    providers: HashMap<ContextKey, HashMap<ID, serde_json::Value>>,
    subscribers: HashMap<ContextKey, Vec<Subscriber>>,
}

impl Default for AmbientContext {
    fn default() -> Self {
        Self::new()
    }
}

impl AmbientContext {
    pub fn new() -> Self {
        Self {
            root_tree: None,
            providers: HashMap::new(),
            subscribers: HashMap::new(),
        }
    }

    /// Set the root tree (called by kernel on each tick)
    pub fn set_root(&mut self, root: SceneNode) {
        self.root_tree = Some(root);
    }

    /// Provide a context value at a scope
    pub fn provide(&mut self, key: ContextKey, value: serde_json::Value, scope_id: ID) {
        self.providers
            .entry(key)
            .or_default()
            .insert(scope_id, value);
    }

    /// Provide a stable value (won't change if already set)
    pub fn provide_stable(&mut self, key: ContextKey, value: serde_json::Value, scope_id: ID) {
        let map = self.providers.entry(key).or_default();
        map.entry(scope_id).or_insert(value);
    }

    /// Consume a context value for a node
    pub fn consume(&self, key: ContextKey, node_id: &ID) -> Option<serde_json::Value> {
        let root = self.root_tree.as_ref()?;
        let provider_map = self.providers.get(&key)?;
        find_nearest_provider(root, provider_map, node_id)
    }

    /// Get the computed cache for a context key
    pub fn get_cache(&self) -> HashMap<ContextKey, HashMap<ID, serde_json::Value>> {
        match &self.root_tree {
            Some(root) => compute_ambient_cache(root, &self.providers),
            None => HashMap::new(),
        }
    }

    /// Get providers map for external use
    pub fn get_providers(&self) -> &HashMap<ContextKey, HashMap<ID, serde_json::Value>> {
        &self.providers
    }

    /// Take a snapshot of all context values for a node
    pub fn snapshot(&self, node_id: &ID) -> HashMap<ContextKey, serde_json::Value> {
        let mut out = HashMap::new();

        for key in self.providers.keys() {
            if let Some(value) = self.consume(*key, node_id) {
                out.insert(*key, value);
            }
        }

        out
    }

    /// Clear all providers
    pub fn clear(&mut self) {
        self.providers.clear();
        self.subscribers.clear();
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::NodeKind;
    use std::sync::Arc;

    fn make_test_tree() -> SceneNode {
        SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "a".to_string(),
                    kind: NodeKind::Container,
                    children: vec![
                        Arc::new(SceneNode {
                            id: "a1".to_string(),
                            kind: NodeKind::Text,
                            children: vec![],
                            ..Default::default()
                        }),
                        Arc::new(SceneNode {
                            id: "a2".to_string(),
                            kind: NodeKind::Text,
                            children: vec![],
                            ..Default::default()
                        }),
                    ],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "b".to_string(),
                    kind: NodeKind::Container,
                    children: vec![Arc::new(SceneNode {
                        id: "b1".to_string(),
                        kind: NodeKind::Text,
                        children: vec![],
                        ..Default::default()
                    })],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        }
    }

    #[test]
    fn test_path_to_root() {
        let root = make_test_tree();

        let path = path_to_root(&root, &"a1".to_string());
        assert_eq!(path, vec!["a1", "a", "root"]);

        let path = path_to_root(&root, &"root".to_string());
        assert_eq!(path, vec!["root"]);

        let path = path_to_root(&root, &"nonexistent".to_string());
        assert!(path.is_empty());
    }

    #[test]
    fn test_is_ancestor() {
        let root = make_test_tree();

        assert!(is_ancestor(&root, &"root".to_string(), &"a1".to_string()));
        assert!(is_ancestor(&root, &"a".to_string(), &"a1".to_string()));
        assert!(!is_ancestor(&root, &"b".to_string(), &"a1".to_string()));
        assert!(!is_ancestor(&root, &"a1".to_string(), &"a".to_string())); // Not ancestor
    }

    #[test]
    fn test_compute_ambient_cache() {
        let root = make_test_tree();
        let mut providers: HashMap<ContextKey, HashMap<ID, serde_json::Value>> = HashMap::new();

        // Root provides theme
        let mut theme_providers = HashMap::new();
        theme_providers.insert("root".to_string(), serde_json::json!("dark"));
        providers.insert(ContextKey::Ambient, theme_providers);

        let cache = compute_ambient_cache(&root, &providers);

        // All nodes should inherit from root
        let ambient_cache = cache.get(&ContextKey::Ambient).unwrap();
        assert_eq!(ambient_cache.get("root"), Some(&serde_json::json!("dark")));
        assert_eq!(ambient_cache.get("a"), Some(&serde_json::json!("dark")));
        assert_eq!(ambient_cache.get("a1"), Some(&serde_json::json!("dark")));
        assert_eq!(ambient_cache.get("b"), Some(&serde_json::json!("dark")));
        assert_eq!(ambient_cache.get("b1"), Some(&serde_json::json!("dark")));
    }

    #[test]
    fn test_compute_ambient_cache_override() {
        let root = make_test_tree();
        let mut providers: HashMap<ContextKey, HashMap<ID, serde_json::Value>> = HashMap::new();

        // Root provides theme, "a" overrides
        let mut theme_providers = HashMap::new();
        theme_providers.insert("root".to_string(), serde_json::json!("dark"));
        theme_providers.insert("a".to_string(), serde_json::json!("light"));
        providers.insert(ContextKey::Ambient, theme_providers);

        let cache = compute_ambient_cache(&root, &providers);

        let ambient_cache = cache.get(&ContextKey::Ambient).unwrap();
        assert_eq!(ambient_cache.get("root"), Some(&serde_json::json!("dark")));
        assert_eq!(ambient_cache.get("a"), Some(&serde_json::json!("light"))); // Override
        assert_eq!(ambient_cache.get("a1"), Some(&serde_json::json!("light"))); // Inherits from "a"
        assert_eq!(ambient_cache.get("a2"), Some(&serde_json::json!("light"))); // Inherits from "a"
        assert_eq!(ambient_cache.get("b"), Some(&serde_json::json!("dark"))); // Inherits from root
        assert_eq!(ambient_cache.get("b1"), Some(&serde_json::json!("dark"))); // Inherits from root
    }

    #[test]
    fn test_ambient_context_stateful() {
        let root = make_test_tree();
        let mut ctx = AmbientContext::new();
        ctx.set_root(root);

        ctx.provide(
            ContextKey::Ambient,
            serde_json::json!("dark"),
            "root".to_string(),
        );
        ctx.provide(ContextKey::Vars, serde_json::json!(42), "a".to_string());

        assert_eq!(
            ctx.consume(ContextKey::Ambient, &"a1".to_string()),
            Some(serde_json::json!("dark"))
        );
        assert_eq!(
            ctx.consume(ContextKey::Vars, &"a1".to_string()),
            Some(serde_json::json!(42))
        );
        assert_eq!(ctx.consume(ContextKey::Vars, &"b1".to_string()), None); // Not in "a" subtree
    }

    #[test]
    fn test_ambient_context_snapshot() {
        let root = make_test_tree();
        let mut ctx = AmbientContext::new();
        ctx.set_root(root);

        ctx.provide(
            ContextKey::Ambient,
            serde_json::json!("dark"),
            "root".to_string(),
        );
        ctx.provide(ContextKey::Vars, serde_json::json!(42), "root".to_string());

        let snap = ctx.snapshot(&"a1".to_string());
        assert_eq!(
            snap.get(&ContextKey::Ambient),
            Some(&serde_json::json!("dark"))
        );
        assert_eq!(snap.get(&ContextKey::Vars), Some(&serde_json::json!(42)));
    }
}
