// src/workspace/record-screen.tsx
//
// PURPOSE
//   Record (entry `record`, the one Record every device opens): record your
//   voice or a video of yourself in the browser with the one recorder every Trillion screen uses
//   (parts/record-audio/show/record-in-the-browser.ts), and read what you say while you are still saying it. A script
//   from Formats is read as a teleprompter that follows the reader's voice (the tab opens with the format's id and the
//   thought as its input), read in full, as its structure or as its ideas (recording.json script_views), with Have my
//   AI write it beside it. Every piece of the recording is kept on this device the moment it is made and then sent
//   into the person's Files, so the recording and the words said so far can be read by name (and by their AIs) while
//   it is still being recorded. Done finishes the recording and its transcript in the person's Files, one folder per
//   day under recording.json's folder, and hands both to their AIs. Pause holds the recording and the words; a paused
//   voice recording shows its sound as a timeline to scrub, zoom, play, cut a part from, and record into at any point.
//   Once kept, the words can be corrected and the corrected words are kept and handed on too. The words can be copied
//   at any time.
//
//   Each thing shows only when it is needed: before recording, the choice of voice or video, the camera's picture (for
//   video), the way to read the script, and the Record control; while recording (and not paused, for the script), the
//   live waveform, the script and the live words (over the picture, for video, where the script itself follows the
//   words said and the words show only without a script); while a voice recording is paused, its timeline; after, the
//   recording itself to play back, where it was kept, and its words to correct.
//
//   Opened about something shared (/record/about/<share>, the iPhone share sheet's Record), it shows what was shared and
//   what was asked of it, offers the person's formats to read it as (a teleprompter about the share), and Done hands the
//   recording on with the share's own record, which says what to do with both, where it goes and which AI takes it.
//
//   A recording this device holds that was never finished (the tab was closed or reloaded while recording or sending)
//   finishes saving by itself when the screen opens, from the device copy, and is handed on; nothing needs pressing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every piece is on this device before it is sent anywhere (parts/record-audio/do-work/recording-on-device.ts and
//      send-while-recording.ts); a dropped connection, a refusal or a reload never loses what was recorded.
//   2. Discard throws the recording away everywhere: the device copy, the file in Files and the words written so far.
//   3. A failed save keeps the recording and offers Try again; a save waiting for the connection says so and finishes by
//      itself.
//   4. The words never gate the recording: a browser that cannot show them says so in plain words, and the
//      recording still saves and still reaches the person's AI.
//   5. A recording that cannot start, or a microphone that hears nothing, is said in the recorder in plain words (what
//      happened and what to do), from the recorder's DATA; nothing is half-started.
//   6. Files go in through the one browser uploader (upload.ts); the AIs are asked through the one button road
//      (/work/api/queue, the rows recording.json names in src/queued-work.json), once, at Done.
//   7. The script comes from the account's formats (GET /work/api/content-formats), read through the shared
//      screen-state part; nothing here names a format or a way of reading one.
//   8. A recording that was cut or added to is kept as its edit (recording.mjs), made from the recording on the device;
//      the recording as it was made is kept beside it.
//   9. Every control is a shared part (parts/ui): CaptureControl for the one record button before recording,
//      RecordingBar while recording (its time read from the recording's own start and pauses, the live waveform of the
//      sound over time, Pause, Discard and Done), SegmentedControl for voice or video and for the script's view, CaptionScroll for the teleprompter, AudioTimeline for a paused recording, CopyButton (parts/ui/show/copy-button) for the words,
//      MediaFrame for the live picture and FilePreview for the recording made; this file writes no markup of its own.
//  10. On a device that can listen by itself (the iPhone app), the switch to listen there all the time sits above the
//      recorder before recording (listen-here.tsx); it shows nothing anywhere else.

import { codeFailureNotice, lazyPart } from '../../parts/ui/show/load-later/later';
import { CodeLoadFailure, loadCode, whenOnline } from '../../parts/ui/show/load-later/load-code';
import * as React from 'react';
import { useFocusContainerWhile } from '../../parts/screen-arrangement/show/use-focus-container-while';
import { Button, CaptionScroll, CaptureControl, Card, Container, RecordingBar, SchemaValueView, SegmentedControl, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text, Textarea, type CaptureControlState } from '../../parts/ui';
import { CopyButton } from '../../parts/ui/show/copy-button/CopyButton';
import { ListenHere } from './listen-here';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { notify } from '../../parts/ui/show/coss/notifications';
import { loopFreeWords } from '../../../read-data/heard-words.mjs';
import { canCapture, captureSource, openSource, problemWords, startCapture, type Capture, type CaptureSource, type Recorded } from '../../parts/record-audio/show/record-in-the-browser';
import { keepOnDevice, reopenOnDevice, unfinishedRecordings, type DeviceRecording, type UnfinishedRecording } from '../../parts/record-audio/do-work/recording-on-device';
import { sendWhileRecording, type Sending, type SendState } from '../../parts/record-audio/do-work/send-while-recording';
import { isFeedPiece } from '../../parts/record-audio/do-work/always-recording';
import { deviceAccount, PlanNeeded, postJson, readFileJson, readJson } from './api';
import { planNeededTitle, refusal, reasonOf } from './failure';
import { goTo } from './open-screen';
import { useWorkspacePreference, writeWorkspacePreference } from './records';
import surfaces from './screens.mjs';
import { growingFiles, keepText, removeNames, uploadFiles } from './upload';
import {
  calendarRecordingContext, correctedTranscriptJob, cutFrom, editedName, editLength, follow, heardWords, insertInto, isWholeRecording, keptNames, liveStretch, liveWorkJob, meetingTurns, recordingJob, scriptFor,
  scriptWords, scriptSegments, START, teleprompterInView, teleprompterIsLive, timeNewWords, transcriptFileText,
  wordsOfEdit,
} from './recording.mjs';
import { useScriptView } from './script-view';
import { useWriteWithMyAI } from './write-with-my-ai';
import settings from './recording.json';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
// Record's own row: its address, and the query field that opens it joined to a meeting (its `route_query` names the
// field whose input is `meeting`), so a meeting link opens this screen joined wherever it is opened.
const RECORD_ROW = surfaces.surfaces.find(row => row.id === 'trillion.record') as { route_paths: string[]; route_query: Record<string, string> };
const MEETING_FIELD = Object.keys(RECORD_ROW.route_query).find(field => RECORD_ROW.route_query[field] === 'meeting') as string;

// The live picture, the recording made and the timeline are fetched the first time they show, never with the screen.
const MediaFrame = lazyPart(() => import('../../parts/ui/show/media-frame/MediaFrame'), module => module.MediaFrame);
const FilePreview = lazyPart(() => import('../../parts/ui/show/file-preview/FilePreview'), module => module.FilePreview);
const AudioTimeline = lazyPart(() => import('../../parts/ui/show/audio-timeline/AudioTimeline'), module => module.AudioTimeline);
// Opening, playing and saving an edit share the loader's recovered copy, just as the timeline's data and component do.
const editorCode = () => loadCode(() => import('../../parts/record-audio/show/edit-recording'), module => {
  if ([module.decodeRecording, module.renderEdit, module.wavFile, module.playFrom].some(value => typeof value !== 'function')) {
    throw new TypeError('The recording editor is missing an export.');
  }
  return module;
});

