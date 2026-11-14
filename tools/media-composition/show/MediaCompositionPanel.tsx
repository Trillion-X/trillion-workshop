import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  AudioLines,
  Captions,
  MousePointer2,
  Scissors,
  Sparkles,
  Type,
  Wand2,
} from 'lucide-react';

import {
  chooseContentMediaFiles,
  CONTENT_MEDIA_AUDIO_EXTENSIONS,
  CONTENT_MEDIA_IMAGE_EXTENSIONS,
  CONTENT_MEDIA_VIDEO_EXTENSIONS,
  stageContentMediaFile,
  type ContentMediaSourceRef,
} from '../../record-voice-and-meetings/do-work/content-media-work-loop';
import {
  buildMediaCompositionEditDecisionRecord,
  buildMediaCompositionMarkerRecord,
  buildMediaCompositionSelectionRecord,
  writeMediaCompositionRecord,
} from '../do-work/write-media-composition-record';
import { authorEditDecision } from '../do-work/build-edit-decisions';
import {
  authorDecisionsFromRecords,
  deriveWordAndGapSpans,
} from '../do-work/author-decisions-from-records';
import { decodeAudioPeaks } from '../do-work/decode-audio-peaks';
import { detectBeatsFromChannel } from '../do-work/detect-beats-browser';
import { beatSyncSplitTimes } from '../read-data/beat-sync';
import { detectScenesFromVideo, splitDecisionsFromCuts } from '../do-work/detect-scenes-browser';
import { scoreHighlightWindows, highlightDecisions } from '../read-data/highlight-scorer';
import { narrationAddSourceDecision } from '../read-data/narration-source';
import { trackSubjectFromVideo } from '../do-work/detect-track-browser';
import { buildMediaCompositionEditDecisionRecord } from '../do-work/write-media-composition-record';
import {
  composeTimeline,
  LOOK_CATALOG,
  DENOISE_CATALOG,
  AUDIO_FX_CATALOG,
  SPEED_RAMP_CATALOG,
  CHROMA_CATALOG,
  PIP_CORNER_CATALOG,
  buildPunchInZoomKeyframes,
  type ClipTransform,
  type MaterializedClip,
  type MaterializedComposition,
} from '../read-data/compose-timeline';
import {
  DEFAULT_EDIT_CAPABILITIES,
  resolveOpParams,
  type EditParamSource,
} from '../read-data/edit-capabilities';
import { readTranscriptWords } from '../read-data/read-transcript-words';
import { groupWordsIntoCaptionLines } from '../read-data/caption-lines';
import { detectCleanupSpans, cleanupSpansInAuthorOrder } from '../read-data/auto-cleanup';
import {
  mediaWorkspaceSourceIdForRef,
  readMediaWorkspace,
  type MediaWorkspacePanel,
  type MediaWorkspaceSource,
} from '../read-data/read-media-workspace';
import {
  acceptsMediaEditorLayoutState,
  MEDIA_EDITOR_LAYOUT_STATE,
  MEDIA_EDITOR_LAYOUT_STATE_ADDRESS_LABEL,
  MEDIA_EDITOR_LAYOUT_STATE_INPUT,
} from '../read-data/read-media-editor-layout-state';
import {
  addOptimisticMediaWorkspaceSource,
  useOptimisticMediaWorkspace,
} from './media-workspace-optimistic-store';
import {
  requestSeek as sessionRequestSeek,
  setCurrentTime as sessionSetCurrentTime,
  setPlaying as sessionSetPlaying,
  setSelectedSourceId as sessionSetSelectedSourceId,
  useEditorSession,
} from './media-editor-session-store';
import {
  addOptimisticLanes,
  useOptimisticComposition,
} from './media-lanes-optimistic-store';
import {
  MediaDetailsPanel,
  type MediaManualControlValues,
} from './components/MediaDetailsPanel';
import { MediaPreviewStage } from './components/MediaPreviewStage';
import { MediaSourceRail } from './components/MediaSourceRail';
import { MediaToolRail, type MediaTool } from './components/MediaToolRail';
import { EditTimeline } from './EditTimeline';
import { Button } from '../../ui/show/button';
import { Card } from '../../ui/show/card';
import { Container } from '../../ui/show/container';
import { MediaFrame } from '../../ui/show/media-frame';
import { FileWorkAction } from '../../ui/show/file-work-action';
import {
  readPlaceableSurfaceSubject,
  type PlaceableSurfaceSubjectRef,
} from '../../ui/show/placeable-surface-intent/placeable-surface-subject';
import { OpenSurfaceAction } from '../../ui/show/open-surface-action';
import { EmbeddedScreenArrangement } from '../../screen-arrangement/show/EmbeddedScreenArrangement';
import { ScrollableSurface } from '../../ui/show/scrollable-surface';
import { Text } from '../../ui/show/text';

export type MediaCompositionPanelProps = {
  now?: () => Date;
  surfaceInput?: Record<string, unknown>;
};

type LocalPreview = {
  url: string;
  mediaType: string;
  label: string;
};

type MediaSurfacePart =
  | 'workspace'
  | 'choose-media'
  | 'preview-media'
  | 'edit-timeline'
  | 'change-media'
  | 'choose-tool';

const MEDIA_SURFACE_PARTS = new Set<MediaSurfacePart>([
  'workspace',
  'choose-media',
  'preview-media',
  'edit-timeline',
  'change-media',
  'choose-tool',
]);

const CONTENT_PRODUCTION_SURFACE = {
  id: 'content-production.panel',
  title: 'Make content',
  materialTarget: 'content-production',
  packageEntry: {
    packageName: 'content-production',
    entryName: 'content-production',
  },
};

const defaultNow = () => new Date();

const ASPECT_OPTIONS = [
  { id: '16:9', label: '16:9' },
  { id: '4:3', label: '4:3' },
  { id: '1:1', label: '1:1' },
  { id: '3:4', label: '3:4' },
  { id: '9:16', label: '9:16' },
];


const DEFAULT_MANUAL_CONTROLS: MediaManualControlValues = {
  width: 100,
  height: 100,
  padding: 0,
  inset: 0,
  corners: 12,
  stroke: 0,
  shadow: 24,
  // Temporal/audio controls (percent + seconds), converted to their ClipTransform
  // multiplier fields in liveTransform. speed_pct 100 = 1x (identity), 50 = slow-mo.
  speed_pct: 100,
  volume_pct: 100,
  fade_in_s: 0,
  fade_out_s: 0,
  // #120 Manual crop / zoom rect as percent sliders; assembled into t.cropRect (0..1 fractions).
  // Full frame (x0 y0 w100 h100) is identity and drops out.
  crop_x: 0,
  crop_y: 0,
  crop_w: 100,
  crop_h: 100,
  // #121 Manual color adjust (percent sliders): brightness -100..100 -> -1..1 additive; contrast /
  // saturation / gamma 100 = identity. Assembled into t.colorAdjust; identity values drop out.
  adj_brightness: 0,
  adj_contrast: 100,
  adj_saturation: 100,
  adj_gamma: 100,
  // #122 Self-glow / bloom strength (percent -> 0..1). Only applied when the Glow toggle is on.
  glow_strength: 50,
  // #123 Sharpen / clarity amount (percent -> 0..1). 0 = off.
  sharpen: 0,
  // #124 Border / frame thickness (px). 0 = no border.
  border_width: 0,
  // #125 Spotlight / positioned radial focus: center (percent) + strength (percent). 0 strength = off.
  spotlight_x: 50,
  spotlight_y: 50,
  spotlight_strength: 0,
  // #126 Framed-clip scale (percent). 100 = no frame; below 100 shrinks the clip onto a background.
  frame_scale: 100,
};

const MEDIA_TOOLS: MediaTool[] = [
  { id: 'select', label: 'Select', detail: 'Choose and move.', icon: MousePointer2 },
  { id: 'cut', label: 'Cut', detail: 'Split and trim.', icon: Scissors },
  { id: 'text', label: 'Text', detail: 'Captions and labels.', icon: Type },
  { id: 'sound', label: 'Sound', detail: 'Voice and audio.', icon: AudioLines },
  { id: 'captions', label: 'Captions', detail: 'Transcript timing.', icon: Captions },
  { id: 'clean', label: 'Clean', detail: 'Improve source.', icon: Wand2 },
  { id: 'assist', label: 'Assist', detail: 'Review suggestions.', icon: Sparkles },
];

function sourceFamily(source: MediaWorkspaceSource): string {
  return source.media_type.split('/')[0]?.toLowerCase() || 'media';
}

/** Human media-kind word — raw MIME strings never reach the screen. */
function sourceKindLabel(source: MediaWorkspaceSource): string {
  const family = sourceFamily(source);
  if (family === 'audio') return 'Audio';
  if (family === 'video') return 'Video';
  if (family === 'image') return 'Image';
  return 'Media';
}

function sourceDetail(source: MediaWorkspaceSource): string {
  const byteLength = source.artifact_ref?.byte_length;
  const size = typeof byteLength === 'number' && byteLength > 0
    ? ` · ${byteLength < 1024 * 1024 ? `${Math.round(byteLength / 102.4) / 10} KB` : `${Math.round(byteLength / 1024 / 102.4) / 10} MB`}`
    : '';
  return `${sourceKindLabel(source)}${size}`;
}

