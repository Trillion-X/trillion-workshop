// packages/screen-recording/do-work/browser-screen-capture.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Screen capture acquisition via navigator.mediaDevices.getDisplayMedia.
// Mirrors the pattern of browser-media-capture.ts but for screen/display
// capture instead of microphone/camera input.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. getDisplayMedia is the primary acquisition method; there is no legacy
//    fallback because getDisplayMedia is a modern standard.
// 2. Availability is strictly binary: available or missing.
// 3. Audio track is optional — the caller specifies audio:true/false;
//    if requested and unavailable (e.g., user denied), the capture fails.
// 4. Errors are normalized to Error instances and surface honestly.
// 5. This module does NOT own UI permission prompts or fallback flows —
//    it only exposes availability and fetch methods.
//
// =============================================================================

type BrowserScreenCaptureMethod = 'navigator.mediaDevices.getDisplayMedia' | 'missing';

export type ScreenCaptureConfig = {
  video: boolean | MediaTrackConstraints;
  audio: boolean | boolean; // audio may be simple boolean or constraints depending on browser
  preferCurrentTab?: boolean;
};

export function screenCaptureAvailability(source?: Navigator): BrowserScreenCaptureMethod {
  const nav = typeof source !== 'undefined' ? source : (typeof navigator !== 'undefined' ? navigator : null);
  if (nav && typeof nav.mediaDevices?.getDisplayMedia === 'function') {
    return 'navigator.mediaDevices.getDisplayMedia';
  }
  return 'missing';
}

function normalizeScreenCaptureError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.trim()) return new Error(error);
  return new Error('Screen capture failed.');
}

export async function screenMediaStream(
  config: ScreenCaptureConfig,
  source?: Navigator,
): Promise<MediaStream> {
  const nav = typeof source !== 'undefined' ? source : (typeof navigator !== 'undefined' ? navigator : null);

  if (!nav || typeof nav.mediaDevices?.getDisplayMedia !== 'function') {
    throw new Error(
      'Screen recording is not available in this browser surface. The navigator.mediaDevices.getDisplayMedia API is required.',
    );
  }

  const constraints = {
    video: config.video === true ? { cursor: 'always' as const } : config.video,
    audio: config.audio === true ? true : config.audio,
  };

  try {
    return await nav.mediaDevices.getDisplayMedia(constraints);
  } catch (error) {
    throw normalizeScreenCaptureError(error);
  }
}

export async function screenMediaStreamWithAudio(
  config: ScreenCaptureConfig,
  source?: Navigator,
): Promise<MediaStream> {
  // Some browsers require a separate audio stream for system audio.
  // For now, attempt combined capture; if audio is unavailable, the
  // error surfaces honestly and the caller can decide to retry with audio: false.
  return screenMediaStream(config, source);
}

export function isScreenCaptureAvailable(source?: Navigator): boolean {
  return screenCaptureAvailability(source) !== 'missing';
}