type Format = { id: string; label: string; slots: { id: string; label: string; hint?: string }[]; input?: string; process?: string[]; output?: string; from: string };
type Script = ReturnType<typeof scriptFor>;
type SourceReference = { kind: string; label: string; id: string; title: string };
type Input = { format_id?: unknown; about?: unknown; material?: unknown; source?: unknown; share?: unknown; meeting?: unknown; calendar_event?: unknown; quick_record?: unknown };
type CalendarEvent = ReturnType<typeof calendarRecordingContext>;
// Something shared that this recording is about: its record's identity, what it is, and what the person asked of it.
type Shared = { identity: string; about: string; asked: string };
type ShareRecord = { items?: { url?: string; text?: string; name?: string; title?: string }[]; job?: string; own_words?: string | null };
type Opened = { script: Script | null; shared: Shared | null; formats: Format[]; calendarEvent: CalendarEvent; source: SourceReference | null };
// Where a recording is kept: the day's folder and its names there (recording.mjs keptNames).
type Names = { folder: string; audio: string; transcript: string };
// A recording once kept: where, its two files, and the words kept in its transcript.
type Kept = { folder: string; audioFile: string; transcriptFile: string; transcriptName: string; words: string; source?: SourceReference | null; queueSaid?: string };
// Where a recording is after Done: being kept, waiting for the connection (kept on this device), kept, or refused.
type Saving = { state: 'idle' } | { state: 'working' } | { state: 'waiting' } | { state: 'saved'; kept: Kept } | { state: 'failed'; reason: string };
// Where corrected words are: not being kept, being kept, or refused (and why), with the correction held.
type Correcting = { state: 'idle' } | { state: 'working' } | { state: 'failed'; reason: string };
// The recording made, held to play back in this tab.
type Made = { file: File; url: string };
// One stretch of words handed to the person's AIs while recording, and where that work is.
// One meeting recorded from several devices: its space, whether this device started it, and the link others open.
type Meeting = { space_id: string; mine: boolean; link: string };
type Moment = { key: string; heading: string; state: 'pending' | 'sent' | 'done' | 'error'; note: string; result?: unknown };
// A word heard, with the second of the recording it was heard at.
type TimedWord = { word: string; at: number };
type Span = { from: number; to: number };
// What a device copy carries so it can be finished after a reload.
type KeptWith = { names: Names; script: Script | null; share: string | null; words: string; calendarEvent?: CalendarEvent; source?: SourceReference | null };
// One recording on its way: the recorder, its device copy, its sending, and where it is kept.
type Session = { capture: Capture; device: DeviceRecording; sending: Sending; names: Names };
// A paused voice recording opened as a timeline: its decoded sound, the edit as heard, and its peaks.
type Opening = { state: 'loading' } | { state: 'ready'; recorded: AudioBuffer; heard: AudioBuffer; peaks: Float32Array } | { state: 'failed'; reason: string; code?: CodeLoadFailure };

const FILES_SCREEN = 'trillion.files';
const CAPTURE_SOURCE_PREFERENCE = settings.capture_source_preference.key;
const PEAKS_PER_SECOND = 20;
// A part chosen on the timeline starts this long.
const CHOSEN_SECONDS = 2;
// The live words always keep room for a few lines, so the script never squeezes them away (the screen scrolls).
const TRANSCRIPT_MIN_HEIGHT = '9rem';
const text = (value: unknown) => (typeof value === 'string' ? value : '');
// Why a save or a request was refused, in the person's words: what a paid plan unlocks, or the reason itself.
const refusedBecause = (error: unknown) => (error instanceof PlanNeeded ? planNeededTitle(error.upgrade_needed) : reasonOf(error));
// What this screen offers to record: recording.json's choices this browser can record from.
const choices = () => settings.sources.flatMap(choice => {
  const source = captureSource(choice.id);
  return source && canCapture(source) ? [{ ...choice, source }] : [];
});
const endingOf = (name: string) => /\.([^./]+)$/.exec(name)?.[1] ?? 'webm';
const pathOf = (names: Names, name: string) => `${names.folder}/${name}`;
const minutesAndSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const momentOf = (at: Date) => at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Reads the share this tab was opened about, as the share sheet kept it: what it is and what was asked of it. */
async function readShared(identity: string): Promise<Shared> {
  const record = await readFileJson<ShareRecord>(identity);
  const items = record.items ?? [];
  const first = items.find(item => item.url || item.text || item.title || item.name);
  const about = first?.url ?? first?.text ?? first?.title ?? first?.name ?? '';
  const more = items.length > 1 ? ` and ${items.length - 1} more` : '';
  return { identity, about: `${about.trim()}${more}`, asked: text(record.job).trim() };
}

/** Reads the format this tab was opened with and drops the thought into it (no format means no script), and the share
 * it was opened about with the formats to read it as. */
async function readOpened(input: Input): Promise<Opened> {
  const calendarEvent = calendarRecordingContext(input.calendar_event);
  const formatId = text(input.format_id);
  const shareId = text(input.share);
  const formats = formatId || shareId ? (await readJson<{ formats: Format[] }>('/work/api/content-formats')).formats : [];
  const shared = shareId ? await readShared(shareId) : null;
  let source: SourceReference | null = null;
  let sourceMaterial: string | null = null;
  if (input.source != null) {
    if (typeof input.source !== 'object' || Array.isArray(input.source)) throw new Error('That source reference could not be read. Choose it again in Formats.');
    const candidate = input.source as Partial<SourceReference>;
    if (typeof candidate.kind !== 'string' || typeof candidate.id !== 'string' || !candidate.id) throw new Error('That source is no longer available in this account. Choose it again in Formats.');
    const checked = await postJson<{ source: SourceReference | null; material: string }>('/work/api/content-formats/shape', { source: { kind: candidate.kind, id: candidate.id } });
    if (!checked.source) throw new Error('That source is no longer available in this account. Choose it again in Formats.');
    source = checked.source;
    sourceMaterial = checked.material;
  }
  if (!formatId) return { script: null, shared, formats, calendarEvent, source };
  const format = formats.find(item => item.id === formatId);
  if (!format) throw new Error('That format is not in your formats any more. Open Formats and choose another.');
  return { script: scriptFor(format, text(input.about), sourceMaterial ?? text(input.material)), shared, formats, calendarEvent, source };
}

/** Finishes keeping a recording whose sound is in Files (or on its way there): the edited recording when it was cut
 *  or added to, the transcript, and the job that hands both to the person's AIs. */
async function keep(sending: Sending, names: Names, said: string, seconds: number, script: Script | null, shareFile: string | null, edited: File | null, calendarEvent: CalendarEvent = null, source: SourceReference | null = null): Promise<Kept> {
  await sending.whenKept();
  const canonicalSource = source ? (await postJson<{ source: SourceReference | null }>('/work/api/content-formats/shape', { source: { kind: source.kind, id: source.id } })).source : null;
  if (source && !canonicalSource) throw new Error('That source is no longer available in this account. The recording is still on this device.');
  const words = new File([transcriptFileText(said, script, calendarEvent, canonicalSource)], names.transcript, { type: 'text/plain', lastModified: Date.now() });
  const kept = await uploadFiles(edited ? [edited, words] : [words], names.folder);
  const wordsKept = kept[kept.length - 1];
  const audioFile = edited && kept.length === 2 ? kept[0].name : pathOf(names, names.audio);
  if (!wordsKept) throw new Error('This recording is empty. Record again and press Done when you finish.');
  const job = recordingJob({ audioFile, transcriptFile: wordsKept.name, seconds, script, shareFile, calendarEvent, source: canonicalSource });
  const queue = await postJson<{ waiting_for_ai?: boolean; said?: string }>('/work/api/queue', { ...job, press_key: `record:${names.folder}/${names.audio}`, delivery: 'when-connected' });
  return { folder: names.folder, audioFile, transcriptFile: wordsKept.name, transcriptName: names.transcript, words: said, source: canonicalSource,
    ...(queue.waiting_for_ai && queue.said ? { queueSaid: queue.said } : {}) };
}

/** Keeps corrected words in place of a kept recording's transcript, then tells the person's AIs where they are. */
async function keepCorrection(kept: Kept, words: string, script: Script | null, calendarEvent: CalendarEvent, source: SourceReference | null): Promise<Kept> {
  const canonicalSource = source ? (await postJson<{ source: SourceReference | null }>('/work/api/content-formats/shape', { source: { kind: source.kind, id: source.id } })).source : null;
  if (source && !canonicalSource) throw new Error('That source is no longer available in this account.');
  const file = new File([transcriptFileText(words, script, calendarEvent, canonicalSource)], kept.transcriptName, { type: 'text/plain', lastModified: Date.now() });
  const [corrected] = await uploadFiles([file], kept.folder);
  if (!corrected) throw new Error('Write the words before saving them.');
  const queue = await postJson<{ waiting_for_ai?: boolean; said?: string }>('/work/api/queue', { ...correctedTranscriptJob({ audioFile: kept.audioFile, transcriptFile: corrected.name, source: canonicalSource }), press_key: `correct:${corrected.identity}`, delivery: 'when-connected' });
  return { ...kept, transcriptFile: corrected.name, words, source: canonicalSource, queueSaid: queue.waiting_for_ai ? queue.said : undefined };
}

