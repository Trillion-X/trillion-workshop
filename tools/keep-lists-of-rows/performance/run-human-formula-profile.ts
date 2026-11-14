export interface HumanFormulaPerformanceProfile {
  profile_revision: string;
  source_characters: number;
  catalog_items: number;
  visible_rows: number;
  dependency_cells: number;
  cycle_depth: number;
  concurrent_analyses: number;
  warmups: number;
  runs: number;
  percentile: 'nearest-rank';
  adapters: readonly string[];
  scenarios: readonly string[];
  thresholds: {
    native_analyze_p95_ms: number;
    composer_filter_p95_ms: number;
    owner_round_trip_p95_ms: number;
    stale_reply_discard_p95_ms: number;
    dense_edit_frame_p95_ms: number;
    max_boundary_calls_per_committed_revision: number;
    max_editor_heap_delta_bytes: number;
  };
}

export interface PerformanceClock {
  now(): number;
}

export interface HeapSampler {
  bytes(): number;
}

export interface HumanFormulaPerformanceAdapters {
  clock: PerformanceClock;
  heap: HeapSampler;
  nativeAnalyze: (scenario: string, profile: HumanFormulaPerformanceProfile) => void | Promise<void>;
  filterCatalog: (scenario: string, profile: HumanFormulaPerformanceProfile) => void | Promise<void>;
  ownerRoundTrip: (scenario: string, profile: HumanFormulaPerformanceProfile) => void | Promise<void>;
  discardStaleReply: (scenario: string, profile: HumanFormulaPerformanceProfile) => void | Promise<void>;
  renderDenseEdit: (scenario: string, profile: HumanFormulaPerformanceProfile) => void | Promise<void>;
  boundaryCallsByRevision: () => Readonly<Record<string, number>>;
}

export interface HumanFormulaPerformanceMetric {
  id: string;
  samples: number;
  p95: number;
  unit: 'ms' | 'count' | 'bytes';
  threshold: number;
  pass: boolean;
}

export interface HumanFormulaPerformanceResult {
  profile_revision: string;
  environment: Readonly<Record<string, unknown>>;
  metrics: readonly HumanFormulaPerformanceMetric[];
  boundary_calls_by_revision: Readonly<Record<string, number>>;
  missing: readonly string[];
  scenarios_exercised: readonly string[];
  pass: boolean;
}

const REQUIRED_ADAPTERS = [
  'native-analyze',
  'composer-filter',
  'owner-round-trip',
  'stale-reply-discard',
  'dense-edit-frame',
  'boundary-call-counter',
  'editor-heap',
] as const;

function nearestRank(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
}

async function measure(
  count: number,
  scenarios: readonly string[],
  clock: PerformanceClock,
  operation: (scenario: string) => void | Promise<void>,
): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = clock.now();
    await operation(scenarios[index % scenarios.length]!);
    samples.push(clock.now() - started);
  }
  return samples;
}

function timingMetric(
  id: string,
  samples: readonly number[],
  threshold: number,
): HumanFormulaPerformanceMetric {
  const p95 = nearestRank(samples, 0.95);
  return { id, samples: samples.length, p95, unit: 'ms', threshold, pass: p95 <= threshold };
}

export async function runHumanFormulaProfile(
  profile: HumanFormulaPerformanceProfile,
  adapters: HumanFormulaPerformanceAdapters,
  environment: Readonly<Record<string, unknown>> = {},
): Promise<HumanFormulaPerformanceResult> {
  const declared = new Set(profile.adapters);
  const missing = REQUIRED_ADAPTERS.filter((adapter) => !declared.has(adapter));
  if (profile.percentile !== 'nearest-rank') missing.push('nearest-rank-percentile');
  if (profile.scenarios.length === 0) missing.push('scenarios');

  const scenarios = [...new Set(profile.scenarios)];
  const run = async (
    operation: (scenario: string, profile: HumanFormulaPerformanceProfile) => void | Promise<void>,
    count: number,
  ) => measure(count, scenarios, adapters.clock, (scenario) => operation(scenario, profile));

  for (const operation of [
    adapters.nativeAnalyze,
    adapters.filterCatalog,
    adapters.ownerRoundTrip,
    adapters.discardStaleReply,
    adapters.renderDenseEdit,
  ]) await run(operation, profile.warmups);

  const heapBefore = adapters.heap.bytes();
  const nativeAnalyze = await run(adapters.nativeAnalyze, profile.runs);
  const composerFilter = await run(adapters.filterCatalog, profile.runs);
  const ownerRoundTrip = await run(adapters.ownerRoundTrip, profile.runs);
  const staleReplyDiscard = await run(adapters.discardStaleReply, profile.runs);
  const denseEditFrame = await run(adapters.renderDenseEdit, profile.runs);
  const heapDelta = Math.max(0, adapters.heap.bytes() - heapBefore);
  const boundaryCalls = adapters.boundaryCallsByRevision();
  const maxBoundaryCalls = Math.max(0, ...Object.values(boundaryCalls));
  const thresholds = profile.thresholds;
  const metrics: HumanFormulaPerformanceMetric[] = [
    timingMetric('native_analyze', nativeAnalyze, thresholds.native_analyze_p95_ms),
    timingMetric('composer_filter', composerFilter, thresholds.composer_filter_p95_ms),
    timingMetric('owner_round_trip', ownerRoundTrip, thresholds.owner_round_trip_p95_ms),
    timingMetric('stale_reply_discard', staleReplyDiscard, thresholds.stale_reply_discard_p95_ms),
    timingMetric('dense_edit_frame', denseEditFrame, thresholds.dense_edit_frame_p95_ms),
    {
      id: 'boundary_calls_per_committed_revision',
      samples: Object.keys(boundaryCalls).length,
      p95: maxBoundaryCalls,
      unit: 'count',
      threshold: thresholds.max_boundary_calls_per_committed_revision,
      pass: maxBoundaryCalls <= thresholds.max_boundary_calls_per_committed_revision,
    },
    {
      id: 'editor_heap_delta',
      samples: 1,
      p95: heapDelta,
      unit: 'bytes',
      threshold: thresholds.max_editor_heap_delta_bytes,
      pass: heapDelta <= thresholds.max_editor_heap_delta_bytes,
    },
  ];
  return {
    profile_revision: profile.profile_revision,
    environment,
    metrics,
    boundary_calls_by_revision: boundaryCalls,
    missing,
    scenarios_exercised: scenarios,
    pass: missing.length === 0 && metrics.every((metric) => metric.pass),
  };
}
