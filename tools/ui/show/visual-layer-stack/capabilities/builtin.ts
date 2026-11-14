// packages/ui/show/visual-layer-stack/capabilities/builtin.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The built-in visual-layer capability pack: binds today's visual kinds to a
// `capabilityId` each, reusing existing leaf primitives. Every capability
// renders its OWN element kind (Pattern 103 sibling-consumption) and is blind to
// every other capability. The generic renderer (VisualLayerStack) never imports
// this — the OWNER composes it in via `createCapabilityMap({ ...builtinVisualLayerCapabilities, ...own })`.
//
// capabilityId -> leaf:
//   solid             -> styled <div> (color DATA)
//   gradient          -> styled <div> (css gradient DATA)
//   image             -> ImageBlock (cover/contain/fill/none) or tiled <div>
//   media             -> background <video> (muted/looping/cover) for video/*
//   pattern.dot-grid  -> CanvasDotGrid (consumes ctx.camera → parallax)
//   effect.blur       -> styled <div> (backdrop blur radius DATA)
//   effect.sound      -> SoundLayer (a look moving with the sound; lights follow; capabilities/sound.ts)
//
// New kinds (shader, live-package, …) are NEW entries elsewhere — never edits here.
//
// NON-NEGOTIABLE: raw <video>/<img> are legal ONLY because this is a ui/ leaf.
// =============================================================================

import React from 'react';
import { ImageBlock } from '../../image-block/ImageBlock';
import { CanvasDotGrid } from '../../canvas-dot-grid/CanvasDotGrid';
import { Button } from '../../button/Button';
import { Text } from '../../text/Text';
import { Inline } from '../../inline/Inline';
import { Input } from '../../input/Input';
import { composeMeshBackground, readMeshValue } from '../../mesh-editor/mesh-value';
import type { VisualLayerCapability, VisualLayerRenderContext } from '../visual-layer-registry';
import { effectSound } from './sound';
import { later } from '../../load-later/later';
import type { AddressRef, VisualLayerDescriptor } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';

// Editors arrive when a layer is first opened to change it (../../load-later/later.ts); renders draw from the first paint.
const ColorWheel = later(() => import('../../color-wheel/ColorWheel'), module => module.ColorWheel);
const Slider = later(() => import('../../slider/Slider'), module => module.Slider);
const GradientEditor = later(() => import('../../gradient-editor/GradientEditor'), module => module.GradientEditor);
const MeshEditor = later(() => import('../../mesh-editor/MeshEditor'), module => module.MeshEditor);

function isAddressRef(value: unknown): value is AddressRef {
  return !!value && typeof value === 'object' && typeof (value as AddressRef).family === 'string';
}

/** Resolve a layer's source URL from `input.url` or an addressed subject. */
function subjectUrl(ctx: VisualLayerRenderContext, input: Record<string, unknown>): string | null {
  if (typeof input.url === 'string') return input.url;
  if (isAddressRef(input.subject)) {
    const resolved = ctx.resolveSubject(input.subject);
    if (typeof resolved === 'string') return resolved;
    if (resolved && typeof (resolved as { url?: unknown }).url === 'string') return (resolved as { url: string }).url;
  }
  return null;
}

function contentType(descriptor: VisualLayerDescriptor): string {
  return String(descriptor.paint.input.contentType ?? '').toLowerCase();
}

const solid: VisualLayerCapability = {
  presentation: { label: 'Color', icon: 'Palette' },
  addAffordance: { order: 10, defaultZ: -1, defaultInput: { color: '#1e1e1e' } },
  editor: ({ input, patchInput }) =>
    React.createElement(ColorWheel, {
      value: typeof input.color === 'string' ? input.color : '#1e1e1e',
      onChange: (hex: string) => patchInput({ color: hex }),
      size: 180,
    }),
  render: ({ descriptor }) =>
    React.createElement('div', {
      className: 'h-full w-full',
      style: { background: String(descriptor.paint.input.color ?? 'transparent') },
    }),
  resolveCssPaint: ({ input }) => ({ background: String(input.color ?? 'transparent') }),
};

