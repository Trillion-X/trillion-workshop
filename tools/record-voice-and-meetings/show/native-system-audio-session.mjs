/** Routes native events only to the browser capture session that opened them. */
export function listenToNativeSystemAudio(target, sessionID, handlers) {
  let active = true;
  const eventName = 'trillion-native-system-audio';
  const listener = event => {
    if (!active) return;
    const detail = event?.detail;
    if (!detail || detail.session_id !== sessionID) return;
    if (detail.event === 'audio') handlers.audio?.(detail);
    else if (detail.event === 'started') handlers.started?.(detail);
    else if (detail.event === 'error') handlers.failure?.(detail);
  };
  target.addEventListener(eventName, listener);
  return () => {
    if (!active) return;
    active = false;
    target.removeEventListener(eventName, listener);
  };
}

/** Ends a mixed destination track through the same ended path as a lost input. */
export function endNativeSystemAudioTrack(track) {
  track.dispatchEvent(new Event('ended'));
  track.stop();
}

const MAX_EXCLUDED_APPS = 128;
const MAX_EXCLUDED_APP_LENGTH = 256;

/**
 * The applications whose sound a source's row leaves out of the capture (`exclude_apps` in capture-sources.json):
 * stable bundle identifiers, de-duplicated. Empty (the row names none) leaves the whole Mac's output in. A malformed
 * entry is dropped, never widened into a different match.
 */
export function excludedApps(row) {
  const named = Array.isArray(row?.exclude_apps) ? row.exclude_apps : [];
  const kept = named.filter(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_EXCLUDED_APP_LENGTH
    && id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id));
  return [...new Set(kept)].slice(0, MAX_EXCLUDED_APPS);
}

/** The start message the Mac app reads: the session and the applications left out of this capture. */
export const nativeStartMessage = (sessionID, row) => ({ command: 'system-audio-start', session_id: sessionID, exclude_apps: excludedApps(row) });
