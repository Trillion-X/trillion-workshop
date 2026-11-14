// package-set://bitfield-studio/packages/research-workspace/show/add-channel-panel.test.tsx
//
// Failure-path verification for the paste-a-channel Add control (L116 "prove the user can do the
// thing" includes graceful failure). A gather can SUCCEED structurally (http 200, status
// completed) yet return ZERO items — a bad channel link, or a channel with no videos. Before this
// fix the panel treated that as success (cleared the input, empty board, no feedback). Now the
// blind handler reads the GENERIC gather-result `count` and surfaces "no videos found" while
// keeping the pasted value so the user can correct it.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const send = vi.fn();
vi.mock('@bitfield/runtime-kit', () => ({
  sendRequestToBitfieldTarget: (...args: unknown[]) => send(...args),
}));

// Imported AFTER the mock so the panel binds the mocked function.
const { AddChannelPanel } = await import('./AddChannelPanel');

const CONFIG = {
  title: 'Research a channel',
  placeholder: 'Paste a channel…',
  addLabel: 'Add',
  // source-specific feedback copy is DATA (surfaceInput), not hardcoded in the blind panel (L090).
  emptyLabel: 'No videos found for that channel. Check the link and try again.',
  gatherTarget: 'slot::workflow',
  definitionId: 'action:research-gather',
  paramKey: 'channel_id',
  gatherTemplate: { fetch_target: 'compute.process', feed_address: 'research-workspace-source-feed' },
};

afterEach(() => {
  cleanup();
  send.mockReset();
});

describe('AddChannelPanel empty-result feedback', () => {
  it('shows "no videos found" when the gather returns count 0, and keeps the pasted value', async () => {
    send.mockResolvedValue({ status: 'completed', output: { count: 0 } });
    render(<AddChannelPanel config={CONFIG} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'UCbadchannel' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(screen.getByText(/No videos found for that channel/)).toBeTruthy());
    expect(input.value).toBe('UCbadchannel'); // not cleared — the user can fix the link
    // the panel asked for the output so it could read the generic count
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ include_output: true }) }),
    );
  });

  it('clears the input and shows no error when the gather returns videos (count > 0)', async () => {
    send.mockResolvedValue({ status: 'completed', output: { count: 30 } });
    render(<AddChannelPanel config={CONFIG} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'UCX6OQ3DkcsbYNE6H8uQQuVA' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(input.value).toBe(''));
    expect(screen.queryByText(/No videos found/)).toBeNull();
  });

  // L090 lock: when the surfaceInput omits the source-specific copy, the blind panel's own default
  // must be SOURCE-AGNOSTIC — no "video"/"channel" vocabulary baked into the code. This is what lets
  // the SAME panel serve a podcast or blog source (a different copy DATA row) without a code edit.
  it('falls back to a source-agnostic empty message (no "video"/"channel" in code) when copy is not configured', async () => {
    send.mockResolvedValue({ status: 'completed', output: { count: 0 } });
    // config WITHOUT emptyLabel/errorLabel — exercises the code defaults.
    const bare = {
      addLabel: 'Add',
      gatherTarget: 'slot::workflow',
      definitionId: 'action:research-gather',
      paramKey: 'source_id',
      gatherTemplate: { fetch_target: 'slot::http-client', feed_address: 'x' },
    };
    render(<AddChannelPanel config={bare} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'anything' } });
    fireEvent.click(screen.getByText('Add'));
    const msg = await screen.findByText(/Nothing found/);
    expect(msg).toBeTruthy();
    expect(msg.textContent ?? '').not.toMatch(/video|channel/i); // code default names no source type
  });
});
