// A run's health is NOT a stored status — the ai-execution-run records carry no
// status field. Health is DERIVED from each run's own self-describing facts: did
// it reach an end (ended_at)? how many steps did it record? how long ago did it
// start? what did it cost? The classifier is a GENERIC evaluator over an ordered
// list of self-describing DATA rules injected by the owner (surface_input) — it
// never enumerates health-key names in control flow. Fail-closed: no rules (or no
// rule matches) → no classification, so a new health signal is one DATA row with
// ZERO code change (L069 primitive, L090 self-describing data + generic handler,
// enum-dissolution: no closed TS union of health kinds).

import type { ExecutionRun } from './read-ai-execution-history';

// Rendering tone for a health bucket — a closed algebra of the design system's
// semantic tones (Physics of the palette), not an extensible Society list.
export type HealthTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

// The comparison ops a clause may use. Closed by the Physics of comparison
// (present/absent + numeric ordering), like Option/Result — not user-extensible.
export type HealthOp = 'present' | 'absent' | 'gte' | 'lte' | 'eq';

// One comparison against a single derived fact of a run. `fact` names a key of
// RunFacts; the evaluator looks it up blindly (never switches on the name).
export type HealthClause = {
  fact: string;
  op: HealthOp;
  value?: number;
};

// A self-describing health rule. ALL clauses must hold for the rule to match; the
// FIRST matching rule (in list order) wins, so order encodes precedence. Injected
// as DATA — the surface/leaf never hardcodes these. `severity` is an optional
// DATA-supplied passthrough so the classified output can travel unchanged into
// downstream filters or projections with no code change.
export type HealthRule = {
  key: string;
  label: string;
  tone?: HealthTone;
  severity?: string;
  requires: HealthClause[];
};

// The classification result for one run. Directly consumable anywhere a surface
// wants the generic `{ key, label, tone, severity? }` health payload.
export type RunHealth = { key: string; label: string; tone: HealthTone; severity?: string };

// The ONLY run-structural properties a health rule may test. Extend HERE (one
// place) to expose a new fact to DATA rules — the evaluator stays untouched.
export type RunFacts = {
  ended: boolean; // has an ended_at stamp — the run reached an end
  steps: number; // number of recorded steps
  ageSeconds: number; // seconds since started_at relative to `nowMs` (0 if unknown)
  costUnits: number; // total cost units (0 if none recorded)
};

// Real records nest cost under `cost.total_units`; tolerate a flat `total_units`
// too. Absent/malformed → 0 (a run with no recorded cost cost nothing to read as).
function costUnitsOf(run: ExecutionRun): number {
  const flat = run.total_units;
  if (typeof flat === 'number' && Number.isFinite(flat)) return flat;
  const cost = (run as unknown as { cost?: unknown }).cost;
  if (cost && typeof cost === 'object') {
    const units = (cost as { total_units?: unknown }).total_units;
    if (typeof units === 'number' && Number.isFinite(units)) return units;
  }
  return 0;
}

// Project a run + its step count into the fixed fact set health rules test.
// `nowMs` is passed in (never read from a clock inside) so the derivation is pure
// and deterministic under test.
export function deriveRunFacts(run: ExecutionRun, stepCount: number, nowMs: number): RunFacts {
  const startedMs = run.started_at ? Date.parse(run.started_at) : NaN;
  const ageSeconds = Number.isFinite(startedMs) ? Math.max(0, Math.round((nowMs - startedMs) / 1000)) : 0;
  return {
    ended: Boolean(run.ended_at),
    steps: Number.isFinite(stepCount) ? Math.max(0, Math.round(stepCount)) : 0,
    ageSeconds,
    costUnits: costUnitsOf(run),
  };
}

// Blind lookup — the evaluator does not enumerate fact names in control flow.
function factValue(facts: RunFacts, key: string): number | boolean | undefined {
  return (facts as unknown as Record<string, number | boolean>)[key];
}

