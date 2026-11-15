// crates/trigger-ast/src/trigger_deps.rs
//
// Purpose: Static analysis of trigger query ASTs to extract event-type dependencies.
// This is the foundation of selective trigger dispatch — by knowing what each trigger
// depends on, we can skip evaluation when the incoming event cannot possibly match.
//
// Non-Negotiable Invariants:
// 1. Analysis is CONSERVATIVE — if uncertain, assume the trigger depends on everything
//    (never skip a trigger that might match). Zero false negatives guaranteed.
// 2. Analysis is STATIC — runs once when triggers are loaded, not per-event.
// 3. Physics-only — no Society words in this module.
// 4. The existing `flatten_member_chain` from `formula_core::ast` is the canonical
//    utility for flattening dotted member access chains. We use it, not reimplement it.
//
// Key Concepts:
// - TriggerDeps: The dependency profile of a single trigger query. Boolean flags indicate
//   which event categories the trigger references (pointer, keyboard, FSM, history, target).
// - analyze_trigger_deps(): Public entry point. Parses a query string to AST, walks the
//   AST, returns a TriggerDeps describing what the trigger depends on.
// - classify_path(): Maps dot-separated field paths to dependency category flags.
// - check_event_type_literal(): Detects `event.type == "pointer"` patterns in binary
//   expressions and sets the appropriate dependency flag.
// - Conservative fallback: Any parse failure or unrecognized pattern → TriggerDeps::all().
//
// Security Considerations:
// - Untrusted query strings are parsed but never executed here (static analysis only).
// - Parse failures produce conservative deps (safe, never skip).
// - No heap allocations beyond the HashSet of accessed paths.
//
// AI DIRECTIVE: The extensive, granular documentation in this codebase is a critical
// design feature. You are forbidden from simplifying or removing it. Your mandate is
// to maintain and extend this level of meticulous detail.

use formula_ast::parser::Parser;
use formula_ast::{flatten_member_chain, AstNode, BinaryExpr, BinaryOp, Expression, Literal};
use std::collections::HashSet;

// ============================================================
// DEPENDENCY PROFILE TYPE
// ============================================================

/// What event categories a trigger query depends on.
///
/// Produced by static analysis of the trigger's formula AST. Each boolean flag
/// indicates whether the query references state related to that event category.
/// The `is_conservative` flag is a safety valve: when set, the trigger is always
/// evaluated regardless of event type (zero false negatives guaranteed).
///
/// # Selective Dispatch Semantics
///
/// The `matches_*_event()` methods answer: "Could this trigger possibly care about
/// a [pointer|keyboard|fsm] event?" They return false ONLY when we can prove the
/// trigger exclusively depends on a different event category. For example:
/// - A trigger referencing only `graph.keyboard.pressed_keys` returns false for
///   `matches_pointer_event()` — it cannot possibly match a pointer event.
/// - A trigger referencing `graph.fsm` returns true for BOTH pointer and keyboard
///   because FSM state can change on any event type.
/// - A trigger with no dependencies (like `true`) returns true for everything.
///
/// # Example
///
/// ```text
/// let deps = analyze_trigger_deps("graph.keyboard.pressed_keys");
/// // deps.depends_on_keyboard = true
/// // deps.matches_pointer_event() = false   (keyboard-exclusive)
/// // deps.matches_keyboard_event() = true
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerDeps {
    /// True if the query references pointer-related state
    /// (graph.pointers, event.x, event.y, or event.type == "pointer")
    pub depends_on_pointer: bool,

    /// True if the query references keyboard-related state
    /// (graph.keyboard, event.key, event.code, or event.type == "keyboard")
    pub depends_on_keyboard: bool,

    /// True if the query references FSM state
    /// (graph.fsm, or LOOKUP(graph.fsm, ...))
    pub depends_on_fsm: bool,

    /// True if the query references event history
    /// (graph.recent_events, graph.rt_events, graph.event_history)
    pub depends_on_history: bool,

    /// True if the query references event target or subtype
    /// (event.target, event.subtype)
    pub depends_on_event_target: bool,

    /// Set of specific graph/event field paths accessed.
    /// Examples: "graph.pointers", "graph.keyboard.pressed_keys", "event.key"
    pub accessed_paths: HashSet<String>,

    /// If true, analysis was inconclusive — treat as depending on everything.
    /// This is the safety valve: conservative triggers are NEVER skipped.
    pub is_conservative: bool,
}

