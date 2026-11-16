# src/

Source modules for the formula-engine crate — AST, parsing, evaluation, dependency analysis, reactive registry, and hypergraph solver.

## Files

| File | Purpose |
|------|---------|
| `lib.rs` | Crate root — module declarations and public re-exports |
| `ast.rs` | AST node types (Expression, Literal, BinaryOp, etc.), validation, traversal utilities |
| `compat.rs` | Compatibility layer and format migration helpers |
| `compiler.rs` | AST → Manifold compilation with caching and optimization |
| `context.rs` | EvaluationContext, ReadSet (dependency tracking), SecurityContext, ScopeContext |
| `deps.rs` | DependencyGraph, DependencyKey, cycle detection, ReactiveHooks trait, `run_recompute_with_hooks()` |
| `evaluator.rs` | Tree-walking interpreter: `evaluate_ast()`, `evaluate_ast_with_readset()`, ReadSet tracking during evaluation |
| `functions.rs` | Built-in function registry and dynamic dispatch (TEXT, SUM, IF, etc.) |
| `hypergraph.rs` | Manifold hypergraph data structure (Node, Hyperedge, constraints) |
| `lexer.rs` | Tokenizer for formula expressions (numbers, strings, operators, identifiers) |
| `parser.rs` | Recursive descent parser — token stream → AST with error recovery |
| `registry.rs` | FormulaRegistry — persists formula ReadSets, builds DependencyGraph on demand, computes recomputation plans |
| `rules.rs` | Rewrite rule system entry point and rule trait definitions |
| `sandbox.rs` | WASM-based secure execution sandbox via wasmtime (native only, `sandbox` feature) |
| `solver.rs` | Hypergraph solver — iteratively applies rewrite rules until graph is fully resolved |
| `types.rs` | Value type system with strict typing, null propagation, type coercion |
| `verifier.rs` | Correctness and performance verification gates (native only, `sandbox` feature) |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `Evaluator` | `new(context) / evaluate_ast(ast) / evaluate_ast_with_readset(ast)` | Tree-walking interpreter, evaluates AST nodes to typed Values |
| `EvaluationContext` | `new() / set_variable(name, value) / get_readset_snapshot() / clear_readset()` | Evaluation environment: variables, scope, ReadSet, security |
| `ReadSet` | `get_variables() / get_entity_references() / get_special_references() / get_function_calls()` | Tracks all data dependencies discovered during evaluation |
| `FormulaRegistry` | `new() / record_readset(id, rs) / remove_formula(id) / dependency_graph() / recomputation_plan(keys)` | Persists formula ReadSets, lazy-cached DependencyGraph, reactive re-evaluation planning |
| `DependencyGraph` | `build(readsets, producers) / recomputation_plan(keys) / affected_formulas_from_keys(keys) / topological_order()` | Formula-to-formula dependency relationships with topological ordering |
| `DependencyKey` | `Var(String) / Entity(String) / Special(String) / Func(String)` | Normalized dependency key for stable ordering and comparison |
| `ChangeSet` | `from_entries(Vec<DependencyChange>) / push(change) / len()` | Caller-provided dependency-key changes for reactive recomputation |
| `DependencyChange` | `new(key, op) / variable(name, op) / entity(ref, op) / special(name, op)` | One already-normalized dependency-key change; contains no caller storage vocabulary |
| `ReactiveHooks` | `on_keys_invalidated(keys) / on_recomputation_scheduled(plan) / on_formula_recompute_start(id) / on_formula_recompute_end(id, ok)` | Trait for observing reactive re-evaluation lifecycle |
| `Value` | `number(f64) / string(&str) / boolean(bool) / null() / array(vec) / from(json)` | Universal typed value with SQL-style null propagation |
| `AstNode` | `Expression(Expression)` | Root AST node wrapping an Expression |
| `Expression` | `Literal / Identifier / Binary / Unary / FunctionCall / MemberAccess / IndexAccess / Lambda / VersionedIdentifier` | All formula expression variants |
| `FunctionRegistry` | `new() / lookup(name) / register(name, func)` | Built-in function registry for dynamic dispatch |
| `Manifold` | `new() / add_node(node) / add_edge(edge) / get_node(id)` | Hypergraph data structure for compiled formula plans |

## Dependencies

**Depends on:** `ops-core` (pure operator implementations), `serde`, `serde_json`, `chrono`, `chrono-tz`, `regex`, `rust_decimal`, `sha2`, `blake3`, `wasmtime` (optional, native-only)

**Depended on by:** any package that needs formula parsing, evaluation, dependency tracking, or reactive recomputation.

## Boundary

Formula-core accepts generic evaluation scope data and normalized dependency keys. It does not translate caller records, graph records, package records, or any caller-specific event into formula dependencies; callers perform that translation outside this crate.
