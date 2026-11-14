import * as React from 'react';

import type { ClipTransform, MaterializedComposition } from '../../read-data/compose-timeline';
import type {
  MediaCompositionEditDecision,
  MediaCompositionMarker,
  MediaWorkspacePanel,
  MediaWorkspaceSource,
} from '../../read-data/read-media-workspace';
import { Badge } from '../../../ui/show/badge';
import { Button } from '../../../ui/show/button';
import { Card } from '../../../ui/show/card';
import { Container } from '../../../ui/show/container';
import { PositionGrid } from '../../../ui/show/position-grid';
import { SegmentedControl } from '../../../ui/show/segmented-control';
import { ScrollableSurface } from '../../../ui/show/scrollable-surface';
import { Slider } from '../../../ui/show/slider';
import { Text } from '../../../ui/show/text';
import { Toggle } from '../../../ui/show/toggle';

import { MediaNextAction } from './MediaNextAction';
import { MediaOutputPanel } from './MediaOutputPanel';

export type MediaManualControlValues = Record<string, number>;

export type MediaDetailsPanelProps = {
  panels: MediaWorkspacePanel[];
  selectedPanel?: MediaWorkspacePanel;
  selectedSource?: MediaWorkspaceSource;
  selectedSourceDetail?: string;
  selectedToolLabel: string;
  selectedToolDetail: string;
  aspectRatio: string;
  framePreset: string;
  position: string;
  keepAspectRatio: boolean;
  controls: MediaManualControlValues;
  editDecisions: MediaCompositionEditDecision[];
  markers: MediaCompositionMarker[];
  blockers: unknown[];
  message?: string;
  proposalPrimaryAction: React.ReactNode;
  proposalSecondaryAction?: React.ReactNode;
  outputAction?: React.ReactNode;
  panelSummary: (panel: MediaWorkspacePanel) => string;
  onSelectPanel: (panelId: string) => void;
  onFramePresetChange: (value: string) => void;
  onPositionChange: (value: string) => void;
  onKeepAspectRatioChange: (value: boolean) => void;
  duckMusic: boolean;
  echo: boolean;
  onEchoChange: (value: boolean) => void;
  onDuckMusicChange: (value: boolean) => void;
  kenBurns: boolean;
  onKenBurnsChange: (value: boolean) => void;
  autoReframe: boolean;
  onAutoReframeChange: (value: boolean) => void;
  reframeFill: string;
  onReframeFillChange: (value: string) => void;
  reframeFillOptions: string[];
  look: string;
  onLookChange: (value: string) => void;
  lookOptions: string[];
  denoise: string;
  onDenoiseChange: (value: string) => void;
  denoiseOptions: string[];
  soundFx: string;
  onSoundFxChange: (value: string) => void;
  soundFxOptions: string[];
  speedRamp: string;
  onSpeedRampChange: (value: string) => void;
  speedRampOptions: string[];
  speedRampAudio: boolean;
  onSpeedRampAudioChange: (value: boolean) => void;
  adjustmentLayer: boolean;
  onAdjustmentLayerChange: (value: boolean) => void;
  reverse: boolean;
  onReverseChange: (value: boolean) => void;
  freezeTail: boolean;
  onFreezeTailChange: (value: boolean) => void;
  greenScreen: boolean;
  onGreenScreenChange: (value: boolean) => void;
  stabilize: boolean;
  onStabilizeChange: (value: boolean) => void;
  motionBlur: boolean;
  onMotionBlurChange: (value: boolean) => void;
  trails: boolean;
  onTrailsChange: (value: boolean) => void;
  wobble: boolean;
  onWobbleChange: (value: boolean) => void;
  warmthRamp: boolean;
  onWarmthRampChange: (value: boolean) => void;
  strobe: boolean;
  onStrobeChange: (value: boolean) => void;
  scanlines: boolean;
  onScanlinesChange: (value: boolean) => void;
  lensFringe: boolean;
  onLensFringeChange: (value: boolean) => void;
  posterize: boolean;
  onPosterizeChange: (value: boolean) => void;
  halftone: boolean;
  onHalftoneChange: (value: boolean) => void;
  gradientMap: boolean;
  onGradientMapChange: (value: boolean) => void;
  solarize: boolean;
  onSolarizeChange: (value: boolean) => void;
  pixelate: boolean;
  onPixelateChange: (value: boolean) => void;
  grain: boolean;
  onGrainChange: (value: boolean) => void;
  emboss: boolean;
  onEmbossChange: (value: boolean) => void;
  defocus: boolean;
  onDefocusChange: (value: boolean) => void;
  fisheye: boolean;
  onFisheyeChange: (value: boolean) => void;
  warmth: boolean;
  onWarmthChange: (value: boolean) => void;
  colorSplash: boolean;
  onColorSplashChange: (value: boolean) => void;
  perspective: boolean;
  onPerspectiveChange: (value: boolean) => void;
  smooth: boolean;
  onSmoothChange: (value: boolean) => void;
  directionalBlur: boolean;
  onDirectionalBlurChange: (value: boolean) => void;
  binarize: boolean;
  onBinarizeChange: (value: boolean) => void;
  swirl: boolean;
  onSwirlChange: (value: boolean) => void;
  mirror: boolean;
  onMirrorChange: (value: boolean) => void;
  tile: boolean;
  onTileChange: (value: boolean) => void;
  invert: boolean;
  onInvertChange: (value: boolean) => void;
  vibrance: boolean;
  onVibranceChange: (value: boolean) => void;
  channelSwap: boolean;
  onChannelSwapChange: (value: boolean) => void;
  exposure: boolean;
  onExposureChange: (value: boolean) => void;
  shear: boolean;
  onShearChange: (value: boolean) => void;
  histeq: boolean;
  onHisteqChange: (value: boolean) => void;
  morphology: boolean;
  onMorphologyChange: (value: boolean) => void;
  colorize: boolean;
  onColorizeChange: (value: boolean) => void;
  normalize: boolean;
  onNormalizeChange: (value: boolean) => void;
  chromaBleed: boolean;
  onChromaBleedChange: (value: boolean) => void;
  rgbSplit: boolean;
  onRgbSplitChange: (value: boolean) => void;
  monoMix: boolean;
  onMonoMixChange: (value: boolean) => void;
  tiltShift: boolean;
  onTiltShiftChange: (value: boolean) => void;
  sketch: boolean;
  onSketchChange: (value: boolean) => void;
  zoomBlur: boolean;
  onZoomBlurChange: (value: boolean) => void;
  lightLeak: boolean;
  onLightLeakChange: (value: boolean) => void;
  filmDamage: boolean;
  onFilmDamageChange: (value: boolean) => void;
  hueShift: boolean;
  onHueShiftChange: (value: boolean) => void;
  shake: { amplitude: number; frequency?: number; decay?: number } | null;
  setShake: (value: { amplitude: number; frequency?: number; decay?: number } | null) => void;
  glow: boolean;
  onGlowChange: (value: boolean) => void;
  dropShadow: boolean;
  onDropShadowChange: (value: boolean) => void;
  borderColor: string;
  onBorderColorChange: (value: string) => void;
  frameBackground: string;
  onFrameBackgroundChange: (value: string) => void;
  duotone: { shadow: string; highlight: string } | null;
  onDuotoneChange: (value: { shadow: string; highlight: string } | null) => void;
  cornerBackground: string;
  onCornerBackgroundChange: (value: string) => void;
  censorFilter: string;
  onCensorFilterChange: (value: string) => void;
  censorRegions: Array<{ x: number; y: number; w: number; h: number; filter: string }>;
  onAddCensorRegion: (filter: string) => void;
  onClearCensorRegions: () => void;
  censorMotion: '' | 'pan' | 'bounce' | 'orbit';
  onCensorMotionChange: (value: '' | 'pan' | 'bounce' | 'orbit') => void;
  censorEase: '' | 'smooth' | 'in' | 'out';
  onCensorEaseChange: (value: '' | 'smooth' | 'in' | 'out') => void;
  censorFadeIn: boolean;
  onCensorFadeInChange: (value: boolean) => void;
  censorFadeOut: boolean;
  onCensorFadeOutChange: (value: boolean) => void;
  censorSpotlight: boolean;
  onCensorSpotlightChange: (value: boolean) => void;
  spotlightFollow: boolean;
  onSpotlightFollowChange: (value: boolean) => void;
  spotlightPulse: boolean;
  onSpotlightPulseChange: (value: boolean) => void;
  progressBar: { height: number; color: string; edge: 'top' | 'bottom'; markers?: number[]; markerColor?: string } | null;
  onProgressBarChange: (value: { height: number; color: string; edge: 'top' | 'bottom'; markers?: number[]; markerColor?: string } | null) => void;
  timer: { mode: 'elapsed' | 'countdown'; corner: 'tl' | 'tr' | 'bl' | 'br'; color: string } | null;
  onTimerChange: (value: { mode: 'elapsed' | 'countdown'; corner: 'tl' | 'tr' | 'bl' | 'br'; color: string } | null) => void;
  countdownRing: { radius?: number; thickness?: number; color?: string; x?: number; y?: number; mode?: 'fill' | 'deplete' } | null;
  onCountdownRingChange: (value: { radius?: number; thickness?: number; color?: string; x?: number; y?: number; mode?: 'fill' | 'deplete' } | null) => void;
  pulses: Array<{ at: number; strength?: number; duration?: number; kind?: 'flash' | 'punch' | 'shake' | 'glitch' | 'tint'; color?: string }> | null;
  onPulsesChange: (value: Array<{ at: number; strength?: number; duration?: number; kind?: 'flash' | 'punch' | 'shake' | 'glitch' | 'tint'; color?: string }> | null) => void;
  letterbox: { aspect?: number; color?: string } | null;
  onLetterboxChange: (value: { aspect?: number; color?: string } | null) => void;
  scrim: { edge?: 'top' | 'bottom' | 'left' | 'right'; strength?: number; color?: string } | null;
  onScrimChange: (value: { edge?: 'top' | 'bottom' | 'left' | 'right'; strength?: number; color?: string } | null) => void;
  highlightSweep: { x: number; y: number; w: number; h: number; color?: string; opacity?: number; start?: number; duration?: number } | null;
  onHighlightSweepChange: (value: { x: number; y: number; w: number; h: number; color?: string; opacity?: number; start?: number; duration?: number } | null) => void;
  ellipseMaskOn: boolean;
  onEllipseMaskOnChange: (value: boolean) => void;
  irisReveal: boolean;
  onIrisRevealChange: (value: boolean) => void;
  splitTone: { shadows: { r: number; g: number; b: number }; mids: { r: number; g: number; b: number }; highlights: { r: number; g: number; b: number } } | null;
  onSplitToneChange: (value: { shadows: { r: number; g: number; b: number }; mids: { r: number; g: number; b: number }; highlights: { r: number; g: number; b: number } } | null) => void;
  rotateDegrees: number;
  onRotateDegreesChange: (value: number) => void;
  clipFlip: string;
  onClipFlipChange: (value: string) => void;
  /** Split-screen / compare: the source_id of a second source to tile beside this clip (null = off). */
  splitCompareWith: string | null;
  onSplitCompareWithChange: (value: string | null) => void;
  splitLayout: 'h' | 'v' | 'grid';
  onSplitLayoutChange: (value: 'h' | 'v' | 'grid') => void;
  /** Mirror the compare cell so both sources face the same way (lefty/righty, opposite angle). */
  splitMirrorCompare: boolean;
  onSplitMirrorCompareChange: (value: boolean) => void;
  /** Other sources available to compare against (this clip's own source excluded). */
  splitCompareOptions: Array<{ id: string; label: string }>;
  smoothSlowmo: boolean;
  onSmoothSlowmoChange: (value: boolean) => void;
  pipCorner: string;
  onPipCornerChange: (value: string) => void;
  pipCornerOptions: string[];
  onAddPictureInPicture: () => void;
  canAddPictureInPicture: boolean;
  onAddBlurRegion: () => void;
  onAddMosaicRegion: () => void;
  canAddCensorRegion: boolean;
  onRemoveBackground: () => void;
  canRemoveBackground: boolean;
  onPunchIn: () => void;
  canPunchIn: boolean;
  onLoopSegment: () => void;
  onBoomerangSegment: () => void;
  canLoopSegment: boolean;
  captionLang: string;
  onCaptionLangChange: (value: string) => void;
  captionLangOptions: string[];
  onTranslateCaptions: () => void;
  onClearCaptionTranslation: () => void;
  blendModeOptions: string[];
  onAddBlendOverlay: (mode: string) => void;
  canAddBlendOverlay: boolean;
  audioVizOptions: string[];
  onAddAudioViz: (viz: string) => void;
  loudnessPresets: { label: string; lufs: number }[];
  onNormalizeLoudness: (lufs: number) => void;
  canNormalizeLoudness: boolean;
  onDetachAudio: () => void;
  canDetachAudio: boolean;
  onAddCaptions: () => void;
  canAddCaptions: boolean;
  captionKaraoke: boolean;
  onCaptionKaraokeChange: (value: boolean) => void;
  onAutoCleanup: () => void;
  canAutoCleanup: boolean;
  onBeatSync: () => void;
  canBeatSync: boolean;
  onSceneSplit: () => void;
  canSceneSplit: boolean;
  onMakeHighlight: () => void;
  canMakeHighlight: boolean;
  onAddNarration: () => void;
  canAddNarration: boolean;
  onTrackSubject: () => void;
  canTrackSubject: boolean;
  onCloseGaps: () => void;
  onRippleTrim: () => void;
  canRippleTrim: boolean;
  rippleActive: boolean;
  onControlChange: (key: string, value: number) => void;
  onResetControl: (key: string) => void;
  liveTransform: ClipTransform;
  onCommitTransform: () => void;
  composition?: MaterializedComposition;
  sources?: MediaWorkspaceSource[];
};