impl TriggerDeps {
    /// A conservative TriggerDeps that matches everything (safe fallback).
    ///
    /// Used when:
    /// - Query parsing fails
    /// - A bare `graph` or `event` identifier is referenced without member access
    /// - An unrecognized graph/event field is accessed
    pub fn all() -> Self {
        Self {
            depends_on_pointer: true,
            depends_on_keyboard: true,
            depends_on_fsm: true,
            depends_on_history: true,
            depends_on_event_target: true,
            accessed_paths: HashSet::new(),
            is_conservative: true,
        }
    }

    /// A TriggerDeps with no dependencies set (nothing depends on anything).
    ///
    /// Used as the initial state before walking the AST. If the walk finds no
    /// references to graph/event state, the trigger has no event-type dependencies
    /// (e.g., `true` or `false` or `1 + 2 == 3`).
    fn none() -> Self {
        Self {
            depends_on_pointer: false,
            depends_on_keyboard: false,
            depends_on_fsm: false,
            depends_on_history: false,
            depends_on_event_target: false,
            accessed_paths: HashSet::new(),
            is_conservative: false,
        }
    }

    /// Returns true if this trigger could possibly care about a pointer event.
    ///
    /// Returns false ONLY when the trigger depends exclusively on keyboard state
    /// (and nothing else that could be relevant to pointer events). This guarantees
    /// zero false negatives: we never skip a trigger that might match.
    ///
    /// Triggers that depend on FSM, history, or have no deps evaluate for all events.
    pub fn matches_pointer_event(&self) -> bool {
        !self.is_keyboard_exclusive()
    }

    /// Returns true if this trigger could possibly care about a keyboard event.
    ///
    /// Returns false ONLY when the trigger depends exclusively on pointer state
    /// (and nothing else that could be relevant to keyboard events).
    pub fn matches_keyboard_event(&self) -> bool {
        !self.is_pointer_exclusive()
    }

    /// Returns true if this trigger could possibly care about a wheel event.
    ///
    /// Returns false ONLY when the trigger depends exclusively on pointer or keyboard state.
    /// Conservative triggers always return true.
    pub fn matches_wheel_event(&self) -> bool {
        !self.is_pointer_exclusive() && !self.is_keyboard_exclusive()
    }

    /// Returns true if this trigger could possibly care about an FSM state change.
    ///
    /// FSM-dependent or conservative triggers always return true.
    pub fn matches_fsm_event(&self) -> bool {
        self.is_conservative || self.depends_on_fsm
    }

    /// Returns true if no specific dependencies were detected and the trigger
    /// is not conservative. Such triggers (like `true` or `false`) have no
    /// event-type restrictions and should be evaluated for all events.
    pub fn has_no_deps(&self) -> bool {
        !self.depends_on_pointer
            && !self.depends_on_keyboard
            && !self.depends_on_fsm
            && !self.depends_on_history
            && !self.depends_on_event_target
            && !self.is_conservative
    }

    /// True if this trigger depends exclusively on keyboard state.
    ///
    /// "Exclusively" means: depends_on_keyboard is the ONLY category flag set,
    /// no FSM/history/pointer/target deps, and not conservative. When this is true,
    /// we can safely skip evaluation for pointer events.
    fn is_keyboard_exclusive(&self) -> bool {
        self.depends_on_keyboard
            && !self.depends_on_pointer
            && !self.depends_on_fsm
            && !self.depends_on_history
            && !self.depends_on_event_target
            && !self.is_conservative
    }

    /// True if this trigger depends exclusively on pointer state.
    ///
    /// Mirror of `is_keyboard_exclusive` for the pointer category.
    fn is_pointer_exclusive(&self) -> bool {
        self.depends_on_pointer
            && !self.depends_on_keyboard
            && !self.depends_on_fsm
            && !self.depends_on_history
            && !self.depends_on_event_target
            && !self.is_conservative
    }
}

// ============================================================
// PUBLIC ANALYSIS API
// ============================================================

