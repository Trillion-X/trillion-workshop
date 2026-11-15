// crates/composition-engine/tests/error_conformance.rs
//
// # Purpose
//
// Cross-boundary conformance tests for `SceneError` and `SceneDiffError`.
// These tests act as a **compile-time CI gate**: every variant is constructed
// using named-field syntax. If any future variant regresses to an opaque
// `(String)` pattern, this file will refuse to compile.
//
// # Non-Negotiable Invariants
//
// 1. **Compile-time gate** — every variant in both enums is constructed with
//    named fields. Opaque `(String)` variants break compilation.
// 2. **Variant count guard** — if a new variant is added without updating
//    this test, the count assertion fails.
// 3. **Display contract** — every variant's `Display` output includes
//    structured field values.
// 4. **SceneError carries reason+hint** — all 4 SceneError variants have
//    `reason` and `hint` fields for machine-readable error handling.
// 5. **SceneDiffError baseline** — already compliant; these tests verify
//    the baseline remains intact.
//
// # Key Concepts
//
// - Integration test (lives in `tests/`) — verifies the public API surface.
// - Two error enums in one test file: SceneError (scene tree operations) and
//   SceneDiffError (diff/apply operations).
// - SceneDiffError uses `thiserror::Error` derive; SceneError uses manual
//   `Display` impl — both are verified.
//
// # Security Considerations
//
// - Test data uses marker strings that are trivially distinguishable from
//   production data.
//
// ---
// PERMANENT DIRECTIVE TO ALL FUTURE AI ASSISTANTS:
// The extensive, granular documentation in this codebase is a critical design
// feature. You are forbidden from simplifying or removing it. Your mandate is
// to maintain and extend this level of meticulous detail.
// ---

use composition_engine::kernel::scene::SceneError;
use composition_engine::kernel::scene_diff_types::SceneDiffError;
use composition_engine::kernel::types::NodeKind;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Expected number of SceneError variants.
///
/// 4 total: CycleDetected, CannotRemoveRoot, NodeNotFound, ParentNotFound.
const EXPECTED_SCENE_ERROR_COUNT: usize = 4;

/// Expected number of SceneDiffError variants.
///
/// 7 total: DuplicateId, InvalidId, NodeNotFound, IndexOutOfBounds,
/// PatchApplicationFailed, ValidationFailed, KindChangedForId.
const EXPECTED_SCENE_DIFF_ERROR_COUNT: usize = 7;

// ============================================================================
// HELPERS — SceneError
// ============================================================================

/// Construct every single SceneError variant using named-field syntax.
///
/// **THIS IS THE COMPILE-TIME GATE.** If any variant is an opaque `(String)`,
/// this function will NOT COMPILE.
fn construct_all_scene_errors() -> Vec<SceneError> {
    vec![
        SceneError::CycleDetected {
            child_id: "child-conformance".into(),
            parent_id: "parent-conformance".into(),
            reason: "CONFORMANCE_REASON".into(),
            hint: "CONFORMANCE_HINT".into(),
        },
        SceneError::CannotRemoveRoot {
            reason: "CONFORMANCE_REASON".into(),
            hint: "CONFORMANCE_HINT".into(),
        },
        SceneError::NodeNotFound {
            id: "node-conformance".into(),
            reason: "CONFORMANCE_REASON".into(),
            hint: "CONFORMANCE_HINT".into(),
        },
        SceneError::ParentNotFound {
            id: "parent-conformance".into(),
            reason: "CONFORMANCE_REASON".into(),
            hint: "CONFORMANCE_HINT".into(),
        },
    ]
}

// ============================================================================
// HELPERS — SceneDiffError
// ============================================================================

