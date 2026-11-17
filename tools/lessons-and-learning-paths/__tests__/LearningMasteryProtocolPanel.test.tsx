import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from '../../../test-helpers/vitest-shim.mjs';

const { send } = vi.hoisted(() => ({ send: vi.fn(async () => ({ ok: true })) }));
vi.mock('@bitfield/runtime-kit', () => ({ sendRequestToBitfieldTarget: send }));
vi.mock('@bitfield/runtime-kit/react', () => ({ useBitfieldData: vi.fn(() => null) }));
vi.mock('tools/ui/show/placeable-surface-host', () => ({
  PlaceableSurfaceHost: ({ packageName, entryName }: { packageName: string; entryName: string }) => (
    <div data-testid="embedded-owner">{packageName}/{entryName}</div>
  ),
}));

import { LearningMasteryProtocolPanel } from '../show/LearningMasteryProtocolPanel.tsx';
import { descriptor } from './protocol-fixture.ts';

describe('LearningMasteryProtocolPanel', () => {
  afterEach(() => { cleanup(); send.mockClear(); });

  it('renders descriptor fields and arbitrary embedded owner surfaces', () => {
    render(<LearningMasteryProtocolPanel descriptorRaw={descriptor} />);
    expect(screen.getByText('Orient')).toBeTruthy();
    expect(screen.getByText('Constraint')).toBeTruthy();
    expect(screen.getByTestId('embedded-owner').textContent).toBe('documents/composition-scene');
  });

  it('dispatches the descriptor action target for an allowed transition', async () => {
    render(<LearningMasteryProtocolPanel descriptorRaw={descriptor} stateRaw={{
      kind: 'learning-mastery-protocol-state',
      protocol_ref: 'protocol:novel',
      state_ref: 'state:1',
      revision: 3,
      phase: 'orient',
      values: { constraint: 'Time' },
    }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Begin' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // Static routing stays at payload top level; the dynamic transition
    // context is delivered under `input` (the owner/workflow input location).
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      target: 'protocol-owner.transition',
      payload: { input: { state_ref: 'state:1', expected_state_revision: 3, from: 'orient', to: 'execute' } },
    });
  });

  it('renders saved answers in editable fields and saves typed drafts via the save action', async () => {
    const withSave = {
      ...descriptor,
      actions: {
        ...descriptor.actions,
        save: { target: 'protocol-owner.write-state', payload: { mode: 'save' } },
      },
    };
    render(<LearningMasteryProtocolPanel descriptorRaw={withSave} stateRaw={{
      kind: 'learning-mastery-protocol-state',
      protocol_ref: 'protocol:novel',
      state_ref: 'state:1',
      revision: 5,
      phase: 'orient',
      values: { constraint: 'Saved answer' },
    }} />);
    // The saved value shows in the editable field (not display-only text).
    const field = screen.getByDisplayValue('Saved answer') as HTMLTextAreaElement;
    expect(field.tagName).toBe('TEXTAREA');
    // Typing a new draft, then Save dispatches the save action with the merged
    // values under `input` and preserves the current phase (save-in-place).
    fireEvent.change(field, { target: { value: 'New reflection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save answers' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      target: 'protocol-owner.write-state',
      payload: { input: { phase: 'orient', values: { constraint: 'New reflection' }, next_revision: 6 } },
    });
  });

  it('fails closed without a descriptor', () => {
    render(<LearningMasteryProtocolPanel />);
    expect(screen.getByText('This learning protocol is not available yet')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });
});
