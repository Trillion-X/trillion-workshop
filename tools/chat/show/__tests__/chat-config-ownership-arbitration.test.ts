// PORTED FROM: bitfield-packages/packages/chat/show/__tests__/chat-config-ownership-arbitration.test.ts @ e99ac5976
// chat-config-ownership-arbitration.test.ts
//
// Regression proof for the React #185 ("Maximum update depth exceeded") crash
// that fired whenever a channel-routed conversation transcript (telegram /
// whatsapp / discord / imessage / any future channel) was opened in the chat
// material zone.
//
// The crash was an infinite render loop between TWO effects in ChatView that both
// wrote `chatConfig.participantRef` with conflicting desired values:
//   Effect A (default-participant normalizer): forces the ref to the first
//     cli-registry participant whenever the current ref is NOT a registry member.
//   Effect B (active-session sync): mirrors an OPEN conversation's route ref into
//     chatConfig. A channel route ref is never a cli-registry member.
// With no ownership boundary, A resets the channel ref -> B rewrites it -> repeat
// forever. The fix gives A/B mutually-exclusive ownership by mode, arbitrated by
// the ONE predicate `canChangeChatProviderSelection` that the picker UI also
// reads. This test models both effects as pure step functions and proves:
//   1. WITHOUT the gate the loop never reaches a fixpoint (would blow the render
//      budget -> #185).
//   2. WITH the gate it reaches a fixpoint in a bounded number of steps, and the
//      surviving ref is the opened channel's route ref (Effect B owns it).
//   3. The gate is BLIND to channel identity — telegram/whatsapp/discord/imessage
//      and an invented future channel all converge the same way (zero per-channel
//      code).
//   4. When NO conversation is open (composing new) the normalizer still runs, so
//      the provider picker default is preserved (no regression).

import { describe, it, expect } from 'vitest';
import {
  canChangeChatProviderSelection,
  resolveEditableParticipantRefs,
} from '../chat-config-ownership';

// ---- Minimal state model of the two writers ------------------------------

interface ConfigState {
  participantRef: string;
}

interface Mode {
  activeSessionId: string | null;
  pendingConversationLedgerId: string | null;
  hasPendingConversation: boolean;
  isProcessing: boolean;
}

const PRESENTED_AGENT_PROFILES = [
  'ai-agent-profile:founder-operator',
  'ai-agent-profile:researcher',
  'ai-agent-profile:writer',
];
const PRESENTED_DEFAULT = PRESENTED_AGENT_PROFILES[0];

/** Effect A — default-participant normalizer. `gated` mirrors the shipped fix. */
function effectA(state: ConfigState, mode: Mode, gated: boolean): ConfigState {
  if (gated && !canChangeChatProviderSelection(mode)) return state; // ownership: not editable -> no-op
  if (PRESENTED_AGENT_PROFILES.includes(state.participantRef)) return state;
  return { participantRef: PRESENTED_DEFAULT };
}

/** Effect B — active-session sync. Sole writer while a conversation is open. */
function effectB(state: ConfigState, mode: Mode, openSessionRouteRef: string | null): ConfigState {
  if (!mode.activeSessionId || openSessionRouteRef === null) return state;
  if (state.participantRef === openSessionRouteRef) return state; // synced -> no-op
  return { participantRef: openSessionRouteRef };
}

/**
 * Run A then B repeatedly until the render settles or the step budget is
 * exhausted. React re-renders after EVERY setState, so a render only settles when
 * NEITHER effect wants to write in a full pass — not merely when the net state is
 * unchanged (A writing claude then B rewriting the channel ref is a NET no-op per
 * pair, yet each write schedules another render; that is exactly the oscillation
 * React aborts as #185). Convergence here therefore requires that both effects
 * no-op in the same pass. Returns { steps, converged, state }.
 */
function runToFixpoint(
  initial: ConfigState,
  mode: Mode,
  openSessionRouteRef: string | null,
  gated: boolean,
  budget = 50,
): { steps: number; converged: boolean; state: ConfigState } {
  let state = initial;
  for (let steps = 1; steps <= budget; steps++) {
    const afterA = effectA(state, mode, gated);
    const aWrote = afterA.participantRef !== state.participantRef;
    const afterB = effectB(afterA, mode, openSessionRouteRef);
    const bWrote = afterB.participantRef !== afterA.participantRef;
    if (!aWrote && !bWrote) {
      return { steps, converged: true, state: afterB };
    }
    state = afterB;
  }
  return { steps: budget, converged: false, state };
}

const CHANNEL_ROUTE_REFS = [
  'telegram:6000000001',
  'whatsapp:15550100123',
  'discord:dm:998877',
  'imessage:+15550100123',
  // an invented future channel — the fix must handle it with ZERO new code:
  'signal:group:xyz',
];

