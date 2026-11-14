// packages/ui/show/breathing-pacer/decode-breathing-cycle.ts
// Generic decoder: a raw breathing pattern (an ordered list of phases, each a
// {label, seconds, scale?}) -> a resolved BreathingCycleView with the exact CSS
// @keyframes that drive one seamless, looping breath. Pure + data-driven: box
// breathing (4-4-4-4), 4-7-8, coherence (5-5), the physiological sigh — every
// pattern is DATA, zero code per pattern (L069/L090). No domain vocabulary, no
// closed enum of "breathing types" — the phase list IS the type.
//
// Scale semantics: each phase declares the scale the circle REACHES at the end
// of that phase; the circle interpolates from the previous phase's end scale to
// this one over the phase's seconds. An omitted scale inherits the previous end
// scale (a "hold"). The loop is seamless because the cycle starts at the last
// phase's end scale (grow -> hold -> shrink -> hold -> grow ...).

export interface RawBreathingPhase {
  /** Instruction shown while this phase runs, e.g. "Breathe in" / "Hold". */
  label: string;
  /** Phase duration in seconds (> 0). */
  seconds: number;
  /** Circle scale reached at the END of this phase (e.g. 1 = full, 0.5 = small).
   *  Omit to hold the previous phase's scale. */
  scale?: number;
}

export interface ResolvedBreathingPhase {
  label: string;
  seconds: number;
  /** Scale reached at the end of the phase (forward-filled). */
  endScale: number;
  /** % of the total cycle at which this phase STARTS. */
  startPct: number;
  /** % of the total cycle at which this phase ENDS. */
  endPct: number;
}

export interface BreathingLabelView {
  /** Stable key for React. */
  key: string;
  text: string;
  /** CSS animation-name driving this label's opacity window. */
  animationName: string;
  /** The `@keyframes ...` block for this label (opacity 1 only in its window). */
  keyframesCss: string;
}

export interface BreathingCycleView {
  /** Total cycle length in seconds (sum of phase seconds). */
  totalSeconds: number;
  /** animation-name for the core circle's scale animation. */
  coreAnimationName: string;
  /** The `@keyframes ...` block for the core circle scale. */
  coreKeyframesCss: string;
  /** All @keyframes blocks (core + every label) joined — inject once in a <style>. */
  keyframesCss: string;
  /** One entry per phase, in order (drives the stacked, time-synced labels). */
  labels: BreathingLabelView[];
  /** Resolved phases with end scale + timeline %s (for optional per-phase UI). */
  phases: ResolvedBreathingPhase[];
  /** Scale the cycle rests at when animation is disabled (= last end scale). */
  startScale: number;
  minScale: number;
  maxScale: number;
}

const DEFAULT_SCALE = 1;

function sanitize(seed: string): string {
  const cleaned = String(seed).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return cleaned.length > 0 ? cleaned : 'x';
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function isPositive(n: unknown): n is number {
  return typeof n === 'number' && isFinite(n) && n > 0;
}

/** Opacity keyframes that make a label fully visible only within [startPct,endPct]. */
function labelKeyframes(name: string, startPct: number, endPct: number): string {
  const span = endPct - startPct;
  const fade = Math.min(4, span / 3); // gentle in/out, always inside the window
  const stops: Array<[number, number]> = [];
  const push = (pct: number, op: number) => stops.push([round(Math.max(0, Math.min(100, pct))), op]);

  if (startPct <= 0) {
    push(0, 1);
  } else {
    push(0, 0);
    push(startPct, 0);
    push(startPct + fade, 1);
  }
  push(endPct - fade, 1);
  if (endPct >= 100) {
    push(100, 1);
  } else {
    push(endPct, 0);
    push(100, 0);
  }

  // De-dup identical consecutive percents (keep the last), then serialize.
  const byPct = new Map<number, number>();
  for (const [pct, op] of stops) byPct.set(pct, op);
  const body = [...byPct.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pct, op]) => `${pct}% { opacity: ${op}; }`)
    .join(' ');
  return `@keyframes ${name} { ${body} }`;
}

export interface DecodeBreathingCycleOptions {
  /** Seed for the (deterministic) animation names so two pacers never collide. */
  idSeed?: string;
}

export function decodeBreathingCycle(
  raw: unknown,
  options: DecodeBreathingCycleOptions = {},
): BreathingCycleView {
  const seed = sanitize(options.idSeed ?? 'default');
  const coreAnimationName = `bfb_${seed}_core`;

  const rawPhases: RawBreathingPhase[] = Array.isArray(raw)
    ? (raw as RawBreathingPhase[])
    : Array.isArray((raw as { phases?: unknown })?.phases)
      ? ((raw as { phases: RawBreathingPhase[] }).phases)
      : [];

  const clean = rawPhases.filter((p) => p && isPositive(p.seconds));

  if (clean.length === 0) {
    // Fail-closed: a single static "breath" so the surface never renders broken.
    const coreKeyframesCss = `@keyframes ${coreAnimationName} { 0%,100% { transform: scale(1); } }`;
    return {
      totalSeconds: 0,
      coreAnimationName,
      coreKeyframesCss,
      keyframesCss: coreKeyframesCss,
      labels: [],
      phases: [],
      startScale: 1,
      minScale: 1,
      maxScale: 1,
    };
  }

  // Seed the loop from the last declared scale so the cycle closes seamlessly.
  let startScale = DEFAULT_SCALE;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    if (typeof clean[i].scale === 'number' && isFinite(clean[i].scale as number)) {
      startScale = clean[i].scale as number;
      break;
    }
  }

  const totalSeconds = clean.reduce((sum, p) => sum + p.seconds, 0);

  const phases: ResolvedBreathingPhase[] = [];
  let prevScale = startScale;
  let elapsed = 0;
  for (const p of clean) {
    const endScale =
      typeof p.scale === 'number' && isFinite(p.scale) ? p.scale : prevScale;
    const startPct = round((elapsed / totalSeconds) * 100);
    elapsed += p.seconds;
    const endPct = round((elapsed / totalSeconds) * 100);
    phases.push({ label: String(p.label ?? ''), seconds: p.seconds, endScale, startPct, endPct });
    prevScale = endScale;
  }

  const scales = [startScale, ...phases.map((p) => p.endScale)];
  const minScale = Math.min(...scales);
  const maxScale = Math.max(...scales);

  // Core scale keyframes: start at startScale, hit each phase's end scale at its
  // boundary %, close at startScale (the last phase's end scale == startScale).
  const coreStops = [`0% { transform: scale(${round(startScale)}); }`];
  for (const p of phases) {
    coreStops.push(`${p.endPct}% { transform: scale(${round(p.endScale)}); }`);
  }
  const coreKeyframesCss = `@keyframes ${coreAnimationName} { ${coreStops.join(' ')} }`;

  const labels: BreathingLabelView[] = phases.map((p, i) => {
    const animationName = `bfb_${seed}_l${i}`;
    return {
      key: `l${i}`,
      text: p.label,
      animationName,
      keyframesCss: labelKeyframes(animationName, p.startPct, p.endPct),
    };
  });

  const keyframesCss = [coreKeyframesCss, ...labels.map((l) => l.keyframesCss)].join('\n');

  return {
    totalSeconds,
    coreAnimationName,
    coreKeyframesCss,
    keyframesCss,
    labels,
    phases,
    startScale,
    minScale,
    maxScale,
  };
}
