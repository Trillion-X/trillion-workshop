// tools/lessons-and-learning-paths/show/CourseLinks.tsx
//
// PURPOSE
//   A compact list of courses: each a link carrying its title and how many lessons it has, under a heading. A course page puts it
//   under its lessons as "the other courses"; `current` leaves that course out. It reads the answer of tool:read-the-courses
//   (do-work/courses.ts readCourses), the same props as CourseList.tsx.
//
// NON-NEGOTIABLE INVARIANTS
//   1. View is pure: no fetch and no window while it renders. Every word is a prop or the answer's own.
//   2. A course's address is base_path and its slug; the count is the answer's own lesson_count, left out when the answer has none.
//   3. Nothing is drawn when no course is left after leaving out `current`.
//   4. Everything drawn is a shared part (Text, Button, Card); no raw HTML and no inline styling.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button } from '../../ui/show/button/Button.tsx';
import { Text } from '../../ui/show/text/Text.tsx';
import type { CatalogueAnswer } from '../do-work/courses.ts';

export type CourseLinksProps = CatalogueAnswer & {
  heading?: string;
  base_path?: string;
  /** The slug of the course the page is about; it is left out. */
  current?: string;
  /** The word after the count of lessons, singular and plural. */
  lessonWords?: { one: string; many: string };
};

const WORDS = { one: 'lesson', many: 'lessons' } as const;

export function View({ courses, heading, base_path = '/courses', current, lessonWords = WORDS }: CourseLinksProps) {
  const base = base_path.replace(/\/+$/, '');
  const others = courses.filter(course => course.slug !== current);
  if (others.length === 0) return null;
  return (
    <Text as="section" className="grid gap-4" data-course-links>
      {heading ? <Text as="h2" variant="heading-lg">{heading}</Text> : null}
      <Text as="ul" className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {others.map(course => (
          <Text as="li" key={course.slug} data-course={course.slug}>
            <Button variant="ghost" href={`${base}/${encodeURIComponent(course.slug)}`} className="grid h-auto w-full gap-1 text-start">
              <Text as="span">{course.title}</Text>
              {course.lesson_count === undefined ? null : <Text as="span" variant="label" color="muted">{`${course.lesson_count} ${course.lesson_count === 1 ? lessonWords.one : lessonWords.many}`}</Text>}
            </Button>
          </Text>
        ))}
      </Text>
    </Text>
  );
}
