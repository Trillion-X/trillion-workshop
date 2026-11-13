// src/workspace/file-screen.tsx
//
// PURPOSE
//   One file in its own tab, shown by the one file preview (parts/ui/show/file-preview): a video or sound plays in the
//   shared player, and a picture, PDF, text or code file, or Office document shows; anything else is its card with
//   Download. The path above it (Files, its folders, its name) goes back to any of those folders in the Files tab;
//   Share beside the path opens the one sharing sheet (sharing-sheet.tsx) for the stored file.
//   A file dropped from the computer onto the screen arrangement opens here at once from the dropped bytes, is put
//   into the person's Files, and the tab then takes that file's own address, so it reopens after a reload.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A stored file is read by range from the person's namespace (/work/api/namespace/bytes/<identity>, the same
//      address the Files pictures use), so it starts at once and seeks anywhere without downloading the whole file.
//   2. What the file is (its media type, its names) comes from the Worker's answer for that identity; a tab opened
//      from its own address (/file/<identity>) reads it the same way. What the opener said fills in only until then.
//   3. A dropped file is uploaded the one way every uploader does (upload.ts); the tab changes to the stored file only
//      after the Worker says it is stored, and says so in words when the upload stops.
//   4. Every control is a shared component (breadcrumb, Button, FilePreview, empty and loading states, notifications).
//   5. A stored file this tab shows is kept as opened on the person's Recent screen, and as watched once it has really
//      played for a few seconds (file-uses.ts); the store stamps each time.
//   6. A stored recording's kept words (its `transcript` result, the transcription tool's own) are handed to the
//      player once read, so they show with it, following the sound; a file without them shows the player alone.
//   7. Under it is the same file card every hover preview shows (file-card.ts), in full: its facts, the tools this
//      person can use on it, who is in it and what each person said.
//   8. The file shows at once when its opener named it and its type (open-screen.ts fileTab): no read stands between
//      the tab and the bytes. The tab is titled with the file's name (the person's files, else the opener's, else
//      "Unnamed file"), never its identity, and a video shows its poster before play.
//   9. Beside it on a wide pane, under it on a narrow one, is what was said about the stored file and the box to say
//      more (say-about-this.tsx): on a recording each note is kept at the moment the player is on and plays from there.
//      Every file opened anywhere (Media, Files, search, a message) opens here, so every one has it.

import React from 'react';
import { Button, Container, NamedIcon, Text } from '../../parts/ui';
import { MeetingReviewTabs } from '../../parts/ui/show/meeting-review/MeetingReviewTabs';
import type { MeetingReviewTab } from '../../parts/ui/show/meeting-review/MeetingReviewTabs';
import { mountFilePreview } from '../../parts/ui/show/file-preview/mount-file-preview';
import { releaseNode } from '../../parts/ui/show/one-owner-per-node';
// A PDF opened here draws its pages through the reader this page serves.
import './pdf-reader-served';
import { mountSharedContent } from '../../parts/ui/show/coss/shared-content';
import { MediaCarousel } from '../../parts/ui';
import { FilePreview } from '../../parts/ui/show/file-preview/FilePreview';
import { FileCardFor } from '../../parts/ui/show/file-card';
import { mountBreadcrumb } from '../../parts/ui/show/breadcrumb/mount-breadcrumb';
import { loadScreen, mountScreenState } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { readPlaceableSurfaceSubject } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-subject';
import { readFileLookup, readJson, fileResults } from './api';
import { sendQueuedJob } from './queue-job';
import { previewStore } from './made-previews';
import { reasonOf, refusal } from './failure';
import { goTo, fileTab, openScreenOn } from './open-screen';
import { readRecordingOwnerForFileFromOwner, readRecordingMeetingAssociation, readRecordingMeetingAssociationFromOwner, replaceRecordingTranscript } from './recordings';
import { clearRecordingMeetingContext, setRecordingMeetingContext } from '../../parts/record-audio/do-work/record-audio-requests';
import { meetingContextOfCalendarItem, type MeetingCalendarContext } from '../../../../record-voice-and-meetings/do-work/meeting-join-recording.ts';
import { MeetingAssociationPanel } from '../../parts/record-audio/show/MeetingAssociationPanel';
import { momentInWords, stretchInWords } from '../../parts/ui/show/relative-time/relative-time';
import { MeetingNoteMetadata } from '../../parts/record-audio/show/MeetingNoteMetadata';
import { ArrangedContents } from '../../parts/screen-arrangement/show/ArrangedContents';
import { subscribeRecordChanges } from './records';
import { uploadFiles } from './upload';
import { keepFileUse, whenWatched } from './file-uses';
import { NoteShareRow, openSharing } from './sharing-sheet';
import { DockedComposer } from './global-composer';
import { SayAboutThis, isRecording, type PlayClock } from './say-about-this';
import { NoteTranscript } from './note-transcript';
import { canEditTextDocument, EditableTextDocument } from './editable-text-document';
import type { FilePreviewProps } from '../../parts/ui/show/file-preview/FilePreview';
import { timedTextOf } from '../../parts/media-playback/read-data/kept-timed-text';
import { wordsOfRecording, type TimedPassage } from './media-transcribe';
import { ProcessingStepsPill } from '../../parts/record-audio/show/ProcessingStepsPill';
import { processingSteps, recordingFacts, type WordsState } from '../../parts/record-audio/read-data/processing-steps';
import widgets from '../../parts/record-audio/read-data/recording-widgets.json';
import { AI_WORK, onStoreChange } from './store-changes';
import meetingReview from './meeting-review.json' with { type: 'json' };
import { ActionItemsPanel, SummaryChoices, SummaryTools, useOwnTemplates, type SummaryChoice } from './note-review-tools';
import { actionItemsOf, summaryAsk } from './note-review.mjs';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Found = { identity: string; media_type: string | null; names?: string[]; byte_length?: number };
type KeptWords = { results: { value: { segments?: TimedPassage[] } }[] };

// Where a dropped file is kept in the person's Files.
const DROPPED_INTO = '/';

// Files, then each folder above the file, then the file itself, as breadcrumb steps (a folder's id is its path).
function pathSteps(name: string) {
  const parts = name.split('/').filter(Boolean);
  return [{ id: '/', label: 'Files' }, ...parts.map((part, index) => ({ id: `/${parts.slice(0, index + 1).join('/')}`, label: part }))];
}

const baseName = (name: string) => name.slice(name.lastIndexOf('/') + 1);
// A stored file's own identity (bytes it can be read by at once), as against a path the Worker must look up.
const IDENTITY = /^(1f|12):[0-9a-f]{64}$/;
// The name a file shows with when neither the person's files nor its opener has one for it.
const UNNAMED = 'Unnamed file';
const open = (detail: Record<string, unknown>) => window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail }));
const openFolder = (collection: string) => open({ id: 'trillion.files', surfaceInput: { collection } });

