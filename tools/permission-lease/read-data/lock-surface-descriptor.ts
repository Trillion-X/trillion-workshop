// packages/permission-lease/read-data/lock-surface-descriptor.ts
//
// PURPOSE — the lock-surface DESCRIPTOR primitive (L063/L090 fix for the
// ObligationGatePanel binary-branch leak flagged by Codex 2026-07-03).
//
// A gate is NOT binary. "Locked vs Unlocked" is only the degenerate 2-state
// case; mastery gates have {locked, in-progress, mastered, decayed}, streak
// gates have {broken, building, kept}, etc. The panel must NOT branch on
// `unlocked` (that bakes a 2-state Society assumption + example-specific icons
// like Footprints into Physics). Instead: this PURE function maps an
// obligation + its decision + facts to a self-describing DESCRIPTOR — a state
// key plus resolved {icon, tone, label, title, body, progress, action} — and a
// blind renderer displays it. Adding a state = a DATA row in the obligation's
// `state_ladder` + `presentation`, never a code branch.
//
// NON-NEGOTIABLE INVARIANTS
// 1. Pure, deterministic, never throws. No I/O, no React.
// 2. Zero domain vocabulary — no "walk", "water", "lesson". All naming is DATA.
// 3. Icons/tones/labels are DATA (obligation.presentation) with maximally-capable
//    defaults (L083); the DEFAULT 2-state case still looks right with zero config.

import { decideCapability, type CapabilityObligation, type FactRecord, type ConditionPack } from './obligation-decision.ts';

export type ProgressView = { have: number; required: number; caption: string };

/** How the user SATISFIES a gate (DATA carried on the obligation). The panel is
 *  blind: it writes the evidence `fact` (stamping today's day + recorded_at),
 *  then dispatches progression-evaluator's compute-and-write-over-facts for each
 *  `recompute` (substituting the `$today` token in fact_where). Zero domain
 *  vocabulary here — walk/water/sleep are all this same shape as DATA rows. */
export type SatisfyRecompute = { measure_id: string; fact_where: unknown[]; params_override?: Record<string, unknown> };
export type SatisfySpec = { fact: { kind: string; fields?: Record<string, unknown> }; recompute: SatisfyRecompute[] };
export type ActionView = { label: string; iconName?: string; satisfy: SatisfySpec };

export type LockSurfaceDescriptor = {
  obligationRef: string;
  /** Self-describing state key. Degenerate case: "locked" | "unlocked". Rich
   *  case: any string from the obligation's state_ladder. */
  state: string;
  iconName: string;
  /** StatusDot tone, e.g. "success" | "warning" | "neutral". DATA-driven. */
  tone: string;
  pulse: boolean;
  stateLabel: string;
  title: string;
  body?: string;
  progress?: ProgressView;
  action?: ActionView;
};

type StatePresentation = { icon?: string; tone?: string; pulse?: boolean; label?: string };
type StateLadderEntry = { state: string; min: number };

// Maximally-capable defaults (L083): the 2-state gate renders correctly with
// zero per-obligation config. Obligations override any field via `presentation`.
const DEFAULT_PRESENTATION: Record<string, Required<StatePresentation>> = {
  unlocked: { icon: 'CheckCircle2', tone: 'success', pulse: false, label: 'Unlocked' },
  locked: { icon: 'Lock', tone: 'warning', pulse: true, label: 'Locked' },
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}
function numOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Validate the obligation's `satisfy` DATA into a typed SatisfySpec, or null if
 *  malformed. Fail-closed: a gate with no valid satisfy shows no action button. */
function normalizeSatisfy(raw: unknown): SatisfySpec | null {
  if (!isRecord(raw)) return null;
  const fact = raw.fact;
  if (!isRecord(fact) || !str(fact.kind)) return null;
  const fields = isRecord(fact.fields) ? fact.fields : undefined;
  const recomputeRaw = Array.isArray(raw.recompute) ? raw.recompute : [];
  const recompute: SatisfyRecompute[] = [];
  for (const r of recomputeRaw) {
    if (!isRecord(r)) continue;
    const measureId = str(r.measure_id);
    const factWhere = Array.isArray(r.fact_where) ? r.fact_where : null;
    if (!measureId || !factWhere) continue;
    recompute.push({
      measure_id: measureId,
      fact_where: factWhere,
      params_override: isRecord(r.params_override) ? r.params_override : undefined,
    });
  }
  if (recompute.length === 0) return null;
  return { fact: { kind: str(fact.kind) as string, fields }, recompute };
}

/** The latest value logged for a measure (by recorded_at), 0 if none. Reads BOTH
 *  the canonical progression-evaluator shape ({kind:"measure.fact", emit:<measure>})
 *  AND the bare-kind shape ({kind:<measure>}) so the panel's progress count agrees
 *  with the reduced measure the gate decides on (Codex 2026-07-04 — the facade fix). */
export function latestMeasureValue(
  facts: FactRecord[],
  measure: string,
  freshness?: { withinMs: number; nowIso: string },
): number {
  let best: { at: string; value: number } | null = null;
  for (const f of Array.isArray(facts) ? facts : []) {
    const r = f as Record<string, unknown>;
    const matches = r.kind === measure || (r.kind === 'measure.fact' && r.emit === measure);
    if (!matches) continue;
    const at = str(r.recorded_at) ?? '';
    const value = numOr(r.value, 0);
    if (!best || at > best.at) best = { at, value };
  }
  if (!best) return 0;
  // SSOT freshness: when the gate's condition governs this measure with a window,
  // a STALE latest fact contributes ZERO fresh progress — so the progress the panel
  // shows matches the freshness-aware DECISION. Without this, a prior-day count reads
  // as "3 of 1" while the gate (correctly) stays locked — the reported contradiction.
  if (freshness) {
    const factMs = Date.parse(best.at);
    const nowMs = Date.parse(freshness.nowIso);
    if (!Number.isFinite(factMs) || !Number.isFinite(nowMs) || nowMs - factMs > freshness.withinMs) return 0;
  }
  return best.value;
}

