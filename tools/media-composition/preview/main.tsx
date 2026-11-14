// Preview entry for the media-composition visual editor, styled after Palmier Pro.
//
// ARCHITECTURE: this surface does NOT reimplement editing logic. Editor state is an
// append-only EDIT-DECISION STREAM; the timeline is the fold of that stream through
// the REAL pure package primitive `composeTimeline`. Every control AUTHORS a decision
// record the primitive folds (split/delete/trim/remove-span/add-source/set-transform).
// The Inspector's Volume/Fade/Speed author a single `set-transform` decision whose
// per-clip properties video-compose honors on render. Only render (ffmpeg) is
// server-side (/api/render); the primitive stays client-side and pure.
//
// LOOK: Palmier Pro anatomy, composed from packages/ui only (L065, zero raw HTML):
// top bar, left library, centered stage + transport, right Inspector (Levels/Playback),
// bottom timeline + toolbar.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Undo2, Redo2, MousePointer2, Scissors, Type, Trash2, ZoomIn, Clapperboard, SlidersHorizontal } from 'lucide-react';
import './compiled.css';
import './base.css';
import { EditTrackLanes } from '../show/components/EditTrackLanes';
import { composeTimeline } from '../read-data/compose-timeline';
import type {
  MediaCompositionEditDecision,
  MediaWorkspaceView,
} from '../read-data/read-media-workspace';
import { Container } from '../../ui/show/container';
import { Card } from '../../ui/show/card';
import { Text } from '../../ui/show/text';
import { Input } from '../../ui/show/input';
import { Button } from '../../ui/show/button';
import { Badge } from '../../ui/show/badge';
import { Icon } from '../../ui/show/icon';
import { MediaFrame } from '../../ui/show/media-frame';
import { RangeInput } from '../../ui/show/range-input';
// The editor look is a screen-look THEME (DATA), never hardcoded colors. We read the
// DreamCut theme record from screen-look's own package DATA and apply it through the
// SAME resolver the live shell uses, so the whole ui (glass, accent, buttons) adopts
// Meng To's palette from tokens — change the theme row, the editor re-skins.
import { resolveScreenLookPalette } from '../../screen-look/read-data/resolve-screen-look-palette.js';
import screenLookData from '../../screen-look/things-to-store-and-run.json';

type LibraryClip = { id: string; label: string; dur: number; thumb: string };
// Caption position is the NORMALIZED {x,y} primitive (0..1), never a corner enum.
// x: 0 left / 0.5 center / 1 right; y: 0 top / 0.5 middle / 1 bottom.
type Caption = { text: string; x?: number; y?: number; size?: number; color?: string };
type Transition = { renderer?: string; type?: string; duration?: number };
type Transform = { speed?: number; volume?: number; fadeIn?: number; fadeOut?: number; caption?: Caption; transition?: Transition };

// add-source authors a REAL lane by DATA: `lane_role`/`lane_label` decide which
// track the clip lands on. The fold (`foldAddSource`) CREATES a new lane when the
// role is new and appends when it exists — so "add to this track" and "add as a
// new track" are the SAME primitive with different lane_role, zero surface branch.
function addSource(id: string, inP: number, outP: number, createdAt: string, laneRole = 'video-1', laneLabel = 'Video', laneTone = 'source', sourceLabel = id): MediaCompositionEditDecision {
  return {
    action: 'add-source', label: sourceLabel,
    source_ref: { source_id: id }, span: { start: inP, end: outP },
    // lane_tone is DATA: it tells the fold which visual tone this lane paints (source =
    // filmstrip). Declaring it keeps EVERY video-N lane consistent instead of each role
    // name falling to a hash-random palette slot (video-1 vs video-2 mismatch).
    parameters: { lane_role: laneRole, lane_label: laneLabel, lane_tone: laneTone }, created_at: createdAt,
  };
}

// The A1 audio track is a PURE PROJECTION of the real video clips' own audio — NOT
// a duplicated decision (the old `toAudioLane` faked multi-track by injecting mirror
// decisions, an L134 shim). Here we derive it from the already-materialized clips of
// every video lane, so it is honestly "these clips' audio". Selecting an A1 clip
// selects its PARENT video clip, so the Volume/Fade inspector actually controls that
// track's audio — the track is functional, not decorative. Render is unaffected
// (segmentsOf reads video lanes only). `audio:<clipId>` prefix maps back to the parent.
const AUDIO_CLIP_PREFIX = 'audio:';
function withDerivedAudioLanes(comp: ReturnType<typeof composeTimeline>): ReturnType<typeof composeTimeline> {
  const videoLanes = comp.lanes.filter((l) => l.role !== 'audio' && l.clips.length > 0);
  if (videoLanes.length === 0) return comp;
  // One combined A1 lane derived from the first video lane's clips (the primary
  // track). Extra video tracks keep their embedded audio; A1 mirrors the primary.
  const primary = videoLanes[0];
  const audioLane = {
    laneId: 'derived-audio-1',
    role: 'audio',
    label: 'Audio',
    tone: 'audio',
    duration: primary.duration,
    clips: primary.clips.map((c) => ({ ...c, clipId: `${AUDIO_CLIP_PREFIX}${c.clipId}` })),
  };
  return { ...comp, lanes: [...comp.lanes, audioLane] };
}

