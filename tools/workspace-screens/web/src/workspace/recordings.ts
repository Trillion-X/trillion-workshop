// src/workspace/recordings.ts
//
// PURPOSE
//   What the recording parts' own screens (parts/record-video RecordVideoPanel as Record video, parts/record-audio
//   RecordAudioPanel as Record audio) ask of the app they run in, answered here so their recordings land where every
//   Trillion recording lands. The parts ask through the records seam, as they asked the Bitfield runtime:
//   - `content-media-evidence.materialize-artifact` with the finished recording (parts/content-media-evidence): the
//     file is kept in the person's Files under recording.json's folder, one folder per day, named as the Record
//     screen names it (recording.mjs keptNames), through the one uploader (upload.ts);
//   - `slot::workflow` with the part's own actions (`action:<part>:<action>`): saving a recording lists it in the
//     part's recordings input (src/workspace/inputs.json, the person's own records) and keeps the words heard while
//     recording beside it as its transcript, then hands both to the person's AIs with recording.json's jobs; a rename,
//     subtitle, notes or removal changes that list. The states a part reports while recording are not kept.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Which parts are answered, and where each lists its recordings, is DATA (recording.json `parts`); nothing here
//      decides by a part's name beyond reading that DATA and the action names the parts themselves declare.
//   2. Every request another answerer owns (the palette's search on `slot::workflow`, a background picture's keeping
//      on the materializer) is left to it: each answer here says which requests it `handles`.
//   3. A recording is kept whole, whatever its length: the part hands the file itself, never a byte array.
//   4. The words kept are the words heard while recording (the part's live recording `heard`); a part that heard none
//      keeps no transcript file, and its AIs are pointed at the recording itself, so nothing claims words not heard.
//   5. A recording tied to a meeting (at its save, or when the person links or unlinks it) keeps that meeting beside its file as
//      the `meeting` result, so the one search finds the recording by the meeting's title and the people invited.

import { answerTarget, readInputValue, readInputValueFromOwner, updateInputValueDurably } from './records';
import { postJson, fileResults } from './api';
import { keptNames, recordingJob, transcriptFileText, type scriptFor } from './recording.mjs';
import settings from './recording.json';
import { currentLiveRecording, subscribeToLiveRecording } from '../../parts/record-video/show/live-recording';
import { MEETING_RESULT_KIND, meetingResultOf, readMeetingCalendarContext, type MeetingCalendarContext } from 'trillion-workshop/tools/record-voice-and-meetings/do-work/meeting-join-recording.ts';
import { readMeetingApplicationInputContext } from '../../parts/record-audio/do-work/meeting-application-recording';
import { updateRecordingMeetingContextRows } from '../../parts/record-audio/do-work/recording-meeting-context-update';
// Static, never fetched at save time: a deploy during a recording replaces the content-named chunks, and a save that
// had to fetch one then failed with "Failed to fetch dynamically imported module" and kept nothing.
import { uploadFiles } from './upload';

type Script = ReturnType<typeof scriptFor>;
type SourceReference = { kind: string; label: string; id: string; title: string };
type Row = Record<string, unknown>;
type Execute = { operation?: string; definition_id?: string; input?: Row };
type Materialize = { source?: { file?: Blob; bytes?: number[]; media_type?: string; display_name?: string; provenance?: { package_ref?: string } } };
type Kept = { folder: string; name: string; transcript: string; script: Script | null; source: SourceReference | null };

const PARTS = settings.parts as Record<string, { recordings: string }>;
const FILE = 'file:';
const text = (value: unknown) => (typeof value === 'string' ? value : '');

// The script the open Record video screen reads from (a format with the person's thought), so the recording kept is
// named after the format, its transcript carries the script and the AIs are asked to turn it into that format.
let readingFrom: Script | null = null;
let readingSource: SourceReference | null = null;
let followingScript: Script | null | undefined;
let followingSource: SourceReference | null | undefined;
subscribeToLiveRecording(() => {
  if (!currentLiveRecording() && followingScript !== undefined) {
    readingFrom = followingScript;
    readingSource = followingSource ?? null;
    followingScript = undefined;
    followingSource = undefined;
  }
});
/** The Record video screen says which script the next recording is read from (null: none). */
export function recordFrom(script: Script | null, source: SourceReference | null = null) {
  // Preserve this take's words through saving, and retain the latest edit for
  // the following take. Explicitly clearing the script is also an edit.
  if (currentLiveRecording()) { followingScript = script; followingSource = source; return; }
  readingFrom = script;
  readingSource = source;
}