const FRAME_PRESETS = [
  { id: 'fit', label: 'Fit' },
  { id: 'fill', label: 'Fill' },
  { id: 'crop', label: 'Crop' },
];

const CONTROL_DESCRIPTORS = [
  { key: 'width', label: 'Width', min: 10, max: 200, unit: '%' },
  { key: 'height', label: 'Height', min: 10, max: 200, unit: '%' },
  { key: 'padding', label: 'Padding', min: 0, max: 80, unit: '' },
  { key: 'inset', label: 'Inset', min: 0, max: 80, unit: '' },
  { key: 'corners', label: 'Corners', min: 0, max: 80, unit: '' },
  { key: 'stroke', label: 'Stroke', min: 0, max: 20, unit: '' },
  { key: 'shadow', label: 'Shadow', min: 0, max: 100, unit: '' },
  // Temporal + audio controls. Percent sliders stay integer-friendly; liveTransform
  // converts speed_pct/volume_pct to the ClipTransform multiplier (speed/volume) and
  // fade_in_s/fade_out_s to seconds. 25% speed = quarter-speed slow-mo, 400% = 4x.
  { key: 'speed_pct', label: 'Speed', min: 25, max: 400, unit: '%' },
  { key: 'volume_pct', label: 'Volume', min: 0, max: 200, unit: '%' },
  { key: 'fade_in_s', label: 'Fade in', min: 0, max: 5, unit: 's' },
  { key: 'fade_out_s', label: 'Fade out', min: 0, max: 5, unit: 's' },
  // #120 Manual crop / zoom rect (percent of the source frame). w/h default 100 = full frame; drop
  // below 100 or move x/y > 0 to crop a region, which the render scales up to fill (crop = zoom).
  { key: 'crop_x', label: 'Crop X', min: 0, max: 100, unit: '%' },
  { key: 'crop_y', label: 'Crop Y', min: 0, max: 100, unit: '%' },
  { key: 'crop_w', label: 'Crop width', min: 10, max: 100, unit: '%' },
  { key: 'crop_h', label: 'Crop height', min: 10, max: 100, unit: '%' },
  // #121 Manual color adjust (the daily-driver "Adjust" panel). 0 / 100% are identity; assembled into
  // t.colorAdjust and applied as an eq= after any preset look, so a look and a manual tweak stack.
  { key: 'adj_brightness', label: 'Brightness', min: -100, max: 100, unit: '%' },
  { key: 'adj_contrast', label: 'Contrast', min: 0, max: 200, unit: '%' },
  { key: 'adj_saturation', label: 'Saturation', min: 0, max: 200, unit: '%' },
  { key: 'adj_gamma', label: 'Gamma', min: 10, max: 300, unit: '%' },
  // #122 Self-glow / bloom intensity (only applied when the Glow toggle is on).
  { key: 'glow_strength', label: 'Glow strength', min: 0, max: 100, unit: '%' },
  // #123 Sharpen / clarity (unsharp mask on luma). 0 = off.
  { key: 'sharpen', label: 'Sharpen', min: 0, max: 100, unit: '%' },
  // #124 Border / frame thickness (px). 0 = no border; the color is chosen by the preset buttons.
  { key: 'border_width', label: 'Border', min: 0, max: 40, unit: 'px' },
  // #125 Spotlight / positioned radial focus: center X/Y (percent) + strength (0 = off).
  { key: 'spotlight_x', label: 'Spotlight X', min: 0, max: 100, unit: '%' },
  { key: 'spotlight_y', label: 'Spotlight Y', min: 0, max: 100, unit: '%' },
  { key: 'spotlight_strength', label: 'Spotlight', min: 0, max: 100, unit: '%' },
  // #126 Framed clip: scale below 100% shrinks the clip onto the chosen background.
  { key: 'frame_scale', label: 'Frame scale', min: 40, max: 100, unit: '%' },
  // #128 Rounded corners: radius as a percent of the shorter side (0 = square; the color is a preset).
  { key: 'corner_radius', label: 'Rounded corners', min: 0, max: 50, unit: '%' },
  // #133 Corner feather: soft corner arc as a percent of the radius (0 = hard; needs a Rounded corners radius).
  { key: 'corner_feather', label: 'Corner softness', min: 0, max: 100, unit: '%' },
  // #132 Oval-mask feather: soft edge as a percent of the radius (0 = hard edge; needs the Oval mask on).
  { key: 'ellipse_feather', label: 'Oval feather', min: 0, max: 100, unit: '%' },
  // #134 Card corner: rounds the floating card (needs the Drop shadow toggle on) for the Screen Studio look.
  { key: 'card_corner', label: 'Card corner', min: 0, max: 50, unit: '%' },
];

