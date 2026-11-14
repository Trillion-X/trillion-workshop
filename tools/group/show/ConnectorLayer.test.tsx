// packages/group/show/ConnectorLayer.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import { ConnectorLayer, type ConnectorModel, type ConnectorRect } from './ConnectorLayer';

const rects = new Map<string, ConnectorRect>([
  ['a', { x: 0, y: 0, w: 100, h: 60 }],
  ['b', { x: 300, y: 200, w: 100, h: 60 }],
]);

function model(over: Partial<ConnectorModel> = {}): ConnectorModel {
  return { memberId: 'c1', fromMemberId: 'a', toMemberId: 'b', selected: false, ...over };
}

// The connector paths live inside the per-connector `<g>`; the arrowhead marker's
// own `<path>` lives under `<defs><marker>` and is NOT inside a `<g>`, so `g path`
// scopes cleanly to the hit + visible connector paths.
const connectorPaths = (c: HTMLElement) => [...c.querySelectorAll('g path')];
const visiblePath = (c: HTMLElement) => c.querySelector('path[marker-end]');
const hitPath = (c: HTMLElement) => connectorPaths(c).find((p) => p.getAttribute('stroke') === 'transparent')!;
// cont.26 — a rough connector drops the crisp marker for a hand-drawn head, so bowed-ness is tested by
// the presence of a quadratic (Q) in any drawn path rather than by the marker-bearing visible path.
const bowed = (c: HTMLElement) => connectorPaths(c).some((p) => (p.getAttribute('d') ?? '').includes('Q'));
const firstBowedD = (c: HTMLElement) => (connectorPaths(c).map((p) => p.getAttribute('d') ?? '').find((d) => d.includes('Q')) ?? '');
const firstPoint = (d: string) => {
  const m = d.match(/^M\s+([\d.-]+)\s+([\d.-]+)/)!;
  return { x: Number(m[1]), y: Number(m[2]) };
};