const gradient: VisualLayerCapability = {
  presentation: { label: 'Gradient', icon: 'Blend' },
  // Maximally-capable default (L083): a real gradient. Input carries BOTH the
  // structured fields (gradientType/angle/stops) the editor edits AND the composed
  // `css` the render reads — so the editor never parses css back.
  addAffordance: {
    order: 20,
    defaultZ: -1,
    defaultInput: {
      gradientType: 'linear',
      angle: 135,
      stops: [{ color: '#3b82f6', pos: 0 }, { color: '#8b5cf6', pos: 100 }],
      css: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
    },
  },
  // F4: the gradient capability now OWNS its editor (type/angle/stops → css). It
  // dropped in with ZERO change to the panel or the Add menu — the F2 mechanism.
  editor: ({ input, patchInput }) => React.createElement(GradientEditor, { input, onPatch: patchInput }),
  render: ({ descriptor }) =>
    React.createElement('div', {
      className: 'h-full w-full',
      // `css` is an arbitrary CSS background-image value (any gradient) — DATA.
      style: { backgroundImage: String(descriptor.paint.input.css ?? 'none') },
    }),
  resolveCssPaint: ({ input }) => ({ backgroundImage: String(input.css ?? 'none') }),
};

const image: VisualLayerCapability = {
  presentation: { label: 'Image', icon: 'Image' },
  addAffordance: { order: 30, defaultZ: -1, requiresSubject: true, subjectPrefixes: ['image/'] },
  accepts: (d) => contentType(d).startsWith('image/'),
  render: (ctx) => {
    const input = ctx.descriptor.paint.input;
    const url = subjectUrl(ctx, input);
    if (!url) return null;
    const fit = String(input.fit ?? 'cover');
    if (fit === 'tile') {
      return React.createElement('div', {
        className: 'h-full w-full',
        style: {
          backgroundImage: `url("${url}")`,
          backgroundRepeat: 'repeat',
          backgroundSize: typeof input.tileSize === 'string' ? input.tileSize : 'auto',
        },
      });
    }
    return React.createElement(ImageBlock, {
      src: url,
      objectFit: (fit === 'contain' || fit === 'fill' || fit === 'none' ? fit : 'cover') as 'contain' | 'cover' | 'fill' | 'none',
      width: 'full',
      rounded: 'none',
      className: 'h-full w-full',
      alt: String(input.label ?? ''),
      draggable: false,
    });
  },
};

const media: VisualLayerCapability = {
  presentation: { label: 'Video', icon: 'Film' },
  addAffordance: { order: 31, defaultZ: -1, requiresSubject: true, subjectPrefixes: ['video/', 'audio/'] },
  accepts: (d) => contentType(d).startsWith('video/') || contentType(d).startsWith('audio/'),
  render: (ctx) => {
    const input = ctx.descriptor.paint.input;
    const url = subjectUrl(ctx, input);
    if (!url) return null;
    // Background media: no controls; muted+looping so it just plays as wallpaper.
    return React.createElement('video', {
      src: url,
      autoPlay: input.autoPlay !== false,
      muted: input.muted !== false,
      loop: input.loop !== false,
      playsInline: true,
      className: 'h-full w-full object-cover',
      'aria-hidden': true,
    });
  },
};

const patternDotGrid: VisualLayerCapability = {
  presentation: { label: 'Dot grid', icon: 'Grid3x3' },
  addAffordance: { order: 50, defaultZ: -1, defaultInput: {} },
  render: ({ descriptor, camera }) => {
    const input = descriptor.paint.input;
    return React.createElement(CanvasDotGrid, {
      panX: camera?.panX ?? 0,
      panY: camera?.panY ?? 0,
      zoom: camera?.zoom ?? 1,
      spacing: typeof input.spacing === 'number' ? input.spacing : undefined,
      dotSize: typeof input.dotSize === 'number' ? input.dotSize : undefined,
    });
  },
};

