// src/workspace/media-edit/transcribe-panel.tsx
//
// PURPOSE
//   The editor's Words panel: what is said in the selected clip, each word at its own second (the shared transcript
//   reader). Choosing a word plays from there; choosing a passage and "Use only this part" trims the clip to exactly
//   where that passage is said. An uploaded clip is transcribed by itself: while its words are still being made the
//   panel says so and shows them the moment they are kept; when making them failed for good it says so with "Try
//   again". A clip with no words and nothing making them gets "Transcribe". Both run the account's transcription tool
//   (src/workspace/media-transcribe.ts) and show the words when it finishes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The words are the recording's own kept transcript (kind `transcript`, read by any identity of the file); this
//      panel keeps no copy and saves nothing of its own in the edit.
//   2. Times: a word's `start`/`end` are seconds inside the recording; the cut is changed only through `change`, and
//      a trim never reaches outside the recording.
//   3. Every control is a shared part (Container, Button, Text, ScreenState, TranscriptReaderSurface).

import React from 'react';
import { Button, Container } from '../../../parts/ui';
import { Text } from '../../../parts/ui/show/text';
import { ScreenState } from '../../../parts/ui/show/screen-state';
import { failedState, reasonOf } from '../failure';
import { TranscriptReaderSurface } from '../../../parts/transcript-reader/show/TranscriptReaderSurface';
import type { TranscriptSegment } from '../../../parts/transcript-reader/read-data/read-transcript-records';
import { transcribeFile, wordsOfRecording, type RecordingWords, type Transcript } from '../media-transcribe';
import { definePanel, type MediaEditClip, type MediaEditPanelProps } from './panel-types';
import { insertRange, removeRange } from './cut-list';

const BYTES = '/work/api/namespace/bytes/';
// How often the panel looks again while a clip's words are being made by themselves.
const LOOK_AGAIN_MS = 5000;
type Words = { state: 'reading' } | { state: 'working' } | RecordingWords;

/** The uploaded file a clip plays, as its `1f:` identity, read from the address its bytes come from. */
const fileOf = (clip: MediaEditClip) => {
  const file = clip.bytes.startsWith(BYTES) ? decodeURIComponent(clip.bytes.slice(BYTES.length)) : clip.identity;
  return /^1f:[0-9a-f]{64}$/.test(file) ? file : null;
};

/** The kept transcript's passages in the reader's shape, times in milliseconds. */
const passages = (transcript: Transcript, ref: string): TranscriptSegment[] => transcript.segments.map((segment, index) => ({
  id: `${ref}#${index}`, transcript_ref: ref, text: segment.text, speaker: segment.speaker, start_ms: Math.round(segment.start * 1000), end_ms: Math.round(segment.end * 1000),
  words: segment.words,
}));

const reason = (error: unknown) => reasonOf(error);

