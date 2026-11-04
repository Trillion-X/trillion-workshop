//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure reducer: folds an ordered sequence of MediaCompositionEditDecision records
// from a MediaWorkspaceView into a MaterializedComposition — the canonical
// derived timeline that the editor's UI and render pipeline consume.
//
// NON-NEGOTIABLE INVARIANTS
//
//   1. PURE & DETERMINISTIC — no Date.now(), no Math.random(), no I/O.
//      Given the same MediaWorkspaceView the output is always identical.
//
//   2. REPLAY-SAFE — applying the same edit-decisions twice produces the same
//      result as applying them once.
//
//   3. NO INPUT MUTATION — all intermediate state is built from spreads / new
//      arrays; the caller's MediaWorkspaceView is never modified.
//
//   4. OPEN TO NEW ACTIONS (L090) — action dispatch is a data-keyed map.
//      Adding 'mute', 'color-grade', etc. = one new entry in FOLD_ACTIONS.
//      Zero consumer code changes required.
//
//   5. UNKNOWN ACTIONS ARE NO-OPS — unrecognised action strings leave state
//      unchanged and never throw.
//
// =============================================================================

import type {
  MediaWorkspaceView,
  MediaCompositionEditDecision,
} from './read-media-workspace';
import {
  LANE_TONE_DESCRIPTORS,
  TONE_PALETTE,
  labelLookup,
} from './media-composition-descriptors';

// ── Public types ─────────────────────────────────────────────────────────────

/** #130/#137/#138 A region filter: an OPAQUE ffmpeg filter (L090 seam) applied to a normalized 0..1
 *  rectangle, then composited back. `motion` (#138) makes it TRACK: the crop+overlay position moves
 *  linearly from {x,y} to {toX,toY} over [start, start+duration] seconds, so a censor follows a subject.
 *  Static (no motion) is just the endpoint === start. */
export type RegionFilter = {
  x: number; y: number; w: number; h: number; filter: string;
  motion?: { toX: number; toY: number; start: number; duration: number };
  /** #139 Keyframe path: N waypoints {x,y,at} the censor traces through (piecewise-linear over time). The
   *  L069 generalization of `motion` (a 2-point path). >= 2 points; sorted by `at` (seconds). Takes
   *  precedence over `motion`, which takes precedence over the static {x,y}. */
  path?: Array<{ x: number; y: number; at: number }>;
  /** #140 Ease curve for the motion/path interpolation: 'smooth' (smoothstep, accel+decel), 'in' (accel),
   *  'out' (decel). Absent / 'linear' = constant speed. Applies to whichever of motion/path is active. */
  ease?: 'linear' | 'smooth' | 'in' | 'out';
  /** #141 Opacity fade: the censor ramps from transparent to full over `in` seconds at the start, and back
   *  to transparent over `out` seconds before the clip end (progressive redaction / reveal). Composes with
   *  any position (static / motion / path). Each is seconds > 0; kept only when at least one is set. */
  fade?: { in?: number; out?: number };
  /** #142 Which side the `filter` applies to. 'inside' (default) = censor the region (blur/pixelate/black the
   *  rectangle). 'outside' = spotlight: the filter hits everything EXCEPT the region, so the region stays
   *  original and pops (dim/desaturate the surroundings). Reuses all position/ease/fade unchanged. */
  mode?: 'inside' | 'outside';
};

