// PORTED FROM: bitfield-packages/packages/chat/show/ParticipantBrowser.test.tsx @ e99ac5976
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ParticipantBrowser } from './ParticipantBrowser';
import type { AddressedParticipantInfo } from '../read-data/read-addressed-exchange-participants';

afterEach(cleanup);

function participant(
  participantRef: string,
  label: string,
  metadata: Record<string, unknown>,
): AddressedParticipantInfo {
  return {
    participantRef,
    label,
    adapter: { kind: 'process-session' },
    accounts: [],
    models: [],
    connectionStates: [],
    serviceConnectionRefs: [],
    requiresAuth: false,
    routeRefs: [],
    setupRouteRefs: [],
    connectionStateRefs: [],
    ingestionRouteRefs: [],
    resultProjectionRefs: [],
    streamParseSpecRefs: [],
    proofRefs: [],
    blockerRefs: [],
    metadata,
  } as unknown as AddressedParticipantInfo;
}

describe('ParticipantBrowser profile presentation', () => {
  it('uses the DATA-provided group label and exposes configuration only for eligible profiles', () => {
    const researcher = participant('profile:researcher', 'Researcher', {
      brandLabel: 'Your agents',
      participantKind: 'agent-profile',
    });
    const person = participant('person:alex', 'Alex', { brandLabel: 'People' });
    const onConfigureParticipant = vi.fn();

    render(
      <ParticipantBrowser
        open
        onClose={() => {}}
        participants={[researcher, person]}
        selectedParticipantRefs={[]}
        onSelectParticipant={() => {}}
        onDone={() => {}}
        onConnectParticipant={() => {}}
        canConfigureParticipant={(candidate) => candidate.participantRef === researcher.participantRef}
        onConfigureParticipant={onConfigureParticipant}
      />,
    );

    expect(screen.getByText('Your agents')).toBeTruthy();
    expect(screen.getByText('People')).toBeTruthy();
    expect(screen.queryByText('Process Session')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Configure Researcher' }));
    expect(onConfigureParticipant).toHaveBeenCalledWith(researcher);
    expect(screen.queryByRole('button', { name: 'Configure Alex' })).toBeNull();
  });
});
