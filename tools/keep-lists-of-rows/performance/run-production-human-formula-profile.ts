import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  foldAddressedCellExpressions,
  type AddressedCellExpressionInputs,
  type AddressedCellValueRecord,
} from '@/packages/visual-database/do-work/cell-expression';
import {
  resolveAddressedCells,
  type AddressedCellInput,
} from '@/packages/visual-database/do-work/resolve-derived-fields';
import {
  decodeVisualDatabaseEvaluatorDescriptors,
  type VisualDatabaseEvaluatorDescriptor,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
} from '@/packages/visual-database/read-data/visual-database';
import {
  acceptExpressionOwnerReply,
  composeExpressionOwnerRequest,
  decodeExpressionOwnerReply,
  withExpressionOwnerTimeout,
} from '@/packages/visual-database/do-work/expression-owner-protocol';
import {
  buildExpressionReferenceCatalog,
  indexExpressionReferences,
} from '@/packages/visual-database/show/reference-catalog';
import type { HumanFormulaPerformanceProfile } from './run-human-formula-profile';

export interface ProductionPerformanceFixture {
  schema: 'visual-database.g12-production-performance-fixture/v1';
  seed: string;
  formula: {
    source_base: string;
    completion_source: string;
    variables: Readonly<Record<string, number>>;
  };
  record_board: {
    catalog_rows: number;
    catalog_columns: number;
    fold_cells: number;
    dependency_cells: number;
    cycle_depth: number;
    sparse_changed_cells: number;
  };
  thresholds_ms: Readonly<Record<string, number>>;
}

export interface NativeFormulaOperation {
  id: string;
  production_api: string;
  samples_ms: readonly number[];
  invocations_per_sample: number;
  observed: Readonly<Record<string, unknown>>;
}

export interface NativeFormulaPerformanceResult {
  schema: 'visual-database.formula-native-performance/v1';
  clock: 'std::time::Instant';
  fixture_schema: string;
  fixture_seed: string;
  source_utf16: number;
  warmups: number;
  runs: number;
  concurrent_analyses: number;
  operations: readonly NativeFormulaOperation[];
}

export interface PerformanceDistribution {
  samples: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface ProductionOperationEvidence {
  id: string;
  production_api: string;
  scenario: string;
  clock: 'node:perf_hooks.performance.now' | 'std::time::Instant';
  warmups: number;
  runs: number;
  invocations_per_sample: number;
  fixture_sha256: string;
  fixture_counts: Readonly<Record<string, number>>;
  samples_ms: readonly number[];
  distribution_ms: PerformanceDistribution;
  heap_samples_bytes?: readonly number[];
  heap_distribution_bytes?: PerformanceDistribution;
  threshold_p95_ms: number;
  pass: boolean;
  observed: Readonly<Record<string, unknown>>;
}

export interface ProductionPerformanceResult {
  schema: 'visual-database.g12-production-performance/v2';
  profile_revision: string;
  environment: Readonly<Record<string, unknown>>;
  fixture: {
    schema: string;
    seed: string;
    sha256: string;
    generated_sha256: Readonly<Record<string, string>>;
    declared_counts: Readonly<Record<string, number>>;
  };
  operations: readonly ProductionOperationEvidence[];
  metrics: readonly {
    id: string;
    operation_id: string;
    samples: number;
    p95: number;
    unit: 'ms' | 'count' | 'bytes';
    threshold: number;
    pass: boolean;
  }[];
  boundary_calls_by_revision: Readonly<Record<string, number>>;
  heap: {
    sampler: 'process.memoryUsage.heapUsed';
    operation_id: string;
    samples: number;
    min_delta_bytes: number;
    p95_delta_bytes: number;
    max_delta_bytes: number;
    threshold_bytes: number;
    pass: boolean;
  };
  scenarios_exercised: readonly string[];
  scenario_operations: Readonly<Record<string, readonly string[]>>;
  operation_counts: Readonly<Record<string, number>>;
  missing: readonly string[];
  failures: readonly string[];
  pass: boolean;
}

interface MeasuredOperation {
  id: string;
  productionApi: string;
  scenario: string;
  fixtureHash: string;
  fixtureCounts: Readonly<Record<string, number>>;
  threshold: number;
  measureHeap?: boolean;
  execute: () => void | Readonly<Record<string, unknown>> | Promise<void | Readonly<Record<string, unknown>>>;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function percentile(samples: readonly number[], ratio: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)]!;
}

