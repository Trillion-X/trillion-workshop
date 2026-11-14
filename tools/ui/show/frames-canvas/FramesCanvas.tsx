// parts/ui/show/frames-canvas/FramesCanvas.tsx
//
// NO PRIOR: searched parts/ui/show and parts/group/show for a pan-and-zoom canvas that lays pictures side by side
// (found the board's GroupBoardPanel, which owns its own items and records, CanvasSurface, the dotted surface, and
// camera-frame.ts, the board's camera math, both reused here), the 21st.dev MCP ("infinite canvas pan zoom frames":
// image fields and drifting grids, no frames) and Mobbin: Klaviyo's form editor (9c5057e4, Desktop and Mobile frames
// named above them on one canvas, a zoom dock) and MagicPath (af20dfa5, screens side by side on a dotted canvas, the
// zoom percent at the bottom), whose anatomy this follows. Nothing laid fixed-size frames out with a pick in frame
// pixels.
//
// PURPOSE
//   An infinite canvas of frames laid side by side, the way Figma and paper.design show one screen at several sizes:
//   each frame is a picture of a page (or words saying it is being drawn) with its name above it; drag the empty
//   canvas or scroll to move around, pinch or Ctrl/Cmd-scroll to zoom around the pointer, and the dock zooms or shows
//   every frame again. Choosing a point on a frame reports it in that frame's own pixels (`onPick`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Domain-blind: a frame is an id, a name, a size, an optional picture and words for its state; what a pick means
//      is the caller's.
//   2. Until the person moves or zooms the canvas themselves, every frame stays in view as the canvas changes size.
//   3. A pick is in the frame's own pixel space (0..width, 0..height), whatever the zoom.
//   4. Other people's and AIs' cursors are drawn where they point (`peers`, canvas coordinates), and where this person
//      points is reported through `onPointer` (canvas coordinates, null when they leave).
//   5. The camera math is the board's (group/show/camera-frame.ts); this file never repeats it.
//   6. A frame may hold live content (`content`) instead of a picture: the thing itself, drawn by the caller (a tour's
//      steps as their real cards). Such frames sit in rows the canvas chooses for the space it has (one column in a
//      narrow pane, several side by side in a wide one), each as tall as what it holds, and every one stays in view
//      until the person moves or zooms. A press inside live content is the caller's (`onPick` is for pictures).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Button } from '../button';
import { CanvasSurface } from '../canvas-surface';
import { NamedIcon } from '../icon/NamedIcon';
import { Text } from '../text';
import { frameCamera, zoomAroundCenter, zoomAroundPoint, type Camera } from '../../../group/show/camera-frame';
import '../../../screen-look/show/frames-canvas.css';

export type CanvasFrame = { id: string; label: string; width: number; height: number; image?: string; state?: string; content?: React.ReactNode; selected?: boolean };
export type FramesCanvasPeer = { id: string; name: string; color: string; cursor?: { x: number; y: number }; doing?: string };
type Placed = CanvasFrame & { x: number; y: number };

const MIN_ZOOM = 0.05;

/** How many columns frames of live content sit in: the count that shows them all at the largest zoom in a stage of this
 *  size, read with each frame's own height as its expected height. */
export function columnsFor(frames: readonly { width: number; height: number }[], stage: { w: number; h: number }, gap: number, padding = 56): number {
  if (!frames.length || !stage.w || !stage.h) return 1;
  const width = Math.max(...frames.map(frame => frame.width));
  const height = Math.max(...frames.map(frame => frame.height));
  let best = { columns: 1, zoom: 0 };
  for (let columns = 1; columns <= frames.length; columns += 1) {
    const rows = Math.ceil(frames.length / columns);
    const w = columns * width + (columns - 1) * gap;
    const h = rows * height + (rows - 1) * gap;
    const zoom = Math.min((stage.w - padding * 2) / w, (stage.h - padding * 2) / h);
    if (zoom > best.zoom + 1e-6) best = { columns, zoom };
  }
  return best.columns;
}
const MAX_ZOOM = 4;
const SURFACE_TILE = { image: 'radial-gradient(color-mix(in srgb, var(--text-muted) 28%, transparent) 1px, transparent 1px)', size: 20 };

