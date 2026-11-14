// packages/group/show/BoardExportPanel.test.tsx
//
// R43: export UX. Two contracts pinned here:
//  - R43a (dedupe): a `fallbackOnly` destination (the browser anchor, dead in the
//    presenter) is NOT rendered as a visible choice — no "Downloads" AND "Download file"
//    duplicate — but still runs in the auto/first-success chain.
//  - R43b (toast): delivery fires the shared notice on success AND failure, so text
//    export gives the identical feedback the image/deck exports already do.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BoardExportPanel } from './BoardExportPanel';
import type { BoardItem } from '../read-data/group-board-model';
import type { OutputDestination } from '../../ui/show/output-destination';
import { outputDeliveryOutcome } from '../../ui/show/output-destination';
import { DOCUMENT_EXPORTS } from '../do-work/board-document-exports';

it('keeps the selected format and delivery pending until the current export settles', async () => {
  let finish!: (value: boolean) => void;
  const deliver = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const onNotice = vi.fn();
  const initial = DOCUMENT_EXPORTS[0];
  const alternate = DOCUMENT_EXPORTS[1];
  const { getByLabelText, getByText } = render(<BoardExportPanel items={ITEMS} now={0} title="Board"
    destinations={[{ id: 'save', label: 'Save file', deliver }]}
    onNotice={onNotice} onClose={() => {}} />);
  fireEvent.click(getByLabelText('Save file'));
  const alternateButton = getByLabelText(`Export as ${alternate.label}`) as HTMLButtonElement;
  expect(alternateButton.disabled).toBe(true);
  fireEvent.click(alternateButton);
  expect(getByLabelText(`Export as ${initial.label}`).getAttribute('aria-pressed')).toBe('true');
  expect(getByText('Delivering…')).toBeTruthy();
  fireEvent.click(getByLabelText('Save file'));
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(onNotice).not.toHaveBeenCalled();
  finish(true);
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(`Exported as ${initial.label}`, 'success'));
  expect(alternateButton.disabled).toBe(false);
  fireEvent.click(alternateButton);
  expect(alternateButton.getAttribute('aria-pressed')).toBe('true');
  expect(getByText('Deliver')).toBeTruthy();
});

it.each(['requested', 'shown', 'cancelled'] as const)('shows %s without claiming delivery for direct, automatic and image export', async (outcome) => {
  const expected = { requested: 'Download requested', shown: 'Text shown for copying', cancelled: 'Export cancelled' }[outcome];
  for (const action of ['direct', 'auto', 'image']) {
    const onNotice = vi.fn();
    const after = vi.fn(async () => true);
    const { getByLabelText, queryByText, unmount } = render(<BoardExportPanel items={ITEMS} now={0} title="Board"
      destinations={[{ id: 'test', label: 'Test destination', deliver: async () => outcome }, { id: 'after', label: 'After', deliver: after }]}
      imageExports={[{ id: 'image', label: 'PNG', produce: async () => ({ filename: 'board.png', mimeType: 'image/png', bytes: new Uint8Array([1]) }) }]}
      onNotice={onNotice} onClose={() => {}} />);
    fireEvent.click(getByLabelText(action === 'direct' ? 'Test destination' : action === 'auto' ? /Deliver the board as/ : 'Export as PNG'));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expected, 'info'));
    expect(queryByText('Delivered')).toBeNull();
    expect(after).not.toHaveBeenCalled();
    unmount();
  }
});

it('does not treat an arbitrary truthy result as confirmed output', () => {
  for (const value of [{ delivered: true }, 'accepted', 'pending', 1, null, undefined]) expect(outputDeliveryOutcome(value)).toBe('failed');
  expect(outputDeliveryOutcome(true)).toBe('delivered');
});

const ITEMS: readonly BoardItem[] = [
  { memberId: 'a', x: 0, y: 0, w: 100, h: 40, text: 'Card A', extra: {} } as unknown as BoardItem,
];

function destinations(deliverImpls: { downloads: boolean; anchor: boolean }): OutputDestination[] {
  return [
    { id: 'downloads', label: 'Downloads', deliver: async () => deliverImpls.downloads },
    // fallbackOnly: the anchor. Never a visible button; only reached in the auto chain.
    { id: 'anchor', label: 'Download file', fallbackOnly: true, deliver: async () => deliverImpls.anchor },
    { id: 'clip', label: 'Copy to clipboard', deliver: async () => deliverImpls.downloads },
  ];
}

afterEach(() => cleanup());

