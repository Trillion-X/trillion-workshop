// packages/choose-per-observer/show/mount-scoreboard.tsx
//
// The LIVE experiment scoreboard entry. Blind + DATA-driven: it reads the
// published-records feed, finds the selection-surface, the attribution-join
// config, the assignment records, and the conversion facts (all by DATA-supplied
// kinds/address), composes the pure projection (projectScoreboard), and renders
// the blind ScoreboardSurface. No metric, no status, no candidate concept is
// named here — everything is configuration (L090).
//
// surface_input (DATA):
//   surface_address   — the selection-surface address to project (required).
//   join_id           — which attribution-join config to use (required).
//   assignment_kind   — record kind carrying {observer_id, winner} (default 'experiment-assignment').
//   outcome_kind      — record kind carrying {observer_id, metric, value?} (default 'experiment-conversion').
//   leader_metric     — emitted metric that decides the front-runner (default 'conversions').

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { useBitfieldData } from '@/packages/choose-per-observer/.bitfield-entry-scope/scoreboard/runtime-kit-react';
import { ScoreboardSurface } from '@/packages/choose-per-observer/show/ScoreboardSurface';
import { projectScoreboard } from '@/packages/choose-per-observer/read-data/scoreboard-projection';
import { buildScoreboardViewModel } from '@/packages/choose-per-observer/show/scoreboard-view-model';
import type { SelectionSurface } from '@/packages/choose-per-observer/read-data/candidate-set-schema';
import type { AttributionJoin } from '@/packages/choose-per-observer/read-data/attribute-outcomes';

/** A valid, empty view-model so the surface can decode its board even in the
 *  loading / error / not-configured states (it decodes boardInput up front). */
const EMPTY_VIEW_MODEL = buildScoreboardViewModel({
  surface: { entity_type: 'selection-surface', address: '', decider_program_ref: '', candidates: [] },
  metrics: {},
  significance: { decided: false, winProbability: null, leaderId: null },
});

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function rowsOf(published: unknown): Array<{ address?: string; payload?: unknown }> {
  if (Array.isArray(published)) return published as Array<{ address?: string; payload?: unknown }>;
  if (published && typeof published === 'object' && Array.isArray((published as { rows?: unknown }).rows)) {
    return (published as { rows: Array<{ address?: string; payload?: unknown }> }).rows;
  }
  return [];
}

function payloadOf(row: { payload?: unknown }): Record<string, unknown> | null {
  const p = row && typeof row === 'object' ? (row.payload ?? row) : null;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
}

function ScoreboardLiveView({ input }: { input: Record<string, unknown> }) {
  const published = useBitfieldData('published-records');
  const surfaceAddress = str(input.surface_address);
  const joinId = str(input.join_id);
  const assignmentKind = str(input.assignment_kind, 'experiment-assignment');
  const outcomeKind = str(input.outcome_kind, 'experiment-conversion');
  const leaderMetric = str(input.leader_metric, 'conversions');

  const projected = React.useMemo(() => {
    if (published == null) return null;
    const rows = rowsOf(published).map(payloadOf).filter((p): p is Record<string, unknown> => p != null);
    const surface = rows.find(
      (p) => p.kind === 'selection-surface' && p.address === surfaceAddress,
    ) as SelectionSurface | undefined;
    const join = rows.find(
      (p) => p.kind === 'attribution-join' && p.join_id === joinId,
    ) as AttributionJoin | undefined;
    if (!surface || !join) return { missing: true as const, surface, join };
    const assignments = rows.filter((p) => p.kind === assignmentKind);
    const outcomes = rows.filter((p) => p.kind === outcomeKind);
    const { viewModel } = projectScoreboard({
      surface,
      join,
      assignments,
      outcomes,
      leaderMetric,
      now: new Date().toISOString(),
    });
    return { missing: false as const, viewModel };
  }, [published, surfaceAddress, joinId, assignmentKind, outcomeKind, leaderMetric]);

  if (projected == null) {
    return <ScoreboardSurface loading viewModel={EMPTY_VIEW_MODEL} />;
  }
  if (projected.missing) {
    return <ScoreboardSurface error viewModel={EMPTY_VIEW_MODEL} />;
  }
  return <ScoreboardSurface viewModel={projected.viewModel} />;
}

function ScoreboardMaterial({ props }: { props: Record<string, unknown> }) {
  // The host threads the placeable-surface `surface_input` DATA to the mount as
  // the camelCase `surfaceInput` prop (same convention as ask-questions). Fall
  // back to snake_case / bare props for direct-mount test harnesses.
  const input = (props.surfaceInput
    ?? props.surface_input
    ?? props) as Record<string, unknown>;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="choose-per-observer scoreboard material">
        <ScoreboardLiveView input={input} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ScoreboardMaterial props={props} />);
}