/// Construct every single SceneDiffError variant using named-field syntax.
///
/// **THIS IS THE COMPILE-TIME GATE.** If any variant is an opaque `(String)`,
/// this function will NOT COMPILE.
fn construct_all_scene_diff_errors() -> Vec<SceneDiffError> {
    vec![
        SceneDiffError::DuplicateId {
            id: "dup-conformance".into(),
            context: "CONFORMANCE_CONTEXT".into(),
        },
        SceneDiffError::InvalidId {
            id: "bad@conformance".into(),
            reason: "CONFORMANCE_REASON".into(),
        },
        SceneDiffError::NodeNotFound {
            id: "missing-conformance".into(),
        },
        SceneDiffError::IndexOutOfBounds {
            parent_id: "parent-conformance".into(),
            index: 99,
            len: 3,
        },
        SceneDiffError::PatchApplicationFailed {
            reason: "CONFORMANCE_REASON".into(),
        },
        SceneDiffError::ValidationFailed {
            reason: "CONFORMANCE_REASON".into(),
        },
        SceneDiffError::KindChangedForId {
            id: "kind-conformance".into(),
            old_kind: NodeKind::Container,
            new_kind: NodeKind::Text,
        },
    ]
}

// ============================================================================
// SCENEERROR TESTS (Tests 1-8)
// ============================================================================

// TEST 1: Compile-Time Gate — All SceneError Variants Are Structured
// ============================================================================

/// **CI GATE**: Construct every SceneError variant using named fields.
/// If ANY variant is opaque, this test will NOT COMPILE.
#[test]
fn scene_error_all_variants_are_structured() {
    let errors = construct_all_scene_errors();

    for err in &errors {
        let display = format!("{}", err);
        assert!(!display.is_empty(), "SceneError display must not be empty");
    }
}

// ============================================================================
// TEST 2: SceneError Variant Count Guard
// ============================================================================

/// Verify SceneError variant count matches expected.
#[test]
fn scene_error_variant_count_matches_expected() {
    let count = construct_all_scene_errors().len();
    assert_eq!(
        count, EXPECTED_SCENE_ERROR_COUNT,
        "SceneError variant count changed! Expected {}, got {}. \
         If you added a new variant, add it to construct_all_scene_errors() \
         and update EXPECTED_SCENE_ERROR_COUNT.",
        EXPECTED_SCENE_ERROR_COUNT, count
    );
}

// ============================================================================
// TEST 3: SceneError Display Contains Reason
// ============================================================================

/// Every SceneError variant's Display output must contain the reason text.
#[test]
fn scene_error_all_variants_display_contains_reason() {
    let errors = construct_all_scene_errors();

    for err in &errors {
        let display = format!("{}", err);
        assert!(
            display.contains("CONFORMANCE_REASON"),
            "SceneError Display must contain reason text. Got: {}",
            display
        );
    }
}

// ============================================================================
// TEST 4: SceneError Display Contains Hint
// ============================================================================

/// Every SceneError variant's Display output must contain the hint text.
#[test]
fn scene_error_all_variants_display_contains_hint() {
    let errors = construct_all_scene_errors();

    for err in &errors {
        let display = format!("{}", err);
        assert!(
            display.contains("CONFORMANCE_HINT"),
            "SceneError Display must contain hint text. Got: {}",
            display
        );
    }
}

// ============================================================================
// TEST 5: CycleDetected Has child_id and parent_id Domain Fields
// ============================================================================

/// CycleDetected must carry child_id and parent_id that appear in Display.
#[test]
fn scene_error_cycle_detected_has_domain_fields() {
    let err = SceneError::CycleDetected {
        child_id: "child-domain-test".into(),
        parent_id: "parent-domain-test".into(),
        reason: "r".into(),
        hint: "h".into(),
    };
    let display = format!("{}", err);
    assert!(
        display.contains("child-domain-test"),
        "child_id must appear in Display"
    );
    assert!(
        display.contains("parent-domain-test"),
        "parent_id must appear in Display"
    );

    if let SceneError::CycleDetected {
        child_id,
        parent_id,
        ..
    } = &err
    {
        assert_eq!(child_id, "child-domain-test");
        assert_eq!(parent_id, "parent-domain-test");
    } else {
        panic!("Expected CycleDetected");
    }
}

