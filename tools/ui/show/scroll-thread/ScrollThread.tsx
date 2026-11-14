// parts/ui/show/scroll-thread/ScrollThread.tsx
//
// Purpose: one continuous line drawn down a page as the reader scrolls. The line runs through every
// element in its container that carries `data-thread-anchor`, in the anchors' numeric order, as one
// smooth curve; an anchor with `data-thread-tangle` gets a hand-drawn ball of loops around it. The
// line travels with the reader: at each anchor marked `data-thread-wait` it arrives before the reader
// does (while that anchor is still low in the window) and waits there until the reader catches up.
// Every anchor the line has reached gets `data-thread-reached="true"`, so what it touches can react.
//
// Anchor attributes (all DATA on the page's own elements; this part names no page or section):
//   data-thread-anchor   number   the anchor's place in the line's order
//   data-thread-x        number   where across the element the line passes (0 left, 1 right; default 0.5)
//   data-thread-y        number   where down the element the line passes (0 top, 1 bottom; default 0.5)
//   data-thread-tangle   px       radius of a ball of loops the line winds into at this anchor (the
//                                 bigger the ball, the more loops, so a large ball reads as dense)
//   data-thread-loop     px       the line goes once around the whole element, this far clear of it,
//                                 entering and leaving on the side it came from
//   data-thread-wait     present  the line arrives early here and waits for the reader
//   data-thread-lift     present  the line lifts off here and comes back down at the next anchor, so
//                                 something else on the page (a diagram's own links) carries it between
//   data-thread-end      present  this anchor is the last point of the line: nothing after it, in the anchors'
//                                 order, is drawn. Without one, the last anchor by order is the end
//   data-thread-narrow-x / -narrow-y / -narrow-tangle   the same, used instead when the window is narrow
//   data-thread-when     "narrow" or "wide": the anchor counts only at that window width
//
// Invariants:
// 1. One SVG, the full height of the container, rebuilt when the container or an anchor moves.
// 2. The drawn length only ever comes from the reader's scroll position (GSAP ScrollTrigger, scrubbed). At the top of
//    the page the line is already drawn to every waiting anchor the first window shows, so it is never missing on load.
// 3. With reduced motion the line is drawn in full and holds still; every anchor counts as reached.
// 4. The container must be positioned (relative); the line sits behind the content and never takes
//    pointer events. The drawn length is published as `data-thread-drawn` on the SVG.
// 5. The line looks drawn by hand: a second, thinner pass wanders a little either side of the first
//    and is drawn in step with it, so the stroke thickens and thins along its length.
// 6. Where the line lifts, each stretch between lifts is its own drawn path, and how much of it shows
//    comes from the whole line's drawn length. A dash pattern starts again at every subpath, so one
//    path with a lift in it drew every later stretch at the same time as the first, already showing
//    below the lift before the reader reached it (2026-10-05: the line stopped at the flow and a still
//    line ran down the rest of the page).
// 7. The ball and the curve are ./thread-geometry.mjs, the drawing the opening cover (../thread-cover) shares.
// 8. The line ends where the page says it ends. An anchor carrying `data-thread-end` is the last point: the line is
//    drawn through the anchors that come before it in order and never past it, whatever number any other anchor
//    carries (2026-10-11: a feature page numbered its sections past the closing call to action, so the line circled
//    the button and then jumped back up the page). Several marked anchors: the last by order is the end. None
//    marked: the last anchor by order is the end, as before. The end is also the last point the reader's scroll
//    draws to, so the line reaches it by scrolling and holds there to the bottom of the page. A marked end is also the
//    lowest the curve goes (the floor `capSegments` holds the curve to), so a long approach from high above cannot sag past it and
//    run under its section to the footer.

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { capSegments, curve, random, stopAtEnd, tangle } from './thread-geometry.mjs';

gsap.registerPlugin(ScrollTrigger);

