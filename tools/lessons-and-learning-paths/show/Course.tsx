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
//   3. The course's picture is drawn only when the answer gives one, at the address image_template makes of it; nothing is
//      guessed here.
//   3a. A title whose id starts with "page:" is one the course page names but no lesson holds: it is drawn as text, never as a
//      link, because its address would land on a lesson page that refuses it.
//   3b. A done mark is drawn only for a lesson the answer marks done, and the count is the answer's own doneCount.
//   4. Everything drawn is a shared part (Text, Button, ProgressBar); no raw HTML and no inline styling. A host that wants a
//      button of its own (a membership, a checkout) passes it as `action`; nothing about payment is known here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button } from '../../ui/show/button/Button.tsx';
import { Card } from '../../ui/show/card/Card.tsx';
import { LiveFrame } from '../../ui/show/live-frame/LiveFrame.tsx';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame.tsx';
import { ProgressBar } from '../../ui/show/progress-bar/ProgressBar.tsx';
import { Text } from '../../ui/show/text/Text.tsx';
import type { CourseAnswer } from '../do-work/courses.ts';

export type CourseProps = CourseAnswer & {
  /** A part the host draws under the description (a button to join, a link to continue). */
  action?: React.ReactNode;
  /** Where a course's picture is, with {image} standing for the course's own picture id (the course's first lesson's thumbnail). */
  image_template?: string;
  /** The word after the count of lessons, singular and plural. */
  lessonWords?: { one: string; many: string };
  /** The words said of a lesson the learner has done. */
  doneLabel?: string;
  /** The headings of the three cards, and the word after the category in the line above the title. */
  cardWords?: { learn: string; contents: string; requirements: string; course: string };
};

const WORDS = { lessons: { one: 'lesson', many: 'lessons' }, done: 'Done', cards: { learn: 'What you will learn', contents: 'What is in it', requirements: 'Before you start', course: 'course' } } as const;

// One of the three cards: a heading over the course row's own list; no card for an empty list.
function ListCard({ heading, items, name }: { heading: string; items: readonly string[]; name: string }) {
  if (items.length === 0) return null;
  return (
    <Card as="section" variant="surface" layout="stack" data-course-card={name}>
      <Text as="h3" variant="heading-lg">{heading}</Text>
      <Text as="ul" className="m-0 grid list-none gap-2 p-0">{items.map(item => <Text as="li" key={item}>{item}</Text>)}</Text>
    </Card>
  );
}

export function View({ course, lessons, doneCount, action, image_template = '{image}', lessonWords = WORDS.lessons, doneLabel = WORDS.done, cardWords = WORDS.cards }: CourseProps) {
  const count = `${lessons.length} ${lessons.length === 1 ? lessonWords.one : lessonWords.many}`;
  const percentage = lessons.length === 0 ? 0 : Math.round((doneCount / lessons.length) * 100);
  return (
    <Text as="section" className="grid gap-6" data-course={course.slug}>
      <Text as="header" className="grid gap-3">
        {course.category === undefined || course.category === '' ? null : <Text as="p" variant="label" color="muted" className="uppercase" data-course-eyebrow>{`${course.category} ${cardWords.course} · ${count}`}</Text>}
        <Text as="h1" variant="title">{course.title}</Text>
        {course.description === '' ? null : <Text as="p" color="muted">{course.description}</Text>}
        {action ?? null}
      </Text>
      {course.image === undefined || course.image === ''
        ? (course.preview_video_id === undefined || course.preview_video_id === '' ? null : <LiveFrame src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(course.preview_video_id)}`} title={course.title} allow="encrypted-media; picture-in-picture; fullscreen" />)
        : <MediaFrame url={image_template.replace('{image}', course.image)} mediaType="image/jpeg" label={course.title} />}
      <Text as="div" className="grid gap-4 sm:grid-cols-3" data-course-cards>
        <ListCard heading={cardWords.learn} items={course.learning_objectives ?? []} name="learn" />
        <ListCard heading={cardWords.contents} items={course.features ?? []} name="contents" />
        <ListCard heading={cardWords.requirements} items={course.requirements ?? []} name="requirements" />
      </Text>
      {course.short_description === undefined || course.short_description === '' ? null : <Text as="h2" variant="heading-lg" data-course-lessons-heading>{course.short_description}</Text>}
      <Text as="div" className="grid gap-2" data-course-progress={`${doneCount}/${lessons.length}`}>
        <Text as="p" variant="label" color="muted">{doneCount > 0 ? `${doneCount} of ${count} ${doneLabel.toLowerCase()}` : count}</Text>
        <ProgressBar percentage={percentage} color="var(--color-success)" />
      </Text>
      <Text as="ol" className="m-0 grid list-none gap-2 p-0">
        {lessons.map(lesson => (
          <Text as="li" key={lesson.id} data-lesson={lesson.id} data-done={lesson.done ? 'true' : 'false'}>
            {lesson.id.startsWith('page:')
              ? (
                <Text as="span" className="flex w-full items-center justify-start gap-3 px-3 py-2" data-lesson-text-only>
                  <Text as="span" color="muted">{lesson.position}</Text>
                  <Text as="span">{lesson.title}</Text>
                </Text>
              )
              : (
                <Button variant="ghost" href={lesson.href} className="h-auto w-full justify-start gap-3 py-2 text-start">
                  <Text as="span" color="muted">{lesson.position}</Text>
                  <Text as="span">{lesson.title}</Text>
                  {lesson.done ? <Text as="span" variant="label" color="success">{doneLabel}</Text> : null}
                </Button>
              )}
          </Text>
        ))}
      </Text>
    </Text>
  );
}