function clauseHolds(facts: RunFacts, clause: HealthClause): boolean {
  const v = factValue(facts, clause.fact);
  switch (clause.op) {
    // "present" = truthy boolean OR a positive count (the fact registered).
    case 'present':
      return v === true || (typeof v === 'number' && v > 0);
    // "absent" = false boolean, a zero count, or an unknown fact.
    case 'absent':
      return v === false || v === 0 || v === undefined;
    case 'gte':
      return typeof v === 'number' && typeof clause.value === 'number' && v >= clause.value;
    case 'lte':
      return typeof v === 'number' && typeof clause.value === 'number' && v <= clause.value;
    case 'eq':
      return typeof v === 'number' && typeof clause.value === 'number' && v === clause.value;
    default:
      return false;
  }
}

function normalizeTone(tone?: HealthTone): HealthTone {
  return tone ?? 'neutral';
}

// Classify a run's facts against an ordered, self-describing rule list. First rule
// whose clauses ALL hold wins. Fail-closed: no rules / no match → undefined (the
// surface shows no health tag rather than inventing a status the data never had).
export function deriveRunHealth(facts: RunFacts, rules: readonly HealthRule[]): RunHealth | undefined {
  for (const rule of rules) {
    if (!rule || !Array.isArray(rule.requires) || rule.requires.length === 0) continue;
    if (rule.requires.every((clause) => clauseHolds(facts, clause))) {
      return {
        key: rule.key,
        label: rule.label,
        tone: normalizeTone(rule.tone),
        ...(rule.severity ? { severity: rule.severity } : {}),
      };
    }
  }
  return undefined;
}

const VALID_OPS: ReadonlySet<string> = new Set<HealthOp>(['present', 'absent', 'gte', 'lte', 'eq']);
const VALID_TONES: ReadonlySet<string> = new Set<HealthTone>(['success', 'warning', 'error', 'info', 'neutral']);

// Parse owner-injected health rules from surface_input DATA. Accepts either a bare
// array or a `{ rules: [...] }` wrapper. Fail-closed: any malformed rule/clause is
// dropped (never throws), so bad DATA degrades to fewer buckets, not a crash.
export function parseHealthRules(raw: unknown): HealthRule[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules)
      ? ((raw as { rules: unknown[] }).rules)
      : [];
  const rules: HealthRule[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const key = typeof r.key === 'string' && r.key.trim() ? r.key : undefined;
    const label = typeof r.label === 'string' && r.label.trim() ? r.label : undefined;
    if (!key || !label) continue;
    const requires: HealthClause[] = [];
    const reqRaw = Array.isArray(r.requires) ? r.requires : [];
    for (const c of reqRaw) {
      if (!c || typeof c !== 'object') continue;
      const cc = c as Record<string, unknown>;
      const fact = typeof cc.fact === 'string' && cc.fact.trim() ? cc.fact : undefined;
      const op = typeof cc.op === 'string' && VALID_OPS.has(cc.op) ? (cc.op as HealthOp) : undefined;
      if (!fact || !op) continue;
      const value = typeof cc.value === 'number' && Number.isFinite(cc.value) ? cc.value : undefined;
      requires.push({ fact, op, ...(value == null ? {} : { value }) });
    }
    if (requires.length === 0) continue; // a rule with no clauses would match everything — drop it
    const tone = typeof r.tone === 'string' && VALID_TONES.has(r.tone) ? (r.tone as HealthTone) : undefined;
    const severity = typeof r.severity === 'string' && r.severity.trim() ? r.severity : undefined;
    rules.push({ key, label, ...(tone ? { tone } : {}), ...(severity ? { severity } : {}), requires });
  }
  return rules;
}

// A frozen empty rule list — the fail-closed default a surface uses when the owner
// injects no rules. Importing THIS (not a populated pack) keeps the surface from
// compile-time-owning a shipped registry (avoids the with_builtin enum-in-disguise).
export const EMPTY_HEALTH_RULES: readonly HealthRule[] = Object.freeze([]);