describe('BoardExportPanel — R43a dedupe + R43b toast', () => {
  it('does NOT render a fallbackOnly destination as a visible choice (R43a)', () => {
    const { queryByLabelText, getByLabelText } = render(
      <BoardExportPanel items={ITEMS} now={0} title="My board" destinations={destinations({ downloads: true, anchor: true })} onClose={() => {}} />,
    );
    // The real, working destination is shown...
    expect(getByLabelText('Downloads')).toBeTruthy();
    expect(getByLabelText('Copy to clipboard')).toBeTruthy();
    // ...the dead browser-anchor duplicate is NOT a visible button.
    expect(queryByLabelText('Download file')).toBeNull();
  });

  it('fires the success notice when a destination delivers (R43b)', async () => {
    const onNotice = vi.fn();
    const { getByLabelText } = render(
      <BoardExportPanel items={ITEMS} now={0} title="My board" destinations={destinations({ downloads: true, anchor: true })} onNotice={onNotice} onClose={() => {}} />,
    );
    fireEvent.click(getByLabelText('Downloads'));
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    const [, tone] = onNotice.mock.calls[onNotice.mock.calls.length - 1];
    expect(tone).toBe('success');
  });

  it('fires the error notice when delivery fails (R43b)', async () => {
    const onNotice = vi.fn();
    const { getByLabelText } = render(
      <BoardExportPanel items={ITEMS} now={0} title="My board" destinations={destinations({ downloads: false, anchor: false })} onNotice={onNotice} onClose={() => {}} />,
    );
    fireEvent.click(getByLabelText('Downloads'));
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    const [text, tone] = onNotice.mock.calls[onNotice.mock.calls.length - 1];
    expect(tone).toBe('error');
    expect(text).toBe('Could not export');
  });

  it('the auto Deliver still reaches the fallbackOnly anchor when visible ones fail (chain intact)', async () => {
    const onNotice = vi.fn();
    // Downloads + clipboard fail, only the fallbackOnly anchor succeeds -> auto chain must
    // still find it, proving fallbackOnly hides the button WITHOUT removing it from delivery.
    const dests: OutputDestination[] = [
      { id: 'downloads', label: 'Downloads', deliver: async () => false },
      { id: 'anchor', label: 'Download file', fallbackOnly: true, deliver: async () => true },
      { id: 'clip', label: 'Copy to clipboard', deliver: async () => false },
    ];
    const { getByLabelText } = render(
      <BoardExportPanel items={ITEMS} now={0} title="My board" destinations={dests} onNotice={onNotice} onClose={() => {}} />,
    );
    fireEvent.click(getByLabelText(/Deliver the board as/));
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    const [, tone] = onNotice.mock.calls[onNotice.mock.calls.length - 1];
    expect(tone).toBe('success');
  });

  it('renders injected image exports and delivers their BYTES through the chain (R43c)', async () => {
    const onNotice = vi.fn();
    const delivered: { filename: string; mimeType: string; hasBytes: boolean }[] = [];
    const dests: OutputDestination[] = [
      {
        id: 'downloads',
        label: 'Downloads',
        deliver: async (p) => { delivered.push({ filename: p.filename, mimeType: p.mimeType, hasBytes: !!(p.bytes && p.bytes.length) }); return true; },
      },
    ];
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const imageExports = [
      { id: 'image-png', label: 'PNG', produce: async () => ({ filename: 'board.png', mimeType: 'image/png', bytes: pngBytes }) },
    ];
    const { getByLabelText } = render(
      <BoardExportPanel items={ITEMS} now={0} title="My board" destinations={dests} imageExports={imageExports} onNotice={onNotice} onClose={() => {}} />,
    );
    fireEvent.click(getByLabelText('Export as PNG'));
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    const [text, tone] = onNotice.mock.calls[onNotice.mock.calls.length - 1];
    expect(tone).toBe('success');
    expect(text).toBe('Exported as PNG');
    // The image artifact reached the destination as BYTES (not text) with its own filename/mime.
    expect(delivered).toEqual([{ filename: 'board.png', mimeType: 'image/png', hasBytes: true }]);
  });

  it('omits the image row entirely when no image exports are injected (blind panel)', () => {
    const { queryByLabelText } = render(
      <BoardExportPanel items={ITEMS} now={0} title="My board" destinations={destinations({ downloads: true, anchor: true })} onClose={() => {}} />,
    );
    expect(queryByLabelText('Export as PNG')).toBeNull();
    expect(queryByLabelText('Export as SVG')).toBeNull();
  });
});