function WordsPanel({ active, playhead, timelineStart, clips, selected, change, seek, setStatus }: MediaEditPanelProps) {
  const [words, setWords] = React.useState<Words>({ state: 'reading' });
  const [chosen, setChosen] = React.useState<TranscriptSegment | null>(null);
  // A stretch of words chosen in the reader (shift-click extends it), in seconds inside the recording.
  const [stretch, setStretch] = React.useState<{ start: number; end: number } | null>(null);
  const source = active ? active.identity : null;
  const file = active ? fileOf(active) : null;

  // The clip's words, looked at again every LOOK_AGAIN_MS while they are still being made by themselves.
  React.useEffect(() => {
    if (!source) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setWords({ state: 'reading' });
    setChosen(null);
    setStretch(null);
    const look = () => wordsOfRecording(source, file).then(
      next => { if (!live) return; setWords(next); if (next.state === 'making') timer = setTimeout(look, LOOK_AGAIN_MS); },
      error => { if (live) setWords({ state: 'failed', why: reason(error) }); },
    );
    look();
    return () => { live = false; clearTimeout(timer); };
  }, [source, file]);

  if (!active) return <ScreenState state={{ status: 'empty', title: 'Choose a clip', description: 'The words said in it show here.', icon: 'AudioLines' }} />;
  const transcribe = () => {
    if (!file) return;
    setWords({ state: 'working' });
    transcribeFile(file).then(transcript => setWords({ state: 'ready', transcript }), error => setWords({ state: 'failed', why: reason(error) }));
  };
  // Seconds inside the recording where the playhead is, and the second in the cut where a recording's second plays.
  const at = active.start + Math.max(0, playhead - timelineStart);
  const inCut = (seconds: number) => timelineStart + (seconds - active.start);
  const useOnly = (segment: TranscriptSegment) => {
    const start = Math.max(0, (segment.start_ms ?? 0) / 1000);
    const end = (segment.end_ms ?? 0) / 1000;
    if (!(end > start)) return;
    change(clips.map((clip, index) => (index === selected ? { ...clip, start, end } : clip)), selected);
  };
  // The chosen words played again as a new clip right after this one, or taken out of this clip where it plays them.
  const attempt = (work: () => void) => { try { work(); setStretch(null); } catch (error) { setStatus(reason(error)); } };
  const addStretch = (range: { start: number; end: number }) => attempt(() => change(insertRange(clips, active, range, selected + 1), selected + 1));
  const inThisClip = stretch && active.end !== null && stretch.end > active.start && stretch.start < active.end;
  const takeOutStretch = (range: { start: number; end: number }) => attempt(() => change(removeRange(clips, inCut(Math.max(range.start, active.start)), inCut(Math.min(range.end, active.end ?? range.end))), selected));

  return (
    <Container data-media-edit-panel="transcribe" layout="vertical" gap="sm" minHeight="0">
      {words.state === 'reading' ? <ScreenState state={{ status: 'loading', label: 'Reading the words' }} /> : null}
      {words.state === 'working' ? <ScreenState state={{ status: 'loading', label: 'Listening for the words' }} /> : null}
      {words.state === 'making' ? (
        <ScreenState state={{ status: 'empty', title: 'Your words are being made', icon: 'Hourglass',
          description: 'Trillion is listening to this clip. The words show here as soon as they are ready.' }} />
      ) : null}
      {words.state === 'none' ? (
        <ScreenState state={{ status: 'empty', title: 'No words yet', icon: 'AudioLines',
          description: file ? 'Work out what is said in this clip, word by word.' : 'Upload this recording to work out what is said in it.',
          ...(file ? { action: { label: 'Transcribe', run: transcribe } } : {}) }} />
      ) : null}
      {words.state === 'failed' ? (
        <ScreenState state={failedState(words.why, file ? transcribe : () => setWords({ state: 'none' }), 'The words could not be made')} />
      ) : null}
      {words.state === 'ready' ? (
        <>
          <TranscriptReaderSurface
            title={active.name}
            segments={passages(words.transcript, active.identity)}
            currentTimeSeconds={at}
            onSelectSegment={segment => { setChosen(segment); seek(inCut((segment.start_ms ?? 0) / 1000)); }}
            onSelectTime={(seconds, segment) => { setChosen(segment); seek(inCut(seconds)); }}
            selectedRange={stretch}
            onSelectRange={setStretch}
          />
          {stretch ? (
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap="wrap">
              <Text variant="body-xs" color="muted">Shift-click another word to choose more.</Text>
              <Container layout="horizontal" gap="xs">
                {inThisClip ? <Button size="xs" variant="ghost" onClick={() => takeOutStretch(stretch)}>Take these words out</Button> : null}
                <Button size="xs" variant="secondary" onClick={() => addStretch(stretch)}>Add as a new clip</Button>
              </Container>
            </Container>
          ) : null}
          {chosen ? (
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
              <Text variant="body-xs" color="muted">{`“${chosen.text}”`}</Text>
              <Button size="xs" variant="accent" onClick={() => useOnly(chosen)}>Use only this part</Button>
            </Container>
          ) : null}
        </>
      ) : null}
    </Container>
  );
}

export const transcribePanel = definePanel<undefined>({ id: 'transcribe', label: 'Words', icon: 'AudioLines', Panel: WordsPanel });