const QUICK = [
  'Make it punchier: tighten every clip to its best 2 seconds.',
  'Reverse the current clip order.',
  'Add one unused source clip in the middle.',
];
const SPEEDS = [0.5, 1, 1.5, 2];
// Aspect ratios are DATA: each row is a label + the render dimensions it drives
// (encode.width/height in the EDL) AND the canvas frame shape. Matches DreamCut's
// top-bar aspect segmented control (16:9 4:3 1:1 3:4 9:16). Adding a ratio = one row.
const ASPECTS: { id: string; w: number; h: number }[] = [
  { id: '9:16', w: 1080, h: 1920 },
  { id: '16:9', w: 1920, h: 1080 },
  { id: '1:1', w: 1080, h: 1080 },
  { id: '4:3', w: 1440, h: 1080 },
  { id: '3:4', w: 1080, h: 1440 },
];
// Canvas preview frame dimensions for a given aspect: the long side is fixed, the
// short side scales, so a vertical reel is tall and a landscape reel is wide.
const FRAME_LONG = 460;
function frameSize(a: { w: number; h: number }): { w: number; h: number } {
  return {
    w: a.w >= a.h ? FRAME_LONG : Math.round((FRAME_LONG * a.w) / a.h),
    h: a.h >= a.w ? FRAME_LONG : Math.round((FRAME_LONG * a.h) / a.w),
  };
}
// The 9 alignment ANCHORS are pure DATA presets over the {x,y} position primitive:
// left/center/right × top/middle/bottom. They are NOT a closed set — freeform drag
// of the caption on the preview writes ANY x,y, so these are just convenient jumps.
// A 3×3 grid renders them; the id is only a React key, never a rendered corner enum.
const ALIGN_ANCHORS: { id: string; x: number; y: number }[] = [
  { id: 'tl', x: 0, y: 0 }, { id: 'tc', x: 0.5, y: 0 }, { id: 'tr', x: 1, y: 0 },
  { id: 'ml', x: 0, y: 0.5 }, { id: 'mc', x: 0.5, y: 0.5 }, { id: 'mr', x: 1, y: 0.5 },
  { id: 'bl', x: 0, y: 1 }, { id: 'bc', x: 0.5, y: 1 }, { id: 'br', x: 1, y: 1 },
];
// Default drop for a new caption: bottom-center (classic subtitle position).
const DEFAULT_CAPTION_X = 0.5;
const DEFAULT_CAPTION_Y = 0.9;
const capX = (c?: Caption) => c?.x ?? DEFAULT_CAPTION_X;
const capY = (c?: Caption) => c?.y ?? DEFAULT_CAPTION_Y;
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const tc = (t: number) => `${fmt(t)}:${String(Math.floor((t % 1) * 30)).padStart(2, '0')}`;

// Materialize the composition (fold output) into ordered render segments, carrying the
// per-clip transform (speed/fade/volume/caption) so /api/render honors them. Reads
// EVERY video track's clips (role != 'audio') in time order — so a clip added to a
// NEW track renders too — never the derived audio projection.
const TEXT_ROLE = 'text';
function segmentsOf(comp: ReturnType<typeof composeTimeline>) {
  const clips = comp.lanes.filter((l) => l.role !== 'audio' && l.role !== TEXT_ROLE).flatMap((l) => l.clips);
  return clips
    .slice()
    .sort((a, b) => a.laneStart - b.laneStart)
    .map((c) => {
      const t = (c.transform ?? {}) as Transform;
      const caption = t.caption && t.caption.text ? t.caption : undefined;
      return {
        sourceId: c.sourceId, in: c.inPoint, out: c.outPoint,
        speed: t.speed, volume: t.volume, fade_in_s: t.fadeIn, fade_out_s: t.fadeOut,
        label: caption ? { text: caption.text, x: capX(caption), y: capY(caption), size: caption.size, color: caption.color } : undefined,
      };
    });
}

// Materialize the TEXT lanes (first-class text elements) into edl.text_overlays: each
// text clip's caption {text,x,y} + its lane time range [laneStart,laneEnd] becomes a
// time-gated burned overlay. Independent of the video spine (segmentsOf skips 'text').
function textOverlaysOf(comp: ReturnType<typeof composeTimeline>) {
  return comp.lanes
    .filter((l) => l.role === TEXT_ROLE)
    .flatMap((l) => l.clips)
    .map((c) => {
      const caption = (c.transform as Transform).caption;
      if (!caption || !(caption.text ?? '').trim()) return null;
      return { text: caption.text, x: capX(caption), y: capY(caption), start: c.laneStart, end: c.laneEnd, size: caption.size, color: caption.color };
    })
    .filter((o): o is NonNullable<typeof o> => o !== null);
}

// Build edl.spine.transitions from consecutive VIDEO clips: transitions[i] is the
// boundary between clip i and i+1 = clip[i+1]'s IN-transition (blend from the prev).
// null = hard cut. video-compose's universal transition primitive renders these.
function transitionsOf(comp: ReturnType<typeof composeTimeline>) {
  const clips = comp.lanes.filter((l) => l.role !== 'audio' && l.role !== TEXT_ROLE)
    .flatMap((l) => l.clips).slice().sort((a, b) => a.laneStart - b.laneStart);
  const out: (Transition | null)[] = [];
  for (let i = 0; i < clips.length - 1; i += 1) {
    const tr = (clips[i + 1].transform as Transform).transition;
    out.push(tr && tr.type ? { renderer: tr.renderer ?? 'xfade', type: tr.type, duration: tr.duration ?? 0.5 } : null);
  }
  return out;
}
// Transition presets = DATA rows over the xfade capability (the type IS the xfade
// transition name — infinitely many; these are convenient jumps, not a closed set).
const TRANSITIONS: { id: string; label: string }[] = [
  { id: 'none', label: 'Cut' }, { id: 'fade', label: 'Fade' }, { id: 'dissolve', label: 'Dissolve' },
  { id: 'wipeleft', label: 'Wipe' }, { id: 'slideright', label: 'Slide' }, { id: 'circleopen', label: 'Circle' },
];

// Palmier-style inspector row (module-level so it never remounts mid-drag): label
// left, value right, slider below. Value updates live; the render is debounced by
// the caller so it fires once the user stops dragging.
function InspectorRow(props: { label: string; value: string; min: number; max: number; step: number; v: number; disabled: boolean; onChange: (n: number) => void }) {
  return (
    <Container layout="vertical" gap="xs">
      <Container layout="horizontal" justifyContent="between" alignItems="center">
        <Text variant="body-xs" color="secondary">{props.label}</Text>
        <Text variant="body-xs" color="strong" mono tabular>{props.value}</Text>
      </Container>
      <RangeInput aria-label={props.label} value={props.v} min={props.min} max={props.max} step={props.step} width="100%" disabled={props.disabled} onValueChange={props.onChange} />
    </Container>
  );
}