// effect.grain — film-grain noise overlay. An SVG fractal-noise data URI is the
// crispest cross-browser grain; `amount` is the layer opacity (caller normally
// sets composite.opacity instead, but amount is honored as a fallback) and the
// noise frequency/blend are DATA. This is a LAYER (paints its own element), so
// the renderer needs zero filter-consumption code.
function grainDataUri(frequency: number): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg'>` +
    `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${frequency}' numOctaves='2' stitchTiles='stitch'/></filter>` +
    `<rect width='100%' height='100%' filter='url(%23n)'/></svg>`;
  return `url("data:image/svg+xml,${svg.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23')}")`;
}

const effectGrain: VisualLayerCapability = {
  presentation: { label: 'Grain', icon: 'Sparkles' },
  addAffordance: { order: 60, defaultZ: 1, defaultInput: { amount: 0.4 } },
  editor: ({ input, patchInput }) =>
    React.createElement(Slider, {
      value: typeof input.amount === 'number' ? input.amount : 0.4,
      min: 0,
      max: 1,
      step: 0.01,
      onValueChange: (amount: number) => patchInput({ amount }),
    }),
  render: ({ descriptor }) => {
    const input = descriptor.paint.input;
    const frequency = typeof input.frequency === 'number' ? input.frequency : 0.85;
    const amount = typeof input.amount === 'number' ? input.amount : 1;
    return React.createElement('div', {
      className: 'h-full w-full',
      style: {
        backgroundImage: grainDataUri(frequency),
        opacity: amount,
        mixBlendMode: (typeof input.blend === 'string' ? input.blend : 'overlay') as React.CSSProperties['mixBlendMode'],
      },
    });
  },
  resolveCssPaint: ({ input }) => ({
    backgroundImage: grainDataUri(typeof input.frequency === 'number' ? input.frequency : 0.85),
    opacity: typeof input.amount === 'number' ? input.amount : 1,
    mixBlendMode: (typeof input.blend === 'string' ? input.blend : 'overlay') as React.CSSProperties['mixBlendMode'],
  }),
};

// effect.tint — a flat color wash over the layers beneath it (color + blend +
// opacity all DATA). Lets a node be "darkened/warmed" without touching the
// background image itself.
const effectTint: VisualLayerCapability = {
  presentation: { label: 'Tint', icon: 'Droplet' },
  addAffordance: { order: 61, defaultZ: 1, defaultInput: { color: '#000000', amount: 0.3 } },
  editor: ({ input, patchInput }) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ColorWheel, {
        value: typeof input.color === 'string' ? input.color : '#000000',
        onChange: (hex: string) => patchInput({ color: hex }),
        size: 160,
      }),
      React.createElement(Slider, {
        value: typeof input.amount === 'number' ? input.amount : 0.3,
        min: 0,
        max: 1,
        step: 0.01,
        onValueChange: (amount: number) => patchInput({ amount }),
      }),
    ),
  render: ({ descriptor }) => {
    const input = descriptor.paint.input;
    return React.createElement('div', {
      className: 'h-full w-full',
      style: {
        background: String(input.color ?? 'transparent'),
        opacity: typeof input.amount === 'number' ? input.amount : 1,
        mixBlendMode: (typeof input.blend === 'string' ? input.blend : 'normal') as React.CSSProperties['mixBlendMode'],
      },
    });
  },
  resolveCssPaint: ({ input }) => ({
    background: String(input.color ?? 'transparent'),
    opacity: typeof input.amount === 'number' ? input.amount : 1,
    mixBlendMode: (typeof input.blend === 'string' ? input.blend : 'normal') as React.CSSProperties['mixBlendMode'],
  }),
};