export function summarizeRealSamples(samples: readonly number[]): PerformanceDistribution {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error('performance samples must be finite non-negative monotonic durations');
  }
  const sum = samples.reduce((total, sample) => total + sample, 0);
  return {
    samples: samples.length,
    min: Math.min(...samples),
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: Math.max(...samples),
    mean: sum / samples.length,
  };
}

async function measureProductionOperation(
  profile: HumanFormulaPerformanceProfile,
  operation: MeasuredOperation,
): Promise<ProductionOperationEvidence> {
  let observed: Readonly<Record<string, unknown>> = {};
  for (let index = 0; index < profile.warmups; index += 1) {
    observed = await operation.execute() ?? {};
  }
  const samples: number[] = [];
  const heapSamples: number[] = [];
  for (let index = 0; index < profile.runs; index += 1) {
    const heapBefore = operation.measureHeap ? process.memoryUsage().heapUsed : 0;
    const started = performance.now();
    observed = await operation.execute() ?? {};
    const elapsed = performance.now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error(`${operation.id} emitted an invalid duration`);
    samples.push(elapsed);
    if (operation.measureHeap) {
      heapSamples.push(Math.max(0, process.memoryUsage().heapUsed - heapBefore));
    }
  }
  const distribution = summarizeRealSamples(samples);
  const heapDistribution = heapSamples.length > 0 ? summarizeRealSamples(heapSamples) : undefined;
  return {
    id: operation.id,
    production_api: operation.productionApi,
    scenario: operation.scenario,
    clock: 'node:perf_hooks.performance.now',
    warmups: profile.warmups,
    runs: profile.runs,
    invocations_per_sample: 1,
    fixture_sha256: operation.fixtureHash,
    fixture_counts: operation.fixtureCounts,
    samples_ms: samples,
    distribution_ms: distribution,
    ...(heapDistribution
      ? { heap_samples_bytes: heapSamples, heap_distribution_bytes: heapDistribution }
      : {}),
    threshold_p95_ms: operation.threshold,
    pass: distribution.p95 <= operation.threshold,
    observed,
  };
}

function recordModel(rows: number, columns: number): VisualDatabaseModel {
  const fields: VisualDatabaseFieldDescriptor[] = Array.from({ length: columns }, (_, index) => ({
    id: `field-${index}`,
    label: `Field ${index + 1}`,
    role: 'value',
    paths: [['payload', `field_${index}`]],
    writePath: ['payload', `field_${index}`],
    shape: 'number',
    source: 'declared',
  }));
  const records: VisualDatabaseRecord[] = Array.from({ length: rows }, (_, rowIndex) => {
    const payload = Object.fromEntries(
      Array.from({ length: columns }, (_, columnIndex) => [`field_${columnIndex}`, rowIndex * columns + columnIndex]),
    );
    return {
      id: `record-${rowIndex}`,
      title: `Record ${rowIndex + 1}`,
      body: '',
      kind: 'fixture',
      group: '',
      lane: { id: '', label: '', order: 0 },
      date: null,
      sort: rowIndex,
      badges: [],
      links: [],
      raw: { address: `record-${rowIndex}`, payload },
    };
  });
  return {
    records,
    fields,
    views: [],
    actions: [],
    palette: [],
    gridProperties: [],
  };
}