// Freeform, DRAGGABLE caption overlay — the live preview of the burned caption.
// Positioned by the SAME {x,y} primitive the drawtext burner uses: left/top percent
// with a self-translate so x=1 pins the right edge, y=1 the bottom (matches
// video-compose's `pad+(w-text_w)*x`). When `editable`, dragging it anywhere writes
// a fresh x,y (freeform) — no corner enum, no fixed slots. Module-level so it never
// remounts mid-drag and drops the pointer capture.
function CaptionOverlay({ caption, editable, onMove }: { caption: Caption; editable: boolean; onMove: (x: number, y: number) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const grab = React.useRef<{ dx: number; dy: number } | null>(null);
  const x = capX(caption);
  const y = capY(caption);
  const onDown = (e: React.PointerEvent) => {
    if (!editable) return;
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    grab.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  };
  const onMovePtr = (e: React.PointerEvent) => {
    if (!grab.current) return;
    const el = ref.current; const parent = el?.parentElement;
    if (!el || !parent) return;
    const pr = parent.getBoundingClientRect();
    const travelX = Math.max(1, pr.width - el.offsetWidth);
    const travelY = Math.max(1, pr.height - el.offsetHeight);
    const nx = (e.clientX - pr.left - grab.current.dx) / travelX;
    const ny = (e.clientY - pr.top - grab.current.dy) / travelY;
    onMove(Math.max(0, Math.min(1, nx)), Math.max(0, Math.min(1, ny)));
  };
  const onUp = (e: React.PointerEvent) => {
    grab.current = null;
    try { ref.current?.releasePointerCapture(e.pointerId); } catch { /* released */ }
  };
  return (
    <Container ref={ref} position="absolute"
      left={`${x * 100}%`} top={`${y * 100}%`} transform={`translate(${-x * 100}%, ${-y * 100}%)`}
      pointerEvents={editable ? 'auto' : 'none'} cursor={editable ? 'grab' : undefined}
      touchAction={editable ? 'none' : undefined}
      onPointerDown={onDown} onPointerMove={onMovePtr} onPointerUp={onUp}
      background="overlay" rounded="sm" padding="xs">
      <Text variant="body-xs" weight="semibold" color="strong">{caption.text}</Text>
    </Container>
  );
}

// Award-grade caption alignment picker: a 3×3 position MATRIX where each cell's
// grid position IS its anchor (top-left cell = top-left anchor), the active cell is
// accent-filled (Button primary) with a solid dot, inactive cells a faint dot. This
// reads instantly as "where does the caption sit" — the standard pro alignment
// control (vs the empty ▢ squares). Freeform drag on the preview still writes any x,y.
function AlignPicker({ x, y, onPick }: { x: number; y: number; onPick: (nx: number, ny: number) => void }) {
  return (
    <Container layout="grid" gridCols={3} gap="xs">
      {ALIGN_ANCHORS.map((a) => {
        const active = Math.abs(x - a.x) < 0.02 && Math.abs(y - a.y) < 0.02;
        return (
          <Button key={a.id} size="sm" variant={active ? 'primary' : 'secondary'} aria-label={`Align ${a.id}`} onClick={() => onPick(a.x, a.y)}>{active ? '●' : '·'}</Button>
        );
      })}
    </Container>
  );
}

function EditorPreview() {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const seq = React.useRef(0);
  const librarySeededRef = React.useRef(false);
  const [decisions, setDecisions] = React.useState<MediaCompositionEditDecision[]>([]);
  const [reelUrl, setReelUrl] = React.useState('/reel.mp4');
  const [instruction, setInstruction] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState('Ready.');
  const [currentTime, setCurrentTime] = React.useState(0);
  const [videoDuration, setVideoDuration] = React.useState(0);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [speed, setSpeed] = React.useState(1);
  const [selectedClipId, setSelectedClipId] = React.useState<string | null>(null);
  const [library, setLibrary] = React.useState<LibraryClip[]>([]);
  const labelBySource = React.useMemo(
    () => Object.fromEntries(library.map((clip) => [clip.id, clip.label])),
    [library],
  );
  const [draft, setDraft] = React.useState<Transform>({ speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 });
  const [zoom, setZoom] = React.useState(1);
  const [aspect, setAspect] = React.useState('9:16');
  // Left icon-rail mode (DreamCut's vertical rail switches what the left panel shows).
  const [leftMode, setLeftMode] = React.useState<'media' | 'text' | 'settings'>('media');
  // Inspector category tabs (DreamCut groups clip properties into tabs, not one flat list).
  const [inspectorTab, setInspectorTab] = React.useState<'adjust' | 'caption' | 'transition'>('adjust');
  const aspectDef = React.useMemo(() => ASPECTS.find((a) => a.id === aspect) ?? ASPECTS[0], [aspect]);
  const frame = React.useMemo(() => frameSize(aspectDef), [aspectDef]);
  // Apply the DreamCut screen-look theme (DATA) → resolves its tokens to concrete CSS
  // variables and paints them on :root, exactly like the live shell's ApplyCurrentScreenLook.
  React.useEffect(() => {
    const things = (screenLookData as { things?: { payload?: { id?: string } }[] }).things ?? [];
    const rec = things.find((t) => t?.payload?.id === 'dreamcut');
    if (!rec?.payload) return;
    const palette = resolveScreenLookPalette(rec.payload) as Record<string, string>;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(palette)) root.style.setProperty(k, v);
  }, []);
  const [redoStack, setRedoStack] = React.useState<MediaCompositionEditDecision[]>([]);

  // Display view = the REAL decision stream (no fake mirror). Multi-track emerges
  // from the decisions' own lane_role; the A1 audio track is DERIVED honestly from
  // the video clips (withDerivedAudioLanes), not injected as fake decisions.
  const view: MediaWorkspaceView = React.useMemo(() => ({
    blockers: [], sources: [], lanes: [], panels: [], detailGroups: [], selections: [],
    editDecisions: decisions, markers: [],
  }), [decisions]);
  const composition = React.useMemo(() => withDerivedAudioLanes(composeTimeline(view)), [view]);
  // Selectable clips = every real (non-derived-audio) clip across all video tracks.
  const sourceClipIds = React.useMemo(
    () => new Set(composition.lanes.filter((l) => l.role !== 'audio').flatMap((l) => l.clips).map((c) => c.clipId)),
    [composition],
  );
  const allClips = React.useMemo(() => composition.lanes.flatMap((l) => l.clips), [composition]);
  const selectedClip = allClips.find((c) => c.clipId === selectedClipId) ?? null;

  // Real (non-derived-audio) clips across video AND text lanes.
  const captionClips = React.useMemo(
    () => allClips.filter((c) => !c.clipId.startsWith(AUDIO_CLIP_PREFIX)),
    [allClips],
  );
  // Which clip's caption drives the live preview overlay: the SELECTED clip when the
  // playhead sits within it (so a fresh text element or an in-progress caption edit
  // shows live), else any clip (video OR standalone text element) under the playhead
  // that carries a caption. This makes text elements show/scrub like the burned output.
  const overlayClip = React.useMemo(() => {
    const sel = captionClips.find((c) => c.clipId === selectedClipId);
    if (sel && currentTime >= sel.laneStart && currentTime < sel.laneEnd) return sel;
    return captionClips.find((c) => currentTime >= c.laneStart && currentTime < c.laneEnd
      && !!((c.transform as { caption?: Caption }).caption?.text ?? '').trim()) ?? null;
  }, [captionClips, selectedClipId, currentTime]);
  const activeCaption: Caption | null = React.useMemo(() => {
    if (!overlayClip) return null;
    if (overlayClip.clipId === selectedClipId) return (draft.caption?.text ?? '').trim() ? draft.caption! : null;
    const c = (overlayClip.transform as { caption?: Caption } | undefined)?.caption;
    return c && (c.text ?? '').trim() ? c : null;
  }, [overlayClip, selectedClipId, draft]);

  // sourceId -> thumbnail URL, for the filmstrip video lane.
  const thumbBySource = React.useMemo(
    () => Object.fromEntries(library.map((c) => [c.id, c.thumb])),
    [library],
  );

  // Real decoded audio peaks per clip for the A1 waveform (server-side ffmpeg on the
  // clip's true in/out). Debounced so rapid edits don't spam ffmpeg; keyed by clipId.
  const [peaksByClip, setPeaksByClip] = React.useState<Record<string, number[]>>({});
  React.useEffect(() => {
    const audioClips = composition.lanes.filter((l) => l.role === 'audio').flatMap((l) => l.clips);
    const clips = audioClips.map((c) => ({ key: c.clipId, sourceId: c.sourceId, in: c.inPoint, out: c.outPoint }));
    if (!clips.length) { setPeaksByClip({}); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      fetch('/api/peaks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clips }) })
        .then((r) => r.json()).then((d) => { if (alive && d.peaks) setPeaksByClip(d.peaks); }).catch(() => undefined);
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [composition]);

  const duration = videoDuration || composition.durationSeconds;
  const playheadPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  React.useEffect(() => {
    let alive = true;
    fetch('/api/library').then((r) => r.json()).then((d) => {
      if (!alive) return;
      const clips = Array.isArray(d.clips) ? d.clips as LibraryClip[] : [];
      setLibrary(clips);
      if (!librarySeededRef.current && clips.length > 0) {
        librarySeededRef.current = true;
        const initial = clips.slice(0, 3).map((clip, index) => addSource(
          clip.id,
          0,
          Math.min(clip.dur, 3),
          String(index).padStart(9, '0'),
          'video-1',
          'Video',
          'source',
          clip.label,
        ));
        seq.current = initial.length;
        setDecisions(initial);
      }
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  // Seed the inspector draft from the selected clip's transform.
  React.useEffect(() => {
    const t = (selectedClip?.transform ?? {}) as Transform;
    setDraft({ speed: t.speed ?? 1, volume: t.volume ?? 1, fadeIn: t.fadeIn ?? 0, fadeOut: t.fadeOut ?? 0, caption: { text: t.caption?.text ?? '', x: t.caption?.x, y: t.caption?.y, size: t.caption?.size, color: t.caption?.color }, transition: t.transition ?? {} });
  }, [selectedClipId]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => setVideoDuration(v.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    v.addEventListener('timeupdate', onTime); v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('play', onPlay); v.addEventListener('pause', onPause);
    v.playbackRate = speed;
    return () => { v.removeEventListener('timeupdate', onTime); v.removeEventListener('loadedmetadata', onMeta); v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPause); };
  }, [reelUrl, speed]);

  // When the reel changes (after any render), reload the <video> and nudge it to
  // paint the first frame. MediaFrame uses preload="metadata", which loads
  // metadata but paints NO frame until a seek/play — that is why the preview went
  // black after a render. load() + a tiny currentTime set forces a visible frame.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    v.load();
    const paint = () => { try { v.currentTime = 0.04; } catch { /* not seekable yet */ } };
    v.addEventListener('loadeddata', paint, { once: true });
    return () => v.removeEventListener('loadeddata', paint);
  }, [reelUrl]);

  const seek = React.useCallback((t: number) => { const v = videoRef.current; if (!v) return; const c = Math.max(0, Math.min(duration || v.duration || 0, t)); v.currentTime = c; setCurrentTime(c); }, [duration]);
  const seekBy = React.useCallback((d: number) => seek((videoRef.current?.currentTime ?? 0) + d), [seek]);
  const togglePlay = React.useCallback(() => { const v = videoRef.current; if (!v) return; if (v.paused) void v.play(); else v.pause(); }, []);
  const applySpeed = React.useCallback((s: number) => { setSpeed(s); if (videoRef.current) videoRef.current.playbackRate = s; }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space' || e.key === 'k') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight' || e.key === 'l') { e.preventDefault(); seekBy(e.shiftKey ? 1 : 5); }
      else if (e.key === 'ArrowLeft' || e.key === 'j') { e.preventDefault(); seekBy(e.shiftKey ? -1 : -5); }
      else if (e.key === 'Home') { e.preventDefault(); seek(0); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, seek]);

  const nextStamp = React.useCallback(() => String(seq.current++).padStart(9, '0'), []);

  // Render COALESCING: an ffmpeg reel render takes seconds, so firing one per
  // keystroke/drag would spawn many concurrent renders that thrash CPU and resolve
  // out of order (a stale reel clobbering a newer one = the "20s later it's fucked"
  // black preview). We keep AT MOST ONE render in flight; rapid edits overwrite a
  // single `pending` slot, and when the in-flight render finishes we render the
  // LATEST pending state. Only the newest reel is ever shown.
  const renderInFlight = React.useRef(false);
  const pendingRender = React.useRef<{ comp: ReturnType<typeof composeTimeline>; why: string } | null>(null);
  const renderComposition = React.useCallback(async (comp: ReturnType<typeof composeTimeline>, why: string): Promise<void> => {
    const segments = segmentsOf(comp);
    if (!segments.length) { setBusy(false); return; }
    if (renderInFlight.current) { pendingRender.current = { comp, why }; setNote(`${why}: queued…`); return; }
    renderInFlight.current = true;
    setBusy(true); setNote(`${why}: rendering...`);
    try {
      const res = await fetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ segments, text_overlays: textOverlaysOf(comp), transitions: transitionsOf(comp), width: aspectDef.w, height: aspectDef.h }) });
      const d = await res.json();
      if (!res.ok) setNote(`Render failed: ${d.error ?? res.status}`);
      else { setReelUrl(d.reelUrl); setCurrentTime(0); setNote(`${why}: done.`); }
    } catch (e) { setNote(`Render error: ${String((e as Error).message)}`); }
    finally {
      renderInFlight.current = false;
      const next = pendingRender.current;
      pendingRender.current = null;
      if (next) void renderComposition(next.comp, next.why); // render the latest queued edit
      else setBusy(false);
    }
  }, [aspectDef.w, aspectDef.h]);

  const authorDecision = React.useCallback((decision: MediaCompositionEditDecision, opts: { render: boolean; why: string }) => {
    const next = [...decisions, { ...decision, created_at: nextStamp() }];
    setDecisions(next);
    setRedoStack([]); // a new edit invalidates the redo branch
    if (opts.render) void renderComposition(composeTimeline({ ...view, editDecisions: next }), opts.why);
  }, [decisions, view, nextStamp, renderComposition]);

  // Undo/redo over the append-only decision stream: undo pops the last edit onto
  // a redo stack; redo re-appends it. Both re-fold + re-render through the primitive.
  const undo = React.useCallback(() => {
    if (!decisions.length || busy) return;
    const last = decisions[decisions.length - 1];
    const next = decisions.slice(0, -1);
    setDecisions(next); setRedoStack((r) => [...r, last]); setSelectedClipId(null);
    void renderComposition(composeTimeline({ ...view, editDecisions: next }), 'Undo');
  }, [decisions, busy, view, renderComposition]);
  const redo = React.useCallback(() => {
    if (!redoStack.length || busy) return;
    const item = redoStack[redoStack.length - 1];
    const next = [...decisions, item];
    setDecisions(next); setRedoStack((r) => r.slice(0, -1));
    void renderComposition(composeTimeline({ ...view, editDecisions: next }), 'Redo');
  }, [redoStack, decisions, busy, view, renderComposition]);

  const splitAtPlayhead = React.useCallback(() => {
    authorDecision({ action: 'split', parameters: { time: currentTime } }, { render: false, why: 'Split' });
    setNote('Split at playhead.');
  }, [authorDecision, currentTime]);

  const deleteSelected = React.useCallback(() => {
    if (!selectedClipId) { setNote('Select a clip first.'); return; }
    authorDecision({ action: 'delete', parameters: { clip_id: selectedClipId } }, { render: true, why: 'Delete' });
    setSelectedClipId(null);
  }, [authorDecision, selectedClipId]);

  // Add a FIRST-CLASS TEXT element at the playhead: ONE add-source on a 'text' lane
  // carrying its caption (text + {x,y}) and an explicit lane_start (the playhead). It
  // is a real timeline element with its own time range — edit via the caption
  // inspector, drag on the preview, and it renders as a time-gated text overlay.
  const textSeq = React.useRef(0);
  const addTextElement = React.useCallback(() => {
    authorDecision({
      action: 'add-source', label: 'Text',
      source_ref: { source_id: `text:${textSeq.current++}` },
      span: { start: 0, end: 2.5 },
      parameters: { lane_role: TEXT_ROLE, lane_label: 'Text', lane_tone: 'output', lane_start: currentTime, caption_text: 'Text', caption_x: DEFAULT_CAPTION_X, caption_y: DEFAULT_CAPTION_Y },
    }, { render: true, why: 'Add text' });
    setNote('Text element added — edit it in the inspector or drag it on the preview.');
  }, [authorDecision, currentTime]);

  // Where the next library add lands: 'append' -> the primary video track;
  // 'new' -> a brand-new video track. Both drive the SAME add-source primitive,
  // differing only by lane_role DATA (proving real add-to-track + new-track).
  const [addTarget, setAddTarget] = React.useState<'append' | 'new'>('append');
  const addFromLibrary = React.useCallback((clip: LibraryClip) => {
    const videoRoles = composition.lanes.filter((l) => l.role !== 'audio').map((l) => l.role);
    const inP = 0.5;
    const outP = Math.max(1, Math.min(clip.dur, 4.5));
    if (addTarget === 'new') {
      // Name the new track by MAX existing video-N + 1 (never by count) so deleting a
      // track then adding never collides with a surviving role and silently appends.
      const maxN = videoRoles.reduce((m, r) => { const g = /^video-(\d+)$/.exec(r); return g ? Math.max(m, Number(g[1])) : m; }, 0);
      const n = maxN + 1;
      authorDecision(addSource(clip.id, inP, outP, '', `video-${n}`, `Video ${n}`, 'source', clip.label), { render: true, why: `Add ${clip.label} → new track` });
    } else {
      const primary = videoRoles[0] ?? 'video-1';
      authorDecision(addSource(clip.id, inP, outP, '', primary, 'Video', 'source', clip.label), { render: true, why: `Add ${clip.label}` });
    }
  }, [authorDecision, composition, addTarget]);

  // Commit the inspector draft as ONE set-transform decision on the selected clip,
  // debounced so the render fires after the user stops dragging (not per tick). The
  // latest draft is read from a ref so the timer never uses a stale value.
  const draftRef = React.useRef(draft);
  React.useEffect(() => { draftRef.current = draft; }, [draft]);
  const commitTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleInspectorCommit = React.useCallback(() => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      if (!selectedClipId) return;
      const t = draftRef.current;
      authorDecision({ action: 'set-transform', parameters: { clip_id: selectedClipId, speed: t.speed, volume: t.volume, fade_in: t.fadeIn, fade_out: t.fadeOut } }, { render: true, why: 'Adjust clip' });
    }, 700);
  }, [authorDecision, selectedClipId]);
  const onDraftChange = React.useCallback((patch: Transform) => {
    setDraft((d) => ({ ...d, ...patch }));
    scheduleInspectorCommit();
  }, [scheduleInspectorCommit]);

  // Caption authors its OWN set-transform decision (only `caption_text`), so it
  // never clobbers speed/volume/fade and vice-versa (the fold merges the extracted
  // fields shallowly). Debounced so the render fires after the user stops typing.
  const captionTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCaptionCommit = React.useCallback(() => {
    if (captionTimer.current) clearTimeout(captionTimer.current);
    captionTimer.current = setTimeout(() => {
      if (!selectedClipId) return;
      const c = draftRef.current.caption ?? { text: '' };
      // Author the FULL caption in one set-transform: text + normalized {x,y} position.
      // The fold replaces caption wholesale, so sending x,y with the text keeps a
      // position change and a text change from clobbering each other.
      authorDecision({ action: 'set-transform', parameters: { clip_id: selectedClipId, caption_text: c.text ?? '', caption_x: capX(c), caption_y: capY(c) } }, { render: true, why: 'Caption' });
    }, 700);
  }, [authorDecision, selectedClipId]);
  const onCaptionChange = React.useCallback((patch: Partial<Caption>) => {
    setDraft((d) => ({ ...d, caption: { ...(d.caption ?? { text: '' }), ...patch } }));
    scheduleCaptionCommit();
  }, [scheduleCaptionCommit]);

  // The selected clip's IN-transition is a discrete pick, so author it immediately
  // (set-transform with transition_type + duration). 'none' clears it (hard cut).
  const setTransition = React.useCallback((type: string) => {
    if (!selectedClipId) return;
    setDraft((d) => ({ ...d, transition: type === 'none' ? {} : { renderer: 'xfade', type, duration: 0.5 } }));
    authorDecision({ action: 'set-transform', parameters: { clip_id: selectedClipId, transition_type: type, transition_duration: 0.5 } }, { render: true, why: 'Transition' });
  }, [authorDecision, selectedClipId]);

  const runAi = React.useCallback(async (text: string) => {
    if (!text.trim() || busy) return;
    const cutList = segmentsOf(composition).map((s) => ({ id: s.sourceId, in: s.in, out: s.out }));
    setBusy(true); setNote(`AI is re-cutting: "${text}" ...`);
    try {
      const res = await fetch('/api/ai-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: text, cutList }) });
      const data = await res.json();
      if (!res.ok) { setNote(`AI edit failed: ${data.error ?? res.status}`); setBusy(false); return; }
      const next: MediaCompositionEditDecision[] = data.cutList.map((c: { id: string; in: number; out: number }, i: number) => addSource(
        c.id,
        c.in,
        c.out,
        String(i).padStart(9, '0'),
        'video-1',
        'Video',
        'source',
        labelBySource[c.id] ?? c.id,
      ));
      seq.current = next.length;
      setDecisions(next); setRedoStack([]); setInstruction('');
      await renderComposition(composeTimeline({ ...view, editDecisions: next }), data.summary ?? 'AI edit');
    } catch (e) { setNote(`AI edit error: ${String((e as Error).message)}`); setBusy(false); }
  }, [busy, composition, view, renderComposition]);

  return (
    <Container layout="vertical" gap="md" padding="md" background="primary" minHeight="100vh">
      {/* TOP BAR */}
      <Container layout="horizontal" justifyContent="between" alignItems="center" padding="xs">
        <Container layout="horizontal" gap="xs" alignItems="center">
          <Text variant="body-xs" color="faint">●●●</Text>
        </Container>
        <Container layout="horizontal" gap="xs" alignItems="baseline">
          <Text variant="body" weight="semibold" color="strong">Founder Reel</Text>
          <Text variant="caption" color="faint">.cut · {aspectDef.w}×{aspectDef.h} · 30fps</Text>
        </Container>
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Button size="sm" variant="accent" className="shadow-lg" disabled={busy} onClick={() => {
            // Export = download the CURRENT rendered reel (the burned mp4 is the SSOT).
            const a = document.createElement('a');
            a.href = reelUrl; a.download = 'founder-reel.mp4';
            document.body.appendChild(a); a.click(); a.remove();
            setNote('Exported founder-reel.mp4');
          }}>⤴ Export</Button>
          <Badge variant="accent" size="md">JA</Badge>
        </Container>
      </Container>

      {/* MAIN: library | stage | inspector */}
      <Container layout="horizontal" gap="sm" alignItems="stretch" flex="1">
        {/* LEFT icon rail (DreamCut composition): a narrow vertical strip of icons
            that switches WHAT the left panel shows. Active icon is the filled button. */}
        <Card variant="surface" padding="xs">
          <Container layout="vertical" gap="sm" alignItems="center" width="36px">
            <Button size="sm" variant={leftMode === 'media' ? 'primary' : 'ghost'} onClick={() => setLeftMode('media')} title="Media"><Icon icon={Clapperboard} size="sm" /></Button>
            <Button size="sm" variant={leftMode === 'text' ? 'primary' : 'ghost'} onClick={() => setLeftMode('text')} title="Text"><Icon icon={Type} size="sm" /></Button>
            <Button size="sm" variant={leftMode === 'settings' ? 'primary' : 'ghost'} onClick={() => setLeftMode('settings')} title="Settings"><Icon icon={SlidersHorizontal} size="sm" /></Button>
          </Container>
        </Card>
        {/* LEFT panel — content driven by the rail mode. */}
        <Card variant="surface" padding="md">
          <Container layout="vertical" gap="sm" width="236px">
            {leftMode === 'media' && (
              <>
                <Container layout="horizontal" justifyContent="between" alignItems="center">
                  <Text variant="body-xs" weight="semibold" color="strong">Media</Text>
                  <Badge variant="muted" size="sm">{library.length}</Badge>
                </Container>
                <Container layout="grid" gridCols={2} gap="xs" overflow="y-auto" maxHeight="420px">
                  {library.map((clip) => (
                    <Container key={clip.id} layout="vertical" gap="none" onClick={() => addFromLibrary(clip)} cursor={busy ? 'wait' : 'pointer'} title={`Add ${clip.label}`} rounded="md" overflow="hidden">
                      <MediaFrame url={clip.thumb} mediaType="image/jpeg" label={clip.label} />
                      <Text variant="caption" color="faint" truncate>{clip.label}</Text>
                    </Container>
                  ))}
                </Container>
                <Container layout="vertical" gap="xs">
                  <Text variant="caption" color="faint">Add clicked clip to</Text>
                  <Container layout="horizontal" gap="xs">
                    <Button size="sm" variant={addTarget === 'append' ? 'primary' : 'secondary'} onClick={() => setAddTarget('append')}>This track</Button>
                    <Button size="sm" variant={addTarget === 'new' ? 'primary' : 'secondary'} onClick={() => setAddTarget('new')}>＋ New track</Button>
                  </Container>
                </Container>
              </>
            )}
            {leftMode === 'text' && (
              <>
                <Text variant="body-xs" weight="semibold" color="strong">Text</Text>
                <Button size="sm" variant="secondary" onClick={addTextElement}>＋ Add text at playhead</Button>
                <Text variant="caption" color="faint">A text element lands on its own track at the playhead. Select it to edit the words and position in the inspector.</Text>
              </>
            )}
            {leftMode === 'settings' && (
              <>
                <Text variant="body-xs" weight="semibold" color="strong">Settings</Text>
                <Text variant="caption" color="faint">Aspect ratio</Text>
                <Container layout="grid" gridCols={3} gap="xs">
                  {ASPECTS.map((a) => (
                    <Button key={a.id} size="sm" variant={a.id === aspect ? 'primary' : 'secondary'} onClick={() => setAspect(a.id)}>{a.id}</Button>
                  ))}
                </Container>
                <Text variant="caption" color="faint">{aspectDef.w}×{aspectDef.h} · 30 fps</Text>
              </>
            )}
          </Container>
        </Card>

        {/* CENTER — stage */}
        <Container layout="vertical" gap="sm" alignItems="stretch" flex="1">
          <Card variant="surface" padding="md">
            <Container layout="vertical" gap="sm" alignItems="center">
              <Container layout="horizontal" justifyContent="between" alignItems="center" width="full">
                <Text variant="body-xs" color="faint">Preview</Text>
                <Container layout="horizontal" gap="xs" alignItems="center">
                  {ASPECTS.map((a) => (
                    <Button key={a.id} size="sm" variant={a.id === aspect ? 'primary' : 'secondary'} onClick={() => setAspect(a.id)}>{a.id}</Button>
                  ))}
                  <Badge variant="muted" size="sm">{`${aspectDef.w}×${aspectDef.h}`}</Badge>
                </Container>
              </Container>
              {/* Stage: DreamCut floats the framed canvas on a soft backdrop with a
                  drop shadow so the video reads as a premium object, not a flat rect. */}
              <Container width="full" layout="vertical" alignItems="center" justifyContent="center" background="tertiary" rounded="lg" className="py-6">
              <Container width={`${frame.w}px`} heightPx={`${frame.h}px`} rounded="lg" overflow="hidden" position="relative" className="shadow-2xl ring-1 ring-white/10">
                <MediaFrame url={reelUrl} mediaType="video/mp4" label="Edited reel" videoRef={videoRef} />
                {/* LIVE caption overlay — the selected clip's caption shows instantly
                    as you type (no wait for the ffmpeg burn). The burned mp4 is the
                    export SSOT; this is the real-time preview of it. */}
                {activeCaption && (
                  <CaptionOverlay
                    caption={activeCaption}
                    editable={overlayClip?.clipId === selectedClipId}
                    onMove={(x, y) => onCaptionChange({ x, y })}
                  />
                )}
              </Container>
              </Container>
              {/* transport */}
              <Container layout="vertical" gap="xs" width="full" alignItems="center">
                <Container layout="horizontal" gap="xs" alignItems="center">
                  <Button size="sm" variant="secondary" onClick={() => seek(0)}>⏮</Button>
                  <Button size="sm" variant="secondary" onClick={() => seekBy(-5)}>◀◀</Button>
                  <Button onClick={togglePlay}>{isPlaying ? '❚❚' : '▶'}</Button>
                  <Button size="sm" variant="secondary" onClick={() => seekBy(5)}>▶▶</Button>
                  <Text variant="body-xs" color="secondary" mono tabular>{tc(currentTime)} / {tc(duration)}</Text>
                </Container>
                <RangeInput aria-label="Scrub" value={currentTime} min={0} max={duration || 1} step={0.05} width="100%" onValueChange={seek} />
                <Container layout="horizontal" gap="xs" alignItems="center">
                  <Text variant="caption" color="faint">Speed</Text>
                  {SPEEDS.map((s) => (<Button key={s} size="sm" variant={s === speed ? 'primary' : 'secondary'} onClick={() => applySpeed(s)}>{s}×</Button>))}
                </Container>
              </Container>
            </Container>
          </Card>
        </Container>

        {/* RIGHT — Inspector (Levels / Playback) */}
        <Card variant="surface" padding="md">
          <Container layout="vertical" gap="sm" width="224px">
            <Text variant="body-xs" weight="semibold" color="strong">Inspector</Text>
            <Text variant="caption" color="faint" truncate>{selectedClip ? selectedClip.label : 'Select a clip'}</Text>
            {/* Category tabs (DreamCut places clip properties behind tabs, not a flat stack). */}
            <Container layout="horizontal" gap="xs">
              <Button size="sm" variant={inspectorTab === 'adjust' ? 'primary' : 'secondary'} onClick={() => setInspectorTab('adjust')}>Adjust</Button>
              <Button size="sm" variant={inspectorTab === 'caption' ? 'primary' : 'secondary'} onClick={() => setInspectorTab('caption')}>Caption</Button>
              <Button size="sm" variant={inspectorTab === 'transition' ? 'primary' : 'secondary'} onClick={() => setInspectorTab('transition')}>Transition</Button>
            </Container>
            {inspectorTab === 'adjust' && (
              <>
                <Container layout="vertical" gap="xs" border="top" padding="none">
                  <Text variant="caption" color="faint">LEVELS</Text>
                  <InspectorRow label="Volume" value={`${Math.round((draft.volume ?? 1) * 100)}%`} min={0} max={1.5} step={0.05} v={draft.volume ?? 1} disabled={!selectedClip} onChange={(n) => onDraftChange({ volume: n })} />
                  <InspectorRow label="Fade in" value={`${(draft.fadeIn ?? 0).toFixed(1)}s`} min={0} max={2} step={0.1} v={draft.fadeIn ?? 0} disabled={!selectedClip} onChange={(n) => onDraftChange({ fadeIn: n })} />
                  <InspectorRow label="Fade out" value={`${(draft.fadeOut ?? 0).toFixed(1)}s`} min={0} max={2} step={0.1} v={draft.fadeOut ?? 0} disabled={!selectedClip} onChange={(n) => onDraftChange({ fadeOut: n })} />
                </Container>
                <Container layout="vertical" gap="xs" border="top" padding="none">
                  <Text variant="caption" color="faint">PLAYBACK</Text>
                  <InspectorRow label="Speed" value={`${(draft.speed ?? 1).toFixed(2)}×`} min={0.5} max={2} step={0.05} v={draft.speed ?? 1} disabled={!selectedClip} onChange={(n) => onDraftChange({ speed: n })} />
                </Container>
              </>
            )}
            {inspectorTab === 'caption' && (
              <Container layout="vertical" gap="xs" border="top" padding="none">
                <Text variant="caption" color="faint">CAPTION</Text>
                <Input placeholder="Add a caption…" value={draft.caption?.text ?? ''} disabled={!selectedClip} onChange={(e) => onCaptionChange({ text: (e.target as HTMLInputElement).value })} />
                {(draft.caption?.text ?? '').trim() && (
                  <Container layout="vertical" gap="xs">
                    {/* 9 alignment ANCHORS = DATA presets over the {x,y} primitive
                        (left/center/right × top/middle/bottom), rendered as a position
                        matrix. The active anchor is whichever (x,y) the caption sits on. */}
                    <AlignPicker x={capX(draft.caption)} y={capY(draft.caption)} onPick={(nx, ny) => onCaptionChange({ x: nx, y: ny })} />
                    <Text variant="caption" color="faint">Or drag the caption on the preview to place it anywhere.</Text>
                  </Container>
                )}
              </Container>
            )}
            {inspectorTab === 'transition' && (
              <Container layout="vertical" gap="xs" border="top" padding="none">
                <Text variant="caption" color="faint">TRANSITION IN</Text>
                <Container layout="grid" gridCols={3} gap="xs">
                  {TRANSITIONS.map((tr) => {
                    const active = (draft.transition?.type ?? 'none') === tr.id || (tr.id === 'none' && !draft.transition?.type);
                    return (
                      <Button key={tr.id} size="sm" variant={active ? 'primary' : 'secondary'} disabled={!selectedClip} onClick={() => setTransition(tr.id)}>{tr.label}</Button>
                    );
                  })}
                </Container>
              </Container>
            )}
          </Container>
        </Card>
      </Container>

      {/* TIMELINE — the star. Icon toolbar + zoom, then the multi-track lanes. */}
      <Card variant="surface" padding="sm">
        <Container layout="vertical" gap="sm">
          <Container layout="horizontal" gap="xs" alignItems="center">
            <Button size="sm" variant="secondary" onClick={undo} disabled={!decisions.length}><Icon icon={Undo2} size="sm" /></Button>
            <Button size="sm" variant="secondary" onClick={redo} disabled={!redoStack.length}><Icon icon={Redo2} size="sm" /></Button>
            <Container width="10px" />
            <Button size="sm" variant="primary"><Icon icon={MousePointer2} size="sm" /></Button>
            <Button size="sm" variant="secondary" onClick={splitAtPlayhead}><Icon icon={Scissors} size="sm" /></Button>
            <Button size="sm" variant="secondary" onClick={deleteSelected} disabled={!selectedClipId}><Icon icon={Trash2} size="sm" /></Button>
            <Button size="sm" variant="secondary" onClick={addTextElement} title="Add text element at playhead"><Icon icon={Type} size="sm" /></Button>
            <Container flex="1" />
            <Text variant="caption" color="faint" truncate>{note}</Text>
            <Container width="10px" />
            <Icon icon={ZoomIn} size="sm" color="faint" />
            <Container width="120px">
              <RangeInput aria-label="Zoom" value={zoom} min={1} max={4} step={0.1} width="100%" onValueChange={setZoom} />
            </Container>
            <Text variant="caption" color="faint" mono tabular>{zoom.toFixed(1)}×</Text>
          </Container>
          <EditTrackLanes
            composition={composition}
            playheadPct={playheadPct}
            playheadLabel={fmt(currentTime)}
            selectedClipId={selectedClipId}
            thumbBySource={thumbBySource}
            peaksByClip={peaksByClip}
            zoom={zoom}
            onSeek={seek}
            onSelectClip={(id) => {
              // An A1 (derived-audio) clip selects its PARENT video clip, so the
              // Volume/Fade inspector controls that clip's audio — the audio track
              // is functional, not decorative.
              const parentId = id.startsWith(AUDIO_CLIP_PREFIX) ? id.slice(AUDIO_CLIP_PREFIX.length) : id;
              if (!sourceClipIds.has(parentId)) return;
              setSelectedClipId(parentId);
              const clip = allClips.find((c) => c.clipId === parentId);
              if (clip) seek(clip.laneStart);
            }}
            onTrim={(id, i, o) => authorDecision({ action: 'trim', parameters: { clip_id: id, new_start: i, new_end: o } }, { render: true, why: 'Trim' })}
            onMove={(id, laneStart, destRole) => {
              // Cross-lane move: EditTrackLanes reports which track ROW the clip was
              // dropped on. Only real video tracks are authorable drop targets — the
              // derived A1 audio lane and the text lane are projections, not lanes you
              // can move footage into (society policy owned here at the harness, L098).
              const toTrack = !!destRole && destRole !== 'audio' && destRole !== TEXT_ROLE;
              authorDecision(
                { action: 'move', parameters: toTrack
                  ? { clip_id: id, lane_start: laneStart, lane_role: destRole }
                  : { clip_id: id, lane_start: laneStart } },
                { render: true, why: toTrack ? `Move clip to ${destRole}` : 'Move clip' },
              );
            }}
          />
        </Container>
      </Card>

      {/* AI bar */}
      <Card variant="surface" padding="sm">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="body-xs" weight="semibold" color="strong">Edit with AI</Text>
          <Container flex="1">
            <Input placeholder="Ask the AI to re-cut, e.g. end on the coaching shot" value={instruction} disabled={busy} onChange={(e) => setInstruction((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if ((e as React.KeyboardEvent).key === 'Enter') runAi(instruction); }} />
          </Container>
          {QUICK.map((q) => (<Button key={q} variant="secondary" size="sm" disabled={busy} onClick={() => runAi(q)}>{q.split(':')[0]}</Button>))}
          <Button onClick={() => runAi(instruction)} disabled={busy}>{busy ? 'Working…' : 'Send'}</Button>
        </Container>
      </Card>
    </Container>
  );
}

createRoot(document.getElementById('root')!).render(<EditorPreview />);
