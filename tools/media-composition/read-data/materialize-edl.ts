// package-set://bitfield-studio/packages/media-composition/read-data/materialize-edl.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The ONE translation from a MaterializedComposition (the pure fold of
// edit-decision records — see compose-timeline.ts) to a contract::edl document
// that `action:video-compose` renders. SSOT (plan 2026-07-18 T2): the preview
// and the export consume the SAME MaterializedComposition; this file is the
// only place the composition becomes an EDL, so what the user previews is what
// the compositor renders — the AI production path and the human tweak path are
// indistinguishable at the compositor boundary (L069).
//
// NON-NEGOTIABLE INVARIANTS
//
//   1. PURE & DETERMINISTIC — no I/O, no Date.now(). Source-ref → URL/path
//      resolution is INJECTED by the caller (the surface resolves CAS refs to
//      the engine's /cas/<addr> route; a CLI resolves to local paths). This
//      file never knows where bytes live.
//
//   2. LANE-ROLE-BLIND — lanes are mapped by STRUCTURE (which lanes carry
//      renderable clips), never by role keywords. The first lane with clips
//      becomes the spine; every subsequent lane's clips become overlay-free
//      spine appends only when the EDL declares them; audio replacement is an
//      explicit decision field, not a role guess.
//
//   3. PER-CLIP PROPERTY GRAMMAR PASSES THROUGH UNTOUCHED — trim/speed/crop/
//      flip/fades/keyframes/track flags on a materialized clip flow onto the
//      EDL clip row verbatim (contract::edl owns their meaning). This file
//      adds no interpretation (L098: the compositor is the consumer language).
//
// =============================================================================

import type {
  MaterializedComposition,
  MaterializedClip,
  ClipTransform,
} from './compose-timeline';
import { TEXT_MOTION_CATALOG } from './compose-timeline';

/** #115 Expand a text overlay's entrance/exit motion into keyframe envelopes the render compiles via
 *  piecewiseExpr. `enter`/`exit` are named TEXT_MOTION_CATALOG presets instantiated against the
 *  overlay's window (entrance over [start, start+dur], exit reversed over [end-dur, end]); `enter_dur`/
 *  `exit_dur` size the motion (default 0.5s). Explicit `keyframes` on the overlay win per-axis. Slide
 *  axes are normalized deltas from the resting x/y; alpha is absolute. Returns undefined when neither a
 *  preset nor explicit keyframes are present (a static overlay stays byte-identical). */
