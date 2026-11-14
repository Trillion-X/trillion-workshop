// bitfield/packages/ai-action-guard/read-data/read-openbot-operator.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure, blind reader for the Union Operator Console. It turns three live DATA
// families that the autonomous-operator primitives publish into plain-language
// view models the surface renders:
//
//   1. ai-execution-step rows written by ai-action-guard/govern-computer-action
//      -> the governed-action feed (allow/deny, resolved-from-snapshot, recorded
//         before the effect).
//   2. permission_lease rows with lease_class "exclusive-control"
//      -> the one-driver takeover state (who holds the wheel).
//   3. ai-agent-profile rows (optionally carrying runtime_adapter_ref)
//      -> the brought-agents panel (how each agent connects).
//
// It imports NOTHING from permission-lease or ai-agent-profile. It reads their
// records only as opaque published payloads delivered over the Envelope by feed
// address. Composition-by-DATA, never crate coupling (L166, no god package).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure functions. No I/O, no fetch, no engine calls. Records in, view out.
// 2. The human-readable DECISIONS map is the single translation table from an
//    internal event/decision to a sentence (L169). Callers never re-branch it.
// 3. Record-ids, run_refs, rule-ids, snapshot-ids, addresses and adapter refs
//    are carried ONLY inside `proof` fields, never in the primary text.
// 4. Missing / malformed records are dropped, never rendered as broken rows.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export type PublishedRecord = { payload?: unknown };

// ---------------------------------------------------------------------------
// The translation table (ported from the openbot audit surface DECISIONS map).
// Internal decision source / lifecycle event -> the sentence an owner reads.
// This is the ONLY place these strings live (L169 canonical translation).
// ---------------------------------------------------------------------------
export const DECISIONS: Record<string, string> = {
  allow: 'Allowed',
  deny: 'Blocked',
  'no-match': 'Blocked',
  absent: 'Blocked',
  broken: 'Blocked',
  'did-not-happen': 'Did not happen',
  'control-taken': 'A person took the wheel',
  'control-released': 'The wheel was handed back',
  'secret-requested': 'The operator asked for a secret',
  'secret-supplied': 'A person supplied a secret',
};

export type DecisionTone = 'allowed' | 'blocked' | 'pending';

export type GovernedAction = {
  id: string;
  /** Plain sentence, e.g. "Clicked Submit order". */
  headline: string;
  /** The verb the operator ran, cleaned of the computer_ namespace. */
  verb: string;
  /** The server-resolved element name (never the caller's claimed label). */
  target: string;
  /** The page host the action touched, when it was a browser action. */
  host?: string;
  /** The caller's claimed label WHEN it differed from the resolved target. */
  relabeledFrom?: string;
  decisionLabel: string;
  tone: DecisionTone;
  /** Plain reason a rule gave, when present. */
  reason?: string;
  recordedAt?: string;
  proof: {
    stepId: string;
    runRef?: string;
    matchedRuleId?: string;
    snapshotId?: number | string;
    mode?: string;
    recordedBeforeEffect: boolean;
  };
};

export type ControlState = {
  /** 'trillion' when no live exclusive-control lease is held. */
  holder: 'trillion' | 'human' | string;
  /** Banner sentence. */
  headline: string;
  /** Sub-sentence explaining what it means for the operator. */
  detail: string;
  tone: 'idle' | 'human-holds';
  /** The one primary action label. */
  action: 'take-the-wheel' | 'hand-back';
  actionLabel: string;
  proof: {
    scopeRef?: string;
    holderSubjectRef?: string;
    since?: string;
    expiresAt?: string;
    reason?: string;
  };
};

export type BroughtAgent = {
  id: string;
  label: string;
  description?: string;
  status: string;
  /** Plain transport line, e.g. "Brought in over ag-ui". */
  transportLine: string;
  toolCount: number;
  proof: {
    runtimeAdapterRef?: string;
    modelRefs: string[];
    toolRefs: string[];
  };
};