function denseFoldFixture(count: number): {
  fields: readonly VisualDatabaseFieldDescriptor[];
  inputs: AddressedCellExpressionInputs;
} {
  const fields: readonly VisualDatabaseFieldDescriptor[] = [{
    id: 'value',
    label: 'Value',
    role: 'value',
    paths: [['payload', 'value']],
    shape: 'number',
    source: 'declared',
  }];
  const sources: AddressedCellValueRecord[] = [];
  const caches: AddressedCellValueRecord[] = [];
  const provenances: AddressedCellValueRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const cell_ref = { record_ref: `record-${index}`, field_ref: 'value' };
    const sourceRevision = `source-${index}`;
    sources.push({
      revision: sourceRevision,
      expectedCurrent: null,
      payload: { cell_ref, expression: { literal: index } },
    });
    caches.push({
      revision: `cache-${index}`,
      expectedCurrent: null,
      payload: {
        cell_ref,
        cached_value: {
          value: index,
          revision: `cache-${index}`,
          source_revision: sourceRevision,
          observed_at: '2026-07-26T00:00:00.000Z',
        },
      },
    });
    provenances.push({
      revision: `provenance-${index}`,
      expectedCurrent: null,
      payload: {
        cell_ref,
        provenance_ref: `formula-evaluation::evaluator%3A%3Aformula::slot%3A%3Aformula-engine::${sourceRevision}::3`,
        revision: `provenance-${index}`,
        source_revision: sourceRevision,
        evaluator_ref: 'evaluator::formula',
        evaluator_target: 'slot::formula-engine',
        evaluator_revision: '3',
        policy_revision: '1',
        reads: { variables: [], entities: [], specials: [], functions: [] },
        provenance_display_label: 'Formula',
      },
    });
  }
  return { fields, inputs: { sources, caches, provenances } };
}

function literalCell(index: number, cached = false): AddressedCellInput {
  return {
    cellRef: { recordRef: `record-${index}`, fieldRef: 'value' },
    expression: { literal: index },
    revision: `source-${index}`,
    ...(cached ? { cachedValue: { value: index, sourceRevision: `source-${index}` } } : {}),
  };
}

function deriveCell(index: number, dependencies: readonly number[]): AddressedCellInput {
  return {
    cellRef: { recordRef: `record-${index}`, fieldRef: 'value' },
    expression: {
      derive: {
        target: 'fixture::sum',
        dependencyRefs: dependencies.map((dependency) => ({
          recordRef: `record-${dependency}`,
          fieldRef: 'value',
          contextKey: `value_${dependency}`,
        })),
        resultPath: ['result'],
      },
    },
    revision: `source-${index}`,
  };
}

function graphFixtures(count: number, cycleDepth: number) {
  if (count < 2 || cycleDepth < 2 || cycleDepth > count) throw new Error('invalid graph fixture sizes');
  const sparse = Array.from({ length: count }, (_, index) => literalCell(index, true));
  const fanIn = [
    ...Array.from({ length: count - 1 }, (_, index) => literalCell(index, true)),
    deriveCell(count - 1, Array.from({ length: count - 1 }, (_, index) => index)),
  ];
  const fanOut = [
    literalCell(0),
    ...Array.from({ length: count - 1 }, (_, offset) => deriveCell(offset + 1, [0])),
  ];
  const cycle = Array.from({ length: cycleDepth }, (_, index) =>
    deriveCell(index, [(index + 1) % cycleDepth]));
  return { sparse, fanIn, fanOut, cycle };
}

function sumDispatch(_target: string, request: Record<string, unknown>): Promise<unknown> {
  const context = request.context && typeof request.context === 'object' && !Array.isArray(request.context)
    ? request.context as Record<string, unknown>
    : {};
  const result = Object.values(context).reduce(
    (total: number, value) => total + (typeof value === 'number' ? value : 0),
    0,
  );
  return Promise.resolve({ result });
}

function formulaDescriptor(packageDefinition: unknown): VisualDatabaseEvaluatorDescriptor {
  if (!packageDefinition || typeof packageDefinition !== 'object') throw new Error('package definition is missing');
  const things = (packageDefinition as { things?: unknown[] }).things;
  const row = Array.isArray(things)
    ? things.find((entry) => (
      !!entry
      && typeof entry === 'object'
      && (entry as { address?: unknown }).address === 'visual-database.evaluator-descriptors'
    ))
    : null;
  const payload = row && typeof row === 'object' ? (row as { payload?: unknown }).payload : null;
  const descriptors = decodeVisualDatabaseEvaluatorDescriptors(payload);
  const descriptor = descriptors.find((entry) => entry.ref === 'evaluator::formula' && entry.authoring);
  if (!descriptor?.authoring) throw new Error('production Formula evaluator descriptor is unavailable');
  return descriptor;
}