export type ClipTransform = {
  aspectRatio?: string;
  framePreset?: string;
  position?: string;
  width?: number;
  height?: number;
  padding?: number;
  inset?: number;
  corners?: number;
  stroke?: number;
  shadow?: number;
  keepAspectRatio?: boolean;
  /** Temporal + audio per-clip properties (honored by video-compose buildClip).
   *  They ride the SAME set-transform op as the visual fields, so an inspector that
   *  sets speed/fade/volume authors one set-transform decision, zero new op code. */
  speed?: number;
  /** #95 Smooth slow-mo: when slowing (speed<1), synthesize in-between frames with optical-flow
   *  motion interpolation (DaVinci Optical Flow / Twixtor) instead of duplicating frames. */
  speedSmooth?: boolean;
  /** #102 Velocity curve: keyframed speed over the clip (a ramp, not a constant). Each point is
   *  {t (input-source seconds), speed (>0)}; the span from one keyframe to the next plays at that
   *  keyframe's speed, the last extends to the clip end. Overrides constant `speed` and mutes the
   *  clip audio (variable-speed audio is a separate concern). Render maps it to setpts=(f(T))/TB. */
  speedRamp?: Array<{ t: number; speed: number }>;
  /** #102 Declares speedRamp t values as fractions (0..1) of the clip's source length instead
   *  of seconds, so a preset curve applies to any clip; the render resolves fractions where
   *  the real duration is known. Absent means seconds. */
  speedRampUnit?: 'seconds' | 'fraction';
  /** #107 Retime the clip audio THROUGH the velocity ramp (per-span tempo shift) so it stays
   *  in sync with the remapped video, instead of the default mute. */
  speedRampAudio?: boolean;
  /** #108 Marks this clip as an ADJUSTMENT LAYER: it contributes NO pixels; instead its opaque
   *  filter DATA (grade) applies to the whole composited program over the clip's own time window
   *  [laneStart, laneStart+length). The same ClipTransform grammar, scoped by TIME instead of by
   *  source (L069): trimming/moving the clip retimes the effect; the render stays blind (L090). */
  adjustment?: boolean;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** Marks this clip as a MUSIC BED, an audio track mixed UNDER the video spine
   *  (not a spine segment). Explicit DATA flag so materialize-edl stays LANE-ROLE-BLIND
   *  (invariant #2, never a role guess): an audio add-source carrying `audio_bed:true`
   *  routes to edl.audio_graph.music_bed (qsin fades plus volume plus amix), which
   *  video-compose already renders. `volume`/`fadeIn`/`fadeOut` above tune the bed. */
  audioBed?: boolean;
  /** NARRATION (#99): when true on an audio add-source, the clip is a TTS/voiceover placed at its
   *  laneStart, routing to edl.audio_graph.narration[] (adelay + volume + amix over the spine) instead
   *  of the video spine. Explicit DATA flag so materialize stays LANE-ROLE-BLIND, exactly like audioBed. */
  narration?: boolean;
  /** #99 TTS descriptor: when a narration clip carries `ttsText`, the render GENERATES the voice from
   *  this text with the DATA-selected engine (`ttsProducer`, default macos-say) and `ttsVoice`, instead
   *  of a pre-made artifact. Lets the UI author narration as pure text; the render makes the audio. */
  ttsText?: string;
  ttsProducer?: string;
  ttsVoice?: string;
  /** DUCKING: when true on a music-bed clip, video-compose sidechaincompresses the bed
   *  keyed by speech already present in the spine, so the music drops under that speech and swells
   *  back in the gaps. Narration/TTS is mixed later and does not key this path unless pre-baked.
   *  Rides to edl.audio_graph.music_bed.duck. */
  duck?: boolean;
  /** KEN BURNS pan/zoom. {zoom_from, zoom_to, x_from, x_to, y_from, y_to} (zoom multiplier;
   *  x/y are the normalized 0..1 center the window pans between). Rides to the EDL clip's
   *  ken_burns; video-compose compiles it to a zoompan ramp. Turns a still into motion. */
  /** #110/#113 Ken Burns pan/zoom. The 6 flat keys are the 2-knot shorthand (zoom_from -> zoom_to,
   *  pan x/y). `keyframes` {zoom,cx,cy: [{t,value,interp?}]} authors an N-STOP cinematic move (zoom in,
   *  hold, pan, zoom out) with per-knot easing; `unit:'fraction'` declares knot t as 0..1 of the clip.
   *  Each axis is a piecewiseExpr envelope the render owns (L069); absent an axis, the 2-knot shorthand. */
  kenBurns?: {
    zoom_from?: number; zoom_to?: number; x_from?: number; x_to?: number; y_from?: number; y_to?: number;
    keyframes?: Record<string, Array<{ t: number; value: number; interp?: string }>>;
    unit?: 'seconds' | 'fraction';
  };
  /** #114 Split edit (J-cut / L-cut): detach this clip's audio from its video by this many seconds.
   *  Negative places the audio BEFORE the clip's video cut (audio leads, a J-cut), positive AFTER
   *  (audio lags, an L-cut). The render re-enters the clip audio through the audio.narration placement
   *  primitive at videoStart+offset; the clip's spine segment is silenced. One scalar, both cut types. */
  audioOffsetS?: number;
  /** Animated property envelopes {property: [{t, value, interp?}]} rendered by video-compose's
   *  property-agnostic evaluator (opacity + volume bound today). Fade-in from black = an opacity
   *  ramp; a new animatable property is one KEYFRAME_BINDINGS row, zero handler code. */
  keyframes?: Record<string, Array<{ t: number; value: number; interp?: string }>>;
  /** Auto-reframe: retarget the shot to a new aspect (16:9 -> 9:16) with a crop window that
   *  FOLLOWS a normalized 0..1 subject-center track over time. No track -> static center crop.
   *  Rides to the EDL clip's `reframe`; video-compose compiles the animated crop. WHERE the
   *  track comes from (a face/person detector producer) is DATA it writes, not render code. */
  reframe?: { aspect_w?: number; aspect_h?: number; track?: Array<{ t: number; cx?: number; cy?: number }>;
    /** #94 How the retargeted frame fills the canvas: 'crop' (cover, default), 'blur' (contain-fit
     *  with a scaled blurred copy filling the bars, no black bars), or a solid pad color string.
     *  `fill_blur` is the background blur sigma (default 20). */
    fill_mode?: string; fill_blur?: number };
  /** Color grade / look: an OPAQUE ffmpeg video-filter string (DATA). Any look (B&W, teal-orange,
   *  VHS, faded, a LUT via `${LUT}` + grade_lut_ref) is a DATA string; the render is blind (L090).
   *  Infinite looks, zero code per look. */
  grade?: string;
  /** Ordered grades after the legacy grade, with a separate LUT per layer. */
  grade_layers?: Array<{ grade: string; grade_lut_ref?: string }>;
  /** Ordered per-clip EFFECT STACK: a list of self-describing effect nodes the compositor resolves
   *  via the effect-registry (do-work/effect-registry.mjs resolveEffectFragment) IN ORDER. Each node is
   *  opaque DATA `{template}` (a raw -vf string), `{effect_id, points}` (a keyframe envelope), or
   *  `{compute, params|param_envelopes, timing?}` (one of the 33 named effects, optionally param-keyframed).
   *  The fold + materialize stay blind (L090); ANY effect in ANY order/count as pure DATA (L069). Empty/absent = none. */
  effects?: Array<Record<string, unknown>>;
  /** Named LOOK preset (a multi-effect stack): the key of a LOOK_STACKS row (e.g. 'vhs', 'cinematic-bloom').
   *  The compositor expands it through the same effect list BEFORE `effects`, so a preset applies its whole
   *  stack and per-clip `effects` layer on top. DATA, zero code per look. Empty/absent = none.
   *  camelCase here lands as snake_case `look_stack` on the EDL (the compositor's read key). */
  lookStack?: string;
  /** Noise reduction: an OPAQUE ffmpeg audio-filter string (afftdn/arnndn/anlmdn/highpass...)
   *  the render applies blind (L090), the audio twin of `grade`; OR the key of an external
   *  denoiser (e.g. 'deepfilternet') the render cleans via a separate binary. DATA, zero
   *  code per method. Empty string clears it. */
  denoise?: string;
  /** #100 Audio effect chain: an OPAQUE ffmpeg audio-filter chain (DATA) the render appends to this
   *  clip's audio (EQ, compressor, de-reverb, de-esser, pitch, "Studio Sound"...). The general audio
   *  twin of `grade` (denoise handles noise specifically); infinite processing, zero code per effect.
   *  Applied after denoise/volume and before per-clip loudnorm so the effect is normalized. Empty clears. */
  audioFilters?: string;
  /** #202 Echo / reverb (AUDIO): add spatial depth by mixing delayed copies of this clip's audio. `amount`
   *  0..1 (required to enable; 0 = off) scales the wet decay (louder, longer tail); optional `delayMs`
   *  20..1000 (default 250) sets the tap spacing (short = slap-back, long = cavern). The ADD half the audio
   *  catalog lacked: the `de-reverb` preset REMOVES room, nothing added it. A first-class one-click tunable
   *  DATA control distinct from the opaque `audioFilters` power-user seam. Maps to EDL `echo`. Blind (L090). */
  echo?: { amount: number; delayMs?: number };
  /** Silence this clip's own audio (render replaces it with silence). Set by detach-audio on the
   *  video clip once its sound moves to a separate audio-lane clip. Maps to EDL `silent_audio`. */
  muted?: boolean;
  /** Play the clip backward (video + audio reversed). */
  reverse?: boolean;
  /** Chroma key / green-screen: an OPAQUE ffmpeg key-filter string (colorkey=0x00ff00:0.3:0.1 /
   *  chromakey / a despill chain) that makes a color transparent. The video twin of `grade`;
   *  the render is blind (L090). Meaningful when the clip composites over a background (a video
   *  overlay), where the keyed color reveals what is behind. Empty string clears it. */
  chroma_key?: string;
  /** Freeze-frame / hold: clone the first ('head') or last ('tail', default) frame for
   *  `duration` seconds, extending the clip. */
  freeze?: { mode?: 'head' | 'tail'; duration: number };
  /** Stabilize / deshake the clip (DaVinci warp-stabilizer class). The render runs a vidstab
   *  two-pass; `stabilizeSmoothing` (frames) is the strength knob, `stabilizeShakiness` (1..10)
   *  the detection aggressiveness. The render is blind to the numbers (L090). */
  stabilize?: boolean;
  stabilizeSmoothing?: number;
  stabilizeShakiness?: number;
  /** Motion blur: blend the last N frames into each output frame (the After Effects / DaVinci
   *  frame-blend look), a smear that reads as motion. `motionBlurFrames` (default 3) is the strength.
   *  The complement of `speedSmooth` (interpolation for slow-downs); this is blending for the
   *  stylized fast look. Render is blind to the number (L090). */
  motionBlur?: boolean;
  motionBlurFrames?: number;
  /** #156 Trails / echo: temporal persistence (lagfun) where each pixel keeps max(current, decay*previous),
   *  so moving bright areas leave a fading light-trail (the long-exposure / persistence-of-vision look).
   *  Distinct from motionBlur (which averages the last N frames uniformly): this is exponential decay that
   *  lingers. `decay` 0..1 (higher = longer trails); the render clamps to a usable 0.5..0.98. Blind DATA (L090). */
  trails?: { decay: number };
  /** #157 Wobble / wave-warp: a per-frame sinusoidal horizontal displacement (the underwater / dream /
   *  drunk / heat-haze look) where each row shifts by amplitude*sin(2PI*(Y/wavelength + speed*t)), so the
   *  frame ripples down its height and animates over time. A COMPUTED per-frame geometric primitive the
   *  static grade seam cannot express. `amplitude` px (>0 enables); `frequency` = waves down the frame
   *  height (default 3); `speed` = waves per second (default 0.5). Blind DATA (L090). */
  wobble?: { amplitude: number; frequency?: number; speed?: number };
  /** #158 Warmth ramp: an ANIMATED white-balance shift over the clip (the sunset / day-to-night / mood
   *  change). `from`/`to` are warmth in -1..1 (positive = warmer/oranger, negative = cooler/bluer); the
   *  render ramps warmth linearly over [start, start+duration] (defaults: start 0, duration = clip length),
   *  scaling red by (1+warmth) and blue by (1-warmth). A COMPUTED time-ramp the static grade/colorAdjust
   *  seam cannot express (those are constant). Blind DATA (L090); dropped unless from and to are finite. */
  warmthRamp?: { from: number; to: number; start?: number; duration?: number };
  /** #159 Strobe / stop-motion: quantize motion to `rate` updates per second by holding each shown frame
   *  (the choppy stop-motion / stutter look). Unlike speed, the clip's DURATION is unchanged; only the
   *  motion cadence drops (the render decimates to `rate` fps then restores the output fps, so each visible
   *  frame is held). Distinct from motionBlur (blends) and trails (persistence). `rate` fps of visible
   *  motion (>0 and below the output fps enables it). Blind DATA (L090). */
  strobe?: { rate: number };
  /** #160 Scanlines (CRT / retro): darken periodic horizontal lines across the frame (the old-TV / VHS /
   *  arcade look). Each row is attenuated by depth*(0.5+0.5*cos(2PI*(Y/period + roll*t))), so the pattern
   *  repeats every `period` px and, when `roll` > 0, the dark band scrolls over time (the CRT roll). A
   *  COMPUTED per-pixel pattern the static grade seam cannot express portably (it needs Y + t). `depth`
   *  0..1 (>0 enables); `period` px (default 4); `roll` waves per second (default 0 = static). Blind DATA (L090). */
  scanlines?: { depth: number; period?: number; roll?: number };
  /** #161 Lens fringe (radial chromatic aberration): split the color channels RADIALLY, zero at the
   *  center and growing toward the corners, so the frame gets the real cheap-lens / VHS color fringe at
   *  its edges (red pushed outward from center, blue inward). Distinct from the UNIFORM `chromatic-aberration`
   *  grade preset (same shift everywhere) and from #155 beat glitch (uniform horizontal split at beats):
   *  this is radius-dependent. A COMPUTED per-pixel geometry the linear grade seam cannot express. `strength`
   *  is the max fractional channel shift at the corner (>0 enables; the render clamps to 0.2). Blind DATA (L090). */
  lensFringe?: { strength: number };
  /** #162 Posterize: quantize each color channel to `levels` discrete steps, flattening smooth gradients into
   *  bands (the poster / comic / retro-print look). Distinct from the CONTINUOUS grade/colorAdjust (curves,
   *  eq): this reduces the number of colors. `levels` per channel (2..64; below 2 is a no-op). Blind DATA (L090). */
  posterize?: { levels: number };
  /** #173 Solarize: partial per-channel tone inversion ABOVE a threshold (the darkroom / psychedelic
   *  reflect-the-highlights look). `threshold` 0..1; each channel c maps to (c > threshold*255 ? 255-c : c).
   *  Distinct from posterize (quantize) and gradientMap (color remap): this reflects the bright end. DATA (L090). */
  solarize?: { threshold: number };
  /** #188 Invert (photographic negative / "invert colors"): flip every tone so bright becomes dark and dark
   *  becomes bright (ffmpeg `negate`). A param-less one-click toggle, distinct from #173 solarize (inverts only
   *  ABOVE a cutoff), #175 posterize (N levels), #177 binarize (2-level). Bare `true` only. The safest effect:
   *  a constant filter with zero DATA interpolation. Blind DATA (L090); dropped unless true. Maps to EDL `invert`. */
  invert?: boolean;
  /** #189 Vibrance (smart saturation): boost the saturation of MUTED colors while protecting already-vivid
   *  ones (ffmpeg `vibrance`), the nonlinear counterpart to the plain linear `saturation` control. `intensity`
   *  -1..1 (positive pops muted color, negative gently mutes it); bare `true` seeds 0.6. Blind DATA (L090);
   *  intensity 0 is identity (dropped). Numeric-only (injection-safe). Maps to EDL `vibrance`. */
  vibrance?: { intensity: number };
  /** #190 Channel swap (the "wrong colors" / alien / infrared look): swap two RGB channels via a fixed
   *  `colorchannelmixer` matrix. `pair` 'rb' (red<->blue, the classic teal alien look), 'rg' (red<->green), or
   *  'gb' (green<->blue); bare `true` seeds 'rb'. Distinct from #? hueShift (a continuous wheel rotation) and
   *  duotone (a 2-color ramp). Numeric-matrix only (injection-safe). Blind DATA (L090); maps to EDL `channel_swap`. */
  channelSwap?: { pair: 'rb' | 'rg' | 'gb' };
  /** #191 Exposure (photographic stops): brighten or darken in linear light by a number of stops (ffmpeg
   *  `exposure`), the exponential Lightroom "exposure" slider, distinct from the plain LINEAR brightness of
   *  the eq grade (an additive offset). `stops` -2..2 (positive brightens, +1 stop ~doubles light); bare
   *  `true` seeds 0.6. Blind DATA (L090); stops 0 is identity (dropped). Numeric-only (injection-safe). Maps
   *  to EDL `exposure`. */
  exposure?: { stops: number };
  /** #192 Shear (parallelogram slant / skew): slant the frame along one axis via a geq coordinate remap (no
   *  trig), distinct from #181 perspective (a trapezoid keystone) and rotate (a rigid turn). `amount` -1..1 is
   *  the slant strength (positive leans one way, negative the other); `axis` 'h' slants columns by row (the
   *  italic lean), 'v' slants rows by column. bare `true` seeds { amount 0.3, axis h }. amount 0 is identity
   *  (dropped). Numeric-remap only (injection-safe). Blind DATA (L090); maps to EDL `shear`. */
  shear?: { amount: number; axis: 'h' | 'v' };
  /** #193 Auto-contrast (histogram equalization): redistribute the tones so the frame uses the full range,
   *  pulling detail out of a flat/low-contrast shot (ffmpeg `histeq`), the "auto levels / enhance" one-click.
   *  Nonlinear, distinct from a plain LINEAR contrast scale. `strength` 0..1 (higher equalizes harder); bare
   *  `true` seeds 0.5. Blind DATA (L090); strength 0 is identity (dropped). Numeric-only (injection-safe).
   *  Maps to EDL `histeq`. */
  histeq?: { strength: number };
  /** #194 Morphology (dilate / erode): a max/min neighbourhood filter that GROWS bright regions ('dilate', the
   *  spread / chunky-bloom look) or SHRINKS them ('erode', the thin / etched look) via ffmpeg `dilation`/
   *  `erosion`. Distinct from a smooth blur (this is a hard max/min, not an average). `mode` dilate|erode;
   *  `amount` 1..4 is the number of passes (how far it grows/shrinks). bare `true` seeds { mode dilate,
   *  amount 2 }. Blind DATA (L090); numeric-only (injection-safe). Maps to EDL `morphology`. */
  morphology?: { mode: 'dilate' | 'erode'; amount: number };
  /** #195 Colorize (single-hue wash / monochrome tint): recolor the WHOLE frame toward one hue while keeping
   *  its luma (ffmpeg `colorize`), the blueprint / cyanotype / sepia / red-alert look. Distinct from duotone (a
   *  2-color luma ramp) and splitTone (different hues for shadows vs highlights). `hue` 0..360 selects the tint
   *  color (0 red, 120 green, 220 blue); `strength` 0..1 is how saturated the wash is. bare `true` seeds a
   *  blueprint blue { hue 220, strength 0.5 }. Blind DATA (L090); strength 0 is identity (dropped). Numeric-only
   *  (injection-safe). Maps to EDL `colorize`. */
  colorize?: { hue: number; strength: number };
  /** #196 Auto white-balance (normalize): independently stretch each RGB channel's range to full, which fixes
   *  a color cast AND maximizes contrast (ffmpeg `normalize` at independence 1), the one-click "auto color".
   *  Distinct from #193 auto-contrast (histeq, a luma-only histogram equalization that cannot correct a color
   *  cast). `strength` 0..1 blends toward the corrected frame; bare `true` seeds 1.0. Blind DATA (L090);
   *  strength 0 is identity (dropped). Numeric-only (injection-safe). Maps to EDL `normalize`. */
  normalize?: { strength: number };
  /** #197 Chroma bleed (color bleed): blur ONLY the color (chroma) while keeping the luma detail sharp, so
   *  color smears past edges but the picture stays crisp (the VHS / anime color-bleed look). Distinct from
   *  every other blur here (defocus/directionalBlur/zoomBlur/smooth all soften the luma too). `radius` 1..40 is
   *  how far the color bleeds; bare `true` seeds 15. Blind DATA (L090); radius < 1 is identity (dropped).
   *  Numeric-only (injection-safe). camelToSnake => EDL `chroma_bleed`. */
  chromaBleed?: { radius: number };
  /** #198 RGB split (chromatic glitch): offset the red and blue channels apart by `amount` px so the picture
   *  ghosts into a red-left / blue-right double image (the datamosh / anaglyph / lo-fi glitch look). Distinct
   *  from #197 chromaBleed (a chroma BLUR with no offset, a soft smear) and from lens_fringe (RADIAL edge-only
   *  fringing): this is a UNIFORM linear channel translation everywhere. The named one-click toggle over a
   *  clamped DATA amount, NOT the opaque fixed-strength `rgbashift` grade preset. `amount` 1..30; bare `true`
   *  seeds 6. Blind DATA (L090); amount < 1 is identity (dropped). Numeric-only (injection-safe).
   *  camelToSnake => EDL `rgb_split`. */
  rgbSplit?: { amount: number };
  /** #199 Mono mix (B&W color-filter): collapse the frame to monochrome using per-channel weights `r`,`g`,`b`
   *  (out gray = r*R + g*G + b*B on all three channels), the darkroom color-filter-for-B&W trick where a red
   *  filter brightens reds and darkens blue sky. THE GENERATIVE monochrome primitive (L069): equal weights =
   *  plain grayscale, {r-heavy} = red filter, {g-heavy} = green filter, etc. Distinct from #195 colorize (a
   *  single-hue WASH that keeps luma in color) and #190 channelSwap (permutes channels, stays color). Blind
   *  DATA weights (L090), each clamped 0..2; bare `true` seeds the red filter {0.7,0.2,0.1}. Enabled only when
   *  the weights sum > 0 (all-zero is a black no-op, dropped). Numeric-only (injection-safe). camelToSnake on
   *  the field name => EDL `mono_mix`. */
  monoMix?: { r: number; g: number; b: number };
  /** #200 Faded film (lifted blacks / matte): raise the output black FLOOR by `lift` (a 0..0.5 fraction of
   *  full range) via ffmpeg's native `colorlevels`, so pure black becomes gray and the shadows wash out into
   *  the low-contrast matte / faded-film / Instagram look, while white stays put. Distinct from #196 normalize
   *  (which does the OPPOSITE, auto-stretching each channel TO full range) and from the opaque `faded` grade
   *  preset (a contrast + colorbalance tweak that never lifts the black floor). `lift` clamped 0..0.5; bare
   *  `true` seeds 0.15. Blind DATA (L090); lift <= 0 is identity (dropped). Numeric-only (injection-safe).
   *  camelToSnake => EDL `faded_film`. */
  fadedFilm?: { lift: number };
  /** #174 Pixelate: quantize the whole frame into `blockSize`-px square blocks (retro 8-bit / mosaic look).
   *  Each block collapses to one averaged color, so fine detail dissolves into flat squares. Distinct from
   *  #130 region censor (which pixelates a numeric RECT of the frame): this is a full-frame stylistic
   *  quantization of the clip. `blockSize` is an integer >= 2 (bigger = coarser). DATA (L090). */
  pixelate?: { blockSize: number };
  /** #175 Grain: overlay tunable, reproducible analog film / sensor grain (fine per-pixel temporal noise).
   *  `amount` is the strength 1..100. Distinct from the fixed `film-grain` LOOK preset (which replaces the
   *  whole grade at a single baked strength) - this is a COMPOSABLE effect that layers on top of any grade
   *  at a tunable strength; and distinct from #169 filmDamage (sparse scratches/dust flecks) - this is even,
   *  full-frame grain. Rendered with a fixed seed so it stays byte-reproducible (#170). DATA (L090). */
  grain?: { amount: number };
  /** #176 Emboss: monochrome relief / engraving look (a 3x3 convolution that maps flat tone to mid-gray and
   *  surfaces edges as light/dark relief). `depth` scales the kernel magnitude (0.2..4; bigger = deeper
   *  relief). Distinct from any color grade or blur - it is a structural convolution, not a look preset.
   *  DATA (L090). */
  emboss?: { depth: number };
  /** #177 Defocus: uniform full-frame gaussian blur (a focus pull / out-of-focus / soft-reveal). `amount` is
   *  the blur radius (0.3..40; bigger = softer). Distinct from the other blurs - motionBlur is directional,
   *  zoomBlur is radial, tiltShift blurs only outside a band, glow blurs only the highlights, and the `dreamy`
   *  LOOK preset is a fixed sigma + grade; this is the plain tunable isotropic blur none of them provide, and
   *  it composes on top of any of them. DATA (L090). */
  defocus?: { amount: number };
  /** #178 Fisheye: barrel / pincushion lens distortion (a GoPro-style bulge or a pinch). `strength` is -1..1
   *  (the lens k1 coefficient): negative bulges the frame outward from center (barrel/fisheye), positive
   *  pinches it inward (pincushion). This is the first OPTICAL/geometric warp effect (distinct from every
   *  color grade and blur - it moves pixels, it does not recolor or soften them). DATA (L090). */
  fisheye?: { strength: number };
  /** #179 Warmth: static white-balance / color-temperature tint. `amount` is -1..1: positive warms the frame
   *  (shift toward orange/tungsten), negative cools it (shift toward blue/daylight). Distinct from #178 (that
   *  warps geometry) and from `warmthRamp` (which ANIMATES warmth over the clip) - this is a fixed tunable
   *  grade, the static tunable version the fixed `warm`/`cool` LOOK presets do not provide. DATA (L090). */
  warmth?: { amount: number };
  /** #180 Color splash (selective color): keep ONE color and turn everything else gray (the classic "color
   *  pop" look). `color` is the hue to keep (any color the compositor understands); `similarity` (0.01..1) is
   *  how wide a hue band around it survives. Distinct from every grade/blur/warp - it is a color-KEY, not a
   *  recolor. DATA (L090). Materializes to the snake-cased `color_splash` on the EDL. */
  colorSplash?: { color: string; similarity: number };
  /** #181 Perspective: keystone tilt (the "looking up/down at it" trapezoid warp). `tilt` is -1..1: positive
   *  pulls the TOP edge inward (top narrower, like looking up), negative pulls the BOTTOM edge inward. A second
   *  OPTICAL/geometric warp (distinct from #178 fisheye's barrel bulge - this is a planar keystone). DATA. */
  perspective?: { tilt: number };
  smooth?: { amount: number };
  directionalBlur?: { amount: number; axis: 'h' | 'v' };
  binarize?: { cutoff: number };
  swirl?: { strength: number };
  mirror?: { axis: 'h' | 'v' };
  tile?: { count: number };
  /** #163 Halftone: render the frame as a comic / newspaper dot-screen. Each `size`-px cell becomes a black
   *  dot on white whose radius grows as the local brightness drops (dark areas = big dots, bright areas =
   *  tiny/no dots), so the image reads as 1-bit ink dots. Distinct from posterize (which keeps colors in
   *  bands): this is a monochrome print screen. A COMPUTED per-pixel pattern the grade seam cannot express.
   *  `size` is the dot cell in px (2..40; larger = coarser dots). Blind DATA (L090). */
  halftone?: { size: number };
  /** #164 Tilt-shift / focus band: keep a horizontal band SHARP and blur everything above and below it
   *  (the toy-miniature fake-depth / subject-focus look). `center` and `height` (normalized 0..1) place and
   *  size the in-focus band; `feather` (normalized 0..1, default 0.1) softens its edges; `blur` is the blur
   *  sigma for the out-of-focus area (default 8). A SPATIALLY-VARYING blur the uniform gblur/grade seam
   *  cannot express. Blind DATA (L090); dropped unless height > 0. */
  tiltShift?: { center: number; height: number; feather?: number; blur?: number };
  /** #165 Sketch / edge-detect: render the frame as line-art or a cartoon-shaded drawing by detecting
   *  edges. `mode` selects the look ('colormix' = cartoon, edges darkened over the image; 'canny' or
   *  'wires' = white line-art on black); `strength` 0..1 raises how many edges are found (more = busier
   *  lines). Blind DATA; the render maps strength to the detector thresholds. */
  sketch?: { mode?: string; strength?: number };
  /** #167 Zoom / radial blur: motion streaks radiating from a center point (the "speed zoom" hype look).
   *  `strength` 0..1 scales how far the streaks spread; `cx`/`cy` (0..1) place the center (default frame
   *  center). Blind DATA; the render averages taps sampled toward the center to make the streaks. */
  zoomBlur?: { strength: number; cx?: number; cy?: number };
  /** #168 Light leak: a soft colored bloom of light bleeding in from a point (the film "light leak" look),
   *  screen-blended so it LIGHTENS the frame toward the leak color, strongest at the point and fading out.
   *  `strength` 0..1; `color` (default warm orange); `x`/`y` (0..1) place the source (default top-right);
   *  `radius` (0..1 of the diagonal) sizes the falloff. Generated procedurally, no asset. Blind DATA. */
  lightLeak?: { strength: number; color?: string; x?: number; y?: number; radius?: number };
  /** #169 Film damage (old-film look): flickering vertical scratch lines and dust specks that jump position
   *  each frame. `scratches` is the number of vertical scratch lines, `dust` the number of dust specks, and
   *  `strength` 0..1 their opacity. Generated procedurally, no asset. Blind DATA; the render owns the timing. */
  filmDamage?: { scratches?: number; dust?: number; strength?: number };
  /** #171 Hue rotation: spin the color wheel `degrees` (-360..360), an optional `saturation`
   *  multiplier (0..3), and an optional `cycleRate` (deg/sec) that continuously rotates the hue over
   *  time for an animated rainbow cycle. One field, two capabilities (static shift AND animated cycle,
   *  L069). Distinct from colorAdjust (brightness/contrast/saturation/gamma, no hue). Blind DATA (L090). */
  hueShift?: { degrees: number; saturation?: number; cycleRate?: number };
  /** #146 Camera shake (the CapCut/action "impact" hit + handheld rumble): jitter the whole frame by
   *  cropping an aspect-preserving inset window whose x/y offset oscillates over time, then scaling
   *  back to fill. The creative INVERSE of `stabilize` (#85). `amplitude` is the max offset as a
   *  fraction of the frame (clamped 0..0.2); `frequency` = oscillations per second (default 8, a
   *  handheld rumble); `decay` (>0) makes the shake die out linearly over the clip for a single impact
   *  hit (0/absent = sustained). An L069 configuration of the same animated-crop primitive as reframe
   *  and Ken Burns; the render owns the oscillation math, the DATA is three blind scalars (L090). */
  shake?: { amplitude: number; frequency?: number; decay?: number };
  /** #119 Whole-clip orientation: `rotateDegrees` (90/180/270 quarter-turns) reorients footage shot
   *  sideways; `flip` ('h'|'v'|'hv') mirrors it. The render reorients then normalizes back to the
   *  target aspect. Blind DATA (L090); this is the whole-clip twin of the split per-cell flip. */
  rotateDegrees?: number;
  flip?: 'h' | 'v' | 'hv';
  /** #120 Manual crop / zoom rect: select a normalized 0..1 sub-rectangle of the source ({x,y,w,h}
   *  as fractions) and the render scales it to fill the canvas. The explicit-region twin of auto
   *  reframe (aspect-follow) and Ken Burns / punch-in (center zoom): any off-center crop, logo
   *  removal, or manual zoom. Blind DATA (L090); full-frame (0,0,1,1) is identity and dropped. */
  cropRect?: { x: number; y: number; w: number; h: number };
  /** #121 Manual color adjustment (the CapCut "Adjust" / Lumetri-basic daily driver): continuous
   *  brightness (-1..1 additive), contrast (0..~3, 1 = none), saturation (0..3, 1 = none), gamma
   *  (0.1..10, 1 = none). Distinct from the fixed LOOK_CATALOG presets: this is the manual, continuous
   *  tweak that STACKS on top of a look (render applies grade then this eq). Blind DATA (L090); an
   *  all-default {1,1,1} + brightness 0 adjustment is identity and dropped. */
  colorAdjust?: { brightness?: number; contrast?: number; saturation?: number; gamma?: number };
  /** #122 Self-glow / bloom (the CapCut "Glow" / cinematic bloom): the clip's own bright areas bleed
   *  a soft halo. Screen-blends a blurred copy of the clip over itself, so only highlights bloom.
   *  `glowStrength` 0..1 (default 0.5) scales the blur spread + blend intensity. NOT a LOOK_CATALOG row
   *  (it needs a split/blend graph, not a linear filter). Blind DATA (L090). */
  glow?: boolean;
  glowStrength?: number;
  /** #123 Sharpen / clarity (the CapCut "Sharpen" daily driver): crispen edge detail. `sharpen` 0..1
   *  scales the unsharp-mask luma amount (0 = none). A linear detail control (its own continuous field,
   *  like colorAdjust), distinct from the color looks. Blind DATA (L090); 0 is identity and dropped. */
  sharpen?: number;
  /** #124 Border / frame: draw a solid colored border inside the clip's edges. `width` is the
   *  thickness in px (at the render canvas scale), `color` is any ffmpeg color (name or 0xRRGGBB).
   *  A common social/meme frame. Blind DATA (L090); width 0 is identity and dropped. */
  border?: { width: number; color: string };
  /** #125 Spotlight / positioned radial focus: darken the frame everywhere except around a chosen
   *  center, to pull the eye to a subject anywhere in frame. `cx`/`cy` are the normalized 0..1 focus
   *  center, `strength` 0..1 the falloff. Distinct from the fixed centered `vignette` look: this is
   *  positionable + adjustable DATA. Blind DATA (L090); strength <= 0 is identity and dropped.
   *  #154 `track` is the L069 generalization of the static center: a keyframed path the focus
   *  FOLLOWS over the clip (each entry `at` a fraction 0..1 of the clip, cx/cy the normalized
   *  center at that moment). The render linearly interpolates cx/cy across the clip (the eye
   *  follows a moving subject: the ball, a face, a cursor). A valid track needs >= 2 points;
   *  otherwise it is dropped and the static cx/cy applies.
   *  #201 `pulse` (cycles/sec, 0..10) is the temporal generalization of the static falloff: a positive
   *  pulse sinusoidally BREATHES the darkening depth over time (a tension/heartbeat throb), the axis
   *  #154 track does not touch (track moves the POSITION, pulse modulates the DEPTH). Composes with both
   *  the static center and a moving track. 0/absent = the existing static falloff. */
  spotlight?: { cx: number; cy: number; strength: number; pulse?: number; track?: Array<{ at: number; cx: number; cy: number }> };
  /** #126 Framed clip (the Screen Studio / CleanShot "beautiful screen recording" look): shrink the
   *  clip to `scale` (0.1..1) and center it on a background, so it sits inside padding. `background` is
   *  either an ffmpeg color (name / 0xRRGGBB) OR 'blur' (a blurred zoomed copy of the clip fills the
   *  bars). Composes with #124 border (border first, then the framed shrink). Blind DATA (L090);
   *  scale >= 1 is identity (no shrink) and dropped. */
  frame?: { scale: number; background: string };
  /** #127 Duotone (the Instagram / CapCut two-color gradient map): map the clip's LUMA to a gradient
   *  between `shadow` (dark tones) and `highlight` (bright tones), both #RRGGBB hex. A trendy stylized
   *  look, parameterized by any two colors (distinct from the fixed LOOK_CATALOG presets). Blind DATA
   *  (L090); dropped unless both colors are valid 6-digit hex. */
  duotone?: { shadow: string; highlight: string };
  /** #172 Gradient map (the CapCut / Premiere-Lumetri / DaVinci "gradient map" tonal grade): map the
   *  clip's normalized LUMA to a MULTI-STOP color ramp. `stops` is a sorted list of >= 2 {at (0..1),
   *  color (named or 6-hex)} points; the render blends the two surrounding stop colors piecewise-linearly
   *  at each pixel's luma. The N-stop generalization of #127 duotone (which is exactly two stops,
   *  shadow at 0 and highlight at 1). Blind DATA (L090); dropped unless >= 2 valid stops survive. */
  gradientMap?: { stops: Array<{ at: number; color: string }> };
  /** #128 Rounded corners (the Screen Studio / Arc "beautiful card" finisher): round the clip's
   *  corners, filling the cut corners with `background`. `radius` is a 0..0.5 fraction of the shorter
   *  side (resolution-independent). Applied to the FINAL composited frame, so it rounds whatever is
   *  there (a full clip -> rounded clip on the bg; composed with #126 frame -> an outer rounded card).
   *  Completes the framed-clip family (#124 border, #126 frame). Blind DATA (L090); radius <= 0 is
   *  identity and dropped. Maps to EDL `rounded_corners`. `feather` (0..1, #133) softens the corner ARC:
   *  the render blends the clip into the background over a band along the arc (straight edges stay hard),
   *  for an anti-aliased card. feather 0 (default) is the hard corner. */
  roundedCorners?: { radius: number; background: string; feather: number };
  /** #129 Drop shadow (the Screen Studio "floating card" finisher): shrink the clip to `scale`, cast a
   *  blurred offset dark copy behind it on a `background`, and overlay the sharp card on top. A
   *  self-contained floating-card look (a superset of #126 frame; use one or the other, not both).
   *  `scale` 0.1..0.99 is the card size, `blur` the shadow softness (px), `dx`/`dy` the shadow offset
   *  (px), `color` the shadow color, `background` the canvas fill. Completes the framed-clip family
   *  (#124 border, #126 frame, #128 rounded corners). Blind DATA (L090); dropped when absent. Maps to
   *  EDL `drop_shadow`. */
  dropShadow?: { scale: number; blur: number; dx: number; dy: number; color: string; background: string; cornerRadius: number };
  /** #130 Region filter / censor (blur a face, pixelate a plate, black out private info, or apply ANY
   *  effect to just a sub-rectangle): `x`/`y`/`w`/`h` are the normalized 0..1 region and `filter` is an
   *  OPAQUE ffmpeg video-filter string applied to only that cropped region, then composited back. The
   *  region is DATA (numeric, bounds-clamped); the effect is the L090/L111 opaque seam (the twin of
   *  `grade`/`denoise`/`viz_filter`), so `boxblur=...`, `pixelize=...`, `drawbox=...:t=fill` (blackout),
   *  `negate`, `hue=s=0`, etc. ALL work with zero code per mode. Blind DATA (L090); dropped unless
   *  `filter` is a non-empty string and w,h > 0. Maps to EDL `region_filter`. */
  regionFilter?: RegionFilter;
  /** #137 Multiple region filters -- the L069 list generalization of #130. `regionFilter` (singular)
   *  is just n=1; this is N independent censors/effects, each its own {x,y,w,h,filter} rectangle applied
   *  in order (blur one face AND pixelate a plate AND black out a badge in one clip). Same numeric bounds
   *  + opaque-filter (L090) seam per element; invalid elements (no filter, zero size) are dropped. The
   *  render treats the effective region list as [regionFilter, ...regionFilters], so there is ONE render
   *  loop, not a per-region branch. Maps to EDL `region_filters` (array). */
  regionFilters?: RegionFilter[];
  /** #143 Animated progress bar burned along the top/bottom that fills left-to-right over the clip duration
   *  (the social-video watch-progress staple). `height` is the bar thickness as a fraction of the frame
   *  height (0..1); `color` is a name/hex parsed to RGB ints (injection-safe); `edge` is 'bottom' (default)
   *  or 'top'. Dropped unless height > 0. Maps to EDL `progress_bar`. */
  progressBar?: { height: number; color: string; edge?: 'top' | 'bottom'; markers?: number[]; markerColor?: string };
  /** #144 Live timer text burned on the clip: 'elapsed' counts up (MM:SS), 'countdown' ticks the seconds
   *  remaining down to 0. `corner` (tl/tr/bl/br, default tr) places it; `size` is the font px; `color` is a
   *  name/hex (injection-safe). Dropped unless mode is a known value. Maps to EDL `timer`. */
  timer?: { mode: 'elapsed' | 'countdown'; corner?: 'tl' | 'tr' | 'bl' | 'br'; size?: number; color?: string };
  /** #147 Countdown ring: a circular arc HUD that sweeps clockwise from 12 o'clock over the clip (the
   *  Instagram-story / intro countdown the LINEAR #143 progress bar cannot express). `mode` 'fill' GROWS the
   *  arc (elapsed) and 'deplete' SHRINKS it (a true countdown). `radius`/`thickness` are fractions of the
   *  frame's short side (min(W,H)); `x`/`y` are the normalized 0..1 center; `color` is a name/hex. A POLAR
   *  configuration of the same geq single-color-replace HUD family as the progress bar. Maps to EDL
   *  `countdown_ring`; the render owns the polar/time math, the DATA is blind style scalars (L090). */
  countdownRing?: { radius?: number; thickness?: number; color?: string; x?: number; y?: number; mode?: 'fill' | 'deplete' };
  /** #148 Marker-synced flashes (beat-sync pulses): a DATA list of clip-local timestamps at which the frame
   *  briefly brightens (a triangular flash peaking at `at`), the music-video "hit/cut on the beat" staple as a
   *  COMPUTED timing primitive the static `grade` seam cannot express. `at` = seconds into the clip; `strength`
   *  is the 0..1 brightness boost (default 0.5); `duration` = the full flash width in secs (default 0.16). The
   *  render folds the whole list into ONE eq=brightness expression (eval=frame); a beat-detector producer just
   *  writes the DATA, the render owns the timing math (L090). Maps to EDL `pulses`. */
  pulses?: Array<{ at: number; strength?: number; duration?: number; kind?: 'flash' | 'punch' | 'shake' | 'glitch' | 'tint'; color?: string }>;
  /** #149 Letterbox / cinematic bars: mask the frame to a target aspect ratio with solid bars (the 2.39:1
   *  "cinemascope" look, or any ratio). `aspect` = target width/height (default 2.39); the render computes
   *  the bar thickness from the frame ratio vs the target, adding TOP/BOTTOM bars when the target is WIDER
   *  than the frame and LEFT/RIGHT bars when it is TALLER. `color` is a name/hex (default black). A computed-
   *  geometry primitive (bar size derived from W/H, not a static filter). Maps to EDL `letterbox`. */
  letterbox?: { aspect?: number; color?: string };
  /** #152 Gradient scrim: a linear darken/tint ramp toward one edge, for caption legibility (the lower-third
   *  "scrim" every captioned video needs so text stays readable over any footage). `edge` (top/bottom/left/
   *  right, default bottom); `strength` 0..1 = the max opacity AT that edge, fading to 0 at the opposite edge
   *  (default 0.6); `color` a name/hex to tint toward (default black = a plain darken). Distinct from the
   *  UNIFORM `grade`: it is a computed X/Y ramp the render owns. Maps to EDL `scrim`. */
  scrim?: { edge?: 'top' | 'bottom' | 'left' | 'right'; strength?: number; color?: string };
  /** #153 Highlight sweep (kinetic-caption "highlighter marker"): a translucent colored box over a NORMALIZED
   *  region {x,y,w,h} (0..1) that WIPES left-to-right from empty to full over [start, start+duration], the
   *  emphasis effect that reveals a phrase as it is spoken. `color` name/hex (default yellow), `opacity` 0..1
   *  (default 0.5), `start`/`duration` secs (default 0 / 0.4). Singular `highlight` + list `highlights` (many
   *  phrases); the render composites the effective list, one timed geq blend each. A computed-timing primitive
   *  the static grade seam cannot express. Named `highlightSweep` to stay distinct from #98 auto-highlight
   *  (transcript-energy auto-trim). Maps to EDL `highlight_sweep` / `highlight_sweeps`. */
  highlightSweep?: { x: number; y: number; w: number; h: number; color?: string; opacity?: number; start?: number; duration?: number };
  highlightSweeps?: Array<{ x: number; y: number; w: number; h: number; color?: string; opacity?: number; start?: number; duration?: number }>;
  /** #131 Ellipse / circle mask (iris reveal, circular video, oval spotlight): show the clip through an
   *  ellipse centered at `cx`/`cy` with normalized radii `rx`/`ry`, filling everything OUTSIDE the ellipse
   *  with `background`. A circle is `rx*W == ry*H`. Same geq single-color-replace family as #128 rounded
   *  corners (a pixel is outside when ((X-cx)/rx)^2 + ((Y-cy)/ry)^2 > 1). The bg color is parsed to RGB
   *  ints, so injection is structurally impossible. Blind DATA (L090); dropped unless rx,ry > 0. Maps to
   *  EDL `ellipse_mask`. `feather` (0..1, #132) softens the edge: the render blends the clip into the
   *  background over a band near the ellipse boundary instead of a hard cut (the pro vignette/spotlight
   *  look). feather 0 (default) is the hard edge. `reveal` (#135) animates the mask: the radii scale by a
   *  time factor ramping `from`->`to` over [`start`, start+`duration`] seconds, so the clip reveals through a
   *  growing/shrinking circle (iris in `from:0,to:1` / iris out `from:1,to:0`). */
  ellipseMask?: {
    cx: number; cy: number; rx: number; ry: number; background: string; feather: number;
    reveal?: { from: number; to: number; start: number; duration: number };
  };
  /** #136 Split-tone color grade (the cinematic 3-way "color wheels" look, e.g. teal shadows + orange
   *  highlights): shift the RGB balance of shadows / midtones / highlights independently, each channel a
   *  -1..1 push. The industry-standard color grade (ffmpeg colorbalance), distinct from #127 duotone (which
   *  REPLACES color) and #121 colorAdjust (global). All-numeric so injection is impossible. Blind DATA
   *  (L090); dropped when every channel is 0. Maps to EDL `split_tone`. */
  splitTone?: {
    shadows: { r: number; g: number; b: number };
    mids: { r: number; g: number; b: number };
    highlights: { r: number; g: number; b: number };
  };
  /** #89 Loop / boomerang: repeat the clip `loopCount` times. When `loopBoomerang`, every odd
   *  repeat plays reversed so the motion ping-pongs (forward, back, forward, ...). The render
   *  concats N copies of the built clip; the clip's on-timeline length becomes loopCount x its own.
   *  A loopCount <= 1 is a no-op. Maps to EDL `loop_count` / `loop_boomerang`. */
  loopCount?: number;
  loopBoomerang?: boolean;
  /** #93 Loudness normalization (EBU R128): target integrated LUFS for this clip's audio (-14 social
   *  default, -16 podcast, -23 broadcast). The render runs ffmpeg loudnorm; the number is DATA. */
  loudnorm?: number;
  /** Stored-bytes address of a .cube LUT resolved into a `${LUT}` placeholder in `grade`. */
  grade_lut_ref?: string;
  /** A burned-in caption riding the SAME set-transform op. `text` is the caption;
   *  `x`/`y` are the NORMALIZED position (0..1) of the text box within the frame —
   *  x: 0 left / 0.5 center / 1 right; y: 0 top / 0.5 middle / 1 bottom. This is the
   *  generative position primitive: the 9 alignment anchors AND any freeform drop
   *  are all just (x,y) values. There is NO corner enum. `size`/`color` are optional
   *  style. video-compose buildClip burns it via drawtext using the SAME (x,y).
   *  Empty/absent text = no caption. (`corner` retained read-only for legacy DATA.) */
  caption?: { text: string; x?: number; y?: number; size?: number; color?: string; corner?: string };
  /** An IN-transition applied at the START of this clip (the blend from the previous
   *  clip). `renderer` selects the capability (default 'xfade'), `type` is the xfade
   *  transition name (fade/wipeleft/slideright/…) — DATA, not code. `duration` seconds.
   *  segmentsOf reads consecutive clips' transitions into edl.spine.transitions, which
   *  video-compose's universal transition primitive already renders (L069). */
  transition?: { renderer?: string; type?: string; duration?: number };
  /** Split-screen / grid: tile this clip's source with N MORE sources into ONE frame, so the
   *  you-vs-a-pro side-by-side, a before/after two-up, and a 4-up product grid are all one
   *  mechanism. `with` = the extra source refs placed alongside this clip (cell 0 is this clip's
   *  own source); `layout` is 'h' (side-by-side, default), 'v' (stacked), or 'grid'; `weights`
   *  sizes the cells; `labels` burns an optional per-cell caption (labels[0] = this clip). REUSES
   *  the render's existing kind:'split' compositor (buildSplit) via a materialize branch, so there
   *  is ZERO new render code (L069). The render stays blind: a sports compare and a product grid
   *  are the SAME mechanism over different DATA. */
  splitScreen?: { with: string[]; layout?: 'h' | 'v' | 'grid'; weights?: number[]; labels?: string[];
    /** Per-cell framing, index-aligned (cell 0 = this clip, cell i = with[i-1]). `crop` frames a
     *  source-px window (tighten onto a player); `flip` ('h'|'v'|'hv') mirrors a cell so a lefty and
     *  righty, or two opposite camera angles, face the same way in the compare. buildSplit already
     *  reads per-source crop/flip, so this is DATA only, zero new render code (L069). */
    cells?: Array<{ crop?: { w: number; h: number; x: number; y: number }; flip?: string;
      /** Source-seconds offset where this cell begins, so the two clips can be nudged into
       *  stroke-phase sync (the DATA lever a pose-matcher sets to align the compare). buildSplit
       *  reads per-source in/out, so this is DATA only (L069). */
      start_at?: number }> };
};

export type MaterializedClip = {
  /** Stable id derived from source + decision lineage — never from Date.now(). */
  clipId: string;
  sourceId: string;
  laneRole: string;
  label: string;
  /** Seconds into the source file where this clip starts. */
  inPoint: number;
  /** Seconds into the source file where this clip ends. */
  outPoint: number;
  /** Seconds on the lane timeline where this clip starts. */
  laneStart: number;
  /** Seconds on the lane timeline where this clip ends. */
  laneEnd: number;
  transform: ClipTransform;
};

export type MaterializedLane = {
  laneId: string;
  role: string;
  label: string;
  /**
   * Resolved visual tone the blind timeline renderer paints directly. This is DATA:
   * the renderer never re-derives tone from role keywords. The default role→tone
   * mapping is Society configuration owned here at the translation boundary (L098),
   * overridable by lane data today and by an EEAF tone picker tomorrow. A lane of any
   * role — "audio", "review", "lightbulb" — resolves to a stable tone here, not in the
   * component. (Physics vs Society / L039.)
   */
  tone: string;
  clips: MaterializedClip[];
  duration: number;
};

/**
 * A timeline OVERLAY element (title / lower-third / caption / shape / arrow-callout / sticker /
 * logo). Self-describing DATA over ONE primitive: `overlay_kind` = 'text' (drawtext) or 'image'
 * (any raster asset, so every shape/arrow/callout dissolves to a single image row, L069). Each
 * carries its own {x,y,start,end} on the global timeline, independent of any clip. The L162
 * arrow-plus-handwriting idiom is one 'image' overlay (the arrow) + one 'text' overlay (the
 * handwriting label).
 */
export type OverlayElement = {
  /** Stable row identity for later caption-position commands. */
  id?: string;
  overlay_kind: 'text' | 'image' | 'video' | 'region' | 'audioviz';
  /** #101 Motion track: a subject path `[{t,x,y}]` (normalized 0..1, t in seconds). When present, the
   *  render binds this overlay's x/y to the piecewise-linear track so the overlay FOLLOWS the subject
   *  (a label/emoji/blur pinned to a moving face). Produced by detect-track; the render is blind. */
  track?: Array<{ t: number; x: number; y: number }>;
  /** #96 Audio-reactive visualizer producer key (waveform / spectrum / cqt / bars). The overlay's
   *  video is GENERATED from the program audio by the render; x/y/width/height are normalized 0..1. */
  viz?: string;
  /** #115 Entrance / exit MOTION. `enter`/`exit` are named TEXT_MOTION_CATALOG presets (slide-left,
   *  fade, pop, ...) sized by `enter_dur`/`exit_dur` (seconds), which materialize expands into per-axis
   *  `keyframes` {x|y|alpha: [{t,value,interp?}]}; explicit `keyframes` override per axis. The render
   *  compiles each axis with the ONE piecewiseExpr primitive (slide/fade/pop, zero render enum). */
  enter?: string;
  exit?: string;
  enter_dur?: number;
  exit_dur?: number;
  keyframes?: Record<string, Array<{ t: number; value: number; interp?: string }>>;
  start?: number;
  end?: number;
  x?: number | string;
  y?: number | string;
  // region (privacy blur / mosaic censor of a rectangle of the frame itself)
  height?: number;
  region_mode?: 'blur' | 'mosaic';
  region_strength?: number;
  // text
  text?: string;
  size?: number;
  color?: string;
  box?: boolean;
  box_color?: string;
  // #90 per-overlay caption translation override: target BCP-47 lang + producer key (+ inline glossary).
  translate_to?: string;
  translate_producer?: string;
  translate_glossary?: Record<string, string>;
  // image
  image_ref?: string;
  image_path?: string;
  width?: number;
  scale?: number;
  opacity?: number;
  rotate?: number;
  // video (picture-in-picture / green-screen composite over the spine)
  source_ref?: string;
  source_path?: string;
  chroma_key?: string;
  // matte (grayscale alpha video from person-segmentation or any producer): keys the overlay
  // transparent by its luma (alphamerge). The generic "green screen without a screen" alpha source.
  // `matte` is a PRODUCER key (e.g. 'person') the render runs on the source to generate the matte;
  // matte_ref/matte_path point at an already-produced matte artifact. Either supplies the alpha.
  matte?: string;
  matte_ref?: string;
  matte_path?: string;
  /** #92 Blend mode: an opaque ffmpeg `all_mode` key (screen/multiply/overlay/add/lighten/darken/
   *  softlight/...) that composites this overlay over the spine instead of a plain alpha overlay.
   *  A blend overlay is scaled to the full canvas (light leak / grain / glow / texture is full-frame).
   *  Opaque DATA (L090): the render passes it straight to ffmpeg, so any blend mode works. */
  blend?: string;
  /** Animate the overlay in/out: seconds of alpha fade at the start/end of its window. */
  fade_in?: number;
  fade_out?: number;
};

export type MaterializedComposition = {
  lanes: MaterializedLane[];
  durationSeconds: number;
  markers: { id: string; label: string; time: number }[];
  /** Last-wins committed transform across the whole composition. */
  globalTransform: ClipTransform;
  /** Timeline overlays (titles / lower-thirds / shapes / callouts), authored via `add-overlay`. */
  overlays: OverlayElement[];
  /** #90 Composition-wide caption translation: `{to, producer, glossary?}` applied to every burned
   *  text by the render (captions / titles / cards). Authored via the `translate-captions` action;
   *  a text overlay can override it. Undefined = no translation (captions render as authored). */
  captionTranslate?: { to: string; producer: string; glossary?: Record<string, string> };
  /** #93 Master-bus loudness normalization target (integrated LUFS) for the finished program. */
  masterLoudnorm?: number;
};

// ── Internal fold state ───────────────────────────────────────────────────────

type FoldState = {
  lanes: Map<string, MaterializedClip[]>;
  laneOrder: string[];
  laneMeta: Map<string, { role: string; label: string; tone?: string }>;
  globalTransform: ClipTransform;
  overlays: OverlayElement[];
  captionTranslate?: { to: string; producer: string; glossary?: Record<string, string> };
  masterLoudnorm?: number;
};

// ── ID derivation (deterministic, no random) ──────────────────────────────────

function clipId(sourceId: string, laneRole: string, suffix: string): string {
  return `clip:${sourceId}:${laneRole}:${suffix}`;
}

// ── Parameter extraction helpers ─────────────────────────────────────────────

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function sourceIdFromRef(sourceRef: Record<string, unknown> | undefined): string {
  if (!sourceRef) return 'unknown';
  return (
    asString(sourceRef['source_id']) ??
    asString(sourceRef['id']) ??
    asString(sourceRef['multihash']) ??
    asString(sourceRef['cas_address']) ??
    'unknown'
  );
}

/** Find the clip in state that contains `laneTime`. Returns index or -1. */
function clipIndexAt(clips: MaterializedClip[], laneTime: number): number {
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (laneTime > c.laneStart && laneTime < c.laneEnd) return i;
  }
  return -1;
}

