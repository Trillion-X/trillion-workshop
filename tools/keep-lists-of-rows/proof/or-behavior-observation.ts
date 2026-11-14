import type { TaskContext } from 'vitest';
import sourceCoverage from './or-source-test-coverage.json';

export type OrBehaviorObservation = {
  schema: 'visual-database.or-test-behavior-observation/v1';
  or_id: `OR-${string}`;
  action_ids: string[];
  assertion_ids: string[];
  observed: Record<string, unknown>;
};

function hasDecisiveProducerKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDecisiveProducerKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    ['pass', 'passed', 'verdict', 'success', 'accepted'].includes(key)
      || hasDecisiveProducerKey(child));
}

function exactIds(values: string[], label: string): void {
  if (
    !Array.isArray(values)
    || values.some((value) => typeof value !== 'string' || value.length === 0)
    || new Set(values).size !== values.length
  ) {
    throw new Error(`${label} must contain unique non-empty IDs`);
  }
}

type SourceCoverageBinding = {
  file: string;
  title: string;
  action_ids: string[];
  assertion_ids: string[];
};

function catalogBoundObservation(
  task: TaskContext['task'],
  observation: Omit<OrBehaviorObservation, 'schema'>,
): Pick<OrBehaviorObservation, 'action_ids' | 'assertion_ids'> | null {
  const row = sourceCoverage.rows.find((candidate) => candidate.or_id === observation.or_id);
  // Unit tests and future OR families outside this catalog retain the generic
  // helper contract. Closed OR-01..OR-28 receipts are catalog-authoritative.
  if (!row) {
    return {
      action_ids: observation.action_ids,
      assertion_ids: observation.assertion_ids,
    };
  }
  const taskName = typeof task.name === 'string' ? task.name : '';
  const matches = (row.tests as SourceCoverageBinding[]).filter((binding) => (
    binding.title === taskName || binding.title.endsWith(` ${taskName}`)
  ));
  // A known OR observation emitted by an unbound test cannot become receipt
  // evidence. This lets source-shape tests remain useful without letting them
  // claim behavior assigned to a different causal simulation.
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(`${observation.or_id} task identity does not resolve exactly once`);
  }
  const binding = matches[0];
  return {
    action_ids: observation.action_ids.filter((id) => binding.action_ids.includes(id)),
    assertion_ids: observation.assertion_ids.filter((id) => binding.assertion_ids.includes(id)),
  };
}

/**
 * Records values observed by a passing Vitest case in that case's result metadata.
 * The JSON reporter serializes this metadata into the create-once G08 artifact, so
 * the OR controller can bind semantic actions/assertions to the test invocation
 * that actually produced the values instead of trusting a separate claim file.
 */
export function observeOrBehavior(
  task: TaskContext['task'],
  observation: Omit<OrBehaviorObservation, 'schema'>,
): void {
  exactIds(observation.action_ids, `${observation.or_id} action_ids`);
  exactIds(observation.assertion_ids, `${observation.or_id} assertion_ids`);
  if (
    !observation.observed
    || typeof observation.observed !== 'object'
    || Array.isArray(observation.observed)
    || Object.keys(observation.observed).length === 0
  ) {
    throw new Error(`${observation.or_id} observed values must be a non-empty object`);
  }
  if (hasDecisiveProducerKey(observation.observed)) {
    throw new Error(`${observation.or_id} observed values contain a producer verdict`);
  }
  const bound = catalogBoundObservation(task, observation);
  if (!bound) return;
  if (bound.action_ids.length + bound.assertion_ids.length === 0) {
    throw new Error(`${observation.or_id} catalog binding admits no claimed behavior`);
  }
  const current = task.meta.or_behavior_observations;
  const rows = current === undefined ? [] : current;
  if (!Array.isArray(rows)) {
    throw new Error('or_behavior_observations metadata has the wrong shape');
  }
  if (rows.some((row) =>
    row && typeof row === 'object' && 'or_id' in row && row.or_id === observation.or_id)) {
    throw new Error(`${observation.or_id} is observed more than once by one test`);
  }
  task.meta.or_behavior_observations = [
    ...rows,
    {
      schema: 'visual-database.or-test-behavior-observation/v1',
      ...observation,
      ...bound,
    },
  ];
}
