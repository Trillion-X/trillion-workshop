// parts/media-composition/show/components/EditTrackLanes.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The reference-locked multi-track clip timeline for the edit-timeline surface,
// modeled on the award-winning ElevenLabs / VEED / Descript editors (pulled via
// the Mobbin MCP). Renders the blind `MaterializedComposition` (the fold of the
// edit-decision stream) as:
//   • a fixed-width track GUTTER (per-lane mute icon + V1/A1 label + clip count)
//   • ONE flex content column holding a fine timecoded RULER, every clip lane,
//     and the PLAYHEAD (with a timecode badge) in one shared coordinate space
//   • VIDEO lanes rendered as thumbnail-filled FILMSTRIP clips; AUDIO/other
//     lanes as dense WAVEFORM clips — tone resolved in the fold, never here
//   • a ZOOM factor that scales the content column width inside an x-scroll wrap
//   • Loom-style draggable TrimHandles on the selected clip
//
// This is the DATA-driven surface: how generic the backend is (composeTimeline)
// has ZERO bearing on how rich this looks (L160). The primitive is powerful, so
// the surface is award-grade.
//
// NON-NEGOTIABLE INVARIANTS
//   1. NO RAW HTML / className in feature code — Container / Card / Text / Icon /
//      ClipBlock / Playhead / TimeRuler / TrimHandle only.
//   2. GEOMETRY FROM DATA — clip width/left are pure functions of laneStart/
//      laneEnd vs lane.duration. Trim px->seconds uses the measured lane width.
//   3. TRIM IS BLIND — the handle reports pixels; this file converts to a new
//      source in/out and calls `onTrim`. It never names an op.
//   4. LANE PRESENTATION IS DATA — a lane shows a filmstrip when a thumbnail is
//      supplied for its source, else a waveform. This file never branches on a
//      lane name; it reads the `thumbBySource` / `peaksBySource` maps.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { Magnet } from 'lucide-react';
import { Button } from '../../../ui/show/coss/ui/button';

import type {
  MaterializedClip,
  MaterializedComposition,
  MaterializedLane,
} from '../../read-data/compose-timeline';
import { Card } from '../../../ui/show/card';
import { ClipBlock, type ClipBlockTone } from '../../../ui/show/clip-block';
import { Container } from '../../../ui/show/container';
import { Playhead } from '../../../ui/show/playhead';
import { Text } from '../../../ui/show/text';
import { TimeRuler } from '../../../ui/show/time-ruler';
import { TrimHandle } from '../../../ui/show/trim-handle';
import { visibleTimelineLanes } from '../../../ui/show/selection/visible-timeline-lanes.mjs';

export type EditTrackLanesProps = {
  composition: MaterializedComposition;
  playheadPct: number;
  /** Timecode shown in the playhead badge (e.g. "0:13"). */
  playheadLabel?: string;
  selectedClipId: string | null;
  peaksBySource?: Record<string, number[]>;
  /** Real decoded peaks keyed by clipId (preferred over peaksBySource). Lets each
   *  clip show the true audio envelope of ITS own in/out, not a per-source guess. */
  peaksByClip?: Record<string, number[]>;
  /** sourceId -> thumbnail URL. A lane whose clips have thumbnails renders as a
   *  filmstrip (video); otherwise it renders a waveform (audio). */
  thumbBySource?: Record<string, string>;
  /** Horizontal zoom. 1 = fit; >1 widens the content column (x-scroll). */
  zoom?: number;
  onSeek: (laneTimeSeconds: number) => void;
  onSelectClip: (clipId: string) => void;
  /** Commit a trim: absolute new source in/out points (seconds). */
  onTrim: (clipId: string, inPoint: number, outPoint: number) => void;
  /** Pending source range when playback still represents the saved composition. */
  getTrimRange?: (clipId: string) => { inPoint: number; outPoint: number } | null;
  /** Commit a move: the clip's new lane-start time (seconds). Reorders by time.
   *  Optional — when absent, a body drag is a no-op (a plain select surface). */
  onMove?: (clipId: string, laneStartSeconds: number, destLaneRole?: string, destLaneId?: string, destClipId?: string) => void;
  dropType?: string;
  onMediaDrop?: (data: string, seconds: number) => void;
  mediaDropHandlers?: Record<string, unknown>;
};