function expandTextMotion(o: Record<string, unknown>): Record<string, Array<{ t: number; value: number; interp?: string }>> | undefined {
  const explicit = (o.keyframes && typeof o.keyframes === 'object') ? { ...(o.keyframes as Record<string, Array<{ t: number; value: number; interp?: string }>>) } : {};
  const start = Number.isFinite(o.start as number) ? Math.max(0, o.start as number) : 0;
  const end = Number.isFinite(o.end as number) ? (o.end as number) : undefined;
  const restX = Number.isFinite(o.x as number) ? (o.x as number) : 0.5;
  const restY = Number.isFinite(o.y as number) ? (o.y as number) : 0.5;
  const rest = { x: restX, y: restY, alpha: 0 };
  const out: Record<string, Array<{ t: number; value: number; interp?: string }>> = {};
  const place = (edge: 'enter' | 'exit') => {
    const name = o[edge];
    if (typeof name !== 'string') return;
    const preset = TEXT_MOTION_CATALOG[name];
    if (!preset) return;
    const durKey = edge === 'enter' ? 'enter_dur' : 'exit_dur';
    const dur = Number.isFinite(o[durKey] as number) && (o[durKey] as number) > 0 ? (o[durKey] as number) : 0.5;
    // Motion-time t (0..1) -> absolute timeline seconds. Exit reverses (t=0 is the settled rest).
    const t0 = edge === 'enter' ? start : (end !== undefined ? end - dur : start);
    const base = preset.rel ? (rest as Record<string, number>)[preset.axis] : 0;
    const toAbs = (mt: number) => edge === 'enter' ? t0 + mt * dur : t0 + (1 - mt) * dur;
    const knots = preset.knots.map((k) => ({ t: +toAbs(k.t).toFixed(3), value: preset.rel ? +(base + k.value).toFixed(3) : k.value, ...(k.interp ? { interp: k.interp } : {}) }))
      .sort((a, b) => a.t - b.t);
    (out[preset.axis] ??= []).push(...knots);
  };
  place('enter');
  place('exit');
  // Explicit per-axis keyframes override a generated preset envelope for that axis.
  for (const axis of Object.keys(explicit)) out[axis] = explicit[axis];
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Resolves a composition source id to a URL/path the compositor's ffmpeg can open. */
export type SourceResolver = (sourceId: string) => string | null;

export type EdlClipRow = {
  id: string;
  /** 'clip' = a single-source spine segment; 'split' = N sources tiled into one frame
   *  (buildSplit reads `sources`/`layout`/`weights`/`duration` instead of `source`). */
  kind: 'clip' | 'split';
  /** Present for kind:'clip'. */
  source?: string;
  /** Present for kind:'split': the tiled cells (cell 0 = the spine clip's own source). `crop`
   *  (source px) and `flip` are buildSplit's native per-source framing controls. */
  sources?: Array<{ source: string; in?: number; out?: number; label?: { text: string };
    crop?: { w: number; h: number; x: number; y: number }; flip?: string }>;
  layout?: 'h' | 'v' | 'grid';
  weights?: number[];
  duration?: number;
  in?: number;
  out?: number;
  track_id: string;
  [property: string]: unknown;
};

export type MusicBed = {
  artifact: string;
  trim?: [number, number];
  volume?: number;
  fade_in?: { st: number; d: number; curve?: string };
  fade_out?: { st: number; d: number; curve?: string };
  /** When true, video-compose sidechaincompresses the bed keyed by spine speech only;
   * narration/TTS added later does not key this path unless pre-baked into the spine. */
  duck?: boolean;
};

export type MaterializedEdl = {
  base: { kind: 'color'; color: string };
  tracks: { id: string }[];
  spine: { segments: EdlClipRow[] };
  audio_graph?: { replace_audio?: string; music_bed?: MusicBed; narration?: NarrationClip[] };
  encode?: Record<string, unknown>;
  /** #90 Composition-wide caption translation applied to every burned text by the render. */
  caption_translate?: { to?: string; producer?: string; glossary?: Record<string, string> };
  /** #93 Master-bus loudness normalization: target integrated LUFS for the finished program. */
  master_loudnorm?: number;
  /** #230 Program-level subtitle / karaoke burn: a ready ASS subtitle string (authored upstream by
   *  author-karaoke-captions.ts from caption-lines word timings) burned over the whole finished program
   *  via one generic libass `ass=` filter. `fontsdir` optionally points at a font directory. Blind DATA
   *  (L069/L090): the render consumes ANY authored ASS (karaoke reveal, plain lines, styled), never knowing
   *  what the words mean. */
  subtitles?: { ass: string; fontsdir?: string };
  text_overlays?: Record<string, unknown>[];
  image_overlays?: Record<string, unknown>[];
  video_overlays?: Record<string, unknown>[];
  region_overlays?: Record<string, unknown>[];
  audio_viz_overlays?: Record<string, unknown>[];
};

/** #99 A narration/voiceover clip placed at a lane time: video-compose adelays it to `start`,
 *  trims to [in,out], applies `volume`, and amixes it over the spine (parallel to the music bed). */
export type NarrationClip = {
  artifact?: string;
  /** #99 render-generated voice: text + DATA-selected engine, generated by video-compose at render. */
  tts_text?: string;
  tts_producer?: string;
  tts_voice?: string;
  start: number;
  in?: number;
  out?: number;
  volume?: number;
};

/** Build a narration audio_graph entry from a NARRATION clip (transform.narration). LANE-ROLE-BLIND:
 *  the routing key is the explicit `narration` DATA flag, never the lane role. `start` is the clip's
 *  laneStart (when the voice speaks). If the clip carries `ttsText`, the render GENERATES the audio
 *  and plays the WHOLE clip (no in/out trim); otherwise it uses the pre-made artifact's in/out. */
function narrationFromClip(clip: MaterializedClip, source: string): NarrationClip {
  const t = clip.transform as Record<string, unknown>;
  const volume = typeof t.volume === 'number' ? t.volume : 1;
  if (typeof t.ttsText === 'string' && t.ttsText.trim()) {
    const n: NarrationClip = { tts_text: t.ttsText, start: Math.max(0, clip.laneStart), volume };
    if (typeof t.ttsProducer === 'string') n.tts_producer = t.ttsProducer;
    if (typeof t.ttsVoice === 'string') n.tts_voice = t.ttsVoice;
    return n;
  }
  const inPoint = clip.inPoint;
  const outPoint = clip.outPoint > clip.inPoint ? clip.outPoint : clip.laneEnd;
  return { artifact: source, start: Math.max(0, clip.laneStart), in: inPoint, out: outPoint, volume };
}

/**
 * Build the music-bed audio_graph entry from a MUSIC-BED clip (transform.audioBed).
 * The bed rides UNDER the video spine (amix), so its trim/volume/fades come from the
 * clip's own in/out + transform. LANE-ROLE-BLIND (invariant #2): the routing key is the
 * explicit `audioBed` DATA flag, never the lane role. Fades default to qsin 2s in / 4s
 * out anchored to the bed's own length so any music DATA works with zero further config.
 */
function musicBedFromClip(clip: MaterializedClip, source: string): MusicBed {
  const t = clip.transform as Record<string, unknown>;
  const start = clip.inPoint;
  const end = clip.outPoint > clip.inPoint ? clip.outPoint : clip.laneEnd;
  const length = Math.max(0, end - start);
  const fadeIn = typeof t.fadeIn === 'number' ? t.fadeIn : 2;
  const fadeOut = typeof t.fadeOut === 'number' ? t.fadeOut : 4;
  const bed: MusicBed = {
    artifact: source,
    volume: typeof t.volume === 'number' ? t.volume : 0.35,
    fade_in: { st: 0, d: fadeIn, curve: 'qsin' },
    fade_out: { st: Math.max(0, length - fadeOut), d: fadeOut, curve: 'qsin' },
  };
  if (end > start) bed.trim = [start, end];
  if (t.duck === true) bed.duck = true;
  return bed;
}

function clipRow(clip: MaterializedClip, source: string, trackId: string, globalTransform?: Record<string, unknown>): EdlClipRow {
  const row: EdlClipRow = {
    id: clip.clipId,
    kind: 'clip',
    source,
    track_id: trackId,
  };
  if (clip.outPoint > clip.inPoint) {
    row.in = clip.inPoint;
    row.out = clip.outPoint;
  }
  // Property-grammar fields captured by edit decisions ride on the transform bag. The committed
  // globalTransform (what "Apply to clip" writes: speed / volume / fades / kenBurns / reframe /
  // grade) is the composition-wide fallback; a clip's own transform overrides it. Without this
  // merge, committed inspector edits render in the live preview but never reach the export EDL.
  const extra = { ...(globalTransform ?? {}), ...(clip.transform as Record<string, unknown>) } as Record<string, unknown>;
  // Generic pass-through (enum-dissolution): EVERY transform field reaches the EDL clip row
  // automatically as its snake_case name. The maps below are the ONLY exceptions, and both are
  // closed by nature (presentation-only keys the render must never see, and grandfathered
  // irregular names whose EDL contract predates the camel→snake convention). A NEW DATA field
  // needs ZERO edits here: name it camelCase on ClipTransform and it lands snake_case on the EDL.
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || UI_ONLY_TRANSFORM_KEYS.has(key)) continue;
    const dst = IRREGULAR_EDL_NAMES[key] ?? camelToSnake(key);
    if (row[dst] === undefined) row[dst] = value;
  }
  return row;
}