// Each kept recording, by the relation the part was handed back, until the part lists it.
const kept = new Map<string, Kept>();

/** A recording kind's file ending: the subtype, with the endings people know for MPEG sound and MP4 sound. */
function endingOf(mediaType: string) {
  const [family, subtype = 'webm'] = mediaType.split(';')[0].trim().toLowerCase().split('/');
  if (subtype === 'mpeg') return 'mp3';
  if (subtype === 'mp4' && family === 'audio') return 'm4a';
  return subtype.replace(/^x-/, '');
}

const partOf = (definition: unknown) => Object.keys(PARTS).find(part => text(definition).startsWith(`action:${part}:`)) ?? null;
const keepsHere = (request: unknown) => Boolean(PARTS[text((request as Materialize | null)?.source?.provenance?.package_ref)]);

/** Keeps a finished recording in the person's Files and answers with the relation the part keeps. */
async function keepRecording(request: unknown) {
  const source = (request as Materialize).source ?? {};
  const mediaType = text(source.media_type) || 'application/octet-stream';
  const bytes = source.file instanceof Blob ? source.file : Array.isArray(source.bytes) ? new Blob([Uint8Array.from(source.bytes)]) : null;
  if (!bytes?.size) throw new Error('This recording is empty. Record again and press Stop when you finish.');
  const startedAt = new Date();
  const script = readingFrom;
  let sourceReference = readingSource;
  if (sourceReference) {
    const answer = await postJson<{ source: SourceReference | null }>('/work/api/content-formats/shape', { source: { kind: sourceReference.kind, id: sourceReference.id } });
    if (!answer.source) throw new Error('That source is no longer available in this account. The recording is still on this device.');
    sourceReference = answer.source;
  }
  const names = keptNames(startedAt, { formatLabel: script?.format_label ?? null, extension: endingOf(mediaType) });
  const [file] = await uploadFiles([new File([bytes], names.audio, { type: mediaType.split(';')[0], lastModified: startedAt.getTime() })], names.folder);
  if (!file) throw new Error('This recording is empty. Record again and press Stop when you finish.');
  const relation = `${FILE}${file.identity}`;
  kept.set(relation, { folder: names.folder, name: file.name, transcript: names.transcript, script, source: sourceReference });
  return {
    kind: 'content-media.materialized-relation/v1',
    relation_ref: relation,
    media_type: mediaType.toLowerCase(),
    display_name: names.audio,
    byte_length: bytes.size,
    integrity_hash: file.identity,
  };
}

/** Keeps the words heard beside the recording and hands both to the person's AIs; answers the words' file identity
 *  (null when none were heard), which the recording's row keeps so its page opens on them. */
async function handOn(input: Row): Promise<string | null> {
  const sourceRef = (input.source_ref ?? {}) as { artifact_ref?: { relation_ref?: string } };
  const recording = kept.get(text(sourceRef.artifact_ref?.relation_ref));
  if (!recording) return null;
  const live = currentLiveRecording();
  const heard = live && live.session.recordedFileId === text(input.recorded_file_id) ? live.heard : null;
  let transcriptFile = recording.name;
  let transcriptIdentity: string | null = null;
  if (heard !== null) {
    const [words] = await uploadFiles([new File([transcriptFileText(heard, recording.script, null, recording.source)], recording.transcript, { type: 'text/plain', lastModified: Date.now() })], recording.folder);
    if (words) { transcriptFile = words.name; transcriptIdentity = words.identity; }
  }
  const seconds = Number(input.duration_ms ?? 0) / 1000;
  const job = recordingJob({ audioFile: recording.name, transcriptFile, seconds, script: recording.script, source: recording.source });
  await postJson('/work/api/queue', { ...job, press_key: `record:${text(input.recorded_file_id)}`, delivery: 'when-connected' });
  return transcriptIdentity;
}

