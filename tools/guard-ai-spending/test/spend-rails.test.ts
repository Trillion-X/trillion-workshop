// Spend rails as DATA. Ported from bitfield-packages packages/agent-wallet/read-data/spend-rails.test.ts (3 cases)
// and the rail case of packages/payment-adapter/tests/payment-adapter-backend.test.ts (1 case). Changed: the rails
// come from this folder's spend-rails.json instead of the old package manifest, an invoke names a Workshop tool id
// instead of an old workflow action, and the "no workflow names x402" check reads this folder's tool rows.
import shipped from '../read-data/spend-rails.json' with { type: 'json' };
import toolRows from '../tool-rows.json' with { type: 'json' };
import { GUARD_TOOL, LEDGER_TOOL, readPaymentRail, readPaymentRails } from '../read-data/spend-rails.ts';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

const quintillionRail = {
  kind: 'payment-rail-descriptor',
  id: 'payment-rail:quintillion',
  label: 'Quintillion Bank',
  enabled: true,
  spend_authority_ref: 'spend-authority:quintillion-bank',
  credential_ref: 'credential:quintillion-bank-login',
  guard_invoke: { tool: GUARD_TOOL },
  ledger_invoke: { tool: LEDGER_TOOL },
  settlement_invoke: { tool: 'tool:settle-a-quintillion-payment' },
  evidence_contract: {
    session_intent_kind: 'operation-session-intent-record',
    evidence_ref: 'operation-evidence:quintillion-settlement',
    projection_ref: 'operation-projection:quintillion-readable-status',
  },
  metadata: { service_vendor: 'quintillion' },
};

describe('spend rails as DATA', () => {
  it('keeps x402 as exactly one disabled rail, never the generic spend owner', () => {
    const rails = readPaymentRails(shipped.rails);
    expect(rails).toHaveLength(1);
    expect(rails[0]).toMatchObject({
      id: 'payment-rail:x402',
      enabled: false,
      guardInvoke: { tool: GUARD_TOOL },
      ledgerInvoke: { tool: LEDGER_TOOL },
    });

    for (const record of toolRows.records) {
      expect(JSON.stringify(record.payload.invoke)).not.toContain('x402');
      expect(record.payload.id).not.toContain('x402');
    }
  });

  it('accepts the next rail through the same capability contract with no code branch', () => {
    expect(readPaymentRail(quintillionRail)).toMatchObject({
      kind: 'payment-rail-descriptor',
      id: 'payment-rail:quintillion',
      enabled: true,
      spendAuthorityRef: 'spend-authority:quintillion-bank',
      guardInvoke: { tool: GUARD_TOOL },
      ledgerInvoke: { tool: LEDGER_TOOL },
      evidenceContract: { projectionRef: 'operation-projection:quintillion-readable-status' },
    });
  });

  it('rejects a rail that bypasses the fail-closed guard or ledger contract', () => {
    expect(readPaymentRail({ ...quintillionRail, guard_invoke: { tool: 'tool:pay-directly' } })).toBeNull();
    expect(readPaymentRail({ ...quintillionRail, ledger_invoke: { tool: 'tool:provider-ledger' } })).toBeNull();
  });

  it('uses one rail capability contract for known and future settlement rails', () => {
    const quintillion = readPaymentRail({
      ...quintillionRail,
      label: 'Quintillion',
      settlement_invoke: { tool: 'tool:quintillion-settle' },
      evidence_contract: {
        session_intent_kind: 'operation-session-intent-record',
        evidence_ref: 'operation-evidence:quintillion',
        projection_ref: 'operation-projection:quintillion-readable-status',
      },
    });

    expect(quintillion).toMatchObject({
      guardInvoke: { tool: GUARD_TOOL },
      ledgerInvoke: { tool: LEDGER_TOOL },
      evidenceContract: { sessionIntentKind: 'operation-session-intent-record' },
    });
  });
});
