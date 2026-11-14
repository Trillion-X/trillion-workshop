// package-set://bitfield-studio/packages/customer-support/show/customer-support-surface.test.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The render-state matrix for the Support Workbench. ONE generic surface must
// render every state honestly (L117) and carry ZERO domain vocabulary in code
// (the Generic / Data-Driven Gate). These cases drive the REAL reader + REAL
// surface (never a mock of either) through:
//
//   empty · loading · error · sparse · dense(desktop) · view-switch ·
//   recoverable-issue · mobile-detail-push · non-support genericity ·
//   no-ref-leak audit · live action dispatch (through the mount panel)
//
// Everything visible is asserted from DATA the fixtures carry — never a
// hardcoded outcome or a fabricated row. The relationship + booking fixtures
// prove the same code renders unrelated domains without a single edit.
//
// =============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The surface itself imports no transport, but the mount panel does. Mock both
// runtime-kit seams so the panel's live-data + dispatch path is testable.
const useBitfieldDataMock = vi.fn();
vi.mock('@bitfield/runtime-kit', () => ({
  sendRequestToBitfieldTarget: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@bitfield/runtime-kit/react', () => ({
  useBitfieldData: (...args: unknown[]) => useBitfieldDataMock(...args),
}));

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { readCustomerSupportWorkspace } from '../read-data/read-customer-support-workspace';
import { CustomerSupportSurface } from './CustomerSupportSurface';
import { CustomerSupportPanel } from './mount-customer-support';
import {
  bookingDescriptorInput,
  emptySupportInput,
  relationshipDescriptorInput,
  supportDescriptorInput,
} from './fixtures';

const supportWorkspace = () => readCustomerSupportWorkspace(supportDescriptorInput);

/**
 * Re-shape a fixture into the EXACT row-array the live `record-work` value
 * carries at runtime: the `record_from_matching_records` aggregate is a
 * `cell_table`, and the input descriptor's `op: rows` projection turns each row
 * into `{ address, payload }`. The decoder buckets those rows by `payload.kind`,
 * so every published record's payload must carry its kind — which is exactly
 * what each seeded `published-record` row in things.json does. Feeding this
 * (instead of the explicit-array object shape) proves the real delivery path,
 * not a convenience shape the runtime never produces.
 */
