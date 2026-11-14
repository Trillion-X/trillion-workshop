// Renders capability-obligation records as gate cards and lets the user satisfy them.

import React from 'react';
import { Container, NamedIcon, ScrollableSurface, Spinner, StatusDot, Text, Button } from '../../ui/index.ts';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  type CapabilityObligation,
  type FactRecord,
} from '../read-data/obligation-decision.ts';
import {
  deriveLockSurfaceDescriptor,
  type SatisfySpec,
} from '../read-data/lock-surface-descriptor.ts';
import { conditionNodes, predicateOps } from '../read-data/condition-node-pack.ts';

const PACK = { nodes: conditionNodes, predicates: predicateOps };

type Row = { address?: string; payload?: Record<string, unknown> };

function rowsOf(raw: unknown): Row[] {
  if (Array.isArray(raw)) return raw as Row[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows)) {
    return (raw as { rows: Row[] }).rows;
  }
  return [];
}

function payloadOf(row: Row): Record<string, unknown> | null {
  const p = row && typeof row === 'object' ? (row.payload ?? row) : null;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/** StatusDot tones the descriptor may resolve to (DATA-driven; cast at the seam). */
type StatusTone = 'success' | 'warning' | 'neutral' | 'danger' | 'info';

function dayKey(nowIso: string): string {
  return nowIso.slice(0, 10);
}

/** Substitute the self-describing `$today` token in a fact_where conditions array
 *  with today's day-key. The panel is blind to what the conditions mean — it only
 *  fills the one dynamic value (today) the DATA marked. */
function substituteToday(factWhere: unknown[], todayKey: string): unknown[] {
  return factWhere.map((cond) => {
    if (!cond || typeof cond !== 'object') return cond;
    const c = cond as Record<string, unknown>;
    if (!Array.isArray(c.in)) return cond;
    return { ...c, in: c.in.map((v) => (v === '$today' ? todayKey : v)) };
  });
}

/** THE HONEST SATISFY LOOP (no facade). Two steps, both DATA-driven:
 *  1. Write a REAL evidence fact (the user attesting), stamped with today + time.
 *  2. Dispatch progression-evaluator's compute-and-write-over-facts (BY ADDRESS —
 *     no god package) to REDUCE today's evidence into the canonical measure.fact.
 *  The gate then reads that reduced, windowed measure. Because the reduction is
 *  scoped to today and the condition carries within_ms freshness, the gate decays
 *  daily — which the old direct measure-write never did. */
async function satisfyGate(satisfy: SatisfySpec, nowIso: string): Promise<void> {
  const today = dayKey(nowIso);
  const { fact, recompute } = satisfy;

  // Step 1 — record the evidence fact. Unique address per press so counts accrue.
  await sendRequestToBitfieldTarget({
    target: 'engine.operation.label-addressed',
    payload: {
      operation_label: 'engine.operation.write-batch',
      writes: [
        {
          address_label: `package::permission-lease::evidence::${fact.kind}::${nowIso}`,
          address_mode: 'identity_text',
          path_labels: ['current-item', 'published-record'],
          payload: {
            ...(fact.fields ?? {}),
            id: `${fact.kind}:${nowIso}`,
            kind: fact.kind,
            recorded_at: nowIso,
            day: today,
          },
        },
      ],
    },
  });

  // Step 2 — reduce the evidence into the canonical measure fact (progression-
  // evaluator owns reduction; dispatched by address). Serial so a failed write
  // is not masked by a fire-and-forget reduce.
  for (const r of recompute) {
    await sendRequestToBitfieldTarget({
      target: 'slot::workflow',
      payload: {
        operation: 'execute_definition',
        definition_id: 'action:compute-and-write-over-facts',
        include_steps: false,
        include_output: false,
        input: {
          measure_id: r.measure_id,
          fact_where: substituteToday(r.fact_where, today),
          // stamp the measure with write-time so the gate's within_ms freshness
          // works — a measure with no recorded_at reads as permanently stale.
          recorded_at: nowIso,
          ...(r.params_override ? { params_override: r.params_override } : {}),
        },
      },
    });
  }
}

/** Blind renderer: displays the self-describing lock-surface descriptor. It never
 *  sees `decision.allowed` or a state name — every icon/tone/label/copy/action is
 *  resolved by the pure `deriveLockSurfaceDescriptor` from DATA. Adding a gate
 *  state (in-progress, mastered, decayed) is a DATA row, never an edit here.
 *  Exported so the structural CapabilityGate reuses the exact same card + satisfy
 *  loop for its blocking obligations. */
export function GateCard({ obligation, facts }: { obligation: CapabilityObligation; facts: FactRecord[] }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nowIso, setNowIso] = React.useState(() => new Date().toISOString());

  const descriptor = React.useMemo(
    () => deriveLockSurfaceDescriptor(obligation, facts, nowIso, PACK),
    [obligation, facts, nowIso],
  );

  const actionSatisfy = descriptor.action?.satisfy;
  const onLog = React.useCallback(async () => {
    if (!actionSatisfy || busy) return;
    setBusy(true);
    setError(null);
    try {
      const at = new Date().toISOString();
      await satisfyGate(actionSatisfy, at);
      setNowIso(at);
    } catch (e) {
      // Never fail silently — a swallowed error reads to the user as "I clicked and
      // nothing happened". Surface a short, human message so the failure is visible.
      setError(e instanceof Error ? e.message : "That didn't go through — try again.");
    } finally {
      setBusy(false);
    }
  }, [actionSatisfy, busy]);

  return (
    <Container layout="vertical" gap="md" padding="xl" alignItems="center" justifyContent="center">
      <NamedIcon name={descriptor.iconName} size="xl" />
      <StatusDot status={descriptor.tone as StatusTone} size="md" pulse={descriptor.pulse} label={descriptor.stateLabel} />
      <Text variant="heading-lg" leading="tight" align="center">{descriptor.title}</Text>
      {descriptor.body ? <Text variant="body" color="muted" leading="snug" align="center">{descriptor.body}</Text> : null}
      {descriptor.progress ? (
        <Text variant="caption" color="faint" align="center">{descriptor.progress.caption}</Text>
      ) : null}
      {descriptor.action ? (
        <Button variant="primary" size="md" onClick={onLog} disabled={busy}>
          {descriptor.action.iconName ? <NamedIcon name={descriptor.action.iconName} size="sm" /> : null}
          {busy ? 'Logging…' : descriptor.action.label}
        </Button>
      ) : null}
      {error ? <Text variant="caption" color="error" align="center">{error}</Text> : null}
    </Container>
  );
}

