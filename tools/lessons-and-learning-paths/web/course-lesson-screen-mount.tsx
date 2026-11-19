// tools/lessons-and-learning-paths/web/course-lesson-screen-mount.tsx
//
// PURPOSE
//   The lesson page (tool:show-the-courses-a-learner-is-on's screen) as a screen module: the one file the screen's row
//   names (`screen.module.entry`), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). The page itself is ../packages/course-lesson/show/CourseLessonSurface.tsx, moved
//   here byte for byte from bitfield-packages (moved-from.json) and edited only in its import paths and for the video
//   and mark-done controls. This file reads the one lesson row the screen's input names and the learner's done row for
//   it, and gives the page what they hold; it takes the place of the retired Bitfield package entry
//   (mount-course-lesson.tsx), which is not carried.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The lesson is the person's own `record:lesson` row, read through the records door; nothing here holds lesson text.
//   2. A field the row does not hold is left out of the page's input; the page's own empty state shows an unwritten lesson.
//   3. The only row this writes is the learner's done row for this course and lesson (read-data/lesson-done.mjs), and
//      only when the person marks the lesson done.
//   4. The video is the lesson row's field the screen input names (`video_field`, the business's own field role for
//      its video); no field name is assumed here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, Text, mountReactSurface } from '../../ui';
import { CourseLessonSurface, type CourseLessonInput } from '../packages/course-lesson/show/CourseLessonSurface';
import { lessonInputOf } from '../read-data/lesson-input.mjs';
import { LESSON_DONE_TYPE, lessonDoneRecordId, lessonDoneValue } from '../read-data/lesson-done.mjs';
import { readRecord, writeRecords } from '#workspace/records-door';

type LessonScreenInput = { lesson_id?: string; course_id?: string; video_field?: string; floating_frame?: unknown };
type LessonValue = Record<string, unknown> | null;

const LESSON_ROW_TYPE = 'record:lesson';

function LessonScreen({ lessonId, courseId, videoField, frame }: { lessonId: string; courseId: string; videoField: string | null; frame: unknown }) {
  const [value, setValue] = React.useState<LessonValue>(null);
  const [done, setDone] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let gone = false;
    setValue(null);
    setDone(false);
    setFailed(false);
    if (lessonId) void readRecord(lessonId, LESSON_ROW_TYPE).then(row => { if (!gone) setValue(row); });
    if (lessonId && courseId) {
      void readRecord(lessonDoneRecordId(courseId, lessonId), LESSON_DONE_TYPE).then(row => { if (!gone) setDone(row !== null); });
    }
    return () => { gone = true; };
  }, [lessonId, courseId]);
  const markDone = React.useCallback(async () => {
    setFailed(false);
    try {
      await writeRecords([{ id: lessonDoneRecordId(courseId, lessonId), type: LESSON_DONE_TYPE, value: lessonDoneValue(courseId, lessonId, new Date().toISOString()) }]);
      setDone(true);
    } catch {
      setFailed(true);
    }
  }, [courseId, lessonId]);
  const input = lessonInputOf(lessonId, value, videoField) as CourseLessonInput;
  return (
    <FloatingMaterialFrame frame={frame}>
      <ErrorBoundary zoneName="course lesson material">
        <CourseLessonSurface input={{ ...input, done }} onMarkDone={courseId ? markDone : undefined} />
        {failed ? <Text variant="body-sm" color="secondary">The lesson could not be marked done. Try again.</Text> : null}
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mount(element: HTMLElement, props: LessonScreenInput = {}) {
  return mountReactSurface(element, <LessonScreen lessonId={props.lesson_id ?? ''} courseId={props.course_id ?? ''} videoField={props.video_field || null} frame={props.floating_frame} />);
}