export type OperatorConsoleData = {
  actions: GovernedAction[];
  control: ControlState;
  agents: BroughtAgent[];
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
/** The last human segment of a dotted/namespaced reference, title-cased. */
function humanizeRef(value: string): string {
  const seg = value.split(/[.:/]/).filter(Boolean).at(-1) ?? value;
  const words = seg.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}
/** Cleaned verb: computer_click -> "clicked", browser_navigate -> "navigated". */
function verbOf(tool: string | undefined, intent: string | undefined): string {
  const raw = (tool ?? intent ?? 'acted').replace(/^computer_|^browser_/, '');
  const map: Record<string, string> = {
    click: 'Clicked',
    type: 'Typed into',
    navigate: 'Navigated to',
    scroll: 'Scrolled',
    submit: 'Submitted',
    select: 'Selected',
    press: 'Pressed',
  };
  return map[raw] ?? humanizeRef(raw);
}

// ---------------------------------------------------------------------------
// governed-action feed (ai-execution-step rows)
// ---------------------------------------------------------------------------
export function readGovernedActions(records: readonly PublishedRecord[]): GovernedAction[] {
  const out: GovernedAction[] = [];
  for (const record of records) {
    const p = record.payload;
    if (!isRecord(p) || p.kind !== 'ai-execution-step') continue;
    if (p.step_kind !== undefined && p.step_kind !== 'governed-computer-action') {
      // Only computer-governance steps belong on this feed; other execution
      // steps (plan, ask, tool) are a different surface.
      continue;
    }
    const id = text(p.id);
    if (!id) continue;
    const el = isRecord(p.resolved_element) ? p.resolved_element : {};
    const resolvedName = text(el.name) ?? text(el.ref) ?? 'an element';
    const decision = isRecord(p.decision) ? p.decision : {};
    const source = text(decision.source) ?? (decision.allowed === true ? 'allow' : 'deny');
    const forward = decision.forward;
    // A row that was allowed by policy but never carried out is "Did not happen".
    const effectiveKey = source === 'allow' && forward === false ? 'did-not-happen' : source;
    const decisionLabel = DECISIONS[effectiveKey] ?? (decision.allowed === true ? 'Allowed' : 'Blocked');
    const tone: DecisionTone =
      decisionLabel === 'Allowed' ? 'allowed' : decisionLabel === 'Did not happen' ? 'pending' : 'blocked';
    const ctx = isRecord(p.context) ? p.context : {};
    const host = text(ctx.host);
    const verb = verbOf(text(p.tool), text(p.intent));

    out.push({
      id,
      verb,
      target: resolvedName,
      headline: `${verb} ${resolvedName}`,
      ...(host ? { host } : {}),
      ...(text(p.caller_label) && text(p.caller_label) !== resolvedName
        ? { relabeledFrom: text(p.caller_label) }
        : {}),
      decisionLabel,
      tone,
      ...(text(decision.reason) ? { reason: text(decision.reason) } : {}),
      ...(text(p.recorded_at) ? { recordedAt: text(p.recorded_at) } : {}),
      proof: {
        stepId: id,
        ...(text(p.run_ref) ? { runRef: text(p.run_ref) } : {}),
        ...(text(decision.matched_rule_id) ? { matchedRuleId: text(decision.matched_rule_id) } : {}),
        ...(p.snapshot_id != null ? { snapshotId: p.snapshot_id as number | string } : {}),
        ...(text(decision.mode) ? { mode: text(decision.mode) } : {}),
        // The row's existence IS the record-before-effect proof: the guard
        // writes this step before returning any forward token.
        recordedBeforeEffect: true,
      },
    });
  }
  // Newest first, by recorded_at when present, else by insertion (stable).
  return out.sort((a, b) => (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''));
}

// ---------------------------------------------------------------------------
// one-driver takeover (permission_lease exclusive-control rows)
// ---------------------------------------------------------------------------
export function readControlState(records: readonly PublishedRecord[]): ControlState {
  // A hand-back is a SEPARATE durable record, not a mutation of the lease. When a
  // person hands the wheel back, permission-lease.revoke-lease records a
  // `permission_lease_revocation` naming the released `lease_ref`; it does NOT flip
  // the original lease's `revoked` flag. So a handed-back lease still arrives here as
  // a live-looking `permission_lease` row. We must cross-reference the revocations,
  // exactly as the gateway does before it stops denying the operator.
  //
  // This mirrors permission-lease's pure core `decodeControlNotes` (the SSOT
  // of the rule): a lease is released iff its own payload says `revoked:true` OR a
  // revocation record names its `lease_ref`. The rule is replicated inline, not
  // imported, so this fold keeps its invariant of importing nothing from
  // permission-lease and treating every record as an opaque published payload (L166).
  const revokedLeaseRefs = new Set<string>();
  for (const record of records) {
    const p = record.payload;
    if (!isRecord(p) || p.kind !== 'permission_lease_revocation') continue;
    const ref = text(p.lease_ref);
    if (ref) revokedLeaseRefs.add(ref);
  }

  let held: Record<string, unknown> | undefined;
  for (const record of records) {
    const p = record.payload;
    if (!isRecord(p) || p.kind !== 'permission_lease') continue;
    if (p.lease_class !== 'exclusive-control') continue;
    if (p.revoked === true) continue;
    // A matching hand-back releases this lease even though its own flag is unset.
    const leaseRef = text(p.lease_ref);
    if (leaseRef && revokedLeaseRefs.has(leaseRef)) continue;
    // The most recent live hold wins.
    if (!held || String(p.since ?? '') > String(held.since ?? '')) held = p;
  }
  if (!held) {
    return {
      holder: 'trillion',
      headline: 'Trillion holds the wheel',
      detail: 'The operator is acting on its own. Take the wheel any time to step in.',
      tone: 'idle',
      action: 'take-the-wheel',
      actionLabel: 'Take the wheel',
      proof: {},
    };
  }
  const holder = text(held.holder) ?? 'human';
  const isHuman = holder === 'human';
  return {
    holder,
    headline: isHuman ? 'You have the wheel' : `${humanizeRef(holder)} has the wheel`,
    detail: 'Trillion is paused and will not act until the wheel is handed back.',
    tone: 'human-holds',
    action: 'hand-back',
    actionLabel: 'Hand back to Trillion',
    proof: {
      ...(text(held.scope_ref) ? { scopeRef: text(held.scope_ref) } : {}),
      ...(text(held.holder_subject_ref) ? { holderSubjectRef: text(held.holder_subject_ref) } : {}),
      ...(text(held.since) ? { since: text(held.since) } : {}),
      ...(text(held.expires_at) ? { expiresAt: text(held.expires_at) } : {}),
      ...(text(held.reason) ? { reason: text(held.reason) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// brought agents (ai-agent-profile rows)
// ---------------------------------------------------------------------------
/** Plain transport sentence derived from the runtime_adapter_ref, never the raw ref. */
function transportLine(adapterRef: string | undefined): string {
  if (!adapterRef) return 'Runs as a local process';
  const lower = adapterRef.toLowerCase();
  if (lower.includes('ag-ui')) return 'Brought in over ag-ui';
  if (lower.includes('a2a')) return 'Brought in over A2A';
  if (lower.includes('http')) return 'Brought in over a streaming connection';
  return `Brought in via ${humanizeRef(adapterRef)}`;
}

export function readBroughtAgents(records: readonly PublishedRecord[]): BroughtAgent[] {
  const out: BroughtAgent[] = [];
  for (const record of records) {
    const p = record.payload;
    if (!isRecord(p) || p.kind !== 'ai-agent-profile') continue;
    const id = text(p.id);
    if (!id) continue;
    const adapterRef = text(p.runtime_adapter_ref);
    const toolRefs = strArray(p.tool_refs);
    out.push({
      id,
      label: text(p.label) ?? humanizeRef(id),
      ...(text(p.description) ? { description: text(p.description) } : {}),
      status: text(p.status) ?? 'available',
      transportLine: transportLine(adapterRef),
      toolCount: toolRefs.length,
      proof: {
        ...(adapterRef ? { runtimeAdapterRef: adapterRef } : {}),
        modelRefs: strArray(p.model_refs),
        toolRefs,
      },
    });
  }
  // Brought-in (adapter) agents first, then the rest, each alphabetical by label.
  return out.sort((a, b) => {
    const aBrought = a.proof.runtimeAdapterRef ? 0 : 1;
    const bBrought = b.proof.runtimeAdapterRef ? 0 : 1;
    return aBrought - bBrought || a.label.localeCompare(b.label);
  });
}

// ---------------------------------------------------------------------------
// the whole console
// ---------------------------------------------------------------------------
export function readOperatorConsole(
  governedActionRecords: readonly PublishedRecord[],
  controlLeaseRecords: readonly PublishedRecord[],
  agentProfileRecords: readonly PublishedRecord[],
): OperatorConsoleData {
  return {
    actions: readGovernedActions(governedActionRecords),
    control: readControlState(controlLeaseRecords),
    agents: readBroughtAgents(agentProfileRecords),
  };
}