/** The part's recordings list, changed by one function and saved in the person's records. */
async function changeList(part: string, change: (rows: Row[]) => Row[]) {
  const input = PARTS[part].recordings;
  return updateInputValueDurably(input, value => change(Array.isArray(value) ? value as Row[] : []));
}

/** Point one saved recording at a corrected immutable transcript version. Both identities are checked so a stale
 *  editor cannot silently replace a newer transcript; repeating the same successful update is safe. */
export async function replaceRecordingTranscript(part: string, recordingId: string, expectedTranscriptFile: string, transcriptFile: string) {
  if (!PARTS[part] || !recordingId || !/^(?:1f|12):[0-9a-f]{64}$/.test(transcriptFile)) {
    throw new Error('This transcript cannot be linked to the recording.');
  }
  await updateInputValueDurably(PARTS[part].recordings, value => {
    const rows = Array.isArray(value) ? value as Row[] : [];
    const saved = rows.find(row => row.id === recordingId);
    if (!saved) throw new Error('This recording is no longer in your recordings.');
    const current = text(saved.transcriptFile);
    if (current === transcriptFile) return rows;
    if (current !== expectedTranscriptFile) throw Object.assign(new Error('A newer transcript is already linked to this recording. Open it before making another change.'), { status: 409 });
    return rows.map(row => row.id === recordingId ? { ...row, transcriptFile } : row);
  });
}

const byId = (id: string, change: (row: Row) => Row) => (rows: Row[]) => rows.map(row => (row.id === id ? change(row) : row));

export type RecordingFileOwner = { part: string; id: string; recordedAt?: string; transcriptFile: string | null };

/** Resolve a Files/search entry against current recording rows, even before the library has hydrated. */
export async function readRecordingOwnerForFileFromOwner(identity: string, recordingId?: string, recordingPart?: string): Promise<RecordingFileOwner | null> {
  const parts = recordingPart ? Object.entries(PARTS).filter(([part]) => part === recordingPart) : Object.entries(PARTS);
  const answers = await Promise.all(parts.map(async ([part, settings]) => {
    const read = await readInputValueFromOwner<unknown>(settings.recordings);
    if (!read.found) return [];
    if (!Array.isArray(read.value)) throw new Error('The recording library could not be read.');
    return read.value.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Row, source = row.sourceRef;
      const artifact = source && typeof source === 'object' ? (source as Row).artifact_ref : null;
      return artifact && typeof artifact === 'object' && (artifact as Row).relation_ref === `file:${identity}`
        && (!recordingId || row.id === recordingId) ? [{part, row}] : [];
    });
  }));
  const matches = answers.flat();
  if (matches.length > 1) throw new Error('More than one recording uses this file. Open its recording library to choose the exact entry.');
  const found = matches[0];
  if (!found) return null;
  const {part, row: match} = found;
  if (typeof match.id !== 'string' || !match.id.trim()) throw new Error('The recording identity could not be read.');
  const transcriptFile = match.transcriptFile ?? null;
  if (transcriptFile !== null && (typeof transcriptFile !== 'string' || !/^(?:1f|12):[0-9a-f]{64}$/.test(transcriptFile))) {
    throw new Error('The saved transcript file identity could not be read.');
  }
  return { part, id: match.id, ...(typeof match.recordedAt === 'string' ? { recordedAt: match.recordedAt } : {}), transcriptFile };
}

export type RecordingMeetingAssociation =
  | { state: 'missing' | 'detached' | 'unreadable' }
  | { state: 'attached'; context: MeetingCalendarContext };

export function readRecordingMeetingAssociation(recordingId: string): RecordingMeetingAssociation {
  let rows: unknown;
  try { rows = readInputValue<unknown>(PARTS['record-audio']?.recordings); }
  catch { return { state: 'unreadable' }; }
  if (!Array.isArray(rows)) return { state: 'unreadable' };
  const row = rows.find((item): item is Row => Boolean(item && typeof item === 'object' && (item as Row).id === recordingId));
  if (!row) return { state: 'missing' };
  if (!Object.hasOwn(row, 'meetingEventContext') || row.meetingEventContext == null) return { state: 'detached' };
  const context = readMeetingCalendarContext(row.meetingEventContext);
  return context ? { state: 'attached', context } : { state: 'unreadable' };
}