type FileResult = { identity: string; kind: string; value: unknown; produced_by?: string | null; recorded_at?: string };
type FileResults = { results: FileResult[] };
type RecordingReviewRun = { jobs: { state: string; in_the_way?: string | null; finished_at?: string | null }[]; steps: { ok: boolean; reason?: string | null }[] };
const reviewTabs = meetingReview.tabs as MeetingReviewTab[];

// Result values come from the Files owner. Show its words as kept; this screen never writes a summary or invents tasks.
function resultWords(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(resultWords).filter(Boolean).join('\n\n');
  if (!value || typeof value !== 'object') return '';
  const row = value as Record<string, unknown>;
  for (const key of ['text', 'summary', 'title', 'label', 'description', 'task', 'name', 'action', 'items', 'action_items', 'actionItems']) {
    if (row[key] !== undefined && row[key] !== null) {
      const words = resultWords(row[key]);
      if (words) return words;
    }
  }
  return '';
}

// When the newest kept result (summary, action items) was saved; null when none says.
function latestRecordedAt(saved: readonly FileResult[]): number | null {
  const times = saved.map(result => Date.parse(result.recorded_at ?? '')).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}
const whenWords = (time: number | null) => time === null ? meetingReview.metadata.unknown : momentInWords(time);

type MeetingCandidate = { id: string; source: string; source_id: string; title: string; starts_at: string; ends_at: string | null; conference_url?: string | null; link?: string | null; source_generation?: string; attendees?: { name?: string; email?: string }[] };
type MeetingCandidates = { items: MeetingCandidate[]; sources: { id: string; label?: string; read: boolean; complete?: boolean; selection?: { connected_at?: string } }[] };
const meetingKey = (item: MeetingCandidate) => JSON.stringify([item.source, item.source_id, item.id]);
const candidateContext = (item: MeetingCandidate) => meetingContextOfCalendarItem(item, item.source_generation);
async function readMeetingCandidates(around: number): Promise<MeetingCandidates> {
  const from = new Date(around - 86400000).toISOString(), to = new Date(around + 86400000).toISOString();
  const answer = await readJson<MeetingCandidates>(`/work/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&fresh=1`);
  if (!Array.isArray(answer.items) || !Array.isArray(answer.sources)) throw new Error('The calendar reply could not be read.');
  return { ...answer, items: answer.items.map(item => ({ ...item, source_generation: answer.sources.find(source => source.id === item.source)?.selection?.connected_at })).filter(item => candidateContext(item)) };
}
function MeetingAssociation({ recordingId, recordedAt, onTitle }: { recordingId: string; recordedAt?: string; onTitle?: (title: string | null) => void }) {
  const [association, setAssociation] = React.useState<ReturnType<typeof readRecordingMeetingAssociation>>({ state: 'unreadable' });
  const [answer, setAnswer] = React.useState<MeetingCandidates>({ items: [], sources: [] });
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'partial' | 'failed'>('loading');
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const sequence = React.useRef(0), associationSequence = React.useRef(0), scope = React.useRef(0), identity = React.useRef(recordingId);
  const refreshing = React.useRef<{ scope: number; recordingId: string } | null>(null);
  identity.current = recordingId;
  const readAssociation = React.useCallback(async () => {
    const at = scope.current, request = ++associationSequence.current;
    try {
      const value = await readRecordingMeetingAssociationFromOwner(recordingId);
      if (at !== scope.current || identity.current !== recordingId || request !== associationSequence.current) return { state: 'superseded' as const };
      setAssociation(value);
      return value;
    } catch {
      if (at !== scope.current || identity.current !== recordingId || request !== associationSequence.current) return { state: 'superseded' as const };
      setAssociation({ state: 'unreadable' });
      return { state: 'unreadable' as const };
    }
  }, [recordingId]);
  const candidateAttached = association.state === 'attached';
  const candidateTime = candidateAttached ? association.context.startsAt : recordedAt;
  const loadCandidates = React.useCallback(async () => {
    if (refreshing.current?.scope === scope.current && refreshing.current.recordingId === recordingId) return;
    const request = ++sequence.current, at = scope.current;
    setLoadState('loading');
    try {
      const recorded = candidateTime ? Date.parse(candidateTime) : NaN;
      const around = candidateAttached ? recorded : Number.isFinite(recorded) ? recorded : Date.now();
      const fresh = await readMeetingCandidates(around);
      if (request !== sequence.current || at !== scope.current || identity.current !== recordingId) return;
      setAnswer(fresh);
      setLoadState(fresh.sources.some(source => source.read === false || source.complete === false) ? 'partial' : 'ready');
    } catch {
      if (request === sequence.current && at === scope.current && identity.current === recordingId) setLoadState('failed');
    }
  }, [candidateAttached, candidateTime, recordingId]);
  React.useEffect(() => {
    scope.current += 1; setDraft(''); setMessage(''); setBusy(false); setAssociation({ state: 'unreadable' });
    void readAssociation();
    const stop = subscribeRecordChanges(() => { void readAssociation(); });
    return () => { scope.current += 1; sequence.current += 1; associationSequence.current += 1; refreshing.current = null; stop(); };
  }, [readAssociation]);
  React.useEffect(() => { void loadCandidates(); return () => { sequence.current += 1; }; }, [loadCandidates]);
  const validate = async (candidate: MeetingCandidate): Promise<MeetingCalendarContext> => {
    const fresh = await readMeetingCandidates(Date.parse(candidate.starts_at));
    const source = fresh.sources.find(row => row.id === candidate.source);
    if (!source?.read || source.complete === false) throw new Error('That calendar source could not be verified.');
    const expected = candidateContext(candidate);
    const exact = fresh.items.find(item => meetingKey(item) === meetingKey(candidate) && JSON.stringify(candidateContext(item)) === JSON.stringify(expected));
    if (!exact || !expected) throw new Error('That meeting changed or is no longer available.');
    return candidateContext(exact)!;
  };
  const save = async (chosen?: string) => {
    const selected = chosen ? answer.items.find(candidate => meetingKey(candidate) === chosen) : answer.items.find(candidate => meetingKey(candidate) === draft);
    if (!selected) return;
    const at = scope.current, target = recordingId;
    setBusy(true); setMessage('');
    try {
      const context = await validate(selected);
      if (at !== scope.current || target !== identity.current) return;
      const expected = association.state === 'attached' ? association.context : null;
      await setRecordingMeetingContext({ recordedFileId: target, meetingEventContext: context, expectedMeetingContext: expected });
      if (at === scope.current && target === identity.current) {
        const confirmed = await readAssociation();
        if (at !== scope.current || target !== identity.current) return;
        if (confirmed.state === 'superseded') return;
        setMessage(confirmed.state === 'attached' && JSON.stringify(confirmed.context) === JSON.stringify(context)
          ? '' : confirmed.state === 'unreadable'
            ? meetingReview.association.words.readback_failed : meetingReview.association.words.readback_changed);
      }
    } catch (error) { if (at === scope.current && target === identity.current) setMessage(reasonOf(error)); }
    finally { if (at === scope.current && target === identity.current) setBusy(false); }
  };
  const detach = async () => {
    if (association.state !== 'attached') return;
    const at = scope.current, target = recordingId;
    setBusy(true); setMessage('');
    try {
      await clearRecordingMeetingContext({ recordedFileId: target, expectedMeetingContext: association.context });
      if (at === scope.current && target === identity.current) {
        const confirmed = await readAssociation();
        if (at !== scope.current || target !== identity.current) return;
        if (confirmed.state === 'superseded') return;
        setMessage(confirmed.state === 'detached' ? '' : confirmed.state === 'unreadable'
          ? meetingReview.association.words.readback_failed : meetingReview.association.words.readback_changed);
      }
    } catch (error) { if (at === scope.current && target === identity.current) setMessage(reasonOf(error)); }
    finally { if (at === scope.current && target === identity.current) setBusy(false); }
  };
  const refresh = async () => {
    const at = scope.current, target = recordingId;
    if (refreshing.current?.scope === at && refreshing.current.recordingId === target) return;
    const token = { scope: at, recordingId: target };
    refreshing.current = token;
    sequence.current += 1;
    setBusy(true); setMessage('');
    try {
      const current = await readAssociation();
      if (at !== scope.current || target !== identity.current || current.state === 'superseded') return;
      const around = current.state === 'attached' ? Date.parse(current.context.startsAt)
        : recordedAt ? Date.parse(recordedAt) : Date.now();
      const fresh = await readMeetingCandidates(around);
      if (at !== scope.current || target !== identity.current) return;
      setAnswer(fresh);
      setLoadState(fresh.sources.some(source => source.read === false || source.complete === false) ? 'partial' : 'ready');
      if (current.state !== 'attached') return;
      const source = fresh.sources.find(row => row.id === current.context.source);
      const exact = fresh.items.find(item => meetingKey(item) === JSON.stringify([current.context.source, current.context.sourceId, current.context.eventId]));
      if (!source?.read || source.complete === false || !exact) {
        setMessage(meetingReview.association.words.refresh_changed);
        return;
      }
      const next = candidateContext(exact);
      const withoutAttendees = (value: MeetingCalendarContext) => {
        const { attendees: _attendees, ...core } = value;
        return core;
      };
      if (!next || JSON.stringify(withoutAttendees(next)) !== JSON.stringify(withoutAttendees(current.context))) {
        setMessage(meetingReview.association.words.refresh_changed);
        return;
      }
      // Rewriting the exact result also retries a prior search-write failure when the row was already current.
      await setRecordingMeetingContext({ recordedFileId: target, meetingEventContext: next, expectedMeetingContext: current.context });
      if (at !== scope.current || target !== identity.current) return;
      const confirmed = await readAssociation();
      if (at !== scope.current || target !== identity.current || confirmed.state === 'superseded') return;
      if (confirmed.state !== 'attached' || JSON.stringify(confirmed.context) !== JSON.stringify(next))
        setMessage(meetingReview.association.words.readback_changed);
    } catch (error) {
      if (at === scope.current && target === identity.current) {
        setLoadState('failed');
        setMessage(reasonOf(error));
      }
    } finally {
      if (refreshing.current === token) { refreshing.current = null; sequence.current += 1; }
      if (at === scope.current && target === identity.current) setBusy(false);
    }
  };
  const attached = association.state === 'attached' ? association.context : null;
  const attachedTitle = attached?.title ?? null;
  React.useEffect(() => { onTitle?.(attachedTitle); }, [attachedTitle, onTitle]);
  const data = meetingReview.association, composition = data.composition;
  return <MeetingAssociationPanel state={association.state} context={attached}
    contextLabel={attached ? `${attached.title}, ${stretchInWords(attached.startsAt, attached.endsAt)}` : ''}
    options={answer.items.map(candidate => ({ value: meetingKey(candidate), label: `${candidate.title}, ${stretchInWords(candidate.starts_at, candidate.ends_at)} · ${answer.sources.find(source => source.id === candidate.source)?.label ?? 'Calendar'}` }))}
    loadState={loadState} selected={draft} busy={busy} message={message} words={data.words}
    onSelect={setDraft} onLink={value => { void save(value); }} compact onUnlink={() => { void detach(); }}
    onRefresh={() => { void refresh(); }}
    onOpen={() => { if (attached) openScreenOn(data.screen, { calendar_event: { id: attached.eventId, source: attached.source, source_id: attached.sourceId, starts_at: attached.startsAt, source_generation: attached.sourceGeneration } }); }}
    renderPieces={pieces => <ArrangedContents pieces={pieces} arrangement={composition.arrangement} keptAt={composition.kept_at} words={composition.words} />} />;
}