function ownerReply(
  operation: 'analyze' | 'evaluate',
  token: string,
): Record<string, unknown> {
  const common = {
    protocol_version: 1,
    operation,
    request_token: token,
    source_revision: 'source-1',
    catalog_revision: 'catalog-1',
    registry_revision: 'registry-1',
    policy_revision: 'policy-1',
    source: '=A1+B1',
    canonical_expression: '=A1 + B1',
    completion: null,
    static_dependencies: [],
    diagnostics: [],
    functions: [],
    legacy_projection: null,
  };
  return operation === 'evaluate'
    ? {
        ...common,
        evaluation: {
          result: 5,
          evaluation_readset: { variables: [], entities: [], specials: [], functions: [] },
        },
      }
    : { ...common, evaluation: null };
}

function ownerRoundTrip(descriptor: VisualDatabaseEvaluatorDescriptor) {
  const authoring = descriptor.authoring!;
  const state = {
    target: descriptor.target,
    descriptorRevision: descriptor.revision!,
    requestToken: 'request-1',
    sourceRevision: 'source-1',
    catalogRevision: 'catalog-1',
    registryRevision: 'registry-1',
    policyRevision: 'policy-1',
  };
  const common = {
    source: '=A1+B1',
    cursor_offset_utf16: 6,
    request_token: state.requestToken,
    source_revision: state.sourceRevision,
    catalog_revision: state.catalogRevision,
    registry_revision: state.registryRevision,
    expected_policy_revision: state.policyRevision,
  };
  const analyzeRequest = composeExpressionOwnerRequest(authoring, 'analyze', {
    ...common,
    variables: { A1: 2, B1: 3 },
  });
  const evaluateRequest = composeExpressionOwnerRequest(authoring, 'evaluate', {
    ...common,
    variables: { A1: 2, B1: 3 },
  });
  const analyze = decodeExpressionOwnerReply(authoring, 'analyze', ownerReply('analyze', state.requestToken));
  const evaluate = decodeExpressionOwnerReply(authoring, 'evaluate', ownerReply('evaluate', state.requestToken));
  const analyzeAccepted = acceptExpressionOwnerReply(state, {
    target: descriptor.target,
    descriptorRevision: descriptor.revision!,
    decoded: analyze,
  });
  const evaluateAccepted = acceptExpressionOwnerReply(state, {
    target: descriptor.target,
    descriptorRevision: descriptor.revision!,
    decoded: evaluate,
  });
  if (!analyzeAccepted.accepted || !evaluateAccepted.accepted) throw new Error('owner round trip was rejected');
  return {
    analyze_bytes: JSON.stringify(analyzeRequest).length,
    evaluate_bytes: JSON.stringify(evaluateRequest).length,
    boundary_calls: 2,
  };
}

function staleReplyDiscard(descriptor: VisualDatabaseEvaluatorDescriptor) {
  const decoded = decodeExpressionOwnerReply(
    descriptor.authoring!,
    'analyze',
    ownerReply('analyze', 'stale-request'),
  );
  const acceptance = acceptExpressionOwnerReply({
    target: descriptor.target,
    descriptorRevision: descriptor.revision!,
    requestToken: 'request-1',
    sourceRevision: 'source-1',
    catalogRevision: 'catalog-1',
    registryRevision: 'registry-1',
    policyRevision: 'policy-1',
  }, {
    target: descriptor.target,
    descriptorRevision: descriptor.revision!,
    decoded,
  });
  if (acceptance.accepted || acceptance.reason !== 'request_token') {
    throw new Error('stale owner reply was not rejected by request_token');
  }
  return { accepted: false, reason: acceptance.reason };
}

