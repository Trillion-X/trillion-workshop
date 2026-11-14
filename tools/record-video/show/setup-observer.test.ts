import { describe, expect, it, vi } from 'vitest';
import {
  countNearBlackPixels,
  frameHasVisualVariance,
  observeMediaDeviceChanges,
  observationProblems,
  readinessObservationsFromSetup,
  rootMeanSquare,
  type SetupObservationResult,
} from './setup-observer';

if (typeof ImageData === 'undefined') {
  (globalThis as { ImageData?: unknown }).ImageData = class {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

function imageDataWithPixels(pixels: number[][], width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixels[y][x];
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a ?? 255;
    }
  }
  return new ImageData(data, width, height);
}

describe('record-video setup-observer pure checks', () => {
  it('counts near-black pixels correctly', () => {
    const data = new Uint8ClampedArray([
      5, 5, 5, 255,
      200, 150, 100, 255,
      10, 10, 10, 255,
      255, 255, 255, 255,
    ]);
    expect(countNearBlackPixels(data, 4)).toBe(2);
  });

  it('rejects an entirely near-black frame as no visual variance', () => {
    const image = imageDataWithPixels(
      [
        [5, 5], [5, 5],
        [5, 5], [5, 5],
      ].map((row) => row.map(() => [5, 5, 5, 255])),
      2,
      2,
    );
    expect(frameHasVisualVariance(image)).toBe(false);
  });

  it('accepts a frame with any non-black content', () => {
    const image = imageDataWithPixels(
      [
        [[5, 5, 5], [200, 150, 100]],
        [[10, 10, 10], [255, 255, 255]],
      ],
      2,
      2,
    );
    expect(frameHasVisualVariance(image)).toBe(true);
  });

  it('computes RMS of a known signal', () => {
    const silence = new Float32Array(1000);
    expect(rootMeanSquare(silence)).toBe(0);

    const tone = new Float32Array(1000).fill(0.1);
    expect(rootMeanSquare(tone)).toBeCloseTo(0.1, 5);
  });

  it('produces a problem for each failed observation only', () => {
    const observations: SetupObservationResult = {
      camera_live: { value: true, method: 'sensor', observed_at_ms: 1 },
      audio_live: { value: false, method: 'sensor', observed_at_ms: 1, detail: 'silent' },
      framing: { value: false, method: 'vision', observed_at_ms: 1, detail: 'black' },
    };
    const problems = observationProblems(observations);
    expect(problems).toHaveLength(2);
    expect(problems.map((p) => p.key).sort()).toEqual(['audio_live', 'framing']);
    expect(problems.every((p) => p.detail.length > 0)).toBe(true);
  });

  it('produces zero problems when every observation passes', () => {
    const observations: SetupObservationResult = {
      camera_live: { value: true, method: 'sensor', observed_at_ms: 1 },
      audio_live: { value: true, method: 'sensor', observed_at_ms: 1 },
      framing: { value: true, method: 'vision', observed_at_ms: 1 },
    };
    expect(observationProblems(observations)).toEqual([]);
  });

  it('preserves physical observation times while timestamping current operator confirmations', () => {
    const result = readinessObservationsFromSetup({
      report: {
        observations: {
          camera_live: { value: true, method: 'sensor', observed_at_ms: 101 },
          audio_live: { value: true, method: 'sensor', observed_at_ms: 102 },
          framing: { value: true, method: 'vision', observed_at_ms: 103 },
        },
        problems: [],
        observed_at_ms: 104,
        duration_ms: 4,
      },
      requirements: [
        { id: 'camera_live', key: 'camera' },
        { id: 'audio_live', key: 'audio' },
        { id: 'framing', key: 'frame' },
        { id: 'claim_review', key: 'claims' },
        { id: 'permission', key: 'capture' },
      ],
      claimReviewed: true,
      capturePermitted: true,
      operatorObservedAtMs: 999,
    });

    expect(result.camera.observed_at_ms).toBe(101);
    expect(result.audio.observed_at_ms).toBe(102);
    expect(result.frame.observed_at_ms).toBe(103);
    expect(result.claims).toEqual({ value: true, method: 'operator', observed_at_ms: 999 });
    expect(result.capture).toEqual({ value: true, method: 'operator', observed_at_ms: 999 });
  });

  it('invalidates setup evidence when the browser reports a device change and removes the listener', () => {
    const previousMediaDevices = globalThis.navigator.mediaDevices;
    const listeners = new Set<() => void>();
    const mediaDevices = {
      addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
    };
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    const onChange = vi.fn();

    const stop = observeMediaDeviceChanges(onChange);
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener();
    expect(onChange).toHaveBeenCalledOnce();

    stop();
    expect(listeners.size).toBe(0);
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: previousMediaDevices });
  });
});
