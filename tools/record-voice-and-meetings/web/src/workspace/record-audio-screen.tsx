// src/workspace/record-audio-screen.tsx
//
// PURPOSE
//   Record audio (entry `record-audio`): the record-audio part's own screen, RecordAudioPanel from Alex's record-audio
//   package, mounted as it is: record with the live waveform, pause, resume, stop or cancel, pick an audio file, and the
//   recording library beside it through shared RecordViews. The recording owner keeps the media; fields and view
//   definitions come from package DATA, and reusable full or partial configurations use the ordinary EEAF owner.
//   This adapter supplies that account transport and the existing recursive screen arrangement.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The panel is the package's; this file only hands it the records its package publishes for it and mounts it.
//   2. Those records are this page's DATA, shown only where the person keeps nothing under the label, never saved back.
//   3. A recording made here lands where every web recording lands (recordings.ts): the import below registers it.

import * as React from 'react';
import { ErrorBoundary } from '../../parts/ui';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { ArrangedContents } from '../../parts/screen-arrangement/show/ArrangedContents';
import { RecordAudioPanel } from '../../parts/record-audio/show/RecordAudioPanel';
import { recordingLibraryTarget } from '../../parts/record-audio/show/RecordingLibrary';
import { MeetingStartSettings } from '../../parts/record-audio/show/MeetingStartSettings';
import { readMeetingCalendarContext } from '../../../do-work/meeting-join-recording.ts';
import { decodeMeetingCaptureStartPolicy, type MeetingCaptureStartPolicy } from '../../parts/record-audio/read-data/capture-policy';
import { readMeetingActivity, subscribeMeetingActivity } from '../../parts/record-audio/do-work/native-meeting-activity';
import meetingSettings from '../../../read-data/meeting-start-settings.json';
import settingsWords from '../../../read-data/meeting-settings.json';
import { decodeMeetingSettings, withMeetingSettings } from '../../../read-data/meeting-settings.mjs';
import { MeetingNotesSettings, type MeetingNotesChange } from '../../parts/record-audio/show/MeetingNotesSettings';
import { AiInstructionsSettings, type AiInstructionsChange } from '../../parts/record-audio/show/AiInstructionsSettings';
import manifest from '../../parts/record-audio/things-to-store-and-run.json';
import visualDatabase from '../../../../keep-lists-of-rows/source-data/published-for-every-consumer.json';
import { partManifestFeeds, partManifestInputValues } from './part-records';
import {
  readInputValue,
  showMissing,
  showRecords,
  useWorkspacePreference,
  readSavedRecordFromOwner,
  updateWorkspacePreferenceDurably,
} from './records';
import { openFile } from './open-screen';
import { keepAdhocRecordingEvent } from './adhoc-recording-event';
import { notify } from '../../parts/ui/show/coss/notifications';
import { recordConfigurationSource } from './record-configurations';
import { recordFilter } from './record-filter';
import './recordings';
import { preferredMicrophone } from './recording-widgets';
import type { ScreenProps } from './lazy-screen';

let fed = false;
const MEETING_START_PREFERENCE = meetingSettings.preference_key;

type RecordingRow = { id?: unknown; label?: unknown; mediaType?: unknown; sourceRef?: unknown; transcriptFile?: unknown; recordedAt?: unknown };

export function openSavedRecording(recordingId: string) {
  const rows = readInputValue<unknown>('recordAudioRecordings');
  const row = Array.isArray(rows)
    ? rows.find((item): item is RecordingRow => Boolean(item && typeof item === 'object' && (item as RecordingRow).id === recordingId))
    : undefined;
  const source = row?.sourceRef && typeof row.sourceRef === 'object' ? row.sourceRef as Record<string, unknown> : null;
  const artifact = source?.artifact_ref && typeof source.artifact_ref === 'object' ? source.artifact_ref as Record<string, unknown> : null;
  const relation = typeof artifact?.relation_ref === 'string' ? artifact.relation_ref : '';
  const identity = relation.startsWith('file:') ? relation.slice('file:'.length) : '';
  if (!identity) {
    notify('This recording file is no longer available.', { kind: 'error' });
    return;
  }
  openFile({
    id: identity,
    name: typeof row?.label === 'string' ? row.label : 'Recording',
    type: typeof row?.mediaType === 'string' ? row.mediaType : 'audio/*',
    transcriptFileId: typeof row?.transcriptFile === 'string' ? row.transcriptFile : undefined,
    recordingOwner: { part: 'record-audio', recorded_file_id: recordingId, ...(typeof row?.recordedAt === 'string' ? { recorded_at: row.recordedAt } : {}) },
  });
}

export function mountRecordAudioScreen(element: HTMLElement, props: ScreenProps = {}): () => void {
  if (!fed) {
    showRecords(partManifestFeeds(manifest));
    showMissing({ ...partManifestInputValues(visualDatabase), ...partManifestInputValues(manifest) });
    fed = true;
  }
  return mountReactSurface(element, (
    <ErrorBoundary surfaceName="Record audio">
      <RecordAudioWorkspace meetingJoinRecording={props.surfaceInput?.meetingJoinRecording}
        meetingRecordingInvocation={props.surfaceInput?.meetingRecordingInvocation}
        recordingRequested={props.surfaceInput?.recordingRequested === true}
        calendarEvent={props.surfaceInput?.calendar_event}
        surfaceInput={props.surfaceInput} />
    </ErrorBoundary>
  ));
}

