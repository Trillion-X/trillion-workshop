// parts/ui/show/sound-signal/sound-painters.ts
//
// NO PRIOR: searched bitfield-packages show for particles, aurora, sparkle, canvas glow, and 21st.dev 'audio reactive visualizer' (#2560, #7245 are single demos)
//
// PURPOSE
//   The motions a look can move in. A look (parts/screen-look/show/sound-looks.json) names its motion by id; each
//   painter here draws one frame of it on a canvas from the sound's frame (sound-signal.ts) and the look's colours,
//   strength and speed. Painters are the only code in a look: a new motion is one painter here plus the looks that
//   use it, never an edit to whoever draws them.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A painter draws only on the canvas it is given and keeps its own moving parts in the `memory` it is handed, so
//      the same motion can run in many places at once.
//   2. Calm by default: everything eases toward the sound rather than jumping to it, and a strength of 0 leaves only
//      the ground and a slow breath.
//   3. No colour, size or speed is written here that a look can set; the numbers here are only how a motion moves.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { SoundFrame } from './sound-signal';

export type SoundLook = { id: string; label: string; about?: string; motion: string; palette: string[]; ground: string | null; strength: number; speed: number };
export type PaintArgs = { context: CanvasRenderingContext2D; width: number; height: number; frame: SoundFrame; look: SoundLook; memory: Record<string, unknown>; still: boolean };
export type Painter = (args: PaintArgs) => void;

const TAU = Math.PI * 2;

function rgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(char => char + char).join('') : clean.slice(0, 6);
  const value = Number.parseInt(full, 16);
  if (Number.isNaN(value)) return `rgba(255,255,255,${alpha})`;
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${Math.max(0, Math.min(1, alpha))})`;
}

/** An eased copy of the sound, kept per place, so motion follows the sound without jumping. */
function eased(memory: Record<string, unknown>, frame: SoundFrame, still: boolean): SoundFrame {
  const last = (memory.eased as SoundFrame | undefined) ?? frame;
  const rate = still ? 0.04 : 0.18;
  const bands: Record<string, number> = {};
  for (const [id, value] of Object.entries(frame.bands)) bands[id] = (last.bands[id] ?? value) + (value - (last.bands[id] ?? value)) * rate;
  const next = { ...frame, level: last.level + (frame.level - last.level) * rate, bands };
  memory.eased = next;
  return next;
}

function ground({ context, width, height, look }: PaintArgs) {
  context.clearRect(0, 0, width, height);
  if (look.ground) { context.fillStyle = look.ground; context.fillRect(0, 0, width, height); }
}

/** Soft colour blooms drifting slowly; they swell with the low and middle of the sound. */
const glow: Painter = args => {
  const { context, width, height, look, memory, still } = args;
  ground(args);
  const sound = eased(memory, args.frame, still);
  const time = sound.time * (still ? 0.15 : look.speed);
  const strength = look.strength;
  const size = Math.max(width, height);
  context.globalCompositeOperation = look.ground ? 'lighter' : 'source-over';
  look.palette.forEach((colour, index) => {
    const band = Object.values(sound.bands)[index % Math.max(1, Object.keys(sound.bands).length)] ?? sound.level;
    const x = width * (0.5 + 0.38 * Math.sin(time * (0.31 + index * 0.13) + index * 2.1));
    const y = height * (0.5 + 0.34 * Math.cos(time * (0.27 + index * 0.11) + index * 1.3));
    const radius = size * (0.28 + 0.32 * band * strength);
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, rgba(colour, (look.ground ? 0.55 : 0.28) * (0.35 + strength * sound.level)));
    gradient.addColorStop(1, rgba(colour, 0));
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  });
  context.globalCompositeOperation = 'source-over';
};

type Spark = { x: number; y: number; vx: number; vy: number; life: number; size: number; colour: string; spin: number };

/** Sparks that pop up on each beat like kernels in a pan, twinkle and fade, over a faint glow. */
const sparkles: Painter = args => {
  const { context, width, height, look, memory, frame, still } = args;
  glow({ ...args, look: { ...look, strength: look.strength * 0.5 } });
  const sound = memory.eased as SoundFrame;
  const sparks = (memory.sparks as Spark[] | undefined) ?? [];
  memory.sparks = sparks;
  const high = sound.bands.high ?? sound.level;
  const born = still ? 0 : (frame.beat ? Math.round(10 + 40 * look.strength * sound.level) : 0) + (Math.random() < high * look.strength * 0.6 ? 1 : 0);
  const unit = Math.min(width, height);
  for (let count = 0; count < born && sparks.length < 260; count += 1) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const speed = unit * (0.002 + Math.random() * 0.006) * (0.6 + look.speed);
    sparks.push({ x: width * (0.1 + Math.random() * 0.8), y: height * (0.55 + Math.random() * 0.45), vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, size: unit * (0.004 + Math.random() * 0.01), colour: look.palette[Math.floor(Math.random() * look.palette.length)] ?? '#ffffff', spin: Math.random() * TAU });
  }
  for (let index = sparks.length - 1; index >= 0; index -= 1) {
    const spark = sparks[index];
    spark.x += spark.vx; spark.y += spark.vy; spark.vy += unit * 0.00004; spark.life -= 0.012 + 0.01 * (1 - look.strength); spark.spin += 0.05;
    if (spark.life <= 0) { sparks.splice(index, 1); continue; }
    const twinkle = 0.6 + 0.4 * Math.sin(spark.spin * 3);
    const radius = spark.size * (0.6 + spark.life);
    context.save();
    context.translate(spark.x, spark.y);
    context.rotate(spark.spin);
    context.fillStyle = rgba(spark.colour, spark.life * twinkle);
    context.shadowColor = rgba(spark.colour, spark.life);
    context.shadowBlur = radius * 3;
    context.beginPath();
    // A four-pointed sparkle: two thin diamonds crossed.
    for (let point = 0; point < 8; point += 1) {
      const reach = point % 2 === 0 ? radius * 2.2 : radius * 0.45;
      const at = (point / 8) * TAU;
      if (point === 0) context.moveTo(Math.cos(at) * reach, Math.sin(at) * reach); else context.lineTo(Math.cos(at) * reach, Math.sin(at) * reach);
    }
    context.closePath();
    context.fill();
    context.restore();
  }
};

/** Lines of light rippling across, each one riding a band of the sound. */
const waves: Painter = args => {
  const { context, width, height, look, memory, still } = args;
  ground(args);
  const sound = eased(memory, args.frame, still);
  const time = sound.time * (still ? 0.15 : look.speed) * 2;
  const bands = Object.values(sound.bands);
  context.lineCap = 'round';
  look.palette.forEach((colour, index) => {
    const band = bands[index % Math.max(1, bands.length)] ?? sound.level;
    const amplitude = height * (0.03 + 0.22 * band * look.strength);
    const baseline = height * (0.35 + 0.15 * index);
    context.beginPath();
    for (let x = 0; x <= width; x += 6) {
      const phase = (x / width) * TAU * (1.2 + index * 0.4) + time * (1 + index * 0.3);
      const y = baseline + Math.sin(phase) * amplitude + Math.sin(phase * 0.5 + index) * amplitude * 0.4;
      if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.strokeStyle = rgba(colour, 0.35 + 0.5 * sound.level);
    context.lineWidth = 1.5 + 3 * band * look.strength;
    context.shadowColor = rgba(colour, 0.8);
    context.shadowBlur = 12 + 30 * band;
    context.stroke();
  });
  context.shadowBlur = 0;
};

type Kernel = { x: number; y: number; vx: number; vy: number; size: number; age: number; spin: number; turn: number; puffs: Array<[number, number, number]>; resting: number };

/** A kernel's puffed shape: a few overlapping round puffs around its centre, different for every kernel. */
function puffsOf(): Array<[number, number, number]> {
  const count = 4 + Math.floor(Math.random() * 3);
  return Array.from({ length: count }, (_, index) => {
    const at = (index / count) * TAU + Math.random() * 0.6;
    const reach = 0.35 + Math.random() * 0.25;
    return [Math.cos(at) * reach, Math.sin(at) * reach, 0.45 + Math.random() * 0.25] as [number, number, number];
  });
}

/** Kernels that pop on each beat: a small seed bursts into a puffed kernel, jumps, tumbles, lands and piles up at the
 *  bottom, then fades to make room. With no sound a kernel still pops now and then. The palette's first colour is the
 *  puff, the second its warm edge, the third the seed. */
const popcorn: Painter = args => {
  const { context, width, height, look, memory, frame, still } = args;
  ground(args);
  const sound = eased(memory, frame, still);
  const kernels = (memory.kernels as Kernel[] | undefined) ?? [];
  memory.kernels = kernels;
  const unit = Math.min(width, height);
  const [puff = '#fff4d6', edge = '#ffd36b', seed = '#c46a1a'] = look.palette;
  const low = sound.bands.low ?? sound.level;
  const born = still ? 0 : (frame.beat ? 1 + Math.round(5 * look.strength * (0.4 + low)) : 0) + (Math.random() < 0.012 + 0.05 * sound.level * look.strength ? 1 : 0);
  for (let count = 0; count < born; count += 1) {
    if (kernels.length >= 140) kernels.shift();
    const speed = unit * (0.012 + Math.random() * 0.016) * (0.5 + look.speed) * (0.7 + look.strength * 0.6);
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
    kernels.push({
      x: width * (0.08 + Math.random() * 0.84), y: height * (0.82 + Math.random() * 0.1),
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      size: unit * (0.018 + Math.random() * 0.014), age: 0, spin: Math.random() * TAU, turn: (Math.random() - 0.5) * 0.25,
      puffs: puffsOf(), resting: 0,
    });
  }
  const floor = height * 0.97;
  const gravity = unit * 0.0009 * (0.6 + look.speed);
  for (let index = kernels.length - 1; index >= 0; index -= 1) {
    const kernel = kernels[index];
    kernel.age += 1;
    if (kernel.resting === 0) {
      kernel.x += kernel.vx; kernel.y += kernel.vy; kernel.vy += gravity; kernel.spin += kernel.turn;
      if (kernel.x < kernel.size || kernel.x > width - kernel.size) kernel.vx *= -0.6;
      if (kernel.y > floor - kernel.size * 0.6) {
        kernel.y = floor - kernel.size * 0.6;
        if (Math.abs(kernel.vy) > unit * 0.004) { kernel.vy *= -0.35; kernel.vx *= 0.6; kernel.turn *= 0.5; } else kernel.resting = 1;
      }
    } else kernel.resting += 1;
    const fade = kernel.resting > 240 ? Math.max(0, 1 - (kernel.resting - 240) / 90) : 1;
    if (fade <= 0) { kernels.splice(index, 1); continue; }
    // The pop: a seed that bursts past full size and settles back over the first few frames.
    const pop = kernel.age < 3 ? 0.25 : kernel.age < 7 ? 0.25 + (kernel.age - 3) * 0.26 : kernel.age < 11 ? 1.29 - (kernel.age - 7) * 0.0725 : 1;
    const radius = kernel.size * pop;
    context.save();
    context.translate(kernel.x, kernel.y);
    context.rotate(kernel.spin);
    context.globalAlpha = fade;
    if (kernel.age < 4) {
      context.fillStyle = seed;
      context.beginPath();
      context.ellipse(0, 0, radius * 1.2, radius * 0.9, 0, 0, TAU);
      context.fill();
    } else {
      if (kernel.age < 14) {
        // The burst: a ring of light that opens and fades as the kernel pops.
        context.strokeStyle = rgba(edge, (14 - kernel.age) / 14);
        context.lineWidth = Math.max(1, radius * 0.12);
        context.beginPath();
        context.arc(0, 0, radius * (1.4 + (kernel.age - 4) * 0.12), 0, TAU);
        context.stroke();
      }
      for (const [px, py, pr] of kernel.puffs) {
        const gradient = context.createRadialGradient(px * radius - pr * radius * 0.3, py * radius - pr * radius * 0.3, 0, px * radius, py * radius, pr * radius);
        gradient.addColorStop(0, puff);
        gradient.addColorStop(0.75, puff);
        gradient.addColorStop(1, edge);
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(px * radius, py * radius, pr * radius, 0, TAU);
        context.fill();
      }
      context.fillStyle = rgba(seed, 0.85);
      context.beginPath();
      context.ellipse(radius * 0.05, radius * 0.1, radius * 0.18, radius * 0.12, 0.4, 0, TAU);
      context.fill();
    }
    context.restore();
  }
  context.globalAlpha = 1;
};

/** Every motion a look can name, by its id. */
export const soundPainters: Record<string, Painter> = { glow, sparkles, waves, popcorn };