export type ScrollThreadProps = {
  /** Line thickness in pixels. */
  strokeWidth?: number;
  /** How far down the window (0 top, 1 bottom) a waiting anchor is when the line reaches it. */
  arriveAt?: number;
  /** How far down the window a waiting anchor is when the line leaves it for the next one. */
  leaveAt?: number;
  /** Seed for the hand-drawn loops, so the same page always draws the same ball. */
  seed?: number;
  /** Window width (px) below which anchors use their narrow position and narrow-only anchors count. */
  narrowBelow?: number;
};

type Point = { x: number; y: number };
type Anchor = { element: HTMLElement; point: Point; box: { width: number; height: number }; tangle: number; loop: number; wait: boolean; lift: boolean; end: boolean };

// Once around an element, clear of it by `gap`: starts on the side facing `from`, ends just past it.
function loop(center: Point, box: { width: number; height: number }, gap: number, from: Point): Point[] {
  const rx = box.width / 2 + gap;
  const ry = box.height / 2 + gap;
  const start = Math.atan2((from.y - center.y) / ry, (from.x - center.x) / rx);
  const steps = 12;
  const points: Point[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = start + (index / steps) * Math.PI * 2.15;
    points.push({ x: center.x + Math.cos(angle) * rx, y: center.y + Math.sin(angle) * ry });
  }
  return points;
}

function readAnchors(container: HTMLElement, narrow: boolean): Anchor[] {
  const box = container.getBoundingClientRect();
  const width = narrow ? 'narrow' : 'wide';
  return stopAtEnd([...container.querySelectorAll<HTMLElement>('[data-thread-anchor]')]
    .filter((element) => (element.dataset.threadWhen ?? width) === width)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const across = Number((narrow ? element.dataset.threadNarrowX : undefined) ?? element.dataset.threadX ?? 0.5);
      const down = Number((narrow ? element.dataset.threadNarrowY : undefined) ?? element.dataset.threadY ?? 0.5);
      return {
        order: Number(element.dataset.threadAnchor),
        end: element.dataset.threadEnd !== undefined,
        anchor: {
          element,
          point: { x: rect.left - box.left + rect.width * across, y: rect.top - box.top + rect.height * down },
          box: { width: rect.width, height: rect.height },
          tangle: Number((narrow ? element.dataset.threadNarrowTangle : undefined) ?? element.dataset.threadTangle ?? 0),
          loop: Number(element.dataset.threadLoop ?? 0),
          wait: element.dataset.threadWait !== undefined,
          lift: element.dataset.threadLift !== undefined,
          end: element.dataset.threadEnd !== undefined,
        },
      };
    })
    .filter((item) => Number.isFinite(item.order) && item.anchor.element.getClientRects().length > 0)
    .sort((a, b) => a.order - b.order))
    .map((item) => item.anchor);
}

const SVG = 'http://www.w3.org/2000/svg';

// The stretches of a curve between lifts: each `M` segment starts a new one. Each stretch carries its own path text and
// the index of its first segment, so its place along the whole line can be measured.
function stretches(start: string, segments: string[]): { d: string; from: number }[] {
  const runs: { d: string; from: number }[] = [{ d: start, from: 0 }];
  segments.forEach((segment, index) => {
    if (segment.startsWith('M')) runs.push({ d: segment, from: index + 1 });
    else runs[runs.length - 1].d += ` ${segment}`;
  });
  return runs;
}

// One drawn path per stretch inside `group`, reused between builds.
function pathsIn(group: SVGGElement, count: number): SVGPathElement[] {
  while (group.childElementCount > count) group.lastElementChild?.remove();
  while (group.childElementCount < count) group.append(document.createElementNS(SVG, 'path'));
  return [...group.children] as SVGPathElement[];
}