type RecordingFileRead =
  | { state: 'loading' }
  | { state: 'ready'; owner: Awaited<ReturnType<typeof readRecordingOwnerForFileFromOwner>> }
  | { state: 'failed'; message: string; retry: () => void };

function RecordingFileMeetingAssociation({ identity, recordingId, recordedAt, recordingPart, onOwnerRead, onTitle }: {
  identity: string; recordingId?: string; recordedAt?: string; recordingPart?: string;
  onTitle?: (title: string | null) => void;
  onOwnerRead?: (read: RecordingFileRead) => void;
}) {
  const [owner, setOwner] = React.useState<{ id: string; recordedAt?: string } | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const [message, setMessage] = React.useState('');
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    let current = true;
    setState('loading'); setOwner(null); setMessage('');
    // The imperative host finishes claiming this file after the React mount.
    // Deliver loading after that commit, before an asynchronous owner answer.
    queueMicrotask(() => { if (current) onOwnerRead?.({state: 'loading'}); });
    void readRecordingOwnerForFileFromOwner(identity, recordingId, recordingPart).then(value => {
      if (current) { setOwner(value?.part === 'record-audio' ? value : null); setState('ready'); onOwnerRead?.({state: 'ready', owner: value}); }
    }).catch(error => { if (current) {
      const message = reasonOf(error);
      setState('failed'); setMessage(message);
      onOwnerRead?.({state: 'failed', message, retry: () => setRetry(value => value + 1)});
    } });
    return () => { current = false; };
  }, [identity, recordingId, recordedAt, recordingPart, retry, onOwnerRead]);
  if (owner) return <MeetingAssociation recordingId={owner.id} recordedAt={owner.recordedAt} onTitle={onTitle} />;
  if (state === 'ready') return null;
  const data = meetingReview.association, composition = data.composition;
  return <MeetingAssociationPanel state="unreadable" context={null} contextLabel="" options={[]} loadState={state === 'failed' ? 'failed' : 'loading'} selected="" busy={false} message={message} words={data.words}
    onSelect={() => {}} onLink={() => {}} onUnlink={() => {}} onOpen={() => {}} onRefresh={() => setRetry(value => value + 1)} compact
    renderPieces={pieces => <ArrangedContents pieces={pieces} arrangement={composition.arrangement} keptAt={composition.kept_at} words={composition.words} />} />;
}