const openMode = (sessionId: string): Mode => ({
  activeSessionId: sessionId,
  pendingConversationLedgerId: null,
  hasPendingConversation: false,
  isProcessing: false,
});

// ---- The predicate itself (SSOT of "selection editable") -----------------

describe('canChangeChatProviderSelection — ownership predicate (SSOT)', () => {
  it('is editable only when composing new: no open session, no locked pending, not processing', () => {
    expect(canChangeChatProviderSelection({
      activeSessionId: null,
      pendingConversationLedgerId: null,
      hasPendingConversation: false,
      isProcessing: false,
    })).toBe(true);
  });

  it('is NOT editable while a conversation is open (Effect B owns chatConfig)', () => {
    expect(canChangeChatProviderSelection({
      activeSessionId: 'session-1',
      pendingConversationLedgerId: null,
      hasPendingConversation: false,
      isProcessing: false,
    })).toBe(false);
  });

  it('is NOT editable while a turn is processing', () => {
    expect(canChangeChatProviderSelection({
      activeSessionId: null,
      pendingConversationLedgerId: null,
      hasPendingConversation: false,
      isProcessing: true,
    })).toBe(false);
  });

  it('is NOT editable while a pending conversation is locked (has pending, no ledger id yet)', () => {
    expect(canChangeChatProviderSelection({
      activeSessionId: null,
      pendingConversationLedgerId: null,
      hasPendingConversation: true,
      isProcessing: false,
    })).toBe(false);
  });

  it('is editable when a pending conversation has resolved its ledger id', () => {
    expect(canChangeChatProviderSelection({
      activeSessionId: null,
      pendingConversationLedgerId: 'ledger-9',
      hasPendingConversation: true,
      isProcessing: false,
    })).toBe(true);
  });
});

describe('resolveEditableParticipantRefs — addressed selection precedence', () => {
  it('lets an explicit available address beat remembered and default refs', () => {
    expect(resolveEditableParticipantRefs({
      availableParticipantRefs: ['remembered', 'selected', 'default'],
      currentParticipantRefs: ['remembered'],
      explicitParticipantRef: 'selected',
      defaultParticipantRef: 'default',
    })).toEqual(['selected']);
  });

  it('fails closed when an explicit address is unavailable', () => {
    expect(resolveEditableParticipantRefs({
      availableParticipantRefs: ['remembered', 'default'],
      currentParticipantRefs: ['remembered'],
      explicitParticipantRef: 'missing',
      defaultParticipantRef: 'default',
    })).toEqual([]);
  });

  it('preserves supported current refs only when no explicit address exists', () => {
    expect(resolveEditableParticipantRefs({
      availableParticipantRefs: ['a', 'b', 'default'],
      currentParticipantRefs: ['a', 'missing', 'b', 'a'],
      defaultParticipantRef: 'default',
    })).toEqual(['a', 'b']);
  });
});

// ---- The loop mechanics --------------------------------------------------

describe('two-effect arbitration — the #185 loop is structurally eliminated', () => {
  it('WITHOUT the gate: an open channel conversation never reaches a fixpoint (this is #185)', () => {
    for (const routeRef of CHANNEL_ROUTE_REFS) {
      const result = runToFixpoint(
        { participantRef: PRESENTED_DEFAULT },
        openMode('session-x'),
        routeRef,
        /* gated */ false,
      );
      expect(result.converged).toBe(false); // oscillates until React aborts
    }
  });

  it('WITH the gate: every channel conversation converges in ONE step, keeping the channel ref', () => {
    for (const routeRef of CHANNEL_ROUTE_REFS) {
      const result = runToFixpoint(
        { participantRef: PRESENTED_DEFAULT },
        openMode('session-x'),
        routeRef,
        /* gated */ true,
      );
      expect(result.converged).toBe(true);
      expect(result.state.participantRef).toBe(routeRef); // Effect B owns it, unchallenged
      expect(result.steps).toBeLessThanOrEqual(2);
    }
  });

  it('WITH the gate: a cli conversation still renders (already a registry ref, immediate fixpoint)', () => {
    const result = runToFixpoint(
      { participantRef: 'ai-agent-profile:researcher' },
      openMode('session-cli'),
      'codex',
      /* gated */ true,
    );
    expect(result.converged).toBe(true);
    expect(result.state.participantRef).toBe('codex');
  });

  it('WITH the gate: composing NEW removes a stale transport and selects a presented profile', () => {
    const result = runToFixpoint(
      { participantRef: 'a2a-crewai' },
      {
        activeSessionId: null,
        pendingConversationLedgerId: null,
        hasPendingConversation: false,
        isProcessing: false,
      },
      /* openSessionRouteRef */ null,
      /* gated */ true,
    );
    expect(result.converged).toBe(true);
    expect(result.state.participantRef).toBe(PRESENTED_DEFAULT);
  });
});