/** Build a kind:'split' spine segment from a clip whose transform carries `splitScreen`.
 *  Cell 0 is the clip's OWN resolved source (trimmed to the clip's in/out); each `with` ref is
 *  resolved through the same SourceResolver and tiled alongside. Returns null when fewer than 2
 *  cells resolve (buildSplitLayout needs >= 2 inputs), so the caller falls back to a normal clip
 *  row rather than emitting a broken 1-source split. Zero new render code: buildSplit already
 *  composites `sources`/`layout`/`weights`/`duration` (L069). */
/** Copy a splitScreen per-cell framing entry (crop/flip/start_at) onto a resolved split source spec.
 *  buildSplit reads these natively per source, so no new render code (L069). `start_at` sets the
 *  cell's source in-point (overriding any trim-derived in/out) so the clips can be nudged into
 *  stroke-phase sync; `out` becomes start_at + the split duration when known. */
function applyCellFraming(
  cell: NonNullable<EdlClipRow['sources']>[number],
  framing: NonNullable<NonNullable<ClipTransform['splitScreen']>['cells']>[number] | undefined,
  duration: number | undefined,
): void {
  if (!framing) return;
  if (framing.crop) cell.crop = framing.crop;
  if (framing.flip) cell.flip = framing.flip;
  if (framing.start_at !== undefined && framing.start_at >= 0) {
    cell.in = framing.start_at;
    if (duration !== undefined) cell.out = +(framing.start_at + duration).toFixed(3);
    else delete cell.out;
  }
}

