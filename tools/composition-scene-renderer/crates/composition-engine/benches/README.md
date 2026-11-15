# benches/

Native criterion benchmarks enforcing sub-millisecond composition targets for the composition engine's incremental rendering pipeline (Task 167 Phases A-E).

## Files

| File | Purpose |
|------|---------|
| `incremental_perf.rs` | 22+ criterion benchmarks across 7 groups: render-only, full-cycle, baseline, scaling, IRPA gates, delta boundary, and perf gates |

## Key Functions

| Function | Signature | Role |
|----------|-----------|------|
| `make_plain_tree(n)` | `fn(usize) -> SceneNode` | Build flat N-node tree (root → N Text children), no bindings |
| `make_tree_with_fsm_bindings(n, n_fsm)` | `fn(usize, usize) -> SceneNode` | Build N-node tree with n_fsm FSM-dependent visibility bindings |
| `make_tree_with_routing_bindings(n, n_routing)` | `fn(usize, usize) -> SceneNode` | Build N-node tree with n_routing routing-dependent visibility bindings |
| `make_new_leaf_node(id)` | `fn(&str) -> SceneNode` | Single leaf node for InsertNode benchmarks |
| `make_subtree(id, n_children)` | `fn(&str, usize) -> SceneNode` | Container with N children for deep-insert benchmarks |
| `init_kernel_with_render(root)` | `fn(SceneNode) -> Kernel` | Init kernel, run initial render to populate all caches |
| `init_kernel_with_fsm(root)` | `fn(SceneNode) -> Kernel` | Init kernel with FSM config + initial render |
| `bench_render_only_fsm` | `(c: &mut Criterion)` | Measure set_fsm_state + render (single-pass path) |
| `bench_render_only_insert` | `(c: &mut Criterion)` | Measure InsertNode patch + render (incremental compute) |
| `bench_render_only_property_change` | `(c: &mut Criterion)` | Measure property mutation + render |
| `bench_render_only_ambient` | `(c: &mut Criterion)` | Measure set_ambient + render (ambient-dirty path) |
| `bench_render_only_deep_subtree` | `(c: &mut Criterion)` | Measure deep subtree insert + render |
| `bench_full_cycle_fsm_dispatch` | `(c: &mut Criterion)` | Measure dispatch_fsm_event + render (recompute + O(1) fast path) |
| `bench_full_cycle_routing_change` | `(c: &mut Criterion)` | Measure set_route + render (recompute + O(1) fast path) |
| `bench_render_noop_clean` | `(c: &mut Criterion)` | Baseline: render() on clean kernel (O(1) snapshot creation) |
| `bench_initial_render_cold` | `(c: &mut Criterion)` | Baseline: cold-start render on 100-node tree |
| `bench_insert_scaling` | `(c: &mut Criterion)` | Scaling: insert N nodes (50, 100, 200) + render |
| `bench_render_only_fsm_scaling` | `(c: &mut Criterion)` | Scaling: FSM toggle on N-node trees (50, 100, 200) |
| `bench_full_cycle_fsm_scaling` | `(c: &mut Criterion)` | Scaling: FSM dispatch on N-node trees (50, 100, 200) |
| `bench_scale_invariance_insert` | `(c: &mut Criterion)` | IRPA: Insert + render at 50/100/200/500/1000 nodes (scale-invariance proof) |
| `bench_noop_scaling` | `(c: &mut Criterion)` | IRPA: Clean render at 50/100/200/500/1000 nodes (near-constant proof) |
| `bench_scale_invariance_property` | `(c: &mut Criterion)` | IRPA: Property change + render at 50/100/200/500/1000 nodes (O(dirty) proof) |
| `bench_delta_overhead_property_change` | `(c: &mut Criterion)` | Delta: render() vs render_with_delta() overhead comparison |
| `bench_delta_serialization_vs_full` | `(c: &mut Criterion)` | Delta: Full snapshot vs Delta serde_json serialization cost |
| `bench_delta_boundary_scaling` | `(c: &mut Criterion)` | Delta: render_with_delta + serialize at 50/100/200/500/1000 nodes |
| `bench_delta_noop_scaling` | `(c: &mut Criterion)` | Delta: Clean-frame render_with_delta at 50/100/200/500/1000 nodes |

## Benchmark Groups

| Group | Benchmarks | Sample Size | What It Measures |
|-------|-----------|-------------|------------------|
| `render_only_benchmarks` | 5 | 50 | Single-pass render cost after dirty-only mutations |
| `full_cycle_benchmarks` | 2 | 50 | Recompute-triggering mutation + O(1) render |
| `baseline_benchmarks` | 2 | 50 | Noop render and cold-start baselines |
| `scaling_benchmarks` | 3 | 30 | Scaling behavior across tree sizes |
| `irpa_gate_benchmarks` | 3 | 20 | Task 168 scale-invariance proofs (insert, noop, property at 50-1000 nodes) |
| `delta_boundary_benchmarks` | 4 | 20 | Task 169 delta publication boundary: overhead, serialization, scaling, noop |
| `perf_gates` | 1 | 10 | Machine-readable perf gate summary |

## Perf Gate Targets (Release Mode)

| Gate | Target | What It Measures |
|------|--------|------------------|
| `recompute_p95` | <= 1ms | render() for single dirty node on 100-node tree |
| `time_to_snapshot_state_update_p95` | <= 1ms | Action dispatch to SceneSnapshot (full cycle) |
| `render_noop_baseline` | <= 0.5ms | O(1) snapshot creation on clean kernel |
| `delta_overhead` | <= 10% | render_with_delta() vs render() marginal cost |
| `delta_noop_scaling 50vs1000` | <= 2x | Clean-frame render_with_delta near-constant |
| `delta_boundary_scaling 50vs1000` | <= 5x | Total delta pipeline sub-linear scaling |

## Running

```bash
cargo bench --bench incremental_perf -p composition-engine
```

## Dependencies

**Depends on:** `composition-engine` (kernel, types, snapshot_delta), `criterion`, `serde_json`, `std::sync::Arc`

**Depended on by:** CI perf gate enforcement (build fails on regression)