/** Shift all clips starting at `fromIndex` left by `gapSeconds`. */
function shiftClipsLeft(clips: MaterializedClip[], fromIndex: number, gapSeconds: number): MaterializedClip[] {
  return clips.map((c, i) => {
    if (i < fromIndex) return c;
    const shift = Math.min(gapSeconds, c.laneStart);
    return { ...c, laneStart: c.laneStart - shift, laneEnd: c.laneEnd - shift };
  });
}

/** Re-sort clips within a lane by laneStart. */
function sortByLaneStart(clips: MaterializedClip[]): MaterializedClip[] {
  return [...clips].sort((a, b) => a.laneStart - b.laneStart);
}

// ── Base clip builder ─────────────────────────────────────────────────────────

function baseClipFromItem(
  item: MediaWorkspaceView['lanes'][number]['items'][number],
  laneRole: string,
  laneStart: number,
): MaterializedClip {
  const inPoint = asNumber(item.start) ?? 0;
  const outPoint = asNumber(item.end) ?? inPoint;
  const duration = Math.max(0, outPoint - inPoint);
  return {
    clipId: clipId(item.item_id, laneRole, 'base'),
    sourceId: item.item_id,
    laneRole,
    label: item.label,
    inPoint,
    outPoint,
    laneStart,
    laneEnd: laneStart + duration,
    transform: {},
  };
}

// ── Fold action map (L090 — action is the discriminant, handler is the value) ─

type FoldFn = (state: FoldState, decision: MediaCompositionEditDecision, decisionIndex: number) => FoldState;

/**
 * add-overlay: author a timeline overlay (title / lower-third / caption / shape / arrow-callout /
 * sticker / logo) as self-describing DATA. `overlay_kind` selects text vs image; the rest are
 * DATA fields the render composites. Zero new code per overlay kind, since a shape IS an image.
 */
function foldAddOverlay(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const kindRaw = asString(params['overlay_kind']) ?? (
    params['region_mode'] !== undefined ? 'region'
    : params['text'] !== undefined ? 'text'
    : (params['source_ref'] !== undefined || params['source_path'] !== undefined || params['matte'] !== undefined || params['matte_ref'] !== undefined || params['matte_path'] !== undefined) ? 'video'
    : (params['image_ref'] !== undefined || params['image_path'] !== undefined) ? 'image'
    : params['viz'] !== undefined ? 'audioviz'
    : undefined);
  if (kindRaw !== 'text' && kindRaw !== 'image' && kindRaw !== 'video' && kindRaw !== 'region' && kindRaw !== 'audioviz') return state;
  const overlay: OverlayElement = { overlay_kind: kindRaw };
  const numKeys = ['start', 'end', 'size', 'width', 'height', 'scale', 'opacity', 'rotate', 'fade_in', 'fade_out', 'region_strength', 'enter_dur', 'exit_dur'] as const;
  for (const k of numKeys) { const v = asNumber(params[k]); if (v !== undefined) (overlay as Record<string, unknown>)[k] = v; }
  const strKeys = ['text', 'color', 'box_color', 'image_ref', 'image_path', 'source_ref', 'source_path', 'chroma_key', 'matte', 'matte_ref', 'matte_path', 'region_mode', 'translate_to', 'translate_producer', 'blend', 'viz', 'enter', 'exit'] as const;
  for (const k of strKeys) { const v = asString(params[k]); if (v !== undefined) (overlay as Record<string, unknown>)[k] = v; }
  // #115 A per-axis keyframe envelope {x|y|alpha: [{t,value,interp?}]} for entrance/exit MOTION, passed
  // through verbatim to the render's piecewiseExpr (the `enter`/`exit` presets above are DATA shorthand
  // that materialize expands into these same envelopes; explicit keyframes win per axis).
  const okf = asRecord(params['keyframes']);
  if (okf) overlay.keyframes = okf as OverlayElement['keyframes'];
  const tg = asRecord(params['translate_glossary']);
  if (tg) overlay.translate_glossary = tg as Record<string, string>;
  // #101 A `track` path [{t,x,y}] makes the overlay follow the subject; kept as sanitized DATA.
  const trk = params['track'];
  if (Array.isArray(trk)) {
    const pts = trk
      .map((p) => (p && typeof p === 'object' ? p as Record<string, unknown> : {}))
      .filter((p) => Number.isFinite(p['t']) && Number.isFinite(p['x']) && Number.isFinite(p['y']))
      .map((p) => ({ t: p['t'] as number, x: p['x'] as number, y: p['y'] as number }));
    if (pts.length > 0) overlay.track = pts;
  }
  if (typeof params['box'] === 'boolean') overlay.box = params['box'] as boolean;
  // x/y accept number or an ffmpeg position expr string ('W-w-24').
  for (const k of ['x', 'y'] as const) {
    const raw = params[k];
    if (typeof raw === 'number' && Number.isFinite(raw)) overlay[k] = raw;
    else { const s = asString(raw); if (s !== undefined) overlay[k] = s; }
  }
  // A `pip_corner` preset (top-left / bottom-right / center / ...) resolves to x/y ONLY when
  // no explicit x/y was given, and gives a video PiP a default 0.3 scale so it reads as an
  // inset, not a full-frame cover. The render is untouched: it still just consumes x/y/scale.
  const corner = asString(params['pip_corner']) ?? asString(params['corner']);
  const cornerPos = corner ? PIP_CORNER_CATALOG[corner] : undefined;
  if (cornerPos) {
    if (overlay.x === undefined) overlay.x = cornerPos.x;
    if (overlay.y === undefined) overlay.y = cornerPos.y;
    if (overlay.overlay_kind === 'video' && overlay.width === undefined && overlay.scale === undefined) overlay.scale = 0.3;
  }
  return { ...state, overlays: [...state.overlays, overlay] };
}

/**
 * add-captions: expand a DATA `lines` array ([{text, start, end}], grouped upstream by
 * caption-lines.ts) into one timed text overlay per line, sharing a `style` DATA row
 * (size/color/x/y/box/box_color/fade_in/fade_out). This is the Descript/CapCut burned-in
 * subtitle feature as PURE DATA over the existing text-overlay render (drawtext timed by
 * between(t,start,end)): zero new render code, the fold stays blind (L090). Defaults place
 * captions centered near the bottom (normalized x 0.5, y 0.9) with a translucent box.
 */
function foldAddCaptions(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const rawLines = params['lines'];
  if (!Array.isArray(rawLines)) return state;
  const style = asRecord(params['style']) ?? {};
  const sNum = (k: string, d?: number): number | undefined => asNumber(style[k]) ?? d;
  const sStr = (k: string, d?: string): string | undefined => asString(style[k]) ?? d;
  const baseX = sNum('x', 0.5);
  const baseY = sNum('y', 0.9);
  const size = sNum('size');
  const color = sStr('color', 'white');
  const boxColor = sStr('box_color', 'black@0.5');
  const box = typeof style['box'] === 'boolean' ? style['box'] as boolean : true;
  const fadeIn = sNum('fade_in');
  const fadeOut = sNum('fade_out');
  // `reveal` selects the caption cadence as DATA: 'line' (default) shows the whole line at
  // once; 'word' is karaoke (CapCut/TikTok) that reveals ONE word at a time in `active_color`.
  // Both are the SAME text-overlay render (timed drawtext), just different DATA windows (L090).
  const reveal = sStr('reveal', 'line');
  const activeColor = sStr('active_color', 'yellow');

  const captions: OverlayElement[] = [];
  for (const raw of rawLines) {
    const line = asRecord(raw);
    const text = line ? asString(line['text']) : undefined;
    const start = line ? asNumber(line['start']) : undefined;
    const end = line ? asNumber(line['end']) : undefined;
    if (!text || !text.trim() || start === undefined || end === undefined) continue;
    const words = line ? line['words'] : undefined;
    if (reveal === 'word' && Array.isArray(words) && words.length > 0) {
      // Karaoke: emit one overlay per word, each gated to its own [start,end], accent-colored.
      for (const [wordIndex, wRaw] of words.entries()) {
        const w = asRecord(wRaw);
        const wText = w ? asString(w['text']) : undefined;
        const wStart = w ? asNumber(w['start']) : undefined;
        const wEnd = w ? asNumber(w['end']) : undefined;
        if (!wText || !wText.trim() || wStart === undefined || wEnd === undefined) continue;
        const wordId = w ? asString(w['id']) : undefined;
        const lineId = line ? asString(line['id']) : undefined;
        const o: OverlayElement = { ...(wordId ? { id: wordId } : lineId ? { id: `${lineId}:word:${wordIndex}` } : {}), overlay_kind: 'text', text: wText, start: wStart, end: wEnd, x: baseX, y: baseY, color: activeColor, box, box_color: boxColor };
        if (size !== undefined) o.size = size;
        if (fadeIn !== undefined) o.fade_in = fadeIn;
        if (fadeOut !== undefined) o.fade_out = fadeOut;
        captions.push(o);
      }
      continue;
    }
    const lineId = line ? asString(line['id']) : undefined;
    const o: OverlayElement = { ...(lineId ? { id: lineId } : {}), overlay_kind: 'text', text, start, end, x: baseX, y: baseY, color, box, box_color: boxColor };
    if (size !== undefined) o.size = size;
    if (fadeIn !== undefined) o.fade_in = fadeIn;
    if (fadeOut !== undefined) o.fade_out = fadeOut;
    captions.push(o);
  }
  if (captions.length === 0) return state;
  return { ...state, overlays: [...state.overlays, ...captions] };
}

function foldSplit(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const sourceRef = asRecord(decision.source_ref);
  const splitTime = asNumber(params['at_time']) ?? asNumber(params['time']);
  if (splitTime === undefined) return state;

  const targetSourceId = sourceIdFromRef(sourceRef);
  const targetClipId = asString(params['clip_id']);
  const targetRole = asString(params['lane_role']);

  const lanes = new Map(state.lanes);
  for (const [role, clips] of lanes) {
    if (targetRole && role !== targetRole) continue;
    const idx = targetClipId ? clips.findIndex(clip => clip.clipId === targetClipId) : clipIndexAt(clips, splitTime);
    if (idx === -1) continue;
    const orig = clips[idx];
    if (targetClipId ? orig.clipId !== targetClipId : targetSourceId && orig.sourceId !== targetSourceId) continue;
    if (splitTime <= orig.laneStart || splitTime >= orig.laneEnd) continue;

    // Reuse the clip's source inPoint proportionally
    const origDuration = orig.outPoint - orig.inPoint;
    const laneOffset = splitTime - orig.laneStart;
    const splitSourceTime = orig.inPoint + (origDuration > 0 ? (laneOffset / (orig.laneEnd - orig.laneStart)) * origDuration : 0);

    const left: MaterializedClip = {
      ...orig,
      clipId: clipId(orig.sourceId, role, `split-L:${splitTime}`),
      outPoint: splitSourceTime,
      laneEnd: splitTime,
    };
    const right: MaterializedClip = {
      ...orig,
      clipId: clipId(orig.sourceId, role, `split-R:${splitTime}`),
      inPoint: splitSourceTime,
      laneStart: splitTime,
    };

    const updated = [...clips];
    updated.splice(idx, 1, left, right);
    lanes.set(role, updated);
    break; // split one clip per decision
  }

  return { ...state, lanes };
}

function foldTrim(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const sourceRef = asRecord(decision.source_ref);
  const targetClipId = asString(params['clip_id']);
  const newStart = asNumber(params['in_point']) ?? asNumber(params['new_start']);
  const newEnd = asNumber(params['out_point']) ?? asNumber(params['new_end']);
  const deltaStart = asNumber(params['delta_start']);
  const deltaEnd = asNumber(params['delta_end']);

  if (newStart === undefined && newEnd === undefined && deltaStart === undefined && deltaEnd === undefined) {
    // Try span as trim bounds
    const span = asRecord(decision.span);
    if (!span) return state;
    const spanStart = asNumber(span['start']);
    const spanEnd = asNumber(span['end']);
    if (spanStart === undefined && spanEnd === undefined) return state;
    return foldTrimClip(state, targetClipId, sourceIdFromRef(sourceRef), spanStart, spanEnd);
  }

  return foldTrimClip(state, targetClipId, sourceIdFromRef(sourceRef),
    newStart ?? (deltaStart !== undefined ? undefined : undefined),
    newEnd ?? (deltaEnd !== undefined ? undefined : undefined),
    deltaStart,
    deltaEnd,
  );
}

function foldTrimClip(
  state: FoldState,
  targetClipId: string | undefined,
  targetSourceId: string,
  newStart: number | undefined,
  newEnd: number | undefined,
  deltaStart?: number,
  deltaEnd?: number,
): FoldState {
  const lanes = new Map(state.lanes);
  for (const [role, clips] of lanes) {
    const idx = clips.findIndex((c) =>
      targetClipId ? c.clipId === targetClipId : c.sourceId === targetSourceId,
    );
    if (idx === -1) continue;
    const orig = clips[idx];
    const adjustedInPoint = newStart ?? (deltaStart !== undefined ? orig.inPoint + deltaStart : orig.inPoint);
    const adjustedOutPoint = newEnd ?? (deltaEnd !== undefined ? orig.outPoint + deltaEnd : orig.outPoint);
    const newDuration = Math.max(0, adjustedOutPoint - adjustedInPoint);
    const updated: MaterializedClip = {
      ...orig,
      inPoint: adjustedInPoint,
      outPoint: adjustedOutPoint,
      laneEnd: orig.laneStart + newDuration,
    };
    const newClips = [...clips];
    newClips[idx] = updated;
    lanes.set(role, newClips);
    break;
  }
  return { ...state, lanes };
}

/**
 * Ripple trim: trim a clip edge AND shift every downstream clip by the
 * duration change, so no gap opens (and no overlap forms) after the edit.
 * A positive delta (clip grew) pushes downstream clips right; negative
 * (clip shrank) pulls them left (clamped at 0). The trimmed clip keeps its
 * laneStart; only its source in/out plus laneEnd change, plus the downstream shift.
 */