/// Analyze a trigger query string and return its dependency profile.
///
/// Parses the query to an AST using the Formula Engine parser, then walks
/// the AST to find references to graph fields and event properties.
///
/// # Conservative Guarantee
///
/// On parse failure, returns `TriggerDeps::all()` — the trigger will be
/// evaluated for every event type. This guarantees zero false negatives:
/// we never skip a trigger that might match.
///
/// # Examples
///
/// ```rust,ignore
/// use interaction_engine::core::trigger_deps::analyze_trigger_deps;
///
/// let deps = analyze_trigger_deps("graph.keyboard.pressed_keys");
/// assert!(deps.depends_on_keyboard);
/// assert!(!deps.depends_on_pointer);
///
/// let deps = analyze_trigger_deps("INVALID QUERY {{{{");
/// assert!(deps.is_conservative); // parse failure → conservative
/// ```
pub fn analyze_trigger_deps(query: &str) -> TriggerDeps {
    let mut parser = Parser::new();
    match parser.parse(query) {
        Ok(ast) => {
            let mut deps = TriggerDeps::none();
            walk_ast(&ast, &mut deps);
            deps
        }
        Err(_) => TriggerDeps::all(),
    }
}

// ============================================================
// AST WALKING — RECURSIVE DESCENT
// ============================================================

/// Entry point: walk the root AstNode.
fn walk_ast(node: &AstNode, deps: &mut TriggerDeps) {
    match node {
        AstNode::Expression(expr) => walk_expression(expr, deps),
    }
}

/// Recursively walk an expression tree and accumulate dependency information.
///
/// For MemberAccess expressions, we first attempt to flatten the entire chain
/// into a dot-separated path using the canonical `flatten_member_chain` from
/// `formula_core::ast`. If flattening succeeds, we classify the path and do
/// NOT recurse further into the chain (it has been fully analyzed). If flattening
/// fails (e.g., IndexAccess in the middle of the chain), we recurse into child
/// expressions to find classifiable sub-chains.
fn walk_expression(expr: &Expression, deps: &mut TriggerDeps) {
    match expr {
        // ---- Member Access: the primary source of dependency information ----
        Expression::MemberAccess(access) => {
            // Try to flatten the full chain: graph.keyboard.pressed_keys
            //   → ("graph", ["keyboard", "pressed_keys"])
            if let Some((base, chain)) = flatten_member_chain(expr) {
                let path = build_dotted_path(&base, &chain);
                classify_path(&path, deps);
                // Chain fully analyzed — do NOT recurse (avoids re-visiting the
                // base Identifier which would incorrectly set is_conservative
                // for bare "graph" inside a classified chain).
            } else {
                // Chain contains non-trivial nodes (e.g., IndexAccess in the middle).
                // Recurse into the object to find classifiable sub-chains.
                walk_expression(&access.object, deps);
            }
        }

        // ---- Binary: recurse both sides, then check for event.type == "..." pattern ----
        Expression::Binary(binary) => {
            walk_expression(&binary.left, deps);
            walk_expression(&binary.right, deps);
            check_event_type_literal(binary, deps);
        }

        // ---- Function Call: walk all arguments exactly once ----
        Expression::FunctionCall(call) => {
            for arg in &call.args {
                walk_expression(arg, deps);
            }
        }

        // ---- Index Access: walk both the array expression and the index expression ----
        Expression::IndexAccess(access) => {
            walk_expression(&access.array, deps);
            walk_expression(&access.index, deps);
        }

        // ---- Unary: walk the inner expression ----
        Expression::Unary(unary) => {
            walk_expression(&unary.expr, deps);
        }

        // ---- Lambda: walk the body (parameters are local, body may reference graph/event) ----
        Expression::Lambda(lambda) => {
            walk_expression(&lambda.body, deps);
        }

        // ---- Bare Identifiers: conservative if graph/event accessed without member path ----
        Expression::Identifier(name) => {
            if name == "graph" || name == "event" {
                // Bare reference to the entire graph or event object — we cannot
                // know which fields will be accessed at runtime. Conservative.
                deps.is_conservative = true;
            }
        }

        // ---- Versioned Identifier: same conservative treatment as bare Identifier ----
        Expression::VersionedIdentifier { name, .. } => {
            if name == "graph" || name == "event" {
                deps.is_conservative = true;
            }
        }

        // ---- Literals: walk array/object contents for nested expressions ----
        Expression::Literal(lit) => {
            match lit {
                Literal::Array(items) => {
                    for item in items {
                        walk_expression(item, deps);
                    }
                }
                Literal::Object(props) => {
                    for (_, value) in props {
                        walk_expression(value, deps);
                    }
                }
                // Null, Boolean, Number, String — leaf nodes, no dependencies
                _ => {}
            }
        }
    }
}