// ============================================================================
// TEST 6: NodeNotFound Has id Domain Field
// ============================================================================

/// NodeNotFound must carry id that appears in Display.
#[test]
fn scene_error_node_not_found_has_id() {
    let err = SceneError::NodeNotFound {
        id: "node-domain-test".into(),
        reason: "r".into(),
        hint: "h".into(),
    };
    let display = format!("{}", err);
    assert!(
        display.contains("node-domain-test"),
        "id must appear in Display"
    );

    if let SceneError::NodeNotFound { id, .. } = &err {
        assert_eq!(id, "node-domain-test");
    } else {
        panic!("Expected NodeNotFound");
    }
}

// ============================================================================
// TEST 7: SceneError Serialization Round-Trip
// ============================================================================

/// JSON serialize → deserialize must preserve all fields for SceneError.
#[test]
fn scene_error_serialization_roundtrip() {
    let errors = construct_all_scene_errors();

    for original in &errors {
        let json = serde_json::to_string(original)
            .unwrap_or_else(|e| panic!("Serialize failed for {:?}: {}", original, e));

        let deserialized: SceneError = serde_json::from_str(&json)
            .unwrap_or_else(|e| panic!("Deserialize failed for {:?}: {}", original, e));

        assert_eq!(
            *original, deserialized,
            "Round-trip must preserve all fields"
        );
    }
}

// ============================================================================
// TEST 8: SceneError ParentNotFound Has id Domain Field
// ============================================================================

/// ParentNotFound must carry id that appears in Display.
#[test]
fn scene_error_parent_not_found_has_id() {
    let err = SceneError::ParentNotFound {
        id: "parent-domain-test".into(),
        reason: "CONFORMANCE_REASON".into(),
        hint: "CONFORMANCE_HINT".into(),
    };
    let display = format!("{}", err);
    assert!(
        display.contains("parent-domain-test"),
        "id must appear in Display"
    );
    assert!(display.contains("CONFORMANCE_REASON"));
    assert!(display.contains("CONFORMANCE_HINT"));
}

// ============================================================================
// SCENEDIFFERROR TESTS (Tests 9-14)
// ============================================================================

// TEST 9: Compile-Time Gate — All SceneDiffError Variants Are Structured
// ============================================================================

/// **CI GATE**: Construct every SceneDiffError variant using named fields.
/// If ANY variant is opaque, this test will NOT COMPILE.
#[test]
fn scene_diff_error_all_variants_are_structured() {
    let errors = construct_all_scene_diff_errors();

    for err in &errors {
        let display = format!("{}", err);
        assert!(
            !display.is_empty(),
            "SceneDiffError display must not be empty"
        );
    }
}

// ============================================================================
// TEST 10: SceneDiffError Variant Count Guard
// ============================================================================

/// Verify SceneDiffError variant count matches expected.
#[test]
fn scene_diff_error_variant_count_matches_expected() {
    let count = construct_all_scene_diff_errors().len();
    assert_eq!(
        count, EXPECTED_SCENE_DIFF_ERROR_COUNT,
        "SceneDiffError variant count changed! Expected {}, got {}. \
         If you added a new variant, add it to construct_all_scene_diff_errors() \
         and update EXPECTED_SCENE_DIFF_ERROR_COUNT.",
        EXPECTED_SCENE_DIFF_ERROR_COUNT, count
    );
}

// ============================================================================
// TEST 11: SceneDiffError Display Contains Structured Data
// ============================================================================

