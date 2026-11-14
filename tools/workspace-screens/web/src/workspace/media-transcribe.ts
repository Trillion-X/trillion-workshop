// src/workspace/media-transcribe.ts
//
// PURPOSE
//   Work out the words said in recordings from the page: each recording's own run of the account's transcription tool
//   (tool:transcribe-file, through POST /work/api/media/transcribe in src/work-media.mjs), read again until it finishes,
//   with one progress card for the whole batch that ends by showing the words. Media's "Transcribe" action and the
//   editor's words panel both start transcription here, so a recording is transcribed the same way from anywhere.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The transcript is the tool's own, kept beside the file (kind `transcript`, src/transcript-words.mjs); the page
//      shows what the run returned and never keeps a second copy.
//   2. Only an uploaded audio or video file can be transcribed: its bytes are in the person's files (`1f:` identity).
//   3. Progress and the result are shared notifications (parts/ui notify); nothing here draws its own controls.
//   4. A recording uploaded is transcribed by itself (the rule starting:transcribe-audio / -video), and a run of it
//      that fails is started again by itself a few times (the tool row's `retry`, src/automations.mjs);
//      `wordsOfRecording` says which of these a recording is in, so a screen never offers to start what is running.

import { notify } from '../../parts/ui/show/coss/notifications';
import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';
import { readJson, fileResults } from './api';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
export type TimedWord = { word: string; start: number; end: number };
export type TimedPassage = { start: number; end: number; text: string; speaker?: string; words?: TimedWord[] };
export type Transcript = { text: string; segments: TimedPassage[] };
type Run = { task_id?: string; state?: string; error?: string; output?: Partial<Transcript> & { said?: string } };
type Kept = { results: { value: Partial<Transcript> }[] };
/** The transcription started by itself for a recording: still working (tried again when it fails), or failed for good. */
type ByItself = { run: { state: 'working' | 'failed'; attempt: number; max_attempts: number } | null };
/** Where a recording's words stand: kept, still being made by themselves, failed for good, or never asked for. */
export type RecordingWords =
  | { state: 'ready'; transcript: Transcript }
  | { state: 'making' }
  | { state: 'failed'; why: string }
  | { state: 'none' };

/** A recording whose words can be worked out here: its bytes are uploaded and it is sound or video. */
export const canTranscribe = (item: { file: string | null; media_kind: string | null; media_type: string | null }) =>
  Boolean(item.file && /^1f:[0-9a-f]{64}$/.test(item.file)) && (['audio', 'video'].includes(item.media_kind ?? '') || /^(audio|video)\//.test(item.media_type ?? ''));

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The words said in one uploaded recording (`file`, its `1f:` identity), waiting while the tool works. With a
 *  `language` (ISO code) the recording is heard again in that language, even when words are already kept. */
export async function transcribeFile(file: string, { every = 3000, language }: { every?: number; language?: string } = {}): Promise<Transcript> {
  let run = await readJson<Run>('/work/api/media/transcribe', { method: 'POST', body: JSON.stringify({ identity: file, ...(language ? { language } : {}) }) });
  while ((run.state === 'working' || run.state === 'scheduled') && run.task_id) {
    await pause(every);
    run = await readJson<Run>(`/work/api/media/transcribe?task=${encodeURIComponent(run.task_id)}`);
  }
  const text = run.output?.text?.trim();
  if (run.state !== 'completed' || !text) throw new Error(run.error ?? run.output?.said ?? 'The words in this recording could not be worked out.');
  return { text, segments: run.output?.segments ?? [] };
}

/**
 * The words of one recording: its kept transcript (read by `source`, any identity of the recording), else how the
 * transcription started by itself for its uploaded file (`file`, its `1f:` identity) stands.
 */
export async function wordsOfRecording(source: string, file: string | null): Promise<RecordingWords> {
  const kept = await fileResults.read<Kept>(source, 'transcript');
  const value = kept.results[0]?.value;
  if (value?.text) return { state: 'ready', transcript: { text: value.text, segments: value.segments ?? [] } };
  if (!file) return { state: 'none' };
  const { run } = await readJson<ByItself>(`/work/api/media/transcribe?identity=${encodeURIComponent(file)}`);
  if (run?.state === 'working') return { state: 'making' };
  if (run?.state === 'failed') return { state: 'failed', why: `Trillion tried ${run.attempt} ${run.attempt === 1 ? 'time' : 'times'} and could not make out the words in this clip.` };
  return { state: 'none' };
}

const excerpt = (text: string) => (text.length > 280 ? `${text.slice(0, 277).trimEnd()}…` : text);

/** Transcribe each recording, with one progress card that ends by showing the words; `changed` runs as each finishes. */
export async function transcribeRecordings(items: { file: string; title: string }[], changed: () => void = () => {}): Promise<void> {
  if (!items.length) return;
  const total = items.length;
  const card = notify(total === 1 ? `Transcribing ${items[0].title}` : `Transcribing ${total} recordings`, {
    kind: 'transcription', progress: { value: null, label: total === 1 ? 'Listening for the words' : `0 of ${total} done` },
  });
  let done = 0;
  const heard: { title: string; text: string }[] = [];
  const failed: string[] = [];
  await Promise.all(items.map(async item => {
    try { heard.push({ title: item.title, text: (await transcribeFile(item.file)).text }); } catch (error) { failed.push(`${item.title}: ${errorWords(error)}`); }
    done += 1;
    if (total > 1) card.update({ progress: { value: done / total, label: `${done} of ${total} done` } });
    changed();
  }));
  const words = heard.map(item => (heard.length === 1 ? item.text : `${item.title}\n${item.text}`)).join('\n\n');
  card.finish({
    title: !heard.length ? (total === 1 ? 'The words could not be worked out' : 'No recording could be transcribed')
      : heard.length === 1 ? `What is said in ${heard[0].title}` : `${heard.length} transcripts ready`,
    kind: heard.length ? 'done' : 'error',
    detail: [heard.length ? excerpt(words) : '', ...failed].filter(Boolean).join('\n\n'),
    actions: heard.length ? [{ label: heard.length === 1 ? 'Copy the words' : 'Copy them all', dismisses: false, onAction: async () => { if (!(await copyTextToClipboard(words))) notify('The words could not be copied', { kind: 'error' }); } }] : [],
    timeout: 0,
  });
}
