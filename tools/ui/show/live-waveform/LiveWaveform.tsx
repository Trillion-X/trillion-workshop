import * as React from 'react';

import { cn } from '../cn';

export type LiveWaveformProps = {
  stream?: MediaStream | null;
  active?: boolean;
  processing?: boolean;
  /**
   * Chrome around the level strip.
   * - 'outlined' (default): rounded bordered well — the original look.
   * - 'flat': no border, transparent ground — the strip sits directly on the
   *   surface (reference-calm: fey/Amie put meters on flat ground).
   */
  frame?: 'outlined' | 'flat';
  /**
   * Fade the strip into the surface at both edges instead of cutting off hard: the oldest sound dissolves at the left
   * and the newest arrives out of the surface at the right. The look's `screen-edge-fade-x` (screen-look edge-fade.css)
   * draws it as a CSS mask whose depth at each edge is a look token, so the canvas itself stays simple.
   */
  edgeFade?: boolean;
  className?: string;
  'aria-label'?: string;
};

const BAR_WIDTH = 2;
const BAR_GAP = 2;
const BAR_RADIUS = 1;
const FFT_SIZE = 1024;
/** How often a loudness is taken: twenty a second, so the wave moves at one speed whatever the screen's frame rate. */
const SAMPLE_MS = 50;

type AudioContextConstructor = typeof AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate = window as Window & { webkitAudioContext?: AudioContextConstructor };
  return candidate.AudioContext ?? candidate.webkitAudioContext ?? null;
}

function readCssColor(element: HTMLElement, variables: readonly string[], fallback: string): string {
  const style = getComputedStyle(element);
  for (const variable of variables) {
    const value = style.getPropertyValue(variable).trim();
    if (value) return value;
  }
  return style.color || fallback;
}

function clamp(value: number): number {
  return Math.max(0.04, Math.min(1, value));
}

/** A bar height, 0.04 to 1, for the sound's loudness: speech sits around -50 to -10 dB (the iPhone's Waveform uses the
 *  same scale, ios/Shared/Waveform.swift level(decibels:), so a voice draws the same height on every device). */
function loudness(samples: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  const decibels = 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8);
  return clamp((decibels + 50) / 40);
}

function roundedBar(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  if (typeof context.roundRect === 'function') {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    context.fill();
    return;
  }
  context.fillRect(x, y, width, height);
}

function processingBars(count: number, tick: number): number[] {
  const center = Math.max(1, count / 2);
  return Array.from({ length: count }, (_, index) => {
    const position = (index - center) / center;
    const centerWeight = 1 - Math.abs(position) * 0.42;
    const wave = Math.sin(tick * 0.035 + index * 0.31) * 0.24
      + Math.cos(tick * 0.021 - index * 0.18) * 0.18;
    return clamp((0.25 + wave) * centerWeight);
  });
}

export function LiveWaveform({
  stream,
  active = false,
  processing = false,
  frame = 'outlined',
  edgeFade = false,
  className,
  'aria-label': ariaLabel = 'Live audio level',
}: LiveWaveformProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  const sourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null);
  const contextRef = React.useRef<AudioContext | null>(null);
  // The loudness heard so far, oldest first, one every SAMPLE_MS; kept while paused so the wave stays where it was.
  const historyRef = React.useRef<number[]>([]);
  const sampledAtRef = React.useRef(0);

  React.useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;

    const resize = () => {
      const box = host.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(box.width * ratio));
      canvas.height = Math.max(1, Math.floor(box.height * ratio));
      const context = canvas.getContext('2d');
      context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!stream || !active) {
      sourceRef.current?.disconnect();
      sourceRef.current = null;
      analyserRef.current = null;
      void contextRef.current?.close();
      contextRef.current = null;
      return undefined;
    }

    const Constructor = audioContextConstructor();
    if (!Constructor) return undefined;

    const context = new Constructor();
    const analyser = context.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    contextRef.current = context;
    analyserRef.current = analyser;
    sourceRef.current = source;

    return () => {
      source.disconnect();
      analyserRef.current = null;
      sourceRef.current = null;
      void context.close();
      if (contextRef.current === context) contextRef.current = null;
    };
  }, [active, stream]);

  React.useEffect(() => {
    let frame = 0;
    const samples = new Float32Array(FFT_SIZE);

    const paint = (tick: number) => {
      const canvas = canvasRef.current;
      const host = hostRef.current;
      const context = canvas?.getContext('2d');
      if (!canvas || !host || !context) {
        frame = requestAnimationFrame(paint);
        return;
      }

      const box = host.getBoundingClientRect();
      const step = BAR_WIDTH + BAR_GAP;
      const capacity = Math.max(8, Math.ceil(box.width / step) + 1);
      const history = historyRef.current;
      // The wave moves only while sound is heard: one loudness every SAMPLE_MS, the newest at the right edge, sliding
      // left between samples so it moves smoothly at any frame rate.
      let slide = 0;
      if (active && analyserRef.current) {
        if (!sampledAtRef.current) sampledAtRef.current = tick;
        while (tick - sampledAtRef.current >= SAMPLE_MS) {
          analyserRef.current.getFloatTimeDomainData(samples);
          history.push(loudness(samples));
          sampledAtRef.current += SAMPLE_MS;
        }
        if (history.length > capacity) history.splice(0, history.length - capacity);
        slide = ((tick - sampledAtRef.current) / SAMPLE_MS) * step;
      } else {
        sampledAtRef.current = 0;
      }
      const bars = processing ? processingBars(capacity, tick) : history;

      context.clearRect(0, 0, box.width, box.height);
      const baseColor = readCssColor(host, ['--accent-primary', '--button-primary-bg'], 'CanvasText');
      const quietColor = readCssColor(host, ['--text-muted', '--text-secondary'], 'CanvasText');
      const centerY = box.height / 2;
      context.fillStyle = active || processing ? baseColor : quietColor;
      // Before any sound, a row of quiet dots where the wave will be.
      for (let back = 0; back * step < box.width + step; back += 1) {
        const value = bars[bars.length - 1 - back];
        const x = box.width - BAR_WIDTH - back * step - (processing ? 0 : slide);
        const height = Math.max(2, (value ?? 0) * box.height * 0.9);
        context.globalAlpha = value === undefined ? 0.25 : active || processing ? 0.45 + value * 0.55 : 0.35;
        roundedBar(context, x, centerY - height / 2, BAR_WIDTH, height, BAR_RADIUS);
      }

      context.globalAlpha = 1;
      frame = requestAnimationFrame(paint);
    };

    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [active, processing]);

  return (
    <div
      ref={hostRef}
      className={cn(
        'relative h-20 min-h-20 w-full overflow-hidden',
        frame === 'outlined'
          ? 'rounded-2xl border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)]'
          : 'bg-transparent',
        edgeFade && 'screen-edge-fade-x',
        className,
      )}
      aria-label={ariaLabel}
      role="img"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