export function FramesCanvas({ frames, onPick, peers = [], onPointer, label = 'Screens', gap = 80 }: {
  frames: CanvasFrame[];
  /** Space between frames, in frame pixels. */
  gap?: number;
  onPick?: (frameId: string, point: { x: number; y: number }) => void;
  peers?: FramesCanvasPeer[];
  onPointer?: (point: { x: number; y: number } | null) => void;
  label?: string;
}) {
  const stage = React.useRef<HTMLDivElement>(null);
  const [camera, setCamera] = React.useState<Camera>({ panX: 0, panY: 0, zoom: 0.25 });
  const moved = React.useRef(false);
  const drag = React.useRef<{ x: number; y: number; camera: Camera } | null>(null);
  const live = frames.some(frame => frame.content !== undefined);
  const flow = React.useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = React.useState({ w: 0, h: 0 });
  const [flowSize, setFlowSize] = React.useState({ w: 0, h: 0 });
  const columns = live ? columnsFor(frames, stageSize, gap) : 0;
  const placed = React.useMemo(() => {
    let x = 0;
    return frames.map(frame => { const at: Placed = { ...frame, x, y: 0 }; x += frame.width + gap; return at; });
  }, [frames, gap]);
  const viewport = () => ({ w: stage.current?.clientWidth ?? 0, h: stage.current?.clientHeight ?? 0 });
  const showAll = React.useCallback(() => {
    moved.current = false;
    const view = viewport();
    if (!view.w || !view.h) return;
    // The padding leaves room above the frames for their names, which keep one size on screen at any zoom. Live frames
    // are fitted by the size their rows take as drawn.
    const boxes = live
      ? (flowSize.w && flowSize.h ? [{ x: 0, y: 0, w: flowSize.w, h: flowSize.h }] : [])
      : placed.map(frame => ({ x: frame.x, y: frame.y, w: frame.width, h: frame.height }));
    const fitted = frameCamera(boxes, view, { padding: live ? 24 : 56, minZoom: MIN_ZOOM, maxZoom: 1 });
    if (fitted) setCamera(fitted);
  }, [placed, live, flowSize]);
  React.useEffect(() => {
    const element = flow.current;
    if (!element) return;
    const measured = new ResizeObserver(() => setFlowSize({ w: element.offsetWidth, h: element.offsetHeight }));
    measured.observe(element);
    return () => measured.disconnect();
  }, [live]);
  React.useLayoutEffect(() => { if (!moved.current) showAll(); }, [showAll]);
  React.useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const resized = new ResizeObserver(() => { setStageSize({ w: element.clientWidth, h: element.clientHeight }); if (!moved.current) showAll(); });
    resized.observe(element);
    // Scroll moves the canvas; Ctrl/Cmd-scroll and pinch (which browsers send as Ctrl-scroll) zoom around the pointer.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      moved.current = true;
      const box = element.getBoundingClientRect();
      setCamera(current => event.ctrlKey || event.metaKey
        ? zoomAroundPoint(current, { x: event.clientX - box.left, y: event.clientY - box.top }, current.zoom * Math.exp(-event.deltaY / 300), MIN_ZOOM, MAX_ZOOM)
        : { ...current, panX: current.panX - event.deltaX, panY: current.panY - event.deltaY });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { resized.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [showAll]);
  const toCanvas = (event: { clientX: number; clientY: number }) => {
    const box = stage.current!.getBoundingClientRect();
    return { x: (event.clientX - box.left - camera.panX) / camera.zoom, y: (event.clientY - box.top - camera.panY) / camera.zoom };
  };
  const pick = (frame: Placed, event: React.MouseEvent) => {
    const at = toCanvas(event);
    const point = { x: Math.floor(at.x - frame.x), y: Math.floor(at.y - frame.y) };
    if (point.x >= 0 && point.y >= 0 && point.x < frame.width && point.y < frame.height) onPick?.(frame.id, point);
  };
  const zoomBy = (factor: number) => { moved.current = true; setCamera(current => zoomAroundCenter(current, viewport(), current.zoom * factor, MIN_ZOOM, MAX_ZOOM)); };

  return <div className="frames-canvas" role="region" aria-label={label}>
    <div
      ref={stage}
      className="frames-canvas__stage"
      onPointerDown={event => { if (event.target === event.currentTarget) { drag.current = { x: event.clientX, y: event.clientY, camera }; event.currentTarget.setPointerCapture(event.pointerId); } }}
      onPointerMove={event => {
        onPointer?.(toCanvas(event));
        const from = drag.current;
        if (!from) return;
        moved.current = true;
        setCamera({ ...from.camera, panX: from.camera.panX + event.clientX - from.x, panY: from.camera.panY + event.clientY - from.y });
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerLeave={() => onPointer?.(null)}
    >
      <CanvasSurface panX={camera.panX} panY={camera.panY} zoom={camera.zoom} tile={SURFACE_TILE} />
      <div className="frames-canvas__world" style={{ transform: `translate(${camera.panX}px, ${camera.panY}px) scale(${camera.zoom})` }}>
        {live ? <div ref={flow} className="frames-canvas__flow" style={{ gridTemplateColumns: `repeat(${columns}, max-content)`, gap }}>
          {frames.map(frame => <div key={frame.id} className="frames-canvas__item" data-frame={frame.id} data-selected={frame.selected ? '' : undefined} style={{ width: frame.width }}>
            <div className="frames-canvas__item-label" style={{ fontSize: 13 / camera.zoom }}>{frame.label}</div>
            {frame.content}
          </div>)}
        </div> : null}
        {live ? null : placed.map(frame => <React.Fragment key={frame.id}>
          <div className="frames-canvas__label" style={{ left: frame.x, top: frame.y, width: frame.width, fontSize: 13 / camera.zoom, paddingBottom: 6 / camera.zoom }}>{frame.label}</div>
          <div className="frames-canvas__frame" data-frame={frame.id} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }} onClick={event => pick(frame, event)}>
            {frame.image ? <img src={frame.image} alt={frame.label} draggable={false} /> : <Text variant="caption" className="frames-canvas__state" style={{ fontSize: 14 / camera.zoom }}>{frame.state ?? ''}</Text>}
          </div>
        </React.Fragment>)}
        {peers.filter(peer => peer.cursor).map(peer => <div key={peer.id} className="frames-canvas__peer" style={{ left: peer.cursor!.x, top: peer.cursor!.y, color: peer.color, transform: `scale(${1 / camera.zoom})` }}>
          <NamedIcon name="MousePointer2" size="sm" />
          <span className="frames-canvas__peer-name" style={{ background: peer.color }}>{peer.doing ? `${peer.name} · ${peer.doing}` : peer.name}</span>
        </div>)}
      </div>
      <div className="frames-canvas__dock">
        <Button size="xs" variant="ghost" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}><NamedIcon name="Minus" size="sm" /></Button>
        <Button size="xs" variant="ghost" aria-label="Show every size" onClick={() => showAll()}>{Math.round(camera.zoom * 100)}%</Button>
        <Button size="xs" variant="ghost" aria-label="Zoom in" onClick={() => zoomBy(1.25)}><NamedIcon name="Plus" size="sm" /></Button>
      </div>
    </div>
  </div>;
}