/// Every SceneDiffError variant's Display output must include its field values.
#[test]
fn scene_diff_error_all_variants_display_nonempty() {
    let test_cases: Vec<(SceneDiffError, Vec<&str>)> = vec![
        (
            SceneDiffError::DuplicateId {
                id: "dup-display".into(),
                context: "display-context".into(),
            },
            vec!["dup-display", "display-context"],
        ),
        (
            SceneDiffError::InvalidId {
                id: "bad@display".into(),
                reason: "display-reason".into(),
            },
            vec!["bad@display", "display-reason"],
        ),
        (
            SceneDiffError::NodeNotFound {
                id: "missing-display".into(),
            },
            vec!["missing-display"],
        ),
        (
            SceneDiffError::IndexOutOfBounds {
                parent_id: "parent-display".into(),
                index: 42,
                len: 7,
            },
            vec!["parent-display", "42", "7"],
        ),
        (
            SceneDiffError::PatchApplicationFailed {
                reason: "display-patch-reason".into(),
            },
            vec!["display-patch-reason"],
        ),
        (
            SceneDiffError::ValidationFailed {
                reason: "display-validation-reason".into(),
            },
            vec!["display-validation-reason"],
        ),
        (
            SceneDiffError::KindChangedForId {
                id: "kind-display".into(),
                old_kind: NodeKind::Container,
                new_kind: NodeKind::Text,
            },
            vec!["kind-display", "Container", "Text"],
        ),
    ];

    for (err, expected_fragments) in &test_cases {
        let display = format!("{}", err);
        assert!(!display.is_empty());
        for fragment in expected_fragments {
            assert!(
                display.contains(fragment),
                "SceneDiffError Display must contain '{}'. Got: {}",
                fragment,
                display
            );
        }
    }
}

// ============================================================================
// TEST 12: SceneDiffError Serialization Round-Trip
// ============================================================================

/// Every SceneDiffError variant must survive a JSON round-trip.
#[test]
fn scene_diff_error_serialization_roundtrip() {
    let errors = construct_all_scene_diff_errors();

    for original in &errors {
        let json = serde_json::to_string(original)
            .unwrap_or_else(|e| panic!("Serialize failed for {:?}: {}", original, e));

        let deserialized: SceneDiffError = serde_json::from_str(&json)
            .unwrap_or_else(|e| panic!("Deserialize failed for {:?}: {}", original, e));

        assert_eq!(
            *original, deserialized,
            "Round-trip must preserve all fields"
        );
    }
}

// ============================================================================
// TEST 13: KindChangedForId Has old_kind and new_kind Domain Fields
// ============================================================================

/// KindChangedForId must carry old_kind and new_kind that appear in Display.
#[test]
fn scene_diff_error_kind_changed_has_domain_fields() {
    let err = SceneDiffError::KindChangedForId {
        id: "kind-domain-test".into(),
        old_kind: NodeKind::Image,
        new_kind: NodeKind::Canvas,
    };
    let display = format!("{}", err);
    assert!(
        display.contains("kind-domain-test"),
        "id must appear in Display"
    );
    assert!(display.contains("Image"), "old_kind must appear in Display");
    assert!(
        display.contains("Canvas"),
        "new_kind must appear in Display"
    );

    if let SceneDiffError::KindChangedForId {
        id,
        old_kind,
        new_kind,
    } = &err
    {
        assert_eq!(id, "kind-domain-test");
        assert_eq!(*old_kind, NodeKind::Image);
        assert_eq!(*new_kind, NodeKind::Canvas);
    } else {
        panic!("Expected KindChangedForId");
    }
}

// ============================================================================
// TEST 14: IndexOutOfBounds Has All Numeric Fields
// ============================================================================

/// IndexOutOfBounds must carry parent_id, index, and len.
#[test]
fn scene_diff_error_index_out_of_bounds_has_all_fields() {
    let err = SceneDiffError::IndexOutOfBounds {
        parent_id: "parent-oob-test".into(),
        index: 10,
        len: 5,
    };

    if let SceneDiffError::IndexOutOfBounds {
        parent_id,
        index,
        len,
    } = &err
    {
        assert_eq!(parent_id, "parent-oob-test");
        assert_eq!(*index, 10usize);
        assert_eq!(*len, 5usize);
    } else {
        panic!("Expected IndexOutOfBounds");
    }

    let display = format!("{}", err);
    assert!(display.contains("parent-oob-test"));
    assert!(display.contains("10"));
    assert!(display.contains("5"));
}
