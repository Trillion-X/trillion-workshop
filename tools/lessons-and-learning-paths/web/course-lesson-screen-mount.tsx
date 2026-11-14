// tools/lessons-and-learning-paths/web/course-lesson-screen-mount.tsx
//
// PURPOSE
//   The lesson page (tool:show-the-courses-a-learner-is-on's screen) as a screen module: the one file the screen's row
//   names (`screen.module.entry`), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). The page itself is ../packages/course-lesson/show/CourseLessonSurface.tsx, moved
//   here byte for byte from bitfield-packages (moved-from.json) and edited only in its import paths. This file reads the
//   one lesson row the screen's input names and gives the page what the row holds; it takes the place of the retired
//   Bitfield package entry (mount-course-lesson.tsx), which is not carried.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The lesson is the person's own `record:lesson` row, read through the records door; nothing here holds lesson text.
//   2. A field the row does not hold is left out of the page's input; the page's own empty state shows an unwritten lesson.
//   3. Nothing here writes a row.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui';
import { CourseLessonSurface, type CourseLessonInput } from '../packages/course-lesson/show/CourseLessonSurface';
import { lessonInputOf } from '../read-data/lesson-input.mjs';
import { readRecord } from '#workspace/records-door';

type LessonScreenInput = { lesson_id?: string; floating_frame?: unknown };
type LessonValue = Record<string, unknown> | null;

const LESSON_ROW_TYPE = 'record:lesson';

function LessonScreen({ lessonId, frame }: { lessonId: string; frame: unknown }) {
  const [value, setValue] = React.useState<LessonValue>(null);
  React.useEffect(() => {
    let gone = false;
    setValue(null);
    if (lessonId) void readRecord(lessonId, LESSON_ROW_TYPE).then(row => { if (!gone) setValue(row); });
    return () => { gone = true; };
  }, [lessonId]);
  return (
    <FloatingMaterialFrame frame={frame}>
      <ErrorBoundary zoneName="course lesson material">
        <CourseLessonSurface input={lessonInputOf(lessonId, value) as CourseLessonInput} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mount(element: HTMLElement, props: LessonScreenInput = {}) {
  return mountReactSurface(element, <LessonScreen lessonId={props.lesson_id ?? ''} frame={props.floating_frame} />);
}
