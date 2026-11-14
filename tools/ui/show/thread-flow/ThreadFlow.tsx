// parts/ui/show/thread-flow/ThreadFlow.tsx
//
// Purpose: a left-to-right flow of hand-drawn nodes in columns, joined by curves in the thread's
// colour, that carries a page's ScrollThread across it. The first node is where the page's thread
// arrives (it waits there, then lifts off); the last node of the last column is where it comes back
// down and carries on. When the thread arrives, the flow's own links draw themselves column by
// column, and each column's nodes come alive as their links reach them: steps tick on one after
// another and items slide in. On a narrow screen the columns stack and the links run downward.
//
// A node may carry: a title and detail line, an illustration, a logo or letter mark, numbered steps,
// a list of items (each with its own logo or letter mark), and a handwritten note beneath it.
//
// Invariants:
// 1. Knows no product: every word, picture and mark arrives in `columns`.
// 2. The flow is two anchors in the page's thread: `threadFrom` (first node) and `threadFrom + 1`
//    (last node), so the page decides where the flow sits in its thread.
// 3. Columns of one node join every node of their neighbour; equal columns join node to node.
// 4. Colours and fonts come from theme roles and tokens only; with reduced motion nothing moves and
//    every link is drawn.

import { useEffect, useRef, type ComponentType } from 'react';
import { HandNote, SketchFigure, SketchFrame } from '../sketch/Sketch';

/** A logo picture, a drawn icon, or letters. A card's own mark (beside its title) is drawn in the
 *  thread's colour unless it is a picture. */
export type FlowMark = { image?: string; icon?: ComponentType<{ size?: number; strokeWidth?: number }>; letters?: string; label: string };

export type FlowNode = {
  id: string;
  title?: string;
  detail?: string;
  figure?: { src: string; alt: string; width: number; height: number };
  mark?: FlowMark;
  steps?: readonly string[];
  items?: readonly { label: string; mark?: FlowMark }[];
  note?: string;
  /** Tints the node as the flow's centre. */
  highlighted?: boolean;
  /** A mark-only node: just the logo, no card text. */
  compact?: boolean;
  /** Where the page's thread meets this node, when it is the first or last node (0..1 across and
   *  down), wide and narrow; centre by default. */
  threadPlace?: { x?: number; y?: number; narrowX?: number; narrowY?: number };
};

export type FlowColumn = { id: string; nodes: readonly FlowNode[] };

export type ThreadFlowProps = {
  label: string;
  columns: readonly FlowColumn[];
  threadFrom: number;
};

function Mark({ mark, size }: { mark: FlowMark; size: 'large' | 'small' }) {
  const Icon = mark.icon;
  return (
    <span className="thread-flow__mark" data-size={size} data-kind={mark.image ? 'image' : Icon ? 'icon' : 'letters'}>
      {mark.image ? <img src={mark.image} alt={mark.label} loading="lazy" decoding="async" />
        : Icon ? <span role="img" aria-label={mark.label}><Icon size={size === 'large' ? 22 : 12} strokeWidth={2.2} /></span>
          : <span aria-label={mark.label}>{mark.letters}</span>}
    </span>
  );
}