/** Partition the live published-records feed into the gate's two inputs: the
 *  capability-obligation DATA rows and the canonical measure.* facts. Exported so
 *  the structural CapabilityGate reads the exact same live inputs. */
export function readGateInputs(published: unknown): { obligations: CapabilityObligation[]; facts: FactRecord[] } {
  const obs: CapabilityObligation[] = [];
  const fs: FactRecord[] = [];
  for (const row of rowsOf(published)) {
    const p = payloadOf(row);
    if (!p) continue;
    const kind = str(p.kind);
    if (kind === 'capability-obligation') obs.push(p as unknown as CapabilityObligation);
    else if (kind && kind.startsWith('measure.')) fs.push(p as FactRecord);
  }
  return { obligations: obs, facts: fs };
}

export function ObligationGatePanel() {
  const published = useBitfieldData('published-records');
  const { obligations, facts } = React.useMemo(() => readGateInputs(published), [published]);

  if (published == null) {
    return (
      <ScrollableSurface>
        <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center" padding="xl">
          <Spinner />
        </Container>
      </ScrollableSurface>
    );
  }

  if (obligations.length === 0) {
    return (
      <ScrollableSurface>
        <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center" padding="xl">
          <NamedIcon name="CheckCircle2" size="lg" />
          <Text variant="heading-lg" leading="tight" align="center">Nothing is holding you back</Text>
          <Text variant="body" color="muted" leading="snug" align="center">No gates are active right now.</Text>
        </Container>
      </ScrollableSurface>
    );
  }

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="xl" padding="none">
        {obligations.map((o) => (
          <GateCard key={o.obligation_ref} obligation={o} facts={facts} />
        ))}
      </Container>
    </ScrollableSurface>
  );
}