/** Find the freshness window (within_ms) that governs `measure` in a self-describing
 *  condition tree (any/all/not combinators + measure leaves). Returns null when the
 *  measure has no window (progress stays the raw latest value). Generic — walks the
 *  DATA tree without naming any combinator, so a new node family needs no edit. */
export function measureWithinMs(condition: unknown, measure: string): number | null {
  if (!isRecord(condition)) return null;
  if (condition.measure === measure && typeof condition.within_ms === 'number' && Number.isFinite(condition.within_ms)) {
    return condition.within_ms;
  }
  for (const v of Object.values(condition)) {
    if (Array.isArray(v)) {
      for (const child of v) {
        const w = measureWithinMs(child, measure);
        if (w != null) return w;
      }
    } else if (isRecord(v)) {
      const w = measureWithinMs(v, measure);
      if (w != null) return w;
    }
  }
  return null;
}

/** Resolve the state key. If the obligation defines a `state_ladder` (DATA:
 *  sorted [{state,min}]), the state is the highest rung whose `min <= measure`,
 *  else the lowest rung. With no ladder, fall back to the binary decision. */
function resolveState(o: Record<string, unknown>, allowed: boolean, measureValue: number): string {
  const ladder = Array.isArray(o.state_ladder) ? (o.state_ladder as StateLadderEntry[]) : null;
  if (ladder && ladder.length > 0) {
    const sorted = [...ladder].filter((e) => isRecord(e) && str(e.state)).sort((a, b) => a.min - b.min);
    let picked = sorted[0]?.state ?? (allowed ? 'unlocked' : 'locked');
    for (const rung of sorted) if (measureValue >= rung.min) picked = rung.state;
    return picked;
  }
  return allowed ? 'unlocked' : 'locked';
}

function presentationFor(o: Record<string, unknown>, state: string): Required<StatePresentation> {
  const overrides = isRecord(o.presentation) ? (o.presentation[state] as StatePresentation | undefined) : undefined;
  const base = DEFAULT_PRESENTATION[state] ?? DEFAULT_PRESENTATION[state === 'unlocked' ? 'unlocked' : 'locked'] ?? DEFAULT_PRESENTATION.locked;
  return {
    icon: str(overrides?.icon) ?? base.icon,
    tone: str(overrides?.tone) ?? base.tone,
    pulse: typeof overrides?.pulse === 'boolean' ? overrides.pulse : base.pulse,
    label: str(overrides?.label) ?? base.label,
  };
}

/** Derive the self-describing lock-surface descriptor. PURE. The panel renders
 *  this blindly — it never sees `decision.allowed` or a state name. */
export function deriveLockSurfaceDescriptor(
  obligation: CapabilityObligation,
  facts: FactRecord[],
  nowIso: string,
  pack: ConditionPack,
): LockSurfaceDescriptor {
  const o = obligation as CapabilityObligation & Record<string, unknown>;
  const decision = decideCapability(obligation.capability_ref, [obligation], facts, nowIso, pack);
  const allowed = decision.allowed;
  const measure = str(o.progress_measure);
  const required = numOr(o.progress_required, 1);
  // Read progress through the SAME freshness the decision uses (SSOT): if the
  // condition windows this measure, a stale latest fact yields 0 fresh progress.
  const withinMs = measure ? measureWithinMs(o.condition, measure) : null;
  const have = measure
    ? latestMeasureValue(facts, measure, withinMs != null ? { withinMs, nowIso } : undefined)
    : allowed
      ? required
      : 0;
  const state = resolveState(o, allowed, have);
  const pres = presentationFor(o, state);

  // Title/body resolved from per-state DATA (e.g. `<state>_title`), falling back
  // to the legacy locked/unlocked fields, then label. No hardcoded copy.
  const title = str(o[`${state}_title`]) ?? (allowed ? str(o.unlocked_title) : str(o.locked_title)) ?? str(o.label) ?? pres.label;
  const body = str(o[`${state}_body`]) ?? (allowed ? str(o.unlocked_body) : str(o.locked_body));

  // Progress + action shown for any non-terminal state (measure present and not
  // yet allowed) — data-driven, not gated on the string "locked".
  const showAction = !allowed && !!measure;
  const progress: ProgressView | undefined =
    showAction && measure ? { have, required, caption: `${have} of ${required}` } : undefined;
  // The action carries the obligation's `satisfy` DATA (evidence fact + recompute
  // spec). NO satisfy => NO button (fail closed — there is no facade fallback that
  // fabricates a measure value; the only way to move a gate is real evidence).
  const satisfy = normalizeSatisfy(o.satisfy);
  const action: ActionView | undefined =
    showAction && satisfy
      ? { label: str(o.unlock_action_label) ?? 'Mark done', iconName: str(o.unlock_action_icon), satisfy }
      : undefined;

  return {
    obligationRef: str(o.obligation_ref) ?? obligation.capability_ref,
    state,
    iconName: pres.icon,
    tone: pres.tone,
    pulse: pres.pulse,
    stateLabel: pres.label,
    title,
    body,
    progress,
    action,
  };
}