/** The camera's picture while the Record control waits: opened when video is chosen, let go when it is not. */
function usePreview(source: CaptureSource | null, wanted: boolean, audioDeviceId: string, onProblem: (said: string) => void) {
  const [opened, setOpened] = React.useState<{ stream: MediaStream; sourceId: string; audioDeviceId: string } | null>(null);
  React.useEffect(() => {
    if (!source || !wanted || source.preview !== 'video') return undefined;
    let open: MediaStream | null = null;
    let gone = false;
    openSource(source, audioDeviceId ? { audio: audioDeviceId } : undefined).then(
      stream => { if (gone) { for (const track of stream.getTracks()) track.stop(); return; } open = stream; setOpened({ stream, sourceId: source.id, audioDeviceId }); },
      error => { if (!gone) onProblem(problemWords(error, source)); },
    );
    return () => {
      gone = true;
      // A picture handed to a recording is the recording's from then on; the recorder lets it go.
      if (open && !handedOver.has(open)) for (const track of open.getTracks()) track.stop();
      setOpened(null);
    };
  }, [source, wanted, audioDeviceId, onProblem]);
  return opened?.sourceId === source?.id && opened.audioDeviceId === audioDeviceId ? opened.stream : null;
}
const handedOver = new WeakSet<MediaStream>();

/** How the sending of a recording stands, redrawn as it changes. */
function useSendState(sending: Sending | null): SendState | null {
  const [state, setState] = React.useState<SendState | null>(null);
  React.useEffect(() => {
    if (!sending) { setState(null); return undefined; }
    setState(sending.state());
    return sending.onChange(() => setState(sending.state()));
  }, [sending]);
  return state;
}

/** Recordings this device holds for this account that were never finished; asked again once a reloaded tab's hold on
 *  its recording has run out. */
function useUnfinished(): [UnfinishedRecording[], (id: string) => void] {
  const [found, setFound] = React.useState<UnfinishedRecording[]>([]);
  React.useEffect(() => {
    let gone = false;
    // Pieces the background recorder left are its own to finish (always-recording.ts sendLeftOver), never kept here.
    const look = () => { void unfinishedRecordings(deviceAccount()).then(list => { if (!gone) setFound(list.filter(item => !isFeedPiece(item.keptWith))); }); };
    look();
    const again = window.setTimeout(look, 16_000);
    return () => { gone = true; window.clearTimeout(again); };
  }, []);
  return [found, id => setFound(current => current.filter(item => item.id !== id))];
}

/** What an unfinished recording is kept with: what it was kept with when it started, or, for a device copy that never
 *  said, the names any recording started at that moment gets, so no device copy is ever left unsavable. */
function keptWithOf(found: UnfinishedRecording): KeptWith {
  const keptWith = found.keptWith as KeptWith | null;
  if (keptWith?.names) return keptWith;
  return { names: keptNames(found.startedAt, { extension: endingOf(found.name) }), script: null, share: null, words: '' };
}

/** One recording found on this device that was never finished: it finishes saving by itself from the device copy as
 *  soon as the screen opens (sending only the pieces Files does not have yet) and is handed to the person's AIs. A save
 *  that cannot reach Files waits and goes on when the connection comes back; one refused says why, with Try again. */
function Unfinished({ found, onDone }: { found: UnfinishedRecording; onDone: () => void }) {
  const [state, setState] = React.useState<{ kind: 'working' | 'waiting' } | { kind: 'failed'; reason: string }>({ kind: 'working' });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let gone = false;
    const keptWith = keptWithOf(found);
    setState({ kind: 'working' });
    const device = reopenOnDevice(found);
    const sending = sendWhileRecording(device, growingFiles, found.upload?.name ?? pathOf(keptWith.names, keptWith.names.audio));
    const unhear = sending.onChange(() => { if (!gone) setState(sending.state().waiting ? { kind: 'waiting' } : { kind: 'working' }); });
    void keep(sending, keptWith.names, keptWith.words, found.seconds, keptWith.script, keptWith.share, null, keptWith.calendarEvent, keptWith.source ?? null).then(
      async () => {
        await device.forget();
        notify('A recording that had not finished saving is in your Files and with your AI', { kind: 'done' });
        if (!gone) onDone();
      },
      error => { sending.stop(); if (!gone) setState({ kind: 'failed', reason: refusedBecause(error) }); },
    ).finally(unhear);
    return () => { gone = true; };
    // One save per found recording and per Try again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found.id, attempt]);
  const said = `A recording from ${momentOf(found.startedAt)} (${minutesAndSeconds(found.seconds)})`;
  return (
    <Card variant="nested" padding="md" role="status" data-unfinished-recording="" data-unfinished-state={state.kind}>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap="wrap">
        <Text variant="body">
          {state.kind === 'failed' ? `${said} did not finish saving.` : state.kind === 'waiting' ? `${said} is saving as soon as you are back online.` : `Saving ${said.charAt(0).toLowerCase()}${said.slice(1)} that had not finished…`}
        </Text>
        {state.kind === 'failed' ? <Button variant="primary" size="sm" onClick={() => setAttempt(count => count + 1)}>Try again</Button> : null}
      </Container>
      {state.kind === 'failed' ? <Text as="p" variant="caption" color="error" role="alert">{state.reason}</Text> : null}
    </Card>
  );
}

const NO_SCRIPT = '';