/** Authoritative read for a recording opened before its library has hydrated. */
export async function readRecordingMeetingAssociationFromOwner(recordingId: string): Promise<RecordingMeetingAssociation> {
  const read = await readInputValueFromOwner<unknown>(PARTS['record-audio'].recordings);
  if (!read.found) return { state: 'missing' };
  if (!Array.isArray(read.value)) throw new Error('The recording library could not be read.');
  const row = read.value.find((item): item is Row => Boolean(item && typeof item === 'object' && (item as Row).id === recordingId));
  if (!row) return { state: 'missing' };
  if (!Object.hasOwn(row, 'meetingEventContext') || row.meetingEventContext == null) return { state: 'detached' };
  const context = readMeetingCalendarContext(row.meetingEventContext);
  return context ? { state: 'attached', context } : { state: 'unreadable' };
}

/** The content identity of the file a recording row keeps (null for a row with no kept file yet). */
function fileIdentityOf(sourceRef: unknown): string | null {
  const artifact = sourceRef && typeof sourceRef === 'object' ? (sourceRef as Row).artifact_ref : null;
  const relation = artifact && typeof artifact === 'object' ? (artifact as Row).relation_ref : null;
  return typeof relation === 'string' && relation.startsWith(FILE) ? relation.slice(FILE.length) : null;
}

/** Keeps the meeting a recording is tied to beside its file, where the one search reads it (src/search.json lane
 *  meeting-details); no meeting keeps an empty value, so a detached recording is no longer found by it. */
async function keepMeetingResult(sourceRef: unknown, context: MeetingCalendarContext | null): Promise<void> {
  const identity = fileIdentityOf(sourceRef);
  if (!identity) return;
  try {
    await fileResults.record([{ identity, kind: MEETING_RESULT_KIND, value: meetingResultOf(context), produced_by: 'trillion meetings' }]);
  } catch {
    throw new Error('The meeting was saved on the recording, but search could not be updated. Link it again to retry.');
  }
}

/** Attach or edit metadata on the canonical recording row; metadata never starts capture. */
export async function setRecordingMeetingContext(recordId: string, value: unknown, expectedValue: unknown = null): Promise<void> {
  const context = readMeetingCalendarContext(value);
  if (!context) throw new Error('Choose a valid calendar event with its source identity and start time.');
  const saved = await updateInputValueDurably(PARTS['record-audio'].recordings, rows => updateRecordingMeetingContextRows(rows, {
    recordId, recordedFileId: recordId, expectedContext: expectedValue, nextContext: context,
  }));
  await keepMeetingResult(saved.find(row => row.id === recordId)?.sourceRef, context);
}

/** Detach metadata while retaining the recording and its media evidence. */
export async function clearRecordingMeetingContext(recordId: string, expectedValue: unknown): Promise<void> {
  const expected = readMeetingCalendarContext(expectedValue);
  if (!expected) throw new Error('The meeting association changed. Reopen the recording before detaching it.');
  const saved = await updateInputValueDurably(PARTS['record-audio'].recordings, rows => updateRecordingMeetingContextRows(rows, {
    recordId, recordedFileId: recordId, expectedContext: expected, nextContext: null,
  }));
  await keepMeetingResult(saved.find(row => row.id === recordId)?.sourceRef, null);
}