const EPSILON = 0.001;
const KNOWN_TONES: readonly ClipBlockTone[] = ['source', 'audio', 'motion', 'analysis', 'identity', 'output'];

function laneTone(lane: MaterializedLane): ClipBlockTone {
  return (KNOWN_TONES as readonly string[]).includes(lane.tone) ? (lane.tone as ClipBlockTone) : 'source';
}

function clipWidthPct(clip: MaterializedClip, laneDuration: number): number {
  const denominator = Math.max(laneDuration, EPSILON);
  const span = Math.max(0, clip.laneEnd - clip.laneStart);
  return (span / denominator) * 100;
}

const tcLabel = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Fine, evenly spaced timecode ticks — denser as the timeline widens with zoom,
 *  so a zoomed-in editor reads frame-close like ElevenLabs/VEED. */
function buildTicks(durationSeconds: number, zoom: number, width: number): { label: string }[] {
  const dur = Math.max(EPSILON, durationSeconds);
  const count = Math.max(2, Math.min(Math.floor(width / 56), 16, Math.max(5, Math.round((dur / 2) * Math.min(zoom, 3)))));
  return Array.from({ length: count }, (_, i) => ({ label: tcLabel((dur / (count - 1)) * i) }));
}

// -- Live trim drag state — pixels while dragging, committed on release ---------
type TrimDrag = { clipId: string; edge: 'start' | 'end'; deltaPx: number };

/** New absolute source in/out for a clip given an edge drag of `deltaSeconds`
 *  timeline-seconds. Maps timeline delta -> source delta by the clip's own
 *  source-per-lane ratio, clamped so in < out and in >= 0. */
function trimmedInOut(clip: MaterializedClip, edge: 'start' | 'end', deltaSeconds: number): { inPoint: number; outPoint: number } {
  const laneSpan = Math.max(EPSILON, clip.laneEnd - clip.laneStart);
  const srcPerLane = (clip.outPoint - clip.inPoint) / laneSpan;
  if (edge === 'start') {
    const inPoint = Math.min(
      Math.max(0, clip.inPoint + deltaSeconds * srcPerLane),
      clip.outPoint - EPSILON,
    );
    return { inPoint, outPoint: clip.outPoint };
  }
  const outPoint = Math.max(clip.inPoint + EPSILON, clip.outPoint + deltaSeconds * srcPerLane);
  return { inPoint: clip.inPoint, outPoint };
}

// -- Track gutter row (V1/A1 style: mute icon + label + clip count) ------------
function LaneGutter({ lane, trackLabel }: { lane: MaterializedLane; trackLabel: string }) {
  return (
    <Card variant="nested" padding="xs" layout="row">
      <Container layout="horizontal" gap="xs" alignItems="center" width="full">
        <Container layout="vertical" gap="none" flex="1">
          <Text variant="body-xs" weight="semibold" truncate>{trackLabel}</Text>
        </Container>
      </Container>
    </Card>
  );
}

// Lane tones that carry visible FRAMES (rendered as a filmstrip when a thumbnail
// exists). Anything else (audio) renders as a waveform. This is a set over the
// already-closed ClipBlockTone union, not a new binary, so a `motion`/`analysis`/
// `identity` lane is handled correctly instead of being mislabeled "audio".
const VISUAL_TONES: ReadonlySet<ClipBlockTone> = new Set(['source', 'motion', 'analysis', 'identity', 'output']);

/** Track names are the lane's own label (DATA: "Video", "Captions", "Look 1"...).
 *  A lane without a label is numbered by what it carries, so a lane kind nobody
 *  anticipated still gets a readable name with no new code. */
function trackLabels(lanes: readonly MaterializedLane[]): string[] {
  let visual = lanes.filter(lane=>lane.role!=='audio'&&!lane.label?.trim()).length, audio = 0;
  return lanes.map((lane) => {
    const own = lane.label?.trim();
    if (own) return own;
    return lane.role==='audio'?`Audio ${++audio}`:`Video ${visual--}`;
  });
}

