import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const sendRequest = vi.hoisted(() => vi.fn());
vi.mock('@bitfield/runtime-kit', () => ({ sendRequestToBitfieldTarget: sendRequest }));
vi.mock('@/packages/record-board-progress-feed/.bitfield-entry-scope/work-flow-map/runtime-kit-react', () => ({
  useBitfieldData: () => [
    { record: { address: 'package::observed-content::observation-plan' }, payload: { plan: [{ source_ref: 'source:codex', descriptor: { label: 'Codex' } }] } },
    { record: { address: 'package::observed-content::ledger::source:codex' }, payload: { accepted: [{
      source_ref: 'source:codex', source_identity_ref: 'message:one', source_revision_ref: 'rev:one',
      correlation_ref: 'batch:shared', observed_at: new Date().toISOString(),
      payload: { atom_ref: 'atom:one', native_ref: 'msg_one', speaker_ref: 'speaker:source:codex:user' },
    }] } },
  ],
}));

import { LiveWorkFlowMap } from './mount-work-flow-map';

describe('live work flow map', () => {
  it('reads the exact Request and Task before painting a task link', async () => {
    sendRequest.mockResolvedValue({ payload: new TextEncoder().encode(JSON.stringify({
      status: 'completed',
      output: {
        request: { found: true, payload: { task_ref: 'request:source:codex:msg_one', at: new Date().toISOString() } },
        task: { found: true, payload: { id: 'request:source:codex:msg_one' } },
        claim: { found: true, payload: { status: 'pending-start', claimed_at: new Date().toISOString() } },
      },
    })) });
    render(<LiveWorkFlowMap />);
    expect(screen.getByText('No linked task recorded')).toBeTruthy();
    expect(await screen.findByText('Task: request:source:codex:msg_one')).toBeTruthy();
    expect(screen.getByText('Request recorded')).toBeTruthy();
    expect(screen.getByText('Execution claim recorded')).toBeTruthy();
    expect(sendRequest).toHaveBeenCalledWith({
      target: 'slot::workflow',
      payload: {
        operation: 'execute_definition', definition_id: 'action:read-source-message-work',
        input: { record_ref: 'request:source:codex:msg_one' }, include_output: true, include_steps: false,
      },
    });
  });
});