export function ThreadFlow({ label, columns, threadFrom }: ThreadFlowProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<SVGSVGElement>(null);
  const first = columns[0]?.nodes[0]?.id;
  const last = columns[columns.length - 1]?.nodes.at(-1)?.id;
  let seed = threadFrom;

  useEffect(() => {
    const root = rootRef.current;
    const lines = linesRef.current;
    if (!root || !lines) return;
    const draw = () => {
      const box = root.getBoundingClientRect();
      lines.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      const columnNodes = [...root.querySelectorAll<HTMLElement>('.thread-flow__column')].map((column) =>
        [...column.querySelectorAll<HTMLElement>(':scope > .thread-flow__node')].map((node) => node.getBoundingClientRect()),
      );
      const curves: { d: string; column: number }[] = [];
      for (let index = 0; index < columnNodes.length - 1; index += 1) {
        const from = columnNodes[index];
        const to = columnNodes[index + 1];
        const pairs = from.length === 1 || to.length === 1
          ? from.flatMap((a) => to.map((b) => [a, b] as const))
          : from.map((a, i) => [a, to[Math.min(i, to.length - 1)]] as const);
        for (const [a, b] of pairs) {
          if (b.left >= a.right - 4) {
            const x1 = a.right - box.left, y1 = a.top + a.height / 2 - box.top;
            const x2 = b.left - box.left, y2 = b.top + b.height / 2 - box.top;
            const bend = (x2 - x1) * 0.55;
            curves.push({ d: `M ${x1} ${y1} C ${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`, column: index });
          } else {
            const x1 = a.left + a.width / 2 - box.left, y1 = a.bottom - box.top;
            const x2 = b.left + b.width / 2 - box.left, y2 = b.top - box.top;
            const bend = (y2 - y1) * 0.55;
            curves.push({ d: `M ${x1} ${y1} C ${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`, column: index });
          }
        }
      }
      lines.replaceChildren(...curves.map(({ d, column }) => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('pathLength', '1');
        path.style.setProperty('--column', String(column));
        return path;
      }));
    };
    // The page's thread marks the first node reached; from then on the flow's links draw themselves.
    const entry = root.querySelector<HTMLElement>('[data-flow-entry]');
    const light = () => { root.dataset.flowLit = entry?.dataset.threadReached === 'true' ? 'true' : 'false'; };
    const reached = new MutationObserver(light);
    if (entry) reached.observe(entry, { attributes: true, attributeFilter: ['data-thread-reached'] });
    const observer = new ResizeObserver(draw);
    observer.observe(root);
    draw();
    light();
    return () => {
      observer.disconnect();
      reached.disconnect();
    };
  }, [columns]);

  return (
    <div
      ref={rootRef}
      className="thread-flow"
      role="group"
      aria-label={label}
      // A column of logo marks only takes the width of its marks; every card column shares the rest.
      style={{ ['--thread-flow-columns' as string]: columns.map((column) => (column.nodes.every((node) => node.compact) ? 'auto' : 'minmax(0, 1fr)')).join(' ') }}
    >
      <style>{STYLE}</style>
      <svg ref={linesRef} className="thread-flow__lines" aria-hidden="true" focusable="false" />
      {columns.map((column, columnIndex) => (
        <div key={column.id} className="thread-flow__column" data-count={column.nodes.length} data-compact={column.nodes.every((node) => node.compact) ? 'true' : 'false'} style={{ ['--column' as string]: columnIndex }}>
          {column.nodes.map((node) => {
            seed += 1;
            const place = node.threadPlace ?? {};
            const edge = node.id === first ? 'entry' : node.id === last ? 'exit' : null;
            const anchor = !edge ? {} : {
              'data-thread-anchor': String(edge === 'entry' ? threadFrom : threadFrom + 1),
              ...(edge === 'entry' ? { 'data-flow-entry': '', 'data-thread-wait': '', 'data-thread-lift': '' } : {}),
              ...(place.x !== undefined ? { 'data-thread-x': String(place.x) } : {}),
              ...(place.y !== undefined ? { 'data-thread-y': String(place.y) } : {}),
              ...(place.narrowX !== undefined ? { 'data-thread-narrow-x': String(place.narrowX) } : {}),
              ...(place.narrowY !== undefined ? { 'data-thread-narrow-y': String(place.narrowY) } : {}),
            };
            if (node.compact && node.mark) {
              return (
                <SketchFrame key={node.id} seed={seed} className="thread-flow__node thread-flow__node--compact" {...anchor}>
                  <Mark mark={node.mark} size="large" />
                </SketchFrame>
              );
            }
            return (
              <div key={node.id} className="thread-flow__node" {...anchor}>
                <SketchFrame seed={seed} highlighted={node.highlighted} className="thread-flow__card">
                  {node.figure ? <SketchFigure className="thread-flow__figure" {...node.figure} breathe={5} /> : null}
                  {node.title ? (
                    <span className="thread-flow__head" data-marked={node.mark ? 'true' : 'false'}>
                      {node.mark ? <Mark mark={node.mark} size="large" /> : null}
                      <span>
                        <span className="thread-flow__title">{node.title}</span>
                        {node.detail ? <span className="thread-flow__detail">{node.detail}</span> : null}
                      </span>
                    </span>
                  ) : null}
                  {node.steps?.length ? (
                    <ol className="thread-flow__steps">
                      {node.steps.map((step, index) => (
                        <li key={step} style={{ ['--step' as string]: index }}>
                          <span className="thread-flow__number" aria-hidden="true">{index + 1}</span>
                          {step}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {node.items?.length ? (
                    <ul className="thread-flow__items">
                      {node.items.map((item, index) => (
                        <li key={item.label} style={{ ['--step' as string]: index }}>
                          {item.mark ? <Mark mark={item.mark} size="small" /> : null}
                          {item.label}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </SketchFrame>
                {node.note ? <HandNote className="thread-flow__note" tilt={-5}>{node.note}</HandNote> : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const STYLE = `
  .thread-flow { position: relative; display: grid; grid-template-columns: var(--thread-flow-columns); gap: clamp(1.6rem, 3.4vw, 4rem); align-items: center; }
  .thread-flow__lines { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; z-index: 0; }
  .thread-flow__lines path { fill: none; stroke: var(--thread-line); stroke-width: 2; stroke-linecap: round; stroke-dasharray: 1 1; stroke-dashoffset: 1; transition: stroke-dashoffset 520ms ease-in-out calc(var(--column) * 520ms); }
  .thread-flow[data-flow-lit="true"] .thread-flow__lines path { stroke-dashoffset: 0; }
  .thread-flow__column { position: relative; z-index: 1; display: grid; gap: 1.4rem; justify-items: stretch; }
  .thread-flow__column[data-compact="true"] { justify-items: center; gap: 1.3rem; }
  .thread-flow__node { position: relative; display: grid; gap: .8rem; justify-items: start; }
  .thread-flow__node--compact { display: grid; place-items: center; width: 5.2rem; height: 5.2rem; }
  .thread-flow__card { width: 100%; padding: 1.3rem 1.35rem; display: grid; gap: .9rem; }
  .thread-flow__figure { width: 9rem; justify-self: center; }
  .thread-flow__head { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .7rem; align-items: center; }
  .thread-flow__head[data-marked="false"] { grid-template-columns: minmax(0, 1fr); }
  .thread-flow__title { display: block; color: var(--text-primary); font: 600 1.14rem/1.3 var(--font-body); }
  .thread-flow__detail { display: block; margin-top: .15rem; color: var(--text-secondary); font: 400 .94rem/1.4 var(--font-body); }
  .thread-flow__mark { display: grid; place-items: center; overflow: hidden; flex: none; border-radius: 9px; color: var(--on-accent); background: var(--ink-line); font: 700 .82rem/1 var(--font-body); }
  .thread-flow__mark[data-kind="image"] { background: transparent; }
  .thread-flow__head .thread-flow__mark[data-kind="letters"], .thread-flow__head .thread-flow__mark[data-kind="icon"] { background: var(--thread-line); color: var(--on-accent); }
  .thread-flow__mark[data-kind="icon"] > span { display: grid; place-items: center; }
  .thread-flow__mark[data-size="large"] { width: 2.8rem; height: 2.8rem; }
  .thread-flow__node--compact .thread-flow__mark[data-size="large"] { width: 3rem; height: 3rem; }
  .thread-flow__mark[data-size="small"] { width: 1.5rem; height: 1.5rem; border-radius: 5px; font-size: .66rem; }
  .thread-flow__mark img { width: 100%; height: 100%; object-fit: contain; }
  .thread-flow__node--compact .thread-flow__mark { animation: thread-flow-bob 5s ease-in-out infinite; }
  .thread-flow__column .thread-flow__node--compact:nth-child(2) .thread-flow__mark { animation-delay: -1.2s; }
  .thread-flow__column .thread-flow__node--compact:nth-child(3) .thread-flow__mark { animation-delay: -2.5s; }
  .thread-flow__column .thread-flow__node--compact:nth-child(4) .thread-flow__mark { animation-delay: -3.7s; }
  .thread-flow__column .thread-flow__node--compact:nth-child(5) .thread-flow__mark { animation-delay: -4.6s; }
  .thread-flow__steps, .thread-flow__items { display: grid; gap: .45rem; margin: 0; padding: 0; list-style: none; }
  .thread-flow__column { --arrive: calc(var(--column) * 520ms); }
  .thread-flow__steps li, .thread-flow__items li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .55rem; align-items: center; color: var(--text-secondary); font: 400 .98rem/1.4 var(--font-body); opacity: .35; translate: -6px 0; transition: color 300ms ease calc(var(--arrive) + var(--step) * 220ms), opacity 400ms ease calc(var(--arrive) + var(--step) * 160ms), translate 400ms ease calc(var(--arrive) + var(--step) * 160ms); }
  .thread-flow__steps li { opacity: 1; translate: 0 0; }
  .thread-flow__number { display: grid; place-items: center; width: 1.45rem; height: 1.45rem; border: 1px solid color-mix(in srgb, var(--ink-line) 35%, transparent); border-radius: 999px; font: 600 .7rem/1 var(--font-body); transition: background 300ms ease calc(var(--arrive) + var(--step) * 220ms), color 300ms ease calc(var(--arrive) + var(--step) * 220ms), border-color 300ms ease calc(var(--arrive) + var(--step) * 220ms); }
  .thread-flow[data-flow-lit="true"] .thread-flow__steps li { color: var(--text-primary); }
  .thread-flow[data-flow-lit="true"] .thread-flow__number { border-color: var(--thread-line); background: var(--thread-line); color: var(--on-accent); }
  .thread-flow[data-flow-lit="true"] .thread-flow__items li { opacity: 1; translate: 0 0; }
  .thread-flow__note { margin: .2rem 0 0 1.6rem; font-size: 1.6rem; }
  @keyframes thread-flow-bob { 0%, 100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-3px) rotate(2deg); } }
  @media (max-width: 900px) {
    .thread-flow { grid-template-columns: minmax(0, 1fr); gap: 2.4rem; }
    .thread-flow__column[data-compact="true"] { grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); justify-items: center; gap: .6rem; }
    .thread-flow__column[data-compact="true"] .thread-flow__node--compact { width: min(5.2rem, 100%); height: auto; aspect-ratio: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .thread-flow__node--compact .thread-flow__mark { animation: none; }
    .thread-flow__steps li, .thread-flow__items li, .thread-flow__number, .thread-flow__lines path { transition: none; }
    .thread-flow__lines path { stroke-dashoffset: 0; }
  }
`;