function nativeOperationEvidence(
  profile: HumanFormulaPerformanceProfile,
  fixture: ProductionPerformanceFixture,
  native: NativeFormulaPerformanceResult,
  fixtureHash: string,
): ProductionOperationEvidence[] {
  return native.operations.map((operation) => {
    const threshold = fixture.thresholds_ms[operation.id];
    if (!Number.isFinite(threshold)) throw new Error(`missing threshold for ${operation.id}`);
    if (operation.samples_ms.length !== profile.runs) {
      throw new Error(`${operation.id} produced ${operation.samples_ms.length} samples`);
    }
    const distribution = summarizeRealSamples(operation.samples_ms);
    return {
      id: operation.id,
      production_api: operation.production_api,
      scenario: operation.id === 'formula_concurrent_analyze' ? 'concurrent' : 'formula',
      clock: 'std::time::Instant',
      warmups: profile.warmups,
      runs: profile.runs,
      invocations_per_sample: operation.invocations_per_sample,
      fixture_sha256: fixtureHash,
      fixture_counts: {
        source_characters: profile.source_characters,
        concurrent_analyses: operation.id === 'formula_concurrent_analyze'
          ? profile.concurrent_analyses
          : 1,
      },
      samples_ms: operation.samples_ms,
      distribution_ms: distribution,
      threshold_p95_ms: threshold,
      pass: distribution.p95 <= threshold,
      observed: operation.observed,
    };
  });
}

