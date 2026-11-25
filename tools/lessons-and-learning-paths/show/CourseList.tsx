// tools/lessons-and-learning-paths/show/CourseList.tsx
//
// PURPOSE
//   The screen of tool:read-the-courses: every course a pursuit offers as one card each (its picture, category, title and short
//   description), in the order the answer gives, each card a link to its course page. A page and an AI app draw the same
//   screen from the same answer, and every prop is a plain JSON value, so a page row can place it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. View is pure: no fetch and no window while it renders. Its props are the answer of the read (do-work/courses.ts
//      readCourses) and a few words and addresses the page row gives: `heading`, `base_path` (where a course page is, the
//      slug is added) and `image_template` (an address with {image} where the course's picture id goes).
//   2. A course with no picture draws no picture; no courses draws the heading alone.
//   3. A card's address is base_path plus the slug, encoded; the screen makes no other address.
//   4. Everything drawn is a shared part (Text, Button, MediaFrame); no raw HTML and no inline styling.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button } from '../../ui/show/button/Button.tsx';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame.tsx';
import { Text } from '../../ui/show/text/Text.tsx';
import type { CatalogueAnswer } from '../do-work/courses.ts';

export type CourseListProps = CatalogueAnswer & {
  heading?: string;
  base_path?: string;
  image_template?: string;
};

export function View({ courses, heading, base_path = '/courses', image_template = '{image}' }: CourseListProps) {
  const base = base_path.replace(/\/+$/, '');
  return (
    <Text as="section" className="grid gap-6" data-course-list>
      {heading ? <Text as="h1" variant="title">{heading}</Text> : null}
      <Text as="ul" className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {courses.map(course => (
          <Text as="li" key={course.slug} data-course={course.slug}>
            <Button variant="ghost" href={`${base}/${encodeURIComponent(course.slug)}`} className="grid h-auto w-full gap-3 p-0 text-start">
              {course.image === '' ? null : <MediaFrame url={image_template.replace('{image}', course.image)} mediaType="image/jpeg" label={course.title} />}
              {course.category === '' ? null : <Text as="span" variant="label" color="muted">{course.category}</Text>}
              <Text as="span" variant="heading-lg">{course.title}</Text>
              {course.short_description === '' ? null : <Text as="span" color="muted">{course.short_description}</Text>}
            </Button>
          </Text>
        ))}
      </Text>
    </Text>
  );
}
