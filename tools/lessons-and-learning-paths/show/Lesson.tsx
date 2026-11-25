// tools/lessons-and-learning-paths/show/Lesson.tsx
//
// PURPOSE
//   The screen of tool:read-a-lesson: one lesson with its recording, the words of the recording as a transcript reader
//   beside it, a mark-done button, and the way to the lesson before and after. A recording with a YouTube address is
//   framed from its embed address; a recording kept in storage is the shared player (a video element with its own controls
//   and captions) on the storage address. A page and an AI app draw the same screen from the same answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. View is pure: no fetch and no window while it renders. The playback time, the seek, the speaker filter and every press
//      come from the host through props (currentTime, seekRequest, speakerFilter, onTimeChange, onSeek, onFilterSpeaker,
//      onMarkDone); nothing here reads a player.
//   2. A lesson with no recording draws its words and its way on, without a player; a lesson with no timed words draws no
//      transcript. Nothing is invented for either.
//   3. Only an https embed address is framed, and only the address the read answered; the frame is the shared LiveFrame.
//   4. The transcript's edit controls appear only when props.viewer.isOwner is true (TranscriptReader's own rule).
//   5. Everything drawn is a shared part; no raw HTML and no inline styling.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button } from '../../ui/show/button/Button.tsx';
import { LiveFrame } from '../../ui/show/live-frame/LiveFrame.tsx';
import { Text } from '../../ui/show/text/Text.tsx';
import { MediaPlaybackSurface, type TimedTextSegment } from '../../media-playback/show/MediaPlaybackSurface.tsx';
import type { LessonAnswer, Passage, VideoAnswer } from '../do-work/courses.ts';
import { View as TranscriptReader, type TranscriptReaderProps } from './TranscriptReader.tsx';

export type LessonProps = LessonAnswer & Pick<TranscriptReaderProps, 'currentTime' | 'speakerFilter' | 'viewer' | 'onSeek' | 'onFilterSpeaker' | 'onRenameSpeaker' | 'onSplitPassage'> & {
  /** The host's seek on the shared player: a new requestId moves it to `seconds`. */
  seekRequest?: { requestId: number; seconds: number } | null;
  onTimeChange?: (currentTime: number, duration: number) => void;
  onMarkDone?: () => void;
  /** The words of the buttons and links; plain defaults. */
  words?: { markDone: string; done: string; previous: string; next: string; course: string };
  /** Where the course page is, for the link back. */
  courseHref?: string;
};

const WORDS = { markDone: 'Mark this lesson done', done: 'Done', previous: 'Previous', next: 'Next', course: 'Back to the course' } as const;

// What the screen hands the player for a recording: the frame's address for a YouTube recording, the storage address for a file.
function playerOf(video: VideoAnswer): { kind: 'frame'; src: string } | { kind: 'file'; src: string } | null {
  if (video === null) return null;
  return video.kind === 'youtube' ? { kind: 'frame', src: video.embedUrl } : { kind: 'file', src: video.url };
}

const timedText = (segments: readonly Passage[]): TimedTextSegment[] =>
  segments.map(passage => ({ id: passage.id, speaker: passage.speaker, text: passage.text, start_ms: Math.round(passage.start * 1000), end_ms: Math.round(passage.end * 1000), words: passage.words }));

export function View({ course, lesson, video, segments, previous, next, seekRequest, onTimeChange, onMarkDone, courseHref, words = WORDS, ...reader }: LessonProps) {
  const player = playerOf(video);
  return (
    <Text as="article" className="grid gap-6" data-lesson={lesson.id} data-done={lesson.done ? 'true' : 'false'}>
      <Text as="header" className="grid gap-2">
        {courseHref === undefined
          ? <Text as="p" variant="label" color="muted">{course.title}</Text>
          : <Button variant="plain" href={courseHref}>{`${words.course}: ${course.title}`}</Button>}
        <Text as="h1" variant="title">{lesson.title}</Text>
      </Text>
      {player === null ? null : player.kind === 'frame'
        ? <LiveFrame src={player.src} title={lesson.title} allow="encrypted-media; picture-in-picture; fullscreen" />
        : (
          <MediaPlaybackSurface
            media={{ id: lesson.id, label: lesson.title, playback_url: player.src, mime_type: 'video/mp4' }}
            timedTextSegments={timedText(segments)}
            transcriptPlacement="beside-media"
            seekRequest={seekRequest}
            onTimeChange={onTimeChange}
          />
        )}
      {segments.length === 0 ? null : <TranscriptReader segments={segments} {...reader} />}
      <Text as="div" className="flex flex-wrap items-center gap-3">
        {lesson.done
          ? <Text as="span" variant="label" color="success" data-lesson-done>{words.done}</Text>
          : <Button variant="primary" data-lesson-mark-done={lesson.id} onClick={onMarkDone}>{words.markDone}</Button>}
        {previous === null ? null : <Button variant="ghost" href={previous.href}>{`${words.previous}: ${previous.title}`}</Button>}
        {next === null ? null : <Button variant="ghost" href={next.href}>{`${words.next}: ${next.title}`}</Button>}
      </Text>
    </Text>
  );
}
