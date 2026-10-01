// packages/ask-questions-sort-answers-follow-up/read-data/follow-up-sequences.ts
//
// The ACT stage's DATA: a per-segment follow-up sequence. Each segment maps to
// an ordered list of steps; each step names an external-operation venue config
// (the proven Stripe/executor pattern — CRM upsert / email / Discord) plus a
// time gate. Keys live in the hosted-credential vault, never here. Selecting and
// reading sequences is pure + generic — a new segment's follow-up is one more
// DATA row, never a code branch (L063/L090). The workflow slot EXECUTES the
// selected sequence; this module only selects/decodes it.

const SEQUENCE_KIND = 'follow-up-sequence';

export interface FollowUpStep {
  stepId: string;
  /** Address of the written note saying how to ask something else to do this. */
  venueConfigAddress?: string;
  /** Body template merged with respondent facts at execution time. */
  bodyTemplate?: Record<string, unknown>;
  /** Time gate (hours from the decision) — data-state gated, not event-chained. */
  delayHours?: number;
  label?: string;
}

export interface FollowUpSequence {
  kind: typeof SEQUENCE_KIND;
  /** Which segment this sequence runs for. */
  segmentId: string;
  steps: FollowUpStep[];
}

/** The sequence whose `segmentId` matches, or null when the segment has none. */
export function selectFollowUpSequence(
  segmentId: string | null,
  sequences: readonly FollowUpSequence[],
): FollowUpSequence | null {
  if (segmentId === null) return null;
  return sequences.find((s) => s.segmentId === segmentId) ?? null;
}

function payloadOf(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const inner = (row as { payload?: unknown }).payload ?? row;
  return inner && typeof inner === 'object' && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : null;
}

function readStep(raw: unknown): FollowUpStep | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.stepId !== 'string') return null;
  return {
    stepId: s.stepId,
    venueConfigAddress: typeof s.venueConfigAddress === 'string' ? s.venueConfigAddress : undefined,
    bodyTemplate:
      s.bodyTemplate && typeof s.bodyTemplate === 'object' && !Array.isArray(s.bodyTemplate)
        ? (s.bodyTemplate as Record<string, unknown>)
        : undefined,
    delayHours: typeof s.delayHours === 'number' ? s.delayHours : undefined,
    label: typeof s.label === 'string' ? s.label : undefined,
  };
}

/** Decode raw bitfield rows -> typed follow-up sequences (drops malformed rows). */
export function readFollowUpSequences(raw: unknown): FollowUpSequence[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: FollowUpSequence[] = [];
  for (const row of rows) {
    const p = payloadOf(row);
    if (!p || p.kind !== SEQUENCE_KIND || typeof p.segmentId !== 'string') continue;
    const steps = Array.isArray(p.steps)
      ? p.steps.map(readStep).filter((s): s is FollowUpStep => s !== null)
      : [];
    out.push({ kind: SEQUENCE_KIND, segmentId: p.segmentId, steps });
  }
  return out;
}
