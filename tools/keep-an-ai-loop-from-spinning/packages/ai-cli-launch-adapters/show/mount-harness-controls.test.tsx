import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildHarnessControlRequest, default as mountHarnessControls, HarnessControls } from './mount-harness-controls';

vi.mock('@bitfield/runtime-kit/react', () => ({
  useBitfieldData: (source: unknown) => source,
}));

afterEach(cleanup);

const stopRow = {
  kind: 'harness-control',
  id: 'harness-control:stop',
  control: 'stop',
  label: 'Stop this work',
  order: 10,
  dispatch: {
    target: 'ai-cli-launch-adapters.emit-session-event',
    output_template: {
      schema: 'ai-cli-launch-adapters.session-event-request/v1',
      event_kind: 'session-stop-requested',
      partition_label: 'trillion',
      provider_ref: 'operator-ui',
    },
  },
};

const contractRow = {
  kind: 'outcome-continuation-contract',
  id: 'outcome:launch-harness',
  observable_outcome: 'Finish the autonomous launch harness',
  next_action: 'Verify the real stop path',
  session_ref: 'session-abc',
  status: 'EXECUTING',
};

const stopButtonName = `Stop this work: ${contractRow.observable_outcome}`;

describe('HarnessControls', () => {
  it('keeps the package entry self-contained and self-mounting', async () => {
    const source = readFileSync(path.join(process.cwd(), 'packages/ai-cli-launch-adapters/show/mount-harness-controls.tsx'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/packages\//);
    expect(source).not.toMatch(/from\s+['"]\.\.\/ui\//);
    expect(source).toContain("from 'react-dom/client'");

    const el = document.createElement('div');
    const unmount = mountHarnessControls({ el, props: { controlsSource: [], contractsSource: [], pausesSource: [] } });
    await waitFor(() => expect(el.textContent).toContain('No automatic work is running'));
    unmount();
    expect(el.textContent).toBe('');
  });

  it('renders no control when the DATA row is absent', () => {
    render(<HarnessControls controlsSource={[]} contractsSource={[]} pausesSource={[]} />);
    expect(screen.getByText('No automatic work is running')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the loading state without fabricating a stop control', () => {
    render(<HarnessControls controlsSource={[]} contractsSource={[]} pausesSource={[]} state="loading" />);
    expect(screen.getByRole('status').textContent).toContain('Loading automatic work');
    expect(screen.queryByRole('button', { name: 'Stop this work' })).toBeNull();
  });

  it('requires explicit confirmation before dispatching the DATA-owned event', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    render(<HarnessControls controlsSource={[stopRow]} contractsSource={[contractRow]} pausesSource={[]} onDispatchControl={dispatch} />);

    fireEvent.click(screen.getByRole('button', { name: stopButtonName }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Stop this work?' }).textContent).toContain('turns off automatic continuation');

    fireEvent.click(within(screen.getByRole('group', { name: 'Stop this work?' })).getByRole('button', { name: 'Stop this work' }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(
      stopRow.dispatch,
      stopRow.id,
      expect.any(String),
      contractRow.id,
      contractRow.session_ref,
    ));
    expect(screen.getByRole('status').textContent).toContain('Work stopped');
    expect(screen.queryByRole('button', { name: stopButtonName })).toBeNull();
  });

  it('builds the target request from DATA and injects exact contract/session/event identity', () => {
    expect(buildHarnessControlRequest(stopRow.dispatch, contractRow.id, 'session-abc', 'event-123')).toEqual({
      target: 'ai-cli-launch-adapters.emit-session-event',
      payload: {
        schema: 'ai-cli-launch-adapters.session-event-request/v1',
        event_kind: 'session-stop-requested',
        partition_label: 'trillion',
        provider_ref: 'operator-ui',
        session_id: 'session-abc',
        event_id: 'event-123',
        contract_ref: contractRow.id,
      },
    });
  });

  it('uses an operator event session when the outcome has no provider session yet', () => {
    const request = buildHarnessControlRequest(stopRow.dispatch, contractRow.id, null, 'event-123');
    expect(request.payload.session_id).toBe('operator-control-event-123');
  });

  it('surfaces dispatch failure and offers a retry', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('offline'));
    render(<HarnessControls controlsSource={[stopRow]} contractsSource={[contractRow]} pausesSource={[]} onDispatchControl={dispatch} errorMessage="No owner receipt arrived." />);

    fireEvent.click(screen.getByRole('button', { name: stopButtonName }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Stop this work?' })).getByRole('button', { name: 'Stop this work' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No owner receipt arrived'));
    expect(screen.getByRole('button', { name: stopButtonName }).textContent).toContain('Try stopping again');
  });

  it('disables the stop action while live state is offline, stale, or concurrent', () => {
    const { rerender } = render(<HarnessControls controlsSource={[stopRow]} contractsSource={[contractRow]} pausesSource={[]} state="offline" />);
    expect((screen.getByRole('button', { name: stopButtonName }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('reconnects');

    rerender(<HarnessControls controlsSource={[stopRow]} contractsSource={[contractRow]} pausesSource={[]} state="stale" />);
    expect((screen.getByRole('button', { name: stopButtonName }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<HarnessControls controlsSource={[stopRow]} contractsSource={[contractRow]} pausesSource={[]} state="concurrent" />);
    expect((screen.getByRole('button', { name: stopButtonName }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders a paused receipt as stopped work with no re-fire control', () => {
    render(<HarnessControls
      controlsSource={[stopRow]}
      contractsSource={[contractRow]}
      pausesSource={[{ kind: 'harness-stop-pause', paused_contracts: [{ id: contractRow.id }] }]}
    />);
    expect(screen.getByTestId('paused-work-card').textContent).toContain(contractRow.observable_outcome);
    expect(screen.queryByRole('button', { name: stopButtonName })).toBeNull();
  });
});