function toPublishedRows(
  fixture: typeof supportDescriptorInput,
): Array<{ address: string; payload: Record<string, unknown> }> {
  const rows: Array<{ address: string; payload: Record<string, unknown> }> = [];
  const push = (kind: string, items: readonly unknown[] | undefined): void => {
    for (const item of items ?? []) {
      if (item && typeof item === 'object') {
        rows.push({
          address: `package::customer-support::published-record::row-${rows.length}`,
          payload: { ...(item as Record<string, unknown>), kind },
        });
      }
    }
  };
  push('record-work.record', fixture.workRecords);
  push('record-work.view-descriptor', fixture.viewDescriptors);
  push('record-work.action-descriptor', fixture.actionDescriptors);
  push('record-work.owner-evidence', fixture.ownerEvidence);
  push('record-work.copy-descriptor', fixture.copyDescriptors);
  return rows;
}

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Support Workbench — render-state matrix', () => {
  it('empty: shows the copy and the one real starter action, no fake rows', () => {
    const workspace = readCustomerSupportWorkspace(emptySupportInput);
    render(React.createElement(CustomerSupportSurface, { workspace }));

    expect(screen.getByRole('heading', { name: 'Support' })).toBeTruthy();
    expect(screen.getByText('No tickets need you right now.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect a channel' })).toBeTruthy();
    // Nothing fabricated.
    expect(screen.queryByText('Refund not received')).toBeNull();
  });

  it('loading: shows the honest loading state, not fabricated records', () => {
    render(React.createElement(CustomerSupportSurface, { workspace: supportWorkspace(), loading: true }));

    expect(screen.getByRole('heading', { name: 'Support' })).toBeTruthy();
    expect(screen.getByLabelText('Loading work')).toBeTruthy();
    expect(screen.queryByText('Refund not received')).toBeNull();
  });

  it('error: routes a hard error through the safe error card under the title', () => {
    render(
      React.createElement(CustomerSupportSurface, {
        workspace: supportWorkspace(),
        errorMessage: 'Could not load your work right now.',
      }),
    );

    expect(screen.getByRole('heading', { name: 'Support' })).toBeTruthy();
    expect(screen.getByText('Could not load your work right now.')).toBeTruthy();
    expect(screen.queryByText('Refund not received')).toBeNull();
  });

  it('sparse: renders a single-record booking workspace through the same component', () => {
    const workspace = readCustomerSupportWorkspace(bookingDescriptorInput);
    render(React.createElement(CustomerSupportSurface, { workspace }));

    // Card + detail both name the record.
    expect(screen.getAllByRole('heading', { name: 'Court hold' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Reserve time' })).toBeTruthy();
    // A single view -> no view switch.
    expect(screen.queryByRole('radiogroup', { name: 'Views' })).toBeNull();
  });

  it('dense(desktop): lists every record and pins the selected record detail', () => {
    render(React.createElement(CustomerSupportSurface, { workspace: supportWorkspace() }));

    for (const label of [
      'Refund not received',
      'Login link expired',
      'Add dark mode to the app',
      'Cannot upload a profile photo',
      'Charged twice this month',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
    // The first record is selected by default; its detail exposes its own actions.
    expect(screen.getAllByRole('button', { name: 'Reply' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Mark resolved' })).toBeTruthy();
  });

  it('view-switch: switching the view re-labels the segmented control selection', () => {
    render(React.createElement(CustomerSupportSurface, { workspace: supportWorkspace() }));

    const views = screen.getByRole('radiogroup', { name: 'Views' });
    expect(within(views).getByRole('radio', { name: 'Inbox' })).toBeTruthy();
    fireEvent.click(within(views).getByRole('radio', { name: 'Priority' }));
    // Records still render after the view changes.
    expect(screen.getAllByText('Refund not received').length).toBeGreaterThanOrEqual(1);
  });

  it('recoverable-issue: surfaces calm DATA-driven copy, never the raw category', () => {
    render(React.createElement(CustomerSupportSurface, { workspace: supportWorkspace() }));

    const banner = screen.getByLabelText('Needs attention');
    expect(within(banner).getByText('Some activity is still being gathered.')).toBeTruthy();
    expect(banner.textContent ?? '').not.toContain('missing-owner-evidence');
  });

  it('mobile: selecting a record pushes a full-screen detail with a back affordance', () => {
    const restore = setViewport(true);
    try {
      render(React.createElement(CustomerSupportSurface, { workspace: supportWorkspace() }));
      // Stacked collection first — no back button yet.
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

      fireEvent.click(screen.getByRole('heading', { name: 'Login link expired' }));

      expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Login link expired' })).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('genericity: renders a relationship workspace with no support vocabulary', () => {
    const workspace = readCustomerSupportWorkspace(relationshipDescriptorInput);
    render(React.createElement(CustomerSupportSurface, { workspace }));

    expect(screen.getByRole('heading', { name: 'Relationship Work' })).toBeTruthy();
    expect(screen.getAllByText('Jordan Avery').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Write note' })).toBeTruthy();
    // The support words live only in support DATA — not in the component.
    expect(screen.queryByText('Support')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('no-ref-leak: never renders an internal ref/key/role token to the user', () => {
    const { container } = render(
      React.createElement(CustomerSupportSurface, { workspace: supportWorkspace() }),
    );
    const text = container.textContent ?? '';
    for (const token of [
      'slot::',
      'package::',
      'record-work.',
      'action.reply',
      'action.resolve',
      'owner-action.',
      'evidence-',
      'missing-owner-evidence',
      'owner_ref',
      'state_refs',
    ]) {
      expect(text).not.toContain(token);
    }
  });
});

describe('Support Workbench — live action dispatch (mount panel)', () => {
  it('prepares the typed reply and sends it through the package target', async () => {
    useBitfieldDataMock.mockReturnValue(supportDescriptorInput);
    render(React.createElement(CustomerSupportPanel));

    // Open the reply composer on the default-selected record.
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply' })[0]);

    const body = screen.getByLabelText('Body');
    fireEvent.change(body, { target: { value: 'Your refund is on the way.' } });

    // The composer's submit is the second "Reply" control (after the rail toggle).
    const replyButtons = screen.getAllByRole('button', { name: 'Reply' });
    fireEvent.click(replyButtons[replyButtons.length - 1]);

    await waitFor(() => expect(sendRequestToBitfieldTarget).toHaveBeenCalled());
    const request = vi.mocked(sendRequestToBitfieldTarget).mock.calls[0][0];
    expect(request.target).toBe('slot::workflow');
    const serialized = JSON.stringify(request);
    expect(serialized).toContain('ticket-1');
    expect(serialized).toContain('Your refund is on the way.');
    expect(serialized).toContain('owner-action.reply');
  });

  it('renders the honest empty state when the live value is empty', () => {
    useBitfieldDataMock.mockReturnValue(undefined);
    render(React.createElement(CustomerSupportPanel));
    // No records, no fabricated rows — the workbench still renders a title.
    expect(screen.queryByText('Refund not received')).toBeNull();
  });
});

describe('Support Workbench — live published-records aggregate (real cell_table row-array)', () => {
  it('decodes the live row-array into the same workbench, bucketed by payload kind', async () => {
    // The shape the runtime actually delivers: one `{ address, payload }` per
    // published record, payload carrying its `kind`. The decoder buckets these.
    useBitfieldDataMock.mockReturnValue(toPublishedRows(supportDescriptorInput));
    render(React.createElement(CustomerSupportPanel));

    // Title + records arrive from the row payloads (copy + work-record kinds).
    expect(screen.getByRole('heading', { name: 'Support' })).toBeTruthy();
    for (const label of ['Refund not received', 'Login link expired', 'Charged twice this month']) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }

    // DATA-driven issue copy survives the row path — proves copy + owner-evidence
    // rows were bucketed AND the missing-evidence join still computes from rows.
    const banner = screen.getByLabelText('Needs attention');
    expect(within(banner).getByText('Some activity is still being gathered.')).toBeTruthy();
    expect(banner.textContent ?? '').not.toContain('missing-owner-evidence');

    // And an action still dispatches through the package target from row DATA.
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply' })[0]);
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'On its way.' } });
    const replyButtons = screen.getAllByRole('button', { name: 'Reply' });
    fireEvent.click(replyButtons[replyButtons.length - 1]);
    await waitFor(() => expect(sendRequestToBitfieldTarget).toHaveBeenCalled());
    const request = vi.mocked(sendRequestToBitfieldTarget).mock.calls[0][0];
    expect(JSON.stringify(request)).toContain('owner-action.reply');
  });

  it('renders the honest empty state from an empty aggregate (zero rows)', () => {
    useBitfieldDataMock.mockReturnValue([]);
    render(React.createElement(CustomerSupportPanel));
    expect(screen.queryByText('Refund not received')).toBeNull();
  });
});