/** #126 Framed-clip background presets (DATA: label + value). 'blur' fills the bars with a blurred copy. */
const FRAME_BACKGROUNDS: { label: string; value: string }[] = [
  { label: 'Black', value: 'black' },
  { label: 'White', value: 'white' },
  { label: 'Blur', value: 'blur' },
];

/** #127 Duotone preset pairs (DATA: label + shadow/highlight hex). A custom pair is DATA-authorable. */
const DUOTONE_PRESETS: { label: string; shadow: string; highlight: string }[] = [
  { label: 'Blue / Pink', shadow: '#0b1e6b', highlight: '#ff5ea8' },
  { label: 'Teal / Orange', shadow: '#053b45', highlight: '#ffb347' },
  { label: 'Purple / Yellow', shadow: '#2a0b52', highlight: '#ffe14d' },
  { label: 'Mono', shadow: '#111111', highlight: '#f5f5f5' },
];

/** #136 Split-tone presets (DATA: label + a 3-way color-balance grade). Cinematic teal-orange etc. The
 *  render is fully generic (any -1..1 push per band/channel); the AI worker can author arbitrary grades. */
type SplitToneValue = { shadows: { r: number; g: number; b: number }; mids: { r: number; g: number; b: number }; highlights: { r: number; g: number; b: number } };
const zeroBand = () => ({ r: 0, g: 0, b: 0 });
const SPLIT_TONE_PRESETS: { label: string; value: SplitToneValue }[] = [
  { label: 'Teal / Orange', value: { shadows: { r: -0.3, g: 0.15, b: 0.4 }, mids: zeroBand(), highlights: { r: 0.4, g: 0.1, b: -0.3 } } },
  { label: 'Warm film', value: { shadows: { r: 0.1, g: 0.05, b: -0.15 }, mids: { r: 0.1, g: 0, b: -0.05 }, highlights: { r: 0.2, g: 0.1, b: -0.1 } } },
  { label: 'Cool moody', value: { shadows: { r: -0.2, g: 0, b: 0.3 }, mids: zeroBand(), highlights: { r: -0.1, g: 0, b: 0.2 } } },
];

/** #130 Censor presets (DATA: label + opaque ffmpeg filter); applied to a centered region. The render is
 *  fully generic (any filter), so the AI worker can author arbitrary region + effect via set-transform. */