function foldRippleTrim(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const sourceRef = asRecord(decision.source_ref);
  const targetClipId = asString(params['clip_id']);
  const targetSourceId = sourceIdFromRef(sourceRef);
  const span = asRecord(decision.span);
  const newStart = asNumber(params['new_start']) ?? asNumber(span?.['start']);
  const newEnd = asNumber(params['new_end']) ?? asNumber(span?.['end']);
  const deltaStart = asNumber(params['delta_start']);
  const deltaEnd = asNumber(params['delta_end']);

  const lanes = new Map(state.lanes);
  for (const [role, clips] of lanes) {
    const idx = clips.findIndex((c) =>
      targetClipId ? c.clipId === targetClipId : c.sourceId === targetSourceId,
    );
    if (idx === -1) continue;
    const orig = clips[idx];
    const oldDuration = orig.laneEnd - orig.laneStart;
    const adjustedInPoint = newStart ?? (deltaStart !== undefined ? orig.inPoint + deltaStart : orig.inPoint);
    const adjustedOutPoint = newEnd ?? (deltaEnd !== undefined ? orig.outPoint + deltaEnd : orig.outPoint);
    const newDuration = Math.max(0, adjustedOutPoint - adjustedInPoint);
    const shift = newDuration - oldDuration;

    const newClips = clips.map((c, i) => {
      if (i === idx) {
        return { ...c, inPoint: adjustedInPoint, outPoint: adjustedOutPoint, laneEnd: c.laneStart + newDuration };
      }
      if (i > idx) {
        const shiftedStart = Math.max(0, c.laneStart + shift);
        return { ...c, laneStart: shiftedStart, laneEnd: shiftedStart + (c.laneEnd - c.laneStart) };
      }
      return c;
    });
    lanes.set(role, newClips);
    break;
  }
  return { ...state, lanes };
}

/**
 * Close gaps (magnetic): reposition every clip in a lane so it butts directly
 * against the previous clip's end (laneStart = previous laneEnd), preserving
 * each clip's own duration and order. With no target lane_role, closes gaps in
 * every lane. This removes ALL inter-clip empty space (the magnetic-timeline
 * behavior of CapCut/Premiere/DaVinci) as pure structure, zero render change.
 */
function foldCloseGaps(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const targetRole = asString(params['lane_role']);
  const startAt = asNumber(params['start_at']) ?? 0;

  const lanes = new Map(state.lanes);
  for (const [role, clips] of lanes) {
    if (targetRole && role !== targetRole) continue;
    const sorted = sortByLaneStart(clips);
    let cursor = startAt;
    const rebuilt = sorted.map((c) => {
      const dur = c.laneEnd - c.laneStart;
      const nc = { ...c, laneStart: cursor, laneEnd: cursor + dur };
      cursor += dur;
      return nc;
    });
    lanes.set(role, rebuilt);
  }
  return { ...state, lanes };
}

/**
 * Detach audio: split a clip's sound off its picture. Silences the target video clip
 * (transform.muted, mapped to EDL silent_audio) and spawns a copy of it (same source,
 * in/out, laneStart/laneEnd) in a dedicated audio lane, so the audio can be moved,
 * trimmed, denoised, or deleted independently of the video (Premiere/DaVinci "detach").
 */
function foldDetachAudio(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const sourceRef = asRecord(decision.source_ref);
  const targetClipId = asString(params['clip_id']);
  const targetSourceId = sourceIdFromRef(sourceRef);
  const audioLaneId = asString(params['audio_lane_id']) ?? 'audio-detached';

  const lanes = new Map(state.lanes);
  let detached: MaterializedClip | undefined;
  for (const [role, clips] of lanes) {
    if (role === audioLaneId) continue;
    const idx = clips.findIndex((c) =>
      targetClipId ? c.clipId === targetClipId : c.sourceId === targetSourceId,
    );
    if (idx === -1) continue;
    const orig = clips[idx];
    const newClips = [...clips];
    newClips[idx] = { ...orig, transform: { ...orig.transform, muted: true } };
    lanes.set(role, newClips);
    detached = {
      ...orig,
      clipId: clipId(orig.sourceId, audioLaneId, 'detached-audio'),
      laneRole: audioLaneId,
      transform: {},
    };
    break;
  }
  if (!detached) return state;

  const audioClips = [...(lanes.get(audioLaneId) ?? []), detached];
  lanes.set(audioLaneId, sortByLaneStart(audioClips));

  const laneMeta = new Map(state.laneMeta);
  const laneOrder = state.laneMeta.has(audioLaneId) ? state.laneOrder : [...state.laneOrder, audioLaneId];
  if (!laneMeta.has(audioLaneId)) laneMeta.set(audioLaneId, { role: 'audio', label: 'Detached audio' });
  return { ...state, lanes, laneMeta, laneOrder };
}

function foldMove(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const sourceRef = asRecord(decision.source_ref);
  const targetClipId = asString(params['clip_id']);
  const targetSourceId = sourceIdFromRef(sourceRef);
  const newLaneStart = asNumber(params['lane_start']);
  const newRole = asString(params['lane_role']);

  const lanes = new Map(state.lanes);

  // Find the clip
  let foundRole: string | undefined;
  let foundIdx = -1;
  let found: MaterializedClip | undefined;

  for (const [role, clips] of lanes) {
    const idx = clips.findIndex((c) =>
      targetClipId ? c.clipId === targetClipId : c.sourceId === targetSourceId,
    );
    if (idx !== -1) {
      foundRole = role;
      foundIdx = idx;
      found = clips[idx];
      break;
    }
  }

  if (!found || foundRole === undefined) return state;

  const duration = found.laneEnd - found.laneStart;
  const destLaneStart = newLaneStart ?? found.laneStart;
  const destRole = newRole ?? foundRole;
  const moved: MaterializedClip = {
    ...found,
    clipId: clipId(found.sourceId, destRole, `moved:${destLaneStart}`),
    laneRole: destRole,
    laneStart: destLaneStart,
    laneEnd: destLaneStart + duration,
  };

  // Remove from source lane
  const srcClips = [...(lanes.get(foundRole) ?? [])];
  srcClips.splice(foundIdx, 1);
  lanes.set(foundRole, sortByLaneStart(srcClips));

  // Add to dest lane
  const destClips = [...(lanes.get(destRole) ?? []), moved];
  lanes.set(destRole, sortByLaneStart(destClips));
  const laneOrder = state.laneOrder.includes(destRole) ? state.laneOrder : [...state.laneOrder, destRole];
  const laneMeta = new Map(state.laneMeta);
  if (!laneMeta.has(destRole)) laneMeta.set(destRole, {role: destRole, label: destRole});
  return { ...state, lanes, laneOrder, laneMeta };
}

function foldDelete(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const sourceRef = asRecord(decision.source_ref);
  const targetClipId = asString(params['clip_id']);
  const targetSourceId = sourceIdFromRef(sourceRef);

  const lanes = new Map(state.lanes);

  for (const [role, clips] of lanes) {
    const idx = clips.findIndex((c) =>
      targetClipId ? c.clipId === targetClipId : c.sourceId === targetSourceId,
    );
    if (idx === -1) continue;
    const removed = clips[idx];
    const gap = removed.laneEnd - removed.laneStart;
    const trimmed = [...clips];
    trimmed.splice(idx, 1);
    lanes.set(role, shiftClipsLeft(trimmed, idx, gap));
    break;
  }

  return { ...state, lanes };
}

/**
 * Remove a TIME RANGE [start,end] (timeline coords) from a lane (or all lanes)
 * and ripple the remainder left by the removed length. This is the atomic unit
 * of transcript editing: removing a filler word or shortening a silent gap is a
 * `remove-span` over that word/gap's [start,end]. Blind to WHY the range is
 * removed — the transcript author (author-decisions-from-records.ts) supplies
 * the range as DATA. Source in/out points of a partially-cut clip are mapped
 * proportionally so the surviving footage stays frame-correct.
 */
function foldRemoveSpan(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const span = asRecord(decision.span);
  const start = asNumber(params['start']) ?? asNumber(span?.['start']);
  const end = asNumber(params['end']) ?? asNumber(span?.['end']);
  if (start === undefined || end === undefined || end <= start) return state;
  const removeLen = end - start;
  const onlyRole = asString(params['lane_role']);

  const lanes = new Map(state.lanes);
  for (const [role, clips] of lanes) {
    if (onlyRole && role !== onlyRole) continue;
    const rebuilt: MaterializedClip[] = [];
    for (const c of clips) {
      const laneSpan = c.laneEnd - c.laneStart;
      const srcPerLane = laneSpan > 0 ? (c.outPoint - c.inPoint) / laneSpan : 0;

      if (c.laneEnd <= start) {
        rebuilt.push(c); // fully before the cut — unchanged
        continue;
      }
      if (c.laneStart >= end) {
        // fully after the cut — ripple left
        rebuilt.push({ ...c, laneStart: c.laneStart - removeLen, laneEnd: c.laneEnd - removeLen });
        continue;
      }
      // clip overlaps the cut window: keep the surviving left/right portions
      if (c.laneStart < start) {
        const leftLaneEnd = Math.min(start, c.laneEnd);
        rebuilt.push({
          ...c,
          clipId: clipId(c.sourceId, role, `rmspan-L:${start}`),
          outPoint: c.inPoint + (leftLaneEnd - c.laneStart) * srcPerLane,
          laneStart: c.laneStart,
          laneEnd: leftLaneEnd,
        });
      }
      if (c.laneEnd > end) {
        const rightLaneStartOrig = Math.max(end, c.laneStart);
        rebuilt.push({
          ...c,
          clipId: clipId(c.sourceId, role, `rmspan-R:${end}`),
          inPoint: c.inPoint + (rightLaneStartOrig - c.laneStart) * srcPerLane,
          laneStart: rightLaneStartOrig - removeLen,
          laneEnd: c.laneEnd - removeLen,
        });
      }
      // clip fully inside [start,end] → dropped entirely
    }
    lanes.set(role, sortByLaneStart(rebuilt));
  }
  return { ...state, lanes };
}

function foldSetTransform(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const sourceRef = asRecord(decision.source_ref);
  const targetClipId = asString(params['clip_id']);
  const targetSourceId = sourceIdFromRef(sourceRef);
  const isGlobal = params['global'] === true || (!targetClipId && targetSourceId === 'unknown');

  // The set-transform op-schema declares a NESTED `transform` object param (the
  // inspector authors `{clip_id, transform: {...}}`). Extract from that object when
  // present, falling back to flat params for legacy/global callers. Without this the
  // whole inspector (width/height/speed/volume/fades) folds to an empty transform.
  const transformParams = asRecord(params['transform']) ?? params;
  const transform = extractTransform(transformParams);

  if (isGlobal) {
    return { ...state, globalTransform: { ...state.globalTransform, ...transform } };
  }

  const lanes = new Map(state.lanes);
  for (const [role, clips] of lanes) {
    const idx = clips.findIndex((c) =>
      targetClipId ? c.clipId === targetClipId : c.sourceId === targetSourceId,
    );
    if (idx === -1) continue;
    const newClips = [...clips];
    newClips[idx] = { ...clips[idx], transform: { ...clips[idx].transform, ...transform } };
    lanes.set(role, newClips);
    break;
  }

  return { ...state, lanes };
}

function foldAddSource(state: FoldState, decision: MediaCompositionEditDecision, decisionIndex: number): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const sourceRef = asRecord(decision.source_ref) ?? {};
  const sourceId = sourceIdFromRef(sourceRef);
  const laneRole = asString(params['lane_role']) ?? asString(sourceRef['role']) ?? 'source';
  const label = asString(decision.label) ?? asString(params['label']) ?? sourceId;

  // Where on the lane to place the new clip: an explicit `lane_start` (seconds) pins
  // it at a chosen time (e.g. a text element dropped at the playhead, or an insert),
  // else it appends after the last clip. Generic — any add-source can place-at-time.
  const existingClips = state.lanes.get(laneRole) ?? [];
  const explicitStart = asNumber(params['lane_start']);
  const laneStart = explicitStart !== undefined
    ? Math.max(0, explicitStart)
    : (existingClips.length > 0 ? Math.max(...existingClips.map((c) => c.laneEnd)) : 0);

  const span = asRecord(decision.span);
  const inPoint = asNumber(span?.['start']) ?? asNumber(params['in_point']) ?? 0;
  const outPoint = asNumber(span?.['end']) ?? asNumber(params['out_point']) ?? inPoint;
  const duration = Math.max(0, outPoint - inPoint);

  const clip: MaterializedClip = {
    clipId: clipId(sourceId, laneRole, `added:${decisionIndex}`),
    sourceId,
    laneRole,
    label,
    inPoint,
    outPoint,
    laneStart,
    laneEnd: laneStart + duration,
    // Seed the transform from the decision params so an add-source can carry an
    // initial caption/speed/etc. in ONE decision — this is how a first-class TEXT
    // element is authored (add-source with caption_text/caption_x/caption_y). A plain
    // video add-source passes no transform params, so this stays {} (identity).
    transform: extractTransform(params),
  };

  const lanes = new Map(state.lanes);
  const existing = lanes.get(laneRole) ?? [];
  lanes.set(laneRole, [...existing, clip]);

  let laneOrder = state.laneOrder;
  if (!laneOrder.includes(laneRole)) {
    laneOrder = [...laneOrder, laneRole];
  }

  let laneMeta = state.laneMeta;
  if (!laneMeta.has(laneRole)) {
    laneMeta = new Map(laneMeta);
    laneMeta.set(laneRole, { role: laneRole, label: asString(params['lane_label']) ?? laneRole, tone: asString(params['lane_tone']) });
  }

  return { ...state, lanes, laneOrder, laneMeta };
}

/**
 * Add an adjustment clip over an explicit program-time span. It uses the same
 * clip representation as the timeline and EDL already understand, so selecting
 * or editing the layer goes through the ordinary clip commands and no render
 * path is special-cased.
 */
function foldAdjustmentLayer(state: FoldState, decision: MediaCompositionEditDecision, decisionIndex: number): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const start = asNumber(params['start']);
  const end = asNumber(params['end']);
  const grade = asString(params['grade']);
  if (start === undefined || end === undefined || start < 0 || end <= start || !grade?.trim()) return state;

  return foldAddSource(state, {
    ...decision,
    source_ref: { source_id: 'adjustment-layer' },
    parameters: {
      lane_role: 'adjustment',
      lane_label: 'Adjustments',
      lane_start: start,
      in_point: 0,
      out_point: end - start,
      adjustment: true,
      grade,
    },
  }, decisionIndex);
}

/** Apply a saved preview drag to one stable caption row. Positions use the same
 * normalized 0..1 frame coordinates used by the live editor and renderer. */
function foldCaptionPosition(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const captionId = asString(params['caption_id']);
  const x = asNumber(params['x']);
  const y = asNumber(params['y']);
  if (!captionId || x === undefined || y === undefined || x < 0 || x > 1 || y < 0 || y > 1) return state;
  const index = state.overlays.findIndex((overlay) => overlay.overlay_kind === 'text' && overlay.id === captionId);
  if (index < 0) return state;
  const overlays = [...state.overlays];
  overlays[index] = { ...overlays[index], x, y };
  return { ...state, overlays };
}

function foldSaveEdit(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  // Commits the current inspector params as globalTransform
  const params = asRecord(decision.parameters) ?? {};
  const transform = extractTransform(params);
  if (Object.keys(transform).length === 0) return state;
  return { ...state, globalTransform: { ...state.globalTransform, ...transform } };
}

/** Register an EMPTY track (lane) as DATA. Adding a track is the SAME primitive as
 *  a lane that a clip creates via add-source, minus the clip: it seeds laneOrder +
 *  laneMeta + an empty clip list so the lane materialises and renders as "Empty
 *  track", ready to drop clips onto. Idempotent by lane_role, so re-folding the
 *  same add-track (or an add-source that later fills the same role) never dupes. */
function foldAddTrack(state: FoldState, decision: MediaCompositionEditDecision): FoldState {
  const params = asRecord(decision.parameters) ?? {};
  const laneRole = asString(params['lane_role']);
  if (!laneRole) return state;
  if (state.lanes.has(laneRole) || state.laneOrder.includes(laneRole)) return state;
  const lanes = new Map(state.lanes);
  lanes.set(laneRole, []);
  const laneMeta = new Map(state.laneMeta);
  laneMeta.set(laneRole, {
    role: laneRole,
    label: asString(params['lane_label']) ?? laneRole,
    tone: asString(params['lane_tone']),
  });
  return { ...state, lanes, laneOrder: [...state.laneOrder, laneRole], laneMeta };
}

/** Legacy corner -> normalized {x,y} preset. Read-only back-compat so DATA authored
 *  before the {x,y} primitive still positions correctly; nothing writes `corner`. */
const LEGACY_CORNER_XY: Record<string, { x: number; y: number }> = {
  tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, bl: { x: 0, y: 1 }, br: { x: 1, y: 1 },
};

/**
 * Look catalog: DATA rows mapping a look key to an OPAQUE ffmpeg grade filter string. This is
 * Society config at the translation boundary (L098), not engine code: the render never sees a
 * key, only the resolved grade string it blindly applies. Add a look = add a row; a custom look
 * is a freeform `grade` string; a LUT-based look is `${LUT}` + grade_lut_ref. Zero code per look.
 */
export const LOOK_CATALOG: Record<string, string> = {
  'black-white': 'hue=s=0',
  noir: 'hue=s=0,eq=contrast=1.5:brightness=-0.02',
  sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  warm: 'colorbalance=rs=.08:rm=.06:bh=-.06,eq=saturation=1.05',
  cool: 'colorbalance=rs=-.06:bs=.08:bm=.05',
  'teal-orange': 'colorbalance=rh=.10:bh=-.08:rs=-.06:bs=.10,eq=saturation=1.1:contrast=1.05',
  vintage: 'curves=preset=vintage',
  faded: 'eq=contrast=.88:saturation=.8,colorbalance=rs=.05:bs=-.05',
  'high-contrast': 'eq=contrast=1.4:saturation=1.12',
  vibrant: 'eq=saturation=1.4:contrast=1.08',
  // The CapCut/Premiere one-click cinematic family. Every one is a linear (single-in/single-out)
  // ffmpeg filter chain so it drops straight into the comma-joined grade seam. Zero engine code:
  // each is a DATA row the render applies blind (L090/enum-dissolution).
  vignette: 'vignette=PI/4', // darkened corners, subject-focusing falloff
  'film-grain': 'noise=alls=18:allf=t', // per-frame analog grain
  'bleach-bypass': 'eq=saturation=0.25:contrast=1.5:brightness=0.02', // desaturated high-contrast (Saving Private Ryan)
  dreamy: 'gblur=sigma=4,eq=brightness=0.04:saturation=1.08', // soft-focus haze
  'chromatic-aberration': 'rgbashift=rh=5:bh=-5', // RGB fringe / lo-fi lens
  cyberpunk: 'colorbalance=rs=.10:bs=.12:gm=-.05,eq=saturation=1.3:contrast=1.1', // neon teal/magenta
  // cross-process (C-41-in-E6 lomography): blue/cyan shadows + warm/yellow highlights + green midtone cast,
  // boosted contrast and saturation. Quote-free colorbalance (per-range shifts) so it drops into the grade seam.
  'cross-process': 'colorbalance=bs=.18:bh=-.18:gm=.10:rs=-.04:rh=.06,eq=contrast=1.15:saturation=1.2',
};

/**
 * Denoise catalog: DATA rows mapping a preset key to what the render applies. In-graph presets
 * resolve to an OPAQUE ffmpeg audio-filter string (afftdn: the FFT denoiser; a voice chain adds
 * a high/low-pass); the `deepfilternet` preset resolves to the literal method key the render's
 * DENOISE_PREPROCESSORS matches (an external learned denoiser). Add an engine = add a row.
 */
export const DENOISE_CATALOG: Record<string, string> = {
  light: 'afftdn=nf=-20',
  medium: 'afftdn=nf=-25',
  strong: 'afftdn=nf=-30',
  voice: 'highpass=f=90,afftdn=nf=-25,lowpass=f=12000',
  deepfilternet: 'deepfilternet',
};

/**
 * #100 Audio-FX catalog: DATA rows mapping an effect key to an OPAQUE ffmpeg audio-filter chain
 * (EQ, compressor, de-reverb, de-esser, pitch, "Studio Sound"). Society config at the translation
 * boundary (L098): the render never sees a key, only the resolved chain it blindly applies. Add an
 * effect = add a row; a custom effect is a freeform `audio_filters` string. Zero code per effect.
 */
/** #102 Preset velocity curves as DATA (the inspector's one-click ramps; t is the FRACTION of
 *  the clip's source length, resolved to seconds at commit). Any custom curve is still just a
 *  speedRamp array; these rows are conveniences, not an enum the render knows about (L090). */
export const SPEED_RAMP_CATALOG: Record<string, Array<{ t: number; speed: number }>> = {
  // fast intro, dramatic slow finish (the classic sports/action reveal)
  'punch-in': [{ t: 0, speed: 2 }, { t: 0.5, speed: 0.4 }],
  // slow-mo moment in the middle, normal on both sides
  'slow-mo-middle': [{ t: 0, speed: 1 }, { t: 0.35, speed: 0.35 }, { t: 0.65, speed: 1 }],
  // gentle accelerando to a timelapse finish
  'ramp-up': [{ t: 0, speed: 0.75 }, { t: 0.4, speed: 1.5 }, { t: 0.7, speed: 3 }],
  // hard speed then an abrupt hit to real-time (music-video cut feel)
  'speed-hit': [{ t: 0, speed: 3 }, { t: 0.6, speed: 1 }],
};

/** #115 Named entrance/exit MOTION presets for text overlays. Each is a DATA shape: an axis (x/y are
 *  normalized-position deltas from the overlay's resting x/y when `rel`, alpha is absolute) and knots
 *  in NORMALIZED motion-time (t 0..1 of the entrance/exit duration). The materializer instantiates a
 *  preset against the overlay's window (entrance over [start, start+dur], exit reversed over
 *  [end-dur, end]) into a piecewiseExpr envelope the render owns. A new motion is a DATA row, zero
 *  render code (slide = x/y envelope, fade = alpha envelope, pop = a y overshoot-and-settle). */
