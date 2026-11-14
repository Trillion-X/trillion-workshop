import { decodeMeetingCaptureStartPolicy, decideMeetingCaptureStart } from '../../parts/record-audio/read-data/capture-policy';
import { configureMeetingActivity, pauseMeetingActivity } from '../../parts/record-audio/do-work/native-meeting-activity';
import { isCurrentMeetingApplicationRecordingInvocation, type MeetingApplicationRecordingInvocation } from '../../parts/record-audio/do-work/meeting-application-recording';
import { currentLiveRecording } from '../../parts/record-audio/show/live-recording';
import settings from 'trillion-workshop/tools/record-voice-and-meetings/read-data/meeting-start-settings.json';
import { notify } from '../../parts/ui/show/coss/notifications';
import { readSavedLabels, readSavedRecordFromOwner, readWorkspacePreference, subscribeRecordLabel } from './records';
import { openScreenOn } from './open-screen';

let activeRuntime: symbol | null = null;

/** Compose the recorder's live host input with this account's existing saved policy. */
export function keepMeetingRecordingTriggers(eligible: () => boolean): () => void {
  const runtime = Symbol('meeting-recording-runtime');
  activeRuntime = runtime;
  let retired = false;
  const current = () => !retired && activeRuntime === runtime && eligible();
  const policy = () => decodeMeetingCaptureStartPolicy(readWorkspacePreference(settings.preference_key));
  const freshPolicy = async () => {
    const saved = await readSavedRecordFromOwner(`workspace-preference:${settings.preference_key}`);
    return decodeMeetingCaptureStartPolicy(saved.found ? saved.value : undefined);
  };
  const invocationCurrent = (invocation: MeetingApplicationRecordingInvocation) =>
    current() && !currentLiveRecording() && isCurrentMeetingApplicationRecordingInvocation(invocation);
  const openRecording = async (invocation: MeetingApplicationRecordingInvocation, requested: boolean) => {
    if (!invocationCurrent(invocation)) return;
    const decision = decideMeetingCaptureStart(await freshPolicy(), invocation);
    if (!invocationCurrent(invocation)) return;
    if (decision !== 'start' && !(requested && decision === 'remind')) return;
    openScreenOn('trillion.record-audio', { meetingRecordingInvocation: invocation, recordingRequested: requested });
  };
  const inputStarted = async (invocation: MeetingApplicationRecordingInvocation) => {
    if (!invocationCurrent(invocation)) return;
    const decision = decideMeetingCaptureStart(await freshPolicy(), invocation);
    if (!invocationCurrent(invocation)) return;
    if (decision === 'start') await openRecording(invocation, false);
    if (decision === 'remind') notify(settings.app_reminder.replace('{app}', invocation.appName), {
      kind: 'info', timeout: 2 * 60 * 1000, key: `recording-reminder:${invocation.invocationId}`,
      actions: [{ id: 'record', label: settings.reminder_action, onAction: () => {
        if (!isCurrentMeetingApplicationRecordingInvocation(invocation)) {
          notify(settings.reminder_ended, { kind: 'info' });
          return;
        }
        void openRecording(invocation, true).catch(unavailable);
      } }],
    });
  };
  const unavailable = () => {
    if (current()) notify(settings.policy_unavailable, { kind: 'error' });
  };
  const onInputStarted = (invocation: MeetingApplicationRecordingInvocation) => { void inputStarted(invocation).catch(unavailable); };
  const configure = () => {
    if (retired || activeRuntime !== runtime) return;
    if (!eligible()) { pauseMeetingActivity(); return; }
    const mode = policy().mode;
    configureMeetingActivity(mode === 'automatic' || mode === 'reminder', onInputStarted);
  };
  const stop = subscribeRecordLabel(`workspace-preference:${settings.preference_key}`, configure);
  // This preference is not a startup-screen record. Restore it through the
  // current owner before observing, even when Record audio was never opened.
  if (eligible()) void readSavedLabels([`workspace-preference:${settings.preference_key}`])
    .then(configure).catch(() => { if (current()) pauseMeetingActivity(); });
  const pause = () => { if (activeRuntime === runtime) pauseMeetingActivity(); };
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', configure);
  return () => {
    retired = true;
    stop();
    if (activeRuntime === runtime) { pauseMeetingActivity(); activeRuntime = null; }
    window.removeEventListener('pagehide', pause);
    window.removeEventListener('pageshow', configure);
  };
}
