// tools/lessons-and-learning-paths/show/TranscriptReader.tsx
//
// PURPOSE
//   The words of a recording below its player: each passage with its speaker, each word marked as the recording reaches it,
//   a press on a word seeking the player there, a press on a speaker showing only that speaker's passages. The caption
//   reader of media-playback draws the same words over a picture; this is the page's own reader beside it, with the same
//   word marks (screen-look's timedWordClass) and the same speaker rules (transcript-reader/read-data).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: the view draws its props. The playback time, the speaker filter and every press come from the host through
//      `currentTime`, `speakerFilter`, `onSeek` and `onFilterSpeaker`; nothing here reads the window or a player.
//   2. A passage with no timed words is spread evenly over its start and end, so the mark still moves through it.
//   3. The edit controls (naming a speaker, splitting a passage before the marked word) are drawn only when
//      `viewer.isOwner` is true; a reader sees none of them, and the owner's presses go to `onRenameSpeaker` and
//      `onSplitPassage`, which the host answers through the transcript-reader edit tool.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button } from '../../ui/show/button/Button';
import { Container } from '../../ui/show/container';
import { InlineTextAction } from '../../ui/show/inline-text-action/InlineTextAction';
import { Text } from '../../ui/show/text/Text';
import { timedPassageClass, timedWordClass } from '../../screen-look/show/timed-text-style';
import { transcriptSegmentsForSpeaker, transcriptSpeakers } from '../../transcript-reader/read-data/read-transcript-records';

export type TimedWord = { word: string; start: number; end: number };
export type Passage = { id: string; start: number; end: number; speaker?: string; text: string; words?: readonly TimedWord[] };

export type TranscriptReaderProps = {
  segments: readonly Passage[];
  currentTime?: number;
  speakerFilter?: string | null;
  viewer?: { isOwner?: boolean };
  onSeek?: (seconds: number) => void;
  onFilterSpeaker?: (speaker: string | null) => void;
  onRenameSpeaker?: (speaker: string) => void;
  onSplitPassage?: (passageId: string, wordIndex: number) => void;
};

// The words of a passage: the stored ones, else its text spread evenly over its own time.
export function wordsOf(passage: Passage): readonly TimedWord[] {
  if (passage.words?.length) return passage.words;
  const parts = passage.text.split(/\s+/).filter(Boolean);
  const each = parts.length ? (passage.end - passage.start) / parts.length : 0;
  return parts.map((word, index) => ({ word, start: passage.start + each * index, end: passage.start + each * (index + 1) }));
}

// The passage the time falls in; between two passages, the one just spoken; -1 before the first passage and after the last.
export function activePassageIndex(segments: readonly Passage[], time: number): number {
  let found = -1;
  segments.forEach((passage, index) => { if (time >= passage.start && (found < 0 || passage.start >= segments[found].start)) found = index; });
  if (found < 0) return -1;
  return time < segments[found].end || found < segments.length - 1 ? found : -1;
}

// The word the time falls in, else the last one already spoken.
export function activeWordIndex(words: readonly TimedWord[], time: number): number {
  const inside = words.findIndex(item => time >= item.start && time < item.end);
  if (inside >= 0) return inside;
  for (let index = words.length - 1; index >= 0; index -= 1) if (time >= words[index].end) return index;
  return -1;
}

export function View({ segments, currentTime = 0, speakerFilter = null, viewer, onSeek, onFilterSpeaker, onRenameSpeaker, onSplitPassage }: TranscriptReaderProps) {
  const speakers = transcriptSpeakers(segments);
  const shown = transcriptSegmentsForSpeaker(segments, speakerFilter);
  const active = activePassageIndex(segments, currentTime);
  const owner = viewer?.isOwner === true;
  return (
    <Container as="section" layout="vertical" gap="md" aria-label="Transcript" data-transcript-reader>
      {speakers.length > 0 && (
        <Container layout="horizontal" gap="sm" wrap alignItems="center" data-transcript-speakers>
          <Button size="sm" variant="ghost" active={speakerFilter === null} onClick={() => onFilterSpeaker?.(null)}>Everyone</Button>
          {speakers.map(speaker => (
            <React.Fragment key={speaker}>
              <Button size="sm" variant="ghost" active={speakerFilter === speaker} onClick={() => onFilterSpeaker?.(speaker)}>{speaker}</Button>
              {owner && <Button size="sm" variant="plain" onClick={() => onRenameSpeaker?.(speaker)}>{`Name ${speaker}`}</Button>}
            </React.Fragment>
          ))}
        </Container>
      )}
      {shown.map(passage => {
        const isActive = segments[active]?.id === passage.id;
        const words = wordsOf(passage);
        const marked = isActive ? activeWordIndex(words, currentTime) : -1;
        const past = currentTime >= passage.end;
        return (
          <Text key={passage.id} as="p" className={timedPassageClass('under-sound')} data-passage={passage.id} data-active={isActive ? 'true' : 'false'}>
            {passage.speaker && <Text as="strong" variant="label" weight="medium">{`${passage.speaker}: `}</Text>}
            {words.map((item, index) => (
              <React.Fragment key={`${passage.id}:${index}`}>
                <InlineTextAction
                  className={timedWordClass('under-sound', isActive && index === marked, isActive ? index < marked : past)}
                  data-word-active={isActive && index === marked ? 'true' : 'false'}
                  onSelect={() => onSeek?.(item.start)}
                >{item.word}</InlineTextAction>{' '}
              </React.Fragment>
            ))}
            {owner && isActive && marked > 0 && (
              <Button size="xs" variant="plain" onClick={() => onSplitPassage?.(passage.id, marked)}>Split before this word</Button>
            )}
          </Text>
        );
      })}
    </Container>
  );
}