function panelSummary(panel: MediaWorkspacePanel): string {
  if (panel.count === 1) return '1 item';
  return `${panel.count} items`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSurfacePart(surfaceInput: Record<string, unknown> | undefined): MediaSurfacePart {
  const raw = surfaceInput?.media_surface ?? surfaceInput?.mediaSurface ?? surfaceInput?.part;
  if (typeof raw === 'string' && MEDIA_SURFACE_PARTS.has(raw as MediaSurfacePart)) return raw as MediaSurfacePart;
  return readSubjectRef(surfaceInput) ? 'choose-media' : 'workspace';
}

function readSubjectRef(surfaceInput: Record<string, unknown> | undefined): PlaceableSurfaceSubjectRef | null {
  const subjectRef = surfaceInput?.subjectRef;
  if (!isRecord(subjectRef)) return null;
  return typeof subjectRef.address === 'string' && subjectRef.address.length > 0
    ? { address: subjectRef.address }
    : null;
}

function fileFromSubjectHandle(handle: unknown, fallbackName: string, fallbackType: string): File | null {
  if (handle instanceof File) return handle;
  if (!(handle instanceof Blob)) return null;
  return new File([handle], fallbackName || 'media', {
    type: fallbackType || handle.type || 'application/octet-stream',
  });
}

function isByteArray(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array');
}

function useBytesPreview(source?: MediaWorkspaceSource): LocalPreview | undefined {
  const addressLabel = source?.artifact_ref?.stored_bytes_address_label ?? '__missing-media-source-bytes__';
  const bytes = useBitfieldData<Uint8Array>({
    input: 'source-bytes-by-address-label',
    params: { addressLabel },
  });
  const [url, setUrl] = React.useState('');

  React.useLayoutEffect(() => {
    if (!isByteArray(bytes) || bytes.byteLength === 0 || !source) {
      setUrl('');
      return undefined;
    }

    const nextUrl = URL.createObjectURL(new Blob([bytes.slice()], { type: source.media_type }));
    setUrl(nextUrl);
    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [bytes, source]);

  return url && source
    ? {
      url,
      mediaType: source.media_type,
      label: source.label,
    }
    : undefined;
}

function Preview({
  preview,
  selectedSource,
  videoRef,
}: {
  preview?: LocalPreview;
  selectedSource?: MediaWorkspaceSource;
  videoRef?: React.RefObject<HTMLVideoElement>;
}) {
  if (preview?.url) {
    return (
      <MediaFrame
        url={preview.url}
        mediaType={preview.mediaType}
        label={preview.label}
        videoRef={videoRef}
      />
    );
  }

  return (
    <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center">
      <Text variant="heading-lg">{selectedSource ? selectedSource.label : 'Add media to preview it.'}</Text>
      <Text variant="body" color="faint">
        {selectedSource ? 'Open that file here to preview frames and sound.' : 'Drop a video, photo, or audio file.'}
      </Text>
    </Container>
  );
}

/**
 * The video clip that the timeline is showing at composition time `t` (the
 * "program" clip). Scans every video lane and returns the clip covering `t` from
 * the TOP-MOST lane that has one, so a higher track composites over a lower one.
 * Returns undefined when no video clip covers `t` (a gap, or an empty timeline).
 */
function programVideoClipAt(composition: MaterializedComposition, t: number): MaterializedClip | undefined {
  let found: MaterializedClip | undefined;
  for (const lane of composition.lanes) {
    if (!lane.role.startsWith('video')) continue;
    for (const clip of lane.clips) {
      if (t >= clip.laneStart && t < clip.laneEnd) found = clip;
    }
  }
  return found;
}

/** The first video clip on the timeline that plays source `sourceId`, if any. */
function firstClipForSource(composition: MaterializedComposition, sourceId: string): MaterializedClip | undefined {
  let best: MaterializedClip | undefined;
  for (const lane of composition.lanes) {
    if (!lane.role.startsWith('video')) continue;
    for (const clip of lane.clips) {
      if (clip.sourceId === sourceId && (!best || clip.laneStart < best.laneStart)) best = clip;
    }
  }
  return best;
}

export function MediaCompositionPanel({ now = defaultNow, surfaceInput }: MediaCompositionPanelProps) {
  const evidenceRows = useBitfieldData('media-composition:contentMediaEvidence');
  const evidenceWorkspace = React.useMemo(() => readMediaWorkspace(evidenceRows), [evidenceRows]);
  const { workspace, previews } = useOptimisticMediaWorkspace(evidenceWorkspace);
  const surfacePart = React.useMemo(() => readSurfacePart(surfaceInput), [surfaceInput]);
  const subjectRef = React.useMemo(() => readSubjectRef(surfaceInput), [surfaceInput]);
  const admittedSubject = React.useMemo(
    () => subjectRef ? readPlaceableSurfaceSubject(subjectRef) : null,
    [subjectRef],
  );
  const admittedSubjectAddresses = React.useRef(new Set<string>());
  // Selection lives in the shared cross-surface store so a click in Choose media
  // updates the Preview + inspector panes (which are separate mounts).
  const selectedSourceId = useEditorSession((s) => s.selectedSourceId);
  const setSelectedSourceId = sessionSetSelectedSourceId;
  const [selectedPanelId, setSelectedPanelId] = React.useState('');
  const [isWriting, setIsWriting] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [selectedToolId, setSelectedToolId] = React.useState(MEDIA_TOOLS[0]?.id ?? 'select');
  const [aspectRatio, setAspectRatio] = React.useState(ASPECT_OPTIONS[0]?.id ?? '16:9');
  const [framePreset, setFramePreset] = React.useState('fit');
  const [position, setPosition] = React.useState('2:2');
  const [keepAspectRatio, setKeepAspectRatio] = React.useState(true);
  const [duckMusic, setDuckMusic] = React.useState(false);
  // #202 Echo / reverb: add room/space to the clip audio (delayed copies). The toggle seeds a default
  // amount; the AI worker authors a precise amount/delayMs as DATA (the same aecho primitive, tuned).
  const [echo, setEcho] = React.useState(false);
  const [kenBurns, setKenBurns] = React.useState(false);
  const [reverse, setReverse] = React.useState(false);
  const [freezeTail, setFreezeTail] = React.useState(false);
  const [greenScreen, setGreenScreen] = React.useState(false);
  const [stabilize, setStabilize] = React.useState(false);
  const [motionBlur, setMotionBlur] = React.useState(false);
  // #156 Trails / echo: persistence light-trails (lagfun). The toggle seeds a default decay; the AI
  // worker can author a precise decay as DATA.
  const [trails, setTrails] = React.useState(false);
  // #157 Wobble / wave-warp: sinusoidal displacement (underwater/dream). The toggle seeds a default
  // amplitude/frequency/speed; the AI worker can author precise values as DATA.
  const [wobble, setWobble] = React.useState(false);
  // #158 Warmth ramp: animated white-balance shift (sunset/day-to-night). The toggle seeds a default
  // warm->cool ramp over the clip; the AI worker can author precise from/to/start/duration as DATA.
  const [warmthRamp, setWarmthRamp] = React.useState(false);
  // #159 Strobe / stop-motion: hold frames so motion stutters. The toggle seeds a default rate; the AI
  // worker can author a precise rate as DATA.
  const [strobe, setStrobe] = React.useState(false);
  // #160 Scanlines (CRT / retro): darken periodic rows. The toggle seeds a default depth/period; the AI
  // worker can author precise depth/period/roll as DATA.
  const [scanlines, setScanlines] = React.useState(false);
  // #161 Lens fringe (radial chromatic aberration): color split growing toward the edges. The toggle seeds
  // a default strength; the AI worker can author a precise strength as DATA.
  const [lensFringe, setLensFringe] = React.useState(false);
  // #162 Posterize: quantize colors to flat bands (poster / comic). The toggle seeds a default level count;
  // the AI worker can author a precise level count as DATA.
  const [posterize, setPosterize] = React.useState(false);
  // #163 Halftone: comic / newspaper dot-screen. The toggle seeds a default dot size; the AI worker can
  // author a precise size as DATA.
  const [halftone, setHalftone] = React.useState(false);
  // #172 Gradient map: map luma to a multi-stop color ramp (teal->amber tonal grade). The toggle seeds a
  // 3-stop default; the AI worker can author precise stops (at + color) as DATA.
  const [gradientMap, setGradientMap] = React.useState(false);
  // #173 Solarize: reflect the highlights above a threshold (darkroom / psychedelic look). The toggle seeds
  // a 0.5 threshold; the AI worker can author a precise threshold as DATA.
  const [solarize, setSolarize] = React.useState(false);
  const [pixelate, setPixelate] = React.useState(false);
  const [grain, setGrain] = React.useState(false);
  const [emboss, setEmboss] = React.useState(false);
  const [defocus, setDefocus] = React.useState(false);
  const [fisheye, setFisheye] = React.useState(false);
  const [warmth, setWarmth] = React.useState(false);
  const [colorSplash, setColorSplash] = React.useState(false);
  const [perspective, setPerspective] = React.useState(false);
  const [smooth, setSmooth] = React.useState(false);
  const [directionalBlur, setDirectionalBlur] = React.useState(false);
  const [binarize, setBinarize] = React.useState(false);
  const [swirl, setSwirl] = React.useState(false);
  const [mirror, setMirror] = React.useState(false);
  const [tile, setTile] = React.useState(false);
  const [invert, setInvert] = React.useState(false);
  const [vibrance, setVibrance] = React.useState(false);
  const [channelSwap, setChannelSwap] = React.useState(false);
  const [exposure, setExposure] = React.useState(false);
  const [shear, setShear] = React.useState(false);
  const [histeq, setHisteq] = React.useState(false);
  const [morphology, setMorphology] = React.useState(false);
  const [colorize, setColorize] = React.useState(false);
  const [normalize, setNormalize] = React.useState(false);
  const [chromaBleed, setChromaBleed] = React.useState(false);
  const [rgbSplit, setRgbSplit] = React.useState(false);
  const [monoMix, setMonoMix] = React.useState(false);
  const [fadedFilm, setFadedFilm] = React.useState(false);
  // #164 Tilt-shift: keep a horizontal band sharp, blur the rest. The toggle seeds a centered focus band;
  // the AI worker can author precise center/height/feather/blur as DATA.
  const [tiltShift, setTiltShift] = React.useState(false);
  // #165 Sketch: render the clip as a cartoon-shaded / line-art drawing. The toggle seeds the cartoon look;
  // the AI worker can author mode ('canny'/'wires' for line-art) and strength as DATA.
  const [sketch, setSketch] = React.useState(false);
  // #167 Zoom / radial blur (speed-zoom): the toggle seeds a centered medium spread; the AI worker can
  // author precise strength and center (cx/cy) as DATA.
  const [zoomBlur, setZoomBlur] = React.useState(false);
  // #168 Light leak (procedural, no asset): the toggle seeds a warm top-right leak; the AI worker can author
  // precise color, position (x/y), radius, and strength as DATA.
  const [lightLeak, setLightLeak] = React.useState(false);
  // #169 Film damage (old-film scratches + dust): the toggle seeds a few scratches and some dust; the AI
  // worker can author precise scratch/dust counts and strength as DATA.
  const [filmDamage, setFilmDamage] = React.useState(false);
  // #171 Hue rotation: the toggle seeds a 120deg color-wheel spin; the AI worker can author exact
  // degrees, a saturation multiplier, and a cycleRate (deg/sec) for an animated rainbow cycle as DATA.
  const [hueShift, setHueShift] = React.useState(false);
  // #146 Camera shake (null = off): amplitude (fraction of frame), frequency (Hz), decay (>0 = single impact).
  const [shake, setShake] = React.useState<{ amplitude: number; frequency?: number; decay?: number } | null>(null);
  const [glow, setGlow] = React.useState(false);
  // #129 Drop shadow / floating card (on/off; the render fills Screen Studio defaults).
  const [dropShadow, setDropShadow] = React.useState(false);
  // #124 Border / frame color (width comes from the border_width manual slider; '' = off).
  const [borderColor, setBorderColor] = React.useState('white');
  // #126 Framed-clip background (scale comes from the frame_scale manual slider; 100 = no frame).
  const [frameBackground, setFrameBackground] = React.useState('black');
  // #127 Duotone gradient-map pair (null = off), chosen from the preset buttons.
  const [duotone, setDuotone] = React.useState<{ shadow: string; highlight: string } | null>(null);
  // #128 Rounded-corners background (radius comes from the corner_radius manual slider; 0 = no rounding).
  const [cornerBackground, setCornerBackground] = React.useState('black');
  // #130 Censor: the opaque ffmpeg filter applied to a centered region ('' = off). Precise region
  // placement is DATA-authorable via set-transform; the preset uses a centered default rectangle.
  const [censorFilter, setCensorFilter] = React.useState('');
  // #137 Multiple censors: a stack of {x,y,w,h,filter} regions (the L069 list generalization of #130).
  // Each "Add censor" appends a region at a staggered default rect so they don't overlap; "Clear" empties it.
  const [censorRegions, setCensorRegions] = React.useState<Array<{ x: number; y: number; w: number; h: number; filter: string }>>([]);
  // #138/#139 Censor motion: '' static, 'pan' = 2-point slide (#138), 'bounce' / 'orbit' = keyframe paths
  // (#139). The AI worker / DATA can author precise motion/path; these presets are the common shapes.
  const [censorMotion, setCensorMotion] = React.useState<'' | 'pan' | 'bounce' | 'orbit'>('');
  // #140 Ease curve for the censor motion/path ('' = linear constant speed).
  const [censorEase, setCensorEase] = React.useState<'' | 'smooth' | 'in' | 'out'>('');
  // #141 Censor opacity fade in/out (ramp the censor strength at the clip's start / end).
  const [censorFadeIn, setCensorFadeIn] = React.useState(false);
  const [censorFadeOut, setCensorFadeOut] = React.useState(false);
  // #142 Spotlight: apply the effect to the surroundings instead of the region (the region pops).
  const [censorSpotlight, setCensorSpotlight] = React.useState(false);
  // #154 Spotlight follow: when on (and the #125 spotlight strength slider is > 0) the focus SWEEPS
  // across the clip instead of sitting still. The toggle seeds a default left-to-right sweep; the AI
  // worker authors a precise cx/cy track as DATA (the same primitive, more keyframes).
  const [spotlightFollow, setSpotlightFollow] = React.useState(false);
  // #201 Spotlight breathe: when on (and the #125 spotlight strength slider is > 0) the focus THROBS,
  // its darkening depth breathing over time instead of holding steady. The toggle seeds a default pulse;
  // the AI worker authors a precise cycles/sec rate as DATA (the same spotlight primitive, animated depth).
  const [spotlightPulse, setSpotlightPulse] = React.useState(false);
  // #143 Progress bar overlay (null = off); the AI worker / DATA can author precise height/color/edge.
  const [progressBar, setProgressBar] = React.useState<{ height: number; color: string; edge: 'top' | 'bottom'; markers?: number[]; markerColor?: string } | null>(null);
  // #144 Live timer overlay (null = off).
  const [timer, setTimer] = React.useState<{ mode: 'elapsed' | 'countdown'; corner: 'tl' | 'tr' | 'bl' | 'br'; color: string } | null>(null);
  // #147 Countdown ring (null = off): a circular arc HUD that sweeps over the clip. mode fill grows / deplete shrinks.
  const [countdownRing, setCountdownRing] = React.useState<{ radius?: number; thickness?: number; color?: string; x?: number; y?: number; mode?: 'fill' | 'deplete' } | null>(null);
  // #148 Marker-synced flashes (beat pulses, null = off). The real list comes from a beat-detector producer;
  // the manual control seeds a fixed 0.5s cadence at a chosen strength as a starter.
  const [pulses, setPulses] = React.useState<Array<{ at: number; strength?: number; duration?: number; kind?: 'flash' | 'punch' | 'shake' | 'glitch' | 'tint'; color?: string }> | null>(null);
  // #149 Letterbox / cinematic bars (null = off): mask to a target aspect ratio with solid bars.
  const [letterbox, setLetterbox] = React.useState<{ aspect?: number; color?: string } | null>(null);
  // #152 Gradient scrim (null = off): a darken/tint ramp toward one edge for caption legibility.
  const [scrim, setScrim] = React.useState<{ edge?: 'top' | 'bottom' | 'left' | 'right'; strength?: number; color?: string } | null>(null);
  // #153 Highlight sweep (null = off): a translucent box wiping across a caption region. Per-phrase lists come
  // from a caption/beat producer; the manual control seeds one lower-third highlight box.
  const [highlightSweep, setHighlightSweep] = React.useState<{ x: number; y: number; w: number; h: number; color?: string; opacity?: number; start?: number; duration?: number } | null>(null);
  // #131 Ellipse / circle mask on/off (centered oval; precise cx/cy/rx/ry is DATA-authorable).
  const [ellipseMaskOn, setEllipseMaskOn] = React.useState(false);
  // #135 Iris-in reveal on/off (animates the oval mask open over ~0.8s; needs the Oval mask on).
  const [irisReveal, setIrisReveal] = React.useState(false);
  // #136 Split-tone 3-way color grade (null = off), chosen from the cinematic preset buttons.
  const [splitTone, setSplitTone] = React.useState<{ shadows: { r: number; g: number; b: number }; mids: { r: number; g: number; b: number }; highlights: { r: number; g: number; b: number } } | null>(null);
  // #119 Whole-clip orientation: quarter-turn rotation (0/90/180/270) + mirror ('' / h / v / hv).
  const [rotateDegrees, setRotateDegrees] = React.useState(0);
  const [clipFlip, setClipFlip] = React.useState('');
  // Split-screen / compare: the source_id of a SECOND source to tile beside this clip (the
  // you-vs-Federer side-by-side), plus the layout. null = no split. Rides the SAME set-transform
  // apply path as every other transform, so it flows to the render's kind:'split' compositor.
  const [splitCompareWith, setSplitCompareWith] = React.useState<string | null>(null);
  const [splitLayout, setSplitLayout] = React.useState<'h' | 'v' | 'grid'>('h');
  // Mirror the compare cell so a lefty/righty (or opposite camera angle) faces the same way.
  const [splitMirrorCompare, setSplitMirrorCompare] = React.useState(false);
  const [pipCorner, setPipCorner] = React.useState<string>('bottom-right');
  // #90 Caption translation target language (a convenience preset list; any BCP-47 code is valid DATA).
  const [captionLang, setCaptionLang] = React.useState<string>('es');
  const [captionKaraoke, setCaptionKaraoke] = React.useState(false);
  const [autoReframe, setAutoReframe] = React.useState(false);
  // #94 How the reframe fills the canvas: 'crop' (cover), 'blur' (contain + blurred fill), 'black' (bars).
  const [reframeFill, setReframeFill] = React.useState<string>('crop');
  // #95 Smooth slow-mo: optical-flow frame interpolation when the clip is slowed (speed < 1).
  const [smoothSlowmo, setSmoothSlowmo] = React.useState(false);
  const [look, setLook] = React.useState('none');
  const [denoise, setDenoise] = React.useState('none');
  const [soundFx, setSoundFx] = React.useState('none');
  // #102 Velocity curve preset key ('none' = constant speed); resolves to SPEED_RAMP_CATALOG DATA.
  const [speedRampKey, setSpeedRampKey] = React.useState('none');
  // #107 Retime audio through the ramp (opt-in; default mutes ramped clips).
  const [speedRampAudio, setSpeedRampAudio] = React.useState(false);
  // #108 Marks the clip as an adjustment layer: its look applies to everything under it.
  const [adjustmentLayer, setAdjustmentLayer] = React.useState(false);
  const [manualControls, setManualControls] = React.useState<MediaManualControlValues>(DEFAULT_MANUAL_CONTROLS);

  // ── Playback clock (shared across surface mounts) ─────────────────────────────
  // currentTime / isPlaying live in the shared session store so the Edit-timeline
  // playhead tracks the Preview video, and any pane can seek. The Preview pane
  // owns the <video> element (videoRef) and is the only writer of the raw clock.
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const currentTime = useEditorSession((s) => s.currentTime);
  const isPlaying = useEditorSession((s) => s.isPlaying);
  const seekNonce = useEditorSession((s) => s.seekNonce);
  const seekTarget = useEditorSession((s) => s.seekTarget);
  const [selectedClipId, setSelectedClipId] = React.useState<string | null>(null);
  const [peaksBySource, setPeaksBySource] = React.useState<Record<string, number[]>>({});
  // #74 Ripple mode: when on, a trim-handle drag authors 'ripple-trim' (shifts all
  // downstream clips by the duration delta) instead of a plain 'trim' (leaves a gap).
  const [rippleMode, setRippleMode] = React.useState(false);

  // ── Derived composition ───────────────────────────────────────────────────────
  // Base composition folds the log's edit-decisions; optimistic empty lanes (just-
  // created tracks) are merged on top so a new track renders instantly.
  const baseComposition = React.useMemo(() => composeTimeline(workspace), [workspace]);
  const composition = useOptimisticComposition(baseComposition);
  const duration = composition.durationSeconds || 0;
  const playheadPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  // Any pane requests a seek through the store; the video-owning pane applies it.
  const seek = React.useCallback((t: number) => {
    sessionRequestSeek(t);
  }, []);

  const playPause = React.useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
      sessionSetPlaying(true);
    } else {
      v.pause();
      sessionSetPlaying(false);
    }
  }, []);

  // ── Live transform assembled from inspector state ─────────────────────────────
  const liveTransform: ClipTransform = React.useMemo(() => {
    const t: ClipTransform = {
      aspectRatio,
      framePreset,
      position,
      keepAspectRatio,
      ...manualControls,
    };
    // Convert the percent/seconds inspector sliders to their ClipTransform fields.
    // extractTransform reads speed/volume/fadeIn/fadeOut; the raw _pct/_s keys are
    // ignored downstream, so this is the one place the UI unit meets the DATA field.
    if (manualControls.speed_pct != null) t.speed = manualControls.speed_pct / 100;
    if (smoothSlowmo && t.speed != null && t.speed < 1) t.speedSmooth = true;
    if (manualControls.volume_pct != null) t.volume = manualControls.volume_pct / 100;
    if (manualControls.fade_in_s != null) t.fadeIn = manualControls.fade_in_s;
    if (manualControls.fade_out_s != null) t.fadeOut = manualControls.fade_out_s;
    // Manual crop rect: 4 percent sliders -> a normalized {x,y,w,h}. Only when it is not the full frame.
    const cropX = manualControls.crop_x ?? 0;
    const cropY = manualControls.crop_y ?? 0;
    const cropW = manualControls.crop_w ?? 100;
    const cropH = manualControls.crop_h ?? 100;
    if (cropW > 0 && cropH > 0 && (cropX > 0 || cropY > 0 || cropW < 100 || cropH < 100)) {
      t.cropRect = { x: cropX / 100, y: cropY / 100, w: cropW / 100, h: cropH / 100 };
    }
    // Manual color adjust: percent sliders -> eq terms; only non-identity values are kept.
    const adj: { brightness?: number; contrast?: number; saturation?: number; gamma?: number } = {};
    if (manualControls.adj_brightness) adj.brightness = manualControls.adj_brightness / 100;
    if (manualControls.adj_contrast != null && manualControls.adj_contrast !== 100) adj.contrast = manualControls.adj_contrast / 100;
    if (manualControls.adj_saturation != null && manualControls.adj_saturation !== 100) adj.saturation = manualControls.adj_saturation / 100;
    if (manualControls.adj_gamma != null && manualControls.adj_gamma !== 100) adj.gamma = manualControls.adj_gamma / 100;
    if (Object.keys(adj).length > 0) t.colorAdjust = adj;
    // Sharpen / clarity: percent slider -> 0..1 unsharp amount.
    if (manualControls.sharpen) t.sharpen = manualControls.sharpen / 100;
    // Border / frame: a positive width slider draws a border in the chosen color.
    if (manualControls.border_width && borderColor) t.border = { width: manualControls.border_width, color: borderColor };
    // Spotlight / positioned radial focus: a positive strength dims the frame away from cx,cy.
    if (manualControls.spotlight_strength) {
      t.spotlight = {
        cx: (manualControls.spotlight_x ?? 50) / 100,
        cy: (manualControls.spotlight_y ?? 50) / 100,
        strength: manualControls.spotlight_strength / 100,
      };
      // #154 The follow toggle seeds a default sweep across the clip; a precise path is authored as DATA.
      if (spotlightFollow) t.spotlight.track = [{ at: 0, cx: 0.25, cy: 0.5 }, { at: 1, cx: 0.75, cy: 0.5 }];
      if (spotlightPulse) t.spotlight.pulse = 2;
    }
    // Framed clip: a scale below 100% shrinks the clip onto the chosen background.
    if (manualControls.frame_scale != null && manualControls.frame_scale < 100) {
      t.frame = { scale: manualControls.frame_scale / 100, background: frameBackground };
    }
    // Duotone: a selected preset pair maps luma to the two colors.
    if (duotone) t.duotone = duotone;
    // #128 Rounded corners: a positive corner_radius (% of the shorter side) rounds the final frame.
    // #133 corner_feather (% of radius) softens the corner arc.
    if (manualControls.corner_radius != null && manualControls.corner_radius > 0) {
      t.roundedCorners = { radius: manualControls.corner_radius / 100, background: cornerBackground, feather: (manualControls.corner_feather ?? 0) / 100 };
    }
    // #129 Drop shadow / floating card: the toggle applies the Screen Studio defaults (the AI worker
    // can author precise scale/blur/offset/colors as DATA via set-transform).
    // #134 card_corner (% of card) rounds the floating card for the true Screen Studio look.
    if (dropShadow) t.dropShadow = { scale: 0.85, blur: 16, dx: 0, dy: 16, color: 'black', background: 'white', cornerRadius: (manualControls.card_corner ?? 0) / 100 };
    // #130 Censor: a chosen preset applies its opaque filter to a centered default region (precise x/y/w/h
    // is DATA-authorable). The render is fully generic; the filter string is the L090/L111 opaque seam.
    if (censorFilter) {
      // #138 pan = a 2-point slide; #139 bounce / orbit = keyframe paths (path wins over motion in the render).
      const censorMove = censorMotion === 'pan' ? { motion: { toX: 0.55, toY: 0.35, start: 0, duration: 2 } }
        : censorMotion === 'bounce' ? { path: [{ x: 0.15, y: 0.35, at: 0 }, { x: 0.6, y: 0.35, at: 1.5 }, { x: 0.15, y: 0.35, at: 3 }] }
        : censorMotion === 'orbit' ? { path: [{ x: 0.15, y: 0.15, at: 0 }, { x: 0.6, y: 0.15, at: 1 }, { x: 0.6, y: 0.6, at: 2 }, { x: 0.15, y: 0.6, at: 3 }] }
        : {};
      // #140 ease rides whatever motion/path is active.
      if (censorMotion && censorEase) censorMove.ease = censorEase;
      // #141 fade ramps the censor opacity in/out (composes with any position, default 0.8s).
      const censorFade = (censorFadeIn || censorFadeOut)
        ? { fade: { ...(censorFadeIn ? { in: 0.8 } : {}), ...(censorFadeOut ? { out: 0.8 } : {}) } }
        : {};
      // #142 spotlight = apply the effect to the surroundings, keep the region original.
      const censorModeObj = censorSpotlight ? { mode: 'outside' as const } : {};
      t.regionFilter = { x: 0.3, y: 0.35, w: 0.4, h: 0.3, filter: censorFilter, ...censorMove, ...censorFade, ...censorModeObj };
    }
    // #137 Multiple censors: the stacked regions ride alongside the singular one (the render composites the
    // full [regionFilter, ...regionFilters] list). Precise per-region x/y/w/h stays DATA-authorable.
    if (censorRegions.length > 0) t.regionFilters = censorRegions;
    // #136 Split-tone: a selected cinematic preset (3-way color balance); the AI worker can author any push.
    if (splitTone) t.splitTone = splitTone;
    // #143 Progress bar overlay (clip-level, fills over the clip duration).
    if (progressBar) t.progressBar = progressBar;
    // #144 Live timer overlay (clip-level).
    if (timer) t.timer = timer;
    // #147 Countdown ring overlay (clip-level).
    if (countdownRing) t.countdownRing = countdownRing;
    // #148 Marker-synced flashes (beat pulses).
    if (pulses && pulses.length) t.pulses = pulses;
    // #149 Letterbox / cinematic bars.
    if (letterbox) t.letterbox = letterbox;
    // #152 Gradient scrim.
    if (scrim) t.scrim = scrim;
    // #153 Highlight sweep.
    if (highlightSweep) t.highlightSweep = highlightSweep;
    // #131 Ellipse mask: the toggle applies a centered oval; the AI worker can author precise cx/cy/rx/ry.
    // #132 feather (% of radius) softens the edge when the ellipse_feather slider is above 0.
    // #135 iris reveal: the toggle animates the oval open over ~0.8s (the AI worker can author from/to/start/duration).
    if (ellipseMaskOn) {
      t.ellipseMask = { cx: 0.5, cy: 0.5, rx: 0.45, ry: 0.45, background: 'black', feather: (manualControls.ellipse_feather ?? 0) / 100 };
      if (irisReveal) t.ellipseMask.reveal = { from: 0, to: 1, start: 0, duration: 0.8 };
    }
    if (duckMusic) t.duck = true;
    if (echo) t.echo = { amount: 0.5 };
    // One-click Ken Burns is a gentle zoom-in from center. The AI worker authors precise
    // from/to via DATA; the toggle is the manual default.
    if (kenBurns) t.kenBurns = { zoom_from: 1, zoom_to: 1.2, x_from: 0.5, x_to: 0.5, y_from: 0.5, y_to: 0.5 };
    // #76 Reverse plays the clip backward; freezeTail holds the last frame for 1s.
    if (reverse) t.reverse = true;
    if (freezeTail) t.freeze = { mode: 'tail', duration: 1 };
    // Auto-reframe retargets the clip to the selected export aspect (e.g. 9:16) with a tight
    // crop instead of black-bar letterbox. No track here means a static center crop; the
    // vision.subject.track detector (motion-analysis) supplies the follow path at export as DATA.
    if (autoReframe) {
      const [aw, ah] = String(aspectRatio).split(':').map((n) => Number(n));
      if (Number.isFinite(aw) && Number.isFinite(ah) && aw > 0 && ah > 0) {
        t.reframe = { aspect_w: aw, aspect_h: ah, ...(reframeFill && reframeFill !== 'crop' ? { fill_mode: reframeFill } : {}) };
      }
    }
    // Color grade / look: a preset key resolves to its opaque ffmpeg grade DATA string (the render
    // is blind to the look). 'none' clears the grade. A custom LUT is grade + grade_lut_ref DATA.
    if (look && look !== 'none' && LOOK_CATALOG[look]) t.grade = LOOK_CATALOG[look];
    // #108 Adjustment layer: the clip stops contributing pixels; its grade (the selected look)
    // applies to the whole program over the clip's time window.
    if (adjustmentLayer) t.adjustment = true;
    else if (look === 'none') t.grade = '';
    // Noise reduction: a preset key resolves to its DATA value (an ffmpeg afilter string, or the
    // 'deepfilternet' external-method key). 'none' clears it. The render applies it blind (L090).
    if (denoise && denoise !== 'none' && DENOISE_CATALOG[denoise]) t.denoise = DENOISE_CATALOG[denoise];
    else if (denoise === 'none') t.denoise = '';
    // #100 Audio effect chain: a preset key resolves to its opaque ffmpeg audio-filter DATA string
    // (EQ/compressor/de-reverb/"Studio Sound"). 'none' clears it. The render applies it blind (L090).
    if (soundFx && soundFx !== 'none' && AUDIO_FX_CATALOG[soundFx]) t.audioFilters = AUDIO_FX_CATALOG[soundFx];
    else if (soundFx === 'none') t.audioFilters = '';
    // #102 Velocity curve: a preset key resolves to its keyframe DATA (fraction-of-clip t values,
    // resolved to seconds at render where the clip duration is known). 'none' clears the ramp.
    if (speedRampKey && speedRampKey !== 'none' && SPEED_RAMP_CATALOG[speedRampKey]) {
      t.speedRamp = SPEED_RAMP_CATALOG[speedRampKey];
      t.speedRampUnit = 'fraction';
      if (speedRampAudio) t.speedRampAudio = true;
    }
    // #78 Green screen keys out the green background (DATA colorkey); reveals what is behind when
    // this clip is composited as a video overlay over the spine.
    if (greenScreen) t.chroma_key = CHROMA_CATALOG.green;
    // #85 Stabilize / deshake (vidstab two-pass); the render owns the numbers.
    if (shake) t.shake = shake;
    if (stabilize) t.stabilize = true;
    // Motion blur: blend frames for the After Effects / DaVinci fast-motion smear (the render owns
    // the frame count).
    if (motionBlur) t.motionBlur = true;
    // #156 Trails / echo: the toggle seeds a default persistence decay; a precise decay is authored as DATA.
    if (trails) t.trails = { decay: 0.9 };
    // #157 Wobble: the toggle seeds a default ripple; precise amplitude/frequency/speed authored as DATA.
    if (wobble) t.wobble = { amplitude: 8, frequency: 3, speed: 0.5 };
    // #158 Warmth ramp: the toggle seeds a warm->cool ramp; precise from/to/start/duration authored as DATA.
    if (warmthRamp) t.warmthRamp = { from: 0.4, to: -0.4, start: 0 };
    // #159 Strobe: the toggle seeds a default choppy rate; a precise rate is authored as DATA.
    if (strobe) t.strobe = { rate: 8 };
    // #160 Scanlines: the toggle seeds a default CRT line pattern; precise depth/period/roll authored as DATA.
    if (scanlines) t.scanlines = { depth: 0.5, period: 4 };
    // #161 Lens fringe: the toggle seeds a default radial aberration; a precise strength is authored as DATA.
    if (lensFringe) t.lensFringe = { strength: 0.05 };
    // #162 Posterize: the toggle seeds a default comic-style level count; a precise count is authored as DATA.
    if (posterize) t.posterize = { levels: 6 };
    // #173 Solarize: the toggle seeds a 0.5 threshold; a precise threshold is authored as DATA.
    if (solarize) t.solarize = { threshold: 0.5 };
    // #174 Pixelate: the toggle seeds a 12-px block; a precise blockSize is authored as DATA.
    if (pixelate) t.pixelate = { blockSize: 12 };
    // #175 Grain: the toggle seeds a 20-strength grain; a precise amount is authored as DATA.
    if (grain) t.grain = { amount: 20 };
    // #176 Emboss: the toggle seeds depth 1; a precise depth is authored as DATA.
    if (emboss) t.emboss = { depth: 1 };
    // #177 Defocus: the toggle seeds an 8-radius blur; a precise amount is authored as DATA.
    if (defocus) t.defocus = { amount: 8 };
    // #178 Fisheye: the toggle seeds a -0.4 barrel bulge; a precise strength is authored as DATA.
    if (fisheye) t.fisheye = { strength: -0.4 };
    // #179 Warmth: the toggle seeds a +0.5 warm tint; a precise amount is authored as DATA.
    if (warmth) t.warmth = { amount: 0.5 };
    // #180 Color splash: the toggle seeds keeping red; a precise color/similarity is authored as DATA.
    if (colorSplash) t.colorSplash = { color: 'red', similarity: 0.3 };
    // #181 Perspective: the toggle seeds a +0.4 top-in keystone; a precise tilt is authored as DATA.
    if (perspective) t.perspective = { tilt: 0.4 };
    // #182 Smooth: the toggle seeds a default edge-preserving smooth; a precise amount is authored as DATA.
    if (smooth) t.smooth = { amount: 0.6 };
    // #183 Directional blur: the toggle seeds a horizontal motion streak; axis and amount are authored as DATA.
    if (directionalBlur) t.directionalBlur = { amount: 0.6, axis: 'h' };
    // #184 Binarize: the toggle seeds a mid-luma cutoff; a precise cutoff is authored as DATA.
    if (binarize) t.binarize = { cutoff: 0.5 };
    // #185 Swirl: the toggle seeds a moderate clockwise twist; a precise strength is authored as DATA.
    if (swirl) t.swirl = { strength: 0.6 };
    // #186 Mirror: the toggle seeds a left-onto-right fold; the axis is authored as DATA.
    if (mirror) t.mirror = { axis: 'h' };
    // #187 Tile: the toggle seeds a 2x2 grid; a precise count is authored as DATA.
    if (tile) t.tile = { count: 2 };
    // #188 Invert: photographic negative (param-less).
    if (invert) t.invert = true;
    // #189 Vibrance: the toggle seeds a default smart-saturation boost; a precise intensity is authored as DATA.
    if (vibrance) t.vibrance = { intensity: 0.6 };
    // #190 Channel swap: the toggle seeds the classic red<->blue swap; other pairs are authored as DATA.
    if (channelSwap) t.channelSwap = { pair: 'rb' };
    // #191 Exposure: the toggle seeds a gentle +0.6-stop lift; a precise stop value is authored as DATA.
    if (exposure) t.exposure = { stops: 0.6 };
    // #192 Shear: the toggle seeds a horizontal slant; the amount/axis are authored as DATA.
    if (shear) t.shear = { amount: 0.3, axis: 'h' };
    // #193 Auto-contrast: the toggle seeds a mid-strength histogram equalization; a precise strength is DATA.
    if (histeq) t.histeq = { strength: 0.5 };
    // #194 Morphology: the toggle seeds a 2-pass dilate (grow bright); erode/amount are authored as DATA.
    if (morphology) t.morphology = { mode: 'dilate', amount: 2 };
    // #195 Colorize: the toggle seeds a blueprint-blue wash; a precise hue/strength is authored as DATA.
    if (colorize) t.colorize = { hue: 220, strength: 0.5 };
    // #196 Auto white-balance: the toggle seeds a full-strength normalize; a precise strength is DATA.
    if (normalize) t.normalize = { strength: 1 };
    // #197 Chroma bleed: the toggle seeds a medium color-bleed radius; a precise radius is authored as DATA.
    if (chromaBleed) t.chromaBleed = { radius: 15 };
    if (rgbSplit) t.rgbSplit = { amount: 6 };
    if (monoMix) t.monoMix = { r: 0.7, g: 0.2, b: 0.1 };
    if (fadedFilm) t.fadedFilm = { lift: 0.15 };
    // #163 Halftone: the toggle seeds a default comic dot size; a precise size is authored as DATA.
    if (halftone) t.halftone = { size: 6 };
    // #172 Gradient map: the toggle seeds a 3-stop teal->amber ramp; precise stops are authored as DATA.
    if (gradientMap) t.gradientMap = { stops: [{ at: 0, color: '#0a2540' }, { at: 0.5, color: '#1f9ea6' }, { at: 1, color: '#ffb454' }] };
    // #164 Tilt-shift: the toggle seeds a centered focus band; precise center/height/feather/blur as DATA.
    if (tiltShift) t.tiltShift = { center: 0.5, height: 0.3, feather: 0.12, blur: 10 };
    // #165 Sketch: the toggle seeds the cartoon look; mode/strength are authorable as DATA.
    if (sketch) t.sketch = { mode: 'colormix', strength: 0.5 };
    // #167 Zoom / radial blur: the toggle seeds a centered medium spread; strength/center authorable as DATA.
    if (zoomBlur) t.zoomBlur = { strength: 0.6, cx: 0.5, cy: 0.5 };
    // #168 Light leak: the toggle seeds a warm top-right leak; color/position/radius authorable as DATA.
    if (lightLeak) t.lightLeak = { strength: 0.8, color: '#ff9628', x: 1, y: 0, radius: 0.75 };
    // #169 Film damage: the toggle seeds a few scratches and some dust; counts/strength authorable as DATA.
    if (filmDamage) t.filmDamage = { scratches: 3, dust: 16, strength: 0.7 };
    // #171 Hue rotation: the toggle seeds a 120deg spin; exact degrees/saturation/cycleRate authorable as DATA.
    if (hueShift) t.hueShift = { degrees: 120 };
    // Self-glow / bloom: highlights bleed a soft halo; the strength slider tunes spread + intensity.
    if (glow) {
      t.glow = true;
      if (manualControls.glow_strength != null) t.glowStrength = manualControls.glow_strength / 100;
    }
    // Whole-clip orientation: quarter-turn rotate + mirror (the sideways-phone fix).
    if (rotateDegrees === 90 || rotateDegrees === 180 || rotateDegrees === 270) t.rotateDegrees = rotateDegrees;
    if (clipFlip === 'h' || clipFlip === 'v' || clipFlip === 'hv') t.flip = clipFlip;
    // Split-screen / compare: tile this clip's source with the chosen second source into one frame
    // (the you-vs-Federer side-by-side). materialize turns this into the render's kind:'split'
    // compositor; zero new render code (L069). No compare source selected means no split.
    if (splitCompareWith) {
      t.splitScreen = {
        with: [splitCompareWith],
        ...(splitLayout !== 'h' ? { layout: splitLayout } : {}),
        ...(splitMirrorCompare ? { cells: [{}, { flip: 'h' }] } : {}),
      };
    }
    return t;
  }, [aspectRatio, framePreset, position, keepAspectRatio, manualControls, duckMusic, echo, kenBurns, autoReframe, reframeFill, smoothSlowmo, look, denoise, soundFx, speedRampKey, speedRampAudio, adjustmentLayer, reverse, freezeTail, greenScreen, shake, stabilize, motionBlur, trails, wobble, warmthRamp, strobe, scanlines, lensFringe, posterize, halftone, gradientMap, solarize, pixelate, grain, emboss, defocus, fisheye, warmth, colorSplash, perspective, smooth, directionalBlur, binarize, swirl, mirror, tile, invert, vibrance, channelSwap, exposure, shear, histeq, morphology, colorize, normalize, chromaBleed, rgbSplit, monoMix, fadedFilm, tiltShift, sketch, zoomBlur, lightLeak, filmDamage, hueShift, glow, dropShadow, borderColor, frameBackground, duotone, cornerBackground, censorFilter, censorRegions, censorMotion, censorEase, censorFadeIn, censorFadeOut, censorSpotlight, spotlightFollow, spotlightPulse, progressBar, timer, countdownRing, pulses, letterbox, scrim, highlightSweep, ellipseMaskOn, irisReveal, splitTone, rotateDegrees, clipFlip, splitCompareWith, splitLayout, splitMirrorCompare]);

  React.useEffect(() => {
    if (!selectedSourceId && workspace.sources[0]) {
      setSelectedSourceId(workspace.sources[0].source_id);
    }
  }, [selectedSourceId, workspace.sources]);

  React.useEffect(() => {
    if (!selectedPanelId && workspace.panels[0]) {
      setSelectedPanelId(workspace.panels[0].panel_id);
    }
  }, [selectedPanelId, workspace.panels]);

  const selectedSource = workspace.sources.find((source) => source.source_id === selectedSourceId);
  const selectedPanel = workspace.panels.find((panel) => panel.panel_id === selectedPanelId) ?? workspace.panels[0];

  // ── Program monitor ───────────────────────────────────────────────────────────
  // The preview shows the timeline's clip AT THE PLAYHEAD (the "program" source),
  // so the preview and the timeline always agree. If no clip covers the playhead
  // (empty timeline or a gap), fall back to the browsed selected source.
  const programClip = React.useMemo(
    () => programVideoClipAt(composition, currentTime),
    [composition, currentTime],
  );
  const programSource = programClip
    ? workspace.sources.find((source) => source.source_id === programClip.sourceId)
    : undefined;
  const previewSource = programSource ?? selectedSource;
  const programClipRef = React.useRef<MaterializedClip | undefined>(undefined);
  programClipRef.current = programClip;

  const bytesPreview = useBytesPreview(previewSource);

  // ── Decoded audio peaks — selected source only ────────────────────────────────
  // Fetches bytes for the currently selected audio/video source and decodes them
  // to a 64-bucket peaks array via the Web Audio API. Result is cached by source
  // ID so toggling between sources never re-decodes. Non-audio/video sources and
  // environments without AudioContext fall back to the Waveform synthetic shape.
  const selectedSourceBytesForPeaks = useBitfieldData<Uint8Array>({
    input: 'source-bytes-by-address-label',
    params: {
      addressLabel:
        selectedSource?.artifact_ref?.stored_bytes_address_label ??
        '__missing-media-source-bytes__',
    },
  });

  React.useEffect(() => {
    if (!selectedSource) return;
    const mediaType = selectedSource.media_type;
    if (!mediaType.startsWith('audio/') && !mediaType.startsWith('video/')) return;
    const sourceId = selectedSource.source_id;
    if (peaksBySource[sourceId] !== undefined) return; // already decoded
    if (!(selectedSourceBytesForPeaks instanceof Uint8Array) || selectedSourceBytesForPeaks.byteLength === 0) return;
    const bytes = selectedSourceBytesForPeaks;
    void decodeAudioPeaks(bytes, mediaType, 64, sourceId).then((peaks) => {
      if (peaks.length === 0) return; // decode failed or unsupported env — keep synthetic
      setPeaksBySource((prev) => ({ ...prev, [sourceId]: peaks }));
    });
  }, [selectedSource, selectedSourceBytesForPeaks, peaksBySource]);
  const selectedPreview = previewSource ? previews[previewSource.source_id] ?? bytesPreview : undefined;
  const selectedSourceDetail = previewSource ? sourceDetail(previewSource) : undefined;

  // The Preview pane OWNS the <video>: push its clock into the shared store while
  // playing (throttled ~30fps so unrelated panes do not re-render per frame) and
  // mirror the element's play/pause/ended into the store. Other panes render no
  // <video>, so videoRef.current is null there and this whole effect no-ops.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    let raf = 0;
    let last = -1;
    const tick = () => {
      if (!v.paused && !v.ended) {
        const clip = programClipRef.current;
        if (clip) {
          // Map the element's clock into COMPOSITION time. When the element passes
          // the clip's out-point, advance the playhead just past the clip's end so
          // the next clip becomes the program (its source loads + plays below).
          if (v.currentTime >= clip.outPoint - 0.03) {
            sessionSetCurrentTime(clip.laneEnd + 0.0001);
            last = -1;
          } else {
            const comp = clip.laneStart + (v.currentTime - clip.inPoint);
            if (Math.abs(comp - last) >= 0.03) { last = comp; sessionSetCurrentTime(comp); }
          }
        } else {
          // No timeline clip at the playhead: play the raw element clock (browsing).
          const t = v.currentTime;
          if (Math.abs(t - last) >= 0.03) { last = t; sessionSetCurrentTime(t); }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    const onPlay = () => sessionSetPlaying(true);
    const onPause = () => sessionSetPlaying(false);
    const onEnded = () => sessionSetPlaying(false);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
    };
  }, [selectedPreview?.url]);

  // Apply a seek authored by ANY pane (Edit-timeline ruler, transport buttons) to
  // the owned <video>, mapped into the program clip's own source time. seekNonce
  // distinguishes an explicit seek from a clock tick.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v || seekNonce === 0) return;
    const clip = programClipRef.current;
    const target = clip ? clip.inPoint + Math.max(0, seekTarget - clip.laneStart) : seekTarget;
    try { v.currentTime = target; } catch { /* element not seekable yet */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce]);

  // When the PROGRAM CLIP changes (the playhead crossed a clip boundary, or a
  // source was selected), point the newly shown <video> at the clip's in-point
  // and keep playing if we were playing, so the timeline sequence plays through.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v || !programClip) return;
    const target = programClip.inPoint + Math.max(0, currentTime - programClip.laneStart);
    if (Math.abs(v.currentTime - target) > 0.25) {
      try { v.currentTime = target; } catch { /* not seekable yet */ }
    }
    if (isPlaying && v.paused) void v.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programClip?.clipId, selectedPreview?.url]);
  const selectedTool = MEDIA_TOOLS.find((tool) => tool.id === selectedToolId) ?? MEDIA_TOOLS[0];
  const manualParameters = React.useMemo(() => ({
    tool: selectedToolId,
    aspect_ratio: aspectRatio,
    frame_preset: framePreset,
    position,
    keep_aspect_ratio: keepAspectRatio,
    controls: manualControls,
  }), [aspectRatio, framePreset, keepAspectRatio, manualControls, position, selectedToolId]);

  const setManualControl = React.useCallback((key: string, value: number) => {
    setManualControls((current) => ({ ...current, [key]: value }));
  }, []);

  const resetManualControl = React.useCallback((key: string) => {
    setManualControls((current) => ({
      ...current,
      [key]: DEFAULT_MANUAL_CONTROLS[key] ?? 0,
    }));
  }, []);

  React.useEffect(() => {
    if (workspace.selectedSourceId) setSelectedSourceId(workspace.selectedSourceId);
  }, [workspace.selectedSourceId]);

  const writeSelectionForSourceRef = React.useCallback(async (sourceRef: ContentMediaSourceRef | Record<string, unknown>) => {
    await writeMediaCompositionRecord({
      record: buildMediaCompositionSelectionRecord({
        sourceRef,
        createdAt: now().toISOString(),
      }),
    });
  }, [now]);

  const selectSource = React.useCallback((sourceId: string) => {
    setSelectedSourceId(sourceId);
    // If the source is on the timeline, jump the playhead to its first clip so
    // the program preview shows it IN timeline context (preview + timeline agree).
    const clip = firstClipForSource(composition, sourceId);
    if (clip) sessionRequestSeek(clip.laneStart);
    const source = workspace.sources.find((item) => item.source_id === sourceId);
    if (!source) return;
    void writeSelectionForSourceRef(source.source_ref).catch((error) => {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] select source failed:', raw);
      setMessage('Media could not be selected. Please try again.');
    });
  }, [composition, workspace.sources, writeSelectionForSourceRef]);

  const saveEdit = React.useCallback(async (action: string, label: string, parameters: Record<string, unknown> = {}) => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action,
          label,
          sourceRef: selectedSource.source_ref,
          parameters: {
            ...manualParameters,
            ...parameters,
          },
          createdAt: now().toISOString(),
        }),
      });
      setMessage(`${label} saved.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] save edit failed:', raw);
      setMessage('The edit could not be saved. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [manualParameters, now, selectedSource]);

  const addMarker = React.useCallback(async () => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionMarkerRecord({
          label: 'Marker',
          sourceRef: selectedSource.source_ref,
          time: currentTime,
          createdAt: now().toISOString(),
        }),
      });
      setMessage('Marker saved.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] save marker failed:', raw);
      setMessage('The marker could not be saved. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [currentTime, now, selectedSource]);

  // ── Edit decision handlers ────────────────────────────────────────────────────
  // Direct per-clip authoring flows below the timeline are dispatched generically
  // by `runOp(action)` (see the edit-timeline surface block). Only the trim-handle
  // drag needs a typed absolute in/out commit, so `trimClip` survives as its own
  // handler; split/move/delete are DATA-driven ops resolved through `runOp`.

  const trimClip = React.useCallback(async (clipId: string, inPoint: number, outPoint: number) => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      // Ripple mode authors 'ripple-trim' (new_start/new_end carry the absolute
      // in/out, and the fold shifts downstream clips by the duration delta). It has
      // no op-schema, so it goes through the un-validated record builder like split.
      const record = rippleMode
        ? buildMediaCompositionEditDecisionRecord({
            action: 'ripple-trim',
            label: 'Ripple trim',
            sourceRef: selectedSource.source_ref,
            parameters: { clip_id: clipId, new_start: inPoint, new_end: outPoint },
            createdAt: now().toISOString(),
          })
        : authorEditDecision(
            'trim',
            { clip_id: clipId, in_point: inPoint, out_point: outPoint },
            { sourceRef: selectedSource.source_ref, createdAt: now().toISOString() },
          );
      await writeMediaCompositionRecord({ record });
      setMessage(rippleMode ? 'Ripple trim saved.' : 'Trim saved.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] trim clip failed:', raw);
      setMessage('The clip could not be trimmed. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, rippleMode, selectedSource]);

  // #74 Close gaps (magnetic): one-shot, reposition every clip to butt against the
  // previous one, removing all inter-clip empty space. No op-schema, so build direct.
  const closeGaps = React.useCallback(async () => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'close-gaps',
          label: 'Close gaps',
          sourceRef: selectedSource.source_ref,
          parameters: {},
          createdAt: now().toISOString(),
        }),
      });
      setMessage('Gaps closed.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] close gaps failed:', raw);
      setMessage('The gaps could not be closed. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource]);

  // #75 Detach audio: split the selected clip's sound onto its own audio lane (video goes
  // silent). No op-schema, so build direct; targets by the composed clip handle when known.
  const detachAudio = React.useCallback(async () => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'detach-audio',
          label: 'Detach audio',
          sourceRef: selectedSource.source_ref,
          parameters: selectedClipId ? { clip_id: selectedClipId } : {},
          createdAt: now().toISOString(),
        }),
      });
      setMessage('Audio detached to its own track.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] detach audio failed:', raw);
      setMessage('The audio could not be detached. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedClipId, selectedSource]);

  // #79 Picture-in-picture: composite the selected source as an inset video overlay over the
  // spine, placed by a corner preset (PIP_CORNER_CATALOG). Pure DATA over the #78 video-overlay
  // render, so the handler only authors an add-overlay decision and the fold resolves the corner.
  const addPictureInPicture = React.useCallback(async () => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    const sourceRefLabel = selectedSource.artifact_ref?.stored_bytes_address_label;
    if (!sourceRefLabel) {
      setMessage('That source has no addressable bytes to composite.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'add-overlay',
          label: 'Picture-in-picture',
          sourceRef: selectedSource.source_ref,
          parameters: { overlay_kind: 'video', source_ref: sourceRefLabel, pip_corner: pipCorner },
          createdAt: now().toISOString(),
        }),
      });
      setMessage('Added as a picture-in-picture overlay.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] add PiP failed:', raw);
      setMessage('The picture-in-picture could not be added. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, pipCorner, selectedSource]);

  // #93 Normalize loudness: author a per-clip set-transform loudnorm at a target LUFS (-14 social /
  // -16 podcast / -23 broadcast). The render runs ffmpeg loudnorm to hit the target.
  const normalizeLoudness = React.useCallback(async (lufs: number) => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'set-transform',
          label: `Normalize loudness (${lufs} LUFS)`,
          sourceRef: selectedSource.source_ref,
          parameters: { transform: { loudnorm: lufs } },
          createdAt: now().toISOString(),
        }),
      });
      setMessage(`Loudness will normalize to ${lufs} LUFS.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] normalize loudness failed:', raw);
      setMessage('The loudness could not be normalized. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource]);

  // #96 Audio visualizer: add a waveform/spectrum/bars overlay GENERATED from the program audio
  // (podcast/music-video look). Composition-level (uses the mix), so no source selection needed.
  const addAudioViz = React.useCallback(async (viz: string) => {
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'add-overlay',
          label: `Audio visualizer (${viz})`,
          parameters: { overlay_kind: 'audioviz', viz, x: 0, y: 0.78, width: 1, height: 0.22, color: 'white' },
          createdAt: now().toISOString(),
        }),
      });
      setMessage(`Added a ${viz} audio visualizer.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] add audio visualizer failed:', raw);
      setMessage('The audio visualizer could not be added. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now]);

  // #92 Blend overlay: composite the selected source over the spine in a blend mode (screen light
  // leak / glow, multiply texture, softlight grade). A full-frame video overlay with a blend key.
  const addBlendOverlay = React.useCallback(async (mode: string) => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    const sourceRefLabel = selectedSource.artifact_ref?.stored_bytes_address_label;
    if (!sourceRefLabel) {
      setMessage('That source has no addressable bytes to composite.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'add-overlay',
          label: `Blend overlay (${mode})`,
          sourceRef: selectedSource.source_ref,
          parameters: { overlay_kind: 'video', source_ref: sourceRefLabel, blend: mode },
          createdAt: now().toISOString(),
        }),
      });
      setMessage(`Added a ${mode} blend overlay.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] add blend overlay failed:', raw);
      setMessage('The blend overlay could not be added. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource]);

  // #86 Privacy blur / mosaic: censor a rectangle of the frame (a face / plate / screen) over
  // the whole clip. Authors an add-overlay region as normalized DATA (center rect by default);
  // the render blurs or pixelizes it. mode = 'blur' | 'mosaic'.
  const addCensorRegion = React.useCallback(async (mode: 'blur' | 'mosaic') => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'add-overlay',
          label: mode === 'mosaic' ? 'Mosaic censor' : 'Blur censor',
          sourceRef: selectedSource.source_ref,
          parameters: { overlay_kind: 'region', region_mode: mode, x: 0.33, y: 0.33, width: 0.34, height: 0.34 },
          createdAt: now().toISOString(),
        }),
      });
      setMessage(mode === 'mosaic' ? 'Added a mosaic censor box.' : 'Added a blur censor box.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] add censor region failed:', raw);
      setMessage('The censor box could not be added. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource]);

  // #84 Remove background (AI matte): composite the selected source over the spine keyed by an
  // AI person-segmentation matte (green screen without a screen). Authors an add-overlay video
  // with a `matte` producer key; the render generates the matte and alphamerges at render time.
  const addRemoveBackground = React.useCallback(async () => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    const sourceRefLabel = selectedSource.artifact_ref?.stored_bytes_address_label;
    if (!sourceRefLabel) {
      setMessage('That source has no addressable bytes to composite.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'add-overlay',
          label: 'Remove background',
          sourceRef: selectedSource.source_ref,
          parameters: { overlay_kind: 'video', source_ref: sourceRefLabel, matte: 'person', x: 0, y: 0 },
          createdAt: now().toISOString(),
        }),
      });
      setMessage('Added with the background removed (AI matte).');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] remove background failed:', raw);
      setMessage('The background could not be removed. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource]);

  // #88 Punch in: a Descript-style zoom emphasis at the playhead. Authors a set-transform with a
  // `zoom` keyframe envelope (buildPunchInZoomKeyframes); the render's zoom binding animates it.
  const punchIn = React.useCallback(async () => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      const keyframes = { zoom: buildPunchInZoomKeyframes({ at: Math.max(0, currentTime - 0.3), zoom: 1.4, hold: 1.0, ramp: 0.3 }) };
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'set-transform',
          label: 'Punch in',
          sourceRef: selectedSource.source_ref,
          parameters: { transform: { keyframes } },
          createdAt: now().toISOString(),
        }),
      });
      setMessage('Added a punch-in zoom at the playhead.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] punch-in failed:', raw);
      setMessage('The punch-in could not be added. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [currentTime, now, selectedSource]);

  // #89 Loop / boomerang: repeat the selected clip. `boomerang` reverses odd copies so the
  // motion ping-pongs (forward, back, forward, ...). loopCount 2 is the default one-tap repeat.
  const loopSegment = React.useCallback(async (boomerang: boolean) => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'set-transform',
          label: boomerang ? 'Boomerang' : 'Loop',
          sourceRef: selectedSource.source_ref,
          parameters: { transform: { loopCount: 2, loopBoomerang: boomerang } },
          createdAt: now().toISOString(),
        }),
      });
      setMessage(boomerang ? 'Boomeranged the clip (forward then reverse).' : 'Looped the clip (x2).');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] loop failed:', raw);
      setMessage('The loop could not be added. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource]);

  // #90 Translate captions: author a composition-wide translate-captions decision (target language +
  // engine). Empty language clears translation. The render applies it to every burned caption/title.
  const translateCaptions = React.useCallback(async (lang: string) => {
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'translate-captions',
          label: lang ? `Translate captions to ${lang}` : 'Clear caption translation',
          sourceRef: selectedSource?.source_ref,
          parameters: { to: lang, producer: 'argos' },
          createdAt: now().toISOString(),
        }),
      });
      setMessage(lang ? `Captions will render translated to ${lang}.` : 'Caption translation cleared.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] translate-captions failed:', raw);
      setMessage('The caption translation could not be set. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource]);

  const commitTransform = React.useCallback(async () => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    if (!selectedClipId) {
      setMessage('Select a clip to apply transform.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: authorEditDecision(
          'set-transform',
          { clip_id: selectedClipId, transform: liveTransform },
          { sourceRef: selectedSource.source_ref, createdAt: now().toISOString() },
        ),
      });
      setMessage('Transform saved.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] save transform failed:', raw);
      setMessage('The transform could not be saved. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [liveTransform, now, selectedClipId, selectedSource]);

  // ── edit-timeline surface (Unit 6) — DATA-driven editing ──────────────────────
  // Transcript words for the transcript modality, read blind through the
  // modality DATA row's source field-map (audio-transcription result words).
  const transcriptModality = React.useMemo(
    () => DEFAULT_EDIT_CAPABILITIES.modalities.find((m) => m.author_kind === 'transcript'),
    [],
  );
  const transcriptWords = React.useMemo(
    () => (transcriptModality?.source ? readTranscriptWords(workspace, transcriptModality.source) : []),
    [workspace, transcriptModality],
  );

  // #69 Descript-class auto-cleanup: detect silence gaps + filler words in the transcript,
  // then author remove-span decisions RIGHT-TO-LEFT (each fold ripples later footage left,
  // so cutting the latest span first keeps every earlier coordinate valid). One button, both
  // reasons; the AI worker calls the same detector with DATA thresholds.
  const autoCleanup = React.useCallback(async () => {
    if (!selectedSource) { setMessage('Choose a source first.'); return; }
    if (transcriptWords.length === 0) { setMessage('No transcript yet, so there is nothing to clean.'); return; }
    const spans = cleanupSpansInAuthorOrder(detectCleanupSpans(transcriptWords));
    if (spans.length === 0) { setMessage('No silences or filler words found.'); return; }
    setIsWriting(true);
    setMessage('');
    try {
      for (const span of spans) {
        await writeMediaCompositionRecord({
          record: authorEditDecision(
            'remove-span',
            { start: span.start, end: span.end },
            { sourceRef: selectedSource.source_ref, createdAt: now().toISOString() },
          ),
        });
      }
      const removed = spans.reduce((sum, s) => sum + (s.end - s.start), 0);
      setMessage(`Removed ${spans.length} silence and filler spans (${removed.toFixed(1)}s).`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] auto cleanup failed:', raw);
      setMessage('Auto cleanup could not finish. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource, transcriptWords]);

  // #77 Burn-in captions: group the transcript words into caption lines (DATA), then author
  // ONE add-captions decision carrying the lines + a style; the fold expands them into timed
  // text overlays the render burns via drawtext. Descript/CapCut auto-subtitles as pure DATA.
  const addCaptions = React.useCallback(async () => {
    if (!selectedSource) { setMessage('Choose a source first.'); return; }
    if (transcriptWords.length === 0) { setMessage('No transcript yet, so there are no words to caption.'); return; }
    const lines = groupWordsIntoCaptionLines(
      transcriptWords.map((w) => ({ text: w.text, start: w.start, end: w.end })),
    );
    if (lines.length === 0) { setMessage('No caption lines to add.'); return; }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'add-captions',
          label: 'Add captions',
          sourceRef: selectedSource.source_ref,
          parameters: { lines, style: { reveal: captionKaraoke ? 'word' : 'line' } },
          createdAt: now().toISOString(),
        }),
      });
      setMessage(captionKaraoke ? `Added karaoke captions from ${lines.length} lines.` : `Added ${lines.length} caption lines.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] add captions failed:', raw);
      setMessage('Captions could not be added. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [captionKaraoke, now, selectedSource, transcriptWords]);

  // ── Beat-synced cuts (#71) ────────────────────────────────────────────────────
  // Decode the selected audio/video bytes to a mono channel, detect beats in-browser
  // (detect-beats-browser energy-flux; librosa audio.beat.track is the export path),
  // and author one `split` decision per beat so clip boundaries land on the music.
  const beatSync = React.useCallback(async () => {
    if (!selectedSource) { setMessage('Choose a source first.'); return; }
    const mediaType = selectedSource.media_type;
    if (!mediaType.startsWith('audio/') && !mediaType.startsWith('video/')) { setMessage('Beat cuts need an audio or video source.'); return; }
    const bytes = selectedSourceBytesForPeaks;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) { setMessage('Media bytes are still loading.'); return; }
    const AudioCtx = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) { setMessage('Beat detection is not available in this environment.'); return; }
    setIsWriting(true);
    setMessage('');
    try {
      const ctx = new AudioCtx();
      const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
      const beats = detectBeatsFromChannel(buffer.getChannelData(0), buffer.sampleRate, { minGap: 0.2 });
      void ctx.close();
      const cuts = beatSyncSplitTimes(beats, { start: 0, end: composition.durationSeconds, minGap: 0.2 });
      if (cuts.length === 0) { setMessage('No clear beats found in this source.'); return; }
      for (const time of cuts) {
        // Build the split record directly: foldSplit reads params.time (the op-schema's at_time
        // validator does not match the reducer, so authoring through it would reject a valid cut).
        await writeMediaCompositionRecord({
          record: buildMediaCompositionEditDecisionRecord({
            action: 'split', label: 'Split', sourceRef: selectedSource.source_ref,
            parameters: { time }, createdAt: now().toISOString(),
          }),
        });
      }
      setMessage(`Cut on ${cuts.length} beats.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] beat sync failed:', raw);
      setMessage('Beat cutting could not finish. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource, selectedSourceBytesForPeaks, composition.durationSeconds]);

  // ── Scene-detect auto-split (#97) ─────────────────────────────────────────────
  // Sample the selected video's frames in-browser (detect-scenes-browser frame-diff;
  // ffmpeg scdet is the export path) and author one `split` decision per hard cut, so
  // a long recording auto-segments into shots via the SAME split fold op (L069).
  const sceneSplit = React.useCallback(async () => {
    if (!selectedSource) { setMessage('Choose a source first.'); return; }
    if (!selectedSource.media_type.startsWith('video/')) { setMessage('Scene split needs a video source.'); return; }
    const bytes = selectedSourceBytesForPeaks;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) { setMessage('Media bytes are still loading.'); return; }
    if (typeof document === 'undefined') { setMessage('Scene detection is not available in this environment.'); return; }
    setIsWriting(true);
    setMessage('');
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: selectedSource.media_type }));
    try {
      const probe = document.createElement('video');
      probe.muted = true; probe.preload = 'auto'; probe.src = url;
      await new Promise<void>((resolve, reject) => {
        probe.addEventListener('loadedmetadata', () => resolve(), { once: true });
        probe.addEventListener('error', () => reject(new Error('video decode failed')), { once: true });
      });
      const cuts = await detectScenesFromVideo(probe, { threshold: 0.3, minGap: 0.4, stepMs: 100 });
      if (cuts.length === 0) { setMessage('No hard scene cuts found in this source.'); return; }
      const splits = splitDecisionsFromCuts(cuts, selectedSource.source_ref, now().toISOString());
      for (const split of splits) {
        // Author the split record directly (foldSplit reads params.time; the op-schema
        // at_time validator does not match the reducer, so authoring through it rejects).
        await writeMediaCompositionRecord({
          record: buildMediaCompositionEditDecisionRecord({
            action: 'split', label: split.label, sourceRef: selectedSource.source_ref,
            parameters: { time: split.parameters.time }, createdAt: split.created_at,
          }),
        });
      }
      setMessage(`Split into ${splits.length + 1} scenes.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] scene split failed:', raw);
      setMessage('Scene detection could not finish. Please try again.');
    } finally {
      URL.revokeObjectURL(url);
      setIsWriting(false);
    }
  }, [now, selectedSource, selectedSourceBytesForPeaks]);

  // ── Auto-highlight / make-a-short (#98) ───────────────────────────────────────
  // Measure per-second audio energy from the decoded source, score the top viral
  // window (scoreHighlightWindows), and author the complement `remove-span` decisions
  // so the long recording is trimmed down to just the highlight (Opus-Clip class, L069).
  const makeHighlight = React.useCallback(async () => {
    if (!selectedSource) { setMessage('Choose a source first.'); return; }
    const mediaType = selectedSource.media_type;
    if (!mediaType.startsWith('audio/') && !mediaType.startsWith('video/')) { setMessage('Highlights need an audio or video source.'); return; }
    const bytes = selectedSourceBytesForPeaks;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) { setMessage('Media bytes are still loading.'); return; }
    const AudioCtx = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) { setMessage('Highlight detection is not available in this environment.'); return; }
    setIsWriting(true);
    setMessage('');
    try {
      const ctx = new AudioCtx();
      const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
      void ctx.close();
      const ch = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      const totalSeconds = buffer.duration;
      const win = 1; // one-second energy windows, mirrors the detect-highlights producer
      const segments: Array<{ start: number; end: number; energy: number }> = [];
      for (let t = 0; t < totalSeconds; t += win) {
        const a = Math.floor(t * sr);
        const b = Math.min(ch.length, Math.floor((t + win) * sr));
        let sum = 0;
        for (let k = a; k < b; k += 1) sum += ch[k] * ch[k];
        const rms = b > a ? Math.sqrt(sum / (b - a)) : 0;
        segments.push({ start: t, end: Math.min(t + win, totalSeconds), energy: Math.min(1, rms * 3) });
      }
      const windows = scoreHighlightWindows(segments, { count: 1 });
      if (windows.length === 0) { setMessage('No clear highlight found in this source.'); return; }
      const decisions = highlightDecisions(windows, { totalDuration: totalSeconds, sourceRef: selectedSource.source_ref, createdAt: now().toISOString() });
      for (const d of decisions) {
        await writeMediaCompositionRecord({
          record: buildMediaCompositionEditDecisionRecord({
            action: 'remove-span', label: d.label, sourceRef: selectedSource.source_ref,
            parameters: d.parameters, createdAt: d.created_at,
          }),
        });
      }
      const len = windows[0].end - windows[0].start;
      setMessage(`Trimmed to a ${len.toFixed(1)}s highlight.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] make highlight failed:', raw);
      setMessage('Highlight detection could not finish. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource, selectedSourceBytesForPeaks]);

  // ── Track subject / pin a label (#101) ────────────────────────────────────────
  // Track the bright subject in-browser and author a text label that FOLLOWS it (a spotlight/emoji
  // pinned to a moving face). Pure DATA: the overlay carries the track path; the render binds x/y.
  const trackSubject = React.useCallback(async () => {
    if (!selectedSource) { setMessage('Choose a source first.'); return; }
    if (!selectedSource.media_type.startsWith('video/')) { setMessage('Tracking needs a video source.'); return; }
    const bytes = selectedSourceBytesForPeaks;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) { setMessage('Media bytes are still loading.'); return; }
    if (typeof document === 'undefined') { setMessage('Tracking is not available in this environment.'); return; }
    const prompt = typeof window !== 'undefined' ? window.prompt : undefined;
    const label = (prompt ? prompt('Label to pin on the subject:', '\u{1F3AF}') : '\u{1F3AF}') || '';
    if (!label.trim()) { setMessage('No label entered.'); return; }
    setIsWriting(true);
    setMessage('');
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: selectedSource.media_type }));
    try {
      const probe = document.createElement('video');
      probe.muted = true; probe.preload = 'auto'; probe.src = url;
      await new Promise<void>((resolve, reject) => {
        probe.addEventListener('loadedmetadata', () => resolve(), { once: true });
        probe.addEventListener('error', () => reject(new Error('video decode failed')), { once: true });
      });
      const track = await trackSubjectFromVideo(probe, { grid: 16, stepMs: 150 });
      if (track.length === 0) { setMessage('Could not find a subject to track.'); return; }
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'add-overlay', label: 'Track subject', sourceRef: {},
          parameters: { overlay_kind: 'text', text: label.trim(), start: 0, end: probe.duration, track },
          createdAt: now().toISOString(),
        }),
      });
      setMessage(`Pinned "${label.trim()}" to the subject (${track.length} track points).`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] track subject failed:', raw);
      setMessage('Tracking could not finish. Please try again.');
    } finally {
      URL.revokeObjectURL(url);
      setIsWriting(false);
    }
  }, [now, selectedSource, selectedSourceBytesForPeaks]);

  // ── Add narration / voiceover (#99) ───────────────────────────────────────────
  // Author a narration clip from a typed script at the playhead. Pure DATA: the render
  // generates the voice with the DATA-selected TTS engine (tts-narrate) and mixes it over
  // the program, so the browser never runs a speech engine (L069 + WASM-is-brain-not-hands).
  const addNarration = React.useCallback(async () => {
    const prompt = typeof window !== 'undefined' ? window.prompt : undefined;
    const text = prompt ? prompt('Narration script (spoken at the playhead):') : '';
    if (!text || !text.trim()) { setMessage('No narration text entered.'); return; }
    setIsWriting(true);
    setMessage('');
    try {
      const decision = narrationAddSourceDecision({
        sourceId: `narration-${Date.now()}`,
        startSeconds: currentTime,
        text: text.trim(),
        producer: 'macos-say',
        volume: 1,
        createdAt: now().toISOString(),
      });
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'add-source', label: decision.label, sourceRef: decision.source_ref,
          span: decision.span, parameters: decision.parameters, createdAt: decision.created_at,
        }),
      });
      setMessage(`Added narration at ${currentTime.toFixed(1)}s.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] add narration failed:', raw);
      setMessage('Could not add narration. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, currentTime]);

  const selectedClip = React.useMemo<MaterializedClip | undefined>(() => {
    for (const lane of composition.lanes) {
      const clip = lane.clips.find((c) => c.clipId === selectedClipId);
      if (clip) return clip;
    }
    return undefined;
  }, [composition, selectedClipId]);

  // Editor state keyed by the SAME snake_case param names ops declare — the
  // op bar resolves which ops are actionable from this, with no per-op branch.
  const paramSource = React.useMemo<EditParamSource>(() => ({
    clip_id: selectedClipId ?? undefined,
    at_time: currentTime,
    in_point: selectedClip?.inPoint,
    out_point: selectedClip?.outPoint,
    lane_start: selectedClip?.laneStart,
    lane_role: selectedClip?.laneRole,
    transform: liveTransform,
  }), [selectedClipId, currentTime, selectedClip, liveTransform]);

  // Generic op dispatch: resolve the op's declared params from editor state and
  // author the decision. Never names an op — validation lives in the schema.
  const runOp = React.useCallback(async (action: string) => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    const descriptor = DEFAULT_EDIT_CAPABILITIES.ops[action];
    if (!descriptor) {
      setMessage('That action is not available.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: authorEditDecision(
          action,
          resolveOpParams(descriptor, paramSource),
          { sourceRef: selectedSource.source_ref, createdAt: now().toISOString() },
        ),
      });
      setMessage(`${descriptor.label} saved.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] run op failed:', raw);
      setMessage('That edit needs a clip selected first.');
    } finally {
      setIsWriting(false);
    }
  }, [now, paramSource, selectedSource]);

  // Transcript cleanup: fold the word/gap span stream through a ruleset DATA row
  // into remove/trim decisions (reuses the blind record-driven author).
  const runRuleset = React.useCallback(async (rulesetName: string) => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    const ruleset = DEFAULT_EDIT_CAPABILITIES.rulesets.find((r) => r.name === rulesetName);
    if (!ruleset) return;
    const spans = deriveWordAndGapSpans(
      transcriptWords.map((w) => ({ t: w.text, start: w.start, end: w.end })),
    );
    const records = authorDecisionsFromRecords({
      items: spans,
      ruleset,
      ctx: { sourceRef: selectedSource.source_ref, createdAt: now().toISOString(), label: ruleset.label },
    });
    if (records.length === 0) {
      setMessage('Nothing to clean up.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      for (const record of records) {
        await writeMediaCompositionRecord({ record });
      }
      setMessage(`${ruleset.label}: ${records.length} applied.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] run cleanup failed:', raw);
      setMessage('The cleanup could not be applied. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource, transcriptWords]);

  // Transcript remove / word-range remove: cut a timeline [start,end] range.
  const removeSpan = React.useCallback(async (start: number, end: number) => {
    if (!selectedSource) {
      setMessage('Choose a source first.');
      return;
    }
    setIsWriting(true);
    setMessage('');
    try {
      await writeMediaCompositionRecord({
        record: authorEditDecision(
          'remove-span',
          { start, end },
          { sourceRef: selectedSource.source_ref, createdAt: now().toISOString() },
        ),
      });
      setMessage('Removed.');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] remove range failed:', raw);
      setMessage('That range could not be removed. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, selectedSource]);

  // Author empty tracks (lanes) as DATA. The panel owns the lane-role policy
  // (L098): it derives the next free `video-N` / `audio-N` from the current
  // composition and writes one `add-track` decision per requested track. The
  // timeline re-derives and the new empty lanes appear, ready to drop clips on.
  const addTracks = React.useCallback(async (videoCount: number, audioCount: number) => {
    const numbersFor = (prefix: string) => composition.lanes
      .map((lane) => lane.role)
      .filter((role) => role.startsWith(`${prefix}-`))
      .map((role) => Number.parseInt(role.slice(prefix.length + 1), 10))
      .filter((n) => Number.isFinite(n));
    const nextFor = (prefix: string) => (numbersFor(prefix).length ? Math.max(...numbersFor(prefix)) : 0) + 1;

    const specs: { role: string; label: string; tone: string }[] = [];
    let v = nextFor('video');
    for (let i = 0; i < videoCount; i += 1, v += 1) specs.push({ role: `video-${v}`, label: `V${v}`, tone: 'source' });
    let a = nextFor('audio');
    for (let i = 0; i < audioCount; i += 1, a += 1) specs.push({ role: `audio-${a}`, label: `A${a}`, tone: 'audio' });
    if (specs.length === 0) return;

    // Render the empty lanes immediately (optimistic), then persist to the log.
    addOptimisticLanes(specs);

    setIsWriting(true);
    setMessage('');
    try {
      for (const spec of specs) {
        await writeMediaCompositionRecord({
          record: buildMediaCompositionEditDecisionRecord({
            action: 'add-track',
            label: `Add ${spec.label}`,
            parameters: { lane_role: spec.role, lane_label: spec.label, lane_tone: spec.tone },
            createdAt: now().toISOString(),
          }),
        });
      }
      setMessage(`Added ${specs.length} track${specs.length > 1 ? 's' : ''}.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] add tracks failed:', raw);
      setMessage('The tracks could not be added. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [composition.lanes, now]);

  const addFile = React.useCallback(async (file: File) => {
    setIsWriting(true);
    setMessage('');
    let previewUrl = '';
    try {
      const source: ContentMediaSourceRef = await stageContentMediaFile({
        packageName: 'media-composition',
        file,
      });
      const sourceId = mediaWorkspaceSourceIdForRef(source);
      previewUrl = URL.createObjectURL(file);
      addOptimisticMediaWorkspaceSource({
        source_id: sourceId,
        label: source.display_name,
        media_type: source.media_type,
        role: 'recorded_files',
        source_package: 'media-composition',
        source_ref: source,
        artifact_ref: source.artifact_ref,
      }, {
        url: previewUrl,
        mediaType: source.media_type,
        label: source.display_name,
      });
      await writeMediaCompositionRecord({
        record: buildMediaCompositionEditDecisionRecord({
          action: 'add-source',
          label: 'Add source',
          sourceRef: source,
          parameters: {
            media_type: source.media_type,
            display_name: source.display_name,
          },
          createdAt: now().toISOString(),
        }),
      });
      await writeSelectionForSourceRef(source);
      setSelectedSourceId(sourceId);
      setMessage(`${source.display_name} added.`);
      previewUrl = '';
    } catch (error) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[media-composition] add media failed:', raw);
      setMessage('The media could not be added. Please try again.');
    } finally {
      setIsWriting(false);
    }
  }, [now, writeSelectionForSourceRef]);

  React.useEffect(() => {
    if (!subjectRef || admittedSubjectAddresses.current.has(subjectRef.address)) return;
    const display = admittedSubject?.display;
    const file = fileFromSubjectHandle(
      admittedSubject?.handle,
      display?.name ?? 'media',
      display?.content_type ?? 'application/octet-stream',
    );
    if (!file) return;
    admittedSubjectAddresses.current.add(subjectRef.address);
    void addFile(file);
  }, [addFile, admittedSubject, subjectRef]);

  const outputAction = (
    <OpenSurfaceAction
      payload={CONTENT_PRODUCTION_SURFACE}
      label="Make content"
    />
  );

  const fileAction = (
    <FileWorkAction
      accept="audio/*,video/*,image/*"
      acceptsFile={(file) => file.type.startsWith('audio/') || file.type.startsWith('video/') || file.type.startsWith('image/')}
      pickFiles={() => chooseContentMediaFiles({
        prompt: 'Choose media files',
        multiple: true,
        allowedContentPrefixes: ['audio/', 'video/', 'image/'],
        allowedExtensions: [
          ...CONTENT_MEDIA_AUDIO_EXTENSIONS,
          ...CONTENT_MEDIA_VIDEO_EXTENSIONS,
          ...CONTENT_MEDIA_IMAGE_EXTENSIONS,
        ],
      }) as Promise<readonly File[]>}
      multiple
      busy={isWriting}
      emptyTitle="Pick or drop media"
      emptyDetail="Video, audio, or images."
      pickLabel="Pick media"
      startLabel="Use media"
      startWhenFilesAccepted
      showStartAction={false}
      rejectMessage="Choose a video, audio, or image file."
      onStart={addFile}
    />
  );

  const toolRail = (
    <MediaToolRail
      tools={MEDIA_TOOLS}
      selectedToolId={selectedToolId}
      onSelectTool={setSelectedToolId}
    />
  );

  const sourceRail = (
    <MediaSourceRail
      title="Choose media"
      sources={workspace.sources}
      selectedSourceId={selectedSourceId}
      sourceFamily={sourceFamily}
      sourceDetail={sourceDetail}
      onSelectSource={selectSource}
      fileAction={fileAction}
    />
  );

  const previewStage = (
    <MediaPreviewStage
      selectedSource={previewSource}
      selectedSourceDetail={selectedSourceDetail}
      modeLabel={aspectRatio}
      toolLabel={selectedTool?.label}
      videoRef={videoRef}
      liveTransform={liveTransform}
      isPlaying={isPlaying}
      currentTime={currentTime}
      duration={duration}
      onPlayPause={playPause}
      onSeek={seek}
      captions={[]}
      overlays={[]}
      preview={<Preview preview={selectedPreview} selectedSource={previewSource} videoRef={videoRef} />}
    />
  );

  const details = (
    <MediaDetailsPanel
      panels={workspace.panels}
      selectedPanel={selectedPanel}
      selectedSource={selectedSource}
      selectedSourceDetail={selectedSourceDetail}
      selectedToolLabel={selectedTool?.label ?? 'Select'}
      selectedToolDetail={selectedTool?.detail ?? 'Choose and move.'}
      aspectRatio={aspectRatio}
      framePreset={framePreset}
      position={position}
      keepAspectRatio={keepAspectRatio}
      controls={manualControls}
      editDecisions={workspace.editDecisions}
      markers={workspace.markers}
      blockers={workspace.blockers}
      message={message}
      proposalPrimaryAction={<Button variant="primary" size="sm" disabled={isWriting} onClick={() => void saveEdit('save-edit', 'Save edit')}>Save edit</Button>}
      proposalSecondaryAction={<Button variant="secondary" size="sm" disabled={isWriting} onClick={() => void addMarker()}>Mark</Button>}
      outputAction={outputAction}
      composition={composition}
      sources={workspace.sources}
      panelSummary={panelSummary}
      onSelectPanel={setSelectedPanelId}
      onFramePresetChange={setFramePreset}
      onPositionChange={setPosition}
      onKeepAspectRatioChange={setKeepAspectRatio}
      duckMusic={duckMusic}
      echo={echo}
      onEchoChange={setEcho}
      onDuckMusicChange={setDuckMusic}
      kenBurns={kenBurns}
      onKenBurnsChange={setKenBurns}
      reverse={reverse}
      onReverseChange={setReverse}
      freezeTail={freezeTail}
      onFreezeTailChange={setFreezeTail}
      greenScreen={greenScreen}
      onGreenScreenChange={setGreenScreen}
      shake={shake}
      setShake={setShake}
      stabilize={stabilize}
      onStabilizeChange={setStabilize}
      motionBlur={motionBlur}
      onMotionBlurChange={setMotionBlur}
      trails={trails}
      onTrailsChange={setTrails}
      wobble={wobble}
      onWobbleChange={setWobble}
      warmthRamp={warmthRamp}
      onWarmthRampChange={setWarmthRamp}
      strobe={strobe}
      onStrobeChange={setStrobe}
      scanlines={scanlines}
      onScanlinesChange={setScanlines}
      lensFringe={lensFringe}
      onLensFringeChange={setLensFringe}
      posterize={posterize}
      onPosterizeChange={setPosterize}
      halftone={halftone}
      onHalftoneChange={setHalftone}
      gradientMap={gradientMap}
      onGradientMapChange={setGradientMap}
      solarize={solarize}
      onSolarizeChange={setSolarize}
      pixelate={pixelate}
      onPixelateChange={setPixelate}
      grain={grain}
      onGrainChange={setGrain}
      emboss={emboss}
      onEmbossChange={setEmboss}
      defocus={defocus}
      onDefocusChange={setDefocus}
      fisheye={fisheye}
      onFisheyeChange={setFisheye}
      warmth={warmth}
      onWarmthChange={setWarmth}
      colorSplash={colorSplash}
      onColorSplashChange={setColorSplash}
      perspective={perspective}
      onPerspectiveChange={setPerspective}
      smooth={smooth}
      onSmoothChange={setSmooth}
      directionalBlur={directionalBlur}
      onDirectionalBlurChange={setDirectionalBlur}
      binarize={binarize}
      onBinarizeChange={setBinarize}
      swirl={swirl}
      onSwirlChange={setSwirl}
      mirror={mirror}
      onMirrorChange={setMirror}
      tile={tile}
      onTileChange={setTile}
      invert={invert}
      onInvertChange={setInvert}
      vibrance={vibrance}
      onVibranceChange={setVibrance}
      channelSwap={channelSwap}
      onChannelSwapChange={setChannelSwap}
      exposure={exposure}
      onExposureChange={setExposure}
      shear={shear}
      onShearChange={setShear}
      histeq={histeq}
      onHisteqChange={setHisteq}
      morphology={morphology}
      onMorphologyChange={setMorphology}
      colorize={colorize}
      onColorizeChange={setColorize}
      normalize={normalize}
      onNormalizeChange={setNormalize}
      chromaBleed={chromaBleed}
      onChromaBleedChange={setChromaBleed}
      rgbSplit={rgbSplit}
      onRgbSplitChange={setRgbSplit}
      monoMix={monoMix}
      onMonoMixChange={setMonoMix}
      tiltShift={tiltShift}
      onTiltShiftChange={setTiltShift}
      sketch={sketch}
      onSketchChange={setSketch}
      zoomBlur={zoomBlur}
      onZoomBlurChange={setZoomBlur}
      lightLeak={lightLeak}
      onLightLeakChange={setLightLeak}
      filmDamage={filmDamage}
      onFilmDamageChange={setFilmDamage}
      hueShift={hueShift}
      onHueShiftChange={setHueShift}
      glow={glow}
      onGlowChange={setGlow}
      dropShadow={dropShadow}
      onDropShadowChange={setDropShadow}
      borderColor={borderColor}
      onBorderColorChange={setBorderColor}
      frameBackground={frameBackground}
      onFrameBackgroundChange={setFrameBackground}
      duotone={duotone}
      onDuotoneChange={setDuotone}
      cornerBackground={cornerBackground}
      onCornerBackgroundChange={setCornerBackground}
      censorFilter={censorFilter}
      onCensorFilterChange={setCensorFilter}
      censorRegions={censorRegions}
      onAddCensorRegion={(filter) => setCensorRegions((prev) => {
        // stagger each added region across a 3x2 grid so stacked censors do not overlap.
        const spots = [
          { x: 0.06, y: 0.1 }, { x: 0.7, y: 0.1 }, { x: 0.06, y: 0.62 },
          { x: 0.7, y: 0.62 }, { x: 0.38, y: 0.36 }, { x: 0.38, y: 0.1 },
        ];
        const s = spots[prev.length % spots.length];
        return [...prev, { x: s.x, y: s.y, w: 0.24, h: 0.28, filter }];
      })}
      onClearCensorRegions={() => setCensorRegions([])}
      censorMotion={censorMotion}
      onCensorMotionChange={setCensorMotion}
      censorEase={censorEase}
      onCensorEaseChange={setCensorEase}
      censorFadeIn={censorFadeIn}
      onCensorFadeInChange={setCensorFadeIn}
      censorFadeOut={censorFadeOut}
      onCensorFadeOutChange={setCensorFadeOut}
      censorSpotlight={censorSpotlight}
      onCensorSpotlightChange={setCensorSpotlight}
      spotlightFollow={spotlightFollow}
      onSpotlightFollowChange={setSpotlightFollow}
      spotlightPulse={spotlightPulse}
      onSpotlightPulseChange={setSpotlightPulse}
      progressBar={progressBar}
      onProgressBarChange={setProgressBar}
      timer={timer}
      onTimerChange={setTimer}
      countdownRing={countdownRing}
      onCountdownRingChange={setCountdownRing}
      pulses={pulses}
      onPulsesChange={setPulses}
      letterbox={letterbox}
      onLetterboxChange={setLetterbox}
      scrim={scrim}
      onScrimChange={setScrim}
      highlightSweep={highlightSweep}
      onHighlightSweepChange={setHighlightSweep}
      ellipseMaskOn={ellipseMaskOn}
      onEllipseMaskOnChange={setEllipseMaskOn}
      irisReveal={irisReveal}
      onIrisRevealChange={setIrisReveal}
      splitTone={splitTone}
      onSplitToneChange={setSplitTone}
      rotateDegrees={rotateDegrees}
      onRotateDegreesChange={setRotateDegrees}
      clipFlip={clipFlip}
      onClipFlipChange={setClipFlip}
      splitCompareWith={splitCompareWith}
      onSplitCompareWithChange={setSplitCompareWith}
      splitLayout={splitLayout}
      onSplitLayoutChange={setSplitLayout}
      splitMirrorCompare={splitMirrorCompare}
      onSplitMirrorCompareChange={setSplitMirrorCompare}
      splitCompareOptions={workspace.sources.filter((s) => s.source_id !== selectedSourceId).map((s) => ({ id: s.source_id, label: s.label }))}
      smoothSlowmo={smoothSlowmo}
      onSmoothSlowmoChange={setSmoothSlowmo}
      pipCorner={pipCorner}
      onPipCornerChange={setPipCorner}
      pipCornerOptions={Object.keys(PIP_CORNER_CATALOG)}
      onAddPictureInPicture={() => void addPictureInPicture()}
      canAddPictureInPicture={!!selectedSource && !!selectedSource.artifact_ref?.stored_bytes_address_label}
      onAddBlurRegion={() => void addCensorRegion('blur')}
      onAddMosaicRegion={() => void addCensorRegion('mosaic')}
      canAddCensorRegion={!!selectedSource}
      onRemoveBackground={() => void addRemoveBackground()}
      canRemoveBackground={!!selectedSource && !!selectedSource.artifact_ref?.stored_bytes_address_label}
      onPunchIn={() => void punchIn()}
      canPunchIn={!!selectedSource}
      onLoopSegment={() => void loopSegment(false)}
      onBoomerangSegment={() => void loopSegment(true)}
      canLoopSegment={!!selectedSource}
      captionLang={captionLang}
      onCaptionLangChange={setCaptionLang}
      captionLangOptions={['es', 'fr', 'de', 'pt', 'ja', 'zh', 'hi', 'ar']}
      onTranslateCaptions={() => void translateCaptions(captionLang)}
      onClearCaptionTranslation={() => void translateCaptions('')}
      blendModeOptions={['screen', 'add', 'multiply', 'overlay', 'softlight', 'lighten']}
      onAddBlendOverlay={(mode) => void addBlendOverlay(mode)}
      canAddBlendOverlay={!!selectedSource && !!selectedSource.artifact_ref?.stored_bytes_address_label}
      loudnessPresets={[{ label: 'Social -14', lufs: -14 }, { label: 'Podcast -16', lufs: -16 }, { label: 'Broadcast -23', lufs: -23 }]}
      onNormalizeLoudness={(lufs) => void normalizeLoudness(lufs)}
      canNormalizeLoudness={!!selectedSource}
      audioVizOptions={['waveform', 'spectrum', 'bars', 'cqt']}
      onAddAudioViz={(viz) => void addAudioViz(viz)}
      autoReframe={autoReframe}
      onAutoReframeChange={setAutoReframe}
      reframeFill={reframeFill}
      onReframeFillChange={setReframeFill}
      reframeFillOptions={['crop', 'blur', 'black']}
      look={look}
      onLookChange={setLook}
      lookOptions={['none', ...Object.keys(LOOK_CATALOG)]}
      denoise={denoise}
      onDenoiseChange={setDenoise}
      denoiseOptions={['none', ...Object.keys(DENOISE_CATALOG)]}
      soundFx={soundFx}
      onSoundFxChange={setSoundFx}
      soundFxOptions={['none', ...Object.keys(AUDIO_FX_CATALOG)]}
      speedRamp={speedRampKey}
      onSpeedRampChange={setSpeedRampKey}
      speedRampOptions={['none', ...Object.keys(SPEED_RAMP_CATALOG)]}
      speedRampAudio={speedRampAudio}
      onSpeedRampAudioChange={setSpeedRampAudio}
      adjustmentLayer={adjustmentLayer}
      onAdjustmentLayerChange={setAdjustmentLayer}
      onDetachAudio={() => void detachAudio()}
      canDetachAudio={!!selectedSource}
      onAutoCleanup={() => void autoCleanup()}
      canAutoCleanup={transcriptWords.length > 0}
      onAddCaptions={() => void addCaptions()}
      canAddCaptions={!!selectedSource && transcriptWords.length > 0}
      captionKaraoke={captionKaraoke}
      onCaptionKaraokeChange={setCaptionKaraoke}
      onBeatSync={() => void beatSync()}
      canBeatSync={!!selectedSource && (selectedSource.media_type.startsWith('audio/') || selectedSource.media_type.startsWith('video/'))}
      onSceneSplit={() => void sceneSplit()}
      canSceneSplit={!!selectedSource && selectedSource.media_type.startsWith('video/')}
      onMakeHighlight={() => void makeHighlight()}
      canMakeHighlight={!!selectedSource && (selectedSource.media_type.startsWith('audio/') || selectedSource.media_type.startsWith('video/'))}
      onAddNarration={() => void addNarration()}
      canAddNarration={composition.durationSeconds > 0}
      onTrackSubject={() => void trackSubject()}
      canTrackSubject={!!selectedSource && selectedSource.media_type.startsWith('video/')}
      onCloseGaps={() => void closeGaps()}
      onRippleTrim={() => setRippleMode((v) => !v)}
      canRippleTrim={!!selectedSource}
      rippleActive={rippleMode}
      onControlChange={setManualControl}
      onResetControl={resetManualControl}
      liveTransform={liveTransform}
      onCommitTransform={() => void commitTransform()}
    />
  );

  if (surfacePart === 'choose-media') {
    return <ScrollableSurface>{sourceRail}</ScrollableSurface>;
  }

  if (surfacePart === 'preview-media') {
    // The preview is a FILL surface, not a scroll surface: the video/photo stage
    // must claim the full height and width of its pane (and grow as the pane is
    // stretched), so it lives in a full-height flex column, never a scroll viewport
    // that collapses to intrinsic content height.
    return (
      <Container layout="vertical" flex={1} height="full" minHeight="0" width="full" padding="lg">
        {previewStage}
      </Container>
    );
  }

  if (surfacePart === 'edit-timeline') {
    return (
      <ScrollableSurface>
        <Card variant="surface" padding="md">
          <EditTimeline
            composition={composition}
            transcriptWords={transcriptWords}
            playheadPct={playheadPct}
            currentTime={currentTime}
            selectedClipId={selectedClipId}
            paramSource={paramSource}
            peaksBySource={peaksBySource}
            disabled={isWriting}
            onSeek={seek}
            onSelectClip={setSelectedClipId}
            onRunOp={(action) => void runOp(action)}
            onRunRuleset={(name) => void runRuleset(name)}
            onRemoveSpan={(start, end) => void removeSpan(start, end)}
            onTrim={(id, inPoint, outPoint) => void trimClip(id, inPoint, outPoint)}
            onAddTracks={(videoCount, audioCount) => void addTracks(videoCount, audioCount)}
          />
        </Card>
      </ScrollableSurface>
    );
  }

  if (surfacePart === 'change-media') {
    return <ScrollableSurface>{details}</ScrollableSurface>;
  }

  if (surfacePart === 'choose-tool') {
    return <ScrollableSurface>{toolRail}</ScrollableSurface>;
  }

  return (
    <EmbeddedScreenArrangement
      initialState={MEDIA_EDITOR_LAYOUT_STATE}
      layoutEntryInput={MEDIA_EDITOR_LAYOUT_STATE_INPUT}
      placeableSurfaceListAddressLabel="placeable-surface-list::media-workspace"
      persistence={{ valueAddressLabel: MEDIA_EDITOR_LAYOUT_STATE_ADDRESS_LABEL }}
      acceptPersistedState={acceptsMediaEditorLayoutState}
      // Show the per-container new-tab "+" so authorized media surfaces (scoped to
      // placeable-surface-list::media-workspace, NOT the studio's main list) can always
      // be re-added after a close, preventing the stranded/empty-workspace dead end.
      chrome={{ 'header.new-tab': true }}
    />
  );
}