// effect.blur — frosts whatever is behind the region (the page under a floating
// window's backdrop, the wallpaper under a pane). The radius in pixels is DATA;
// 0 frosts nothing, so a slow device can turn it off without removing the layer.
const blurOf = (input: Record<string, unknown>) => {
  const radius = typeof input.radius === 'number' && input.radius >= 0 ? input.radius : 12;
  return { backdropFilter: `blur(${radius}px)`, WebkitBackdropFilter: `blur(${radius}px)` } as React.CSSProperties;
};
const effectBlur: VisualLayerCapability = {
  presentation: { label: 'Blur', icon: 'Droplets' },
  addAffordance: { order: 62, defaultZ: 0, defaultInput: { radius: 12 } },
  editor: ({ input, patchInput }) =>
    React.createElement(Slider, {
      value: typeof input.radius === 'number' ? input.radius : 12,
      min: 0,
      max: 48,
      step: 1,
      onValueChange: (radius: number) => patchInput({ radius }),
    }),
  render: ({ descriptor }) => React.createElement('div', { className: 'h-full w-full', style: blurOf(descriptor.paint.input) }),
  resolveCssPaint: ({ input }) => blurOf(input),
};

// mesh — a base color with N draggable colored points, each a soft radial blob
// (stacked radial-gradients). F5: it dropped in as ONE registry entry with its
// own render + editor — ZERO change to the panel, Add menu, or renderer.
const mesh: VisualLayerCapability = {
  presentation: { label: 'Mesh', icon: 'Grid2x2' },
  addAffordance: {
    order: 22,
    defaultZ: -1,
    defaultInput: {
      baseColor: '#1e1e2e',
      points: [
        { x: 0, y: 0, color: '#3b82f6' },
        { x: 100, y: 0, color: '#8b5cf6' },
        { x: 100, y: 100, color: '#ec4899' },
        { x: 0, y: 100, color: '#06b6d4' },
      ],
    },
  },
  editor: ({ input, patchInput }) => React.createElement(MeshEditor, { input, onPatch: patchInput }),
  render: ({ descriptor }) => {
    const value = readMeshValue(descriptor.paint.input);
    return React.createElement('div', {
      className: 'h-full w-full',
      style: { backgroundColor: value.baseColor, backgroundImage: composeMeshBackground(value.points) },
    });
  },
  resolveCssPaint: ({ input }) => {
    const value = readMeshValue(input);
    return { backgroundColor: value.baseColor, backgroundImage: composeMeshBackground(value.points) };
  },
};

// =============================================================================
// GEOMETRY / STYLE OPERATORS — a layer's SILHOUETTE and post-paint style are
// data-selected operators resolved by the SAME registry as its paint, then
// merged onto the layer wrapper by the blind renderer (see VisualLayerStack
// `resolveStyleOp`). These capabilities paint NOTHING (`render` absent) — they
// only contribute `resolveStyle`. There is NO named edge ("paper", "scallop",
// "deckle"): an edge is a literal (`shape.raw`) or a config of ONE parametric
// generator (`shape.edge`). "Paper" = DATA composition (fill.color + shape.edge
// + effect.grain). A new aesthetic ("burned", "lace", "glass") is a DATA row,
// ZERO engine code (L063/L069/L090/enum-dissolution).
// =============================================================================

