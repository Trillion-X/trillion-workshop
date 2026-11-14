// package-set://bitfield-studio/packages/marketing-pipeline/show/coordination-surface.test.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The render-state matrix for the Coordination Workbench. ONE generic surface
// has to render every state honestly (L117) and carry ZERO domain vocabulary in
// code (Generic/Data-Driven Gate). These cases drive the REAL component through:
//
//   empty · loading · error · sparse · dense(desktop) · view-switch ·
//   recoverable-issue+bound-retry · running-process · mobile-detail-push ·
//   non-marketing genericity · no-ref-leak audit
//
// Everything visible is asserted from DATA the model carries — never a hardcoded
// outcome or a fabricated row. The non-marketing fixtures prove the same code
// renders relationship-work and booking models without a single edit.
//
// =============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bookingDescriptorInput,
  marketingDescriptorInput,
  relationshipDescriptorInput,
} from '../read-data/fixtures';
import { readCoordinationRecords } from '../read-data/read-coordination-records';
import { MarketingPipelineSurface, mountMarketingPipeline } from './mount-marketing-pipeline';

const marketingModel = () => readCoordinationRecords(marketingDescriptorInput);

/** Stub matchMedia so useNarrowViewport reports the phone breakpoint. */
function setViewport(narrow: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: narrow,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe('Coordination Workbench — render-state matrix', () => {
  afterEach(() => cleanup());

  it('empty: shows the model copy and the one starter action, no fake rows', () => {
    const model = readCoordinationRecords({
      surfaceCopy: { title: 'Relationship Work', emptyText: 'No people yet.', emptyActionLabel: 'Add person' },
    });
    render(React.createElement(MarketingPipelineSurface, { model }));

    expect(screen.getByRole('heading', { name: 'Relationship Work' })).toBeTruthy();
    expect(screen.getByText('No people yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add person' })).toBeTruthy();
  });

  it('loading: shows the honest loading state, not fabricated records', () => {
    render(React.createElement(MarketingPipelineSurface, { model: marketingModel(), loading: true }));

    expect(screen.getByRole('heading', { name: 'Marketing Pipeline' })).toBeTruthy();
    expect(screen.getByLabelText('Loading work')).toBeTruthy();
    expect(screen.queryByText('Launch note')).toBeNull();
  });

  it('error: routes a hard error through the safe error card under the title', () => {
    render(
      React.createElement(MarketingPipelineSurface, {
        model: marketingModel(),
        errorMessage: 'Could not load your work right now.',
      }),
    );

    expect(screen.getByRole('heading', { name: 'Marketing Pipeline' })).toBeTruthy();
    expect(screen.getByText('Could not load your work right now.')).toBeTruthy();
    expect(screen.queryByText('Launch note')).toBeNull();
  });

  it('sparse: renders a single-record booking model through the same component', () => {
    const model = readCoordinationRecords(bookingDescriptorInput);
    render(React.createElement(MarketingPipelineSurface, { model }));

    // Card + detail both name the record.
    expect(screen.getAllByRole('heading', { name: 'Court hold' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Reserve time' })).toBeTruthy();
    // No view switch with a single (absent) view, no group scan with one group.
    expect(screen.queryByRole('radiogroup', { name: 'Views' })).toBeNull();
  });

  it('dense(desktop): groups all records and pins the selected record detail', () => {
    render(React.createElement(MarketingPipelineSurface, { model: marketingModel() }));

    for (const label of ['Launch note', 'Spring teaser', 'Webinar invite', 'Product update', 'Newsletter #42']) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
    // The first record is selected by default; its detail exposes its own actions.
    expect(screen.getByRole('button', { name: 'Prepare draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send for review' })).toBeTruthy();
  });

  it('view-switch: changing the arrangement to table reveals descriptor columns', () => {
    render(React.createElement(MarketingPipelineSurface, { model: marketingModel() }));

    // Board arrangement has no table columns.
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);

    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));

    const headers = screen.getAllByRole('columnheader').map((node) => node.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Title', 'Step', 'Owner', 'Due']));
  });

  it('recoverable-issue: offers the DATA-bound retry and runs that action', () => {
    const onAction = vi.fn();
    render(React.createElement(MarketingPipelineSurface, { model: marketingModel(), onAction }));

    const banner = screen.getByLabelText('Needs attention');
    const retry = within(banner).getByRole('button', { name: 'Try again' });
    fireEvent.click(retry);

    expect(onAction).toHaveBeenCalledTimes(1);
    const request = onAction.mock.calls[0][0];
    // The retry routes through the workflow target the issue's action names.
    expect(request.targetRequests.length).toBeGreaterThan(0);
  });

  it('running-process: surfaces the running copy for an active session', () => {
    // record.alpha (default selection) carries a non-terminal process session.
    render(React.createElement(MarketingPipelineSurface, { model: marketingModel() }));
    expect(screen.getByText('Work is running')).toBeTruthy();
  });

  it('mobile: selecting a record pushes a full-screen detail with a back affordance', () => {
    const restore = setViewport(true);
    try {
      render(React.createElement(MarketingPipelineSurface, { model: marketingModel() }));
      // Stacked collection first — no back button yet.
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

      fireEvent.click(screen.getByRole('heading', { name: 'Spring teaser' }));

      expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Spring teaser' })).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('genericity: renders a relationship-work model with no marketing vocabulary', () => {
    const model = readCoordinationRecords(relationshipDescriptorInput);
    render(React.createElement(MarketingPipelineSurface, { model }));

    expect(screen.getByRole('heading', { name: 'Relationship Work' })).toBeTruthy();
    expect(screen.getAllByText('Jordan').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Write note' })).toBeTruthy();
    // The marketing words live only in marketing DATA — not in the component.
    expect(screen.queryByText('Marketing Pipeline')).toBeNull();
    expect(screen.queryByText('Prepare draft')).toBeNull();
  });

  it('no-ref-leak: never renders an internal ref/key/role token to the user', () => {
    const { container } = render(React.createElement(MarketingPipelineSurface, { model: marketingModel() }));
    const text = container.textContent ?? '';
    for (const token of [
      'slot::',
      'workflow-definition',
      'package::',
      'coordination.',
      'field.state',
      'action.retry-send',
      'record.echo',
      'process-session::',
    ]) {
      expect(text).not.toContain(token);
    }
  });

  it('mounts through the same model boundary the surface renders', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const result = mountMarketingPipeline({ input: marketingDescriptorInput });

    expect(result.model.records).toHaveLength(5);
    expect(result.model.records[0].id).toBe('record.alpha');
    expect(log).toHaveBeenCalledWith('[marketing-pipeline] mounted surface model records=5');
    log.mockRestore();
  });
});