export async function runProductionHumanFormulaProfile(input: {
  profile: HumanFormulaPerformanceProfile;
  fixture: ProductionPerformanceFixture;
  fixtureSha256: string;
  native: NativeFormulaPerformanceResult;
  packageDefinition: unknown;
  environment: Readonly<Record<string, unknown>>;
}): Promise<ProductionPerformanceResult> {
  const { profile, fixture, native } = input;
  if (fixture.schema !== 'visual-database.g12-production-performance-fixture/v1') {
    throw new Error('unexpected production performance fixture schema');
  }
  if (native.clock !== 'std::time::Instant'
    || native.fixture_seed !== fixture.seed
    || native.source_utf16 !== profile.source_characters
    || native.warmups !== profile.warmups
    || native.runs !== profile.runs
    || native.concurrent_analyses !== profile.concurrent_analyses) {
    throw new Error('native Formula result does not match the declared fixture/profile');
  }
  const declared = fixture.record_board;
  if (declared.catalog_rows !== profile.visible_rows
    || declared.catalog_rows * declared.catalog_columns !== profile.catalog_items
    || declared.fold_cells !== profile.dependency_cells
    || declared.dependency_cells !== profile.dependency_cells
    || declared.cycle_depth !== profile.cycle_depth) {
    throw new Error('fixture sizes do not match the production performance profile');
  }

  const model = recordModel(declared.catalog_rows, declared.catalog_columns);
  const dense = denseFoldFixture(declared.fold_cells);
  const graphs = graphFixtures(declared.dependency_cells, declared.cycle_depth);
  const descriptor = formulaDescriptor(input.packageDefinition);
  const generatedHashes = {
    catalog_model: sha256Json(model),
    dense_fold: sha256Json(dense),
    sparse_graph: sha256Json(graphs.sparse),
    fan_in_graph: sha256Json(graphs.fanIn),
    fan_out_graph: sha256Json(graphs.fanOut),
    cycle_graph: sha256Json(graphs.cycle),
    formula_descriptor: sha256Json(descriptor),
  };
  const emptyFixtureHash = sha256Json({ fields: [], sources: [], caches: [], provenances: [] });
  let fanInDispatches = 0;
  let fanOutDispatches = 0;

  const measured: MeasuredOperation[] = [
    {
      id: 'record_board_fold_empty',
      productionApi: 'foldAddressedCellExpressions',
      scenario: 'empty',
      fixtureHash: emptyFixtureHash,
      fixtureCounts: { cells: 0 },
      threshold: fixture.thresholds_ms.record_board_fold_empty!,
      execute: () => {
        const folded = foldAddressedCellExpressions([], { sources: [], caches: [], provenances: [] });
        if (folded.length !== 0) throw new Error('empty fold produced cells');
        return { folded_cells: folded.length };
      },
    },
    {
      id: 'record_board_reference_catalog',
      productionApi: 'buildExpressionReferenceCatalog + indexExpressionReferences',
      scenario: 'dense',
      fixtureHash: generatedHashes.catalog_model,
      fixtureCounts: { rows: declared.catalog_rows, columns: declared.catalog_columns, items: profile.catalog_items },
      threshold: fixture.thresholds_ms.record_board_reference_catalog!,
      execute: () => {
        const catalog = buildExpressionReferenceCatalog(model, { currentRecordRef: 'record-0' });
        const index = indexExpressionReferences(catalog.candidates);
        if (catalog.candidates.length !== profile.catalog_items || index.size !== profile.catalog_items) {
          throw new Error('reference catalog cardinality drifted');
        }
        return { candidates: catalog.candidates.length, indexed_aliases: index.size };
      },
    },
    {
      id: 'record_board_fold_dense',
      productionApi: 'foldAddressedCellExpressions',
      scenario: 'dense',
      fixtureHash: generatedHashes.dense_fold,
      fixtureCounts: { cells: declared.fold_cells, addressed_values: declared.fold_cells * 3 },
      threshold: fixture.thresholds_ms.record_board_fold_dense!,
      execute: () => {
        const folded = foldAddressedCellExpressions(dense.fields, dense.inputs);
        const current = folded.filter((cell) => cell.projectionState === 'current').length;
        if (folded.length !== declared.fold_cells || current !== declared.fold_cells) {
          throw new Error('dense fold did not preserve every current projection');
        }
        return { folded_cells: folded.length, current_projections: current };
      },
    },
    {
      id: 'record_board_recompute_sparse',
      productionApi: 'resolveAddressedCells/dirtyAddressedCells',
      scenario: 'sparse',
      fixtureHash: generatedHashes.sparse_graph,
      fixtureCounts: { cells: declared.dependency_cells, changed_cells: declared.sparse_changed_cells },
      threshold: fixture.thresholds_ms.record_board_recompute_sparse!,
      execute: async () => {
        const resolution = await resolveAddressedCells(
          graphs.sparse,
          sumDispatch,
          [graphs.sparse[0]!.cellRef],
        );
        if (resolution.dirtyRefs.length !== declared.sparse_changed_cells) {
          throw new Error('sparse dirty closure cardinality drifted');
        }
        return { dirty_cells: resolution.dirtyRefs.length, resolved_cells: resolution.cells.size };
      },
    },
    {
      id: 'record_board_recompute_fan_in',
      productionApi: 'resolveAddressedCells/dirtyAddressedCells',
      scenario: 'fan-in',
      fixtureHash: generatedHashes.fan_in_graph,
      fixtureCounts: { cells: declared.dependency_cells, dependency_edges: declared.dependency_cells - 1 },
      threshold: fixture.thresholds_ms.record_board_recompute_fan_in!,
      execute: async () => {
        fanInDispatches = 0;
        const root = graphs.fanIn[graphs.fanIn.length - 1]!;
        const resolution = await resolveAddressedCells(
          graphs.fanIn,
          async (target, request) => {
            fanInDispatches += 1;
            return sumDispatch(target, request);
          },
          [root.cellRef],
        );
        if (fanInDispatches !== 1 || resolution.dirtyRefs.length !== 1) {
          throw new Error('fan-in recompute did not collapse to one evaluator boundary');
        }
        return { dirty_cells: resolution.dirtyRefs.length, evaluator_dispatches: fanInDispatches };
      },
    },
    {
      id: 'record_board_recompute_fan_out',
      productionApi: 'resolveAddressedCells/dirtyAddressedCells',
      scenario: 'fan-out',
      fixtureHash: generatedHashes.fan_out_graph,
      fixtureCounts: { cells: declared.dependency_cells, dependency_edges: declared.dependency_cells - 1 },
      threshold: fixture.thresholds_ms.record_board_recompute_fan_out!,
      execute: async () => {
        fanOutDispatches = 0;
        const resolution = await resolveAddressedCells(
          graphs.fanOut,
          async (target, request) => {
            fanOutDispatches += 1;
            return sumDispatch(target, request);
          },
          [graphs.fanOut[0]!.cellRef],
        );
        if (fanOutDispatches !== declared.dependency_cells - 1
          || resolution.dirtyRefs.length !== declared.dependency_cells) {
          throw new Error('fan-out recompute did not execute the complete dirty closure');
        }
        return { dirty_cells: resolution.dirtyRefs.length, evaluator_dispatches: fanOutDispatches };
      },
    },
    {
      id: 'record_board_cycle_1000',
      productionApi: 'resolveAddressedCells',
      scenario: 'long-cycle',
      fixtureHash: generatedHashes.cycle_graph,
      fixtureCounts: { cells: declared.cycle_depth, cycle_depth: declared.cycle_depth },
      threshold: fixture.thresholds_ms.record_board_cycle_1000!,
      execute: async () => {
        const resolution = await resolveAddressedCells(graphs.cycle, sumDispatch);
        const cycles = [...resolution.cells.values()].filter((cell) => cell.error?.code === 'cycle').length;
        if (cycles !== declared.cycle_depth) throw new Error('cycle resolver did not mark every cycle member');
        return { cycle_members: cycles, dirty_cells: resolution.dirtyRefs.length };
      },
    },
    {
      id: 'record_board_owner_round_trip',
      productionApi: 'composeExpressionOwnerRequest + decodeExpressionOwnerReply + acceptExpressionOwnerReply',
      scenario: 'owner-round-trip',
      fixtureHash: generatedHashes.formula_descriptor,
      fixtureCounts: { requests_per_committed_revision: 2 },
      threshold: fixture.thresholds_ms.record_board_owner_round_trip!,
      measureHeap: true,
      execute: () => ownerRoundTrip(descriptor),
    },
    {
      id: 'record_board_owner_timeout',
      productionApi: 'withExpressionOwnerTimeout',
      scenario: 'timeout',
      fixtureHash: generatedHashes.formula_descriptor,
      fixtureCounts: { timeout_ms: 1 },
      threshold: fixture.thresholds_ms.record_board_owner_timeout!,
      execute: async () => {
        try {
          await withExpressionOwnerTimeout(new Promise<never>(() => {}), 1);
          throw new Error('owner timeout unexpectedly resolved');
        } catch (failure) {
          if (!(failure instanceof Error) || !failure.message.includes('did not reply')) throw failure;
          return { terminal: 'timed_out' };
        }
      },
    },
    {
      id: 'record_board_stale_reply_discard',
      productionApi: 'decodeExpressionOwnerReply + acceptExpressionOwnerReply',
      scenario: 'stale-reply',
      fixtureHash: generatedHashes.formula_descriptor,
      fixtureCounts: { guard_fields: 7 },
      threshold: fixture.thresholds_ms.record_board_stale_reply_discard!,
      execute: () => staleReplyDiscard(descriptor),
    },
  ];

  // Run suites serially so one operation's distribution cannot be inflated by
  // a different fixture's scheduler/GC pressure. Concurrency is measured only
  // by the explicit 32-worker Formula scenario.
  const measuredEvidence: ProductionOperationEvidence[] = [];
  for (const operation of measured) {
    measuredEvidence.push(await measureProductionOperation(profile, operation));
  }
  const operations = [
    ...nativeOperationEvidence(profile, fixture, native, input.fixtureSha256),
    ...measuredEvidence,
  ];
  const editorHeap = operations
    .find((operation) => operation.id === 'record_board_owner_round_trip')
    ?.heap_distribution_bytes;
  if (!editorHeap) throw new Error('owner round trip emitted no heap samples');
  const heapDelta = editorHeap.p95;
  const heapPass = heapDelta <= profile.thresholds.max_editor_heap_delta_bytes;
  const boundaryCalls = { 'source-1': 2 };
  const operationById = new Map(operations.map((operation) => [operation.id, operation]));
  const metricBindings = [
    ['native_analyze', 'formula_analyze', profile.thresholds.native_analyze_p95_ms],
    ['composer_filter', 'formula_completion', profile.thresholds.composer_filter_p95_ms],
    ['owner_round_trip', 'record_board_owner_round_trip', profile.thresholds.owner_round_trip_p95_ms],
    ['stale_reply_discard', 'record_board_stale_reply_discard', profile.thresholds.stale_reply_discard_p95_ms],
    ['dense_edit_frame', 'record_board_fold_dense', profile.thresholds.dense_edit_frame_p95_ms],
  ] as const;
  const metrics: ProductionPerformanceResult['metrics'][number][] = metricBindings.map(([id, operationId, threshold]) => {
    const operation = operationById.get(operationId);
    if (!operation) throw new Error(`missing metric operation ${operationId}`);
    return {
      id,
      operation_id: operationId,
      samples: operation.distribution_ms.samples,
      p95: operation.distribution_ms.p95,
      unit: 'ms',
      threshold,
      pass: operation.distribution_ms.p95 <= threshold,
    };
  });
  metrics.push({
    id: 'boundary_calls_per_committed_revision',
    operation_id: 'record_board_owner_round_trip',
    samples: Object.keys(boundaryCalls).length,
    p95: Math.max(...Object.values(boundaryCalls)),
    unit: 'count',
    threshold: profile.thresholds.max_boundary_calls_per_committed_revision,
    pass: Math.max(...Object.values(boundaryCalls)) <= profile.thresholds.max_boundary_calls_per_committed_revision,
  });
  metrics.push({
    id: 'editor_heap_delta',
    operation_id: 'record_board_owner_round_trip',
    samples: 1,
    p95: heapDelta,
    unit: 'bytes',
    threshold: profile.thresholds.max_editor_heap_delta_bytes,
    pass: heapPass,
  });

  const scenarioOperations: Record<string, readonly string[]> = {
    empty: ['record_board_fold_empty'],
    dense: ['record_board_reference_catalog', 'record_board_fold_dense'],
    'fan-in': ['record_board_recompute_fan_in'],
    'fan-out': ['record_board_recompute_fan_out'],
    'long-cycle': ['record_board_cycle_1000'],
    concurrent: ['formula_concurrent_analyze'],
    timeout: ['record_board_owner_timeout'],
    'stale-reply': ['record_board_stale_reply_discard'],
  };
  const scenarios = [...new Set(profile.scenarios)];
  const missing = [
    ...scenarios.filter((scenario) => !scenarioOperations[scenario]?.length).map((scenario) => `scenario:${scenario}`),
    ...Object.entries(scenarioOperations)
      .flatMap(([scenario, ids]) => ids.filter((id) => !operationById.has(id)).map((id) => `scenario-operation:${scenario}:${id}`)),
  ];
  const failures = [
    ...operations.filter((operation) => !operation.pass).map((operation) => `operation:${operation.id}`),
    ...metrics.filter((metric) => !metric.pass).map((metric) => `metric:${metric.id}`),
  ];
  const operationCounts = Object.fromEntries(operations.map((operation) => [
    operation.id,
    operation.runs * operation.invocations_per_sample,
  ]));
  return {
    schema: 'visual-database.g12-production-performance/v2',
    profile_revision: profile.profile_revision,
    environment: input.environment,
    fixture: {
      schema: fixture.schema,
      seed: fixture.seed,
      sha256: input.fixtureSha256,
      generated_sha256: generatedHashes,
      declared_counts: {
        source_characters: profile.source_characters,
        catalog_items: profile.catalog_items,
        visible_rows: profile.visible_rows,
        dependency_cells: profile.dependency_cells,
        cycle_depth: profile.cycle_depth,
        concurrent_analyses: profile.concurrent_analyses,
      },
    },
    operations,
    metrics,
    boundary_calls_by_revision: boundaryCalls,
    heap: {
      sampler: 'process.memoryUsage.heapUsed',
      operation_id: 'record_board_owner_round_trip',
      samples: editorHeap.samples,
      min_delta_bytes: editorHeap.min,
      p95_delta_bytes: editorHeap.p95,
      max_delta_bytes: editorHeap.max,
      threshold_bytes: profile.thresholds.max_editor_heap_delta_bytes,
      pass: heapPass,
    },
    scenarios_exercised: scenarios,
    scenario_operations: scenarioOperations,
    operation_counts: operationCounts,
    missing,
    failures,
    pass: missing.length === 0 && failures.length === 0,
  };
}
