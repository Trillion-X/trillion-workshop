// PORTED FROM: bitfield-packages/packages/chat/show/ToolUseBlock.receipt-surface.test.tsx @ e99ac5976
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentMessage } from '../read-data/chat-message-types';
import type { PlaceableSurfacePayload } from '../../ui/show/placeable-surface-intent';

vi.mock('../../ui/show/placeable-surface-host', () => ({
  PlaceableSurfaceHost: (props: { packageName: string; entryName: string }) => (
    <output data-testid="receipt-surface">{`${props.packageName}/${props.entryName}`}</output>
  ),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44 })),
    getTotalSize: () => count * 44,
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));

import { ChatPanel } from './ChatPanel';
import { ToolUseBlock } from './ToolUseBlock';

afterEach(cleanup);

const catalogSurface: PlaceableSurfacePayload & { label: string } = {
  id: 'training-plan.surface',
  label: 'Training plan',
  packageEntry: { packageName: 'training-plan', entryName: 'plan' },
  materialTarget: 'component:training-plan',
  target: 'package::training-plan::surface',
  surfaceInput: { plan_ref: 'plan-1' },
};

function toolUse(surface: unknown, result = 'Completed') {
  return {
    id: 'receipt',
    tool: 'descriptor-selected-action',
    params: {},
    placeableResult: {
      sourceRef: 'package::chat::workflow-execution-receipt::opaque',
      selector: '$.output.surface',
      surface,
    },
    result,
  } as any;
}