// What each of the parts' own actions does here, by the action's name as the parts declare it.
const ACTIONS: Record<string, (part: string, input: Row) => Promise<void>> = {
  'save-recorded-file': async (part, input) => {
    const id = text(input.recorded_file_id);
    const meetingEventContext = readMeetingCalendarContext(input.meeting_event_context);
    const meetingApplicationInputContext = readMeetingApplicationInputContext(input.meeting_application_input_context);
    if (input.meeting_application_input_context != null && !meetingApplicationInputContext)
      throw new TypeError('The recording application source context is malformed.');
    const row: Row = {
      id,
      label: text(input.label),
      subtitle: '',
      notes: '',
      mode: text(input.mode),
      mediaType: text(input.media_type),
      byteLength: input.byte_length,
      durationMs: input.duration_ms,
      recordedAt: text(input.recorded_at),
      storedFileRef: input.stored_file_ref,
      sourceRef: input.source_ref,
      completionReasonRef: text(input.completion_reason_ref),
      completionObservedAt: text(input.completion_observed_at),
      artifactDisposition: text(input.artifact_disposition),
      state: 'stopped',
      ...(meetingEventContext ? { meetingEventContext } : {}),
      ...(meetingApplicationInputContext ? { meetingApplicationInputContext } : {}),
    };
    // The note made when the recording began keeps what the person named or wrote in it while recording.
    await changeList(part, rows => {
      const begun = rows.find(other => other.id === id && other.state === 'recording');
      return [begun ? { ...row, label: text(begun.label) || row.label, subtitle: text(begun.subtitle), notes: text(begun.notes) } : row, ...rows.filter(other => other.id !== id)];
    });
    const transcriptFile = await handOn(input);
    if (transcriptFile) await changeList(part, byId(id, saved => ({ ...saved, transcriptFile })));
    // A recording begun from a meeting is found by that meeting once its file is kept.
    if (meetingEventContext) await keepMeetingResult(input.source_ref, meetingEventContext);
  },
  'begin-recording-note': async (part, input) => {
    const id = text(input.recorded_file_id);
    const meetingEventContext = readMeetingCalendarContext(input.meeting_event_context);
    const meetingApplicationInputContext = readMeetingApplicationInputContext(input.meeting_application_input_context);
    const row: Row = {
      id, label: text(input.label), subtitle: '', notes: '', mode: text(input.mode), recordedAt: text(input.recorded_at), state: 'recording',
      ...(meetingEventContext ? { meetingEventContext } : {}),
      ...(meetingApplicationInputContext ? { meetingApplicationInputContext } : {}),
    };
    await changeList(part, rows => (rows.some(other => other.id === id) ? rows : [row, ...rows]));
  },
  'set-recording-name': (part, input) => changeList(part, byId(text(input.recorded_file_id), row => ({ ...row, label: text(input.label) }))),
  'set-recording-subtitle': (part, input) => changeList(part, byId(text(input.recorded_file_id), row => ({ ...row, subtitle: text(input.subtitle) }))),
  'set-recording-notes': (part, input) => changeList(part, byId(text(input.recorded_file_id), row => ({ ...row, notes: text(input.notes) }))),
  'set-recording-meeting-context': (_part, input) => setRecordingMeetingContext(text(input.record_id), input.meeting_event_context, input.expected_meeting_context),
  'clear-recording-meeting-context': (_part, input) => clearRecordingMeetingContext(text(input.record_id), input.expected_meeting_context),
  'remove-recording': (part, input) => changeList(part, rows => rows.filter(row => row.id !== text(input.recorded_file_id))),
};

answerTarget('content-media-evidence.materialize-artifact', keepRecording, { handles: keepsHere });

answerTarget('slot::workflow', async request => {
  const { definition_id: definition, input = {} } = (request ?? {}) as Execute;
  const part = partOf(definition);
  if (!part) throw new Error(`This app cannot run ${text(definition)}.`);
  const action = ACTIONS[text(definition).slice(`action:${part}:`.length)];
  if (['set-recording-meeting-context', 'clear-recording-meeting-context'].includes(text(definition).slice(`action:${part}:`.length))) {
    if (part !== 'record-audio' || input.record_id !== input.recorded_file_id || typeof input.recorded_file_id !== 'string' || !input.recorded_file_id.trim()) {
      throw new Error('Choose the same recording identity for the meeting association.');
    }
    if (!Object.hasOwn(input, 'expected_meeting_context')) throw new Error('The current meeting association is required.');
  }
  if (action) await action(part, input);
  return { output: {} };
}, { handles: request => partOf((request as Execute | null)?.definition_id) !== null });