// ============================================================
// PATH UTILITIES
// ============================================================

/// Build a dot-separated path from a base identifier and chain of properties.
///
/// # Examples
/// - ("graph", ["keyboard", "pressed_keys"]) → "graph.keyboard.pressed_keys"
/// - ("event", ["type"]) → "event.type"
/// - ("x", []) → "x"
fn build_dotted_path(base: &str, chain: &[String]) -> String {
    if chain.is_empty() {
        return base.to_string();
    }
    let mut path =
        String::with_capacity(base.len() + chain.iter().map(|s| s.len() + 1).sum::<usize>());
    path.push_str(base);
    for prop in chain {
        path.push('.');
        path.push_str(prop);
    }
    path
}

/// Classify a dot-separated path and set the appropriate dependency flags.
///
/// This is the core classification logic. Each path prefix maps to an event
/// category. Unrecognized paths under `graph.*` or `event.*` trigger
/// conservative mode to ensure zero false negatives.
///
/// # Path Classification Table
///
/// | Path Prefix                        | Flag Set              |
/// |------------------------------------|-----------------------|
/// | `graph.pointers`                   | `depends_on_pointer`  |
/// | `event.x`, `event.y`              | `depends_on_pointer`  |
/// | `graph.keyboard`                   | `depends_on_keyboard` |
/// | `event.key`, `event.code`         | `depends_on_keyboard` |
/// | `graph.fsm`                        | `depends_on_fsm`      |
/// | `graph.recent_events`              | `depends_on_history`  |
/// | `graph.rt_events`                  | `depends_on_history`  |
/// | `graph.event_history`              | `depends_on_history`  |
/// | `event.target`, `event.subtype`   | `depends_on_event_target` |
/// | `event.type`                       | (no flag — handled by `check_event_type_literal`) |
/// | `graph.meta`, `graph.device`, `graph.audio` | (no flag — event-type-agnostic state) |
/// | `graph.*` (unrecognized)           | `is_conservative`     |
/// | `event.*` (unrecognized)           | `is_conservative`     |
fn classify_path(path: &str, deps: &mut TriggerDeps) {
    deps.accessed_paths.insert(path.to_string());

    // ---- Pointer-related paths ----
    if path.starts_with("graph.pointers")
        || path.starts_with("event.x")
        || path.starts_with("event.y")
    {
        deps.depends_on_pointer = true;
        return;
    }

    // ---- Keyboard-related paths ----
    if path.starts_with("graph.keyboard")
        || path.starts_with("event.key")
        || path.starts_with("event.code")
    {
        deps.depends_on_keyboard = true;
        return;
    }

    // ---- FSM-related paths ----
    if path.starts_with("graph.fsm") {
        deps.depends_on_fsm = true;
        return;
    }

    // ---- History-related paths ----
    if path.starts_with("graph.recent_events")
        || path.starts_with("graph.rt_events")
        || path.starts_with("graph.event_history")
    {
        deps.depends_on_history = true;
        return;
    }

    // ---- Event target/subtype ----
    if path.starts_with("event.target") || path.starts_with("event.subtype") {
        deps.depends_on_event_target = true;
        return;
    }

    // ---- event.type: no flag here — handled by check_event_type_literal ----
    if path == "event.type" {
        return;
    }

    // ---- Known event-type-agnostic graph fields ----
    // These state fields (meta counters, device info, audio state) don't correspond
    // to a specific event type. Triggers depending only on these evaluate for all
    // events (has_no_deps() returns true since no category flag is set).
    if path.starts_with("graph.meta")
        || path.starts_with("graph.device")
        || path.starts_with("graph.audio")
    {
        return;
    }

    // ---- Unrecognized graph.* or event.* path → conservative ----
    // We don't know what this field is, so we can't rule out any event type.
    if path.starts_with("graph.") || path.starts_with("event.") {
        deps.is_conservative = true;
    }
    // Paths not starting with graph. or event. (e.g., local variables, constants)
    // are ignored — they don't contribute event-type dependencies.
}

