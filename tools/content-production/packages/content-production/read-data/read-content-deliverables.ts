/**
 * file: packages/content-production/read-data/read-content-deliverables.ts
 *
 * PURPOSE: Pure queries for the Deliverables surface (plan §13A U03→U05).
 * Groups the evidence feed's runs / statuses / outputs / errors lanes into
 * per-run delivery cards: what was asked for, where it stands, and every
 * finished artifact the run produced.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Never imports from slot::workflow or slot::eeaf — pure data over the evidence feed
 * 2. Output kinds are DATA from each record — never enumerated here
 * 3. Zero side effects, zero writes
 */

import {
  readContentProductionEvidence,
  type ContentProductionOutput,
  type ContentProductionRun,
} from '@/packages/content-production/read-data/read-content-production';

export type ContentDeliverableOutput = {
  outputId: string;
  stepId: string;
  definitionId: string;
  completedAt: string | null;
  /** The opaque output payload — rendered as user-meaningful fields when present. */
  output: Record<string, unknown>;
};

export type ContentDeliverableRun = {
  runId: string;
  title: string;
  state: string;
  stateMessage: string;
  requestedAt: string | null;
  outputs: ContentDeliverableOutput[];
  errors: { code: string; message: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function runTitle(run: ContentProductionRun): string {
  const raw = run as unknown as Record<string, unknown>;
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  return (
    asText(metadata.title) ??
    asText(raw.prompt_text)?.split('\n').find((line) => line.trim())?.slice(0, 120) ??
    'Untitled run'
  );
}

function deliverableOutput(output: ContentProductionOutput): ContentDeliverableOutput | null {
  const raw = output as unknown as Record<string, unknown>;
  const outputId = asText(raw.output_id);
  if (!outputId) return null;
  return {
    outputId,
    stepId: asText(raw.step_id) ?? '',
    definitionId: asText(raw.definition_id) ?? '',
    completedAt: asText(raw.completed_at),
    output: isRecord(raw.output) ? raw.output : {},
  };
}

/**
 * All runs with their latest status, finished outputs, and errors —
 * newest first. One card per run.
 */
export function readContentDeliverableRuns(evidenceRows: unknown): ContentDeliverableRun[] {
  const evidence = readContentProductionEvidence(evidenceRows);

  const latestStatusByRun = new Map<string, { state: string; message: string; observedAt: number }>();
  for (const status of evidence.statuses) {
    const raw = status as unknown as Record<string, unknown>;
    const runId = asText(raw.run_id);
    if (!runId) continue;
    const observedAt = Date.parse(asText(raw.observed_at) ?? '');
    const current = latestStatusByRun.get(runId);
    if (!current || (Number.isFinite(observedAt) && observedAt > current.observedAt)) {
      latestStatusByRun.set(runId, {
        state: asText(raw.state) ?? '',
        message: asText(raw.message) ?? '',
        observedAt: Number.isFinite(observedAt) ? observedAt : 0,
      });
    }
  }

  const outputsByRun = new Map<string, ContentDeliverableOutput[]>();
  for (const output of evidence.outputs) {
    const raw = output as unknown as Record<string, unknown>;
    const runId = asText(raw.run_id);
    const item = deliverableOutput(output);
    if (!runId || !item) continue;
    outputsByRun.set(runId, [...(outputsByRun.get(runId) ?? []), item]);
  }

  const errorsByRun = new Map<string, { code: string; message: string }[]>();
  for (const error of evidence.errors) {
    const raw = error as unknown as Record<string, unknown>;
    const runId = asText(raw.run_id);
    if (!runId) continue;
    errorsByRun.set(runId, [
      ...(errorsByRun.get(runId) ?? []),
      { code: asText(raw.code) ?? '', message: asText(raw.message) ?? '' },
    ]);
  }

  return evidence.runs
    .map((run) => {
      const raw = run as unknown as Record<string, unknown>;
      const runId = asText(raw.run_id);
      if (!runId) return null;
      const status = latestStatusByRun.get(runId);
      return {
        runId,
        title: runTitle(run),
        state: status?.state ?? 'submitted',
        stateMessage: status?.message ?? '',
        requestedAt: asText(raw.requested_at),
        outputs: outputsByRun.get(runId) ?? [],
        errors: errorsByRun.get(runId) ?? [],
      };
    })
    .filter((run): run is ContentDeliverableRun => run !== null)
    .sort((left, right) => {
      const leftTime = Date.parse(left.requestedAt ?? '');
      const rightTime = Date.parse(right.requestedAt ?? '');
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });
}

/** Pull the user-meaningful fields out of an opaque output payload. */
export function deliverableDisplayFields(output: ContentDeliverableOutput): { key: string; value: string }[] {
  // No slice here: the shared OutputFieldList owns the visible limit, the
  // reveal control, and the internal-key denylist — this reader only flattens
  // scalars into key/value rows.
  return Object.entries(output.output)
    .map(([key, value]) => {
      if (typeof value === 'string') return { key, value };
      if (typeof value === 'number' || typeof value === 'boolean') return { key, value: String(value) };
      return null;
    })
    .filter((entry): entry is { key: string; value: string } => entry !== null);
}

/** A visible result title must come from person-facing DATA, never an internal identity. */
export function deliverableTitle(output: ContentDeliverableOutput): string {
  return (
    asText(output.output.title) ??
    asText(output.output.label) ??
    asText(output.output.name) ??
    'Finished result'
  );
}