function MeetingReview({ identity, title, audioHost, transcript, clock, onSeek, recordingId, recordedAt, recordingPart, onOwnerRead }: {
  identity: string;
  title: string;
  /** The element the recording's player is drawn in; the note shows it as its Audio row. */
  audioHost: HTMLElement;
  transcript: HTMLElement;
  clock: PlayClock;
  onSeek: (seconds: number) => void;
  recordingId?: string;
  recordedAt?: string;
  recordingPart?: string;
  onOwnerRead?: (read: RecordingFileRead) => void;
}) {
  const [results, setResults] = React.useState<Readonly<Record<string, string>> | null>(null);
  const [savedValues, setSavedValues] = React.useState<Readonly<Record<string, unknown[]>>>({});
  const [summaryChoice, setSummaryChoice] = React.useState<SummaryChoice>({ template: meetingReview.summary_tools.templates[0].id, language: '' });
  const ownTemplates = useOwnTemplates();
  const [updatedAt, setUpdatedAt] = React.useState<number | null>(null);
  const [meetingTitle, setMeetingTitle] = React.useState<string | null>(null);
  // When the recording was made: what the opener knew, else what its owner answers.
  const [ownerRecordedAt, setOwnerRecordedAt] = React.useState<string | undefined>(undefined);
  const ownerRead = React.useCallback((read: RecordingFileRead) => {
    if (read.state === 'ready' && read.owner?.recordedAt) setOwnerRecordedAt(read.owner.recordedAt);
    onOwnerRead?.(read);
  }, [onOwnerRead]);
  const madeAt = recordedAt ?? ownerRecordedAt;
  const [failed, setFailed] = React.useState('');
  const [reading, setReading] = React.useState(false);
  const [hasTranscript, setHasTranscript] = React.useState(!transcript.hidden);
  const [askedId, setAskedId] = React.useState('');
  const [reviewState, setReviewState] = React.useState<'idle' | 'sending' | 'queued' | 'running' | 'refused' | 'done'>('idle');
  const [reviewError, setReviewError] = React.useState('');
  const transcriptAnchor = React.useRef<HTMLDivElement>(null);
  const requestSequence = React.useRef(0);
  const mounted = React.useRef(false);
  const pendingReviewPress = React.useRef<Parameters<typeof sendQueuedJob>[0] | null>(null);
  const reviewInFlight = React.useRef(false);
  const runReadSequence = React.useRef(0);
  const currentIdentity = React.useRef(identity);
  currentIdentity.current = identity;
  const reviewStorageKey = `trillion:meeting-review:${identity}`;
  const pressStorageKey = `${reviewStorageKey}:press`;

  const readReviewRun = React.useCallback(async (id: string) => {
    if (!id) return;
    const sequence = ++runReadSequence.current;
    const sourceIdentity = identity;
    const applies = () => mounted.current && currentIdentity.current === sourceIdentity && runReadSequence.current === sequence;
    try {
      const query = new URLSearchParams({ message: id });
      const run = await readJson<RecordingReviewRun>(`/work/api/job-run?${query}`);
      if (!applies()) return;
      setReviewError('');
      if (run.jobs.some(job => job.in_the_way) || run.steps.some(step => !step.ok)) setReviewState('refused');
      else if (run.jobs.length && run.jobs.every(job => job.state === 'finished')) setReviewState('done');
      else if (run.jobs.some(job => job.state === 'taken')) setReviewState('running');
      else setReviewState('queued');
    } catch (error) {
      if (!applies()) return;
      setReviewError(reasonOf(error));
      setReviewState('refused');
    }
  }, [identity]);

  React.useEffect(() => {
    try {
      const saved = sessionStorage.getItem(reviewStorageKey) ?? '';
      if (saved) { setAskedId(saved); void readReviewRun(saved); }
      else setAskedId('');
    } catch { /* Private browsing may disable session storage; the current tab still tracks its own request. */ }
  }, [readReviewRun, reviewStorageKey]);

  React.useEffect(() => askedId ? onStoreChange(() => readReviewRun(askedId), AI_WORK) : undefined, [askedId, readReviewRun]);

  const readResults = React.useCallback(async () => {
    if (!mounted.current) return;
    const sequence = ++requestSequence.current;
    const applies = () => mounted.current && requestSequence.current === sequence;
    setReading(true);
    try {
      const kinds = reviewTabs.filter(tab => tab.kind);
      const answers = await Promise.all(kinds.map(tab => fileResults.read<FileResults>(identity, tab.kind!)));
      if (!applies()) return;
      const words: Record<string, string> = {};
      const saved: Record<string, FileResult[]> = {};
      kinds.forEach((tab, index) => {
        saved[tab.id] = answers[index]?.results ?? [];
        const completedEmpty = saved[tab.id].length > 0 && saved[tab.id].every(result => Array.isArray(result.value) && result.value.length === 0);
        words[tab.id] = saved[tab.id].map(result => resultWords(result.value)).filter(Boolean).join('\n\n')
          || (completedEmpty && tab.completed_empty ? tab.completed_empty : saved[tab.id].length ? tab.unreadable ?? '' : '');
      });
      setResults(words);
      setSavedValues(Object.fromEntries(Object.entries(saved).map(([id, rows]) => [id, rows.map(row => row.value)])));
      setUpdatedAt(latestRecordedAt(Object.values(saved).flat()));
      setFailed('');
    } catch (error) {
      if (applies()) setFailed(reasonOf(error));
    } finally {
      if (applies()) setReading(false);
    }
  }, [identity]);

  const queueReview = React.useCallback(async () => {
    if (reviewInFlight.current) return;
    reviewInFlight.current = true;
    const sourceIdentity = identity;
    const applies = () => mounted.current && currentIdentity.current === sourceIdentity;
    setReviewState('sending');
    setReviewError('');
    if (!pendingReviewPress.current) {
      try {
        const kept = JSON.parse(sessionStorage.getItem(pressStorageKey) ?? 'null');
        if (kept?.job_id === meetingReview.review.job_id && typeof kept.press_key === 'string'
          && kept.context?.audio_identity === identity && Object.values(kept.context).every(value => typeof value === 'string'))
          pendingReviewPress.current = kept;
      } catch { /* Continue with this tab's request if storage is unavailable. */ }
      pendingReviewPress.current ??= { job_id: meetingReview.review.job_id, press_key: crypto.randomUUID(), context: {
        minutes: '', audio_file: title, audio_identity: identity, transcript_file: '', calendar_context: '',
        ...summaryAsk({ templates: meetingReview.summary_tools.templates, languages: meetingReview.summary_tools.languages, template: summaryChoice.template, language: summaryChoice.language, own: ownTemplates.own }),
      } };
      try { sessionStorage.setItem(pressStorageKey, JSON.stringify(pendingReviewPress.current)); } catch { /* Retained in this tab. */ }
    }
    const submitted = pendingReviewPress.current;
    try {
      const answer = await sendQueuedJob(submitted);
      if (pendingReviewPress.current === submitted) pendingReviewPress.current = null;
      try { sessionStorage.removeItem(pressStorageKey); } catch { /* The acknowledged request is tracked by asked_id. */ }
      try { sessionStorage.setItem(reviewStorageKey, answer.asked_id); } catch { /* The request remains tracked in this tab. */ }
      if (!applies()) return;
      setAskedId(answer.asked_id);
      setReviewState('queued');
      void readReviewRun(answer.asked_id);
      void readResults();
    } catch (error) {
      if (!applies()) return;
      setReviewError(reasonOf(error));
      setReviewState('refused');
    } finally { reviewInFlight.current = false; }
  }, [identity, readResults, readReviewRun, reviewStorageKey, pressStorageKey, title, summaryChoice, ownTemplates.own]);
  const actionItems = React.useMemo(() => actionItemsOf(savedValues.actions ?? []), [savedValues]);
  const currentReviewResults = Boolean(results?.summary && results?.actions);
  // Where the words stand (kept, being made by themselves, none), read again every `steps.look_again_ms` while they are being made.
  const [wordsState, setWordsState] = React.useState<WordsState>('none');
  React.useEffect(() => {
    let current = true;
    let timer: number | undefined;
    const look = () => wordsOfRecording(identity, identity).then(found => {
      if (!current) return;
      setWordsState(found.state);
      if (found.state === 'making') timer = window.setTimeout(look, widgets.steps.look_again_ms);
    }, () => { if (current) setWordsState('none'); });
    void look();
    return () => { current = false; window.clearTimeout(timer); };
  }, [identity]);
  const steps = processingSteps(recordingFacts({
    words: wordsState, summarySaved: Boolean(results?.summary), reviewing: reviewState === 'sending' || reviewState === 'queued' || reviewState === 'running',
  }));
  const reviewStatus = reviewState === 'sending' ? meetingReview.review.sending
    : reviewState === 'queued' ? meetingReview.review.queued
    : reviewState === 'running' ? meetingReview.review.running
    : reviewState === 'refused' ? meetingReview.review.refused
    : reviewState === 'done' ? currentReviewResults ? meetingReview.review.result_current : meetingReview.review.finished_without_results
    : '';

  React.useEffect(() => {
    mounted.current = true;
    void readResults();
    const stop = onStoreChange(() => { void readResults(); }, AI_WORK);
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
      stop();
    };
  }, [readResults]);

  React.useLayoutEffect(() => {
    const anchor = transcriptAnchor.current;
    if (!anchor) return;
    anchor.appendChild(transcript);
    const observer = new MutationObserver(() => setHasTranscript(!transcript.hidden));
    observer.observe(transcript, { attributes: true, attributeFilter: ['hidden'] });
    setHasTranscript(!transcript.hidden);
    return () => observer.disconnect();
  }, [transcript]);

  return (
    <MeetingReviewTabs
      tabs={reviewTabs}
      loadingLabel={meetingReview.loading}
      ariaLabel={meetingReview.aria_label}
      header={<Container layout="vertical" gap="sm" padding="sm">
        <Text as="h1" variant="heading-xl" truncate>{meetingTitle ?? title}</Text>
        <MeetingNoteMetadata ariaLabel={meetingReview.aria_label} rows={[
          { id: 'created', label: meetingReview.metadata.created, value: whenWords(madeAt ? Date.parse(madeAt) || null : null) },
          { id: 'updated', label: meetingReview.metadata.updated, value: whenWords(updatedAt) },
        ]} />
        <RecordingFileMeetingAssociation identity={identity} recordingId={recordingId} recordedAt={recordedAt} recordingPart={recordingPart} onOwnerRead={ownerRead} onTitle={setMeetingTitle} />
        <MeetingNoteMetadata ariaLabel={meetingReview.aria_label} rows={[
          { id: 'audio', label: meetingReview.metadata.audio, content: <div className="min-w-0 flex-1" ref={slot => { if (slot && audioHost.parentElement !== slot) slot.replaceChildren(audioHost); }} /> },
        ]} />
      </Container>}
      notes={<Container layout="vertical" gap="sm">
        <SayAboutThis record={`file:${identity}`} files={[{ identity }]} title={title} clock={clock} onSeek={onSeek} composer={false} />
      </Container>}
      transcript={<Container layout="vertical" gap="sm" minWidth="0" className="py-3">
        {!hasTranscript ? <Text variant="body" color="subtle">{reviewTabs.find(tab => tab.id === 'transcript')?.empty}</Text> : null}
        <div ref={transcriptAnchor} />
      </Container>}
      results={results}
      progress={<ProcessingStepsPill steps={steps} />}
      reviewAction={<Container layout="vertical" gap="xs">
        {reviewStatus ? <Text variant="body" color="subtle" role={reviewState === 'refused' ? 'alert' : undefined}>
          {reviewStatus}{reviewError ? ` ${reviewError}` : ''}
        </Text> : null}
        <Button variant="outline" size="sm" loading={reviewState === 'sending'} disabled={reviewState === 'sending' || reviewState === 'queued' || reviewState === 'running'} onClick={() => { return queueReview(); }}>
          {reviewState === 'refused' || (reviewState === 'done' && !currentReviewResults) ? meetingReview.review.retry : meetingReview.review.label}
        </Button>
      </Container>}
      renderBody={tabId => tabId === 'actions' && actionItems.length ? <ActionItemsPanel identity={identity} title={title} items={actionItems} /> : undefined}
      renderTools={tabId => tabId === 'summary'
        ? <Container layout="vertical" gap="sm">
          <SummaryTools identity={identity} title={title} text={results?.summary ?? ''} />
          <SummaryChoices choice={summaryChoice} templates={ownTemplates} onChoice={next => { pendingReviewPress.current = null; setSummaryChoice(next); }} />
        </Container> : null}
      error={failed}
      reading={reading}
      onRefresh={() => { void readResults(); }}
      onManage={tabId => {
        const tab = reviewTabs.find(item => item.id === tabId);
        if (!tab?.kind) return;
        open({ id: 'tool:record_file_results', title: tab.manage, surfaceInput: {
          tool_id: 'record_file_results',
          results: [{ identity, kind: tab.kind, value: "" }],
        } });
      }}
    />
  );
}

