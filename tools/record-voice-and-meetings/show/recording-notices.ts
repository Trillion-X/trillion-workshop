// parts/record-audio/show/recording-notices.ts
//
// PURPOSE
//   The floating cards of a recording in progress, wherever in the app the person is: "Recording ongoing" with Pause (or
//   Resume) and Stop recording while it runs, then "Preparing meeting note" from Stop until the recording is kept, which
//   ends as "Your meeting note is ready" with Open note. They are notifications in the one notification center (the
//   same stack every card in the product floats in), kept in place by a stable key, so no screen draws its own floating
//   box and no second card ever stacks.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The recording is read from live-recording.ts and changed only through live-recording-controls.ts; nothing here
//      keeps a second copy of its phase, its time or its pause.
//   2. Words, buttons and when each shows are DATA (read-data/recording-widgets.json `card` and `preparing`).
//   3. A recording that is cancelled leaves no card behind; one that fails to be kept says so instead of "ready".
//   4. The caller says where a note opens (`openNote`); this file knows no screen.

import { notify } from '../../ui/show/coss/notifications';
import type { NotificationHandle } from '../../ui/show/notifications/notification-center';
import widgets from '../read-data/recording-widgets.json';
import { currentLiveRecording, subscribeToLiveRecording, type LiveRecording } from './live-recording';
import { pauseLiveRecording, resumeLiveRecording, stopLiveRecording } from './live-recording-controls';

export type RecordingNoticeHost = {
  /** Opens the note of a recording: its saved file when `kept`, else the screen that shows it while it records. */
  openNote: (recordedFileId: string, kept: boolean) => void;
  /** A control or the journal failed: said in words by the caller. */
  problem: (error: unknown) => void;
};

const { card, preparing } = widgets;
const SHOWN_PHASES = new Set(Object.keys(card.detail));
const PREPARING_PHASES = new Set(['flushing', 'saving']);
const FAILED_PHASES = new Set(['recoverable-error', 'terminal-error']);

/** The title a recording's card carries: its meeting's own title, else the ad-hoc one. */
export const noteTitle = (live: LiveRecording) => live.session.meetingEventContext?.title?.trim() || widgets.adhoc_title;

/** Keeps the cards in step with the live recording until the returned function is called. */
export function keepRecordingNotices(host: RecordingNoticeHost): () => void {
  let liveCard: NotificationHandle | null = null;
  let prepareCard: NotificationHandle | null = null;
  let following: { recordedFileId: string; title: string } | null = null;

  const operations: Record<string, () => unknown> = {
    pause: () => pauseLiveRecording(host.problem),
    resume: () => resumeLiveRecording(host.problem),
    stop: async () => {
      const result = await stopLiveRecording('capture-completion:operator-stop', 'record-audio:floating-card');
      if (result.journalError) host.problem(result.journalError);
    },
  };

  const showLive = (live: LiveRecording) => {
    const title = noteTitle(live);
    const phase = live.phase;
    const options = {
      key: card.key, kind: card.kind, running: true, timeout: 0,
      detail: card.detail[phase as keyof typeof card.detail],
      actions: [
        ...card.actions.filter(action => action.when.includes(phase)).map(action => ({
          id: action.id, label: action.label, icon: action.icon, danger: 'danger' in action, dismisses: false, onAction: operations[action.id],
        })),
        { id: 'open-note', label: card.open_note, dismisses: false, press: true, onAction: () => host.openNote(live.session.recordedFileId, false) },
      ],
    };
    liveCard = liveCard ? liveCard.update({ title, ...options }) : notify(title, options);
  };

  const react = () => {
    const live = currentLiveRecording();
    if (live && !live.cancelled) following = { recordedFileId: live.session.recordedFileId, title: noteTitle(live) };
    if (live && !live.cancelled && SHOWN_PHASES.has(live.phase)) {
      showLive(live);
      return;
    }
    if (liveCard) { liveCard.dismiss(); liveCard = null; }
    if (live && !live.cancelled && PREPARING_PHASES.has(live.phase)) {
      const options = { key: preparing.key, kind: preparing.kind, running: true, timeout: 0, detail: preparing.detail };
      prepareCard = prepareCard ? prepareCard.update({ title: preparing.title, ...options }) : notify(preparing.title, options);
      return;
    }
    if (live && !live.cancelled && FAILED_PHASES.has(live.phase)) {
      prepareCard?.finish({ title: preparing.failed, kind: 'error', detail: '', actions: [], timeout: 0 });
      prepareCard = null;
      return;
    }
    if (live) return;
    const kept = following;
    if (prepareCard && kept) {
      prepareCard.finish({
        title: preparing.ready, kind: 'done', detail: kept.title, timeout: 0,
        actions: [{ id: 'open-note', label: preparing.ready_action, onAction: () => host.openNote(kept.recordedFileId, true) }],
      });
    } else prepareCard?.dismiss();
    prepareCard = null;
    following = null;
  };

  const stop = subscribeToLiveRecording(react);
  react();
  return () => { stop(); liveCard?.dismiss(); prepareCard?.dismiss(); liveCard = null; prepareCard = null; };
}
