// tools/lessons-and-learning-paths/show/Course.tsx
//
// PURPOSE
//   The screen of tool:read-a-course: one course with its lessons in order, each a link to its lesson, a mark on the lessons
//   the learner has done, and how many that is. A page and an AI app draw the same screen from the same answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. View is pure: no fetch and no window while it renders. Its props are the answer of the read (do-work/courses.ts
//      readCourse) and a few words and slots the host may add; nothing is read from a database here.
//   2. A lesson's address is the one the read gave (href); the screen makes none.
//   3. A done mark is drawn only for a lesson the answer marks done, and the count is the answer's own doneCount.
//   4. Everything drawn is a shared part (Text, Button, ProgressBar); no raw HTML and no inline styling. A host that wants a
//      button of its own (a membership, a checkout) passes it as `action`; nothing about payment is known here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button } from '../../ui/show/button/Button.tsx';
import { ProgressBar } from '../../ui/show/progress-bar/ProgressBar.tsx';
import { Text } from '../../ui/show/text/Text.tsx';
import type { CourseAnswer } from '../do-work/courses.ts';

export type CourseProps = CourseAnswer & {
  /** A part the host draws under the description (a button to join, a link to continue). */
  action?: React.ReactNode;
  /** The word after the count of lessons, singular and plural. */
  lessonWords?: { one: string; many: string };
  /** The words said of a lesson the learner has done. */
  doneLabel?: string;
};

const WORDS = { lessons: { one: 'lesson', many: 'lessons' }, done: 'Done' } as const;

export function View({ course, lessons, doneCount, action, lessonWords = WORDS.lessons, doneLabel = WORDS.done }: CourseProps) {
  const count = `${lessons.length} ${lessons.length === 1 ? lessonWords.one : lessonWords.many}`;
  const percentage = lessons.length === 0 ? 0 : Math.round((doneCount / lessons.length) * 100);
  return (
    <Text as="section" className="grid gap-6" data-course={course.slug}>
      <Text as="header" className="grid gap-3">
        <Text as="h1" variant="title">{course.title}</Text>
        {course.description === '' ? null : <Text as="p" color="muted">{course.description}</Text>}
        {action ?? null}
      </Text>
      <Text as="div" className="grid gap-2" data-course-progress={`${doneCount}/${lessons.length}`}>
        <Text as="p" variant="label" color="muted">{doneCount > 0 ? `${doneCount} of ${count} ${doneLabel.toLowerCase()}` : count}</Text>
        <ProgressBar percentage={percentage} color="var(--color-success)" />
      </Text>
      <Text as="ol" className="m-0 grid list-none gap-2 p-0">
        {lessons.map(lesson => (
          <Text as="li" key={lesson.id} data-lesson={lesson.id} data-done={lesson.done ? 'true' : 'false'}>
            <Button variant="ghost" href={lesson.href} className="h-auto w-full justify-start gap-3 py-2 text-start">
              <Text as="span" color="muted">{lesson.position}</Text>
              <Text as="span">{lesson.title}</Text>
              {lesson.done ? <Text as="span" variant="label" color="success">{doneLabel}</Text> : null}
            </Button>
          </Text>
        ))}
      </Text>
    </Text>
  );
}