const CENSOR_PRESETS: { label: string; value: string }[] = [
  { label: 'Blur', value: 'gblur=sigma=16' },
  { label: 'Pixelate', value: 'pixelize=w=16:h=16' },
  { label: 'Blackout', value: 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill' },
];

/** #128 Rounded-corner background presets (DATA: label + color); the cut corners are filled with this. */
const CORNER_BACKGROUNDS: { label: string; value: string }[] = [
  { label: 'Black', value: 'black' },
  { label: 'White', value: 'white' },
  { label: 'Gray', value: 'gray' },
];

/** #124 Border color presets (DATA: label + ffmpeg color value), for the border color picker. */
const BORDER_COLORS: { label: string; value: string }[] = [
  { label: 'White', value: 'white' },
  { label: 'Black', value: 'black' },
  { label: 'Red', value: 'red' },
  { label: 'Yellow', value: 'yellow' },
];

function positionLabel(position: string): string {
  if (position === '2:2') return 'Center';
  const [row = '0', column = '0'] = position.split(':');
  return `${Number(row) + 1}, ${Number(column) + 1}`;
}

/** Toggle one mirror axis in/out of the flip string ('' | 'h' | 'v' | 'hv'). */
function toggleFlipAxis(current: string, axis: 'h' | 'v'): string {
  const has = current === axis || current === 'hv';
  const other = axis === 'h' ? 'v' : 'h';
  const keepOther = current === other || current === 'hv';
  if (has) return keepOther ? other : '';
  return keepOther ? 'hv' : axis;
}

export function MediaDetailsPanel({
  panels,
  selectedPanel,
  selectedSource,
  selectedSourceDetail,
  selectedToolLabel,
  selectedToolDetail,
  aspectRatio,
  framePreset,
  position,
  keepAspectRatio,
  duckMusic,
  echo,
  onEchoChange,
  onDuckMusicChange,
  kenBurns,
  onKenBurnsChange,
  autoReframe,
  onAutoReframeChange,
  reframeFill,
  onReframeFillChange,
  reframeFillOptions,
  look,
  onLookChange,
  lookOptions,
  denoise,
  onDenoiseChange,
  denoiseOptions,
  soundFx,
  onSoundFxChange,
  soundFxOptions,
  speedRamp,
  onSpeedRampChange,
  speedRampOptions,
  speedRampAudio,
  onSpeedRampAudioChange,
  adjustmentLayer,
  onAdjustmentLayerChange,
  reverse,
  onReverseChange,
  freezeTail,
  onFreezeTailChange,
  greenScreen,
  onGreenScreenChange,
  stabilize,
  onStabilizeChange,
  motionBlur,
  onMotionBlurChange,
  trails,
  onTrailsChange,
  wobble,
  onWobbleChange,
  warmthRamp,
  onWarmthRampChange,
  strobe,
  onStrobeChange,
  scanlines,
  onScanlinesChange,
  lensFringe,
  onLensFringeChange,
  posterize,
  onPosterizeChange,
  halftone,
  onHalftoneChange,
  gradientMap,
  onGradientMapChange,
  solarize,
  onSolarizeChange,
  pixelate,
  onPixelateChange,
  grain,
  onGrainChange,
  emboss,
  onEmbossChange,
  defocus,
  onDefocusChange,
  fisheye,
  onFisheyeChange,
  warmth,
  onWarmthChange,
  colorSplash,
  onColorSplashChange,
  perspective,
  onPerspectiveChange,
  smooth,
  onSmoothChange,
  directionalBlur,
  onDirectionalBlurChange,
  binarize,
  onBinarizeChange,
  swirl,
  onSwirlChange,
  mirror,
  onMirrorChange,
  tile,
  onTileChange,
  invert,
  onInvertChange,
  vibrance,
  onVibranceChange,
  channelSwap,
  onChannelSwapChange,
  exposure,
  onExposureChange,
  shear,
  onShearChange,
  histeq,
  onHisteqChange,
  morphology,
  onMorphologyChange,
  colorize,
  onColorizeChange,
  normalize,
  onNormalizeChange,
  chromaBleed,
  onChromaBleedChange,
  rgbSplit,
  onRgbSplitChange,
  monoMix,
  onMonoMixChange,
  tiltShift,
  onTiltShiftChange,
  sketch,
  onSketchChange,
  zoomBlur,
  onZoomBlurChange,
  lightLeak,
  onLightLeakChange,
  filmDamage,
  onFilmDamageChange,
  hueShift,
  onHueShiftChange,
  shake,
  setShake,
  glow,
  onGlowChange,
  dropShadow,
  onDropShadowChange,
  borderColor,
  onBorderColorChange,
  frameBackground,
  onFrameBackgroundChange,
  duotone,
  onDuotoneChange,
  cornerBackground,
  onCornerBackgroundChange,
  censorFilter,
  onCensorFilterChange,
  censorRegions,
  onAddCensorRegion,
  onClearCensorRegions,
  censorMotion,
  onCensorMotionChange,
  censorEase,
  onCensorEaseChange,
  censorFadeIn,
  onCensorFadeInChange,
  censorFadeOut,
  onCensorFadeOutChange,
  censorSpotlight,
  onCensorSpotlightChange,
  spotlightFollow,
  onSpotlightFollowChange,
  spotlightPulse,
  onSpotlightPulseChange,
  progressBar,
  onProgressBarChange,
  countdownRing,
  onCountdownRingChange,
  pulses,
  onPulsesChange,
  letterbox,
  onLetterboxChange,
  scrim,
  onScrimChange,
  highlightSweep,
  onHighlightSweepChange,
  timer,
  onTimerChange,
  ellipseMaskOn,
  onEllipseMaskOnChange,
  irisReveal,
  onIrisRevealChange,
  splitTone,
  onSplitToneChange,
  rotateDegrees,
  onRotateDegreesChange,
  clipFlip,
  onClipFlipChange,
  splitCompareWith,
  onSplitCompareWithChange,
  splitLayout,
  onSplitLayoutChange,
  splitMirrorCompare,
  onSplitMirrorCompareChange,
  splitCompareOptions,
  smoothSlowmo,
  onSmoothSlowmoChange,
  pipCorner,
  onPipCornerChange,
  pipCornerOptions,
  onAddPictureInPicture,
  canAddPictureInPicture,
  onAddBlurRegion,
  onAddMosaicRegion,
  canAddCensorRegion,
  onRemoveBackground,
  canRemoveBackground,
  onPunchIn,
  canPunchIn,
  onLoopSegment,
  onBoomerangSegment,
  canLoopSegment,
  captionLang,
  onCaptionLangChange,
  captionLangOptions,
  onTranslateCaptions,
  onClearCaptionTranslation,
  blendModeOptions,
  onAddBlendOverlay,
  canAddBlendOverlay,
  audioVizOptions,
  onAddAudioViz,
  loudnessPresets,
  onNormalizeLoudness,
  canNormalizeLoudness,
  captionKaraoke,
  onCaptionKaraokeChange,
  onDetachAudio,
  canDetachAudio,
  onAddCaptions,
  canAddCaptions,
  onBeatSync,
  canBeatSync,
  onSceneSplit,
  canSceneSplit,
  onMakeHighlight,
  canMakeHighlight,
  onAddNarration,
  canAddNarration,
  onTrackSubject,
  canTrackSubject,
  onCloseGaps,
  onRippleTrim,
  canRippleTrim,
  rippleActive,
  onAutoCleanup,
  canAutoCleanup,
  controls,
  editDecisions,
  markers,
  blockers,
  message,
  proposalPrimaryAction,
  proposalSecondaryAction,
  outputAction,
  panelSummary,
  onSelectPanel,
  onFramePresetChange,
  onPositionChange,
  onKeepAspectRatioChange,
  onControlChange,
  onResetControl,
  liveTransform: _liveTransform,
  onCommitTransform,
  composition,
  sources,
}: MediaDetailsPanelProps) {
  return (
    <Card variant="surface" padding="md" layout="stack">
      <Container layout="horizontal" justifyContent="between" alignItems="center">
        <Container layout="vertical" gap="xs">
          <Text variant="heading-lg">Controls</Text>
          <Text variant="body-xs" color="faint">{selectedToolLabel}</Text>
        </Container>
        <Badge size="lg" variant="neutral">{aspectRatio}</Badge>
      </Container>

      <MediaNextAction
        title={selectedSource ? 'Ready to edit' : 'Add media first'}
        detail={selectedSource ? selectedToolDetail : 'Pick or drop a video, audio file, or image to start.'}
        ready={!!selectedSource}
        primaryAction={proposalPrimaryAction}
        secondaryAction={proposalSecondaryAction}
      />

      <Card variant="nested" padding="sm">
        <Container layout="vertical" gap="sm">
          <Container layout="horizontal" justifyContent="between" alignItems="center">
            <Text variant="body" weight="semibold">Frame</Text>
            <Text variant="body-xs" color="faint">{selectedSource ? selectedSource.label : 'No media'}</Text>
          </Container>
          <SegmentedControl
            ariaLabel="Frame preset"
            items={FRAME_PRESETS}
            value={framePreset}
            onValueChange={onFramePresetChange}
            className="w-full"
          />
          <PositionGrid
            label="Position"
            value={position}
            valueLabel={positionLabel(position)}
            onValueChange={onPositionChange}
          />
          <Toggle
            label="Keep aspect ratio"
            checked={keepAspectRatio}
            onCheckedChange={onKeepAspectRatioChange}
          />
          <Toggle
            label="Duck music under speech"
            checked={duckMusic}
            onCheckedChange={onDuckMusicChange}
          />
          <Toggle
            label="Echo (add room / space to the audio)"
            checked={echo}
            onCheckedChange={onEchoChange}
          />
          <Toggle
            label="Ken Burns zoom"
            checked={kenBurns}
            onCheckedChange={onKenBurnsChange}
          />
          <Toggle
            label="Reverse (play backward)"
            checked={reverse}
            onCheckedChange={onReverseChange}
          />
          <Toggle
            label="Freeze last frame (1s)"
            checked={freezeTail}
            onCheckedChange={onFreezeTailChange}
          />
          <Toggle
            label="Green screen (key out background)"
            checked={greenScreen}
            onCheckedChange={onGreenScreenChange}
          />
          <Toggle
            label="Stabilize (deshake)"
            checked={stabilize}
            onCheckedChange={onStabilizeChange}
          />
          <Toggle
            label="Motion blur (blend fast motion)"
            checked={motionBlur}
            onCheckedChange={onMotionBlurChange}
          />
          <Toggle
            label="Trails (echo / light trails that linger)"
            checked={trails}
            onCheckedChange={onTrailsChange}
          />
          <Toggle
            label="Wobble (underwater / dream wave warp)"
            checked={wobble}
            onCheckedChange={onWobbleChange}
          />
          <Toggle
            label="Warmth ramp (warm to cool over the clip)"
            checked={warmthRamp}
            onCheckedChange={onWarmthRampChange}
          />
          <Toggle
            label="Stop-motion (choppy strobe motion)"
            checked={strobe}
            onCheckedChange={onStrobeChange}
          />
          <Toggle
            label="Scanlines (CRT / retro TV lines)"
            checked={scanlines}
            onCheckedChange={onScanlinesChange}
          />
          <Toggle
            label="Lens fringe (color split toward the edges)"
            checked={lensFringe}
            onCheckedChange={onLensFringeChange}
          />
          <Toggle
            label="Posterize (flat poster / comic colors)"
            checked={posterize}
            onCheckedChange={onPosterizeChange}
          />
          <Toggle
            label="Halftone (comic dot print)"
            checked={halftone}
            onCheckedChange={onHalftoneChange}
          />
          <Toggle
            label="Solarize (reflect the highlights)"
            checked={solarize}
            onCheckedChange={onSolarizeChange}
          />
          <Toggle
            label="Pixelate (retro 8-bit blocks)"
            checked={pixelate}
            onCheckedChange={onPixelateChange}
          />
          <Toggle
            label="Grain (analog film / sensor grain)"
            checked={grain}
            onCheckedChange={onGrainChange}
          />
          <Toggle
            label="Emboss (monochrome relief / engraving)"
            checked={emboss}
            onCheckedChange={onEmbossChange}
          />
          <Toggle
            label="Defocus (soft out-of-focus blur)"
            checked={defocus}
            onCheckedChange={onDefocusChange}
          />
          <Toggle
            label="Fisheye (barrel lens bulge)"
            checked={fisheye}
            onCheckedChange={onFisheyeChange}
          />
          <Toggle
            label="Warmth (warm / cool color tint)"
            checked={warmth}
            onCheckedChange={onWarmthChange}
          />
          <Toggle
            label="Color splash (keep one color, grey the rest)"
            checked={colorSplash}
            onCheckedChange={onColorSplashChange}
          />
          <Toggle
            label="Perspective (keystone tilt)"
            checked={perspective}
            onCheckedChange={onPerspectiveChange}
          />
          <Toggle
            label="Smooth (soften noise, keep edges)"
            checked={smooth}
            onCheckedChange={onSmoothChange}
          />
          <Toggle
            label="Directional blur (motion streak)"
            checked={directionalBlur}
            onCheckedChange={onDirectionalBlurChange}
          />
          <Toggle
            label="Threshold (pure black & white)"
            checked={binarize}
            onCheckedChange={onBinarizeChange}
          />
          <Toggle
            label="Swirl (twist from the center)"
            checked={swirl}
            onCheckedChange={onSwirlChange}
          />
          <Toggle
            label="Mirror (kaleidoscope fold)"
            checked={mirror}
            onCheckedChange={onMirrorChange}
          />
          <Toggle
            label="Tile (repeat in a grid)"
            checked={tile}
            onCheckedChange={onTileChange}
          />
          <Toggle
            label="Invert (photographic negative)"
            checked={invert}
            onCheckedChange={onInvertChange}
          />
          <Toggle
            label="Vibrance (boost muted colors)"
            checked={vibrance}
            onCheckedChange={onVibranceChange}
          />
          <Toggle
            label="Channel swap (red / blue alien look)"
            checked={channelSwap}
            onCheckedChange={onChannelSwapChange}
          />
          <Toggle
            label="Exposure (brighten by stops)"
            checked={exposure}
            onCheckedChange={onExposureChange}
          />
          <Toggle
            label="Shear (slant / skew the frame)"
            checked={shear}
            onCheckedChange={onShearChange}
          />
          <Toggle
            label="Auto-contrast (pull out flat detail)"
            checked={histeq}
            onCheckedChange={onHisteqChange}
          />
          <Toggle
            label="Grow / shrink (dilate the bright areas)"
            checked={morphology}
            onCheckedChange={onMorphologyChange}
          />
          <Toggle
            label="Colorize (wash in one tint)"
            checked={colorize}
            onCheckedChange={onColorizeChange}
          />
          <Toggle
            label="Auto white-balance (fix color cast)"
            checked={normalize}
            onCheckedChange={onNormalizeChange}
          />
          <Toggle
            label="Chroma bleed (VHS color smear)"
            checked={chromaBleed}
            onCheckedChange={onChromaBleedChange}
          />
          <Toggle
            label="RGB split (chromatic glitch)"
            checked={rgbSplit}
            onCheckedChange={onRgbSplitChange}
          />
          <Toggle
            label="B&W red filter (darkroom mono)"
            checked={monoMix}
            onCheckedChange={onMonoMixChange}
          />
          <Toggle
            label="Tilt-shift (focus band, blur the rest)"
            checked={tiltShift}
            onCheckedChange={onTiltShiftChange}
          />
          <Toggle
            label="Sketch (cartoon / line-art drawing)"
            checked={sketch}
            onCheckedChange={onSketchChange}
          />
          <Toggle
            label="Zoom blur (speed-zoom streaks from center)"
            checked={zoomBlur}
            onCheckedChange={onZoomBlurChange}
          />
          <Toggle
            label="Light leak (warm glow bleeding from a corner)"
            checked={lightLeak}
            onCheckedChange={onLightLeakChange}
          />
          <Toggle
            label="Film damage (old-film scratches and dust)"
            checked={filmDamage}
            onCheckedChange={onFilmDamageChange}
          />
          <Toggle
            label="Hue shift (spin the colors around the color wheel)"
            checked={hueShift}
            onCheckedChange={onHueShiftChange}
          />
          <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
            <Text size="sm" tone="muted">Camera shake:</Text>
            {([['off', 'Off', 0], ['subtle', 'Subtle', 0.02], ['medium', 'Medium', 0.05], ['heavy', 'Heavy', 0.1]] as const).map(([key, label, amp]) => (
              <Button
                key={key}
                variant={(amp === 0 ? !shake : shake?.amplitude === amp) ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setShake(amp === 0 ? null : { amplitude: amp, frequency: shake?.frequency ?? 8, ...(shake?.decay ? { decay: shake.decay } : {}) })}
              >
                {label}
              </Button>
            ))}
          </Container>
          {shake && (
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              <Text size="sm" tone="muted">Style:</Text>
              {([['sustained', 'Sustained', 0], ['impact', 'Impact hit', 2]] as const).map(([key, label, dec]) => (
                <Button
                  key={key}
                  variant={(dec === 0 ? !shake.decay : !!shake.decay) ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => setShake({ amplitude: shake.amplitude, frequency: shake.frequency ?? 8, ...(dec ? { decay: dec } : {}) })}
                >
                  {label}
                </Button>
              ))}
            </Container>
          )}
          <Toggle
            label="Glow (bloom highlights)"
            checked={glow}
            onCheckedChange={onGlowChange}
          />
          <Toggle
            label="Drop shadow (floating card)"
            checked={dropShadow}
            onCheckedChange={onDropShadowChange}
          />
          <Toggle
            label="Oval mask (show through a circle)"
            checked={ellipseMaskOn}
            onCheckedChange={onEllipseMaskOnChange}
          />
          <Toggle
            label="Iris reveal (animate the oval open)"
            checked={irisReveal}
            onCheckedChange={onIrisRevealChange}
          />
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Border color (set thickness with the Border slider)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {BORDER_COLORS.map((c) => (
                <Button
                  key={c.value}
                  variant={borderColor === c.value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onBorderColorChange(c.value)}
                >
                  {c.label}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Frame background (set size with the Frame scale slider)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {FRAME_BACKGROUNDS.map((b) => (
                <Button
                  key={b.value}
                  variant={frameBackground === b.value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onFrameBackgroundChange(b.value)}
                >
                  {b.label}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Rounded corners fill (set radius with the Rounded corners slider)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {CORNER_BACKGROUNDS.map((b) => (
                <Button
                  key={b.value}
                  variant={cornerBackground === b.value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onCornerBackgroundChange(b.value)}
                >
                  {b.label}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Duotone (map luma to two colors)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              <Button
                variant={duotone === null ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onDuotoneChange(null)}
              >
                Off
              </Button>
              {DUOTONE_PRESETS.map((d) => (
                <Button
                  key={d.label}
                  variant={duotone !== null && duotone.shadow === d.shadow && duotone.highlight === d.highlight ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onDuotoneChange({ shadow: d.shadow, highlight: d.highlight })}
                >
                  {d.label}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Split-tone grade (tint shadows and highlights, e.g. teal + orange)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              <Button
                variant={splitTone === null ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onSplitToneChange(null)}
              >
                Off
              </Button>
              {SPLIT_TONE_PRESETS.map((s) => (
                <Button
                  key={s.label}
                  variant={splitTone !== null && JSON.stringify(splitTone) === JSON.stringify(s.value) ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onSplitToneChange(s.value)}
                >
                  {s.label}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Censor a region (blur / pixelate / black out a centered area)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              <Button
                variant={censorFilter === '' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onCensorFilterChange('')}
              >
                Off
              </Button>
              {CENSOR_PRESETS.map((c) => (
                <Button
                  key={c.label}
                  variant={censorFilter === c.value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onCensorFilterChange(c.value)}
                >
                  {c.label}
                </Button>
              ))}
            </Container>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              <Text size="sm" tone="muted">Move the censor:</Text>
              {([['', 'Still'], ['pan', 'Pan'], ['bounce', 'Bounce'], ['orbit', 'Orbit']] as const).map(([value, label]) => (
                <Button
                  key={value || 'still'}
                  variant={censorMotion === value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onCensorMotionChange(value)}
                >
                  {label}
                </Button>
              ))}
            </Container>
            {censorMotion !== '' && (
              <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
                <Text size="sm" tone="muted">Ease:</Text>
                {([['', 'Linear'], ['smooth', 'Smooth'], ['in', 'Accel'], ['out', 'Decel']] as const).map(([value, label]) => (
                  <Button
                    key={value || 'linear'}
                    variant={censorEase === value ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => onCensorEaseChange(value)}
                  >
                    {label}
                  </Button>
                ))}
              </Container>
            )}
            <Toggle
              label="Fade the censor in"
              checked={censorFadeIn}
              onCheckedChange={onCensorFadeInChange}
            />
            <Toggle
              label="Fade the censor out"
              checked={censorFadeOut}
              onCheckedChange={onCensorFadeOutChange}
            />
            <Toggle
              label="Spotlight (apply the effect to the surroundings, keep the region)"
              checked={censorSpotlight}
              onCheckedChange={onCensorSpotlightChange}
            />
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Stack extra censors ({censorRegions.length} added; each lands in a fresh spot)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {CENSOR_PRESETS.map((c) => (
                <Button
                  key={c.label}
                  variant="ghost"
                  size="sm"
                  onClick={() => onAddCensorRegion(c.value)}
                >
                  + {c.label}
                </Button>
              ))}
              <Button
                variant={censorRegions.length > 0 ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onClearCensorRegions()}
              >
                Clear ({censorRegions.length})
              </Button>
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Progress bar (fills as the clip plays)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              <Toggle
                label="Show progress bar"
                checked={progressBar !== null}
                onCheckedChange={(on) => onProgressBarChange(on ? { height: 0.02, color: 'white', edge: 'bottom' } : null)}
              />
              {progressBar !== null && ([['white', 'White'], ['red', 'Red'], ['yellow', 'Yellow'], ['cyan', 'Cyan']] as const).map(([value, label]) => (
                <Button
                  key={value}
                  variant={progressBar.color === value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onProgressBarChange({ ...progressBar, color: value })}
                >
                  {label}
                </Button>
              ))}
              {progressBar !== null && ([['bottom', 'Bottom'], ['top', 'Top']] as const).map(([value, label]) => (
                <Button
                  key={value}
                  variant={progressBar.edge === value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onProgressBarChange({ ...progressBar, edge: value })}
                >
                  {label}
                </Button>
              ))}
            </Container>
            {progressBar !== null && (
              <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
                <Text size="sm" tone="muted">Chapter ticks:</Text>
                {([['none', 'None', []], ['thirds', 'Thirds', [1 / 3, 2 / 3]], ['quarters', 'Quarters', [0.25, 0.5, 0.75]]] as const).map(([key, label, marks]) => {
                  const active = (progressBar.markers?.length ?? 0) === marks.length;
                  return (
                    <Button
                      key={key}
                      variant={active ? 'primary' : 'ghost'}
                      size="sm"
                      onClick={() => onProgressBarChange({ ...progressBar, markers: marks.length ? [...marks] : undefined, markerColor: marks.length ? 'black' : undefined })}
                    >
                      {label}
                    </Button>
                  );
                })}
              </Container>
            )}
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Timer (burned-in count-up / countdown)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {([['', 'Off'], ['elapsed', 'Count up'], ['countdown', 'Countdown']] as const).map(([value, label]) => (
                <Button
                  key={value || 'off'}
                  variant={(timer?.mode ?? '') === value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onTimerChange(value === '' ? null : { mode: value, corner: timer?.corner ?? 'tr', color: timer?.color ?? 'white' })}
                >
                  {label}
                </Button>
              ))}
              {timer !== null && ([['tl', 'Top-L'], ['tr', 'Top-R'], ['bl', 'Bot-L'], ['br', 'Bot-R']] as const).map(([value, label]) => (
                <Button
                  key={value}
                  variant={timer.corner === value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onTimerChange({ ...timer, corner: value })}
                >
                  {label}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Countdown ring (circular timer)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {([['', 'Off'], ['deplete', 'Countdown'], ['fill', 'Fill up']] as const).map(([value, label]) => (
                <Button
                  key={value || 'off'}
                  variant={(countdownRing?.mode ?? (countdownRing ? 'deplete' : '')) === value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onCountdownRingChange(value === '' ? null : { color: countdownRing?.color ?? 'white', mode: value })}
                >
                  {label}
                </Button>
              ))}
              {countdownRing !== null && ([['white', 'White'], ['red', 'Red'], ['yellow', 'Yellow'], ['cyan', 'Cyan']] as const).map(([value, label]) => (
                <Button
                  key={value}
                  variant={(countdownRing.color ?? 'white') === value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onCountdownRingChange({ ...countdownRing, color: value })}
                >
                  {label}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Beat sync (a beat-detector fills the real timing)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {([['off', 'Off', 0], ['subtle', 'Subtle', 0.4], ['strong', 'Strong', 0.7]] as const).map(([key, label, strength]) => {
                const active = strength === 0 ? !pulses : !!pulses && Math.abs((pulses[0]?.strength ?? 0.5) - strength) < 0.01;
                const kind = pulses?.[0]?.kind ?? 'flash';
                return (
                  <Button
                    key={key}
                    variant={active ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => onPulsesChange(strength === 0 ? null : Array.from({ length: 40 }, (_, i) => ({ at: 0.5 + i * 0.5, strength, kind })))}
                  >
                    {label}
                  </Button>
                );
              })}
              {pulses !== null && ([['flash', 'Flash'], ['punch', 'Punch (zoom)'], ['shake', 'Shake'], ['glitch', 'Glitch'], ['tint', 'Tint (color flash)']] as const).map(([value, label]) => (
                <Button
                  key={value}
                  variant={(pulses[0]?.kind ?? 'flash') === value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onPulsesChange(pulses.map((p) => ({ ...p, kind: value, ...(value === 'tint' && !p.color ? { color: '#ff2d55' } : {}) })))}
                >
                  {label}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Letterbox (cinematic bars)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {([['off', 'Off', 0], ['cinemascope', '2.39', 2.39], ['wide', '2.0', 2.0], ['square', '1:1', 1.0]] as const).map(([key, label, aspect]) => {
                const active = aspect === 0 ? !letterbox : !!letterbox && Math.abs((letterbox.aspect ?? 2.39) - aspect) < 0.01;
                return (
                  <Button
                    key={key}
                    variant={active ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => onLetterboxChange(aspect === 0 ? null : { aspect, color: letterbox?.color ?? 'black' })}
                  >
                    {label}
                  </Button>
                );
              })}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Scrim (gradient for caption legibility)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {([['off', 'Off'], ['bottom', 'Bottom'], ['top', 'Top'], ['left', 'Left'], ['right', 'Right']] as const).map(([value, label]) => (
                <Button
                  key={value}
                  variant={(scrim?.edge ?? (scrim ? 'bottom' : 'off')) === value ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onScrimChange(value === 'off' ? null : { edge: value, strength: scrim?.strength ?? 0.6, color: scrim?.color ?? 'black' })}
                >
                  {label}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Spotlight follow (sweep the focus across the clip; set Spotlight strength above 0)</Text>
            <Toggle
              label="Follow a moving subject"
              checked={spotlightFollow}
              onCheckedChange={onSpotlightFollowChange}
            />
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Spotlight breathe (throb the focus in and out; set Spotlight strength above 0)</Text>
            <Toggle
              label="Breathe the focus (pulse in and out)"
              checked={spotlightPulse}
              onCheckedChange={onSpotlightPulseChange}
            />
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Highlight sweep (marker over a caption/keyword)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              <Button
                variant={highlightSweep ? 'ghost' : 'primary'}
                size="sm"
                onClick={() => onHighlightSweepChange(null)}
              >
                Off
              </Button>
              <Button
                variant={highlightSweep ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onHighlightSweepChange(highlightSweep ?? { x: 0.15, y: 0.8, w: 0.7, h: 0.12, color: 'yellow', opacity: 0.4, start: 0, duration: 0.6 })}
              >
                Lower third
              </Button>
              {highlightSweep ? (
                ([['yellow', 'Yellow'], ['cyan', 'Cyan'], ['magenta', 'Magenta'], ['green', 'Green']] as const).map(([value, label]) => (
                  <Button
                    key={value}
                    variant={(highlightSweep.color ?? 'yellow') === value ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => onHighlightSweepChange({ ...highlightSweep, color: value })}
                  >
                    {label}
                  </Button>
                ))
              ) : null}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Orientation (rotate / mirror)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              <Button
                variant={rotateDegrees === 0 ? 'ghost' : 'primary'}
                size="sm"
                onClick={() => onRotateDegreesChange((rotateDegrees + 90) % 360)}
              >
                {rotateDegrees === 0 ? 'Rotate 90°' : `Rotated ${rotateDegrees}°`}
              </Button>
              <Button
                variant={clipFlip === 'h' || clipFlip === 'hv' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onClipFlipChange(toggleFlipAxis(clipFlip, 'h'))}
              >
                Mirror horizontal
              </Button>
              <Button
                variant={clipFlip === 'v' || clipFlip === 'hv' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onClipFlipChange(toggleFlipAxis(clipFlip, 'v'))}
              >
                Mirror vertical
              </Button>
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Compare side by side (split-screen)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {splitCompareOptions.length === 0 ? (
                <Text size="sm" tone="muted">Add another source to compare against</Text>
              ) : splitCompareOptions.map((opt) => (
                <Button
                  key={opt.id}
                  variant={splitCompareWith === opt.id ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onSplitCompareWithChange(splitCompareWith === opt.id ? null : opt.id)}
                >
                  {opt.label}
                </Button>
              ))}
            </Container>
            {splitCompareWith ? (
              <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
                {(['h', 'v', 'grid'] as const).map((lay) => (
                  <Button
                    key={lay}
                    variant={splitLayout === lay ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => onSplitLayoutChange(lay)}
                  >
                    {lay === 'h' ? 'Side by side' : lay === 'v' ? 'Stacked' : 'Grid'}
                  </Button>
                ))}
              </Container>
            ) : null}
            {splitCompareWith ? (
              <Toggle
                label="Mirror the compare clip (face the same way)"
                checked={splitMirrorCompare}
                onCheckedChange={onSplitMirrorCompareChange}
              />
            ) : null}
          </Container>
          <Toggle
            label="Smooth slow-mo (optical flow)"
            checked={smoothSlowmo}
            onCheckedChange={onSmoothSlowmoChange}
          />
          <Toggle
            label="Auto-reframe (follow subject)"
            checked={autoReframe}
            onCheckedChange={onAutoReframeChange}
          />
          {autoReframe ? (
            <Container layout="vertical" gap="xs">
              <Text size="sm" tone="muted">Fill</Text>
              <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
                {reframeFillOptions.map((mode) => (
                  <Button
                    key={mode}
                    variant={reframeFill === mode ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => onReframeFillChange(mode)}
                  >
                    {mode === 'crop' ? 'Crop' : mode === 'blur' ? 'Blurred fill' : 'Black bars'}
                  </Button>
                ))}
              </Container>
            </Container>
          ) : null}
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Look</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {lookOptions.map((opt) => (
                <Button
                  key={opt}
                  variant={look === opt ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onLookChange(opt)}
                >
                  {opt === 'none' ? 'Original' : opt.replace(/-/g, ' ')}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Reduce noise</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {denoiseOptions.map((opt) => (
                <Button
                  key={opt}
                  variant={denoise === opt ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onDenoiseChange(opt)}
                >
                  {opt === 'none' ? 'Off' : opt.replace(/-/g, ' ')}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Enhance audio</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {soundFxOptions.map((opt) => (
                <Button
                  key={opt}
                  variant={soundFx === opt ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onSoundFxChange(opt)}
                >
                  {opt === 'none' ? 'Off' : opt.replace(/-/g, ' ')}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Adjustment layer</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              <Button
                variant={adjustmentLayer ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onAdjustmentLayerChange(!adjustmentLayer)}
              >
                {adjustmentLayer ? 'On: look applies to clips below' : 'Off'}
              </Button>
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Velocity curve</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {speedRampOptions.map((opt) => (
                <Button
                  key={opt}
                  variant={speedRamp === opt ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onSpeedRampChange(opt)}
                >
                  {opt === 'none' ? 'Off' : opt.replace(/-/g, ' ')}
                </Button>
              ))}
              <Button
                variant={speedRampAudio ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onSpeedRampAudioChange(!speedRampAudio)}
              >
                keep audio
              </Button>
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Picture-in-picture corner</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {pipCornerOptions.map((opt) => (
                <Button
                  key={opt}
                  variant={pipCorner === opt ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onPipCornerChange(opt)}
                >
                  {opt.replace(/-/g, ' ')}
                </Button>
              ))}
              <Button variant="ghost" size="sm" disabled={!canAddPictureInPicture} onClick={onAddPictureInPicture}>
                Add picture-in-picture
              </Button>
              <Button variant="ghost" size="sm" disabled={!canAddCensorRegion} onClick={onAddBlurRegion}>
                Blur box
              </Button>
              <Button variant="ghost" size="sm" disabled={!canAddCensorRegion} onClick={onAddMosaicRegion}>
                Mosaic box
              </Button>
              <Button variant="ghost" size="sm" disabled={!canRemoveBackground} onClick={onRemoveBackground}>
                Remove background (AI)
              </Button>
              <Button variant="ghost" size="sm" disabled={!canPunchIn} onClick={onPunchIn}>
                Punch in
              </Button>
              <Button variant="ghost" size="sm" disabled={!canLoopSegment} onClick={onLoopSegment}>
                Loop
              </Button>
              <Button variant="ghost" size="sm" disabled={!canLoopSegment} onClick={onBoomerangSegment}>
                Boomerang
              </Button>
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Translate captions</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {captionLangOptions.map((opt) => (
                <Button
                  key={opt}
                  variant={captionLang === opt ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onCaptionLangChange(opt)}
                >
                  {opt}
                </Button>
              ))}
              <Button variant="ghost" size="sm" onClick={onTranslateCaptions}>
                Translate captions
              </Button>
              <Button variant="ghost" size="sm" onClick={onClearCaptionTranslation}>
                Clear
              </Button>
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Blend overlay (film grain / light leak / glow)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {blendModeOptions.map((mode) => (
                <Button
                  key={mode}
                  variant="ghost"
                  size="sm"
                  disabled={!canAddBlendOverlay}
                  onClick={() => onAddBlendOverlay(mode)}
                >
                  {mode}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Audio visualizer</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {audioVizOptions.map((viz) => (
                <Button key={viz} variant="ghost" size="sm" onClick={() => onAddAudioViz(viz)}>
                  {viz}
                </Button>
              ))}
            </Container>
          </Container>
          <Container layout="vertical" gap="xs">
            <Text size="sm" tone="muted">Normalize loudness (EBU R128)</Text>
            <Container layout="horizontal" wrap="wrap" gap="xs" alignItems="center">
              {loudnessPresets.map((preset) => (
                <Button
                  key={preset.lufs}
                  variant="ghost"
                  size="sm"
                  disabled={!canNormalizeLoudness}
                  onClick={() => onNormalizeLoudness(preset.lufs)}
                >
                  {preset.label}
                </Button>
              ))}
            </Container>
          </Container>
          <Toggle
            label="Karaoke captions (highlight each word)"
            checked={captionKaraoke}
            onCheckedChange={onCaptionKaraokeChange}
          />
          <Container layout="horizontal" justifyContent="start" alignItems="center" gap="sm">
            <Button variant="ghost" size="sm" disabled={!canAddCaptions} onClick={onAddCaptions}>
              Add captions
            </Button>
            <Button variant="ghost" size="sm" disabled={!canDetachAudio} onClick={onDetachAudio}>
              Detach audio
            </Button>
            <Button variant="ghost" size="sm" disabled={!canAutoCleanup} onClick={onAutoCleanup}>
              Clean up audio
            </Button>
            <Button variant="ghost" size="sm" disabled={!canBeatSync} onClick={onBeatSync}>
              Cut to beat
            </Button>
            <Button variant="ghost" size="sm" disabled={!canSceneSplit} onClick={onSceneSplit}>
              Auto-split scenes
            </Button>
            <Button variant="ghost" size="sm" disabled={!canMakeHighlight} onClick={onMakeHighlight}>
              Make highlight
            </Button>
            <Button variant="ghost" size="sm" disabled={!canAddNarration} onClick={onAddNarration}>
              Add narration
            </Button>
            <Button variant="ghost" size="sm" disabled={!canTrackSubject} onClick={onTrackSubject}>
              Track subject
            </Button>
            <Button variant="ghost" size="sm" active={rippleActive} disabled={!canRippleTrim} onClick={onRippleTrim}>
              Ripple trim
            </Button>
            <Button variant="ghost" size="sm" onClick={onCloseGaps}>
              Close gaps
            </Button>
          </Container>
          <Container layout="horizontal" justifyContent="end" alignItems="center">
            <Button variant="primary" size="sm" onClick={onCommitTransform}>
              Apply to clip
            </Button>
          </Container>
        </Container>
      </Card>

      <ScrollableSurface>
        <Container layout="vertical" gap="sm">
        {CONTROL_DESCRIPTORS.map((control) => (
          <Slider
            key={control.key}
            label={control.label}
            value={controls[control.key] ?? control.min}
            min={control.min}
            max={control.max}
            unit={control.unit}
            onValueChange={(value) => onControlChange(control.key, value)}
            onReset={() => onResetControl(control.key)}
          />
        ))}

        <Container layout="horizontal" gap="sm" wrap>
          {panels.map((panel) => (
            <Button
              key={panel.panel_id}
              variant="ghost"
              size="sm"
              active={panel.panel_id === selectedPanel?.panel_id}
              onClick={() => onSelectPanel(panel.panel_id)}
            >
              {panel.label}
            </Button>
          ))}
        </Container>

        {selectedSource ? (
          <Card variant="nested" padding="sm">
            <Text variant="body" weight="semibold">{selectedSource.label}</Text>
            <Text variant="body-xs" color="faint">{selectedSourceDetail}</Text>
          </Card>
        ) : null}

        {selectedPanel ? (
          <>
            <Container layout="horizontal" justifyContent="between" alignItems="center">
              <Text variant="heading">Records</Text>
              <Text variant="body-xs" color="faint">{panelSummary(selectedPanel)}</Text>
            </Container>
            <Text variant="body-xs" color="faint">{selectedPanel.label}</Text>
            {selectedPanel.items.slice(0, 12).map((item) => (
              <Card key={item.item_id} variant="nested" padding="sm">
                <Text variant="body" weight="semibold">{item.label}</Text>
                <Text variant="body-xs" color="faint">{item.detail}</Text>
              </Card>
            ))}
          </>
        ) : (
          <Container layout="vertical" gap="sm">
            <Text variant="heading">Panels appear here.</Text>
            <Text variant="body" color="faint">Transcripts, people, motion, captions, color, and output controls share this area.</Text>
          </Container>
        )}

        <Card variant="nested" padding="sm">
          <Container layout="horizontal" justifyContent="between" alignItems="center">
            <Text variant="body" weight="semibold">Saved edits</Text>
            <Badge size="sm" variant="neutral">{editDecisions.length}</Badge>
          </Container>
          <Text variant="body-xs" color="faint">{markers.length} markers saved</Text>
        </Card>

        {blockers.length > 0 ? (
          <Card variant="nested" padding="sm">
            <Text variant="body" weight="semibold">Some material is still loading.</Text>
            <Text variant="body-xs" color="faint">You can keep editing what is already here.</Text>
          </Card>
        ) : null}

        <MediaOutputPanel message={message} outputAction={outputAction} composition={composition} sources={sources} />
        </Container>
      </ScrollableSurface>
    </Card>
  );
}