function styleNum(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Deterministic PRNG (mulberry32) — no Math.random at render, so a clip is
 *  stable across re-renders (identity-preserving) for a given seed. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Parametric perimeter clip-path. ALL geometry is `input` DATA:
 *   amplitude — % inward bite depth
 *   frequency — cycles per edge (tooth/scallop count)
 *   noise     — 0 = smooth cosine scallop … 1 = random torn edge
 *   seed      — deterministic variation
 * noise=0 + low frequency = wave; noise=1 + high frequency = ripped paper;
 * frequency≈3 = bevel. rough/scallop/deckle/wave are coordinates in ONE space.
 */
function edgeClipPath(input: Record<string, unknown>): string {
  const amplitude = Math.max(0, styleNum(input.amplitude, 4));
  const frequency = Math.max(1, styleNum(input.frequency, 16));
  const noise = Math.min(1, Math.max(0, styleNum(input.noise, 1)));
  const random = seededRandom(Math.round(styleNum(input.seed, 1) * 1000) || 1);
  const samples = Math.min(240, Math.max(24, Math.round(frequency * 4)));
  const bite = (k: number): number => {
    const wave = (1 - Math.cos(k * Math.PI * 2 * frequency)) / 2; // 0..1 smooth
    return amplitude * (wave * (1 - noise) + random() * noise);
  };
  const pts: string[] = [];
  const pushEdge = (point: (k: number) => [number, number]) => {
    for (let i = 0; i <= samples; i++) {
      const [x, y] = point(i / samples);
      pts.push(`${x.toFixed(2)}% ${y.toFixed(2)}%`);
    }
  };
  pushEdge((k) => [k * 100, bite(k)]);             // top    L→R
  pushEdge((k) => [100 - bite(k), k * 100]);       // right  T→B
  pushEdge((k) => [100 - k * 100, 100 - bite(k)]); // bottom R→L
  pushEdge((k) => [bite(k), 100 - k * 100]);       // left   B→T
  return `polygon(${pts.join(',')})`;
}

/** A labelled Slider row bound to one numeric `input` field (pure presentation). */
function sliderRow(
  field: string,
  input: Record<string, unknown>,
  patchInput: (patch: Record<string, unknown>) => void,
  min: number,
  max: number,
  fallback: number,
): React.ReactElement {
  return React.createElement(Slider, {
    key: field,
    value: styleNum(input[field], fallback),
    min,
    max,
    step: (max - min) / 100,
    onValueChange: (value: number) => patchInput({ [field]: value }),
  });
}

// shape.raw — the -1000IQ maximally-capable default (L083): ANY literal CSS the
// user/AI supplies passes through verbatim. Infinite silhouettes, borders,
// text-strokes, shadows, angles, filters — ALL from a single DATA object, zero
// code per effect. `input.style` is an OPAQUE CSSProperties bag merged whole
// (L090 — the handler never inspects its keys); the named convenience fields
// (clipPath/maskImage/transform/filter) remain for back-compat + structured
// editors. Works on a region wrapper OR a text run (text-stroke/border on glyphs).
// Presentation-only convenience presets for the Custom-shape editor. Each row is
// DATA: a label + the literal CSS `clip-path` it sets. The `resolveStyle` handler
// below NEVER reads this list — it applies whatever `clipPath` string it is given,
// so adding a preset is one DATA row here and zero handler change (L090/L083). The
// raw text input is the infinite escape hatch: ANY clip-path the user pastes works.
const CUSTOM_SHAPE_PRESETS: ReadonlyArray<{ label: string; clipPath: string }> = [
  { label: 'Circle', clipPath: 'circle(50%)' },
  { label: 'Ellipse', clipPath: 'ellipse(50% 38%)' },
  { label: 'Rounded', clipPath: 'inset(0 round 18px)' },
  { label: 'Squircle', clipPath: 'inset(0 round 30%)' },
  { label: 'Hexagon', clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' },
  { label: 'Diamond', clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' },
  { label: 'Triangle', clipPath: 'polygon(50% 0%, 100% 100%, 0% 100%)' },
  { label: 'Pentagon', clipPath: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)' },
  { label: 'Star', clipPath: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)' },
  { label: 'Arrow', clipPath: 'polygon(0% 20%, 60% 20%, 60% 0%, 100% 50%, 60% 100%, 60% 80%, 0% 80%)' },
];

const shapeRaw: VisualLayerCapability = {
  presentation: { label: 'Custom shape', icon: 'PenTool' },
  // GUI for "Custom shape": pick a preset silhouette OR paste any CSS clip-path.
  // Without this the silhouette could only be set by editing DATA directly — the
  // exact gap the user hit ("I don't get how it's supposed to work"). Presets are
  // DATA; the raw Input keeps the infinite escape hatch. (.ts file → no JSX.)
  editor: ({ input, patchInput }) => {
    const current = typeof input.clipPath === 'string' ? input.clipPath : '';
    return React.createElement(
      'div',
      { className: 'flex flex-col gap-2' },
      React.createElement(Text, { variant: 'label' }, 'Shape'),
      React.createElement(
        Inline,
        { gap: 'xs', className: 'flex-wrap' },
        React.createElement(
          Button,
          { variant: current === '' ? 'solid' : 'ghost', size: 'xs', onClick: () => patchInput({ clipPath: '' }) },
          'None',
        ),
        ...CUSTOM_SHAPE_PRESETS.map((preset) =>
          React.createElement(
            Button,
            {
              key: preset.label,
              variant: current === preset.clipPath ? 'solid' : 'ghost',
              size: 'xs',
              onClick: () => patchInput({ clipPath: preset.clipPath }),
            },
            preset.label,
          ),
        ),
      ),
      React.createElement(Text, { variant: 'caption', color: 'muted' }, 'Or paste any CSS clip-path'),
      React.createElement(Input, {
        value: current,
        placeholder: 'polygon(…) · circle(50%) · inset(0 round 16px)',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => patchInput({ clipPath: event.target.value }),
        // keep typing inside the popover from triggering canvas keyboard shortcuts
        onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => event.stopPropagation(),
      }),
    );
  },
  resolveStyle: ({ input }) => {
    const css: Record<string, unknown> = {};
    if (typeof input.clipPath === 'string') {
      css.clipPath = input.clipPath;
      css.WebkitClipPath = input.clipPath;
    }
    if (typeof input.maskImage === 'string') {
      css.maskImage = input.maskImage;
      css.WebkitMaskImage = input.maskImage;
      css.maskSize = 'cover';
      css.WebkitMaskSize = 'cover';
    }
    if (typeof input.transform === 'string') css.transform = input.transform;
    if (typeof input.filter === 'string') css.filter = input.filter;
    // The infinite escape hatch: an arbitrary CSS bag, merged verbatim. Borders,
    // -webkit-text-stroke, textShadow, borderRadius, angles — whatever the user
    // (or an AI) supplies as DATA — with ZERO new capability code per property.
    if (input.style && typeof input.style === 'object') {
      Object.assign(css, input.style as Record<string, unknown>);
    }
    return css as React.CSSProperties;
  },
};

// shape.edge — ONE parametric perimeter generator. Every torn/scalloped/deckle/
// wave/bevel edge is a point in (amplitude, frequency, noise, seed) space.
const shapeEdge: VisualLayerCapability = {
  presentation: { label: 'Edge', icon: 'Scissors' },
  addAffordance: { order: 26, defaultZ: -1, defaultInput: { amplitude: 3, frequency: 18, noise: 0.85, seed: 1 } },
  editor: ({ input, patchInput }) =>
    React.createElement(
      React.Fragment,
      null,
      sliderRow('amplitude', input, patchInput, 0, 14, 4),
      sliderRow('frequency', input, patchInput, 2, 48, 16),
      sliderRow('noise', input, patchInput, 0, 1, 1),
    ),
  resolveStyle: ({ input }) => {
    const clip = edgeClipPath(input);
    return { clipPath: clip, WebkitClipPath: clip } as React.CSSProperties;
  },
};

/** The built-in pack. The owner composes this with custom capabilities. */
export const builtinVisualLayerCapabilities: Readonly<Record<string, VisualLayerCapability>> = {
  solid,
  gradient,
  mesh,
  image,
  media,
  'pattern.dot-grid': patternDotGrid,
  'shape.raw': shapeRaw,
  'shape.edge': shapeEdge,
  'effect.grain': effectGrain,
  'effect.tint': effectTint,
  'effect.blur': effectBlur,
  // Moves with the sound around the person (parts/ui/show/sound-signal), behind the panes or in any region.
  'effect.sound': effectSound,
};
