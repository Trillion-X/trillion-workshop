// Floating-layer focus regression for a note edit session.
//
// Regression lock for #211 Bug B: the note edit session must survive focus moving
// into ANY portaled floating layer (the toolbar, the paint panel, its nested
// Add-menu / colour popover — all marked `data-floating-layer`), and end ONLY when
// focus settles outside the editor and every floating layer. The editor's onBlur
// asks one question — did focus settle in-session — and defers one animation frame
// past the portal focus-juggling that emits null/foreign relatedTarget blurs.

import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { rendererForKind } from './item-renderers';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => { cleanup(); document.body.querySelectorAll('[data-test-scratch]').forEach((n) => n.remove()); });

function renderEditingNote(onEndEdit: () => void) {
  const Note = rendererForKind('note');
  const item = {
    kind: 'note', memberId: 'm1', x: 0, y: 0, w: 220, h: 140, text: 'hi', html: '<p>hi</p>', extra: {},
  } as unknown as BoardItem;
  return render(<Note item={item} selected editing onEndEdit={onEndEdit} onEditHtml={() => {}} />);
}

const twoFrames = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

describe('#211 Bug B — edit session survives portaled floating layers', () => {
  it('blur INTO a floating layer (e.g. the Add menu) does NOT end the session', async () => {
    const onEndEdit = vi.fn();
    const { container } = renderEditingNote(onEndEdit);
    const ce = container.querySelector('[contenteditable="true"]') as HTMLElement;
    expect(ce).not.toBeNull();
    // A portaled Add-menu / colour popover carries the shared marker.
    const layer = document.createElement('div');
    layer.setAttribute('data-floating-layer', '');
    layer.setAttribute('data-test-scratch', '');
    const btn = document.createElement('button');
    layer.appendChild(btn);
    document.body.appendChild(layer);
    btn.focus();
    fireEvent.blur(ce, { relatedTarget: btn });
    await twoFrames();
    expect(onEndEdit).not.toHaveBeenCalled();
  });

  it('blur to a PLAIN outside target (focus settles outside every layer) ENDS the session', async () => {
    const onEndEdit = vi.fn();
    const { container } = renderEditingNote(onEndEdit);
    const ce = container.querySelector('[contenteditable="true"]') as HTMLElement;
    const outside = document.createElement('button');
    outside.setAttribute('data-test-scratch', '');
    document.body.appendChild(outside);
    outside.focus(); // focus genuinely settled outside the editor + any floating layer
    fireEvent.blur(ce, { relatedTarget: outside });
    await twoFrames();
    expect(onEndEdit).toHaveBeenCalled();
  });

  it('a null-relatedTarget blur (portal focus juggling) does NOT end the session while focus is still inside a layer', async () => {
    const onEndEdit = vi.fn();
    const { container } = renderEditingNote(onEndEdit);
    const ce = container.querySelector('[contenteditable="true"]') as HTMLElement;
    const layer = document.createElement('div');
    layer.setAttribute('data-floating-layer', '');
    layer.setAttribute('data-test-scratch', '');
    const inner = document.createElement('button');
    layer.appendChild(inner);
    document.body.appendChild(layer);
    inner.focus(); // focus really landed in the floating layer…
    fireEvent.blur(ce, { relatedTarget: null }); // …but the blur reports null (Radix portal juggling)
    await twoFrames();
    // The deferred activeElement check sees focus inside the floating layer → stays.
    expect(onEndEdit).not.toHaveBeenCalled();
  });
});
