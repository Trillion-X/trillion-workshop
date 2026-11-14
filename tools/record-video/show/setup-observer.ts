import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Observe a live browser MediaStream before recording and produce fresh
// evidence that the physical setup is usable. This module never records,
// never authorizes capture, and never treats a permission grant or device
// existence as proof that the camera is framed or the microphone hears a
// non-silent signal.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. SENSOR EVIDENCE ONLY: observations here carry method "sensor". Operator
//    confirmations are separate evidence and can never satisfy a sensor-only
//    requirement.
// 2. FRESHNESS: every observation records its own observed_at_ms. The
//    evaluator independently rejects stale entries.
// 3. CLEAN RELEASE: the preview stream is stopped even when a check fails or
//    throws. No ghost tracks remain holding camera/microphone.
// 4. GENERIC KEYS: observations use format-independent keys (camera_live,
//    audio_live, framing). The caller maps them to the plan's requirement
//    keys.
// 5. NO HARDWARE ASSUMPTIONS: no camera name, person, room, platform, or
//    domain is hardcoded. Constraints come from the caller.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export type SetupObservationEvidence = {
  value: boolean;
  method: 'sensor' | 'vision';
  observed_at_ms: number;
  detail?: string;
};

export type SetupObservationResult = {
  camera_live: SetupObservationEvidence;
  audio_live: SetupObservationEvidence;
  framing: SetupObservationEvidence;
};

export type SetupObservationProblem = {
  key: keyof SetupObservationResult;
  detail: string;
};

export type SetupObservationReport = {
  observations: SetupObservationResult;
  problems: SetupObservationProblem[];
  observed_at_ms: number;
  duration_ms: number;
};

export type BrowserMediaSetupConstraints = {
  audio?: boolean | MediaTrackConstraints;
  video?: boolean | MediaTrackConstraints;
};

export type RecordingReadinessRequirement = {
  id: string;
  key: string;
};

export type RecordingReadinessObservation = {
  value: boolean;
  method: 'sensor' | 'vision' | 'operator';
  observed_at_ms: number;
};

const AUDIO_CHECK_DURATION_MS = 1200;
const AUDIO_SILENCE_RMS_THRESHOLD = 0.0008;
const FRAMING_BLACK_PIXEL_THRESHOLD = 0.995;
const FRAMING_SAMPLE_COUNT = 5;
const FRAMING_SAMPLE_INTERVAL_MS = 80;

/**
 * Open a preview MediaStream, independently verify the physical setup, and
 * release the stream. This is the pre-recording observation pass: it does
 * not create a MediaRecorder, does not save any media, and does not start
 * any workflow.
 */
export async function observeBrowserMediaSetup(
  constraints: BrowserMediaSetupConstraints,
): Promise<SetupObservationReport> {
  const startedAtMs = Date.now();
  let stream: MediaStream | null = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    const observations = await inspectStream(stream);
    const problems = observationProblems(observations);
    return {
      observations,
      problems,
      observed_at_ms: Date.now(),
      duration_ms: Date.now() - startedAtMs,
    };
  } finally {
    stopPreviewStream(stream);
  }
}

/**
 * Inspect an already-open stream without acquiring it. Used when the caller
 * already holds a preview stream and wants to re-run the observation pass.
 */
export async function inspectBrowserMediaStream(
  stream: MediaStream,
): Promise<SetupObservationResult> {
  return inspectStream(stream);
}

/**
 * Translate the setup pass into the presentation-readiness input without
 * changing when the physical evidence was actually observed. Operator
 * confirmations are current statements, but camera, microphone and framing
 * evidence must retain the sensor pass timestamp so the evaluator can reject
 * it when it has gone stale.
 */