describe('ConnectorLayer', () => {
  it('draws a visible path + a hit path between two resolved endpoints', () => {
    const { container } = render(
      <ConnectorLayer connectors={[model()]} rects={rects} preview={null} onSelect={() => {}} />,
    );
    // One visible stroke + one fat transparent hit path per connector.
    expect(connectorPaths(container).length).toBe(2);
    // The visible path carries the arrowhead marker.
    expect(visiblePath(container)).not.toBeNull();
  });

  it('clips endpoints to the box borders (not the centers)', () => {
    const { container } = render(
      <ConnectorLayer connectors={[model()]} rects={rects} preview={null} onSelect={() => {}} />,
    );
    const { x, y } = firstPoint(visiblePath(container)!.getAttribute('d')!);
    // Center of A is (50,30); the start point must sit ON A's border, i.e. past the
    // center toward B — so x > 50 and within the box's right/bottom extent.
    expect(x).toBeGreaterThan(50);
    expect(x).toBeLessThanOrEqual(100);
    expect(y).toBeGreaterThan(30);
  });

  it('a crisp connector (no roughness) draws ONE straight visible path — byte-identical, zero regression', () => {
    const { container } = render(
      <ConnectorLayer connectors={[model()]} rects={rects} preview={null} onSelect={() => {}} />,
    );
    expect(connectorPaths(container).length).toBe(2); // hit + 1 crisp visible
    expect(visiblePath(container)!.getAttribute('d')).not.toContain('Q'); // plain M…L…, no bows
  });

  it('cont.26 — a connector with roughness renders a PENCIL stroke (two bowed quadratic paths)', () => {
    const { container } = render(
      <ConnectorLayer connectors={[model({ roughness: 2, arrow: 'none' })]} rects={rects} preview={null} onSelect={() => {}} />,
    );
    expect(connectorPaths(container).length).toBe(3); // hit (crisp) + 2 rough visible (doubleStroke); no head (arrow none)
    expect(bowed(container)).toBe(true); // hand-drawn bows
  });

  it('cont.26 — the board default roughness applies when a connector has no per-line value', () => {
    const { container } = render(
      <ConnectorLayer connectors={[model({ arrow: 'none' })]} rects={rects} preview={null} onSelect={() => {}} defaultRoughness={3} />,
    );
    expect(connectorPaths(container).length).toBe(3); // pencil from the board default
    expect(bowed(container)).toBe(true);
    expect(hitPath(container).getAttribute('d')).not.toContain('Q'); // hit-band stays crisp for clicks
  });

  it('cont.26 Line-style — a NAMED brushstroke (pencil) renders a bowed pencil stroke; per-line wins over board default', () => {
    const { container } = render(
      <ConnectorLayer connectors={[model({ strokeStyle: 'pencil', arrow: 'none' })]} rects={rects} preview={null} onSelect={() => {}} />,
    );
    expect(connectorPaths(container).length).toBe(3); // hit + 2 doubleStroke pencil paths
    expect(bowed(container)).toBe(true);
  });

  it('cont.26 Line-style — the board defaultStrokeStyle applies when a line has none', () => {
    const { container } = render(
      <ConnectorLayer connectors={[model({ arrow: 'none' })]} rects={rects} preview={null} onSelect={() => {}} defaultStrokeStyle="sketch" />,
    );
    expect(connectorPaths(container).length).toBe(3); // sketch brushstroke from the board default
    expect(bowed(container)).toBe(true);
  });

  it('cont.26 — a ROUGH connector draws a HAND-DRAWN arrowhead (no crisp marker); a crisp one keeps the marker', () => {
    const rough = render(<ConnectorLayer connectors={[model({ roughness: 2 })]} rects={rects} preview={null} onSelect={() => {}} />); // arrow 'end' default
    expect(rough.container.querySelector('path[marker-end]')).toBeNull(); // no crisp triangle on a pencil line
    expect(connectorPaths(rough.container).length).toBeGreaterThan(3); // hit + 2 line + hand-drawn head paths
    expect(bowed(rough.container)).toBe(true);
    const crisp = render(<ConnectorLayer connectors={[model()]} rects={rects} preview={null} onSelect={() => {}} />);
    expect(crisp.container.querySelector('path[marker-end]')).not.toBeNull(); // a crisp line keeps the marker
  });

  it('cont.26 Line-style — a dashed style stays CRISP but applies a dash; solid styles do not', () => {
    const { container } = render(
      <ConnectorLayer connectors={[model({ strokeStyle: 'dashed' })]} rects={rects} preview={null} onSelect={() => {}} />,
    );
    const v = visiblePath(container)!;
    expect(v.getAttribute('d')).not.toContain('Q'); // dashed is roughness 0 → crisp
    expect(v.getAttribute('stroke-dasharray')).toBeTruthy(); // …but dashed
  });

  it('cont.26 Line-style — marker and sketch bow DIFFERENTLY (bowing now flows, not just roughness)', () => {
    const draw = (id: string) => {
      const { container } = render(
        <ConnectorLayer connectors={[model({ strokeStyle: id, arrow: 'none' })]} rects={rects} preview={null} onSelect={() => {}} />,
      );
      return firstBowedD(container);
    };
    const marker = draw('marker');
    const sketch = draw('sketch');
    expect(marker).toContain('Q');
    expect(sketch).toContain('Q');
    expect(marker).not.toBe(sketch); // different bowing/roughness → distinguishable brushstrokes (the fix)
  });

  it('skips a dangling connector whose endpoint rect is missing', () => {
    const { container } = render(
      <ConnectorLayer
        connectors={[model({ toMemberId: 'ghost' })]}
        rects={rects}
        preview={null}
        onSelect={() => {}}
      />,
    );
    expect(connectorPaths(container).length).toBe(0);
  });

  it('renders the dashed creation preview (a straight rubber-band line)', () => {
    const { container } = render(
      <ConnectorLayer
        connectors={[]}
        rects={rects}
        preview={{ from: { x: 10, y: 10 }, to: { x: 200, y: 120 } }}
        onSelect={() => {}}
      />,
    );
    const dashed = container.querySelector('line[stroke-dasharray]');
    expect(dashed).not.toBeNull();
    expect(dashed!.getAttribute('x2')).toBe('200');
  });

  it('selects on pointer-down of the hit path (shift = additive)', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ConnectorLayer connectors={[model()]} rects={rects} preview={null} onSelect={onSelect} />,
    );
    fireEvent.pointerDown(hitPath(container));
    // Clicking the hit path selects THAT connector by id (the additive flag rides
    // e.shiftKey, which jsdom's synthetic PointerEvent does not serialize).
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe('c1');
  });

  it('renders two endpoint handles ONLY for a selected connector with onEndpointDown', () => {
    const { container, rerender } = render(
      <ConnectorLayer connectors={[model({ selected: true })]} rects={rects} preview={null} onSelect={() => {}} onEndpointDown={() => {}} />,
    );
    expect(container.querySelectorAll('circle').length).toBe(2);
    // Unselected → no handles.
    rerender(<ConnectorLayer connectors={[model({ selected: false })]} rects={rects} preview={null} onSelect={() => {}} onEndpointDown={() => {}} />);
    expect(container.querySelectorAll('circle').length).toBe(0);
    // Selected but no onEndpointDown (edit-disabled) → no handles.
    rerender(<ConnectorLayer connectors={[model({ selected: true })]} rects={rects} preview={null} onSelect={() => {}} />);
    expect(container.querySelectorAll('circle').length).toBe(0);
  });

  it('begins a re-anchor on endpoint-handle pointer-down (reports memberId + which end)', () => {
    const onEndpointDown = vi.fn();
    const { container } = render(
      <ConnectorLayer connectors={[model({ selected: true })]} rects={rects} preview={null} onSelect={() => {}} onEndpointDown={onEndpointDown} />,
    );
    const handles = [...container.querySelectorAll('circle')];
    expect(handles.length).toBe(2);
    handles[0].setPointerCapture = () => {}; // jsdom lacks it; the handler calls it
    fireEvent.pointerDown(handles[0]);
    expect(onEndpointDown).toHaveBeenCalledTimes(1);
    expect(onEndpointDown.mock.calls[0][0]).toBe('c1');
    expect(['from', 'to']).toContain(onEndpointDown.mock.calls[0][1]);
  });

  it('renders a label chip with the relationship name only when label is set', () => {
    const { container, queryByText, rerender } = render(
      <ConnectorLayer connectors={[model({ label: 'blocks' })]} rects={rects} preview={null} onSelect={() => {}} />,
    );
    expect(queryByText('blocks')).not.toBeNull();
    expect(container.querySelectorAll('text').length).toBe(1);
    rerender(<ConnectorLayer connectors={[model()]} rects={rects} preview={null} onSelect={() => {}} />);
    expect(container.querySelectorAll('text').length).toBe(0); // no label → no chip
  });

  it('double-clicking a connector fires onLabelEdit with its memberId', () => {
    const onLabelEdit = vi.fn();
    const { container } = render(
      <ConnectorLayer connectors={[model()]} rects={rects} preview={null} onSelect={() => {}} onLabelEdit={onLabelEdit} />,
    );
    fireEvent.doubleClick(hitPath(container));
    expect(onLabelEdit).toHaveBeenCalledWith('c1');
  });

  it('renders style DATA: custom color, dashed stroke, and arrow direction', () => {
    // dashed + custom color + both-ends arrow
    const both = render(
      <ConnectorLayer connectors={[model({ color: '#ef4444', dashed: true, arrow: 'both' })]} rects={rects} preview={null} onSelect={() => {}} />,
    );
    const line = visiblePath(both.container)!;
    expect(line.getAttribute('stroke')).toBe('#ef4444');
    expect(line.getAttribute('stroke-dasharray')).toBe('7 5');
    expect(line.getAttribute('marker-start')).toBe('url(#board-arrowhead-triangle)'); // both → start marker (b94 default triangle)
    both.unmount();

    // arrow:'none' → no markers at all
    const none = render(
      <ConnectorLayer connectors={[model({ arrow: 'none' })]} rects={rects} preview={null} onSelect={() => {}} />,
    );
    const nl = connectorPaths(none.container).find((p) => p.getAttribute('stroke') !== 'transparent')!;
    expect(nl.getAttribute('marker-end')).toBeNull();
    expect(nl.getAttribute('marker-start')).toBeNull();
  });

  it('applies the board-DEFAULT connector style (arrow/routing/dashed) when a line has no per-line value; per-line wins', () => {
    const visibleOf = (c: HTMLElement) => connectorPaths(c).find((p) => p.getAttribute('stroke') !== 'transparent')!;
    // Board defaults: dashed + no-arrow + elbow. A connector with NO per-line style adopts all three.
    const def = render(
      <ConnectorLayer
        connectors={[model()]}
        rects={rects}
        preview={null}
        onSelect={() => {}}
        defaultArrow="none"
        defaultRouting="elbow"
        defaultDashed
      />,
    );
    const line = visibleOf(def.container);
    expect(line.getAttribute('stroke-dasharray')).toBe('7 5'); // board default dashed
    expect(line.getAttribute('marker-end')).toBeNull(); // board default arrow 'none'
    expect((line.getAttribute('d')!.match(/ L /g) || []).length).toBeGreaterThanOrEqual(3); // board default elbow
    def.unmount();

    // A per-line value OVERRIDES the board default (solid + arrow-at-end + straight beat dashed/none/elbow).
    const over = render(
      <ConnectorLayer
        connectors={[model({ dashed: false, arrow: 'end', routing: 'straight' })]}
        rects={rects}
        preview={null}
        onSelect={() => {}}
        defaultArrow="none"
        defaultRouting="elbow"
        defaultDashed
      />,
    );
    const line2 = visibleOf(over.container);
    expect(line2.getAttribute('stroke-dasharray')).toBeNull(); // per-line solid wins over board dashed
    expect(line2.getAttribute('marker-end')).toBe('url(#board-arrowhead-triangle)'); // per-line arrow wins (b94 default triangle)
    const d2 = line2.getAttribute('d')!;
    expect(d2).toContain(' L ');
    expect(d2).not.toContain('Q'); // per-line straight wins over board elbow
    over.unmount();
  });

  it('routes the path by the member routing DATA: straight, curved (bezier), elbow (orthogonal)', () => {
    const dOf = (over: Partial<ConnectorModel>) => {
      const r = render(<ConnectorLayer connectors={[model(over)]} rects={rects} preview={null} onSelect={() => {}} />);
      const d = visiblePath(r.container)!.getAttribute('d')!;
      r.unmount();
      return d;
    };
    // straight (default + explicit) → a single line segment: one L, no curve command.
    const straight = dOf({ routing: 'straight' });
    expect(straight).toMatch(/^M /);
    expect(straight).toContain(' L ');
    expect(straight).not.toContain('Q');
    expect(dOf({})).toBe(straight); // absent routing reproduces straight
    // curved → a quadratic bezier.
    expect(dOf({ routing: 'curved' })).toContain('Q');
    // elbow → an orthogonal polyline with ≥3 L segments (Manhattan route).
    const elbow = dOf({ routing: 'elbow' });
    expect(elbow).not.toContain('Q');
    expect((elbow.match(/ L /g) || []).length).toBeGreaterThanOrEqual(3);
  });
});