// The file a drop onto the arrangement handed this tab, when it is still in this page.
function droppedFiles(input: Record<string, unknown> | undefined): File[] {
  const refs = Array.isArray(input?.subjectRefs) ? input.subjectRefs : input?.subjectRef ? [input.subjectRef] : [];
  return refs.flatMap((value) => {
    const ref = value as { address?: unknown } | null;
    if (typeof ref?.address !== 'string') return [];
    const handle = readPlaceableSurfaceSubject(ref.address)?.handle;
    return handle instanceof File ? [handle] : [];
  });
}

function fileGallery(input: Record<string, unknown> | undefined): Array<{ id: string; name: string; type: string; src: string }> {
  if (!Array.isArray(input?.files)) return [];
  return input.files.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    return typeof row.id === 'string' && IDENTITY.test(row.id) && typeof row.name === 'string'
      ? [{ id: row.id, name: row.name, type: typeof row.type === 'string' ? row.type : 'application/octet-stream', src: `/work/api/namespace/bytes/${encodeURIComponent(row.id)}` }]
      : [];
  });
}

export function mountFileScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const input = props.surfaceInput;
  const asked = typeof input?.id === 'string' ? input.id : '';
  // A moment found by search opens its recording at that second (a media fragment the player honours).
  const seconds = typeof input?.at === 'number' ? input.at
    : typeof input?.at === 'string' && input.at.trim() ? Number(input.at) : null;
  const at = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? `#t=${seconds.toFixed(2)}` : '';
  const pickedFiles = droppedFiles(input);
  const presentedFiles = fileGallery(input);
  // What the opener already knows about the file: its name (a path or a file name) and its type (fileTab).
  const named = typeof input?.name === 'string' ? input.name : '';
  const typed = typeof input?.type === 'string' ? input.type : '';
  let disposed = false;
  let unmountPath: (() => void) | null = null;
  let preview: ReturnType<typeof mountFilePreview> | null = null;
  let droppedUrls: string[] = [];
  let stopWatching: (() => void) | null = null;
  const path = document.createElement('div');
  path.className = 'trillion-file-path';
  const crumbs = document.createElement('div');
  crumbs.className = 'trillion-file-crumbs';
  const actions = document.createElement('div');
  path.replaceChildren(crumbs, actions);
  // A recording's share chips (sharing-sheet.tsx NoteShareRow) are their own row under the path, so the path keeps its room.
  const shareRow = document.createElement('div');
  shareRow.hidden = true;
  const stage = document.createElement('div');
  stage.className = 'trillion-file-stage';
  const editorHost = document.createElement('section');
  editorHost.className = 'trillion-file-editor';
  const reviewHost = document.createElement('section');
  reviewHost.className = 'trillion-file-review';
  element.classList.add('trillion-file');
  // The file's card under it (parts/ui/show/file-card): what it is, what can be done with it, who is in it, what was said.
  const card = document.createElement('div');
  card.className = 'trillion-file-card';
  const main = document.createElement('div');
  main.className = 'trillion-file-main';
  const transcript = document.createElement('section');
  transcript.className = 'trillion-file-transcript';
  main.replaceChildren(stage, editorHost, reviewHost, card);
  // What was said about the file and the box to say more (say-about-this.tsx).
  const say = document.createElement('div');
  say.className = 'trillion-file-say';
  const body = document.createElement('div');
  body.className = 'trillion-file-body';
  body.replaceChildren(main, say);
  actions.className = 'trillion-file-actions';
  // A recording's one box (the docked composer: ask, or note at the moment playing) sits under the whole page.
  const dock = document.createElement('div');
  element.replaceChildren(path, shareRow, body, dock);

  // RecordAudio keeps the words heard during capture as a real text file. Show
  // that evidence beside the recording without assigning timestamps it never had.
  const transcriptFileId = typeof input?.transcriptFileId === 'string' && IDENTITY.test(input.transcriptFileId)
    ? input.transcriptFileId
    : null;
  let transcriptShownFor: string | null = null;
  const ownerValue = input?.recordingOwner;
  const recordingOwner = ownerValue && typeof ownerValue === 'object' && !Array.isArray(ownerValue)
    && typeof (ownerValue as Record<string, unknown>).part === 'string'
    && typeof (ownerValue as Record<string, unknown>).recorded_file_id === 'string'
    ? ownerValue as { part: string; recorded_file_id: string; recorded_at?: string }
    : null;
  let resolvedRecordingOwner = recordingOwner;
  // The player's clock and seek exist only once the player is drawn; the note transcript reads them when it needs them.
  let audioIdentity = '';
  const playerLink: { clock: PlayClock | null; seek: (seconds: number) => void } = { clock: null, seek: () => {} };
  const transcriptClock: PlayClock = { now: () => playerLink.clock?.now() ?? 0, subscribe: listener => playerLink.clock?.subscribe(listener) ?? (() => {}) };
  const showTranscript = (identity: string) => {
    if (!IDENTITY.test(identity) || transcriptShownFor === identity) return;
    transcriptShownFor = identity;
    mountSharedContent(transcript, (
      <Container layout="vertical" className="trillion-file-transcript-content" aria-label="Transcript">
        <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm">
          <Text variant="heading-sm" color="strong">Transcript</Text>
          {resolvedRecordingOwner ? <Button variant="outline" size="sm" onClick={() => open(fileTab({ id: identity, recordingOwner: resolvedRecordingOwner }))}>Edit transcript</Button> : null}
        </Container>
        <NoteTranscript identity={audioIdentity} title={baseName(named || UNNAMED)} clock={transcriptClock} onSeek={seconds => playerLink.seek(seconds)}>
          <FilePreview
            url={`/work/api/namespace/bytes/${encodeURIComponent(identity)}`}
            contentType="text/plain"
            label="Transcript"
          />
        </NoteTranscript>
      </Container>
    ));
    transcript.hidden = false;
  };
  // A recording whose words are kept as its own `transcript` result (no sidecar text file): the same note transcript, no file to fall back on.
  const showKeptTranscript = async (identity: string) => {
    const kept = await fileResults.read<KeptWords>(identity, 'transcript').catch(() => null);
    if (disposed || audioIdentity !== identity || transcriptShownFor) return;
    if (!kept?.results[0]?.value?.segments?.length) { releaseNode(transcript); transcript.replaceChildren(); transcript.hidden = true; return; }
    mountSharedContent(transcript, (
      <Container layout="vertical" className="trillion-file-transcript-content" aria-label="Transcript">
        <NoteTranscript identity={identity} title={baseName(named || UNNAMED)} clock={transcriptClock} onSeek={seconds => playerLink.seek(seconds)}>{null}</NoteTranscript>
      </Container>
    ));
    transcript.hidden = false;
  };
  if (transcriptFileId) showTranscript(transcriptFileId);
  else transcript.hidden = true;

  // Where the recording is playing (the player tells it), for the moment a note is kept at.
  let playingAt = 0;
  const listeners = new Set<() => void>();
  const clock: PlayClock = { now: () => playingAt, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const heard = (seconds: number) => {
    playingAt = seconds;
    listeners.forEach(listener => listener());
  };
  let seeks = 0;
  playerLink.clock = clock;
  playerLink.seek = seconds => addToPreview({ seekRequest: { requestId: seeks += 1, seconds } });
  let reviewFor: string | null = null;

  // The path above the file: Files, its folders, its name.
  function showPath(name: string) {
    unmountPath?.();
    unmountPath = mountBreadcrumb(crumbs, { steps: pathSteps(name), onOpen: step => { if (step !== name) openFolder(step); } });
  }

  // What the preview shows now; a later word (the kept transcript, the poster) is added to it, never drawn over it.
  let current: FilePreviewProps | null = null;
  const addToPreview = (more: Partial<FilePreviewProps>) => {
    if (!current || !preview || disposed) return;
    current = { ...current, ...more };
    preview.update(current);
  };

  function show(name: string, url: string, contentType: string): FilePreviewProps {
    showPath(name);
    releaseNode(stage);
    stage.replaceChildren();
    playingAt = 0;
    current = { url, contentType, label: baseName(name), autoPlay: false, onTimeChange: heard };
    preview = mountFilePreview(stage, current);
    return current;
  }

  function showGallery(files: readonly { id: string; name: string; type: string; src: string }[]) {
    releaseNode(stage);
    preview = null;
    current = null;
    showPath(`${files.length} files`);
    delete stage.dataset.shareRecord;
    stage.replaceChildren();
    mountSharedContent(stage, (
      <MediaCarousel
        ariaLabel="Files to present"
        className="trillion-file-carousel"
        items={files.map((file) => ({ id: file.id, src: file.src, alt: file.name, label: file.name }))}
        mediaClassName="trillion-file-carousel__preview"
        renderMedia={(item, index) => <FilePreview url={item.src} contentType={files[index].type} label={item.label} autoPlay={false} />}
        showLabels
      />
    ));
  }

  // A recording's kept words, read after it shows so the player never waits on them.
  async function showWords(identity: string, contentType: string) {
    if (!isRecording(contentType)) return;
    const kept = await fileResults.read<KeptWords>(identity, 'transcript').catch(() => null);
    const passages = kept?.results[0]?.value?.segments;
    if (passages?.length) addToPreview({ timedText: timedTextOf(identity, passages) });
  }

  // A video's still (the same poster every preview of it shows, made-previews.ts), so it shows a frame before play.
  async function showPoster(identity: string, contentType: string) {
    if (!/^video\//i.test(contentType)) return;
    const made = await previewStore.read(identity).catch(() => null) as { poster?: string } | null;
    if (made?.poster) addToPreview({ poster: made.poster });
  }

  // Draws the file once its identity and type are known: from the opener's own words at once, then again from the
  // Worker's answer only where that says something new (a name, a type), so the file never waits on a read to show.
  let drawn: { identity: string; name: string; type: string } | null = null;
  function drawFile(found: Found) {
    const name = found.names?.[0] || named || UNNAMED;
    const type = found.media_type || typed;
    audioIdentity = isRecording(type) ? found.identity : '';
    if (transcriptFileId) {
      showTranscript(transcriptFileId);
    }
    // Selected words in a document or transcript belong to this file, even when
    // its preview renderer has no record-aware wrapper of its own.
    stage.dataset.shareRecord = `file:${found.identity}`;
    if (drawn && drawn.identity === found.identity && drawn.name === name && drawn.type === type) return;
    if (drawn && drawn.identity === found.identity && drawn.type === type) showPath(name);
    else {
      show(name, `/work/api/namespace/bytes/${encodeURIComponent(found.identity)}${at}`, type);
      void showWords(found.identity, type);
      void showPoster(found.identity, type);
    }
    const url = current?.url;
    mountSharedContent(card, <FileCardFor full subject={{ id: found.identity, title: baseName(name), url, type: type || undefined }} />);
    releaseNode(editorHost);
    editorHost.replaceChildren();
    stage.hidden = false;
    const editableName = found.names?.find(alias => alias === name) ?? '';
    if (editableName && canEditTextDocument(editableName, type)) {
      const openVersion = (version: { identity: string; media_type: string | null; names?: string[] }) => {
        const instance = input?.surface_instance_ref;
        const targetName = version.names?.find(alias => alias === editableName) ?? version.names?.[0] ?? editableName;
        const opened = fileTab({ id: version.identity, name: targetName, type: version.media_type ?? type, ...(recordingOwner ? { recordingOwner } : {}) });
        open({ ...opened, ...(typeof instance === 'string' ? { replacesInstance: instance } : {}) });
      };
      const openLatestVersion = (version: { identity: string; media_type: string | null; names?: string[] }) => {
        const targetName = version.names?.find(alias => alias === editableName) ?? version.names?.[0] ?? editableName;
        open(fileTab({ id: version.identity, name: targetName, type: version.media_type ?? type, ...(recordingOwner ? { recordingOwner } : {}) }));
      };
      mountSharedContent(editorHost, <EditableTextDocument
        identity={found.identity}
        name={editableName}
        mediaType={type}
        onOpenLatest={openLatestVersion}
        onEditingChange={editing => { stage.hidden = editing; }}
        onOpenVersion={openVersion}
        onSaveVersion={recordingOwner ? (version, previousIdentity) => replaceRecordingTranscript(
          recordingOwner.part, recordingOwner.recorded_file_id, previousIdentity, version.identity,
        ) : undefined}
      />);
    }
    const recording = isRecording(type);
    // A recording's player is the note's Audio row (MeetingReview moves it there); any other file keeps it in the stage.
    stage.classList.toggle('trillion-file-stage--note', recording);
    if (!recording && stage.parentElement !== main) main.prepend(stage);
    if (recording) {
      const savedRecordingId = recordingOwner?.recorded_file_id;
      // The docked composer (global-composer.tsx) is drawn once per recording, so a draw never loses what is being typed.
      releaseNode(say); say.replaceChildren();
      if (dock.dataset.for !== found.identity) {
        releaseNode(dock); dock.replaceChildren();
        mountSharedContent(dock, <Container padding="sm"><DockedComposer note={{ record: `file:${found.identity}`, files: [{ identity: found.identity }], clock }} /></Container>);
        dock.dataset.for = found.identity;
      }
      if (reviewFor !== found.identity) {
        releaseNode(reviewHost);
        // Absence is unknown until this file's recording-owner read answers.
        // Keep the transcript slot present so the first review paint cannot
        // describe a pending read as a missing saved transcript.
        transcript.hidden = false;
        mountSharedContent(reviewHost, (
          <MeetingReview identity={found.identity} title={baseName(name)} audioHost={stage} transcript={transcript} clock={clock} recordingId={savedRecordingId} recordedAt={recordingOwner?.recorded_at} recordingPart={recordingOwner?.part}
            onOwnerRead={read => {
              if (disposed || drawn?.identity !== found.identity) return;
              if (read.state === 'ready') {
                if (read.owner) {
                  resolvedRecordingOwner = {part: read.owner.part, recorded_file_id: read.owner.id, recorded_at: read.owner.recordedAt};
                  if (read.owner.transcriptFile) { showTranscript(read.owner.transcriptFile); return; }
                } else if (transcriptFileId && !recordingOwner) {
                  showTranscript(transcriptFileId); return;
                }
                transcriptShownFor = null;
                void showKeptTranscript(found.identity);
                return;
              }
              // An explicitly supplied sidecar can also belong to a generic
              // audio file outside the recording library. Its own byte read is
              // independent of that library's discovery or refusal.
              if (transcriptFileId && !recordingOwner) return;
              transcriptShownFor = null;
              const words = meetingReview.transcript_read;
              mountSharedContent(transcript, <Container layout="vertical" gap="sm" className="trillion-file-transcript-content">
                <Text variant="body" color="subtle" role={read.state === 'failed' ? 'alert' : 'status'}>
                  {read.state === 'loading' ? words.loading : `${words.failed} ${read.message}`}
                </Text>
                {read.state === 'failed' ? <Button variant="outline" size="sm" onClick={read.retry}>{words.retry}</Button> : null}
              </Container>);
              transcript.hidden = false;
            }}
            onSeek={seconds => addToPreview({ seekRequest: { requestId: seeks += 1, seconds } })} />
        ));
        reviewFor = found.identity;
      }
    } else {
      if (reviewFor) { releaseNode(reviewHost); reviewFor = null; }
      releaseNode(dock); dock.replaceChildren(); delete dock.dataset.for;
      mountSharedContent(say, <SayAboutThis record={`file:${found.identity}`} files={[{ identity: found.identity }]} title={baseName(name)} />);
    }
    // Who sees this file: the one sharing sheet, for the stored file itself.
    mountSharedContent(actions, (<>
      <Button variant="ghost" size="sm" onClick={event => openSharing(`file:${found.identity}`, { title: baseName(name), anchor: event.currentTarget })}>
        <NamedIcon name="Share2" size="sm" aria-hidden="true" />
        Share
      </Button>
    </>));
    if (recording) { mountSharedContent(shareRow, <NoteShareRow record={`file:${found.identity}`} title={baseName(name)} />); shareRow.hidden = false; }
    else { releaseNode(shareRow); shareRow.hidden = true; }
    if (!drawn) {
      void keepFileUse(found.identity, 'opened');
      stopWatching = whenWatched(stage, () => void keepFileUse(found.identity, 'watched'));
    }
    drawn = { identity: found.identity, name, type };
  }

  const readFound = () => readFileLookup<Found>(asked);
  const load = () => loadScreen(stage, {
    loading: { label: 'Opening the file', layout: 'preview' },
    read: readFound,
    failed: refusal('This file could not open'),
    clear: () => { releaseNode(stage); preview = null; drawn = null; },
    draw: drawFile,
  });

  // Show picked bytes at once; once stored, one file becomes its own file tab and
  // several become one closable carousel tab in the same container.
  async function keepDroppedFiles(files: File[]) {
    if (files.length === 0) return;
    droppedUrls = files.map((file) => URL.createObjectURL(file));
    if (files.length === 1) show(`${DROPPED_INTO === '/' ? '' : DROPPED_INTO}/${files[0].name}`, droppedUrls[0], files[0].type);
    else showGallery(files.map((file, index) => ({
      id: droppedUrls[index],
      src: droppedUrls[index],
      name: file.name,
      type: file.type || 'application/octet-stream',
    })));
    const label = files.length === 1 ? files[0].name : `${files.length} files`;
    const note = notify(`Adding ${label} to your files`, { kind: 'transfer', progress: { value: 0 }, timeout: 0, key: `drop:${Date.now()}` });
    try {
      const total = files.reduce((sum, file) => sum + file.size, 0);
      const progress = new Map<string, number>();
      const stored = await uploadFiles(files, DROPPED_INTO, (name, share) => {
        progress.set(name, share);
        const done = files.reduce((sum, file) => sum + file.size * (progress.get(file.name) ?? 0), 0);
        note.update({ progress: { value: total ? done / total : 1 } });
      });
      note.finish({ title: `${label} ${files.length === 1 ? 'is' : 'are'} in your files`, progress: null, timeout: 5000 });
      const instance = input?.surface_instance_ref;
      if (stored.length && typeof instance === 'string' && !disposed) {
        const opened = stored.length === 1
          ? fileTab({ id: stored[0].identity, name: files[0].name, type: files[0].type })
          : {
              id: typeof input?.filePresentationSurfaceId === 'string' ? input.filePresentationSurfaceId : 'trillion.file',
              title: `${stored.length} files`,
              surfaceInput: { files: stored.map((file, index) => ({ id: file.identity, name: files[index].name, type: files[index].type || 'application/octet-stream' })) },
            };
        open({ ...opened, replacesInstance: instance });
      }
    } catch (error) {
      note.finish({ title: `${label} could not be added to your files`, detail: errorWords(error), kind: 'error', progress: null, timeout: 0 });
    }
  }

  // An opener that named the stored file and its type (open-screen.ts fileTab) shows it at once; the Worker's answer
  // then only fills in what the opener did not know. Anything else waits on that answer.
  const known = IDENTITY.test(asked) && typed !== '';
  if (known) {
    drawFile({ identity: asked, media_type: typed, names: [] });
    void readFound().then(found => { if (!disposed && found) drawFile(found); }, () => {});
  }
  const screen = asked && !known ? load() : null;
  if (presentedFiles.length > 0) showGallery(presentedFiles);
  else if (!asked && pickedFiles.length > 0) void keepDroppedFiles(pickedFiles);
  else if (!asked && (input?.subjectRef || input?.subjectRefs)) mountScreenState(stage, { status: 'empty', icon: 'FileQuestion', title: 'These files are no longer here', description: 'Drop them again, or open them from Files.', action: goTo('Open Files', 'trillion.files') });
  else if (!asked) mountScreenState(stage, { status: 'empty', icon: 'FileQuestion', title: 'No file was named', description: 'Open a file from Files.', action: goTo('Open Files', 'trillion.files') });

  return () => {
    disposed = true;
    screen?.dispose();
    stopWatching?.();
    unmountPath?.();
    releaseNode(stage);
    releaseNode(editorHost);
    releaseNode(reviewHost);
    releaseNode(shareRow);
    releaseNode(dock);
    releaseNode(transcript);
    if (droppedUrls.length) { const urls = [...droppedUrls]; queueMicrotask(() => urls.forEach((url) => URL.revokeObjectURL(url))); }
    element.classList.remove('trillion-file');
    element.replaceChildren();
  };
}
