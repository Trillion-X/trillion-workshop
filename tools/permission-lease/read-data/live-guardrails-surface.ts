//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The translation boundary for the Guardrails / Allowed-Trading surface, built
// on the visual-database generic primitive. It does TWO things, both data-driven:
//
//   1. PROJECT the live lease into ONE visual-database record (the lease payload IS
//      the record payload, plus a human title). The guardrail DIMENSIONS (caps,
//      allowed symbols, posture, expiry, …) are NOT enumerated here — they are
//      visual-database FIELD DESCRIPTORS authored as DATA
//      (permission-lease:guardrails.fields). A venue with different guardrails
//      renders by DATA alone: a different descriptor record, ZERO code change.
//   2. TRANSLATE the lease-PRIMITIVE Physics into plain human sentences — the
//      things universal to ANY permission lease, closed by Physics (not a
//      configurable dimension): the every-order-is-checked promise, the latest
//      check verdict, whether trading is switched off, and what the agent is
//      doing right now (the canonical hold-reason sentence). These are NOT a
//      dimension list — they are the lease primitive's own states.
//
// What this file does NOT do anymore (BURNED — superseded by visual-database, L030):
//   - It does NOT reach for named cap fields (max_order_notional, …) with
//     hardcoded labels/types/sentences. That fixed dimension set was the
//     instance-solving. The dimensions are now descriptor DATA the surface reads.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. HONEST DATA ONLY. The projected record carries only what the live lease
//    actually holds; absent fields simply have no value (visual-database omits an
//    empty metric). Safety reads PESSIMISTIC: missing records => paper / blocked.
// 2. NO HARDCODED DIMENSION SET. The guardrail field set is DATA (descriptors).
//    This file projects the lease record and translates only lease-primitive
//    Physics — never a fixed list of caps.
// 3. PURE AND DETERMINISTIC. No I/O, no clock except the injected `now`. The live
//    engine read lives in read-live-guardrails.ts; this file decodes what it is
//    handed, so it stays unit-testable against fixtures.
// 4. NO INTERNAL VOCABULARY in the human sentences. The hold-reason translation
//    is the canonical permission-lease one (hold-reason.ts).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { holdReasonSentence } from './hold-reason.ts';

// -----------------------------------------------------------------------------
// Output shape
// -----------------------------------------------------------------------------

/** Calm semantic color hint. Picks a color token; never a raw status code. */
export type GuardrailTone = 'safe' | 'caution' | 'live-money' | 'blocked' | 'unknown';

/** The latest order-check result, already translated to a human verdict. */
export type LatestCheckVerdict = 'allowed' | 'blocked' | 'none';

/** One plain lease-primitive statement (the check promise, the verdict, the
 *  agent's current hold) shown as a prose row. NOT a guardrail dimension — the
 *  dimensions are visual-database descriptors rendered generically by the panel. */
export interface GuardrailLine {
  /** Stable key for React lists. */
  key: string;
  /** The plain human sentence the user reads. */
  text: string;
  /** Second line giving more detail, when set. */
  detail?: string;
  /** Calm color hint for the row's status dot. */
  tone: GuardrailTone;
}

export interface LiveGuardrailsSurface {
  /** Big headline state, e.g. "Paper money only" / "Real money is ON". */
  headline: string;
  /** One calm sentence under the headline summarising the posture. */
  subhead: string;
  /** Color hint for the hero. */
  headlineTone: GuardrailTone;
  /** True only when the live rule actually allows real money. */
  realMoneyOn: boolean;
  /** The order-check gate, always shown (it is the core promise). */
  checkGate: GuardrailLine;
  /** The latest check result line (Allowed / Blocked / Needs a check). */
  latestCheck: GuardrailLine;
  latestVerdict: LatestCheckVerdict;
  /**
   * What the agent is doing right now, in plain words — present ONLY when the
   * live cycle actually carries a reason. Two-level safety: a system stop
   * (rule switched off) outranks an agent self-pause. Null until the agent is
   * running and has written a reason.
   */
  agentStatus: GuardrailLine | null;
  /** True when the agent has paused itself (its reason is a self-stop). */
  agentSelfHalted: boolean;
  /** One honest sentence about what switching to live money requires. */
  liveSwitchNote: string;
  /** True when neither live record could be read (loading / not connected). */
  recordsMissing: boolean;
  /**
   * The lease projected into ONE visual-database record: the record payload IS the
   * lease payload (so every guardrail field descriptor's `paths` resolve), plus
   * a human `humanLabel` so it passes visual-database's human-record gate. The
   * panel decodes this with the guardrails field/view descriptors (DATA) and
   * renders the lease's self-describing fields generically. Null when the lease
   * is missing (the surface then shows the protected/not-connected posture).
   */
  leaseRecord: GuardrailLeaseRecord | null;
}