// -- One clip cell — grows trim handles when it is the selected clip -----------
// The clip BODY is draggable to reorder/reposition: a pointer drag beyond a small
// threshold moves the whole clip (reports the pixel delta on release, the parent
// authors a `move`), while a pointer press with NO movement is a select+seek click.
// Trim handles stopPropagation on pointerdown, so grabbing an edge trims, not moves.
function ClipCell({
  clip,
  tone,
  laneDuration,
  waveform,
  peaks,
  thumbSrc,
  selected,
  displayClip = clip,
  canTrim = true,
  onSelect,
  onSeek,
  onTrimDrag,
  onTrimEnd,
  onTrimCancel,
  onTrimNudge,
  onMoveEnd,
  onMoveNudge,
  resolveMove,
}: {
  clip: MaterializedClip;
  tone: ClipBlockTone;
  laneDuration: number;
  waveform: boolean;
  peaks?: number[];
  thumbSrc?: string;
  selected: boolean;
  displayClip?: MaterializedClip;
  canTrim?: boolean;
  onSelect: () => void;
  onSeek: () => void;
  onTrimDrag: (edge: 'start' | 'end', deltaPx: number) => void;
  onTrimEnd: () => void;
  onTrimCancel: () => void;
  onTrimNudge: (edge: 'start' | 'end', seconds: number) => void;
  onMoveEnd?: (deltaPx: number, deltaY: number) => void;
  onMoveNudge?: (seconds: number) => void;
  resolveMove?: (deltaPx:number)=>number;
}) {
  const move = React.useRef<{ startX: number; startY: number; dx: number; dy: number; moved: boolean } | null>(null);
  const [dragDx, setDragDx] = React.useState(0);
  const [dragDy, setDragDy] = React.useState(0);
  const onPointerDown = (e: React.PointerEvent) => {
    onSelect();
    move.current = { startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, moved: false };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const m = move.current;
    if (!m) return;
    if (!onMoveEnd) return;
    m.dx = e.clientX - m.startX;
    m.dy = e.clientY - m.startY;
    if (Math.abs(m.dx) > 4 || Math.abs(m.dy) > 4) m.moved = true;
    setDragDx(m.moved ? resolveMove?.(m.dx)??m.dx : 0);
    setDragDy(m.moved ? m.dy : 0);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const m = move.current;
    move.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* released */ }
    setDragDx(0);
    setDragDy(0);
    // Report relative movement so focus-induced scrolling cannot turn a horizontal
    // drag into a different track. The lane resolves its current center on release.
    if (e.type === 'pointercancel' || !m) return;
    if (m.moved) onMoveEnd?.(m.dx, m.dy);
    else { onSeek(); }
  };
  return (
    <Container
      layout="horizontal"
      position="absolute"
      top="0"
      left={`${laneDuration > 0 ? displayClip.laneStart / laneDuration * 100 : 0}%`}
      heightPx="100%"
      width={`${clipWidthPct(displayClip, laneDuration)}%`}
      minWidth="0"
      cursor={onMoveEnd ? 'grab' : 'pointer'}
      touchAction="none"
      transform={dragDx || dragDy ? `translate(${dragDx}px, ${dragDy}px)` : undefined}
      zIndex={dragDx || dragDy ? '30' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      tabIndex={0}
      role="button"
      aria-label={clip.label}
      aria-pressed={selected}
      onKeyDown={(event: React.KeyboardEvent) => {
        if (event.target !== event.currentTarget) return;
        const direction: Record<string, number> = {ArrowLeft:-1,ArrowRight:1};
        if (direction[event.key] && onMoveNudge) {
          event.preventDefault();onSelect();onMoveNudge(direction[event.key] * (event.shiftKey ? 1 : .1));return;
        }
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();onSelect();onSeek();
      }}
    >
      <ClipBlock
        label={clip.label}
        minWidth="0"
        detail={tcLabel(clip.laneStart)}
        tone={tone}
        active={selected}
        showWaveform={waveform}
        seed={clip.clipId}
        peaks={peaks}
        thumbSrc={thumbSrc}
      />
      {selected && canTrim && (
        <>
          <TrimHandle edge="start" ariaLabel="Trim start"
            onNudge={seconds => onTrimNudge('start', seconds)}
            onDrag={(dx) => onTrimDrag('start', dx)} onDragEnd={onTrimEnd} onDragCancel={onTrimCancel} />
          <TrimHandle edge="end" ariaLabel="Trim end"
            onNudge={seconds => onTrimNudge('end', seconds)}
            onDrag={(dx) => onTrimDrag('end', dx)} onDragEnd={onTrimEnd} onDragCancel={onTrimCancel} />
        </>
      )}
    </Container>
  );
}