function splitRow(
  clip: MaterializedClip,
  primarySource: string,
  ss: NonNullable<ClipTransform['splitScreen']>,
  trackId: string,
  resolveSource: SourceResolver,
  unresolved: Set<string>,
): EdlClipRow | null {
  const trimmed = clip.outPoint > clip.inPoint;
  const duration = trimmed ? +(clip.outPoint - clip.inPoint).toFixed(3) : undefined;
  const cells: NonNullable<EdlClipRow['sources']> = [];
  const cell0: NonNullable<EdlClipRow['sources']>[number] = { source: primarySource };
  if (trimmed) { cell0.in = clip.inPoint; cell0.out = clip.outPoint; }
  if (ss.labels?.[0]) cell0.label = { text: ss.labels[0] };
  applyCellFraming(cell0, ss.cells?.[0], duration);
  cells.push(cell0);
  ss.with.forEach((ref, i) => {
    const resolved = resolveSource(ref);
    if (!resolved) { unresolved.add(ref); return; }
    const cell: NonNullable<EdlClipRow['sources']>[number] = { source: resolved };
    const label = ss.labels?.[i + 1];
    if (label) cell.label = { text: label };
    applyCellFraming(cell, ss.cells?.[i + 1], duration);
    cells.push(cell);
  });
  if (cells.length < 2) return null;
  const seg: EdlClipRow = { id: clip.clipId, kind: 'split', sources: cells, track_id: trackId };
  if (ss.layout) seg.layout = ss.layout;
  if (ss.weights && ss.weights.length) seg.weights = ss.weights;
  if (duration !== undefined) seg.duration = duration;
  return seg;
}

/** Inspector/layout-only keys (frame styling, percent-slider raw values) that describe the
 *  PREVIEW presentation, not the render contract; they must not leak into the EDL (L114).
 *  `transition` is consumed into the positional edl.spine.transitions array (never a clip-row
 *  field), so it is excluded here rather than passed through. */
const UI_ONLY_TRANSFORM_KEYS = new Set([
  'aspectRatio', 'framePreset', 'position', 'width', 'height', 'padding', 'inset', 'corners',
  'stroke', 'shadow', 'keepAspectRatio', 'speed_pct', 'volume_pct', 'transition',
  // splitScreen is consumed into a kind:'split' segment (splitRow), never a clip-row EDL field.
  'splitScreen',
]);

/** Grandfathered EDL names that differ from mechanical camel→snake (contract::edl predates it).
 *  `caption` is the clip's burned text, which the compositor reads as the clip `label`. */
const IRREGULAR_EDL_NAMES: Record<string, string> = {
  fadeIn: 'fade_in_s', fadeOut: 'fade_out_s', muted: 'silent_audio', caption: 'label',
};

function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Materialize the export EDL. Clips are emitted in lane order, each lane's
 * clips ordered by laneStart; clips whose source cannot be resolved are
 * REPORTED (fail-closed at the caller), never silently dropped.
 */