/** The lease projected as a visual-database record payload (lease fields + a human
 *  title). Generic on purpose — the surface never names the cap fields. */
export interface GuardrailLeaseRecord {
  /** Stable record id (the lease ref). */
  id: string;
  /** The whole projected payload (lease fields + humanLabel) the descriptors read. */
  payload: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Safe field readers
// -----------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Agent facts are stored as `attribute_fact` rows whose real payload is a JSON
 * string in `value_json`. The lease is stored as a plain object. This unwraps
 * either form so callers can hand us the raw read-current payload directly.
 */
export function unwrapFactPayload(raw: unknown): Record<string, unknown> | null {
  const object = asObject(raw);
  if (!object) return null;
  const valueJson = asString(object.value_json);
  if (valueJson) {
    try {
      return asObject(JSON.parse(valueJson));
    } catch {
      return null;
    }
  }
  return object;
}

// -----------------------------------------------------------------------------
// Latest-check translation (lease-primitive Physics, not a dimension)
// -----------------------------------------------------------------------------

/**
 * Translates the most recent order check into a plain verdict. The raw `result`
 * value (`granted`/`denied`/...) and revoked/expired flags never escape — only
 * Allowed / Blocked / Needs a check.
 */
function readLatestCheck(latest: Record<string, unknown> | null, now: Date): {
  line: GuardrailLine;
  verdict: LatestCheckVerdict;
} {
  if (!latest) {
    return {
      verdict: 'none',
      line: {
        key: 'latest-check',
        text: 'No order has been checked yet.',
        detail: 'The first order the agent tries will be checked before it can go live.',
        tone: 'caution',
      },
    };
  }

  const result = asString(latest.result) ?? asString(latest.Result);
  const revoked = latest.revoked === true;
  const expiresAt = asString(latest.expires_at) ?? asString(latest.expiresAt);
  const expired = latest.expired === true || (expiresAt ? Date.parse(expiresAt) <= now.getTime() : false);
  const allowed = result === 'granted' && !revoked && !expired;

  if (allowed) {
    return {
      verdict: 'allowed',
      line: {
        key: 'latest-check',
        text: 'The last order was allowed.',
        detail: 'The agent can trade within the limits below.',
        tone: 'safe',
      },
    };
  }

  return {
    verdict: 'blocked',
    line: {
      key: 'latest-check',
      text: 'The last order was blocked.',
      detail: 'Nothing went through — the order did not meet the rules above.',
      tone: 'blocked',
    },
  };
}

// -----------------------------------------------------------------------------
// Agent-reason translation (what the agent is doing right now)
// -----------------------------------------------------------------------------

/** The hold-reason codes the agent treats as a SELF-STOP (it paused itself),
 *  distinct from a system stop (the rule switched off). `kill-switch` is the
 *  loss-limit halt. The human sentence comes from the canonical hold-reason.ts. */
const SELF_HALT_REASONS: ReadonlySet<string> = new Set(['kill-switch']);

/** True when the cycle's hold reason means the agent stopped ITSELF. */
function isSelfHalt(reason: string | undefined): boolean {
  return reason !== undefined && SELF_HALT_REASONS.has(reason);
}

// -----------------------------------------------------------------------------
// The decoder
// -----------------------------------------------------------------------------

export interface LiveGuardrailsInput {
  /** Raw read-current payload of the trading-rule (lease) record. */
  rule?: unknown;
  /** Raw read-current payload of the agent's latest cycle fact. */
  cycle?: unknown;
  /** Raw read-current payload of the latest order-check record, if any. */
  latestCheck?: unknown;
}

/**
 * Build the human Guardrails surface from the live records. Safe to call with
 * any field missing — it degrades to the protected posture and omits lines it
 * cannot honestly produce. The guardrail DIMENSIONS are NOT produced here; the
 * panel renders them from the lease record (`leaseRecord`) + descriptor DATA.
 */
export function buildLiveGuardrailsSurface(
  input: LiveGuardrailsInput = {},
  now: Date = new Date(),
): LiveGuardrailsSurface {
  const rule = unwrapFactPayload(input.rule);
  const cycle = unwrapFactPayload(input.cycle);
  const latestCheck = unwrapFactPayload(input.latestCheck);
  const recordsMissing = !rule && !cycle;

  // Real money is ON only when the live rule explicitly says so. Pessimistic by
  // default: anything missing or unreadable resolves to paper.
  const realMoneyOn = rule?.live_money_allowed === true;
  const revoked = rule?.revoked === true;

  // What the agent is doing right now — present only when the live cycle carries
  // a reason code (absent until the agent is running). A `kill-switch` reason
  // and/or an explicit `halted: true` flag is the agent pausing itself.
  const holdReason = asString(cycle?.hold_reason);
  const thresholdPct = asNumber(cycle?.target_pct) ?? asNumber(cycle?.threshold_pct) ?? null;
  const haltedFlag = cycle?.halted === true;
  const agentSelfHalted = isSelfHalt(holdReason) || haltedFlag;
  const reasonSentence = holdReasonSentence(holdReason ?? (haltedFlag ? 'kill-switch' : null), thresholdPct);
  const agentStatus: GuardrailLine | null = reasonSentence
    ? {
        key: 'agent-status',
        text: reasonSentence,
        tone: agentSelfHalted ? 'blocked' : 'caution',
      }
    : null;

  const headline = realMoneyOn ? 'Real money is ON' : 'Paper money only';
  const headlineTone: GuardrailTone = realMoneyOn ? 'live-money' : 'safe';
  const subhead = realMoneyOn
    ? 'The agent can place orders with real money, inside the limits below.'
    : 'The agent is practising with fake money. Your real money cannot be touched.';

  // The check gate — the core promise, always shown. Two-level safety: a system
  // stop (the rule switched off) outranks an agent self-pause.
  const checkGate: GuardrailLine = {
    key: 'check-gate',
    text: 'Every order is checked before it can go live.',
    detail: revoked
      ? 'Trading is switched off right now — no orders will be sent.'
      : agentSelfHalted
        ? 'The agent has paused itself — no orders will be sent until it resumes.'
        : 'Orders run only when the latest check says yes.',
    tone: revoked || agentSelfHalted ? 'blocked' : 'safe',
  };

  const { line: latestLine, verdict: latestVerdict } = readLatestCheck(latestCheck, now);

  const liveSwitchNote = realMoneyOn
    ? 'You turned real money on. Switch it back to paper any time to stop real orders.'
    : 'Real money stays off until you switch it on yourself. Nothing the agent does can flip it.';

  // Project the live lease into ONE visual-database record: the record payload IS
  // the lease payload (so every guardrail descriptor's `paths` resolve), plus a
  // human title so it passes visual-database's human-record gate. The dimensions
  // are NOT named here — the panel reads them from descriptor DATA.
  const leaseRecord: GuardrailLeaseRecord | null = rule
    ? {
        id: asString(rule.lease_ref) ?? 'permission-lease',
        payload: { ...rule, humanLabel: realMoneyOn ? 'Real-money trading' : 'Paper trading' },
      }
    : null;

  return {
    headline,
    subhead,
    headlineTone,
    realMoneyOn,
    checkGate,
    latestCheck: latestLine,
    latestVerdict,
    agentStatus,
    agentSelfHalted,
    liveSwitchNote,
    recordsMissing,
    leaseRecord,
  };
}