// -- Component ------------------------------------------------------------------
export function EditTrackLanes({
  composition: inputComposition,
  playheadPct,
  playheadLabel,
  selectedClipId,
  peaksBySource,
  peaksByClip,
  thumbBySource,
  zoom = 1,
  onSeek,
  onSelectClip,
  onTrim,
  getTrimRange,
  onMove,
  dropType,
  onMediaDrop,
  mediaDropHandlers,
}: EditTrackLanesProps) {
  const composition = React.useMemo(() => {const lanes=visibleTimelineLanes(inputComposition.lanes);return {...inputComposition,lanes:[...lanes.filter(lane=>lane.role!=='audio').reverse(),...lanes.filter(lane=>lane.role==='audio')]};}, [inputComposition]);
  const [snapping,setSnapping]=React.useState(true);
  const bypassSnap=React.useRef(false);
  React.useEffect(()=>{const down=(event:KeyboardEvent)=>{bypassSnap.current=event.altKey;},up=()=>{bypassSnap.current=false;};window.addEventListener('keydown',down);window.addEventListener('keyup',down);window.addEventListener('blur',up);return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',down);window.removeEventListener('blur',up);};},[]);
  const [rulerWidth, setRulerWidth] = React.useState(280);
  const ticks = buildTicks(composition.durationSeconds, zoom, rulerWidth);
  const laneLabels = trackLabels(composition.lanes);
  const [drag, setDrag] = React.useState<TrimDrag | null>(null);
  const laneRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());

  // Ruler scrub: click or drag anywhere on the ruler strip to move the playhead.
  // The content column is one coordinate space (ruler + clips + playhead share
  // it, scaled together by zoom), so pointer-x measured against the content
  // column width maps straight to seconds regardless of zoom.
  const contentRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setRulerWidth(node.getBoundingClientRect().width));
    observer.observe(node);
    return () => observer.disconnect();
  }, [composition.lanes.length]);
  const [scrubbing, setScrubbing] = React.useState(false);
  const seekFromClientX = React.useCallback((clientX: number) => {
    const el = contentRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(frac * Math.max(EPSILON, composition.durationSeconds));
  }, [onSeek, composition.durationSeconds]);
  const onScrubDown = React.useCallback((e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setScrubbing(true);
    seekFromClientX(e.clientX);
  }, [seekFromClientX]);
  const onScrubMove = React.useCallback((e: React.PointerEvent) => {
    if (scrubbing) seekFromClientX(e.clientX);
  }, [scrubbing, seekFromClientX]);
  const onScrubUp = React.useCallback((e: React.PointerEvent) => {
    setScrubbing(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* released already */ }
  }, []);

  const setLaneRef = React.useCallback((laneId: string) => (el: HTMLDivElement | null) => {
    if (el) laneRefs.current.set(laneId, el);
    else laneRefs.current.delete(laneId);
  }, []);

  /** timeline-seconds for a pixel delta, using the shared ruler's duration and measured width. */
  const deltaSeconds = React.useCallback((laneId: string, deltaPx: number): number => {
    const width = laneRefs.current.get(laneId)?.offsetWidth ?? 0;
    if (width <= 0) return 0;
    return (deltaPx / width) * Math.max(composition.durationSeconds, EPSILON);
  }, [composition.durationSeconds]);

  const clipById = React.useCallback((clipId: string): { clip: MaterializedClip; lane: MaterializedLane } | null => {
    for (const lane of composition.lanes) {
      const clip = lane.clips.find((c) => c.clipId === clipId);
      if (clip) return { clip, lane };
    }
    return null;
  }, [composition.lanes]);

  const commitTrim = React.useCallback(() => {
    setDrag((current) => {
      if (!current) return null;
      const found = clipById(current.clipId);
      if (found) {
        const dt = deltaSeconds(found.lane.laneId, current.deltaPx);
        const pending = getTrimRange?.(current.clipId);
        if (getTrimRange && !pending) return null;
        const base = pending ? { ...found.clip, ...pending } : found.clip;
        const { inPoint, outPoint } = trimmedInOut(base, current.edge, dt);
        if (Math.abs(outPoint - base.outPoint) > EPSILON || Math.abs(inPoint - base.inPoint) > EPSILON) {
          onTrim(current.clipId, inPoint, outPoint);
        }
      }
      return null;
    });
  }, [clipById, deltaSeconds, onTrim, getTrimRange]);

  // Commit a body-drag as a MOVE: convert the pixel delta to lane-seconds via the
  // clip's own lane width, add to its current laneStart (clamped >= 0), author the
  // move. Reorder emerges from the new laneStart sort — no special reorder op.
  // Which lane ROW the release Y sits over (pure geometry from each lane row's
  // measured rect). Returns the lane so the parent can move a clip ACROSS tracks;
  // the parent owns the policy of which lanes are valid drop targets (L098).
  const laneAtClientY = React.useCallback((clientY: number): MaterializedLane | null => {
    for (const lane of composition.lanes) {
      const el = laneRefs.current.get(lane.laneId);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return lane;
    }
    return null;
  }, [composition.lanes]);

  // Magnetic snap targets: timeline start (0), the playhead, and every OTHER clip's
  // start/end across all lanes. A dragged clip snaps when either its start OR its end
  // lands within the snap window of a target (award-grade magnetic timeline).
  const snapStart = React.useCallback((rawStart: number, clipId: string, laneId: string, clipDuration: number): number => {
    const maxStart = Math.max(0, composition.durationSeconds - clipDuration);
    const boundedStart = Math.max(0, Math.min(maxStart, rawStart));
    if(!snapping||bypassSnap.current)return boundedStart;
    const window = deltaSeconds(laneId, 8); // ~8px in seconds, zoom-aware
    if (window <= 0) return boundedStart;
    const targets: number[] = [0, (playheadPct / 100) * Math.max(EPSILON, composition.durationSeconds)];
    for (const lane of composition.lanes) {
      for (const c of lane.clips) {
        if (c.clipId === clipId) continue;
        targets.push(c.laneStart, c.laneEnd);
      }
    }
    let snapped = boundedStart;
    let best = window;
    for (const t of targets) {
      const dStart = Math.abs(t - boundedStart);
      if (dStart <= best) { best = dStart; snapped = t; }
      const dEnd = Math.abs(t - (boundedStart + clipDuration));
      if (dEnd <= best) { best = dEnd; snapped = t - clipDuration; }
    }
    return Math.max(0, Math.min(maxStart, snapped));
  }, [snapping,deltaSeconds, playheadPct, composition.durationSeconds, composition.lanes]);

  const commitMove = React.useCallback((clipId: string, deltaPx: number, deltaY: number) => {
    const found = clipById(clipId);
    if (!found) return;
    const dt = deltaSeconds(found.lane.laneId, deltaPx);
    const rawStart = Math.max(0, Math.min(composition.durationSeconds - (found.clip.laneEnd - found.clip.laneStart), found.clip.laneStart + dt));
    const clipDuration = found.clip.laneEnd - found.clip.laneStart;
    const newStart = snapStart(rawStart, clipId, found.lane.laneId, clipDuration);
    const sourceRect = laneRefs.current.get(found.lane.laneId)?.getBoundingClientRect();
    const destLane = sourceRect ? laneAtClientY(sourceRect.top + sourceRect.height / 2 + deltaY) : null;
    const destRole = destLane && destLane.role !== found.lane.role ? destLane.role : undefined;
    const repositioned = Math.abs(newStart - found.clip.laneStart) > EPSILON;
    const changedLane = destLane && destLane.laneId !== found.lane.laneId;
    const dropTime = newStart + clipDuration / 2;
    const destinationClip = destLane?.clips.filter(clip => clip.clipId !== clipId).sort((a, b) => {
      const distance = (clip: typeof a) => Math.max(clip.laneStart - dropTime, dropTime - clip.laneEnd, 0);
      return distance(a) - distance(b);
    })[0];
    if (onMove && (repositioned || changedLane)) {
      const savedLaneId = (destLane as (MaterializedLane & { savedLaneId?: string }) | null)?.savedLaneId;
      onMove(clipId, newStart, destRole, savedLaneId ?? destLane?.laneId, destinationClip?.clipId);
    }
  }, [clipById, deltaSeconds, onMove, laneAtClientY, snapStart, composition.durationSeconds]);

  // Single-coordinate-space layout (ElevenLabs/VEED anatomy): a fixed-width track
  // GUTTER on the left, and ONE content column on the right (scaled to `zoom`
  // inside an x-scroll wrapper) that holds the ruler, every clip lane, AND the
  // playhead. Because ruler, clips, and playhead share that one scaled column,
  // the ruler tick at 0:00 sits exactly over each lane clip start and the
  // playhead `left:%` measures against the same width at any zoom. Matched
  // `minHeight` rows keep the gutter labels aligned with their lanes.
  const GUTTER = '132px';
  const RULER_ROW = '24px';
  const LANE_ROW = '54px';
  const contentWidth = `${Math.max(100, Math.round(zoom * 100))}%`;

  if (composition.lanes.length === 0) {
    return (
      <Container layout="vertical" gap="sm" alignItems="center" padding="lg">
        <Text variant="heading">Add media to build a timeline.</Text>
        <Text variant="body" color="faint">Add media or run analysis, then the tracks appear here.</Text>
      </Container>
    );
  }

  return (
    <Container layout="vertical" gap="sm">
      <Container layout="horizontal" gap="sm" alignItems="start">
        {/* Left gutter: ruler spacer + one track chip per lane */}
        <Container layout="vertical" gap="xs" width={GUTTER}>
          <Container layout="vertical" justifyContent="center" minHeight={RULER_ROW}>
            <Button size="icon-sm" variant="ghost" aria-label="Snap to clips" aria-pressed={snapping} title="Snap to clips · hold Option to bypass" onClick={()=>setSnapping(value=>!value)}><Magnet size={14}/></Button>
          </Container>
          {composition.lanes.map((lane, i) => (
            <Container key={lane.laneId} layout="vertical" justifyContent="center" minHeight={LANE_ROW} heightPx={LANE_ROW}>
              <LaneGutter lane={lane} trackLabel={laneLabels[i]} />
            </Container>
          ))}
        </Container>

        {/* x-scroll wrapper so zoom can push the content column past 100% */}
        <Container flex="1" overflow="x-auto" minWidth="0">
          {/* Content column: ruler + lanes + playhead in ONE scaled coordinate space */}
          <Container ref={contentRef} data-media-drop-target={onMediaDrop ? '' : undefined} layout="vertical" gap="xs" position="relative" width={contentWidth} minWidth="100%" onDragOver={event=>{if(dropType&&onMediaDrop&&event.dataTransfer.types.includes(dropType)){event.preventDefault();event.dataTransfer.dropEffect='copy';}}} onDrop={event=>{if(!dropType||!onMediaDrop||!event.dataTransfer.types.includes(dropType))return;event.preventDefault();event.stopPropagation();const rect=event.currentTarget.getBoundingClientRect();if(rect.width>0)onMediaDrop(event.dataTransfer.getData(dropType),Math.max(0,Math.min(composition.durationSeconds,(event.clientX-rect.left)/rect.width*composition.durationSeconds)));}} {...mediaDropHandlers}>
            <Container
              layout="horizontal"
              width="full"
              alignItems="center"
              minHeight={RULER_ROW}
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onPointerUp={onScrubUp}
              cursor="ew-resize"
              touchAction="none"
            >
              <TimeRuler ticks={ticks} />
            </Container>
            {composition.lanes.map((lane) => {
              const tone = laneTone(lane);
              const visual = VISUAL_TONES.has(tone);
              return (
                <Container key={lane.laneId} ref={setLaneRef(lane.laneId)} layout="horizontal" gap="none" width="full" position="relative" alignItems="stretch" minHeight={LANE_ROW} heightPx={LANE_ROW}>
                  {lane.clips.length === 0 ? (
                    <Card variant="ghost" padding="xs" layout="row">
                      <Text variant="caption" color="faint">Empty track</Text>
                    </Card>
                  ) : (
                    lane.clips.map((clip) => {
                      let displayClip=clip;
                      if(drag?.clipId===clip.clipId){const range=getTrimRange?.(clip.clipId),base=range?{...clip,...range}:clip,trim=trimmedInOut(base,drag.edge,deltaSeconds(lane.laneId,drag.deltaPx)),ratio=(clip.laneEnd-clip.laneStart)/(base.outPoint-base.inPoint);displayClip={...clip,laneStart:clip.laneStart+(trim.inPoint-base.inPoint)*ratio,laneEnd:clip.laneEnd+(trim.outPoint-base.outPoint)*ratio};}
                      // A clip shows a FILMSTRIP when its lane carries frames AND a
                      // thumbnail exists for its source; otherwise a WAVEFORM. Pure
                      // DATA (tone + thumbnail presence), no lane-name branch.
                      const thumbSrc = visual ? thumbBySource?.[clip.sourceId] : undefined;
                      return (
                        <ClipCell
                          key={clip.clipId}
                          clip={clip}
                          displayClip={displayClip}
                          tone={tone}
                          laneDuration={composition.durationSeconds}
                          waveform={!thumbSrc && Boolean((peaksByClip?.[clip.clipId] ?? peaksBySource?.[clip.sourceId])?.length)}
                          peaks={peaksByClip?.[clip.clipId] ?? peaksBySource?.[clip.sourceId]}
                          thumbSrc={thumbSrc}
                          selected={clip.clipId === selectedClipId}
                          canTrim={!getTrimRange || getTrimRange(clip.clipId)!==null}
                          onSelect={() => onSelectClip(clip.clipId)}
                          onSeek={() => onSeek(clip.laneStart)}
                          onTrimDrag={(edge, deltaPx) => setDrag({ clipId: clip.clipId, edge, deltaPx })}
                          onTrimEnd={commitTrim}
                          onTrimCancel={() => setDrag(null)}
                          onTrimNudge={(edge, seconds) => { const pending = getTrimRange?.(clip.clipId); if (getTrimRange && !pending) return; const base = pending ? { ...clip, ...pending } : clip; const range = trimmedInOut(base, edge, seconds * (clip.laneEnd - clip.laneStart) / (base.outPoint - base.inPoint)); onTrim(clip.clipId, range.inPoint, range.outPoint); }}
                          onMoveEnd={onMove ? (deltaPx, deltaY) => commitMove(clip.clipId, deltaPx, deltaY) : undefined}
                          onMoveNudge={onMove ? seconds => {const clipDuration=clip.laneEnd-clip.laneStart,newStart=snapStart(clip.laneStart+seconds,clip.clipId,lane.laneId,clipDuration);if(Math.abs(newStart-clip.laneStart)>EPSILON)onMove(clip.clipId,newStart);} : undefined}
                          resolveMove={deltaPx=>{const width=laneRefs.current.get(lane.laneId)?.offsetWidth||0;if(!width)return deltaPx;const start=snapStart(clip.laneStart+deltaSeconds(lane.laneId,deltaPx),clip.clipId,lane.laneId,clip.laneEnd-clip.laneStart);return (start-clip.laneStart)/composition.durationSeconds*width;}}
                        />
                      );
                    })
                  )}
                </Container>
              );
            })}

            <Playhead positionPct={playheadPct} label={playheadLabel} />
          </Container>
        </Container>
      </Container>

      {drag && (
        <Text variant="caption" color="faint">Trimming, release to apply.</Text>
      )}
    </Container>
  );
}