export function readinessObservationsFromSetup(input: {
  report: SetupObservationReport;
  requirements: readonly RecordingReadinessRequirement[];
  claimReviewed: boolean;
  capturePermitted: boolean;
  operatorObservedAtMs: number;
}): Record<string, RecordingReadinessObservation> {
  const observations: Record<string, RecordingReadinessObservation> = {};
  for (const requirement of input.requirements) {
    if (requirement.id === 'camera_live') {
      observations[requirement.key] = input.report.observations.camera_live;
    } else if (requirement.id === 'audio_live') {
      observations[requirement.key] = input.report.observations.audio_live;
    } else if (requirement.id === 'framing') {
      observations[requirement.key] = input.report.observations.framing;
    } else if (requirement.id === 'claim_review') {
      observations[requirement.key] = {
        value: input.claimReviewed,
        method: 'operator',
        observed_at_ms: input.operatorObservedAtMs,
      };
    } else if (requirement.id === 'permission') {
      observations[requirement.key] = {
        value: input.capturePermitted,
        method: 'operator',
        observed_at_ms: input.operatorObservedAtMs,
      };
    }
  }
  return observations;
}

/**
 * Subscribe to hardware-route changes through the browser-owned device
 * registry. A changed camera or microphone invalidates the previous setup
 * pass; callers must never keep a readiness result across this event.
 */
export function observeMediaDeviceChanges(onChange: () => void): () => void {
  const mediaDevices = typeof navigator === 'undefined' ? null : navigator.mediaDevices;
  if (!mediaDevices?.addEventListener || !mediaDevices.removeEventListener) return () => undefined;
  mediaDevices.addEventListener('devicechange', onChange);
  return () => mediaDevices.removeEventListener('devicechange', onChange);
}

async function inspectStream(stream: MediaStream): Promise<SetupObservationResult> {
  const videoTracks = stream.getVideoTracks();
  const audioTracks = stream.getAudioTracks();

  const cameraLive = checkCameraLive(videoTracks);
  const framing = await checkFraming(videoTracks);
  const audioLive = await checkUsableAudio(audioTracks);

  return { camera_live: cameraLive, audio_live: audioLive, framing };
}

function checkCameraLive(tracks: readonly MediaStreamTrack[]): SetupObservationEvidence {
  const observedAtMs = Date.now();

  if (tracks.length === 0) {
    return {
      value: false,
      method: 'sensor',
      observed_at_ms: observedAtMs,
      detail: 'No video track in the preview stream.',
    };
  }

  const liveTrack = tracks.find((track) => track.readyState === 'live' && track.enabled);
  if (!liveTrack) {
    return {
      value: false,
      method: 'sensor',
      observed_at_ms: observedAtMs,
      detail: `Video track state: ${tracks.map((t) => `${t.readyState}/${t.enabled}`).join(', ')}.`,
    };
  }

  return {
    value: true,
    method: 'sensor',
    observed_at_ms: observedAtMs,
    detail: `Video track live: ${liveTrack.label || 'unnamed camera'}.`,
  };
}

