import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  buildLiveGuardrailsSurface,
  unwrapFactPayload,
} from './live-guardrails-surface.ts';

const NOW = new Date('2026-06-19T12:00:00.000Z');

// The live paper rule, exactly as read from the log today.
const PAPER_RULE = {
  kind: 'permission_lease',
  lease_ref: 'permission-lease:default-paper-trading',
  mode: 'paper',
  live_money_allowed: false,
  allowed_actions: ['trade-order.paper-submit'],
  allowed_symbols: ['AAPL'],
  max_order_notional: 1000,
  max_daily_notional: 5000,
  connector_ref: 'paper-simulator',
  revoked: false,
  expires_at: null,
};

// The live agent cycle fact, wrapped in an attribute_fact row.
const CYCLE_FACT = {
  table: 'attribute_fact',
  subject_id: 'agent:trading-momentum',
  property_id: 'last_cycle',
  type_id: 'type:json',
  value_json: JSON.stringify({
    equity: 100000,
    daily_pl_pct: 0,
    target_pct: 5,
    on_target: false,
    open_orders: 6,
    orders_placed: 0,
    decisions: [],
  }),
};

describe('live guardrails surface', () => {
  it('reads the live paper posture into the headline + subhead', () => {
    const surface = buildLiveGuardrailsSurface({ rule: PAPER_RULE, cycle: CYCLE_FACT }, NOW);

    expect(surface.headline).toBe('Paper money only');
    expect(surface.realMoneyOn).toBe(false);
    expect(surface.headlineTone).toBe('safe');
    expect(surface.checkGate.text).toBe('Every order is checked before it can go live.');
    expect(surface.recordsMissing).toBe(false);
  });

  it('projects the live lease into ONE visual-database record (payload IS the lease + a human title)', () => {
    const surface = buildLiveGuardrailsSurface({ rule: PAPER_RULE }, NOW);

    expect(surface.leaseRecord).not.toBeNull();
    expect(surface.leaseRecord?.id).toBe('permission-lease:default-paper-trading');
    // The dimension VALUES ride on the record payload (descriptors read them);
    // the decoder does NOT enumerate/label them — that is descriptor DATA.
    expect(surface.leaseRecord?.payload.max_order_notional).toBe(1000);
    expect(surface.leaseRecord?.payload.max_daily_notional).toBe(5000);
    expect(surface.leaseRecord?.payload.allowed_symbols).toEqual(['AAPL']);
    expect(surface.leaseRecord?.payload.live_money_allowed).toBe(false);
    // A human title so the record passes visual-database's human-record gate.
    expect(surface.leaseRecord?.payload.humanLabel).toBe('Paper trading');
  });

  it('projects ANY dimension the lease carries — a different venue renders by DATA alone', () => {
    // A venue whose lease carries DIFFERENT guardrail fields. The decoder does
    // not know these names; it projects them onto the record payload verbatim,
    // so descriptor DATA renders them with ZERO decoder change.
    const schwabLease = {
      kind: 'permission_lease',
      lease_ref: 'permission-lease:schwab-options',
      live_money_allowed: true,
      max_open_positions: 3,
      max_leverage: 2,
      allowed_asset_classes: ['option', 'equity'],
      revoked: false,
    };
    const surface = buildLiveGuardrailsSurface({ rule: schwabLease }, NOW);

    expect(surface.leaseRecord?.payload.max_open_positions).toBe(3);
    expect(surface.leaseRecord?.payload.max_leverage).toBe(2);
    expect(surface.leaseRecord?.payload.allowed_asset_classes).toEqual(['option', 'equity']);
    // Real money posture flows from the same generic field, no special-casing.
    expect(surface.realMoneyOn).toBe(true);
    expect(surface.leaseRecord?.payload.humanLabel).toBe('Real-money trading');
  });

  it('flips to a live-money posture only when the rule explicitly allows it', () => {
    const surface = buildLiveGuardrailsSurface(
      { rule: { ...PAPER_RULE, live_money_allowed: true } },
      NOW,
    );

    expect(surface.headline).toBe('Real money is ON');
    expect(surface.realMoneyOn).toBe(true);
    expect(surface.headlineTone).toBe('live-money');
    expect(surface.liveSwitchNote).toContain('Switch it back to paper');
  });

  it('is pessimistic when records are missing — never claims real money or a lease record', () => {
    const surface = buildLiveGuardrailsSurface({}, NOW);

    expect(surface.realMoneyOn).toBe(false);
    expect(surface.headline).toBe('Paper money only');
    expect(surface.recordsMissing).toBe(true);
    expect(surface.latestVerdict).toBe('none');
    expect(surface.leaseRecord).toBeNull();
  });

  it('translates a granted check into "allowed" and a denied check into "blocked"', () => {
    const allowed = buildLiveGuardrailsSurface(
      { rule: PAPER_RULE, latestCheck: { kind: 'permission_lease_check', result: 'granted', revoked: false } },
      NOW,
    );
    const blocked = buildLiveGuardrailsSurface(
      { rule: PAPER_RULE, latestCheck: { kind: 'permission_lease_check', result: 'denied', revoked: false } },
      NOW,
    );

    expect(allowed.latestVerdict).toBe('allowed');
    expect(allowed.latestCheck.text).toBe('The last order was allowed.');
    expect(blocked.latestVerdict).toBe('blocked');
    expect(blocked.latestCheck.text).toBe('The last order was blocked.');
  });

  it('treats a revoked rule as trading switched off', () => {
    const surface = buildLiveGuardrailsSurface({ rule: { ...PAPER_RULE, revoked: true } }, NOW);

    expect(surface.checkGate.tone).toBe('blocked');
    expect(surface.checkGate.detail).toContain('switched off');
  });

  it('shows no agent status until the live cycle carries a reason', () => {
    const surface = buildLiveGuardrailsSurface({ rule: PAPER_RULE, cycle: CYCLE_FACT }, NOW);

    // The live cycle today has no hold_reason -> no invented status.
    expect(surface.agentStatus).toBeNull();
    expect(surface.agentSelfHalted).toBe(false);
  });

  it('reads an agent self-halt (kill-switch) as a self-stop, via the canonical hold-reason sentence', () => {
    const cycle = {
      table: 'attribute_fact',
      value_json: JSON.stringify({ equity: 100000, hold_reason: 'kill-switch' }),
    };
    const surface = buildLiveGuardrailsSurface({ rule: PAPER_RULE, cycle }, NOW);

    expect(surface.agentSelfHalted).toBe(true);
    // Canonical hold-reason.ts phrasing for kill-switch (capital protection halt).
    expect(surface.agentStatus?.text).toContain('loss limit');
    expect(surface.agentStatus?.tone).toBe('blocked');
    // The check gate reflects the agent self-pause, not "switched off" (the rule).
    expect(surface.checkGate.tone).toBe('blocked');
    expect(surface.checkGate.detail).toContain('paused itself');
  });

  it('also treats an explicit halted flag as an agent self-halt', () => {
    const cycle = { value_json: JSON.stringify({ equity: 100000, halted: true }) };
    const surface = buildLiveGuardrailsSurface({ rule: PAPER_RULE, cycle }, NOW);

    expect(surface.agentSelfHalted).toBe(true);
    expect(surface.agentStatus).not.toBeNull();
  });

  it('translates a non-halt hold reason into a calm waiting status (canonical sentence)', () => {
    const cycle = {
      value_json: JSON.stringify({ equity: 100000, target_pct: 5, hold_reason: 'no-signal-above-threshold' }),
    };
    const surface = buildLiveGuardrailsSurface({ rule: PAPER_RULE, cycle }, NOW);

    expect(surface.agentSelfHalted).toBe(false);
    expect(surface.agentStatus?.tone).toBe('caution');
    // Canonical sentence names the configured momentum gate.
    expect(surface.agentStatus?.text).toContain('momentum gate');
  });

  it('system revocation outranks an agent self-pause in the check gate', () => {
    // Both signals present: the rule is switched off AND the agent paused itself.
    const cycle = { value_json: JSON.stringify({ hold_reason: 'kill-switch' }) };
    const surface = buildLiveGuardrailsSurface(
      { rule: { ...PAPER_RULE, revoked: true }, cycle },
      NOW,
    );

    // The stronger statement (rule switched off) wins the gate detail.
    expect(surface.checkGate.detail).toContain('switched off');
    // The agent self-halt is still surfaced separately.
    expect(surface.agentSelfHalted).toBe(true);
  });

  it('never leaks internal vocabulary into the human sentences', () => {
    const surface = buildLiveGuardrailsSurface({ rule: PAPER_RULE, cycle: CYCLE_FACT }, NOW);
    // Only the human-sentence fields are subject to the no-vocabulary rule. The
    // leaseRecord payload intentionally carries raw lease fields (the descriptors
    // translate them) — it is NOT human copy, so it is excluded here.
    const allText = JSON.stringify({
      headline: surface.headline,
      subhead: surface.subhead,
      checkGate: surface.checkGate,
      latestCheck: surface.latestCheck,
      agentStatus: surface.agentStatus,
      liveSwitchNote: surface.liveSwitchNote,
    });

    for (const banned of [
      'lease',
      'owner',
      'slot',
      'workflow',
      'connector_ref',
      'allowed_actions',
      'on_target',
      'hold_reason',
      'operation:',
      'granted',
      'denied',
      'trade-order.paper-submit',
    ]) {
      expect(allText).not.toContain(banned);
    }
  });

  it('unwraps both attribute_fact value_json and plain object payloads', () => {
    expect(unwrapFactPayload(CYCLE_FACT)?.equity).toBe(100000);
    expect(unwrapFactPayload(PAPER_RULE)?.max_order_notional).toBe(1000);
    expect(unwrapFactPayload(null)).toBeNull();
    expect(unwrapFactPayload({ value_json: 'not json' })).toBeNull();
  });
});