// ============================================================
// EVENT TYPE LITERAL DETECTION
// ============================================================

/// Check for the pattern `event.type == "pointer"` or `event.type == "keyboard"`
/// in a binary expression.
///
/// This is a special case: the path `event.type` itself doesn't tell us the
/// dependency category, but when compared with `==` to a known string literal,
/// we can infer the exact event type the trigger expects.
///
/// Handles both operand orders:
/// - `event.type == "pointer"`
/// - `"pointer" == event.type`
fn check_event_type_literal(binary: &BinaryExpr, deps: &mut TriggerDeps) {
    // Only handle equality comparisons — inequality (!=) cannot narrow the type
    if binary.op != BinaryOp::Eq {
        return;
    }

    // Try both operand orders
    let type_value = extract_event_type_comparison(&binary.left, &binary.right)
        .or_else(|| extract_event_type_comparison(&binary.right, &binary.left));

    if let Some(value) = type_value {
        match value.as_str() {
            "pointer" | "touch" | "mouse" | "gaze" => {
                deps.depends_on_pointer = true;
            }
            "keyboard" | "key" => {
                deps.depends_on_keyboard = true;
            }
            // Sensor, voice, and state events — recognized but no pointer/keyboard flag.
            // Triggers checking for these won't match pointer or keyboard events.
            "sensor" | "motion" | "voice" | "state" => {}
            _ => {
                // Unrecognized event type string — conservative fallback
                deps.is_conservative = true;
            }
        }
    }
}