function RecordScreen({ opened, meetingCode, quickRecord }: { opened: Opened; meetingCode: string; quickRecord: boolean }) {
  const screenRef = React.useRef<HTMLDivElement>(null);
  const { shared, formats, calendarEvent } = opened;
  // About a share, the person may read it as one of their formats: the script is that format about what was shared.
  const [readAs, setReadAs] = React.useState(NO_SCRIPT);
  const script = React.useMemo(() => {
    const format = shared ? formats.find(item => item.id === readAs) : null;
    return format && shared ? scriptFor(format, shared.about, shared.asked) : opened.script;
  }, [opened.script, shared, formats, readAs]);
  const { views, view, choose: chooseView } = useScriptView();
  const offered = React.useMemo(choices, []);
  const [choice, setChoice] = React.useState(offered[0]?.id ?? '');
  const savedChoice = useWorkspacePreference<string>(CAPTURE_SOURCE_PREFERENCE);
  const personChoseSource = React.useRef(false);
  const preferenceWrite = React.useRef(Promise.resolve());
  const [audioInputs, setAudioInputs] = React.useState<MediaDeviceInfo[]>([]);
  const [audioDeviceId, setAudioDeviceId] = React.useState('');
  const source = offered.find(one => one.id === choice)?.source ?? null;
  const [control, setControl] = React.useState<CaptureControlState>('idle');
  const [paused, setPaused] = React.useState(false);
  const [correction, setCorrection] = React.useState('');
  const [correcting, setCorrecting] = React.useState<Correcting>({ state: 'idle' });
  const [heard, setHeard] = React.useState({ final: '', hearing: '' });
  const [wordsNote, setWordsNote] = React.useState('');
  // Work handed to the person's AIs while recording: each finished stretch of words goes to them at once, through the
  // same queue every button uses (recording.json jobs.live_words, live_work), and its progress shows beside the words.
  const [moments, setMoments] = React.useState<Moment[]>([]);
  const handed = React.useRef({ words: 0, started: '' });
  // One meeting recorded from several devices (recording.json meeting): the space their turns meet in, whether this
  // device started it (only that one hands words to the AIs), its join link, and everyone's turns read back.
  const [meeting, setMeeting] = React.useState<Meeting | null>(null);
  const [joining, setJoining] = React.useState<'idle' | 'working' | 'failed'>('idle');
  const [together, setTogether] = React.useState<ReturnType<typeof meetingTurns>>([]);
  const device = React.useMemo(() => crypto.randomUUID(), []);
  const posted = React.useRef(0);
  // Seconds since the words last changed while recording, so what gathered goes once the speaker pauses (live_work.quiet_seconds).
  const [quietFor, setQuietFor] = React.useState(0);
  const [problem, setProblem] = React.useState('');
  const [saving, setSaving] = React.useState<Saving>({ state: 'idle' });
  const write = useWriteWithMyAI(script);
  const [made, setMade] = React.useState<Made | null>(null);
  const [session, setSession] = React.useState<Session | null>(null);
  const sessionRef = React.useRef<Session | null>(null);
  const startingCapture = React.useRef(false);
  sessionRef.current = session;
  const sendState = useSendState(session?.sending ?? null);
  const [unfinished, forgetUnfinished] = useUnfinished();
  const transcriptEnd = React.useRef<HTMLDivElement | null>(null);
  const preview = usePreview(source, control === 'idle' && !made, audioDeviceId, setProblem);

  React.useEffect(() => {
    if (personChoseSource.current || control !== 'idle' || saving.state !== 'idle' || made || session
      || !savedChoice || !offered.some(item => item.id === savedChoice)) return;
    setChoice(savedChoice);
  }, [offered, savedChoice, control, saving.state, made, session]);

  const chooseCaptureSource = React.useCallback((next: string) => {
    if (!offered.some(item => item.id === next) || control !== 'idle' || saving.state !== 'idle' || made || session) return;
    personChoseSource.current = true;
    setChoice(next);
    preferenceWrite.current = preferenceWrite.current.catch(() => {}).then(
      () => writeWorkspacePreference(CAPTURE_SOURCE_PREFERENCE, next),
    ).catch(() => {
      notify(settings.capture_source_preference.save_failed, { kind: 'error' });
    });
  }, [offered, control, saving.state, made, session]);

  React.useEffect(() => {
    const devices = typeof navigator === 'undefined' ? null : navigator.mediaDevices;
    if (!devices?.enumerateDevices) return undefined;
    let active = true;
    const refresh = async () => {
      try {
        const found = (await devices.enumerateDevices()).filter(device =>
          device.kind === 'audioinput' && device.deviceId && !['default', 'communications'].includes(device.deviceId));
        if (!active) return;
        setAudioInputs(found);
        setAudioDeviceId(current => current && !found.some(device => device.deviceId === current) ? '' : current);
      } catch { if (active) setAudioInputs([]); }
    };
    void refresh();
    devices.addEventListener?.('devicechange', refresh);
    return () => { active = false; devices.removeEventListener?.('devicechange', refresh); };
  }, [preview]);

  // The edit of the recording (spans of the recording made, in the order they play), and where the part being
  // recorded now goes: `at` seconds into the edit, from `from` seconds of the recording made.
  const [edit, setEdit] = React.useState<Span[]>([]);
  const editRef = React.useRef<Span[]>(edit);
  editRef.current = edit;
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;
  const [undo, setUndo] = React.useState<Span[][]>([]);
  const run = React.useRef({ at: 0, from: 0 });
  const timed = React.useRef<TimedWord[]>([]);
  const [opening, setOpening] = React.useState<Opening | null>(null);
  const [openingAttempt, setOpeningAttempt] = React.useState(0);
  const retryOpening = React.useCallback(() => {
    setOpening({ state: 'loading' });
    setOpeningAttempt(attempt => attempt + 1);
  }, []);
  const [position, setPosition] = React.useState(0);
  const [chosen, setChosen] = React.useState<Span | null>(null);
  const [playing, setPlaying] = React.useState<(() => void) | null>(null);
  const [repeatChosen, setRepeatChosen] = React.useState(false);
  const playback = React.useRef<{ request: number; pending: boolean; stop: (() => void) | null }>({ request: 0, pending: false, stop: null });
  const stopPlayback = React.useCallback(() => {
    playback.current.request += 1;
    playback.current.pending = false;
    playback.current.stop?.();
    playback.current.stop = null;
    setPlaying(null);
  }, []);
  const readElapsed = React.useCallback(() => sessionRef.current?.capture.elapsedMs() ?? 0, []);
  const recordedSeconds = () => readElapsed() / 1000;
  // The recording being kept, so Try again goes on with it after its session has ended.
  const keeping = React.useRef<{ running: Session; recorded: Recorded; said: string; edit: Span[] } | null>(null);
  // The sound recorded up to the current pause, decoded once for every edit made during that pause.
  const [pauses, setPauses] = React.useState(0);
  const decoded = React.useRef<{ pause: number; sound: AudioBuffer } | null>(null);

  // The teleprompter's place: the finished words are followed once and kept; the words still being heard are laid on
  // top of that place for this drawing only.
  const segments = React.useMemo(() => (script ? scriptSegments(script) : []), [script]);
  const words = React.useMemo(() => scriptWords(segments), [segments]);
  const settled = React.useRef({ place: START, read: 0 });
  // The words as shown and kept: a line heard again and again back to back reads once (heard-words.json).
  const loopFree = React.useRef(loopFreeWords());
  const shownFinal = React.useMemo(() => loopFree.current(heard.final), [heard.final]);
  const finalWords = React.useMemo(() => heardWords(heard.final), [heard.final]);
  if (finalWords.length < settled.current.read) settled.current = { place: START, read: 0 };
  if (finalWords.length > settled.current.read) settled.current = { place: follow(words, finalWords.slice(settled.current.read), settled.current.place), read: finalWords.length };
  const place = follow(words, heardWords(heard.hearing), settled.current.place);
  const prompter = script ? teleprompterInView(script, view, place) : null;

  React.useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: 'end' }); }, [heard]);
  // Leaving the screen while recording keeps what was recorded on this device: the microphone and camera are let go,
  // and the recording is offered again the next time Record opens.
  React.useEffect(() => {
    const leave = () => { const running = sessionRef.current; if (!running) return; running.sending.stop(); void running.device.release(); };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); const running = sessionRef.current; if (running) { leave(); running.capture.discard(); } };
  }, []);
  // The recording made plays from this tab's memory until another is made or the screen goes.
  React.useEffect(() => (made ? () => URL.revokeObjectURL(made.url) : undefined), [made]);
  // The words said so far go into the transcript file while recording, so an AI can read them before Done.
  const wordsSoFar = React.useRef('');
  wordsSoFar.current = shownFinal;
  React.useEffect(() => {
    if (!session) return undefined;
    let written = '';
    const timer = window.setInterval(() => {
      const words = wordsSoFar.current;
      if (!words.trim() || words === written) return;
      written = words;
      const keptWith: KeptWith = { names: session.names, script, share: shared?.identity ?? null, words, calendarEvent, source: opened.source };
      void session.device.setKeptWith(keptWith);
      void keepText(pathOf(session.names, session.names.transcript), transcriptFileText(words, script, calendarEvent, opened.source)).catch(() => undefined);
    }, settings.live_words_every_ms);
    return () => window.clearInterval(timer);
  }, [session, script, shared, calendarEvent, opened.source]);
  // The device keeps how long the recording runs, for a recording finished after a reload.
  React.useEffect(() => {
    if (!session || paused) return undefined;
    const timer = window.setInterval(() => session.device.setSeconds(session.capture.elapsedMs() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [session, paused]);

  // A paused voice recording opens as a timeline: the sound recorded so far is decoded and the edit made from it.
  const voice = (session?.capture.source ?? source)?.preview !== 'video';
  React.useEffect(() => {
    if (!session || !paused || !voice) { setOpening(null); return undefined; }
    let gone = false;
    let stopWaitingForOnline = () => {};
    setOpening(current => current ?? { state: 'loading' });
    void (async () => {
      try {
        const { decodeRecording, renderEdit } = await editorCode();
        const peaksOf = await loadCode(() => import('../../parts/ui/show/audio-timeline/AudioTimeline'), module => module.peaksOf);
        if (gone) return;
        if (decoded.current?.pause !== pauses) {
          const sound = await decodeRecording(await session.capture.soFar());
          if (gone) return;
          decoded.current = { pause: pauses, sound };
        }
        const recorded = decoded.current.sound;
        const heardEdit = await renderEdit(recorded, edit);
        if (!gone) setOpening({ state: 'ready', recorded, heard: heardEdit, peaks: peaksOf([heardEdit.getChannelData(0)], heardEdit.sampleRate, PEAKS_PER_SECOND) });
      } catch (error) {
        if (gone) return;
        setOpening({ state: 'failed', reason: errorWords(error, 'This recording cannot be shown here.'), ...(error instanceof CodeLoadFailure ? { code: error } : {}) });
        if (error instanceof CodeLoadFailure && error.reason === 'unreached') {
          stopWaitingForOnline = whenOnline(() => { if (!gone) retryOpening(); });
        }
      }
    })();
    return () => { gone = true; stopWaitingForOnline(); };
  }, [session, paused, voice, edit, pauses, openingAttempt, retryOpening]);
  React.useEffect(() => () => {
    playback.current.request += 1;
    playback.current.stop?.();
  }, []);

  const save = async (running: Session, recorded: Recorded, said: string, finalEdit: Span[]) => {
    setControl('working'); setSaving({ state: 'working' });
    const unhear = running.sending.onChange(() => {
      const state = running.sending.state();
      setSaving(current => (current.state === 'working' && state.waiting ? { state: 'waiting' } : current.state === 'waiting' && !state.waiting ? { state: 'working' } : current));
    });
    try {
      let edited: File | null = null;
      let words = said;
      // Only a voice recording is edited (the timeline opens for voice); a video is kept as it was made.
      const voiceOnly = running.capture.stream.getVideoTracks().length === 0;
      if (voiceOnly && finalEdit.length && !isWholeRecording(finalEdit, recorded.seconds)) {
        const { decodeRecording, renderEdit, wavFile } = await editorCode();
        const sound = await renderEdit(await decodeRecording(recorded.file), finalEdit, settings.edited.sample_rate);
        edited = wavFile(sound, editedName(running.names.audio), running.capture.startedAt.getTime());
        words = wordsOfEdit(finalEdit, timed.current) || said;
        setMade(current => { if (current) URL.revokeObjectURL(current.url); return { file: edited as File, url: URL.createObjectURL(edited as File) }; });
      }
      const saved = await keep(running.sending, running.names, words, editLength(finalEdit) || recorded.seconds, script, shared?.identity ?? null, edited, calendarEvent, opened.source);
      await running.device.forget();
      setCorrection(saved.words);
      setSaving({ state: 'saved', kept: saved });
      notify(saved.queueSaid ? `Recording saved. ${saved.queueSaid}` : 'Recording saved and sent to your AI', { kind: 'done' });
    } catch (error) {
      // A recording discarded while it waited is gone on purpose; only the recording still being kept can fail.
      if (keeping.current?.running === running) setSaving({ state: 'failed', reason: refusedBecause(error) });
    } finally { unhear(); setControl('idle'); }
  };
  // The part being recorded now joins the edit where it was started (the end, or the place Record here was pressed).
  const settledEdit = (current: Span[], until: number) => insertInto(current, run.current.at, { from: run.current.from, to: until });
  // The recording is finished (Done, or the browser stopped it): it is shown to play back and kept.
  const finished = (running: Session, recorded: Recorded, said: string) => {
    stopPlayback();
    setSession(null); setPaused(false); setOpening(null); setChosen(null); setRepeatChosen(false);
    if (said.trim()) setProblem(current => current === problemWords({ name: 'silent' }, running.capture.source) ? '' : current);
    running.device.setSeconds(recorded.seconds);
    void running.device.close();
    const finalEdit = pausedRef.current ? editRef.current : settledEdit(editRef.current, recorded.seconds);
    setEdit(finalEdit);
    setMade({ file: recorded.file, url: URL.createObjectURL(recorded.file) });
    keeping.current = { running, recorded, said, edit: finalEdit };
    void save(running, recorded, said, finalEdit);
  };
  const heardSoFar = React.useRef('');
  heardSoFar.current = heard.final;

  const start = async () => {
    if (!source || control !== 'idle' || sessionRef.current || startingCapture.current) return;
    startingCapture.current = true;
    stopPlayback();
    setControl('working');
    setSaving({ state: 'idle' }); setHeard({ final: '', hearing: '' }); setWordsNote(''); setProblem(''); setPaused(false); setCorrecting({ state: 'idle' });
    setMade(null); setEdit([]); setUndo([]); setChosen(null); setRepeatChosen(false); setOpening(null);
    run.current = { at: 0, from: 0 };
    timed.current = [];
    settled.current = { place: START, read: 0 };
    if (preview) handedOver.add(preview);
    // The browser is asked to keep this page's storage, so the device copy is not cleared to make room.
    void navigator.storage?.persist?.().catch(() => false);
    let startedSession: Session | null = null;
    const held: Blob[] = [];
    try {
      const running: Capture = await startCapture(source, {
        ...(preview ? { stream: preview } : {}),
        ...(audioDeviceId ? { audioDeviceId } : {}),
        onHeard: next => { setHeard(next); timed.current = timeNewWords(timed.current, next.final, (sessionRef.current?.capture.elapsedMs() ?? 0) / 1000); },
        onWordsUnavailable: setWordsNote,
        onProblem: setProblem,
        onQuietRecovered: () => setProblem(current => current === problemWords({ name: 'silent' }, source) ? '' : current),
        onEnded: (recorded, said) => { setProblem(said); if (startedSession) finished(startedSession, recorded, heardSoFar.current); },
        // Each piece goes to this device first; the sender sends only what the device holds.
        onPiece: piece => { if (startedSession) void startedSession.device.add(piece); else held.push(piece); },
      });
      const names = keptNames(running.startedAt, { formatLabel: script?.format_label ?? calendarEvent?.title ?? null, extension: endingOf(running.fileName) });
      const device = keepOnDevice({
        id: `record:${running.startedAt.getTime()}:${Math.random().toString(36).slice(2, 8)}`, name: names.audio, mediaType: running.mediaType,
        startedAt: running.startedAt, account: deviceAccount(), keptWith: { names, script, share: shared?.identity ?? null, words: '', calendarEvent, source: opened.source } satisfies KeptWith,
      });
      for (const piece of held.splice(0)) void device.add(piece);
      startedSession = { capture: running, device, sending: sendWhileRecording(device, growingFiles, pathOf(names, names.audio)), names };
      sessionRef.current = startedSession;
      setSession(startedSession);
      setControl('recording');
    } catch (error) {
      setProblem(problemWords(error, source));
      setControl('idle');
    } finally {
      startingCapture.current = false;
    }
  };
  const requestedStart = React.useRef(start);
  requestedStart.current = start;
  const quickStartAttempted = React.useRef(false);
  React.useEffect(() => {
    if (!quickRecord || quickStartAttempted.current || !source || control !== 'idle' || session || made) return;
    quickStartAttempted.current = true;
    void requestedStart.current();
  }, [quickRecord, source, control, session, made]);
  const done = async () => {
    const running = session;
    if (!running) return;
    setControl('working');
    finished(running, await running.capture.stop(), shownFinal);
  };
  const discard = () => {
    const running = session;
    stopPlayback();
    if (running) {
      running.capture.discard();
      void running.sending.cancel().then(() => running.device.forget());
      if (heard.final.trim()) void removeNames([pathOf(running.names, running.names.transcript)]).catch(() => undefined);
    }
    const last = keeping.current;
    if (!running && last) {
      void last.running.sending.cancel().then(() => last.running.device.forget());
      void removeNames([pathOf(last.running.names, last.running.names.transcript)]).catch(() => undefined);
    }
    keeping.current = null;
    setSession(null);
    setControl('idle'); setPaused(false); setHeard({ final: '', hearing: '' }); setSaving({ state: 'idle' }); setProblem(''); setMade(null);
    setEdit([]); setUndo([]); setChosen(null); setRepeatChosen(false); setOpening(null);
  };
  // Pausing settles the part just recorded into the edit; going on records the next part at `at` (the end by default).
  const pause = () => {
    if (!session) return;
    session.capture.pause();
    setEdit(current => settledEdit(current, recordedSeconds()));
    setPosition(Number.POSITIVE_INFINITY);
    setPauses(count => count + 1);
    setPaused(true);
  };
  const resumeAt = (at: number | null) => {
    if (!session) return;
    stopPlayback();
    run.current = { at: at ?? editLength(edit), from: recordedSeconds() };
    setChosen(null); setRepeatChosen(false);
    session.capture.resume();
    setPaused(false);
  };
  const retry = () => {
    const last = keeping.current;
    if (!last) return;
    last.running.sending.retry();
    void save(last.running, last.recorded, last.said, last.edit);
  };
  const saveCorrection = async () => {
    if (saving.state !== 'saved') return;
    setCorrecting({ state: 'working' });
    try {
      const corrected = await keepCorrection(saving.kept, correction.trim(), script, calendarEvent, opened.source);
      setSaving({ state: 'saved', kept: corrected });
      setCorrecting({ state: 'idle' });
      notify(corrected.queueSaid ? `Corrected words saved. ${corrected.queueSaid}` : 'Corrected words saved and sent to your AI', { kind: 'done' });
    } catch (error) {
      setCorrecting({ state: 'failed', reason: refusedBecause(error) });
    }
  };

  // The timeline's controls: play from the place, choose a part, cut it, undo, record here.
  const heardLength = opening?.state === 'ready' ? opening.heard.duration : editLength(edit);
  const at = Math.min(position, heardLength);
  const togglePlay = async () => {
    if (playback.current.stop || playback.current.pending) { stopPlayback(); return; }
    if (opening?.state !== 'ready') return;
    const request = ++playback.current.request;
    playback.current.pending = true;
    try {
      const { playFrom } = await editorCode();
      if (playback.current.request !== request) return;
      const from = chosen ? chosen.from : at >= heardLength - 0.05 ? 0 : at;
      let ended = false;
      const stop = playFrom(opening.heard, from, setPosition, () => {
        ended = true;
        if (playback.current.request === request) {
          playback.current.pending = false;
          playback.current.stop = null;
          setPlaying(null);
        }
      }, { range: chosen ?? undefined, loop: !!chosen && repeatChosen });
      if (!ended) { playback.current.stop = stop; setPlaying(() => stop); }
    } catch (error) {
      if (playback.current.request === request) notify(errorWords(error, 'This recording cannot be played here.'), { kind: 'error' });
    } finally {
      if (playback.current.request === request) playback.current.pending = false;
    }
  };
  const choosePart = () => {
    stopPlayback();
    const from = at >= heardLength - 0.05 ? Math.max(0, heardLength - CHOSEN_SECONDS) : at;
    setChosen({ from, to: Math.min(heardLength, from + CHOSEN_SECONDS) });
  };
  const cutChosen = () => {
    if (!chosen) return;
    stopPlayback();
    setUndo(current => [...current, edit]);
    setEdit(current => cutFrom(current, chosen.from, chosen.to));
    setPosition(chosen.from);
    setChosen(null); setRepeatChosen(false);
  };
  const undoLast = () => {
    stopPlayback();
    const last = undo[undo.length - 1];
    if (!last) return;
    setUndo(undo.slice(0, -1));
    setEdit(last);
    setChosen(null); setRepeatChosen(false);
  };

  const recording = session !== null;
  const video = !voice;
  useFocusContainerWhile(recording && video && !!script, screenRef, 600);
  const said = [shownFinal, heard.hearing].filter(Boolean).join(' ');
  const listening = paused ? 'Paused. Press Resume to go on.' : wordsNote ? 'Recording. Your words will be in the transcript your AI reads.' : 'Listening…';
  const edited = saving.state === 'saved' && correction.trim() !== saving.kept.words.trim();
  const live = session?.capture.stream ?? preview;
  const kept = session ? session.device : null;
  const keptLine = !recording || !sendState ? null
    : sendState.problem ? `Saved on this device. ${sendState.problem}`
      : sendState.waiting ? 'Saved on this device. It goes to your Files when you are back online.'
        : sendState.sent > 0 ? `In your Files as you speak: ${kept?.name ?? ''}` : 'Saved on this device as you speak.';

  // While recording: the script (when there is one) and the live words, over the picture for video. The script shows
  // only while the recording runs: a pause, or a camera that stopped, takes it away at once (teleprompterIsLive).
  const scriptLive = video
    ? teleprompterIsLive({ mode: 'video', recording, paused, captureActive: session?.capture.stream.getVideoTracks().some(track => track.readyState === 'live') ?? false })
    : recording && !paused;
  const teleprompter = scriptLive && script && prompter ? (
    // Over a picture the script never grows past it: its scrolling words give up height first.
    <Container data-teleprompter="" data-script-view={view.id} pointerEvents="none" minHeight="0" className="max-h-full">
      <CaptionScroll
        className="max-h-full"
        segments={prompter.segments}
        activeWordIndex={prompter.activeWordIndex}
        spokenWordCount={prompter.spokenWordCount}
        progress={prompter.progress}
        statusLabel={view.label}
        metaLabel={script.lines.map(line => line.label).join(' · ')}
      />
    </Container>
  ) : null;
  const viewChoice = script && views.length > 1 && !(recording && paused) && !made ? (
    <Container layout="horizontal" justifyContent="center">
      <SegmentedControl ariaLabel="How to read the script" items={views.map(({ id, label }) => ({ id, label }))} value={view.id} onValueChange={chooseView} />
    </Container>
  ) : null;
  React.useEffect(() => {
    setQuietFor(0);
    if (!recording) return;
    const timer = window.setTimeout(() => setQuietFor(settings.live_work.quiet_seconds), settings.live_work.quiet_seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [recording, heard.final, heard.hearing]);
  React.useEffect(() => {
    if (!recording) { handed.current = { words: 0, started: '' }; setMoments(list => (list.length ? [] : list)); return; }
    if (!handed.current.started) handed.current.started = new Date().toISOString();
    if (meeting && !meeting.mine) return;
    const final = meeting ? together.map(turn => turn.text).join(' ') : heard.final;
    const stretch = liveStretch({ final, hearing: meeting ? '' : heard.hearing, handed: handed.current.words, quiet: quietFor });
    if (!stretch) return;
    const { start } = stretch;
    handed.current.words = stretch.end;
    // One line on repeat (a speaker playing it near the microphone) is not something said for work: it is passed over.
    if (stretch.repeated) return;
    const job = liveWorkJob(stretch, handed.current.started, moments.flatMap(item => item.state === 'error' || item.note === 'nothing to act on' ? [] : [item.state === 'done' ? item.note : `Being worked on now: ${item.heading}`]));
    const heading = job.context.heading;
    const key = `live:${handed.current.started}:${start}`;
    setMoments(list => [...list, { key, heading, state: 'pending', note: '' }]);
    const mark = (state: Moment['state'], note: string) => setMoments(list => list.map(item => item.key === key ? { ...item, state, note } : item));
    postJson('/work/api/queue', { ...job, press_key: key })
      .then(() => mark('sent', 'Sent to your AI'), error => mark('error', refusedBecause(error)));
  }, [recording, heard.final, heard.hearing, meeting, together, quietFor]);
  // A meeting link (Record's `route_query`, on any address) opens Record with the meeting's invite code, joined to it.
  React.useEffect(() => {
    const code = meetingCode;
    if (!code || meeting) return;
    setJoining('working');
    postJson<{ space_id?: string; space?: { space_id?: string } }>(`/work/api/spaces/join/${encodeURIComponent(code)}`, {})
      .then(answer => { const id = answer.space_id ?? answer.space?.space_id; if (!id) throw new Error('That meeting link did not open a meeting.'); setMeeting({ space_id: id, mine: false, link: '' }); setJoining('idle'); })
      .catch(error => { setJoining('failed'); notify(`Could not join the meeting: ${refusedBecause(error)}`, { kind: 'error' }); });
  }, []);
  const recordWithOthers = async () => {
    setJoining('working');
    try {
      const started = await postJson<{ space_id?: string; space?: { space_id?: string } }>('/work/api/spaces/start', { title: `${settings.meeting.title} ${new Date().toLocaleString()}` });
      const id = started.space_id ?? started.space?.space_id;
      if (!id) throw new Error('The meeting could not be started.');
      // The invite answers with the space's own join address; its code is what opens this meeting on Record.
      const invite = await postJson<{ url: string }>(`/work/api/spaces/${encodeURIComponent(id)}/invites`, {});
      const code = new URL(invite.url).searchParams.get('join');
      if (!code) throw new Error('The meeting link could not be made.');
      // The link is Record's own address, never the page's current one (which may be any screen's).
      const link = new URL(RECORD_ROW.route_paths[0], window.location.origin);
      link.searchParams.set(MEETING_FIELD, code);
      setMeeting({ space_id: id, mine: true, link: link.href });
      setJoining('idle');
    } catch (error) { setJoining('failed'); notify(`Could not start recording with others: ${refusedBecause(error)}`, { kind: 'error' }); }
  };
  // While recording in a meeting: every finished turn this device hears goes to the meeting's space, and everyone's
  // turns are read back into one transcript.
  React.useEffect(() => {
    if (!recording || !meeting) { posted.current = 0; return; }
    const words = heard.final.trim().split(/\s+/).filter(Boolean);
    if (words.length <= posted.current) return;
    const text = words.slice(posted.current).join(' ');
    posted.current = words.length;
    void postJson(`/work/api/spaces/${encodeURIComponent(meeting.space_id)}/items`, { items: [{ kind: settings.meeting.item_kind, body: { text, device, at: new Date().toISOString() } }] }).catch(() => undefined);
  }, [recording, meeting, heard.final]);
  React.useEffect(() => {
    if (!recording || !meeting) return;
    const read = () => readJson<{ items?: unknown[] }>(`/work/api/spaces/${encodeURIComponent(meeting.space_id)}/items?kind=${settings.meeting.item_kind}&limit=${settings.meeting.read_limit}`)
      .then(answer => setTogether(meetingTurns((answer.items ?? []) as Parameters<typeof meetingTurns>[0])), () => undefined);
    void read();
    const timer = window.setInterval(() => { void read(); }, settings.meeting.read_every_ms);
    return () => window.clearInterval(timer);
  }, [recording, meeting]);
  // While recording, what the AIs did with each stretch is read back from AI work (the jobs' `said` names them).
  React.useEffect(() => {
    if (!recording || !moments.length) return;
    const check = async () => {
      const rows: { said?: string | null; state?: string; summary?: string | null; result?: unknown }[] = [];
      const collect = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') {
          const row = value as Record<string, unknown>;
          if (typeof row.handoff_id === 'string') rows.push(row as typeof rows[number]); else Object.values(row).forEach(collect);
        }
      };
      collect(await readJson<unknown>('/work/api/ai-work').catch(() => null));
      setMoments(list => list.map(item => {
        if (item.state === 'error') return item;
        const row = rows.find(one => one.said === `Act on "${item.heading}"`);
        if (!row) return item;
        if (row.state === 'finished') {
          const outcome = row.result && typeof row.result === 'object' ? (row.result as Record<string, unknown>) : null;
          const result = typeof row.summary === 'string' && row.summary ? row.summary
            : typeof row.result === 'string' ? row.result
            : typeof outcome?.outcome === 'string' ? outcome.outcome : typeof outcome?.summary === 'string' ? outcome.summary : 'Done';
          const shown = row.result ?? result;
          const summary = row.summary && row.summary !== shown && row.summary !== outcome?.summary && row.summary !== outcome?.outcome
            ? row.summary : null;
          return { ...item, state: 'done', note: result, result: summary ? { summary, result: shown } : shown };
        }
        return { ...item, state: 'sent', note: row.state === 'taken' ? 'Your AI is on it' : 'Sent to your AI' };
      }));
    };
    const timer = window.setInterval(() => { void check(); }, settings.live_work.check_every_ms);
    return () => window.clearInterval(timer);
  }, [recording, moments.length]);
  const meetingBar = !recording && !made ? (
    meeting ? (
      <Card variant="nested" padding="md" aria-label="Recording with others">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Container flex={1} minWidth="0">
            <Text as="p" variant="body">{meeting.mine ? 'Others join by opening this link on their phone or laptop, then pressing Record.' : 'You joined the meeting. Press Record.'}</Text>
          </Container>
          {meeting.mine ? <CopyButton text={meeting.link} label="Copy link" copiedLabel="Copied" /> : null}
        </Container>
      </Card>
    ) : (
      <Container layout="horizontal" justifyContent="center">
        <Button variant="secondary" work={null} disabled={joining === 'working'} onClick={() => recordWithOthers()}>
          {joining === 'working' ? 'Starting…' : joining === 'failed' ? 'Try again: record with others' : 'Record with others'}
        </Button>
      </Container>
    )
  ) : null;
  const everyone = recording && meeting && together.length ? (
    <Card variant="nested" padding="lg" aria-label="Everyone in this meeting" aria-live="polite">
      <Container layout="vertical" gap="sm">
        <Text as="p" variant="body" color="muted">Everyone in this meeting</Text>
        {together.map(turn => (
          <Container key={`${turn.at}:${turn.devices.join(',')}`} layout="vertical" gap="xs">
            <Text as="p" variant="body" color="muted">{turn.who.join(' and ') || 'Someone'}{turn.devices.length > 1 ? ` · heard on ${turn.devices.length} devices` : ''}</Text>
            <Text as="p" variant="body">{turn.text}</Text>
          </Container>
        ))}
      </Container>
    </Card>
  ) : null;
  const liveWork = recording && moments.length ? (
    <Card variant="nested" padding="lg" aria-label="What your AI is doing" aria-live="polite">
      <Container layout="vertical" gap="sm">
        <Text as="p" variant="body" color="muted">What your AI is doing</Text>
        {moments.map(item => (
          <Container key={item.key} layout="vertical" gap="xs">
            <Text as="p" variant="body">{item.heading}</Text>
            {item.state === 'done' ? <SchemaValueView value={item.result ?? item.note} /> : (
              <Text as="p" variant="body" color={item.state === 'error' ? 'error' : 'muted'}>
                {item.state === 'pending' ? 'Sending to your AI…' : item.note}
              </Text>
            )}
          </Container>
        ))}
      </Container>
    </Card>
  ) : null;
  // The words take the whole width; copying them is a small mark in the corner.
  const liveWords = recording ? (
    <Card variant="nested" padding="lg" aria-label="What you said" aria-live="polite" position="relative" {...(video ? {} : { flex: 1, className: 'overflow-y-auto', style: { minHeight: TRANSCRIPT_MIN_HEIGHT } })}>
      {said ? (
        <>
          <Container className="absolute end-2 top-2"><CopyButton text={said} label="Copy words" copiedLabel="Copied" iconOnly /></Container>
          <Text as="p" variant="body-lg" wrap="preserve" className="pe-8">
            {shownFinal}{shownFinal && heard.hearing ? ' ' : ''}<Text as="span" variant="body-lg" color="muted">{heard.hearing}</Text>
          </Text>
        </>
      ) : <Text as="p" variant="body" color="muted">{listening}</Text>}
      <Container ref={transcriptEnd} />
    </Card>
  ) : null;
  const openingNotice = opening?.state === 'failed' && opening.code ? codeFailureNotice(opening.code.reason, retryOpening) : null;
  const timeline = recording && paused && voice ? (
    <Card variant="nested" padding="md" data-recording-timeline="">
      {opening?.state === 'ready' ? (
        <Container layout="vertical" gap="sm">
          <React.Suspense fallback={null}>
            <AudioTimeline
              peaks={opening.peaks}
              peaksPerSecond={PEAKS_PER_SECOND}
              duration={heardLength}
              position={at}
              onPositionChange={seconds => { stopPlayback(); setPosition(seconds); }}
              selection={chosen ? { start: chosen.from, end: chosen.to } : null}
              onSelectionChange={span => { stopPlayback(); setChosen({ from: span.start, to: span.end }); }}
              label="Your recording so far"
            />
          </React.Suspense>
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="center" wrap="wrap">
            <Button variant="secondary" size="sm" onClick={() => { togglePlay(); }}>{playing ? 'Stop' : chosen ? 'Play chosen part' : 'Play'}</Button>
            {chosen
              ? <Button variant="secondary" size="sm" onClick={cutChosen}>Cut this part</Button>
              : <Button variant="ghost" size="sm" onClick={choosePart}>Choose a part</Button>}
            {chosen ? <Button variant="ghost" size="sm" active={repeatChosen} onClick={() => { stopPlayback(); setRepeatChosen(value => !value); }}>Repeat chosen part</Button> : null}
            {chosen ? <Button variant="ghost" size="sm" onClick={() => { stopPlayback(); setChosen(null); setRepeatChosen(false); }}>Keep it</Button> : null}
            {undo.length ? <Button variant="ghost" size="sm" onClick={undoLast}>Undo</Button> : null}
            {at < heardLength - 0.05 ? <Button variant="primary" size="sm" onClick={() => resumeAt(at)}>Record here</Button> : null}
          </Container>
        </Container>
      ) : opening?.state === 'failed'
        ? openingNotice
          ? <ScreenState state={{ status: 'unavailable', inline: true, title: openingNotice.why, description: openingNotice.then, retry: openingNotice.action }} />
          : <Text as="p" variant="caption" color="muted">{opening.reason}</Text>
        : <Text as="p" variant="caption" color="muted">Opening your recording…</Text>}
    </Card>
  ) : null;
  // A restored split workspace can give Record only half a phone screen. While recording, one small bar above the
  // picture and the words holds the time, the live waveform, Pause, Discard and Done, so they stay reachable without
  // scrolling; before recording, the one Record control starts it.
  const captureActions = recording ? (
    <RecordingBar
      stream={session.capture.stream}
      active={!paused}
      readElapsedMs={readElapsed}
      actions={[
        { id: 'pause', label: paused ? 'Resume' : 'Pause', icon: paused ? 'Mic' : 'Pause', onPress: paused ? () => resumeAt(null) : pause },
        { id: 'discard', label: 'Discard', icon: 'X', onPress: discard },
        { id: 'done', label: 'Done', icon: 'Check', main: true, onPress: () => void done(), disabled: saving.state === 'failed' || saving.state === 'waiting' },
      ]}
    />
  ) : (
    <Container layout="horizontal" justifyContent="center" aria-label="Recording controls">
      <CaptureControl
        state={control}
        onStart={() => void start()}
        disabled={saving.state === 'failed' || saving.state === 'waiting' || !source}
        startLabel={made ? 'Record again' : 'Record'}
        workingLabel="Saving your recording…"
      />
    </Container>
  );

  return (
    <Container ref={screenRef} layout="vertical" height="full" gap="md" padding="lg" minHeight="0" overflow="y-auto" data-record-screen="">
      <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between">
        <Container layout="vertical" gap="xs" flex={1} style={{ minWidth: 0 }}>
          <Text variant="title">{script ? script.format_label : shared ? 'Record about what you shared' : calendarEvent ? `Record: ${calendarEvent.title}` : 'Record'}</Text>
          {calendarEvent ? <Text variant="caption" data-record-calendar-context>{new Date(calendarEvent.starts_at).toLocaleString()} · {settings.calendar_context_hint}</Text> : null}
          {script?.about ? <Text variant="body" color="muted" truncate>{script.about}</Text> : null}
          {shared && !script && shared.about ? <Text variant="body" color="muted" truncate>{shared.about}</Text> : null}
          {shared?.asked ? <Text variant="caption" color="muted" truncate>Your AI will: {shared.asked}</Text> : null}
        </Container>
        {!recording ? write.button : null}
      </Container>
      {write.run}

      {unfinished.map(found => <Unfinished key={found.id} found={found} onDone={() => forgetUnfinished(found.id)} />)}

      {shared && formats.length && !recording && control === 'idle' && !made ? (
        <Container layout="horizontal" justifyContent="center">
          <Select value={readAs} onValueChange={value => setReadAs(typeof value === 'string' ? value : NO_SCRIPT)}>
            <SelectTrigger aria-label="Read it as"><SelectValue>{script ? `Read it as ${script.format_label}` : 'Read it as…'}</SelectValue></SelectTrigger>
            <SelectPopup>
              <SelectItem value={NO_SCRIPT}>No script</SelectItem>
              {formats.map(format => <SelectItem key={format.id} value={format.id}>{format.label}</SelectItem>)}
            </SelectPopup>
          </Select>
        </Container>
      ) : null}

      {!recording && control === 'idle' && !made && offered.length > 1 ? (
        <Container layout="horizontal" justifyContent="center">
          <SegmentedControl ariaLabel="What to record" items={offered.map(({ id, label }) => ({ id, label }))} value={choice} onValueChange={chooseCaptureSource} />
        </Container>
      ) : null}

      {viewChoice}

      {!recording && !made ? <ListenHere /> : null}
      {meetingBar}
      {(recording || video) ? captureActions : null}

      {!recording && control === 'idle' && !made && audioInputs.length > 1 ? (
        <Container layout="horizontal" justifyContent="center">
          <Select value={audioDeviceId} onValueChange={value => setAudioDeviceId(typeof value === 'string' ? value : '')}>
            <SelectTrigger aria-label="Microphone">
              <SelectValue>{audioInputs.find(device => device.deviceId === audioDeviceId)?.label || 'Default microphone'}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">Default microphone</SelectItem>
              {audioInputs.map((device, index) => <SelectItem key={device.deviceId} value={device.deviceId}>
                {device.label || `Microphone ${index + 1}`}
              </SelectItem>)}
            </SelectPopup>
          </Select>
        </Container>
      ) : null}

      {video && !made && live ? (
        // Video: the picture fills the screen; while recording, the script and the words sit over it.
        <Container position="relative" flex={1} minHeight="0" rounded="lg" overflow="hidden" style={{ minHeight: '18rem' }}>
          <React.Suspense fallback={null}>
            <MediaFrame stream={live} mediaType="video/webm" label="Your camera" muted autoPlay playsInline mirrored={(session?.capture.source ?? source)?.mirrored ?? false} fill />
          </React.Suspense>
          {recording ? (
            // With a script, the script itself follows the words said; without one, the words show at the bottom.
            <Container position="absolute" inset="0" layout="vertical" justifyContent={teleprompter ? 'start' : 'end'} padding="md" zIndex="10">
              {teleprompter ?? <Container background="overlay" rounded="lg">{liveWords}</Container>}
            </Container>
          ) : null}
        </Container>
      ) : null}
      {video ? everyone : null}
      {video ? liveWork : null}

      {!video && recording ? (
        <>
          {teleprompter}
          {timeline}
          {liveWords}
          {everyone}
          {liveWork}
        </>
      ) : null}

      {made ? (
        <Container layout="vertical" gap="md" flex={1} minHeight="0">
          <React.Suspense fallback={null}>
            <FilePreview url={made.url} contentType={made.file.type} label={made.file.name} />
          </React.Suspense>
          {saving.state === 'saved' ? (
            // The words keep the whole width after Done too; copying them is the same small mark in the corner.
            <Container position="relative" width="full">
              <Textarea
                aria-label="Correct your words"
                value={correction}
                rows={5}
                className="pe-10"
                disabled={correcting.state === 'working'}
                onChange={event => { setCorrection(event.target.value); if (correcting.state === 'failed') setCorrecting({ state: 'idle' }); }}
              />
              <Container className="absolute end-2 top-2"><CopyButton text={correction} label="Copy words" copiedLabel="Copied" iconOnly /></Container>
            </Container>
          ) : null}
        </Container>
      ) : null}

      {recording && keptLine ? <Text as="p" variant="caption" color="muted" role="status" data-recording-kept="">{keptLine}</Text> : null}
      {recording && wordsNote ? <Text as="p" variant="caption" color="muted" role="status">{wordsNote}</Text> : null}
      {problem ? <Text as="p" variant="body" color="error" role="alert">{problem}</Text> : null}
      {saving.state === 'waiting' ? (
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="center" wrap="wrap" role="status">
          <Text variant="body">Saved on this device. It goes to your Files when you are back online.</Text>
          <Button variant="ghost" size="sm" onClick={discard}>Discard</Button>
        </Container>
      ) : null}
      {saving.state === 'saved' ? (
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="center" wrap="wrap" role="status">
          <Text variant="body">{saving.kept.queueSaid ? `Saved in Files under ${saving.kept.folder}. ${saving.kept.queueSaid}` : `Saved in Files under ${saving.kept.folder} and sent to your AI.`}</Text>
          {edited ? (
            <Button variant="primary" size="sm" disabled={correcting.state === 'working'} onClick={() => saveCorrection()}>
              {correcting.state === 'working' ? 'Saving…' : 'Save corrected words'}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={goTo('Open Files', FILES_SCREEN).run}>Open Files</Button>
        </Container>
      ) : null}
      {correcting.state === 'failed' ? (
        <Text as="p" variant="body" color="error" role="alert">Your corrected words are still here. {correcting.reason}</Text>
      ) : null}
      {saving.state === 'failed' ? (
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="center" wrap="wrap" role="alert">
          <Text variant="body" color="error">Your recording is still here. {saving.reason}</Text>
          <Button variant="primary" size="sm" onClick={retry}>Try again</Button>
          <Button variant="ghost" size="sm" onClick={discard}>Discard</Button>
        </Container>
      ) : null}

      {!recording && !video ? captureActions : null}
    </Container>
  );
}

function RecordRoot({ input }: { input: Input }) {
  const key = JSON.stringify([
    ...[input.format_id, input.about, input.material, input.share, input.meeting, input.quick_record].map(text), JSON.stringify(input.source ?? null),
    calendarRecordingContext(input.calendar_event),
  ]);
  const loaded = useScreenLoad(key, {
    loading: { label: text(input.share) ? 'Opening what you shared' : 'Loading your script', layout: 'editor' },
    read: () => readOpened(input),
    failed: text(input.share) ? refusal('What you shared could not open')
      : refusal('Your script could not load'),
  });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <RecordScreen key={key} opened={loaded.value} meetingCode={text(input.meeting)} quickRecord={input.quick_record === '1'} />;
}

export function mountRecordScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}): () => void {
  return mountReactSurface(element, <RecordRoot input={props.surfaceInput ?? {}} />);
}