function RecordAudioWorkspace({ meetingJoinRecording, meetingRecordingInvocation, recordingRequested, calendarEvent, surfaceInput }: {
  meetingJoinRecording?: unknown; meetingRecordingInvocation?: unknown; recordingRequested?: boolean; calendarEvent?: unknown;
  surfaceInput?: Record<string, unknown>;
}) {
  const context = readMeetingCalendarContext(calendarEvent);
  const savedMode = useWorkspacePreference<unknown>(MEETING_START_PREFERENCE);
  const policy = decodeMeetingCaptureStartPolicy(savedMode);
  const activity = React.useSyncExternalStore(subscribeMeetingActivity, readMeetingActivity, readMeetingActivity);
  const accessCode = typeof surfaceInput?.access_code === 'string' ? surfaceInput.access_code : undefined;
  const configurationSource = React.useMemo(() => recordConfigurationSource({accessCode}), [accessCode]);
  const changePolicy = React.useCallback((change: (policy: MeetingCaptureStartPolicy) => MeetingCaptureStartPolicy) => {
    void updateWorkspacePreferenceDurably(MEETING_START_PREFERENCE, current => {
      const next = change(decodeMeetingCaptureStartPolicy(current));
      const existing = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
      const start = existing.meeting_start && typeof existing.meeting_start === 'object' && !Array.isArray(existing.meeting_start)
        ? existing.meeting_start as Record<string, unknown> : {};
      return { ...existing, meeting_start: { ...start, mode: next.mode,
        allowed_apps: next.allowedApps, blocked_apps: next.blockedApps } };
    }).catch(() => {
      notify('The meeting recording preference could not be saved.', { kind: 'error' });
    });
  }, []);
  const changeMode = React.useCallback((mode: MeetingCaptureStartPolicy['mode']) => {
    changePolicy(current => ({ ...current, mode }));
  }, [changePolicy]);
  const changeAppEnabled = React.useCallback((id: string, enabled: boolean) => {
    changePolicy(current => ({ ...current,
      allowedApps: enabled && current.allowedApps.length ? [...new Set([...current.allowedApps, id])] : current.allowedApps,
      blockedApps: enabled ? current.blockedApps.filter(app => app !== id) : [...new Set([...current.blockedApps, id])],
    }));
  }, [changePolicy]);
  const settings = decodeMeetingSettings(savedMode);
  // One change is saved after the one before it finishes, so two quick changes (typed words, then a switch) both land.
  const settingsQueue = React.useRef<Promise<unknown>>(Promise.resolve());
  const changeSettings = React.useCallback((change: MeetingNotesChange | AiInstructionsChange) => {
    settingsQueue.current = settingsQueue.current
      .then(() => updateWorkspacePreferenceDurably(MEETING_START_PREFERENCE, current => withMeetingSettings(current, change)))
      .catch(() => { notify(settingsWords.save_failed, { kind: 'error' }); });
  }, []);
  const pieces = [
    { id: 'recording', label: 'Record audio', content: <RecordAudioPanel
      onOpenRecording={openSavedRecording}
      meetingStartMode={policy.mode}
      meetingStartPolicy={policy}
      readMeetingStartPolicy={async () => {
        const saved = await readSavedRecordFromOwner(`workspace-preference:${MEETING_START_PREFERENCE}`);
        return decodeMeetingCaptureStartPolicy(saved.found ? saved.value : undefined);
      }}
      meetingJoinRecording={meetingJoinRecording}
      meetingRecordingInvocation={meetingRecordingInvocation}
      recordingRequested={recordingRequested}
      meetingEventContext={context}
      microphone={preferredMicrophone}
      onRecordingSaved={saved => { void readSavedRecordFromOwner(`workspace-preference:${MEETING_START_PREFERENCE}`).then(current => keepAdhocRecordingEvent(current.found ? current.value : undefined, saved)); }}
      meetingContextLabel={context ? meetingSettings.context_label.replace('{title}', context.title) : undefined}
      recordingLibraryConfiguration={{
        source: configurationSource,
        target: recordingLibraryTarget,
        openPath: '/record-audio',
        ...(typeof surfaceInput?.configuration === 'string' ? {initialId: surfaceInput.configuration} : {}),
        ...(typeof surfaceInput?.shared_configuration === 'string' ? {sharedCode: surfaceInput.shared_configuration} : {}),
        ...(typeof surfaceInput?.shared_offer === 'string' ? {sharedOffer: surfaceInput.shared_offer} : {}),
      }}
      recordingLibraryConfigurationId={typeof surfaceInput?.configuration === 'string' ? surfaceInput.configuration : undefined}
      recordingLibraryRuleOperators={recordFilter.ruleOperators}
      recordingLibraryLoadFilterRecords={recordFilter.loadFilterRecords}
    /> },
    { id: 'meeting-start-settings', label: meetingSettings.title, content: <MeetingStartSettings
      mode={policy.mode} onChange={changeMode} apps={activity.apps}
      observationStatus={activity.status}
      allowedApps={policy.allowedApps} blockedApps={policy.blockedApps} onAppEnabledChange={changeAppEnabled} /> },
    { id: 'meeting-notes-settings', label: settingsWords.notes.title, content: <MeetingNotesSettings
      value={{ sendNotesTo: settings.sendNotesTo, smartPages: settings.smartPages, adhocEvents: settings.adhocEvents, languages: settings.languages }}
      onChange={changeSettings} /> },
    { id: 'ai-instructions-settings', label: settingsWords.instructions.title, content: <AiInstructionsSettings
      value={{ text: settings.instructions.text, scopes: settings.instructions.scopes, words: settings.words }}
      onChange={changeSettings} /> },
  ];
  return <ArrangedContents
    pieces={pieces}
    arrangement={meetingSettings.composition.arrangement}
    keptAt={meetingSettings.composition.kept_at}
    words={meetingSettings.composition.words}
  />;
}