/// Helper: if `member_expr` flattens to `event.type` and `literal_expr` is a
/// string literal, return `Some(literal_value)`. Otherwise `None`.
fn extract_event_type_comparison(
    member_expr: &Expression,
    literal_expr: &Expression,
) -> Option<String> {
    if let Some((base, chain)) = flatten_member_chain(member_expr) {
        if base == "event" && chain.len() == 1 && chain[0] == "type" {
            if let Expression::Literal(Literal::String(value)) = literal_expr {
                return Some(value.clone());
            }
        }
    }
    None
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Test 1: Literal "true" has no dependencies ----
    #[test]
    fn literal_true_has_no_deps() {
        let deps = analyze_trigger_deps("true");
        assert!(
            !deps.depends_on_pointer,
            "true should not depend on pointer"
        );
        assert!(
            !deps.depends_on_keyboard,
            "true should not depend on keyboard"
        );
        assert!(!deps.depends_on_fsm, "true should not depend on fsm");
        assert!(
            !deps.depends_on_history,
            "true should not depend on history"
        );
        assert!(
            !deps.depends_on_event_target,
            "true should not depend on event_target"
        );
        assert!(!deps.is_conservative, "true should not be conservative");
        assert!(deps.has_no_deps(), "true should have no deps");
    }

    // ---- Test 2: Literal "false" has no dependencies ----
    #[test]
    fn literal_false_has_no_deps() {
        let deps = analyze_trigger_deps("false");
        assert!(!deps.depends_on_pointer);
        assert!(!deps.depends_on_keyboard);
        assert!(!deps.is_conservative);
        assert!(deps.has_no_deps());
    }

    // ---- Test 3: graph.pointers with index access sets pointer dependency ----
    #[test]
    fn graph_pointers_index_access_sets_pointer() {
        let deps = analyze_trigger_deps(r#"graph.pointers["1"].distance_traveled < 10"#);
        assert!(
            deps.depends_on_pointer,
            "graph.pointers should set pointer dep"
        );
        assert!(!deps.depends_on_keyboard, "should not set keyboard");
        assert!(!deps.depends_on_fsm, "should not set fsm");
        assert!(!deps.is_conservative, "should not be conservative");
        assert!(
            deps.accessed_paths.contains("graph.pointers"),
            "should track graph.pointers path"
        );
    }

    // ---- Test 4: event.type == "keyboard" && event.key sets keyboard ----
    #[test]
    fn event_type_keyboard_and_key_sets_keyboard() {
        let deps = analyze_trigger_deps(r#"event.type == "keyboard" && event.key == "e""#);
        assert!(deps.depends_on_keyboard, "should depend on keyboard");
        assert!(!deps.depends_on_pointer, "should not depend on pointer");
        assert!(!deps.is_conservative);
    }

    // ---- Test 5: event.type == "pointer" && event.subtype sets pointer + event_target ----
    #[test]
    fn event_type_pointer_and_subtype_sets_pointer_and_target() {
        let deps = analyze_trigger_deps(r#"event.type == "pointer" && event.subtype == "click""#);
        assert!(
            deps.depends_on_pointer,
            "should depend on pointer via event.type == pointer"
        );
        assert!(
            deps.depends_on_event_target,
            "event.subtype should set event_target"
        );
        assert!(!deps.depends_on_keyboard);
    }

    // ---- Test 6: LOOKUP(graph.fsm, ...) sets FSM dependency ----
    #[test]
    fn lookup_graph_fsm_sets_fsm() {
        let deps = analyze_trigger_deps(r#"LOOKUP(graph.fsm, "fsm:editor:mode") == "edit""#);
        assert!(
            deps.depends_on_fsm,
            "LOOKUP(graph.fsm, ...) should set fsm dep"
        );
        assert!(!deps.depends_on_pointer);
        assert!(!deps.depends_on_keyboard);
    }

    // ---- Test 7: INCLUDES(graph.keyboard.pressed_keys, ...) sets keyboard ----
    #[test]
    fn includes_keyboard_pressed_keys_sets_keyboard() {
        let deps = analyze_trigger_deps(r#"INCLUDES(graph.keyboard.pressed_keys, "Control")"#);
        assert!(
            deps.depends_on_keyboard,
            "graph.keyboard.pressed_keys should set keyboard"
        );
        assert!(!deps.depends_on_pointer);
        assert!(deps.accessed_paths.contains("graph.keyboard.pressed_keys"));
    }

    // ---- Test 8: graph.recent_events[0].key sets history ----
    #[test]
    fn recent_events_index_sets_history() {
        let deps = analyze_trigger_deps(r#"graph.recent_events[0].key == "Control""#);
        assert!(
            deps.depends_on_history,
            "graph.recent_events should set history dep"
        );
        assert!(!deps.depends_on_pointer);
        assert!(!deps.depends_on_keyboard);
    }

    // ---- Test 9: Keyboard-only query does NOT set pointer ----
    #[test]
    fn keyboard_only_does_not_set_pointer() {
        let deps = analyze_trigger_deps(
            r#"event.key == "k" && INCLUDES(graph.keyboard.pressed_keys, "Meta")"#,
        );
        assert!(deps.depends_on_keyboard, "should depend on keyboard");
        assert!(!deps.depends_on_pointer, "should NOT depend on pointer");
        assert!(!deps.is_conservative);
    }

    // ---- Test 10: TriggerDeps::all() is fully conservative ----
    #[test]
    fn trigger_deps_all_is_conservative() {
        let deps = TriggerDeps::all();
        assert!(deps.is_conservative);
        assert!(deps.depends_on_pointer);
        assert!(deps.depends_on_keyboard);
        assert!(deps.depends_on_fsm);
        assert!(deps.depends_on_history);
        assert!(deps.depends_on_event_target);
        assert!(deps.matches_pointer_event());
        assert!(deps.matches_keyboard_event());
        assert!(deps.matches_fsm_event());
    }

    // ---- Test 11: Parse failure returns conservative ----
    #[test]
    fn parse_failure_returns_conservative() {
        let deps = analyze_trigger_deps("{{{{ INVALID SYNTAX }}}}");
        assert!(deps.is_conservative, "parse failure must be conservative");
        assert!(deps.matches_pointer_event());
        assert!(deps.matches_keyboard_event());
    }

    // ---- Test 12: Complex query with pointer AND keyboard sets both ----
    #[test]
    fn complex_pointer_and_keyboard_sets_both() {
        let deps = analyze_trigger_deps(
            r#"graph.pointers["1"].distance_traveled < 10 && INCLUDES(graph.keyboard.pressed_keys, "Shift")"#,
        );
        assert!(deps.depends_on_pointer, "should depend on pointer");
        assert!(deps.depends_on_keyboard, "should depend on keyboard");
        assert!(!deps.depends_on_fsm);
        assert!(!deps.is_conservative);
    }

    // ---- Test 13: matches_pointer_event false for keyboard-only ----
    #[test]
    fn matches_pointer_false_for_keyboard_only() {
        let deps = analyze_trigger_deps(r#"event.key == "Enter""#);
        assert!(
            !deps.matches_pointer_event(),
            "keyboard-only should not match pointer"
        );
        assert!(
            deps.matches_keyboard_event(),
            "keyboard-only should match keyboard"
        );
    }

    // ---- Test 14: matches_keyboard_event false for pointer-only ----
    #[test]
    fn matches_keyboard_false_for_pointer_only() {
        let deps = analyze_trigger_deps(r#"graph.pointers["1"].distance_traveled < 10"#);
        assert!(deps.depends_on_pointer);
        assert!(
            !deps.matches_keyboard_event(),
            "pointer-only should not match keyboard"
        );
        assert!(
            deps.matches_pointer_event(),
            "pointer-only should match pointer"
        );
    }

    // ---- Test 15: Bare "graph" identifier sets conservative ----
    #[test]
    fn bare_graph_identifier_is_conservative() {
        let deps = analyze_trigger_deps("graph");
        assert!(deps.is_conservative, "bare graph should be conservative");
    }

    // ---- Test 16: event.target sets event_target dependency ----
    #[test]
    fn event_target_sets_event_target_dep() {
        let deps = analyze_trigger_deps(r#"event.target == "button-1""#);
        assert!(
            deps.depends_on_event_target,
            "event.target should set event_target"
        );
        assert!(!deps.depends_on_pointer);
        assert!(!deps.depends_on_keyboard);
    }

    // ---- Test 17: graph.meta has no event-type dependencies ----
    #[test]
    fn graph_meta_has_no_event_type_deps() {
        let deps = analyze_trigger_deps("graph.meta.event_count > 3");
        assert!(!deps.depends_on_pointer);
        assert!(!deps.depends_on_keyboard);
        assert!(!deps.depends_on_fsm);
        assert!(!deps.depends_on_history);
        assert!(!deps.is_conservative);
        assert!(
            deps.has_no_deps(),
            "graph.meta should not bind to any event type"
        );
    }

    // ---- Test 18: FSM-only trigger evaluates for both pointer and keyboard events ----
    #[test]
    fn fsm_only_matches_all_event_types() {
        let deps = analyze_trigger_deps(r#"LOOKUP(graph.fsm, "mode") == "edit""#);
        assert!(deps.depends_on_fsm);
        // FSM state can change on any event — trigger must evaluate for both
        assert!(
            deps.matches_pointer_event(),
            "fsm-only should match pointer (FSM is event-type-agnostic)"
        );
        assert!(
            deps.matches_keyboard_event(),
            "fsm-only should match keyboard (FSM is event-type-agnostic)"
        );
        assert!(deps.matches_fsm_event());
    }

    // ---- Test 19: Numeric expression has no deps ----
    #[test]
    fn numeric_expression_has_no_deps() {
        let deps = analyze_trigger_deps("1 + 2 == 3");
        assert!(deps.has_no_deps());
        assert!(!deps.is_conservative);
    }

    // ---- Test 20: No-dep triggers evaluate for all events (conservative by absence) ----
    #[test]
    fn no_dep_triggers_evaluate_for_all_events() {
        let deps = analyze_trigger_deps("true");
        assert!(deps.has_no_deps());
        // A trigger with no deps matches all events because we can't rule anything out
        assert!(
            deps.matches_pointer_event(),
            "no-dep trigger should match pointer"
        );
        assert!(
            deps.matches_keyboard_event(),
            "no-dep trigger should match keyboard"
        );
    }

    // ---- Test 21: History-only trigger evaluates for all events ----
    #[test]
    fn history_only_matches_all_event_types() {
        let deps = analyze_trigger_deps(r#"graph.recent_events[0].key == "Control""#);
        assert!(deps.depends_on_history);
        // History tracks events of all types — must evaluate for both
        assert!(
            deps.matches_pointer_event(),
            "history-only should match pointer"
        );
        assert!(
            deps.matches_keyboard_event(),
            "history-only should match keyboard"
        );
    }

    // ---- Test 22: Reversed operand order event.type detection ----
    #[test]
    fn reversed_operand_event_type_detection() {
        let deps = analyze_trigger_deps(r#""keyboard" == event.type"#);
        assert!(
            deps.depends_on_keyboard,
            "reversed operand order should still detect keyboard"
        );
    }
}