export function ScrollThread({ strokeWidth = 3, arriveAt = 0.78, leaveAt = 0.42, seed = 7, narrowBelow = 900 }: ScrollThreadProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const measureRef = useRef<SVGPathElement>(null);
  const firstRef = useRef<SVGGElement>(null);
  const secondRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const path = pathRef.current;
    const measure = measureRef.current;
    const first = firstRef.current;
    const second = secondRef.current;
    const container = svg?.parentElement;
    if (!svg || !path || !measure || !first || !second || !container) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    let trigger: ScrollTrigger | null = null;
    let frame = 0;

    const build = () => {
      trigger?.kill();
      trigger = null;
      const anchors = readAnchors(container, window.innerWidth < narrowBelow);
      // The page is measured with the line folded away: the line's own box counts toward the container's scroll
      // height, so sizing it from a measure that includes itself grew the page a little on every rebuild, without end.
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      const pageWidth = container.scrollWidth;
      const pageHeight = container.scrollHeight;
      svg.setAttribute('width', String(pageWidth));
      svg.setAttribute('height', String(pageHeight));
      svg.setAttribute('viewBox', `0 0 ${pageWidth} ${pageHeight}`);
      if (anchors.length < 2) {
        path.setAttribute('d', '');
        pathsIn(first, 0);
        pathsIn(second, 0);
        return;
      }
      // Every anchor, with its loops, as one run of points; remember where each anchor sits in it.
      const next = random(seed);
      const points: Point[] = [];
      const pointOfAnchor: number[] = [];
      const lifted = new Set<number>();
      let endFrom = 0;
      for (const anchor of anchors) {
        endFrom = points.length;
        if (anchor.loop > 0 && points.length) {
          points.push(...loop(anchor.point, anchor.box, anchor.loop, points[points.length - 1]));
          // A loop belongs to this anchor. Its wait/reached point is the completed circle,
          // so the circle draws as the reader reaches the call to action.
          pointOfAnchor.push(points.length - 1);
          continue;
        }
        points.push(anchor.point);
        pointOfAnchor.push(points.length - 1);
        if (anchor.tangle > 0) points.push(...tangle(anchor.point, anchor.tangle, next));
        if (anchor.lift) lifted.add(points.length - 1);
      }
      // A marked end is also the lowest the line goes: the curve into it never sags below its last point or loop, so it
      // cannot run on under the end's section (to the footer) however far above the line came from.
      const finish = anchors[anchors.length - 1];
      const floor = finish.end ? Math.max(...points.slice(endFrom).map((point) => point.y)) : Infinity;
      const segments = capSegments(curve(points, lifted), floor);
      const start = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
      // The whole line, measured once (a lift's jump adds no length); never drawn itself.
      path.setAttribute('d', `${start} ${segments.join(' ')}`);
      const total = path.getTotalLength();
      const lengthBefore = (segmentCount: number) => {
        if (segmentCount === 0) return 0;
        measure.setAttribute('d', `${start} ${segments.slice(0, segmentCount).join(' ')}`);
        return measure.getTotalLength();
      };
      // The second pass: the same points, each nudged a little across the line.
      const wander = random(seed + 101);
      const nudged = points.map((point) => ({ x: point.x + (wander() - 0.5) * strokeWidth * 0.9, y: point.y + (wander() - 0.5) * strokeWidth * 0.9 }));
      const nudgedStart = `M ${nudged[0].x.toFixed(1)} ${nudged[0].y.toFixed(1)}`;
      // Each stretch between lifts, in both passes, with where it starts along the whole line.
      const runs = stretches(start, segments);
      const nudgedRuns = stretches(nudgedStart, capSegments(curve(nudged, lifted), floor + strokeWidth));
      const starts = runs.map((run) => lengthBefore(run.from));
      const drawnPaths = [pathsIn(first, runs.length), pathsIn(second, nudgedRuns.length)].map((paths, pass) => paths.map((element, index) => {
        element.setAttribute('class', pass ? 'scroll-thread__line scroll-thread__line--second' : 'scroll-thread__line');
        element.style.strokeWidth = String(pass ? strokeWidth * 0.55 : strokeWidth);
        element.setAttribute('d', (pass ? nudgedRuns : runs)[index].d);
        const length = element.getTotalLength();
        element.style.strokeDasharray = `${length} ${length}`;
        return { element, length, from: starts[index] ?? 0, span: (starts[index + 1] ?? total) - (starts[index] ?? 0) };
      }));
      // The length of the line up to each anchor, measured on the same curve.
      const lengthAt = pointOfAnchor.map((pointIndex) => lengthBefore(pointIndex));
      const containerTop = container.getBoundingClientRect().top + window.scrollY;
      const setDrawn = (drawn: number) => {
        // A stretch shows the part of the whole line's drawn length that falls inside it.
        for (const passPaths of drawnPaths) for (const run of passPaths) {
          const shown = run.span > 0 ? Math.min(1, Math.max(0, (drawn - run.from) / run.span)) : drawn >= run.from ? 1 : 0;
          run.element.style.strokeDashoffset = String(run.length * (1 - shown));
        }
        svg.dataset.threadDrawn = String(Math.round(drawn));
        svg.dataset.threadTotal = String(Math.round(total));
        anchors.forEach((anchor, index) => {
          anchor.element.dataset.threadReached = lengthAt[index] <= drawn + 1 ? 'true' : 'false';
        });
      };
      if (still.matches) {
        setDrawn(total);
        return;
      }
      // Scroll position -> drawn length: arrive early at each waiting anchor, hold, then move on.
      const viewport = window.innerHeight;
      const maxScroll = Math.max(1, document.documentElement.scrollHeight - viewport);
      const keys: { scroll: number; length: number }[] = [{ scroll: 0, length: 0 }];
      anchors.forEach((anchor, index) => {
        if (!anchor.wait && index !== anchors.length - 1) return;
        const y = containerTop + anchor.point.y;
        const arrive = Math.min(maxScroll, Math.max(0, y - viewport * arriveAt));
        const leave = Math.min(maxScroll, Math.max(arrive, y - viewport * leaveAt));
        keys.push({ scroll: arrive, length: lengthAt[index] }, { scroll: leave, length: lengthAt[index] });
      });
      keys.push({ scroll: maxScroll, length: total });
      keys.sort((a, b) => a.scroll - b.scroll || a.length - b.length);
      // What the line has reached with no scroll at all is where it starts: a tween at scroll 0 would never play.
      const startLength = Math.max(...keys.filter((key) => key.scroll <= 0).map((key) => key.length));
      const state = { drawn: startLength };
      const timeline = gsap.timeline({ paused: true, onUpdate: () => setDrawn(state.drawn) });
      let at = 0;
      let reached = startLength;
      for (const key of keys.filter((candidate) => candidate.scroll > 0)) {
        const length = Math.max(reached, key.length);
        timeline.to(state, { drawn: length, duration: Math.max(0.001, key.scroll - at), ease: 'none' }, at);
        at = Math.max(at, key.scroll);
        reached = length;
      }
      trigger = ScrollTrigger.create({ start: 0, end: maxScroll, scrub: 0.7, animation: timeline });
      timeline.progress(Math.min(1, window.scrollY / maxScroll));
      setDrawn(state.drawn);
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(build);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    container.querySelectorAll('img').forEach((image) => image.addEventListener('load', schedule));
    void document.fonts?.ready.then(schedule);
    still.addEventListener('change', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      still.removeEventListener('change', schedule);
      container.querySelectorAll('img').forEach((image) => image.removeEventListener('load', schedule));
      trigger?.kill();
    };
  }, [arriveAt, leaveAt, seed, narrowBelow, strokeWidth]);

  return (
    <svg ref={svgRef} className="scroll-thread" aria-hidden="true" focusable="false">
      <style>{STYLE}</style>
      <path ref={measureRef} className="scroll-thread__measure" />
      <path ref={pathRef} className="scroll-thread__measure" />
      <g ref={firstRef} />
      <g ref={secondRef} />
    </svg>
  );
}

const STYLE = `
  .scroll-thread { position: absolute; top: 0; left: 0; z-index: 0; overflow: visible; pointer-events: none; }
  .scroll-thread__line { fill: none; stroke: var(--thread-line); stroke-linecap: round; stroke-linejoin: round; }
  .scroll-thread__line--second { opacity: .85; }
  .scroll-thread__measure { fill: none; stroke: none; }
`;