describe('ToolUseBlock generic receipt surface route', () => {
  it('renders a compact count card and opens the current catalog surface from a result ref', () => {
    let opened: unknown = null;
    const receive = (event: Event) => {
      opened = (event as CustomEvent<unknown>).detail;
      event.preventDefault();
    };
    window.addEventListener('application/x-placeable-surface+json', receive);
    try {
      render(
        <ToolUseBlock
          toolUse={toolUse({
            surface_ref: catalogSurface.id,
            counts: { records_found: 12, events_written: 7 },
          })}
          placeableSurfaceCatalog={[catalogSurface]}
        />,
      );

      expect(screen.getByText('Records found').previousSibling?.textContent).toBe('12');
      expect(screen.getByText('Events written').previousSibling?.textContent).toBe('7');
      fireEvent.click(screen.getByRole('button', { name: 'Open Training plan' }));
      expect(opened).toEqual(catalogSurface);
    } finally {
      window.removeEventListener('application/x-placeable-surface+json', receive);
    }
  });

  it('shows row count for row-carrying results and fails closed for an unknown surface ref', () => {
    let opened: unknown = null;
    const receive = (event: Event) => {
      opened = (event as CustomEvent<unknown>).detail;
      event.preventDefault();
    };
    window.addEventListener('application/x-placeable-surface+json', receive);
    const rendered = render(
      <ToolUseBlock
        toolUse={toolUse({
          surface_ref: catalogSurface.id,
          rows: [{ id: 'one' }, { id: 'two' }],
        })}
        placeableSurfaceCatalog={[catalogSurface]}
      />,
    );
    expect(screen.getByText('Records').previousSibling?.textContent).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Open Training plan' }));
    expect(opened).toMatchObject({
      surfaceInput: { plan_ref: 'plan-1', records: [{ id: 'one' }, { id: 'two' }] },
    });
    window.removeEventListener('application/x-placeable-surface+json', receive);

    rendered.rerender(
      <ToolUseBlock
        defaultOpen
        toolUse={toolUse({ surface_ref: 'revoked.surface', counts: { records: 2 } }, 'Raw fallback')}
        placeableSurfaceCatalog={[catalogSurface]}
      />,
    );
    expect(screen.queryByText('Open Training plan')).toBeNull();
    expect(screen.queryByText('Raw fallback')).toBeNull();
    expect(screen.getByText('Work complete')).toBeTruthy();
  });

  it('mounts an unknown discovered tool surface only when its complete payload exactly matches the current catalog', () => {
    render(<ToolUseBlock defaultOpen toolUse={toolUse(catalogSurface)} placeableSurfaceCatalog={[catalogSurface]} />);

    expect(screen.getByTestId('receipt-surface').textContent).toBe('training-plan/plan');
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it.each([
    ['a changed target', { ...catalogSurface, target: 'package::attacker::surface' }],
    ['changed surface input', { ...catalogSurface, surfaceInput: { plan_ref: 'attacker-plan' } }],
  ])('denies a hostile payload with %s even when package and entry match', (_label, surface) => {
    render(<ToolUseBlock defaultOpen toolUse={toolUse(surface)} placeableSurfaceCatalog={[catalogSurface]} />);

    expect(screen.queryByTestId('receipt-surface')).toBeNull();
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.getByText('Work complete')).toBeTruthy();
  });

  it('denies a once-allowed payload after the catalog row is revoked or missing', () => {
    const rendered = render(<ToolUseBlock defaultOpen toolUse={toolUse(catalogSurface)} placeableSurfaceCatalog={[catalogSurface]} />);
    expect(screen.getByTestId('receipt-surface')).toBeTruthy();

    rendered.rerender(<ToolUseBlock defaultOpen toolUse={toolUse(catalogSurface)} placeableSurfaceCatalog={[]} />);

    expect(screen.queryByTestId('receipt-surface')).toBeNull();
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.getByText('Work complete')).toBeTruthy();
  });

  it('keeps ordinary raw tool output out of the conversation', () => {
    render(<ToolUseBlock defaultOpen toolUse={toolUse(undefined, 'Ordinary generic result')} placeableSurfaceCatalog={[catalogSurface]} />);

    expect(screen.queryByTestId('receipt-surface')).toBeNull();
    expect(screen.queryByText('Ordinary generic result')).toBeNull();
    expect(screen.getByText('Work complete')).toBeTruthy();
  });

  it('emits the durable receipt read to the containing workspace only from an explicit action', () => {
    let request: unknown = null;
    const receive = (event: Event) => {
      request = (event as CustomEvent<unknown>).detail;
      event.preventDefault();
    };
    window.addEventListener('application/x-placeable-surface+json', receive);
    try {
      render(
        <ToolUseBlock
          defaultOpen
          toolUse={toolUse(catalogSurface)}
          placeableSurfaceCatalog={[catalogSurface]}
          surfaceIntentDestinationRef="workspace:opaque"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Open in workspace' }));
      expect(request).toEqual({
        destinationRef: 'workspace:opaque',
        deliveryRef: 'package::chat::workflow-execution-receipt::opaque',
        source: {
          input: 'selector-source-by-address-label',
          params: { addressLabel: 'package::chat::workflow-execution-receipt::opaque' },
        },
        intentPath: ['output', 'surface'],
        keyPath: ['evidence', 'attempt_ref'],
        defaultRoute: 'emit',
      });
    } finally {
      window.removeEventListener('application/x-placeable-surface+json', receive);
    }
  });

  it('shows no placement action without a containing recipient or a valid trusted selector', () => {
    const rendered = render(
      <ToolUseBlock
        defaultOpen
        toolUse={toolUse(catalogSurface)}
        placeableSurfaceCatalog={[catalogSurface]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Open in workspace' })).toBeNull();

    rendered.rerender(
      <ToolUseBlock
        defaultOpen
        toolUse={{
          ...toolUse(catalogSurface),
          placeableResult: { ...toolUse(catalogSurface).placeableResult, selector: '$..surface' },
        }}
        placeableSurfaceCatalog={[catalogSurface]}
        surfaceIntentDestinationRef="workspace:opaque"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Open in workspace' })).toBeNull();
  });

  it('delivers the same gate through a grouped virtual transcript row', () => {
    const groupedMessages: AgentMessage[] = [
      {
        id: 'one',
        type: 'tool_result',
        role: 'assistant',
        content: 'Completed',
        timestamp: '2026-07-26T00:00:00.000Z',
        toolUse: toolUse(catalogSurface),
      },
      {
        id: 'two',
        type: 'tool_result',
        role: 'assistant',
        content: 'Completed',
        timestamp: '2026-07-26T00:00:01.000Z',
        toolUse: toolUse({ ...catalogSurface, target: 'package::attacker::surface' }),
      },
    ];

    render(<ChatPanel messages={groupedMessages} onSend={() => {}} placeableSurfaceCatalog={[catalogSurface]} />);

    expect(document.body.textContent).not.toContain('descriptor-selected-action');
    fireEvent.click(screen.getByRole('button', { name: /2 work updates/i }));
    expect(screen.getAllByTestId('receipt-surface')).toHaveLength(1);
    expect(screen.queryByText('Completed')).toBeNull();
    expect(document.body.textContent).not.toContain('descriptor-selected-action');
  });

  it('never paints commands, parameters, hooks, tokens, paths, raw output, or internal action names', () => {
    render(
      <ToolUseBlock
        defaultOpen
        durationMs={8123}
        usage={{ inputTokens: 1200, outputTokens: 340 }}
        toolUse={{
          id: 'internal-call-id',
          tool: 'descriptor-selected-action',
          params: { command: 'cat /private/work.txt', account_ref: 'account:secret' },
          hookActivity: [{ hookEvent: 'PreToolUse', command: '/internal/check-authority.sh' }],
          result: 'owner:private raw diagnostic output',
          callTokens: 1200,
          resultTokens: 340,
        } as any}
      />,
    );

    const visible = document.body.textContent || '';
    for (const hidden of ['descriptor-selected-action', 'cat /private/work.txt', 'account:secret', 'check-authority', '1200', '340', 'tokens', 'hook', 'raw diagnostic']) {
      expect(visible).not.toContain(hidden);
    }
    expect(visible).toContain('Work complete');
  });

  it('reduces raw tool failures to a plain retry message', () => {
    render(<ToolUseBlock toolUse={toolUse(undefined, 'Error: trusted caller authority is required')} />);
    expect(screen.getByText('Something went wrong. Try again.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('authority');
  });
});