export const TEXT_MOTION_CATALOG: Record<string, { axis: 'x' | 'y' | 'alpha'; rel?: boolean; knots: Array<{ t: number; value: number; interp?: string }> }> = {
  'slide-left': { axis: 'x', rel: true, knots: [{ t: 0, value: -1.2, interp: 'ease-out' }, { t: 1, value: 0 }] },
  'slide-right': { axis: 'x', rel: true, knots: [{ t: 0, value: 1.2, interp: 'ease-out' }, { t: 1, value: 0 }] },
  'slide-up': { axis: 'y', rel: true, knots: [{ t: 0, value: 1.2, interp: 'ease-out' }, { t: 1, value: 0 }] },
  'slide-down': { axis: 'y', rel: true, knots: [{ t: 0, value: -1.2, interp: 'ease-out' }, { t: 1, value: 0 }] },
  'fade': { axis: 'alpha', knots: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
  'pop': { axis: 'y', rel: true, knots: [{ t: 0, value: -0.6 }, { t: 0.6, value: 0.08, interp: 'ease-out' }, { t: 1, value: 0, interp: 'ease-in-out' }] },
};

export const AUDIO_FX_CATALOG: Record<string, string> = {
  // Descript "Studio Sound"-style clean-up: high-pass rumble, gentle EQ lift, compress, de-reverb.
  'studio-sound': 'highpass=f=80,equalizer=f=180:t=q:w=1:g=-3,equalizer=f=3500:t=q:w=2:g=3,acompressor=threshold=-18dB:ratio=3:attack=8:release=180,afftdn=nf=-25',
  podcast: 'highpass=f=90,acompressor=threshold=-16dB:ratio=4:attack=5:release=150,equalizer=f=200:t=q:w=1:g=2',
  warm: 'equalizer=f=150:t=q:w=1.5:g=3,equalizer=f=6000:t=q:w=2:g=-2',
  bright: 'equalizer=f=8000:t=q:w=2:g=4,equalizer=f=250:t=q:w=1:g=-2',
  'de-ess': 'equalizer=f=6500:t=q:w=1.5:g=-8',
  'de-reverb': 'afftdn=nf=-20,equalizer=f=300:t=q:w=1:g=-3',
  telephone: 'highpass=f=500,lowpass=f=3000,acompressor=threshold=-12dB:ratio=6',
  radio: 'acompressor=threshold=-20dB:ratio=6:attack=3:release=120,equalizer=f=100:t=q:w=1:g=4,equalizer=f=5000:t=q:w=2:g=3',
  // #205 pitch presets: rubberband shifts PITCH while KEEPING duration (unlike raw asetrate/atempo, which
  // also change tempo), and it is sample-rate agnostic (no hardcoded SR), so a clip at 44.1k or 48k both work.
  // `pitch=k` multiplies the perceived frequency: >1 higher, <1 lower. Opaque chain (the render never sees the
  // key), same DATA-catalog pattern as every row above.
  'pitch-up': 'rubberband=pitch=1.5',
  'pitch-down': 'rubberband=pitch=0.667',
  chipmunk: 'rubberband=pitch=2',
  'deep-voice': 'rubberband=pitch=0.5',
  helium: 'rubberband=pitch=1.8',
  // #208 noise-gate: an AMPLITUDE gate (agate, a dynamics processor) that silences audio BELOW a threshold,
  // so room-tone/hiss between spoken words drops out while speech passes. Distinct mechanism from the spectral
  // afftdn/de-ess rows: those subtract a noise profile, this gates on level. Opaque chain, same DATA pattern.
  'noise-gate': 'agate=threshold=0.08:ratio=9:attack=5:release=150',
  // #215 Stereo PLACEMENT: fold the clip's audio to one side of the stereo field (the only rows that touch
  // WHERE the sound sits, not its tone). `pan=stereo|c0=..|c1=..` sends the summed signal to left or right and
  // silences the other output channel, so different sources sit in different places in an assembled mix.
  'pan-left': 'pan=stereo|c0=c0+c1|c1=0*c0',
  'pan-right': 'pan=stereo|c0=0*c0|c1=c0+c1',
};

/**
 * Chroma-key catalog: DATA rows mapping a key-color preset to its OPAQUE ffmpeg colorkey string.
 * `similarity`/`blend` are baked into the preset; a freeform `chroma_key` string covers any key
 * color, chromakey vs colorkey, or a despill chain. Add a key color = add a row.
 */
export const CHROMA_CATALOG: Record<string, string> = {
  green: 'colorkey=0x00ff00:0.30:0.10',
  blue: 'colorkey=0x0000ff:0.30:0.10',
};

/** Picture-in-picture placement presets: a non-coder picks a CORNER, the render still only
 *  ever sees ffmpeg (x,y) position exprs (`W`/`H` = canvas, `w`/`h` = overlay). The 24px
 *  margin is baked so the catalog stays a pure DATA row (like CHROMA_CATALOG); an explicit
 *  x/y on the decision still wins, so this is a convenient default, never a ceiling (L083). */
/** #88 Build a punch-in ZOOM keyframe envelope: hold zoom 1, ramp up to `zoom` at `at`, hold for
 *  `hold` seconds, ramp back to 1. Pure DATA over the keyframe engine (the render's `zoom` binding
 *  reads it); a Descript-style emphasis is just this envelope, no bespoke render code (L069). */
export function buildPunchInZoomKeyframes(
  opts: { at?: number; zoom?: number; hold?: number; ramp?: number } = {},
): Array<{ t: number; value: number; interp?: string }> {
  const at = Math.max(0, Number.isFinite(opts.at) ? (opts.at as number) : 0.5);
  const zoom = Number.isFinite(opts.zoom) && (opts.zoom as number) > 1 ? (opts.zoom as number) : 1.4;
  const hold = Number.isFinite(opts.hold) && (opts.hold as number) > 0 ? (opts.hold as number) : 1.0;
  const ramp = Number.isFinite(opts.ramp) && (opts.ramp as number) > 0 ? (opts.ramp as number) : 0.3;
  const up = at + ramp;
  const holdEnd = up + hold;
  const down = holdEnd + ramp;
  return [
    { t: 0, value: 1 },
    { t: at, value: 1 },
    { t: up, value: zoom },
    { t: holdEnd, value: zoom },
    { t: down, value: 1 },
  ];
}

export const PIP_CORNER_CATALOG: Record<string, { x: string; y: string }> = {
  'top-left': { x: '24', y: '24' },
  'top-right': { x: 'W-w-24', y: '24' },
  'bottom-left': { x: '24', y: 'H-h-24' },
  'bottom-right': { x: 'W-w-24', y: 'H-h-24' },
  center: { x: '(W-w)/2', y: '(H-h)/2' },
};

function extractTransform(params: Record<string, unknown>): ClipTransform {
  const t: ClipTransform = {};
  const str = (k: string): string | undefined => asString(params[k]);
  const num = (k: string): number | undefined => asNumber(params[k]);
  if (str('aspect_ratio') ?? str('aspectRatio')) t.aspectRatio = str('aspect_ratio') ?? str('aspectRatio');
  if (str('frame_preset') ?? str('framePreset')) t.framePreset = str('frame_preset') ?? str('framePreset');
  if (str('position')) t.position = str('position');
  if (num('width') !== undefined) t.width = num('width');
  if (num('height') !== undefined) t.height = num('height');
  if (num('padding') !== undefined) t.padding = num('padding');
  if (num('inset') !== undefined) t.inset = num('inset');
  if (num('corners') !== undefined) t.corners = num('corners');
  if (num('stroke') !== undefined) t.stroke = num('stroke');
  if (num('shadow') !== undefined) t.shadow = num('shadow');
  if (typeof params['keep_aspect_ratio'] === 'boolean') t.keepAspectRatio = params['keep_aspect_ratio'];
  if (typeof params['keepAspectRatio'] === 'boolean') t.keepAspectRatio = params['keepAspectRatio'];
  if (num('speed') !== undefined) t.speed = num('speed');
  // #95 Smooth slow-mo flag (optical-flow interpolation when slowing).
  const speedSmooth = params['speed_smooth'] ?? params['speedSmooth'];
  if (typeof speedSmooth === 'boolean') t.speedSmooth = speedSmooth;
  // #102 Velocity curve: keyframed speed over the clip. Sanitize each point to {t,speed>0}.
  const rampRaw = params['speed_ramp'] ?? params['speedRamp'];
  if (Array.isArray(rampRaw)) {
    const ramp = rampRaw
      .map((p) => asRecord(p))
      .filter((p): p is Record<string, unknown> => p !== undefined)
      .map((p) => ({ t: Number(p['t']), speed: Number(p['speed']) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.speed) && p.speed > 0);
    if (ramp.length > 0) t.speedRamp = ramp;
  }
  const rampUnit = params['speed_ramp_unit'] ?? params['speedRampUnit'];
  if (rampUnit === 'seconds' || rampUnit === 'fraction') t.speedRampUnit = rampUnit;
  const rampAudio = params['speed_ramp_audio'] ?? params['speedRampAudio'];
  if (typeof rampAudio === 'boolean') t.speedRampAudio = rampAudio;
  if (typeof params['adjustment'] === 'boolean') t.adjustment = params['adjustment'];
  if (num('volume') !== undefined) t.volume = num('volume');
  if ((num('fade_in') ?? num('fadeIn')) !== undefined) t.fadeIn = num('fade_in') ?? num('fadeIn');
  if ((num('fade_out') ?? num('fadeOut')) !== undefined) t.fadeOut = num('fade_out') ?? num('fadeOut');
  if (typeof params['audio_bed'] === 'boolean') t.audioBed = params['audio_bed'];
  if (typeof params['audioBed'] === 'boolean') t.audioBed = params['audioBed'];
  if (params['music'] === true) t.audioBed = true;
  if (typeof params['narration'] === 'boolean') t.narration = params['narration'];
  if (params['narrate'] === true) t.narration = true;
  if (typeof params['tts_text'] === 'string') t.ttsText = params['tts_text'];
  if (typeof params['tts_producer'] === 'string') t.ttsProducer = params['tts_producer'];
  if (typeof params['tts_voice'] === 'string') t.ttsVoice = params['tts_voice'];
  if (typeof params['duck'] === 'boolean') t.duck = params['duck'];
  if (typeof params['audio_duck'] === 'boolean') t.duck = params['audio_duck'];
  // Animated property envelopes: {property: [{t, value, interp?}, ...]} pass through verbatim
  // to the EDL clip's `keyframes`, which video-compose's property-agnostic envelope evaluator
  // renders (opacity/volume already bound; a new animatable property is one KEYFRAME_BINDINGS row).
  const kf = asRecord(params['keyframes']);
  if (kf) t.keyframes = kf as ClipTransform['keyframes'];
  const kb = asRecord(params['ken_burns']) ?? asRecord(params['kenBurns']);
  if (kb) {
    const kbNum = (k: string): number | undefined => asNumber(kb[k]);
    const out: NonNullable<ClipTransform['kenBurns']> = {};
    for (const key of ['zoom_from', 'zoom_to', 'x_from', 'x_to', 'y_from', 'y_to'] as const) {
      const v = kbNum(key);
      if (v !== undefined) out[key] = v;
    }
    // #113 Multi-stop: pass the per-axis keyframe envelopes {zoom,cx,cy: [{t,value,interp?}]} and the
    // optional t unit straight through to the render's piecewiseExpr (zero flat-key enumeration).
    const kbKf = asRecord(kb['keyframes']);
    if (kbKf) out.keyframes = kbKf as NonNullable<ClipTransform['kenBurns']>['keyframes'];
    const kbUnit = kb['unit'];
    if (kbUnit === 'seconds' || kbUnit === 'fraction') out.unit = kbUnit;
    t.kenBurns = out;
  }
  // #146 Camera shake: {amplitude, frequency?, decay?} scalars. amplitude is required + clamped 0..0.2
  // (0 is a no-op, dropped); frequency/decay pass through when present. The creative inverse of stabilize.
  const shk = asRecord(params['shake']) ?? asRecord(params['camera_shake']) ?? asRecord(params['cameraShake']);
  if (shk) {
    const amp = asNumber(shk['amplitude']) ?? asNumber(shk['amount']);
    if (amp !== undefined && amp > 0) {
      const out: NonNullable<ClipTransform['shake']> = { amplitude: Math.min(0.2, amp) };
      const freq = asNumber(shk['frequency']) ?? asNumber(shk['hz']);
      if (freq !== undefined && freq > 0) out.frequency = freq;
      const decay = asNumber(shk['decay']);
      if (decay !== undefined && decay > 0) out.decay = decay;
      t.shake = out;
    }
  }
  // #114 Split edit (J-cut / L-cut): one scalar detaches the clip's audio from its video.
  const audioOffset = num('audio_offset_s') ?? num('audioOffsetS');
  if (audioOffset !== undefined) t.audioOffsetS = audioOffset;
  // Auto-reframe: `reframe`/`auto_reframe` {aspect_w, aspect_h, track:[{t,cx,cy?}]}. The track
  // is a subject-center path written by a detector producer (DATA); no track -> center crop.
  const rf = asRecord(params['reframe']) ?? asRecord(params['auto_reframe']);
  if (rf) {
    const out: NonNullable<ClipTransform['reframe']> = {};
    const aw = asNumber(rf['aspect_w']); if (aw !== undefined) out.aspect_w = aw;
    const ah = asNumber(rf['aspect_h']); if (ah !== undefined) out.aspect_h = ah;
    // #94 Fill mode: 'crop' (cover, default), 'blur' (contain + blurred fill), or a solid pad color.
    const fm = asString(rf['fill_mode']); if (fm !== undefined) out.fill_mode = fm;
    const fb = asNumber(rf['fill_blur']); if (fb !== undefined) out.fill_blur = fb;
    const rawTrack = rf['track'];
    if (Array.isArray(rawTrack)) {
      const track: NonNullable<NonNullable<ClipTransform['reframe']>['track']> = [];
      for (const p of rawTrack) {
        const pr = asRecord(p);
        const tt = pr ? asNumber(pr['t']) : undefined;
        if (pr && tt !== undefined) {
          const point: { t: number; cx?: number; cy?: number } = { t: tt };
          const cx = asNumber(pr['cx']); if (cx !== undefined) point.cx = cx;
          const cy = asNumber(pr['cy']); if (cy !== undefined) point.cy = cy;
          track.push(point);
        }
      }
      if (track.length) out.track = track;
    }
    t.reframe = out;
  }
  // Color grade / look. A `grade` string is the opaque DATA the render applies; a `look` key
  // resolves to a grade string from the DATA look catalog (a preset is a DATA row, never engine
  // code). `grade_lut_ref` supplies a .cube for a `${LUT}` placeholder.
  const gradeStr = str('grade');
  if (gradeStr !== undefined) t.grade = gradeStr;
  const lookKey = str('look') ?? str('filter');
  if (lookKey !== undefined && t.grade === undefined) {
    const preset = LOOK_CATALOG[lookKey];
    if (preset) t.grade = preset;
    else if (lookKey === '' || lookKey === 'none') t.grade = '';
  }
  const lutRef = str('grade_lut_ref');
  if (lutRef !== undefined) t.grade_lut_ref = lutRef;
  if (params['grade_layers'] !== undefined) {
    const layers = params['grade_layers'];
    if (!Array.isArray(layers) || layers.length > 32 || layers.some(layer => !layer || typeof layer.grade !== 'string' || !layer.grade.trim() || (layer.grade_lut_ref !== undefined && typeof layer.grade_lut_ref !== 'string')))
      throw new Error('Choose valid ordered color layers.');
    t.grade_layers = layers.map(layer => ({ grade: layer.grade, ...(layer.grade_lut_ref !== undefined ? { grade_lut_ref: layer.grade_lut_ref } : {}) }));
  }
  // Ordered per-clip EFFECT STACK + named multi-effect LOOK preset. `effects` is a raw ordered list of
  // opaque effect nodes (the fold keeps them blind, L090; the compositor resolves each via the
  // effect-registry). `look_stack` is a named LOOK_STACKS preset key. Both ride the SAME set-transform op
  // (zero new op code), so an inspector authoring "add effect" / "apply look" writes one set-transform decision.
  const effectsRaw = params['effects'];
  if (Array.isArray(effectsRaw)) {
    const effects = effectsRaw
      .map((n) => asRecord(n))
      .filter((n): n is Record<string, unknown> => n !== undefined);
    if (effects.length > 0) t.effects = effects;
    else if (effectsRaw.length === 0) t.effects = []; // explicit clear
  }
  const lookStack = str('look_stack') ?? str('lookStack');
  if (lookStack !== undefined) t.lookStack = lookStack;
  // Split-screen / grid: tile this clip's source with N more sources (you-vs-a-pro side-by-side,
  // before/after, a 4-up grid). Accepts a nested `split_screen`/`splitScreen` object OR flat
  // `split_with`/`split_sources` + `split_layout`/`split_weights`/`split_labels`. `with` names the
  // EXTRA source refs; cell 0 is always this clip's own source. materialize resolves the refs and
  // emits a kind:'split' segment (zero new render code, L069). An empty `with` clears it.
  const ssObj = asRecord(params['split_screen']) ?? asRecord(params['splitScreen']);
  const asStrArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => asString(x)).filter((x): x is string => x !== undefined) : undefined;
  const asNumArr = (v: unknown): number[] | undefined =>
    Array.isArray(v) ? v.map((x) => asNumber(x)).filter((x): x is number => x !== undefined) : undefined;
  const ssWith = asStrArr(params['split_with']) ?? asStrArr(params['split_sources'])
    ?? (ssObj ? asStrArr(ssObj['with']) : undefined);
  if (ssWith !== undefined) {
    if (ssWith.length === 0) {
      t.splitScreen = undefined;
    } else {
      const ss: NonNullable<ClipTransform['splitScreen']> = { with: ssWith };
      const layout = str('split_layout') ?? (ssObj ? asString(ssObj['layout']) : undefined);
      if (layout === 'h' || layout === 'v' || layout === 'grid') ss.layout = layout;
      const weights = asNumArr(params['split_weights']) ?? (ssObj ? asNumArr(ssObj['weights']) : undefined);
      if (weights && weights.length) ss.weights = weights;
      const labels = asStrArr(params['split_labels']) ?? (ssObj ? asStrArr(ssObj['labels']) : undefined);
      if (labels && labels.length) ss.labels = labels;
      // Per-cell framing (index-aligned, cell 0 = this clip): each entry may carry a source-px
      // `crop` {w,h,x,y} to tighten onto a subject and a `flip` ('h'|'v'|'hv') to mirror the cell so
      // both sources face the same way. buildSplit reads per-source crop/flip, so this is DATA only.
      const rawCells = (Array.isArray(params['split_cells']) ? params['split_cells']
        : (ssObj && Array.isArray(ssObj['cells']) ? ssObj['cells'] : undefined)) as unknown[] | undefined;
      if (rawCells) {
        const cells = rawCells.map((c) => {
          const rec = asRecord(c) ?? {};
          const cell: NonNullable<NonNullable<ClipTransform['splitScreen']>['cells']>[number] = {};
          const cropRec = asRecord(rec['crop']);
          if (cropRec) {
            const w = asNumber(cropRec['w']); const h = asNumber(cropRec['h']);
            const x = asNumber(cropRec['x']); const y = asNumber(cropRec['y']);
            if (w !== undefined && h !== undefined && x !== undefined && y !== undefined) cell.crop = { w, h, x, y };
          }
          const flip = asString(rec['flip']);
          if (flip === 'h' || flip === 'v' || flip === 'hv') cell.flip = flip;
          const startAt = asNumber(rec['start_at']) ?? asNumber(rec['startAt']);
          if (startAt !== undefined && startAt >= 0) cell.start_at = startAt;
          return cell;
        });
        if (cells.some((c) => c.crop || c.flip || c.start_at !== undefined)) ss.cells = cells;
      }
      t.splitScreen = ss;
    }
  }
  // #100 Audio effect chain: an `audio_filters` string is the opaque DATA the render appends to the
  // clip audio; an `audio_fx`/`sound` key resolves to a chain from the DATA catalog. Empty/'none' clears.
  const afStr = str('audio_filters') ?? str('audioFilters');
  if (afStr !== undefined) t.audioFilters = afStr;
  const fxKey = str('audio_fx') ?? str('sound');
  if (fxKey !== undefined && t.audioFilters === undefined) {
    const preset = AUDIO_FX_CATALOG[fxKey];
    if (preset) t.audioFilters = preset;
    else if (fxKey === '' || fxKey === 'none') t.audioFilters = '';
  }
  // Noise reduction: a `denoise` string is the opaque DATA the render applies (afilter or the
  // external method key); a `denoise_preset`/`noise_reduction` key resolves to one from the
  // DATA catalog. Empty/'none' clears it (no denoise).
  const denoiseStr = str('denoise');
  if (denoiseStr !== undefined) t.denoise = denoiseStr;
  const denoiseKey = str('denoise_preset') ?? str('noise_reduction');
  if (denoiseKey !== undefined && t.denoise === undefined) {
    const preset = DENOISE_CATALOG[denoiseKey];
    if (preset) t.denoise = preset;
    else if (denoiseKey === '' || denoiseKey === 'none') t.denoise = '';
  }
  // #78 Chroma key. A `chroma_key` string is the opaque DATA the render applies; a
  // `chroma_key_color`/`key_color` preset key resolves to a colorkey string from the catalog.
  // Empty/'none' clears it.
  const chromaStr = str('chroma_key');
  if (chromaStr !== undefined) t.chroma_key = chromaStr;
  const chromaKey = str('chroma_key_color') ?? str('key_color');
  if (chromaKey !== undefined && t.chroma_key === undefined) {
    const preset = CHROMA_CATALOG[chromaKey];
    if (preset) t.chroma_key = preset;
    else if (chromaKey === '' || chromaKey === 'none') t.chroma_key = '';
  }
  // #76 Reverse + freeze. `reverse` plays the clip backward. `freeze`/`freeze_frame` holds a
  // frame: a {mode, duration} record, or flat `freeze_duration` (+ optional `freeze_mode`).
  if (typeof params['reverse'] === 'boolean') t.reverse = params['reverse'];
  const fz = asRecord(params['freeze']) ?? asRecord(params['freeze_frame']);
  const fzMode = (str('freeze_mode') ?? (fz ? asString(fz['mode']) : undefined)) === 'head' ? 'head' : 'tail';
  const fzDur = num('freeze_duration') ?? (fz ? asNumber(fz['duration']) : undefined);
  if (fzDur !== undefined && fzDur > 0) t.freeze = { mode: fzMode, duration: fzDur };
  // #85 Stabilize / deshake. `stabilize`/`stabilise` boolean turns on the vidstab two-pass;
  // `stabilize_smoothing` (frames) + `stabilize_shakiness` (1..10) are optional strength knobs.
  const stab = params['stabilize'] ?? params['stabilise'];
  if (typeof stab === 'boolean') t.stabilize = stab;
  const stabSmoothing = num('stabilize_smoothing') ?? num('stabilizeSmoothing');
  if (stabSmoothing !== undefined) t.stabilizeSmoothing = stabSmoothing;
  const stabShakiness = num('stabilize_shakiness') ?? num('stabilizeShakiness');
  if (stabShakiness !== undefined) t.stabilizeShakiness = stabShakiness;
  // Motion blur / frame-blend. `motion_blur` boolean turns on the tmix frame-average; `motion_blur_frames`
  // (>=2, default 3) is the strength. Blind DATA (L090).
  const motionBlur = params['motion_blur'] ?? params['motionBlur'];
  if (typeof motionBlur === 'boolean') t.motionBlur = motionBlur;
  const motionBlurFrames = num('motion_blur_frames') ?? num('motionBlurFrames');
  if (motionBlurFrames !== undefined && motionBlurFrames >= 2) t.motionBlurFrames = Math.round(motionBlurFrames);
  // #156 Trails / echo: nested {decay} object OR flat trails_decay (0..1). Only a positive decay enables
  // the persistence trail; the render clamps to 0.5..0.98. Distinct from motionBlur (frame averaging).
  const trailsRec = asRecord(params['trails']);
  const trailsDecay = trailsRec ? asNumber(trailsRec['decay']) : (num('trails_decay') ?? num('trailsDecay'));
  if (trailsDecay !== undefined && trailsDecay > 0) t.trails = { decay: trailsDecay };
  // #157 Wobble / wave-warp: nested {amplitude, frequency?, speed?} OR flat wobble_amplitude/frequency/speed.
  // Only a positive amplitude enables the ripple; frequency/speed are optional (render defaults 3 / 0.5).
  const wobRec = asRecord(params['wobble']);
  const wobAmp = wobRec ? asNumber(wobRec['amplitude']) : (num('wobble_amplitude') ?? num('wobbleAmplitude'));
  if (wobAmp !== undefined && wobAmp > 0) {
    const wob: { amplitude: number; frequency?: number; speed?: number } = { amplitude: wobAmp };
    const f = wobRec ? asNumber(wobRec['frequency']) : (num('wobble_frequency') ?? num('wobbleFrequency'));
    if (f !== undefined && f > 0) wob.frequency = f;
    const sp = wobRec ? asNumber(wobRec['speed']) : (num('wobble_speed') ?? num('wobbleSpeed'));
    if (sp !== undefined && sp >= 0) wob.speed = sp;
    t.wobble = wob;
  }
  // #158 Warmth ramp: nested {from, to, start?, duration?} OR flat warmth_from/warmth_to/warmth_start/
  // warmth_duration. Requires finite from AND to (clamped -1..1); start >= 0, duration > 0 optional.
  const warmRec = asRecord(params['warmth_ramp']) ?? asRecord(params['warmthRamp']);
  const warmFrom = warmRec ? asNumber(warmRec['from']) : (num('warmth_from') ?? num('warmthFrom'));
  const warmTo = warmRec ? asNumber(warmRec['to']) : (num('warmth_to') ?? num('warmthTo'));
  if (warmFrom !== undefined && warmTo !== undefined) {
    const clampW = (n: number) => Math.min(1, Math.max(-1, n));
    const wr: { from: number; to: number; start?: number; duration?: number } = { from: clampW(warmFrom), to: clampW(warmTo) };
    const st = warmRec ? asNumber(warmRec['start']) : (num('warmth_start') ?? num('warmthStart'));
    if (st !== undefined && st >= 0) wr.start = st;
    const du = warmRec ? asNumber(warmRec['duration']) : (num('warmth_duration') ?? num('warmthDuration'));
    if (du !== undefined && du > 0) wr.duration = du;
    t.warmthRamp = wr;
  }
  // #159 Strobe / stop-motion: nested {rate} OR flat strobe_rate (fps of visible motion). Only a positive
  // rate enables it; the render also ignores a rate at or above the output fps (no effect). Blind DATA (L090).
  const strobeRec = asRecord(params['strobe']);
  const strobeRate = strobeRec ? asNumber(strobeRec['rate']) : (num('strobe_rate') ?? num('strobeRate'));
  if (strobeRate !== undefined && strobeRate > 0) t.strobe = { rate: strobeRate };
  // #160 Scanlines (CRT / retro): nested {depth, period?, roll?} OR flat scanlines_depth/period/roll. Only a
  // positive depth enables the lines; period/roll are optional (render defaults 4px / 0 = static). Blind DATA.
  const scanRec = asRecord(params['scanlines']);
  const scanDepth = scanRec ? asNumber(scanRec['depth']) : (num('scanlines_depth') ?? num('scanlinesDepth'));
  if (scanDepth !== undefined && scanDepth > 0) {
    const sl: { depth: number; period?: number; roll?: number } = { depth: Math.min(1, Math.max(0, scanDepth)) };
    const per = scanRec ? asNumber(scanRec['period']) : (num('scanlines_period') ?? num('scanlinesPeriod'));
    if (per !== undefined && per > 0) sl.period = per;
    const rl = scanRec ? asNumber(scanRec['roll']) : (num('scanlines_roll') ?? num('scanlinesRoll'));
    if (rl !== undefined && rl >= 0) sl.roll = rl;
    t.scanlines = sl;
  }
  // #161 Lens fringe (radial chromatic aberration): nested {strength} OR flat lens_fringe_strength. Only a
  // positive strength enables it; the render clamps to a sane 0.2 max. Blind DATA (L090).
  const fringeRec = asRecord(params['lens_fringe']) ?? asRecord(params['lensFringe']);
  const fringeStrength = fringeRec ? asNumber(fringeRec['strength']) : (num('lens_fringe_strength') ?? num('lensFringeStrength'));
  if (fringeStrength !== undefined && fringeStrength > 0) t.lensFringe = { strength: Math.min(0.2, fringeStrength) };
  // #162 Posterize: nested {levels} OR flat posterize_levels. Only levels >= 2 quantizes (below 2 is a no-op);
  // clamped to 2..64 and rounded to an integer. Blind DATA (L090).
  const postRec = asRecord(params['posterize']);
  const postLevels = postRec ? asNumber(postRec['levels']) : (num('posterize_levels') ?? num('posterizeLevels'));
  if (postLevels !== undefined && postLevels >= 2) t.posterize = { levels: Math.round(Math.min(64, Math.max(2, postLevels))) };
  // #173 Solarize: nested {threshold} OR flat solarize_threshold OR bare `true` (=> 0.5). Partial per-channel
  // inversion above threshold*255. Clamped 0..1. Blind DATA (L090).
  const solRec = asRecord(params['solarize']);
  const solThr = params['solarize'] === true ? 0.5
    : (solRec ? asNumber(solRec['threshold']) : (num('solarize_threshold') ?? num('solarizeThreshold')));
  if (solThr !== undefined) t.solarize = { threshold: Math.min(1, Math.max(0, solThr)) };
  // #174 Pixelate: nested {blockSize} OR flat pixelate_block_size OR bare `true` (=> 12). Full-frame square-block
  // quantization (retro 8-bit / mosaic). blockSize is an integer >= 2, clamped 2..256 and rounded. Blind DATA (L090).
  const pixRec = asRecord(params['pixelate']);
  const pixBlock = params['pixelate'] === true ? 12
    : (pixRec ? asNumber(pixRec['blockSize']) : (num('pixelate_block_size') ?? num('pixelateBlockSize')));
  if (pixBlock !== undefined) t.pixelate = { blockSize: Math.round(Math.min(256, Math.max(2, pixBlock))) };
  // #175 Grain: nested {amount} OR flat grain_amount OR bare `true` (=> 20). Composable tunable film/sensor
  // grain strength 1..100, clamped + rounded. Blind DATA (L090).
  const grainRec = asRecord(params['grain']);
  const grainAmt = params['grain'] === true ? 20
    : (grainRec ? asNumber(grainRec['amount']) : (num('grain_amount') ?? num('grainAmount')));
  if (grainAmt !== undefined) t.grain = { amount: Math.round(Math.min(100, Math.max(1, grainAmt))) };
  // #176 Emboss: nested {depth} OR flat emboss_depth OR bare `true` (=> 1). Monochrome relief; depth scales the
  // convolution kernel, clamped 0.2..4. Blind DATA (L090).
  const embRec = asRecord(params['emboss']);
  const embDepth = params['emboss'] === true ? 1
    : (embRec ? asNumber(embRec['depth']) : (num('emboss_depth') ?? num('embossDepth')));
  if (embDepth !== undefined) t.emboss = { depth: Math.min(4, Math.max(0.2, embDepth)) };
  // #177 Defocus: nested {amount} OR flat defocus_amount OR bare `true` (=> 8). Uniform gaussian blur radius,
  // clamped 0.3..40. Blind DATA (L090).
  const defRec = asRecord(params['defocus']);
  const defAmt = params['defocus'] === true ? 8
    : (defRec ? asNumber(defRec['amount']) : (num('defocus_amount') ?? num('defocusAmount')));
  if (defAmt !== undefined) t.defocus = { amount: Math.min(40, Math.max(0.3, defAmt)) };
  // #178 Fisheye: nested {strength} OR flat fisheye_strength OR bare `true` (=> -0.4). Lens k1 coefficient,
  // clamped -1..1 (negative bulges, positive pinches). Blind DATA (L090).
  const fishRec = asRecord(params['fisheye']);
  const fishS = params['fisheye'] === true ? -0.4
    : (fishRec ? asNumber(fishRec['strength']) : (num('fisheye_strength') ?? num('fisheyeStrength')));
  if (fishS !== undefined) t.fisheye = { strength: Math.min(1, Math.max(-1, fishS)) };
  // #179 Warmth: nested {amount} OR flat warmth_amount OR bare `true` (=> 0.5). Static white-balance tint,
  // -1..1 (positive warm, negative cool). Blind DATA (L090).
  const wbRec = asRecord(params['warmth']);
  const wbAmt = params['warmth'] === true ? 0.5
    : (wbRec ? asNumber(wbRec['amount']) : (num('warmth_amount') ?? num('warmthAmount')));
  if (wbAmt !== undefined) t.warmth = { amount: Math.min(1, Math.max(-1, wbAmt)) };
  // #180 Color splash: bare `true` (=> keep red, similarity 0.3) OR nested {color, similarity}. Keeps one hue,
  // greys the rest. similarity clamped 0.01..1. Blind DATA (L090); the color is sanitized at render time.
  const splashRec = asRecord(params['colorSplash']);
  if (params['colorSplash'] === true) {
    t.colorSplash = { color: 'red', similarity: 0.3 };
  } else if (splashRec && typeof splashRec['color'] === 'string') {
    const splashSim = asNumber(splashRec['similarity']);
    t.colorSplash = { color: splashRec['color'], similarity: splashSim !== undefined ? Math.min(1, Math.max(0.01, splashSim)) : 0.3 };
  }
  // #181 Perspective: nested {tilt} OR flat perspective_tilt OR bare `true` (=> 0.4). Keystone trapezoid warp,
  // tilt clamped -1..1 (positive top-in, negative bottom-in). Blind DATA (L090).
  const perspRec = asRecord(params['perspective']);
  const perspTilt = params['perspective'] === true ? 0.4
    : (perspRec ? asNumber(perspRec['tilt']) : (num('perspective_tilt') ?? num('perspectiveTilt')));
  if (perspTilt !== undefined) t.perspective = { tilt: Math.min(1, Math.max(-1, perspTilt)) };
  // #182 Smooth: nested {amount} OR flat smooth_amount OR bare `true` (=> 0.6). Edge-PRESERVING smooth (a
  // light in-filter smartblur / "beauty", distinct from #177 defocus which blurs edges too, and from the
  // heavy out-of-process `denoise` binary). amount clamped 0..1; 0 is identity. Blind DATA (L090).
  const smoothRec = asRecord(params['smooth']);
  const smoothAmt = params['smooth'] === true ? 0.6
    : (smoothRec ? asNumber(smoothRec['amount']) : (num('smooth_amount') ?? num('smoothAmount')));
  if (smoothAmt !== undefined && smoothAmt > 0) t.smooth = { amount: Math.min(1, Math.max(0, smoothAmt)) };
  // #183 Directional blur: nested {amount, axis} OR flat directional_blur_amount/axis OR bare `true`
  // (=> amount 0.6, axis h). A single-axis motion streak (avgblur separable), axis 'h' or 'v' selected as
  // DATA; amount clamped 0..1; 0 dropped. Distinct from #177 defocus (symmetric). Blind DATA (L090).
  const dirRec = asRecord(params['directionalBlur']);
  const dirAmt = params['directionalBlur'] === true ? 0.6
    : (dirRec ? asNumber(dirRec['amount']) : (num('directional_blur_amount') ?? num('directionalBlurAmount')));
  if (dirAmt !== undefined && dirAmt > 0) {
    const rawAxis = params['directionalBlur'] === true ? 'h'
      : (dirRec && typeof dirRec['axis'] === 'string' ? dirRec['axis'] : (str('directional_blur_axis') ?? str('directionalBlurAxis')));
    t.directionalBlur = { amount: Math.min(1, Math.max(0, dirAmt)), axis: rawAxis === 'v' ? 'v' : 'h' };
  }
  // #184 Binarize: nested {cutoff} OR flat binarize_cutoff OR bare `true` (=> 0.5). Pure 1-bit black/white at
  // a luma cutoff (the notan / silkscreen stamp look), cutoff clamped 0..1. Distinct from #175 posterize
  // (N color levels) and #173 solarize (invert above cutoff). Blind DATA (L090).
  const binRec = asRecord(params['binarize']);
  const binCut = params['binarize'] === true ? 0.5
    : (binRec ? asNumber(binRec['cutoff']) : (num('binarize_cutoff') ?? num('binarizeCutoff')));
  if (binCut !== undefined) t.binarize = { cutoff: Math.min(1, Math.max(0, binCut)) };
  // #185 Swirl: nested {strength} OR flat swirl_strength OR bare `true` (=> 0.6). A rotational twist that is
  // strongest at the center and fades to zero at the edge, strength clamped -1..1 (sign = twist direction).
  // Distinct from #178 fisheye (radial bulge), #181 perspective (keystone), and wobble (wave). Blind DATA.
  const swirlRec = asRecord(params['swirl']);
  const swirlStr = params['swirl'] === true ? 0.6
    : (swirlRec ? asNumber(swirlRec['strength']) : (num('swirl_strength') ?? num('swirlStrength')));
  if (swirlStr !== undefined && swirlStr !== 0) t.swirl = { strength: Math.min(1, Math.max(-1, swirlStr)) };
  // #186 Mirror: nested {axis} OR flat mirror_axis OR bare `true` (=> axis h). A kaleidoscope-style self-fold
  // that reflects one half of the frame onto the other, axis 'h' (left onto right) or 'v' (top onto bottom).
  // Distinct from `flip` (a full flip, not a symmetric fold). Blind DATA (L090).
  const mirrorRec = asRecord(params['mirror']);
  const mirrorOn = params['mirror'] === true || mirrorRec !== undefined || str('mirror_axis') !== undefined || str('mirrorAxis') !== undefined;
  if (mirrorOn) {
    const rawAxis = params['mirror'] === true ? 'h'
      : (mirrorRec && typeof mirrorRec['axis'] === 'string' ? mirrorRec['axis'] : (str('mirror_axis') ?? str('mirrorAxis')));
    t.mirror = { axis: rawAxis === 'v' ? 'v' : 'h' };
  }
  // #187 Tile: nested {count} OR flat tile_count OR bare `true` (=> 2). Repeats the frame in an NxN grid (the
  // kaleidoscope-tile / grid look), count clamped 2..6 and rounded; count < 2 is identity (dropped). Blind DATA.
  const tileRec = asRecord(params['tile']);
  const tileCount = params['tile'] === true ? 2
    : (tileRec ? asNumber(tileRec['count']) : (num('tile_count') ?? num('tileCount')));
  if (tileCount !== undefined && tileCount >= 2) t.tile = { count: Math.min(6, Math.max(2, Math.round(tileCount))) };
  // #188 Invert (photographic negative): bare `true` only, no params. Blind DATA (L090); dropped unless true.
  if (params['invert'] === true) t.invert = true;
  // #189 Vibrance: nested {intensity} OR flat vibrance_intensity OR bare `true` (=> 0.6). intensity 0 is
  // identity (dropped); clamped -1..1. Blind DATA (L090).
  const vibRec = asRecord(params['vibrance']);
  const vibInt = params['vibrance'] === true ? 0.6
    : (vibRec ? asNumber(vibRec['intensity']) : (num('vibrance_intensity') ?? num('vibranceIntensity')));
  if (vibInt !== undefined && vibInt !== 0) t.vibrance = { intensity: Math.min(1, Math.max(-1, vibInt)) };
  // #190 Channel swap: nested {pair} OR flat channel_swap_pair OR bare `true` (=> 'rb'). pair is one of
  // rb/rg/gb (unknown falls back to rb). Blind DATA (L090); dropped unless present.
  const csRec = asRecord(params['channelSwap']);
  const csOn = params['channelSwap'] === true || csRec !== undefined || str('channel_swap_pair') !== undefined || str('channelSwapPair') !== undefined;
  if (csOn) {
    const rawPair = params['channelSwap'] === true ? 'rb'
      : (csRec && typeof csRec['pair'] === 'string' ? csRec['pair'] : (str('channel_swap_pair') ?? str('channelSwapPair')));
    t.channelSwap = { pair: rawPair === 'rg' ? 'rg' : (rawPair === 'gb' ? 'gb' : 'rb') };
  }
  // #191 Exposure: nested {stops} OR flat exposure_stops OR bare `true` (=> 0.6). stops 0 is identity
  // (dropped); clamped -2..2. Blind DATA (L090).
  const expRec = asRecord(params['exposure']);
  const expStops = params['exposure'] === true ? 0.6
    : (expRec ? asNumber(expRec['stops']) : (num('exposure_stops') ?? num('exposureStops')));
  if (expStops !== undefined && expStops !== 0) t.exposure = { stops: Math.min(2, Math.max(-2, expStops)) };
  // #192 Shear: nested {amount, axis} OR flat shear_amount/shear_axis OR bare `true` (=> amount 0.3, axis h).
  // amount 0 is identity (dropped); clamped -1..1; axis 'h' (default) or 'v'. Blind DATA (L090).
  const shRec = asRecord(params['shear']);
  const shOn = params['shear'] === true || shRec !== undefined || num('shear_amount') !== undefined || num('shearAmount') !== undefined;
  if (shOn) {
    const rawAmt = params['shear'] === true ? 0.3
      : (shRec ? asNumber(shRec['amount']) : (num('shear_amount') ?? num('shearAmount')));
    const rawAxis = params['shear'] === true ? 'h'
      : (shRec && typeof shRec['axis'] === 'string' ? shRec['axis'] : (str('shear_axis') ?? str('shearAxis')));
    const amt = rawAmt === undefined ? 0.3 : Math.min(1, Math.max(-1, rawAmt));
    if (amt !== 0) t.shear = { amount: amt, axis: rawAxis === 'v' ? 'v' : 'h' };
  }
  // #193 Auto-contrast (histogram equalization): nested {strength} OR flat histeq_strength OR bare `true`
  // (=> 0.5). strength 0 is identity (dropped); clamped 0..1. Blind DATA (L090).
  const heqRec = asRecord(params['histeq']);
  const heqStr = params['histeq'] === true ? 0.5
    : (heqRec ? asNumber(heqRec['strength']) : (num('histeq_strength') ?? num('histeqStrength')));
  if (heqStr !== undefined && heqStr > 0) t.histeq = { strength: Math.min(1, Math.max(0, heqStr)) };
  // #194 Morphology: nested {mode, amount} OR flat morphology_mode/morphology_amount OR bare `true` (=> dilate,
  // amount 2). mode 'erode' or (default) 'dilate'; amount clamped 1..4 and rounded. Blind DATA (L090).
  const morphRec = asRecord(params['morphology']);
  const morphOn = params['morphology'] === true || morphRec !== undefined || str('morphology_mode') !== undefined || num('morphology_amount') !== undefined;
  if (morphOn) {
    const rawMode = params['morphology'] === true ? 'dilate'
      : (morphRec && typeof morphRec['mode'] === 'string' ? morphRec['mode'] : (str('morphology_mode') ?? str('morphologyMode')));
    const rawAmt = params['morphology'] === true ? 2
      : (morphRec ? asNumber(morphRec['amount']) : (num('morphology_amount') ?? num('morphologyAmount')));
    const amt = rawAmt === undefined ? 2 : Math.min(4, Math.max(1, Math.round(rawAmt)));
    t.morphology = { mode: rawMode === 'erode' ? 'erode' : 'dilate', amount: amt };
  }
  // #195 Colorize: nested {hue, strength} OR flat colorize_hue/colorize_strength OR bare `true` (=> hue 220,
  // strength 0.5). hue wraps 0..360; strength clamped 0..1; strength 0 is identity (dropped). Blind DATA (L090).
  const colRec = asRecord(params['colorize']);
  const colOn = params['colorize'] === true || colRec !== undefined || num('colorize_hue') !== undefined || num('colorize_strength') !== undefined;
  if (colOn) {
    const rawHue = params['colorize'] === true ? 220
      : (colRec ? asNumber(colRec['hue']) : (num('colorize_hue') ?? num('colorizeHue')));
    const rawStr = params['colorize'] === true ? 0.5
      : (colRec ? asNumber(colRec['strength']) : (num('colorize_strength') ?? num('colorizeStrength')));
    const hue = rawHue === undefined ? 220 : ((Math.round(rawHue) % 360) + 360) % 360;
    const strength = rawStr === undefined ? 0.5 : Math.min(1, Math.max(0, rawStr));
    if (strength > 0) t.colorize = { hue, strength };
  }
  // #196 Auto white-balance (normalize): nested {strength} OR flat normalize_strength OR bare `true` (=> 1.0).
  // strength 0 is identity (dropped); clamped 0..1. Blind DATA (L090).
  const normRec = asRecord(params['normalize']);
  const normStr = params['normalize'] === true ? 1
    : (normRec ? asNumber(normRec['strength']) : (num('normalize_strength') ?? num('normalizeStrength')));
  if (normStr !== undefined && normStr > 0) t.normalize = { strength: Math.min(1, Math.max(0, normStr)) };
  // #197 Chroma bleed: nested {radius} OR flat chroma_bleed_radius OR bare `true` (=> 15). radius < 1 is
  // identity (dropped); clamped 1..40 and rounded. Blind DATA (L090).
  const cbRec = asRecord(params['chromaBleed']);
  const cbRad = params['chromaBleed'] === true ? 15
    : (cbRec ? asNumber(cbRec['radius']) : (num('chroma_bleed_radius') ?? num('chromaBleedRadius')));
  if (cbRad !== undefined && cbRad >= 1) t.chromaBleed = { radius: Math.min(40, Math.max(1, Math.round(cbRad))) };
  // #198 RGB split: nested {amount} OR flat rgb_split_amount OR bare `true` (=> 6). amount < 1 is identity
  // (dropped); clamped 1..30 and rounded. Blind DATA (L090).
  const rsRec = asRecord(params['rgbSplit']);
  const rsAmt = params['rgbSplit'] === true ? 6
    : (rsRec ? asNumber(rsRec['amount']) : (num('rgb_split_amount') ?? num('rgbSplitAmount')));
  if (rsAmt !== undefined && rsAmt >= 1) t.rgbSplit = { amount: Math.min(30, Math.max(1, Math.round(rsAmt))) };
  // #199 Mono mix: nested {r,g,b} weights OR flat mono_mix_r/g/b OR bare `true` (=> red filter 0.7,0.2,0.1).
  // Each weight clamped 0..2 and rounded to 3 dp; enabled only when the sum > 0 (all-zero is a black no-op).
  // Blind DATA (L090).
  const mmRec = asRecord(params['monoMix']);
  let mmR: number | undefined, mmG: number | undefined, mmB: number | undefined;
  if (params['monoMix'] === true) { mmR = 0.7; mmG = 0.2; mmB = 0.1; }
  else if (mmRec) { mmR = asNumber(mmRec['r']); mmG = asNumber(mmRec['g']); mmB = asNumber(mmRec['b']); }
  else { mmR = num('mono_mix_r') ?? num('monoMixR'); mmG = num('mono_mix_g') ?? num('monoMixG'); mmB = num('mono_mix_b') ?? num('monoMixB'); }
  if (mmR !== undefined || mmG !== undefined || mmB !== undefined) {
    const clampW = (v: number | undefined) => Math.min(2, Math.max(0, Math.round((Number.isFinite(v as number) ? (v as number) : 0) * 1000) / 1000));
    const wr = clampW(mmR), wg = clampW(mmG), wb = clampW(mmB);
    if (wr + wg + wb > 0) t.monoMix = { r: wr, g: wg, b: wb };
  }
  // #200 Faded film: nested {lift} OR flat faded_film_lift OR bare `true` (=> 0.15). lift <= 0 is identity
  // (dropped); clamped 0..0.5 and rounded to 3 dp. Blind DATA (L090).
  const ffRec = asRecord(params['fadedFilm']);
  const ffLift = params['fadedFilm'] === true ? 0.15
    : (ffRec ? asNumber(ffRec['lift']) : (num('faded_film_lift') ?? num('fadedFilmLift')));
  if (ffLift !== undefined && ffLift > 0) t.fadedFilm = { lift: Math.min(0.5, Math.max(0, Math.round(ffLift * 1000) / 1000)) };
  // #163 Halftone: nested {size} OR flat halftone_size (dot cell px). Only size >= 2 enables it; clamped 2..40
  // and rounded. Blind DATA (L090).
  const htRec = asRecord(params['halftone']);
  const htSize = htRec ? asNumber(htRec['size']) : (num('halftone_size') ?? num('halftoneSize'));
  if (htSize !== undefined && htSize >= 2) t.halftone = { size: Math.round(Math.min(40, Math.max(2, htSize))) };
  // #164 Tilt-shift / focus band: nested {center, height, feather?, blur?} OR flat tilt_shift_center/height/
  // feather/blur. Only height > 0 enables it; center/height/feather clamped 0..1, blur > 0. Blind DATA (L090).
  const tsRec = asRecord(params['tilt_shift']) ?? asRecord(params['tiltShift']);
  const tsHeight = tsRec ? asNumber(tsRec['height']) : (num('tilt_shift_height') ?? num('tiltShiftHeight'));
  if (tsHeight !== undefined && tsHeight > 0) {
    const clamp01 = (n: number | undefined, d: number) => (n === undefined ? d : Math.min(1, Math.max(0, n)));
    const ts: { center: number; height: number; feather?: number; blur?: number } = {
      center: clamp01(tsRec ? asNumber(tsRec['center']) : (num('tilt_shift_center') ?? num('tiltShiftCenter')), 0.5),
      height: Math.min(1, Math.max(0, tsHeight)),
    };
    const fe = tsRec ? asNumber(tsRec['feather']) : (num('tilt_shift_feather') ?? num('tiltShiftFeather'));
    if (fe !== undefined && fe >= 0) ts.feather = Math.min(1, fe);
    const bl = tsRec ? asNumber(tsRec['blur']) : (num('tilt_shift_blur') ?? num('tiltShiftBlur'));
    if (bl !== undefined && bl > 0) ts.blur = bl;
    t.tiltShift = ts;
  }
  // #165 Sketch / edge-detect: nested {mode?, strength?} OR flat sketch_mode / sketch_strength (also plain
  // `sketch: true` for the default cartoon look). Enabled by the object's presence or sketch === true; the
  // render clamps strength 0..1 and allowlists mode. Blind DATA (L090).
  const skRec = asRecord(params['sketch']);
  const skFlag = typeof params['sketch'] === 'boolean' ? (params['sketch'] as boolean) : undefined;
  const skFlatMode = asString(params['sketch_mode']) ?? asString(params['sketchMode']);
  const skFlatStrength = num('sketch_strength') ?? num('sketchStrength');
  if (skRec || skFlag === true || skFlatMode !== undefined || skFlatStrength !== undefined) {
    const sk: { mode?: string; strength?: number } = {};
    const mode = skRec ? asString(skRec['mode']) : skFlatMode;
    if (mode !== undefined && mode.trim()) sk.mode = mode.trim();
    const strength = skRec ? asNumber(skRec['strength']) : skFlatStrength;
    if (strength !== undefined) sk.strength = Math.min(1, Math.max(0, strength));
    t.sketch = sk;
  }
  // #167 Zoom / radial blur: nested {strength, cx?, cy?} OR flat zoom_blur_strength / zoom_blur_cx / zoom_blur_cy.
  // Only strength > 0 enables it; strength/cx/cy clamped 0..1 (cx/cy default 0.5 handled by render). Blind DATA (L090).
  const zbRec = asRecord(params['zoom_blur']) ?? asRecord(params['zoomBlur']);
  const zbStrength = zbRec ? asNumber(zbRec['strength']) : (num('zoom_blur_strength') ?? num('zoomBlurStrength'));
  if (zbStrength !== undefined && zbStrength > 0) {
    const zb: { strength: number; cx?: number; cy?: number } = { strength: Math.min(1, Math.max(0, zbStrength)) };
    const zcx = zbRec ? asNumber(zbRec['cx']) : (num('zoom_blur_cx') ?? num('zoomBlurCx'));
    if (zcx !== undefined) zb.cx = Math.min(1, Math.max(0, zcx));
    const zcy = zbRec ? asNumber(zbRec['cy']) : (num('zoom_blur_cy') ?? num('zoomBlurCy'));
    if (zcy !== undefined) zb.cy = Math.min(1, Math.max(0, zcy));
    t.zoomBlur = zb;
  }
  // #168 Light leak: nested {strength, color?, x?, y?, radius?} OR flat light_leak_strength / _color / _x / _y /
  // _radius. Only strength > 0 enables it; strength/x/y/radius clamped 0..1 (x/y default top-right, radius
  // default handled by render); color kept as free text (render resolves to safe RGB ints). Blind DATA (L090).
  const llRec = asRecord(params['light_leak']) ?? asRecord(params['lightLeak']);
  const llStrength = llRec ? asNumber(llRec['strength']) : (num('light_leak_strength') ?? num('lightLeakStrength'));
  if (llStrength !== undefined && llStrength > 0) {
    const ll: { strength: number; color?: string; x?: number; y?: number; radius?: number } = { strength: Math.min(1, Math.max(0, llStrength)) };
    const lc = llRec ? asString(llRec['color']) : asString(params['light_leak_color']);
    if (lc !== undefined && lc.trim()) ll.color = lc.trim();
    const lx = llRec ? asNumber(llRec['x']) : (num('light_leak_x') ?? num('lightLeakX'));
    if (lx !== undefined) ll.x = Math.min(1, Math.max(0, lx));
    const ly = llRec ? asNumber(llRec['y']) : (num('light_leak_y') ?? num('lightLeakY'));
    if (ly !== undefined) ll.y = Math.min(1, Math.max(0, ly));
    const lr = llRec ? asNumber(llRec['radius']) : (num('light_leak_radius') ?? num('lightLeakRadius'));
    if (lr !== undefined && lr > 0) ll.radius = Math.min(1, Math.max(0, lr));
    t.lightLeak = ll;
  }
  // #169 Film damage: nested {scratches?, dust?, strength?} OR flat film_damage_scratches / _dust / _strength
  // (also plain film_damage:true for the default look). Enabled when scratches>0 OR dust>0 OR the flag is
  // true; counts are rounded and clamped (scratches 0..8, dust 0..40), strength clamped 0..1. Blind DATA (L090).
  const fdRec = asRecord(params['film_damage']) ?? asRecord(params['filmDamage']);
  const fdFlag = typeof params['film_damage'] === 'boolean' ? (params['film_damage'] as boolean) : undefined;
  const fdScratches = fdRec ? asNumber(fdRec['scratches']) : (num('film_damage_scratches') ?? num('filmDamageScratches'));
  const fdDust = fdRec ? asNumber(fdRec['dust']) : (num('film_damage_dust') ?? num('filmDamageDust'));
  if ((fdScratches !== undefined && fdScratches > 0) || (fdDust !== undefined && fdDust > 0) || fdFlag === true) {
    const fd: { scratches?: number; dust?: number; strength?: number } = {};
    const sc = fdScratches !== undefined ? Math.round(Math.min(8, Math.max(0, fdScratches))) : (fdFlag === true ? 2 : 0);
    if (sc > 0) fd.scratches = sc;
    const du = fdDust !== undefined ? Math.round(Math.min(40, Math.max(0, fdDust))) : (fdFlag === true ? 14 : 0);
    if (du > 0) fd.dust = du;
    const fst = fdRec ? asNumber(fdRec['strength']) : (num('film_damage_strength') ?? num('filmDamageStrength'));
    if (fst !== undefined) fd.strength = Math.min(1, Math.max(0, fst));
    if (fd.scratches || fd.dust) t.filmDamage = fd;
  }
  // #171 Hue rotation: nested {degrees, saturation?, cycleRate?} OR flat hue_shift_degrees /
  // hue_shift_saturation / hue_shift_cycle_rate, OR bare hue_shift:<number> (= degrees). Enabled when
  // degrees is nonzero OR a nonzero cycleRate spins it; degrees clamped -360..360, saturation clamped
  // 0..3, cycleRate clamped -720..720 deg/s. Blind DATA (L090).
  const hsRec = asRecord(params['hue_shift']) ?? asRecord(params['hueShift']);
  const hsBare = typeof params['hue_shift'] === 'number' ? (params['hue_shift'] as number)
    : (typeof params['hueShift'] === 'number' ? (params['hueShift'] as number) : undefined);
  const hsDeg = hsRec ? asNumber(hsRec['degrees']) : (num('hue_shift_degrees') ?? num('hueShiftDegrees') ?? hsBare);
  const hsCycle = hsRec ? asNumber(hsRec['cycleRate']) : (num('hue_shift_cycle_rate') ?? num('hueShiftCycleRate'));
  if ((hsDeg !== undefined && hsDeg !== 0) || (hsCycle !== undefined && hsCycle !== 0)) {
    const hs: { degrees: number; saturation?: number; cycleRate?: number } = {
      degrees: Math.max(-360, Math.min(360, hsDeg ?? 0)),
    };
    const hsSat = hsRec ? asNumber(hsRec['saturation']) : (num('hue_shift_saturation') ?? num('hueShiftSaturation'));
    if (hsSat !== undefined) hs.saturation = Math.max(0, Math.min(3, hsSat));
    if (hsCycle !== undefined && hsCycle !== 0) hs.cycleRate = Math.max(-720, Math.min(720, hsCycle));
    t.hueShift = hs;
  }
  // #119 Whole-clip orientation. `rotate_degrees` snaps to the nearest quarter-turn in {90,180,270}
  // (0/360 = identity, dropped); `flip` mirrors ('h'|'v'|'hv'). Blind DATA (L090).
  const rotateDegrees = num('rotate_degrees') ?? num('rotateDegrees');
  if (rotateDegrees !== undefined) {
    const q = ((Math.round(rotateDegrees / 90) * 90) % 360 + 360) % 360;
    if (q === 90 || q === 180 || q === 270) t.rotateDegrees = q;
  }
  const flipClip = str('flip') ?? str('clip_flip');
  if (flipClip === 'h' || flipClip === 'v' || flipClip === 'hv') t.flip = flipClip;
  // #120 Manual crop rect. Read a nested {x,y,w,h} object (crop_rect/cropRect) or flat crop_x/y/w/h,
  // all as 0..1 fractions. Clamp into frame, require w>0/h>0, drop a full-frame (identity) crop.
  const cr = asRecord(params['crop_rect']) ?? asRecord(params['cropRect']);
  const cropX = cr ? asNumber(cr['x']) : num('crop_x');
  const cropY = cr ? asNumber(cr['y']) : num('crop_y');
  const cropW = cr ? asNumber(cr['w']) : num('crop_w');
  const cropH = cr ? asNumber(cr['h']) : num('crop_h');
  if (cropW !== undefined && cropH !== undefined && cropW > 0 && cropH > 0) {
    const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
    const x = clamp01(cropX ?? 0);
    const y = clamp01(cropY ?? 0);
    const w = Math.min(clamp01(cropW), 1 - x);
    const h = Math.min(clamp01(cropH), 1 - y);
    if (w > 0 && h > 0 && (x > 0 || y > 0 || w < 1 || h < 1)) t.cropRect = { x, y, w, h };
  }
  // #121 Manual color adjustment. Read a nested {brightness,contrast,saturation,gamma} object
  // (color_adjust/colorAdjust) or flat keys. Keep only the terms that differ from identity
  // (brightness 0, contrast/saturation/gamma 1); drop the whole thing if it is all-identity.
  const ca = asRecord(params['color_adjust']) ?? asRecord(params['colorAdjust']);
  const caGet = (k: string) => (ca ? asNumber(ca[k]) : num(k));
  const brightnessAdj = caGet('brightness');
  const contrastAdj = caGet('contrast');
  const saturationAdj = caGet('saturation');
  const gammaAdj = caGet('gamma');
  const adjust: { brightness?: number; contrast?: number; saturation?: number; gamma?: number } = {};
  if (brightnessAdj !== undefined && brightnessAdj !== 0) adjust.brightness = brightnessAdj;
  if (contrastAdj !== undefined && contrastAdj !== 1) adjust.contrast = contrastAdj;
  if (saturationAdj !== undefined && saturationAdj !== 1) adjust.saturation = saturationAdj;
  if (gammaAdj !== undefined && gammaAdj > 0 && gammaAdj !== 1) adjust.gamma = gammaAdj;
  if (Object.keys(adjust).length > 0) t.colorAdjust = adjust;
  // #122 Self-glow / bloom. `glow` boolean turns on the screen-blended blurred-copy bloom;
  // `glow_strength` 0..1 (default applied at render) scales spread + intensity.
  const glow = params['glow'] ?? params['glowOn'];
  if (typeof glow === 'boolean') t.glow = glow;
  const glowStrength = num('glow_strength') ?? num('glowStrength');
  if (glowStrength !== undefined) t.glowStrength = Math.min(1, Math.max(0, glowStrength));
  // #123 Sharpen / clarity. `sharpen`/`clarity` 0..1 scales the unsharp amount; 0 is identity, dropped.
  const sharpen = num('sharpen') ?? num('clarity');
  if (sharpen !== undefined && sharpen > 0) t.sharpen = Math.min(1, sharpen);
  // #124 Border / frame. Nested {width,color} object OR flat border_width/border_color (stroke is an
  // alias for width, completing the legacy frame-styling field). Only a positive width draws a border.
  const bd = asRecord(params['border']);
  const borderWidth = bd ? asNumber(bd['width']) : (num('border_width') ?? num('borderWidth') ?? num('stroke'));
  const borderColor = (bd ? asString(bd['color']) : (str('border_color') ?? str('borderColor'))) ?? 'white';
  if (borderWidth !== undefined && borderWidth > 0) t.border = { width: Math.round(borderWidth), color: borderColor };
  // #125 Spotlight / positioned radial focus. Nested {cx,cy,strength} object OR flat
  // spotlight_x/spotlight_y/spotlight_strength (0..1). Only a positive strength dims the frame.
  const sp = asRecord(params['spotlight']);
  const spStrength = sp ? asNumber(sp['strength']) : (num('spotlight_strength') ?? num('spotlightStrength'));
  if (spStrength !== undefined && spStrength > 0) {
    const clamp01 = (n: number | undefined, d: number) => (n === undefined ? d : Math.min(1, Math.max(0, n)));
    t.spotlight = {
      cx: clamp01(sp ? asNumber(sp['cx']) : num('spotlight_x'), 0.5),
      cy: clamp01(sp ? asNumber(sp['cy']) : num('spotlight_y'), 0.5),
      strength: Math.min(1, spStrength),
    };
    // #201 Spotlight breathe: an optional `pulse` (cycles/sec) that throbs the falloff depth over time.
    // Nested spotlight.pulse OR flat spotlight_pulse; clamped 0..10; only a positive pulse is kept.
    const spPulse = sp ? asNumber(sp['pulse']) : (num('spotlight_pulse') ?? num('spotlightPulse'));
    if (spPulse !== undefined && spPulse > 0) t.spotlight.pulse = Math.min(10, Math.max(0, spPulse));
    // #154 Spotlight follow: an optional keyframed path {at (fraction 0..1), cx, cy}. Parsed from a
    // nested `track`/`spotlight_track` array; each point needs finite at/cx/cy (clamped 0..1). Sorted
    // by `at`; kept only when >= 2 valid points resolve (one point is just the static center already
    // captured above). The render interpolates cx/cy across the clip (L069: static center = a track
    // of length 0/1; a moving center = the same primitive with a path).
    const rawTrack = (sp ? sp['track'] : undefined) ?? params['spotlight_track'] ?? params['spotlightTrack'];
    if (Array.isArray(rawTrack)) {
      const pts = rawTrack
        .map((r) => asRecord(r))
        .filter((r): r is Record<string, unknown> => r !== undefined)
        .map((r) => ({ at: asNumber(r['at']), cx: asNumber(r['cx']), cy: asNumber(r['cy']) }))
        .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.cx) && Number.isFinite(p.cy))
        .map((p) => ({ at: Math.min(1, Math.max(0, p.at as number)), cx: clamp01(p.cx, 0.5), cy: clamp01(p.cy, 0.5) }))
        .sort((a, b) => a.at - b.at);
      if (pts.length >= 2) t.spotlight.track = pts;
    }
  }
  // #126 Framed clip. Nested {scale,background} object OR flat frame_scale/frame_background. Only a
  // scale below 1 shrinks the clip (>= 1 is identity, dropped); background defaults to black.
  const fr = asRecord(params['frame']);
  const frScale = fr ? asNumber(fr['scale']) : (num('frame_scale') ?? num('frameScale'));
  if (frScale !== undefined && frScale > 0 && frScale < 1) {
    const bg = (fr ? asString(fr['background']) : (str('frame_background') ?? str('frameBackground'))) ?? 'black';
    t.frame = { scale: Math.max(0.1, frScale), background: bg };
  }
  // #127 Duotone. Nested {shadow,highlight} object OR flat duotone_shadow/duotone_highlight, both
  // 6-digit hex (#RRGGBB or RRGGBB). Only set when BOTH parse as valid hex (the render maps luma between
  // them via curves). Normalize to lowercase 6-hex without '#'.
  const dt = asRecord(params['duotone']);
  const hex = (v: string | undefined): string | undefined => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(v ?? '');
    return m ? m[1].toLowerCase() : undefined;
  };
  const dtShadow = hex(dt ? asString(dt['shadow']) : (str('duotone_shadow') ?? str('duotoneShadow')));
  const dtHighlight = hex(dt ? asString(dt['highlight']) : (str('duotone_highlight') ?? str('duotoneHighlight')));
  if (dtShadow !== undefined && dtHighlight !== undefined) t.duotone = { shadow: dtShadow, highlight: dtHighlight };
  // #172 Gradient map: map luma to a MULTI-STOP color ramp (the N-stop generalization of #127 duotone).
  // `gradientMap: true` seeds a default 3-stop teal->amber ramp; a nested {stops:[{at,color},...]} object
  // supplies a custom ramp. Each stop's `at` clamps 0..1 and `color` is a named color OR 6-hex (opt '#');
  // stops are sorted by `at`. Dropped unless >= 2 valid stops survive. The render (colorToRgb255 + geq)
  // blends the two surrounding stops per pixel, so any garbage color yields safe RGB ints (injection-safe).
  const gmRaw = params['gradientMap'] ?? params['gradient_map'];
  if (gmRaw !== undefined) {
    const parseStop = (rec: Record<string, unknown> | null): { at: number; color: string } | undefined => {
      if (!rec) return undefined;
      const at = asNumber(rec['at']);
      const c = asString(rec['color']);
      if (at === undefined || c === undefined) return undefined;
      const col = c.trim();
      // named color (letters only) OR 6-hex (optional '#'), the only forms colorToRgb255 resolves.
      if (!(/^#?[0-9a-fA-F]{6}$/.test(col) || /^[A-Za-z]+$/.test(col))) return undefined;
      return { at: Math.min(1, Math.max(0, at)), color: col.toLowerCase() };
    };
    const DEFAULT_GRADIENT_STOPS = [
      { at: 0, color: '#0a2540' },
      { at: 0.5, color: '#1f9ea6' },
      { at: 1, color: '#ffb454' },
    ];
    let stops: Array<{ at: number; color: string }>;
    if (gmRaw === true) {
      stops = DEFAULT_GRADIENT_STOPS.map((s) => ({ ...s }));
    } else {
      const rec = asRecord(gmRaw);
      const rawStops = rec ? rec['stops'] : undefined;
      stops = Array.isArray(rawStops)
        ? rawStops.map((s) => parseStop(asRecord(s))).filter((s): s is { at: number; color: string } => s !== undefined)
        : [];
    }
    if (stops.length >= 2) {
      stops.sort((a, b) => a.at - b.at);
      t.gradientMap = { stops };
    }
  }
  // #128 Rounded corners. Nested {radius,background} object OR flat corner_radius/corner_background.
  // radius is a 0..0.5 fraction of the shorter side (resolution-independent). Only a positive radius
  // rounds; background defaults to black. (The render parses the color to RGB ints, so any value is
  // injection-safe, but we pass it through verbatim here.)
  const rc = asRecord(params['roundedCorners']) ?? asRecord(params['rounded_corners']);
  const rcRadius = rc ? asNumber(rc['radius']) : (num('corner_radius') ?? num('cornerRadius'));
  if (rcRadius !== undefined && rcRadius > 0) {
    const bg = (rc ? asString(rc['background']) : (str('corner_background') ?? str('cornerBackground'))) ?? 'black';
    const rcFeather = rc ? asNumber(rc['feather']) : (num('corner_feather') ?? num('cornerFeather'));
    t.roundedCorners = {
      radius: Math.min(0.5, rcRadius),
      background: bg,
      feather: rcFeather === undefined ? 0 : Math.min(1, Math.max(0, rcFeather)),
    };
  }
  // #129 Drop shadow / floating card. Nested {scale,blur,dx,dy,color,background} object OR a flat
  // `drop_shadow: true` (defaults) OR flat drop_shadow_* keys. Presence turns it on; missing fields use
  // the Screen Studio defaults (scale 0.85, blur 16px, offset 0/16px, black shadow on a white canvas).
  const ds = asRecord(params['dropShadow']) ?? asRecord(params['drop_shadow']);
  const dsFlat = Object.keys(params).some((k) => k.startsWith('drop_shadow_') || k.startsWith('dropShadow'));
  const dsOn = ds !== undefined || params['drop_shadow'] === true || params['dropShadow'] === true || dsFlat;
  if (dsOn) {
    const dnum = (k1: string, k2: string, d: number) => {
      const v = ds ? asNumber(ds[k1]) : (num(k2) ?? num(k1));
      return v === undefined ? d : v;
    };
    const dstr = (k1: string, k2: string, d: string) => {
      const v = ds ? asString(ds[k1]) : (str(k2) ?? str(k1));
      return v === undefined ? d : v;
    };
    t.dropShadow = {
      scale: Math.min(0.99, Math.max(0.1, dnum('scale', 'drop_shadow_scale', 0.85))),
      blur: Math.max(0, dnum('blur', 'drop_shadow_blur', 16)),
      dx: dnum('dx', 'drop_shadow_dx', 0),
      dy: dnum('dy', 'drop_shadow_dy', 16),
      color: dstr('color', 'drop_shadow_color', 'black'),
      background: dstr('background', 'drop_shadow_background', 'white'),
      // #134 cornerRadius (0..0.5): round the card corners (to the background color) inside the floating-card
      // subgraph for the true Screen Studio rounded+shadowed card. 0 = square card.
      cornerRadius: Math.min(0.5, Math.max(0, dnum('cornerRadius', 'drop_shadow_corner_radius', 0))),
    };
  }
  // #130 Region filter / censor. Nested {x,y,w,h,filter} object OR flat region_filter_* keys. The region
  // is a normalized 0..1 rectangle (clamped) and `filter` is an OPAQUE ffmpeg filter string (the L090/L111
  // seam). Set only when `filter` is a non-empty string and w,h > 0.
  // #138 Per-region motion: a nested `motion` {toX,toY,start,duration} makes the censor TRACK a moving
  // subject (the render slides crop+overlay from {x,y} to {toX,toY} across the window). Dropped unless
  // duration > 0. Shared by the singular #130 and every #137 list element.
  const parseRegionMotion = (rec: Record<string, unknown> | undefined): RegionFilter['motion'] | undefined => {
    const m = asRecord(rec?.['motion']);
    if (m === undefined) return undefined;
    const dur = asNumber(m['duration']);
    if (dur === undefined || dur <= 0) return undefined;
    const c = (v: number | undefined, d: number) => (v === undefined ? d : Math.min(1, Math.max(0, v)));
    return {
      toX: c(asNumber(m['toX']) ?? asNumber(m['to_x']), 0),
      toY: c(asNumber(m['toY']) ?? asNumber(m['to_y']), 0),
      start: Math.max(0, asNumber(m['start']) ?? 0),
      duration: dur,
    };
  };
  // #139 Keyframe path: a `path` array of {x,y,at} waypoints the censor traces (piecewise-linear). Each point
  // is clamped (x,y in 0..1, at >= 0); kept only when >= 2 valid points remain, and sorted by `at`.
  const parseRegionPath = (rec: Record<string, unknown> | undefined): RegionFilter['path'] | undefined => {
    const arr = rec?.['path'];
    if (!Array.isArray(arr)) return undefined;
    const c01 = (v: number | undefined, d: number) => (v === undefined ? d : Math.min(1, Math.max(0, v)));
    const pts = arr
      .map((p) => asRecord(p))
      .filter((p): p is Record<string, unknown> => p !== undefined)
      .map((p) => ({ x: c01(asNumber(p['x']), 0), y: c01(asNumber(p['y']), 0), at: Math.max(0, asNumber(p['at']) ?? 0) }))
      .sort((a, b) => a.at - b.at);
    return pts.length >= 2 ? pts : undefined;
  };
  // #140 Ease: 'smooth' | 'in' | 'out' shape the motion/path interpolation; 'linear'/absent = constant speed.
  const parseRegionEase = (rec: Record<string, unknown> | undefined): RegionFilter['ease'] | undefined => {
    const e = asString(rec?.['ease']);
    return e === 'smooth' || e === 'in' || e === 'out' ? e : undefined;
  };
  // #141 Fade: {in,out} seconds ramping the censor opacity up at the start / down before the end. Kept only
  // when at least one positive value is present.
  const parseRegionFade = (rec: Record<string, unknown> | undefined): RegionFilter['fade'] | undefined => {
    const f = asRecord(rec?.['fade']);
    if (f === undefined) return undefined;
    const pos = (v: unknown) => { const n = asNumber(v); return n !== undefined && n > 0 ? n : undefined; };
    const inS = pos(f['in']); const outS = pos(f['out']);
    if (inS === undefined && outS === undefined) return undefined;
    return { ...(inS !== undefined ? { in: inS } : {}), ...(outS !== undefined ? { out: outS } : {}) };
  };
  // #142 Mode: 'outside' spotlights (filter everything except the region); anything else = default 'inside'.
  const parseRegionMode = (rec: Record<string, unknown> | undefined): RegionFilter['mode'] | undefined =>
    (asString(rec?.['mode']) === 'outside' ? 'outside' : undefined);
  const regf = asRecord(params['regionFilter']) ?? asRecord(params['region_filter']);
  if (regf !== undefined || str('region_filter') !== undefined) {
    const c01 = (v: number | undefined, d: number) => (v === undefined ? d : Math.min(1, Math.max(0, v)));
    const rfFilter = (regf ? asString(regf['filter']) : (str('region_filter') ?? str('region_filter_filter'))) ?? '';
    const rfW = c01(regf ? asNumber(regf['w']) : num('region_filter_w'), 0);
    const rfH = c01(regf ? asNumber(regf['h']) : num('region_filter_h'), 0);
    if (rfFilter.trim() && rfW > 0 && rfH > 0) {
      const motion = parseRegionMotion(regf);
      const path = parseRegionPath(regf);
      const ease = (motion || path) ? parseRegionEase(regf) : undefined;
      const fade = parseRegionFade(regf);
      const mode = parseRegionMode(regf);
      t.regionFilter = {
        x: c01(regf ? asNumber(regf['x']) : num('region_filter_x'), 0),
        y: c01(regf ? asNumber(regf['y']) : num('region_filter_y'), 0),
        w: rfW,
        h: rfH,
        filter: rfFilter.trim(),
        ...(motion ? { motion } : {}),
        ...(path ? { path } : {}),
        ...(ease ? { ease } : {}),
        ...(fade ? { fade } : {}),
        ...(mode ? { mode } : {}),
      };
    }
  }
  // #137 Multiple region filters -- the L069 list generalization of #130. `regionFilters`/`region_filters`
  // is an array of {x,y,w,h,filter}; each element is validated + clamped exactly like the singular, and only
  // the valid ones survive. n=1 is just the singular; the render composites [regionFilter, ...regionFilters].
  const regfArr = params['regionFilters'] ?? params['region_filters'];
  if (Array.isArray(regfArr)) {
    const c01 = (v: number | undefined, d: number) => (v === undefined ? d : Math.min(1, Math.max(0, v)));
    const list = regfArr
      .map((el) => asRecord(el))
      .filter((el): el is Record<string, unknown> => el !== undefined)
      .map((el) => {
        const motion = parseRegionMotion(el);
        const path = parseRegionPath(el);
        const ease = (motion || path) ? parseRegionEase(el) : undefined;
        const fade = parseRegionFade(el);
        const mode = parseRegionMode(el);
        return {
          x: c01(asNumber(el['x']), 0),
          y: c01(asNumber(el['y']), 0),
          w: c01(asNumber(el['w']), 0),
          h: c01(asNumber(el['h']), 0),
          filter: (asString(el['filter']) ?? '').trim(),
          ...(motion ? { motion } : {}),
          ...(path ? { path } : {}),
          ...(ease ? { ease } : {}),
          ...(fade ? { fade } : {}),
          ...(mode ? { mode } : {}),
        };
      })
      .filter((el) => el.filter && el.w > 0 && el.h > 0);
    if (list.length > 0) t.regionFilters = list;
  }
  // #143 Animated progress bar. Nested {height,color,edge} object OR flat progress_bar_* keys. height is a
  // fraction of the frame height (clamped 0..1); dropped unless height > 0. edge defaults to 'bottom'.
  const pbRec = asRecord(params['progressBar']) ?? asRecord(params['progress_bar']);
  if (pbRec !== undefined || num('progress_bar_height') !== undefined) {
    const c01 = (v: number | undefined, d: number) => (v === undefined ? d : Math.min(1, Math.max(0, v)));
    const pbH = c01(pbRec ? asNumber(pbRec['height']) : num('progress_bar_height'), 0);
    if (pbH > 0) {
      const edge = (pbRec ? asString(pbRec['edge']) : str('progress_bar_edge')) === 'top' ? 'top' : 'bottom';
      // #145 Chapter markers: normalized 0..1 tick positions on the bar (dropped empty), drawn in markerColor.
      const mkArr = pbRec ? pbRec['markers'] : undefined;
      const markers = Array.isArray(mkArr)
        ? mkArr.map((m) => asNumber(m)).filter((m): m is number => m !== undefined).map((m) => Math.min(1, Math.max(0, m)))
        : [];
      t.progressBar = {
        height: pbH,
        color: (pbRec ? asString(pbRec['color']) : str('progress_bar_color')) ?? 'white',
        edge,
        ...(markers.length > 0 ? { markers } : {}),
        ...(markers.length > 0 ? { markerColor: (pbRec ? asString(pbRec['markerColor']) : str('progress_bar_marker_color')) ?? 'black' } : {}),
      };
    }
  }
  // #144 Live timer. Nested {mode,corner,size,color} object OR flat timer_* keys. Dropped unless mode is a
  // known value ('elapsed' | 'countdown'); corner defaults to top-right.
  const tmRec = asRecord(params['timer']) ?? asRecord(params['timer_config']);
  const tmMode = (tmRec ? asString(tmRec['mode']) : str('timer_mode'));
  if (tmMode === 'elapsed' || tmMode === 'countdown') {
    const cornerRaw = (tmRec ? asString(tmRec['corner']) : str('timer_corner'));
    const corner = cornerRaw === 'tl' || cornerRaw === 'tr' || cornerRaw === 'bl' || cornerRaw === 'br' ? cornerRaw : 'tr';
    const sizeRaw = tmRec ? asNumber(tmRec['size']) : num('timer_size');
    t.timer = {
      mode: tmMode,
      corner,
      ...(sizeRaw !== undefined && sizeRaw > 0 ? { size: sizeRaw } : {}),
      color: (tmRec ? asString(tmRec['color']) : str('timer_color')) ?? 'white',
    };
  }
  // #147 Countdown ring: nested {radius,thickness,color,x,y,mode} (aliases countdown_ring/countdownRing/ring).
  // Presence turns it on (all fields default in the render); mode clamped to fill/deplete (default deplete).
  const crRec = asRecord(params['countdown_ring']) ?? asRecord(params['countdownRing']) ?? asRecord(params['ring']);
  if (crRec) {
    const out: NonNullable<ClipTransform['countdownRing']> = {};
    const rad = asNumber(crRec['radius']); if (rad !== undefined && rad > 0) out.radius = rad;
    const th = asNumber(crRec['thickness']); if (th !== undefined && th > 0) out.thickness = th;
    const col = asString(crRec['color']); if (col !== undefined) out.color = col;
    const cxv = asNumber(crRec['x']); if (cxv !== undefined) out.x = cxv;
    const cyv = asNumber(crRec['y']); if (cyv !== undefined) out.y = cyv;
    const md = crRec['mode']; if (md === 'fill' || md === 'deplete') out.mode = md;
    t.countdownRing = out;
  }
  // #148 Marker-synced flashes (beat pulses): array under `pulses`/`flashes`/`beats`; each item {at|t, strength?,
  // duration?}. Keeps only finite `at`; strength clamped 0..1 (default handled by render), duration>0. Empty dropped.
  const pulsesRaw = params['pulses'] ?? params['flashes'] ?? params['beats'];
  if (Array.isArray(pulsesRaw)) {
    const pulses: NonNullable<ClipTransform['pulses']> = [];
    for (const p of pulsesRaw) {
      const pr = asRecord(p);
      const at = pr ? (asNumber(pr['at']) ?? asNumber(pr['t'])) : undefined;
      if (pr && at !== undefined) {
        const pulse: { at: number; strength?: number; duration?: number; kind?: 'flash' | 'punch' | 'shake' | 'glitch' | 'tint'; color?: string } = { at };
        const s = asNumber(pr['strength']); if (s !== undefined) pulse.strength = Math.min(1, Math.max(0, s));
        const d = asNumber(pr['duration']); if (d !== undefined && d > 0) pulse.duration = d;
        const k = pr['kind']; if (k === 'flash' || k === 'punch' || k === 'shake' || k === 'glitch' || k === 'tint') pulse.kind = k;
        // #166 tint pulses carry a color the render blends the frame toward on the beat. Kept as free-text
        // DATA; the render resolves it to safe RGB ints (colorToRgb255). Ignored by non-tint kinds.
        const c = asString(pr['color']); if (c !== undefined && c.trim()) pulse.color = c.trim();
        pulses.push(pulse);
      }
    }
    if (pulses.length) t.pulses = pulses;
  }
  // #149 Letterbox / cinematic bars: `letterbox` boolean true (default 2.39) OR {aspect, color}. aspect from a
  // number or a "w:h" string; color a name/hex. Presence turns it on (bars computed from the frame at render).
  const lbRaw = params['letterbox'];
  if (lbRaw === true) {
    t.letterbox = {};
  } else {
    const lb = asRecord(lbRaw);
    if (lb) {
      const out: NonNullable<ClipTransform['letterbox']> = {};
      let ar = asNumber(lb['aspect']);
      if (ar === undefined) {
        const s = asString(lb['aspect']);
        if (s && s.includes(':')) { const [w, h] = s.split(':').map(Number); if (w > 0 && h > 0) ar = w / h; }
      }
      if (ar !== undefined && ar > 0) out.aspect = ar;
      const c = asString(lb['color']); if (c !== undefined) out.color = c;
      t.letterbox = out;
    }
  }
  // #152 Gradient scrim: {edge, strength, color}. edge clamped to top/bottom/left/right; strength 0..1; color a
  // name/hex. Presence turns it on (defaults handled by the render). A boolean true is the plain-default scrim.
  const scRaw = params['scrim'];
  if (scRaw === true) {
    t.scrim = {};
  } else {
    const sc = asRecord(scRaw);
    if (sc) {
      const out: NonNullable<ClipTransform['scrim']> = {};
      const e = sc['edge'];
      if (e === 'top' || e === 'bottom' || e === 'left' || e === 'right') out.edge = e;
      const s = asNumber(sc['strength']); if (s !== undefined) out.strength = Math.min(1, Math.max(0, s));
      const c = asString(sc['color']); if (c !== undefined) out.color = c;
      t.scrim = out;
    }
  }
  // #153 Highlight sweep: a translucent box over a normalized {x,y,w,h} region that wipes over [start,
  // start+duration]. Requires finite x,y,w,h with w,h>0; color/opacity/start/duration optional. Singular
  // `highlight` + list `highlights`; both parsed by the same reader.
  const parseHighlight = (rec: Record<string, unknown> | null) => {
    if (!rec) return undefined;
    const x = asNumber(rec['x']); const y = asNumber(rec['y']); const w = asNumber(rec['w']); const h = asNumber(rec['h']);
    if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return undefined;
    const out: NonNullable<ClipTransform['highlightSweep']> = { x, y, w, h };
    const c = asString(rec['color']); if (c !== undefined) out.color = c;
    const op = asNumber(rec['opacity']); if (op !== undefined) out.opacity = Math.min(1, Math.max(0, op));
    const st = asNumber(rec['start']); if (st !== undefined && st >= 0) out.start = st;
    const du = asNumber(rec['duration']); if (du !== undefined && du > 0) out.duration = du;
    return out;
  };
  const hl = parseHighlight(asRecord(params['highlightSweep']) ?? asRecord(params['highlight_sweep']));
  if (hl) t.highlightSweep = hl;
  const hlList = params['highlightSweeps'] ?? params['highlight_sweeps'];
  if (Array.isArray(hlList)) {
    const hls = hlList.map((p) => parseHighlight(asRecord(p))).filter((p): p is NonNullable<ClipTransform['highlightSweep']> => p !== undefined);
    if (hls.length) t.highlightSweeps = hls;
  }
  // #131 Ellipse / circle mask. Nested {cx,cy,rx,ry,background} object OR flat ellipse_mask_* keys. cx/cy
  // are the normalized 0..1 center (default 0.5), rx/ry the normalized radii; only set when rx,ry > 0.
  const em = asRecord(params['ellipseMask']) ?? asRecord(params['ellipse_mask']);
  const emFlat = Object.keys(params).some((k) => k.startsWith('ellipse_mask_') || k.startsWith('ellipseMask'));
  if (em !== undefined || emFlat) {
    const c01 = (v: number | undefined, d: number) => (v === undefined ? d : Math.min(1, Math.max(0, v)));
    const emRx = c01(em ? asNumber(em['rx']) : num('ellipse_mask_rx'), 0);
    const emRy = c01(em ? asNumber(em['ry']) : num('ellipse_mask_ry'), 0);
    if (emRx > 0 && emRy > 0) {
      t.ellipseMask = {
        cx: c01(em ? asNumber(em['cx']) : num('ellipse_mask_cx'), 0.5),
        cy: c01(em ? asNumber(em['cy']) : num('ellipse_mask_cy'), 0.5),
        rx: emRx,
        ry: emRy,
        background: (em ? asString(em['background']) : str('ellipse_mask_background')) ?? 'black',
        feather: c01(em ? asNumber(em['feather']) : (num('ellipse_mask_feather') ?? num('ellipseMaskFeather')), 0),
      };
      // #135 Animated iris reveal. Nested `reveal` object OR flat ellipse_mask_reveal_* keys. duration > 0
      // turns it on; the radii scale by a time factor ramping from->to over [start, start+duration] seconds.
      const rev = asRecord(em?.['reveal']);
      const revDur = rev ? asNumber(rev['duration']) : num('ellipse_mask_reveal_duration');
      if (revDur !== undefined && revDur > 0) {
        const rnum = (k1: string, k2: string, d: number) => {
          const v = rev ? asNumber(rev[k1]) : num(k2);
          return v === undefined ? d : v;
        };
        t.ellipseMask.reveal = {
          from: Math.max(0, rnum('from', 'ellipse_mask_reveal_from', 0)),
          to: Math.max(0, rnum('to', 'ellipse_mask_reveal_to', 1)),
          start: Math.max(0, rnum('start', 'ellipse_mask_reveal_start', 0)),
          duration: revDur,
        };
      }
    }
  }
  // #136 Split-tone color grade. Nested {shadows,mids,highlights} each {r,g,b} in -1..1. Only set when at
  // least one channel is nonzero (the render maps it to ffmpeg colorbalance).
  const stRec = asRecord(params['splitTone']) ?? asRecord(params['split_tone']);
  if (stRec !== undefined) {
    const cn = (v: unknown) => {
      const n = asNumber(v);
      return n === undefined ? 0 : Math.min(1, Math.max(-1, n));
    };
    const band = (key: string) => {
      const b = asRecord(stRec[key]);
      return { r: cn(b?.['r']), g: cn(b?.['g']), b: cn(b?.['b']) };
    };
    const st = { shadows: band('shadows'), mids: band('mids'), highlights: band('highlights') };
    const any = [st.shadows, st.mids, st.highlights].some((c) => c.r !== 0 || c.g !== 0 || c.b !== 0);
    if (any) t.splitTone = st;
  }
  // #89 Loop / boomerang. `loop_count` repeats the clip; `loop_boomerang` reverses odd repeats.
  const loopCount = num('loop_count') ?? num('loopCount');
  if (loopCount !== undefined && loopCount > 1) t.loopCount = Math.floor(loopCount);
  const loopBoomerang = params['loop_boomerang'] ?? params['loopBoomerang'];
  if (typeof loopBoomerang === 'boolean') t.loopBoomerang = loopBoomerang;
  // #93 Loudness normalization target (integrated LUFS).
  const loudnorm = num('loudnorm') ?? num('loudness_lufs') ?? num('target_lufs');
  if (loudnorm !== undefined) t.loudnorm = loudnorm;
  // #202 Echo / reverb: nested {amount, delayMs?} OR flat echo_amount / echo_delay_ms OR bare echo:<number>
  // (= amount). Enabled only when amount > 0; amount clamp 0..1, delayMs clamp 20..1000 ms. Blind DATA (L090).
  const echoRec = asRecord(params['echo']);
  const echoBare = typeof params['echo'] === 'number' ? (params['echo'] as number) : undefined;
  const echoAmount = echoRec ? asNumber(echoRec['amount']) : (num('echo_amount') ?? num('echoAmount') ?? echoBare);
  if (echoAmount !== undefined && echoAmount > 0) {
    const e: { amount: number; delayMs?: number } = { amount: Math.min(1, Math.max(0, echoAmount)) };
    const echoDelay = echoRec ? asNumber(echoRec['delayMs']) : (num('echo_delay_ms') ?? num('echoDelayMs'));
    if (echoDelay !== undefined) e.delayMs = Math.min(1000, Math.max(20, echoDelay));
    t.echo = e;
  }
  // In-transition (blend from the previous clip). `transition_type` empty/'none' clears it.
  const transitionType = str('transition_type');
  if (transitionType !== undefined) {
    t.transition = (transitionType && transitionType !== 'none')
      ? { renderer: str('transition_renderer') ?? 'xfade', type: transitionType, duration: num('transition_duration') ?? 0.5 }
      : {};
  }
  // Caption: `caption_text` sets the burned caption; empty string clears it.
  // Position is the normalized {x,y} primitive (`caption_x`/`caption_y`, 0..1).
  // A legacy `caption_corner` maps to an {x,y} preset so old DATA still renders,
  // but the surface only ever writes x/y — there is no corner branch downstream.
  const captionText = str('caption_text') ?? str('captionText');
  if (captionText !== undefined) {
    if (!captionText.trim()) {
      t.caption = { text: '' };
    } else {
      const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
      let cx = num('caption_x');
      let cy = num('caption_y');
      const legacyCorner = str('caption_corner');
      if ((cx === undefined || cy === undefined) && legacyCorner) {
        const preset = LEGACY_CORNER_XY[legacyCorner];
        if (preset) { cx = cx ?? preset.x; cy = cy ?? preset.y; }
      }
      t.caption = {
        text: captionText,
        ...(cx !== undefined ? { x: clamp01(cx) } : {}),
        ...(cy !== undefined ? { y: clamp01(cy) } : {}),
        ...(num('caption_size') !== undefined ? { size: num('caption_size') } : {}),
        ...(str('caption_color') !== undefined ? { color: str('caption_color') } : {}),
      };
    }
  }
  return t;
}

/**
 * #90 Translate captions: set the composition-wide `captionTranslate` default the render applies to
 * every burned text. `to` is any BCP-47 language code (DATA), `producer` names the translation engine
 * (DATA, e.g. glossary / argos / an AI provider), optional inline `glossary`. An empty/absent `to`
 * CLEARS translation (captions render as authored). Languages and engines are DATA; adding either is
 * a data row, never a code branch (L069 enum-dissolution).
 */
function foldTranslateCaptions(state: FoldState, decision: EditDecision): FoldState {
  const params = decision.parameters ?? {};
  const to = asString(params['to']) ?? asString(params['target_lang']) ?? asString(params['language']);
  if (!to) return { ...state, captionTranslate: undefined };
  const producer = asString(params['producer']) ?? 'glossary';
  const glossary = asRecord(params['glossary']) as Record<string, string> | undefined;
  return { ...state, captionTranslate: { to, producer, ...(glossary ? { glossary } : {}) } };
}

/** #93 Set the master-bus loudness normalization target (integrated LUFS) for the finished program.
 *  An empty/absent target clears it. The number is DATA; the render runs ffmpeg loudnorm on the mix. */
function foldSetMasterLoudness(state: FoldState, decision: EditDecision): FoldState {
  const params = decision.parameters ?? {};
  const lufs = asNumber(params['lufs']) ?? asNumber(params['loudnorm']) ?? asNumber(params['target_lufs']);
  return { ...state, masterLoudnorm: lufs };
}

// Dispatch table: adding a new action = one entry here, zero elsewhere.

const FOLD_ACTIONS: Record<string, FoldFn> = {
  'add-overlay': (state, decision) => foldAddOverlay(state, decision),
  'translate-captions': (state, decision) => foldTranslateCaptions(state, decision),
  'set-master-loudness': (state, decision) => foldSetMasterLoudness(state, decision),
  'add-captions': (state, decision) => foldAddCaptions(state, decision),
  'split': (state, decision) => foldSplit(state, decision),
  'trim': (state, decision) => foldTrim(state, decision),
  'ripple-trim': (state, decision) => foldRippleTrim(state, decision),
  'close-gaps': (state, decision) => foldCloseGaps(state, decision),
  'detach-audio': (state, decision) => foldDetachAudio(state, decision),
  'move': (state, decision) => foldMove(state, decision),
  'delete': (state, decision) => foldDelete(state, decision),
  'remove-span': (state, decision) => foldRemoveSpan(state, decision),
  'set-transform': (state, decision) => foldSetTransform(state, decision),
  'add-source': (state, decision, index) => foldAddSource(state, decision, index),
  'editor.layers.adjustment': (state, decision, index) => foldAdjustmentLayer(state, decision, index),
  'editor.captions.position': (state, decision) => foldCaptionPosition(state, decision),
  'add-track': (state, decision) => foldAddTrack(state, decision),
  'save-edit': (state, decision) => foldSaveEdit(state, decision),
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Pure fold: derives a MaterializedComposition from a MediaWorkspaceView.
 *
 * SSOT: the ordered editDecisions in the view are the single source of truth.
 * The composition is fully derived — never stored separately, never mutated.
 */
/**
 * Fixed rendering palette (a set of distinct colors), NOT domain vocabulary. The
 * *mapping* of a lane to one of these is data; the palette itself is a primitive.
 */
/**
 * Default role→tone seed. Society DATA living at the translation boundary, exactly like
 * role labels — a starting configuration, never physics, and overridable per-lane. It is
 * an EXACT-match map, not fuzzy keyword guessing: that is what lets any new role be
 * configured freely instead of being silently captured by an `includes('audio')` rule.
 */
const DEFAULT_ROLE_TONE = labelLookup(LANE_TONE_DESCRIPTORS);

/** Deterministic, role-stable palette slot for any role the defaults do not cover. */
function fallbackTone(role: string): string {
  let hash = 0;
  for (let i = 0; i < role.length; i += 1) hash = (Math.imul(hash, 31) + role.charCodeAt(i)) >>> 0;
  return TONE_PALETTE[hash % TONE_PALETTE.length];
}

/**
 * Resolve a lane's tone as DATA: an explicit lane-declared tone wins; else the default
 * seed; else a stable hash slot. No role-keyword matching ever happens in the renderer.
 */
function resolveLaneTone(role: string, declared?: string): string {
  if (declared && (TONE_PALETTE as readonly string[]).includes(declared)) return declared;
  return DEFAULT_ROLE_TONE.get(role.toLowerCase()) ?? fallbackTone(role);
}

// Roles that are METADATA, not media TRACKS. Their records drive folding (an
// add-source decision, a selection, a marker) or belong to analysis surfaces;
// they must never render as a timeline lane. Real tracks are the media roles
// (recorded_files / source_files) plus the video-*/audio-*/image-*/text-* lanes
// the fold creates. This is Society DATA at the translation boundary, the exact
// sibling of DEFAULT_ROLE_TONE, so a new metadata role is one row, not a branch.
const NON_TRACK_ROLES: ReadonlySet<string> = new Set([
  'edit_decisions', 'selections', 'markers', 'config', 'blockers',
  'results', 'chapters', 'claims', 'phases', 'alignments', 'clusters',
  'matches', 'plans', 'render_manifests', 'handoffs', 'intents', 'workspaces',
]);

export function composeTimeline(view: MediaWorkspaceView): MaterializedComposition {
  // ── Step 1: build initial state from sources + lanes ────────────────────────
  const initialState: FoldState = {
    lanes: new Map(),
    laneOrder: [],
    laneMeta: new Map(),
    globalTransform: {},
    overlays: [],
  };

  let state = view.lanes.reduce<FoldState>((acc, lane) => {
    // Skip metadata roles: they are consumed by the fold (edit_decisions,
    // selections, markers) or are analysis rows, never a media track lane.
    if (NON_TRACK_ROLES.has(lane.role)) return acc;
    const clips: MaterializedClip[] = [];
    let cursor = 0;

    for (const item of lane.items) {
      const clip = baseClipFromItem(item, lane.role, cursor);
      clips.push(clip);
      cursor = clip.laneEnd;
    }

    const lanes = new Map(acc.lanes);
    lanes.set(lane.lane_id, clips);

    const laneMeta = new Map(acc.laneMeta);
    laneMeta.set(lane.lane_id, { role: lane.role, label: lane.label, tone: asString((lane as { tone?: unknown }).tone) });

    return {
      ...acc,
      lanes,
      laneOrder: [...acc.laneOrder, lane.lane_id],
      laneMeta,
    };
  }, initialState);

  // ── Step 2: sort decisions by created_at (ISO string sort = chronological) ──
  const ordered = [...view.editDecisions].sort((a, b) => {
    const ta = a.created_at ?? '';
    const tb = b.created_at ?? '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  // ── Step 3: fold each decision into state ────────────────────────────────────
  for (let i = 0; i < ordered.length; i++) {
    const decision = ordered[i];
    const action = decision.action ?? '';
    const fold = FOLD_ACTIONS[action];
    if (fold) {
      state = fold(state, decision, i);
    }
    // Unknown action: no-op, never throw
  }

  // ── Step 4: materialise output ───────────────────────────────────────────────
  const materializedLanes: MaterializedLane[] = state.laneOrder
    .filter((laneId) => state.lanes.has(laneId))
    .map((laneId) => {
      const clips = state.lanes.get(laneId) ?? [];
      const meta = state.laneMeta.get(laneId) ?? { role: laneId, label: laneId };
      const duration = clips.length > 0 ? Math.max(...clips.map((c) => c.laneEnd)) : 0;
      return { laneId, role: meta.role, label: meta.label, tone: resolveLaneTone(meta.role, meta.tone), clips, duration };
    });

  const durationSeconds = materializedLanes.length > 0
    ? Math.max(...materializedLanes.map((l) => l.duration))
    : 0;

  const markers = view.markers.map((m, i) => ({
    id: m.marker_id ?? `marker:${i}`,
    label: m.label ?? '',
    time: m.time ?? 0,
  }));

  return {
    lanes: materializedLanes,
    durationSeconds,
    markers,
    globalTransform: state.globalTransform,
    overlays: state.overlays,
    captionTranslate: state.captionTranslate,
    masterLoudnorm: state.masterLoudnorm,
  };
}