export function materializeExportEdl(
  composition: MaterializedComposition,
  resolveSource: SourceResolver,
  encode?: Record<string, unknown>,
): { edl: MaterializedEdl; unresolvedSourceIds: string[] } {
  const segments: EdlClipRow[] = [];
  const tracks: { id: string }[] = [];
  const unresolved = new Set<string>();
  let musicBed: MusicBed | undefined;
  const narrations: NarrationClip[] = [];
  const adjustments: Array<Record<string, unknown>> = [];
  const spineTransitions: Array<Record<string, unknown> | null> = [];

  for (const lane of composition.lanes) {
    const ordered = [...lane.clips]
      .filter((c) => c.outPoint > c.inPoint
        || (c.transform as Record<string, unknown>).audioBed === true
        || (c.transform as Record<string, unknown>).narration === true)
      .sort((a, b) => a.laneStart - b.laneStart);
    if (ordered.length === 0) continue;
    let laneHasSpineClip = false;
    for (const clip of ordered) {
      const ct = clip.transform as Record<string, unknown>;
      // A TTS-NARRATION clip has no pre-made artifact (the render generates it from ttsText), so it
      // is routed BEFORE the source-resolution guard, which would otherwise drop it as unresolved.
      if (ct.narration === true && typeof ct.ttsText === 'string' && (ct.ttsText as string).trim()) {
        narrations.push(narrationFromClip(clip, ''));
        continue;
      }
      // #108 An ADJUSTMENT clip contributes no pixels and needs no source: its opaque filter
      // DATA (grade) applies to the composited program over the clip's own time window. Routed
      // BEFORE source resolution (like TTS narration) since there may be nothing to resolve.
      if (ct.adjustment === true) {
        const filter = typeof ct.grade === 'string' && (ct.grade as string).trim() ? (ct.grade as string).trim() : '';
        if (filter) {
          const start = clip.laneStart;
          const entry: Record<string, unknown> = { start, end: start + (clip.outPoint - clip.inPoint), filter };
          // #109 A `strength` keyframe envelope on the adjustment clip animates the layer's
          // intensity. Clip keyframes are CLIP-LOCAL seconds; the render blends in GLOBAL
          // program time, so offset each point by the clip's lane position here (the one
          // place both domains are known).
          const kf = (ct.keyframes as Record<string, Array<{ t: number; value: number; interp?: string }>> | undefined)?.strength;
          if (Array.isArray(kf) && kf.length > 0) {
            entry.strength_keyframes = kf.map((p) => ({ ...p, t: start + p.t }));
          }
          adjustments.push(entry);
        }
        continue;
      }
      const source = resolveSource(clip.sourceId);
      if (!source) {
        unresolved.add(clip.sourceId);
        continue;
      }
      // A MUSIC-BED clip (explicit DATA flag) never becomes a spine segment; it mixes
      // under the video as edl.audio_graph.music_bed. First bed wins (a single mix bus).
      if ((clip.transform as Record<string, unknown>).audioBed === true) {
        if (!musicBed) musicBed = musicBedFromClip(clip, source);
        continue;
      }
      // A NARRATION clip (explicit DATA flag) never becomes a spine segment either; it mixes over
      // the video as an edl.audio_graph.narration entry placed at its laneStart. Any number allowed.
      if ((clip.transform as Record<string, unknown>).narration === true) {
        narrations.push(narrationFromClip(clip, source));
        continue;
      }
      if (!laneHasSpineClip) { tracks.push({ id: lane.laneId }); laneHasSpineClip = true; }
      // Split-screen / grid: when this clip carries `splitScreen.with`, emit a kind:'split' segment
      // (this clip's source + the extra sources tiled) instead of a normal clip row. Falls back to a
      // normal clip row if fewer than 2 cells resolve (splitRow returns null).
      const ssTransform = ct.splitScreen as ClipTransform['splitScreen'] | undefined;
      const splitSeg = ssTransform && Array.isArray(ssTransform.with) && ssTransform.with.length > 0
        ? splitRow(clip, source, ssTransform, lane.laneId, resolveSource, unresolved)
        : null;
      segments.push(splitSeg ?? clipRow(clip, source, lane.laneId, composition.globalTransform as Record<string, unknown> | undefined));
      // #41 A clip's `transition` is its IN-transition (blend FROM the previous clip). Captured in
      // spine order so it can be aggregated into the render's positional edl.spine.transitions.
      spineTransitions.push((ct.transition ?? null) as Record<string, unknown> | null);
    }
  }

  const edl: MaterializedEdl = {
    base: { kind: 'color', color: 'black' },
    tracks,
    spine: { segments },
  };
  // #41 Transition aggregation: the compositor reads a POSITIONAL edl.spine.transitions where
  // entry i is the crossfade between spine segment i and i+1. A clip's transition is its IN-blend,
  // so segment (i+1)'s transition owns gap i; segment 0 has no previous clip. Emit only if any
  // gap has a real {renderer,type,duration} (an empty {} means the inspector cleared it).
  if (segments.length > 1) {
    const gaps = segments.slice(1).map((_, i) => {
      const tr = spineTransitions[i + 1];
      return tr && typeof (tr as { type?: unknown }).type === 'string' && (tr as { duration?: unknown }).duration ? tr : null;
    });
    if (gaps.some(Boolean)) (edl.spine as Record<string, unknown>).transitions = gaps;
  }
  if (musicBed || narrations.length > 0) {
    edl.audio_graph = {};
    if (musicBed) edl.audio_graph.music_bed = musicBed;
    if (narrations.length > 0) edl.audio_graph.narration = narrations;
  }
  // #108 Adjustment windows: time-scoped opaque filter chains over the composited program.
  if (adjustments.length > 0) (edl as Record<string, unknown>).adjustment_layers = adjustments;
  if (encode) edl.encode = encode;
  // #90 Composition-wide caption translation: a `{to, producer, glossary?}` default the render
  // applies to EVERY burned text (captions / titles / cards) unless a text overlay overrides it.
  const ct = composition.captionTranslate as { to?: string; producer?: string; glossary?: Record<string, string> } | undefined;
  if (ct && ct.to && ct.producer) edl.caption_translate = { to: ct.to, producer: ct.producer, glossary: ct.glossary };
  // #93 Master-bus loudness normalization target for the finished program.
  if (typeof composition.masterLoudnorm === 'number') edl.master_loudnorm = composition.masterLoudnorm;
  // Timeline overlays (titles / lower-thirds / shapes / arrow-callouts / stickers) split by kind:
  // 'text' rows drive video-compose's drawtext text_overlays; 'image' rows drive the generic
  // image_overlays composite (a shape IS a DATA image, so one path covers every annotation).
  const overlays = Array.isArray(composition.overlays) ? composition.overlays : [];
  const textOverlays = overlays.filter((o) => o.overlay_kind === 'text' && typeof o.text === 'string' && o.text.trim());
  const imageOverlays = overlays.filter((o) => o.overlay_kind === 'image' && (typeof o.image_ref === 'string' || typeof o.image_path === 'string'));
  if (textOverlays.length) edl.text_overlays = textOverlays.map((o) => ({ text: o.text, x: o.x, y: o.y, size: o.size, color: o.color, box: o.box, box_color: o.box_color, start: o.start, end: o.end, fade_in: o.fade_in, fade_out: o.fade_out, translate_to: o.translate_to, translate_producer: o.translate_producer, translate_glossary: o.translate_glossary, track: o.track, keyframes: expandTextMotion(o) }));
  if (imageOverlays.length) edl.image_overlays = imageOverlays.map((o) => ({ image_ref: o.image_ref, image_path: o.image_path, x: o.x, y: o.y, width: o.width, scale: o.scale, opacity: o.opacity, rotate: o.rotate, start: o.start, end: o.end, fade_in: o.fade_in, fade_out: o.fade_out, track: o.track }));
  // 'video' rows drive the video_overlays composite: a picture-in-picture / green-screen clip
  // laid over the spine, keyed transparent by chroma_key so the spine shows through (#78/#79).
  const videoOverlays = overlays.filter((o) => o.overlay_kind === 'video' && (typeof o.source_ref === 'string' || typeof o.source_path === 'string'));
  if (videoOverlays.length) edl.video_overlays = videoOverlays.map((o) => ({ source_ref: o.source_ref, source_path: o.source_path, chroma_key: o.chroma_key, matte: o.matte, matte_ref: o.matte_ref, matte_path: o.matte_path, blend: o.blend, x: o.x, y: o.y, width: o.width, scale: o.scale, opacity: o.opacity, start: o.start, end: o.end, fade_in: o.fade_in, fade_out: o.fade_out }));
  // 'region' rows drive the region_overlays censor: a rectangle of the FRAME ITSELF blurred or
  // pixelized over a window (privacy blur of a face/plate/screen). No source, just a rect + mode.
  const regionOverlays = overlays.filter((o) => o.overlay_kind === 'region');
  if (regionOverlays.length) edl.region_overlays = regionOverlays.map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height, mode: o.region_mode, strength: o.region_strength, start: o.start, end: o.end }));
  // #96 audio-reactive visualizer overlays: a waveform/spectrum/bars video generated from the program
  // audio, composited over the frame. viz selects the producer; x/y/width/height are normalized 0..1.
  const audioVizOverlays = overlays.filter((o) => o.overlay_kind === 'audioviz' && typeof o.viz === 'string');
  if (audioVizOverlays.length) edl.audio_viz_overlays = audioVizOverlays.map((o) => ({ viz: o.viz, x: o.x, y: o.y, width: o.width, height: o.height, color: o.color, opacity: o.opacity }));
  return { edl, unresolvedSourceIds: [...unresolved] };
}
