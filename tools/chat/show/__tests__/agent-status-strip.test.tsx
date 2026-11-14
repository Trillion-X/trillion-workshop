// PORTED FROM: bitfield-packages/packages/chat/show/__tests__/agent-status-strip.test.tsx @ e99ac5976
// AgentStatusStrip + build-agent-status-sessions — offline render-harness proof.
//
// Proves the Cursor-style agent/model header chip strip (contract §3/§9.4) is
// fully DATA-driven:
//   (1) the builder fans the active turn's phase across its participants → chips
//       with the universal mark; null turn or no participants → no chips;
//   (2) the strip renders a chip per session with the right status pill text
//       (Working Ns / Thinking / Done / Failed);
//   (3) no sessions → renders nothing (no filler).
// Zero hardcoded CLI/model names — every chip comes from participant data.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AgentStatusStrip, statusLabel } from '../AgentStatusStrip';
import {
  buildAgentStatusSessions,
  type AgentSessionStatus,
} from '../build-agent-status-sessions';
import type { AddressedParticipantInfo } from '../../read-data/read-addressed-exchange-participants';

afterEach(cleanup);

function participant(ref: string, label: string): AddressedParticipantInfo {
  return {
    participantRef: ref,
    label,
    models: [],
    adapter: { kind: 'process-session' },
    accounts: [],
    connectionStates: [],
    routeRefs: [],
    setupRouteRefs: [],
    connectionStateRefs: [],
    ingestionRouteRefs: [],
    resultProjectionRefs: [],
    streamParseSpecRefs: [],
    proofRefs: [],
    blockerRefs: [],
  } as unknown as AddressedParticipantInfo;
}

describe('buildAgentStatusSessions (pure projection)', () => {
  it('null turn or no participants → no chips', () => {
    expect(buildAgentStatusSessions(null, [participant('codex', 'Codex')])).toHaveLength(0);
    expect(buildAgentStatusSessions({ phase: 'working' }, [])).toHaveLength(0);
  });

  it('fans the turn phase across participants with the universal mark', () => {
    const out = buildAgentStatusSessions(
      { phase: 'working', startedAtMs: 1000 },
      [participant('codex', 'Codex'), participant('claude', 'Claude')],
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ key: 'codex', label: 'Codex', phase: 'working', startedAtMs: 1000 });
    expect(out[0].mark.name).toBe('Codex');
    expect(out[1]).toMatchObject({ key: 'claude', label: 'Claude', phase: 'working' });
  });

  it('carries an error message through', () => {
    const out = buildAgentStatusSessions({ phase: 'error', message: 'needs a key' }, [participant('gemini', 'Gemini')]);
    expect(out[0]).toMatchObject({ phase: 'error', message: 'needs a key' });
  });
});

describe('statusLabel (pure)', () => {
  it('maps each phase to its pill text', () => {
    expect(statusLabel({ key: 'a', label: 'A', mark: { name: 'A' }, phase: 'thinking' } as AgentSessionStatus)).toBe('Working');
    expect(statusLabel({ key: 'a', label: 'A', mark: { name: 'A' }, phase: 'done' } as AgentSessionStatus)).toBe('Done');
    expect(statusLabel({ key: 'a', label: 'A', mark: { name: 'A' }, phase: 'error' } as AgentSessionStatus)).toBe('Failed');
    // No startedAtMs → plain "Working" (no NaN).
    expect(statusLabel({ key: 'a', label: 'A', mark: { name: 'A' }, phase: 'working' } as AgentSessionStatus)).toBe('Working');
  });
});

describe('AgentStatusStrip (blind presentation)', () => {
  it('renders nothing when there are no sessions', () => {
    const { container } = render(<AgentStatusStrip sessions={[]} />);
    expect(container.textContent).toBe('');
  });

  it('renders a chip per session with label + status pill', () => {
    const sessions = buildAgentStatusSessions(
      { phase: 'done' },
      [participant('codex', 'Codex'), participant('claude', 'Claude')],
    );
    render(<AgentStatusStrip sessions={sessions} />);
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getAllByText('Done')).toHaveLength(2);
  });

  it('shows a Failed pill for an error session', () => {
    const sessions = buildAgentStatusSessions({ phase: 'error', message: 'x' }, [participant('gemini', 'Gemini')]);
    render(<AgentStatusStrip sessions={sessions} />);
    expect(screen.getByText('Gemini')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
  });
});