async function checkUsableAudio(tracks: readonly MediaStreamTrack[]): Promise<SetupObservationEvidence> {
  const observedAtMs = Date.now();

  if (tracks.length === 0) {
    return {
      value: false,
      method: 'sensor',
      observed_at_ms: observedAtMs,
      detail: 'No audio track in the preview stream.',
    };
  }

  const liveTrack = tracks.find((track) => track.readyState === 'live' && track.enabled);
  if (!liveTrack) {
    return {
      value: false,
      method: 'sensor',
      observed_at_ms: observedAtMs,
      detail: `Audio track state: ${tracks.map((t) => `${t.readyState}/${t.enabled}`).join(', ')}.`,
    };
  }

  if (typeof AudioContext === 'undefined') {
    return {
      value: false,
      method: 'sensor',
      observed_at_ms: observedAtMs,
      detail: 'AudioContext is unavailable in this browser context.',
    };
  }

  const audioContext = new AudioContext();
  try {
    const source = audioContext.createMediaStreamSource(new MediaStream([liveTrack]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const samples = new Float32Array(analyser.fftSize);
    const deadline = Date.now() + AUDIO_CHECK_DURATION_MS;
    let maximumRms = 0;

    while (Date.now() < deadline) {
      analyser.getFloatTimeDomainData(samples);
      const rms = rootMeanSquare(samples);
      if (rms > maximumRms) maximumRms = rms;
      await sleep(60);
    }

    if (maximumRms < AUDIO_SILENCE_RMS_THRESHOLD) {
      return {
        value: false,
        method: 'sensor',
        observed_at_ms: observedAtMs,
        detail: `Audio signal is silent (max RMS ${maximumRms.toFixed(6)} < ${AUDIO_SILENCE_RMS_THRESHOLD}).`,
      };
    }

    return {
      value: true,
      method: 'sensor',
      observed_at_ms: observedAtMs,
      detail: `Audio signal detected (max RMS ${maximumRms.toFixed(6)}).`,
    };
  } finally {
    void audioContext.close().catch(() => undefined);
  }
}

async function checkFraming(tracks: readonly MediaStreamTrack[]): Promise<SetupObservationEvidence> {
  const observedAtMs = Date.now();

  const liveTrack = tracks.find((track) => track.readyState === 'live' && track.enabled);
  if (!liveTrack) {
    return {
      value: false,
      method: 'vision',
      observed_at_ms: observedAtMs,
      detail: 'No live video track to inspect framing.',
    };
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.width = '1px';
  video.style.height = '1px';

  const canvas = document.createElement('canvas');
  const context2d = canvas.getContext('2d', { willReadFrequently: true });
  if (!context2d) {
    return {
      value: false,
      method: 'vision',
      observed_at_ms: observedAtMs,
      detail: 'Could not create a 2D canvas context for frame inspection.',
    };
  }

  document.body.appendChild(video);
  try {
    video.srcObject = new MediaStream([liveTrack]);
    await video.play();

    const dimensions = await waitForVideoDimensions(video);
    if (!dimensions) {
      return {
        value: false,
        method: 'vision',
        observed_at_ms: observedAtMs,
        detail: 'Video track did not deliver frame dimensions.',
      };
    }

    canvas.width = Math.min(160, dimensions.width);
    canvas.height = Math.min(160, dimensions.height);

    let nonUniformFrames = 0;
    for (let sample = 0; sample < FRAMING_SAMPLE_COUNT; sample += 1) {
      await sleep(FRAMING_SAMPLE_INTERVAL_MS);
      context2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = context2d.getImageData(0, 0, canvas.width, canvas.height);
      if (frameHasVisualVariance(imageData)) nonUniformFrames += 1;
    }

    if (nonUniformFrames === 0) {
      return {
        value: false,
        method: 'vision',
        observed_at_ms: observedAtMs,
        detail: `All ${FRAMING_SAMPLE_COUNT} sampled frames were visually uniform (black/covered camera or no scene).`,
      };
    }

    return {
      value: true,
      method: 'vision',
      observed_at_ms: observedAtMs,
      detail: `${nonUniformFrames}/${FRAMING_SAMPLE_COUNT} frames showed visual variance at ${dimensions.width}x${dimensions.height}.`,
    };
  } catch (error) {
    return {
      value: false,
      method: 'vision',
      observed_at_ms: observedAtMs,
      detail: `Framing inspection failed: ${errorWords(error)}`,
    };
  } finally {
    video.srcObject = null;
    video.remove();
  }
}

export function frameHasVisualVariance(imageData: ImageData): boolean {
  const { data, width, height } = imageData;
  const totalPixels = width * height;
  if (totalPixels === 0) return false;

  const blackPixelCount = countNearBlackPixels(data, totalPixels);
  const blackRatio = blackPixelCount / totalPixels;
  return blackRatio < FRAMING_BLACK_PIXEL_THRESHOLD;
}

export function countNearBlackPixels(data: Uint8ClampedArray, totalPixels: number): number {
  let count = 0;
  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    if (r < 12 && g < 12 && b < 12) count += 1;
  }
  return count;
}

export function rootMeanSquare(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function waitForVideoDimensions(video: HTMLVideoElement): Promise<{ width: number; height: number } | null> {
  const deadline = Date.now() + 3000;
  return new Promise((resolve) => {
    const check = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        resolve({ width: video.videoWidth, height: video.videoHeight });
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stopPreviewStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function observationProblems(observations: SetupObservationResult): SetupObservationProblem[] {
  const problems: SetupObservationProblem[] = [];
  for (const key of Object.keys(observations) as Array<keyof SetupObservationResult>) {
    if (!observations[key].value) {
      problems.push({ key, detail: observations[key].detail ?? 'Observation failed.' });
    }
  }
  return problems;
}
