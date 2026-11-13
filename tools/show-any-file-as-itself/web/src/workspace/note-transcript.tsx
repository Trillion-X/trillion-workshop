// src/workspace/note-transcript.tsx
//
// PURPOSE
//   A recording's transcript on its note: the shared transcript reader (parts/transcript-reader) over the recording's
//   kept words, following the player, with the note's tools: click a speaker to rename them or take the name back,
//   copy a link that opens the recording at a passage, hear the recording again in another language, Copy transcript,
//   Export PDF, and split a passage before a chosen word. A recording whose words are not kept as timed passages shows
//   what the caller gives it instead (the saved transcript file).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The words are the recording's own kept `transcript` result (the transcription tool's, read by any identity of
//      the file); an edit writes that same result again, and only after reading it once more and finding it as this
//      screen showed it. A transcript changed meanwhile is refused with words, never overwritten.
//   2. A rename or split changes labels and passage boundaries only: no word and no second is added, lost or moved.
//   3. Every outcome is said in words (parts/transcript-reader/show/transcript-tools.json); a copy says "copied" only
//      when the clipboard write happened (note-actions.ts).
//   4. Hearing it again in a language is the account's transcription tool asked with that language; the old words stay
//      until the new ones are kept.

import React from 'react';
import { TranscriptReaderSurface } from '../../parts/transcript-reader/show/TranscriptReaderSurface';
import type { TranscriptSegment } from '../../parts/transcript-reader/read-data/read-transcript-records';
import { nameSpeaker, namedSpeakers, splitPassage, takeNameBack, transcriptAsText, type EditPassage } from '../../parts/transcript-reader/read-data/edit-transcript';
import words from '../../parts/transcript-reader/show/transcript-tools.json' with { type: 'json' };
import { linkTo } from '../../parts/ui/show/clipboard/answer-copy.mjs';
import { copyTextToClipboard } from '../../../../ui/show/clipboard/copy-text.ts';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { fileResults } from './api';
import { transcribeFile } from './media-transcribe';
import { copyNoteText, saveNotePdf } from './note-actions';
import type { PlayClock } from './say-about-this';

type Kept = { text?: string; segments?: EditPassage[]; [more: string]: unknown };
type KeptRead = { results: { value: Kept }[] };
const say = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
const PRODUCER = 'trillion transcript editor';

/** The recording's kept transcript result, or null when there is none. */
async function readKept(identity: string): Promise<Kept | null> {
  const answer = await fileResults.read<KeptRead>(identity, 'transcript');
  return answer.results[0]?.value ?? null;
}

const sameWords = (a: Kept | null, b: Kept | null) => JSON.stringify(a?.segments ?? null) === JSON.stringify(b?.segments ?? null);

export function NoteTranscript({ identity, title, clock, onSeek, children }: {
  /** The recording's own identity (the audio or video the words belong to). */
  identity: string;
  title: string;
  clock: PlayClock;
  onSeek: (seconds: number) => void;
  /** What shows when the recording has no timed words kept. */
  children: React.ReactNode;
}) {
  const [kept, setKept] = React.useState<Kept | null | undefined>(undefined);
  const [now, setNow] = React.useState(0);
  const shown = React.useRef<Kept | null>(null);
  shown.current = kept ?? null;

  React.useEffect(() => {
    let live = true;
    setKept(undefined);
    if (!identity) return undefined;
    readKept(identity).then(value => { if (live) setKept(value); }, () => { if (live) setKept(null); });
    return () => { live = false; };
  }, [identity]);
  React.useEffect(() => { setNow(clock.now()); return clock.subscribe(() => setNow(clock.now())); }, [clock]);

  const passages = React.useMemo(() => kept?.segments ?? [], [kept]);
  const segments: TranscriptSegment[] = React.useMemo(() => passages.map((passage, index) => ({
    id: `${identity}#${index}`, transcript_ref: identity, text: passage.text, speaker: passage.speaker,
    start_ms: Math.round(passage.start * 1000), end_ms: Math.round(passage.end * 1000), words: passage.words,
  })), [identity, passages]);

  // Writes the edited passages as the recording's transcript, after finding it as this screen showed it.
  const keep = React.useCallback(async (edit: (current: EditPassage[]) => EditPassage[]) => {
    const before = shown.current;
    const latest = await readKept(identity);
    if (!before || !sameWords(before, latest)) { setKept(latest); throw new Error(words.reprocess.stale); }
    const next: Kept = { ...before, segments: edit(before.segments ?? []) };
    await fileResults.record([{ identity, kind: 'transcript', value: next, produced_by: PRODUCER }]);
    setKept(next);
  }, [identity]);

  const attempt = async (work: () => Promise<void>, done: string, failed: string) => {
    try { await work(); if (done) notify(done); } catch (error) { notify(failed, { kind: 'error', detail: errorWords(error) }); }
  };

  if (!identity || kept === undefined || !passages.length || !passages.some(passage => passage.words?.length || passage.text)) return <>{children}</>;
  const everyone = passages;
  const tools = {
    canTakeBack: (speaker: string) => namedSpeakers(everyone).includes(speaker),
    onNameSpeaker: (speaker: string, name: string | null) => attempt(
      () => keep(current => name === null ? takeNameBack(current, speaker) : nameSpeaker(current, speaker, name)),
      name === null ? say(words.speaker.taken_back, { name: speaker }) : say(words.speaker.named, { from: speaker, name }), words.speaker.failed),
    onCopyMoment: async (seconds: number) => {
      const time = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
      const link = linkTo(`${window.location.origin}/file/${encodeURIComponent(identity)}`, Math.floor(seconds));
      if (await copyTextToClipboard(link)) notify(say(words.moment.done, { time })); else notify(words.moment.failed, { kind: 'error', detail: words.moment.detail });
    },
    onSplit: (segment: TranscriptSegment, wordIndex: number) => attempt(
      () => keep(current => splitPassage(current, segments.findIndex(row => row.id === segment.id), wordIndex)), words.split.done, words.split.failed),
    onCopy: () => { void copyNoteText(transcriptAsText(everyone), words.copy); },
    onExportPdf: () => { saveNotePdf(title, [{ text: transcriptAsText(everyone) }], words.pdf); },
    onReprocess: (language: { code: string; label: string }) => attempt(async () => {
      notify(say(words.reprocess.started, { language: language.label }));
      await transcribeFile(identity, { language: language.code });
      setKept(await readKept(identity));
    }, say(words.reprocess.done, { language: language.label }), words.reprocess.failed),
  };
  return <TranscriptReaderSurface title={title} segments={segments} currentTimeSeconds={now} tools={tools}
    onSelectTime={seconds => onSeek(seconds)} />;
}
