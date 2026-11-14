import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContentAnalyticsPanel } from '@/packages/content-analytics/show/ContentAnalyticsPanel';
import type { ContentAnalyticsModel } from '@/packages/content-analytics/read-data/content-analytics-model';

vi.mock('@/packages/content-analytics/.bitfield-entry-scope/content-analytics/runtime-kit-react', () => ({
  useBitfieldData: () => [],
}));

afterEach(() => {
  cleanup();
});

const MODEL: ContentAnalyticsModel = {
  status: 'Ready',
  statusTone: 'success',
  eyebrow: 'Results',
  title: 'Content results',
  primary: { value: '25', label: 'Ready result', detail: 'Jun 21, 12:00 PM' },
  itemsTitle: 'Content results',
  items: [{
    id: 'result:1',
    title: 'Ready result',
    detail: '25 / Jun 21, 12:00 PM',
    badge: 'trusted',
    values: [{ fieldId: 'metric', label: 'Number', value: 25, text: '25' }],
    raw: { arbitrary: true },
  }],
  empty: { title: 'No results yet', detail: 'Configured results appear here.' },
  detailsTitle: 'More',
  details: [{ fieldId: 'metric', label: 'Number', value: 25, text: '25' }],
  blockers: [],
  actions: [{
    id: 'record',
    label: 'Record result',
    target: 'slot::workflow',
    operation: 'execute_definition',
    definitionId: 'action:record-content-analytics-observation',
    copy: [{ key: 'observation_id', from: 'selected.id' }],
    blocked: false,
  }],
  revision: 'test',
  proof: { descriptorCount: 4, sourceRecordCount: 1 },
};

describe('ContentAnalyticsPanel', () => {
  it('renders the supplied serialized model without backend vocabulary', () => {
    const { container } = render(<ContentAnalyticsPanel model={MODEL} />);

    expect(screen.getAllByText('Content results').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ready result').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('source_id');
    expect(container.textContent).not.toContain('raw_payload_hash');
    expect(container.textContent).not.toContain('workflow');
    expect(container.textContent).not.toContain('slot');
  });

  it('invokes the descriptor action through the injected sender', async () => {
    const sent = vi.fn(async () => ({ ok: true }));
    render(<ContentAnalyticsPanel model={MODEL} sendTargetRequest={sent} />);

    fireEvent.click(screen.getByRole('button', { name: 'Record result' }));

    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent.mock.calls[0]?.[0]).toMatchObject({
      target: 'slot::workflow',
      payload: {
        operation: 'execute_definition',
        definition_id: 'action:record-content-analytics-observation',
      },
    });
  });

  it('disables blocked descriptor actions before any owner call', () => {
    const sent = vi.fn();
    render(<ContentAnalyticsPanel
      model={{
        ...MODEL,
        status: 'Needs attention',
        statusTone: 'warning',
        blockers: [{ message: 'Not ready.', severity: 'blocked' }],
        actions: [{ ...MODEL.actions[0]!, blocked: true, blockedReason: 'Not ready.' }],
      }}
      sendTargetRequest={sent}
    />);

    expect(screen.getByRole('button', { name: 'Record result' })).toHaveProperty('disabled', true);
    expect(screen.getAllByText('Not ready.').length).toBeGreaterThan(0);
    expect(sent).not.toHaveBeenCalled();
  });
});
