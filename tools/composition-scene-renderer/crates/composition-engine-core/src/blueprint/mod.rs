//! crates/composition-engine-core/src/blueprint/mod.rs
//!
//! Blueprint Module — Untrusted authoring layer for UI scenes.
//!
//! # Purpose
//! This module provides the types and functions for working with author-time
//! blueprints. Blueprints are the untrusted, user-facing format that gets
//! validated, normalized, and resolved into kernel-ready SceneNodes.
//!
//! # Pipeline
//! ```text
//! BlueprintNode (untrusted)
//!     ↓ guards.validate()
//! BlueprintNode (validated)
//!     ↓ normalize.normalize_scene()
//! SceneInit (normalized)
//!     ↓ resolver.resolve_tree()
//! SceneNode (resolved, kernel-ready)
//! ```
//!
//! # Non-Negotiable Invariants
//! - Never pass BlueprintNode directly to the kernel
//! - All style values must be resolved to magnitudes before kernel consumption
//! - Validation happens before normalization
//!
//! # Modules
//! - `types`: Blueprint types (BlueprintNode, BlueprintStyle, etc.)
//! - `guards`: Validation functions
//! - `normalize`: Blueprint → SceneInit conversion
//! - `resolver`: Token resolution and style resolution
//!
//! Ported from: frontends/web/composition-engine/blueprint/

pub mod guards;
pub mod normalize;
pub mod resolver;
pub mod types;

// Re-export main types for convenience
pub use types::{
    BindingRef, BlueprintA11y, BlueprintAxis, BlueprintEvent, BlueprintHandlers, BlueprintInsets,
    BlueprintKind, BlueprintLayout, BlueprintNode, BlueprintProps, BlueprintRect, BlueprintScene,
    BlueprintSplitPart, BlueprintStyle, BlueprintViewport, StyleLiteral, StyleLiteralValue,
    StyleValue, TokenRef,
};

pub use guards::{
    is_blueprint_node, is_blueprint_scene, validate_node, validate_scene, Diagnostic,
    ValidationError, ValidationResult,
};

pub use normalize::{
    normalize_from_json, normalize_from_value, normalize_node_to_scene, normalize_scene,
    NormalizeError, NormalizeResult,
};

pub use resolver::{
    resolve_style, resolve_tree, resolve_tree_no_tokens, resolve_tree_with_tokens, HashMapResolver,
    Magnitude, ResolveError, ResolveResult, TokenResolver, TokenSet,
};
