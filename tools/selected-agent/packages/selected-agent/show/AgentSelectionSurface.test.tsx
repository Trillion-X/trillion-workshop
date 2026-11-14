import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useBitfieldDataMock = vi.fn();
const setSelectedAgentMock = vi.fn();

vi.mock('@bitfield/runtime-kit/react', () => ({
  useBitfieldData: (...args: unknown[]) => useBitfieldDataMock(...args),
}));
vi.mock('@/packages/selected-agent/do-work/set-selected-agent', () => ({
  SELECTED_AGENT_ACTION: 'action:update-selected-agent',
  setSelectedAgent: (...args: unknown[]) => setSelectedAgentMock(...args),
}));
vi.mock('@/packages/chat/show/input/unified-agent-picker', () => ({
  UnifiedAgentPicker: ({ onSelect, disabled }: {
    onSelect: (participantRef: string, modelId: string | null) => void;
    disabled: boolean;
  }) => (
    <button disabled={disabled} onClick={() => onSelect('profile:local', 'model:fast')}>
      Choose Local Agent
    </button>
  ),
}));
vi.mock('@/packages/ui', async () => {
  const actual = await vi.importActual<typeof import('@/packages/ui')>('@/packages/ui');
  return {
    ...actual,
    OpenSurfaceAction: ({ label, payload }: { label: string; payload: unknown }) => (
      <button data-payload={JSON.stringify(payload)}>{label}</button>
    ),
  };
});

import { AgentSelectionSurface } from './AgentSelectionSurface';

const cliRows = [
  { subject_id: 'cli:local', property_id: 'prop:cli_registry:cli', value: 'agent:local' },
  { subject_id: 'cli:local', property_id: 'prop:cli_registry:display_name', value: 'Local Agent' },
  { subject_id: 'cli:local', property_id: 'prop:cli_registry:models', value: [{ id: 'model:fast', label: 'Fast' }] },
];
const profileRows = [{ kind: 'ai-agent-profile', id: 'profile:local', label: 'Local Agent',
  instruction_refs: ['instruction:local'], model_refs: ['model:fast'] }];
const modelDescriptors = [{
  kind: 'ai-model-descriptor',
  id: 'model:fast',
  model_id: 'fast',
  provider_ref: 'provider:any',
  status: 'available',
}];
const providerFacts = [
  {
    subject_id: 'provider-routing:automatic',
    property_id: 'prop:provider_routing:policy',
    value: {
      kind: 'ai-provider-routing-policy',
      eligibility: [
        { property_id: 'prop:provider:availability', equals: 'available' },
        { property_id: 'prop:provider:authority', in: ['granted'] },
        { property_id: 'prop:provider:capability_refs', contains_all: ['capability:text-generation'] },
      ],
    },
  },
  { subject_id: 'provider:any', property_id: 'prop:provider:vendor', value: 'any' },
  { subject_id: 'provider:any', property_id: 'prop:provider:availability', value: 'available' },
  { subject_id: 'provider:any', property_id: 'prop:provider:authority', value: 'granted' },
  { subject_id: 'provider:any', property_id: 'prop:provider:capability_refs', value: ['capability:text-generation'] },
];

beforeEach(() => {
  setSelectedAgentMock.mockReset();
  setSelectedAgentMock.mockResolvedValue(undefined);
  useBitfieldDataMock.mockImplementation((name: string) => {
    if (name === 'cli-registry') return cliRows;
    if (name === 'agent-profile-participants') return profileRows;
    if (name === 'chat-model-descriptors') return modelDescriptors;
    if (name === 'provider-routing-facts') return providerFacts;
    return [];
  });
});

afterEach(cleanup);

describe('AgentSelectionSurface', () => {
  it('renders live options and dispatches the selected-agent owner action', async () => {
    render(<AgentSelectionSurface surfaceInput={{ selection_action_ref: 'action:update-selected-agent' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose Local Agent' }));

    await waitFor(() => expect(setSelectedAgentMock).toHaveBeenCalledWith(
      'profile:local',
      'action:update-selected-agent',
    ));
    expect(screen.getByText('Saving your choice...')).toBeTruthy();
  });

  it('reports owner failure without claiming the choice changed', async () => {
    setSelectedAgentMock.mockRejectedValue(new Error('owner unavailable'));
    render(<AgentSelectionSurface />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose Local Agent' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your AI choice could not be saved. Nothing changed.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows success only after the selected-agent readback matches', async () => {
    let selectedRows: unknown[] = [];
    useBitfieldDataMock.mockImplementation((name: string) => {
      if (name === 'cli-registry') return cliRows;
      if (name === 'agent-profile-participants') return profileRows;
      if (name === 'chat-model-descriptors') return modelDescriptors;
      if (name === 'provider-routing-facts') return providerFacts;
      if (name === 'selected-agent') return selectedRows;
      return [];
    });
    const { rerender } = render(<AgentSelectionSurface />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose Local Agent' }));
    selectedRows = [{ selectedAgentId: 'profile:local' }];
    rerender(<AgentSelectionSurface />);

    expect(await screen.findByText('Ready. Local Agent is selected.')).toBeTruthy();
  });

  it('offers the provider-neutral connection catalog when no AI can run', () => {
    useBitfieldDataMock.mockImplementation((name: string) => {
      if (name === 'agent-profile-participants') return profileRows;
      if (name === 'chat-model-descriptors') return [];
      return [];
    });

    render(<AgentSelectionSurface />);

    expect(screen.getByRole('status').textContent).toBe('Connect an AI to continue.');
    const connect = screen.getByRole('button', { name: 'Connect AI' });
    expect(connect.getAttribute('data-payload')).toBe(JSON.stringify({
      id: 'service-connections.settings',
      surfaceInput: { initial_categories: ['AI'] },
    }));
    expect(screen.queryByRole('button', { name: 'Choose Local Agent' })).toBeNull();
    expect(screen.queryByText('Automatic selection is ready.')).toBeNull();
  });
});
