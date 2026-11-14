// src/workspace/recording-widgets.ts
//
// PURPOSE
//   Starts the widgets of a recording in progress for this page (parts/record-audio): the floating "Recording ongoing"
//   and "Preparing meeting note" cards and the microphone pill, wherever the person is in the app. It says where a note
//   opens (the saved file, or the Record audio screen while it records), where the chosen microphone is kept (a
//   workspace preference, the record-audio recording-widgets.json `pill.microphone_preference`) and how a failure is said.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The widgets and their words are the part's; this file only connects them to this app's screens and preferences.
//   2. The microphone chosen is one preference read by the pill and by the Record audio screen (`preferredMicrophone`), so
//      the next recording opens the one the person picked in either place.

import { keepRecordingNotices } from '../../parts/record-audio/show/recording-notices';
import { mountRecordingPill } from '../../parts/record-audio/show/RecordingPill';
import widgets from '../../parts/record-audio/read-data/recording-widgets.json';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from '../../parts/ui/show/safe-error-card/sanitize-error-text';
import { readWorkspacePreference, subscribeRecordLabel, writeConfirmedWorkspacePreference } from './records';
import { openScreenOn } from './open-screen';

const KEY = widgets.pill.microphone_preference;
const LABEL = `workspace-preference:${KEY}`;

/** The microphone the next recording opens ('' for the default one). */
export function preferredMicrophone(): string {
  const saved = readWorkspacePreference<{ device_id?: unknown }>(KEY);
  return typeof saved?.device_id === 'string' ? saved.device_id : '';
}

const problem = (error: unknown) => notify(errorWords(error, 'The recording could not be changed.'), { kind: 'error' });

/** Where a note opens: a kept recording's file, else the screen that shows the recording being made. */
async function openNote(recordedFileId: string, kept: boolean) {
  if (!kept) { openScreenOn('trillion.record-audio', {}); return; }
  const { openSavedRecording } = await import('trillion-workshop/tools/record-voice-and-meetings/web/src/workspace/record-audio-screen.tsx');
  openSavedRecording(recordedFileId);
}

/** Shows the widgets for as long as this page lives. */
export function keepRecordingWidgets(): () => void {
  const stopNotices = keepRecordingNotices({ openNote: (id, kept) => { void openNote(id, kept); }, problem });
  const host = {
    microphone: preferredMicrophone,
    onMicrophone: (deviceId: string) => { void writeConfirmedWorkspacePreference(KEY, { device_id: deviceId }).catch(problem); },
    subscribeMicrophone: (listener: () => void) => subscribeRecordLabel(LABEL, listener),
    problem,
  };
  let stopPill = mountRecordingPill(host);
  let disposed = false;
  // The sandboxed Mac has no local Workshop reader. Its trusted hosted main page offers the same public window
  // DATA it already uses; native validates it and replies only after registering the window's channel. Keep the
  // inline pill usable during that handshake or a refusal, then remount against the admitted channel if it arrives.
  const hostHandlers = () => typeof window === 'undefined' ? undefined : (window as Window & {
    webkit?: { messageHandlers?: Record<string, { postMessage: (body: unknown) => unknown } | undefined> };
  }).webkit?.messageHandlers;
  const handlers = hostHandlers();
  const setup = handlers?.trillionRecordingWindowSetup;
  if (setup && !handlers?.[widgets.window.channel]) {
    try {
      Promise.resolve(setup.postMessage(widgets.window)).then(accepted => {
        if (disposed || accepted !== true || !hostHandlers()?.[widgets.window.channel]) return;
        stopPill();
        stopPill = mountRecordingPill(host);
      }).catch(() => { /* The inline pill remains available when native setup fails. */ });
    } catch { /* A synchronous bridge failure also retains the inline pill. */ }
  }
  return () => { disposed = true; stopNotices(); stopPill(); };
}
