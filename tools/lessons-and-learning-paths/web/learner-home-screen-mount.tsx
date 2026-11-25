// tools/lessons-and-learning-paths/web/learner-home-screen-mount.tsx
//
// PURPOSE
//   The learner's home as a screen module (its single export, `mount(element, props)`, is the contract of the module kind,
//   web/src/workspace/tool-screen.tsx): the first thing a learner sees, never a blank panel. One column: a greeting and a
//   title; the lesson to resume as a hero (its video still, the course, the lesson, its place and the course's progress,
//   one Resume press); the next lessons of that course as rows; each course with its own progress; and the courses not
//   open yet, muted, with one press to the plans. A learner who has finished nothing sees the same hero on the first
//   lesson, saying Start, with no progress. It reads the course, lesson and done rows through the records door, as the
//   course list does, and works the home out with read-data/learner-home.mjs.
//
//   Design: the anatomy of real learning homes (Mobbin: Uxcel mobbin.com/screens/de53d532-f4ae-4d3a-a132-c601b845704b,
//   Coursera mobbin.com/screens/18683325-d982-4756-b06e-4ed52c933b06, Codecademy mobbin.com/screens/6b452ce5-0b98-42e6-84df-7a5f45b42beb,
//   Headspace mobbin.com/screens/d193a25d-a91c-41e4-8fa5-e835461d1e1d, Optimal Workshop
//   mobbin.com/screens/dbd9988f-0843-43f2-8f21-984039e19e7a); the rows are the shared media-item part (21st.dev 29173), the
//   loading shapes the shared Skeleton (21st.dev 1588, shadcn), the failure the shared EmptyState.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Courses, lessons and done rows are the learner's own rows, read through the records door; nothing here holds course
//      text. Done, next and the counts come from showTheCoursesALearnerIsOn only.
//   2. A lesson opens the screen the row's DATA names: `open_lesson`, the id of the catalog entry that shows a lesson, with
//      {course_id} and {lesson_id} filled (the entry the sidebar opens), or, without one, the lesson screen
//      (course-lesson-screen-mount) on that lesson. `open_plans` is the catalog entry the closed courses point to.
//   3. The still and the length are the lesson row's fields the input names (`video_field`, `length_field`). The greeting's
//      name and the closed courses are host values the row names (`first_name`, `closed_courses`); without them they are
//      not drawn.
//   4. Every word is read-data/learner-home-words.json, each replaceable by the row's `words`. Nothing here writes a row.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Button, Container, ErrorBoundary, FloatingMaterialFrame, NamedIcon, ProgressBar, Text, mountReactSurface } from '../../ui';
import { EmptyState } from '../../ui/show/empty-state';
import { Skeleton } from '../../ui/show/shadcn/skeleton';
import { MediaItem, MediaStill } from '../../ui/show/media-item';
import { emitPlaceableSurfaceIntent } from '../../ui/show/placeable-surface-intent/placeable-surface-intent';
import { listRecords, type StoredRecord } from '#workspace/records-door';
import { showTheCoursesALearnerIsOn } from '../read-data/courses-of-a-learner.mjs';
import { LESSON_DONE_TYPE, finishedLessonsOf } from '../read-data/lesson-done.mjs';
import { fillWords, learnerHomeOf } from '../read-data/learner-home.mjs';
import WORDS from '../read-data/learner-home-words.json';

type Words = typeof WORDS;
type HomeInput = {
  video_field?: string;
  length_field?: string;
  open_lesson?: string;
  open_plans?: string;
  words?: Partial<Words>;
  first_name?: string;
  closed_courses?: unknown;
  floating_frame?: unknown;
};
type Home = ReturnType<typeof learnerHomeOf>;
type HomeLesson = NonNullable<Home['resume']>;
type CourseRow = { title?: unknown; about?: unknown; lesson_ids?: unknown };

const COURSE_ROW_TYPE = 'record:course';
const LESSON_ROW_TYPE = 'record:lesson';
const LESSON_SCREEN_ENTRY = 'course-lesson-screen-mount';
const PROGRESS_COLOUR = 'var(--button-primary-bg)';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The course rows, each with its lessons in order (a lesson the door does not hold is left out), as the course list reads them. */
function coursesOf(courses: StoredRecord[], lessons: Map<string, Record<string, unknown>>) {
  return courses.map(course => {
    const row = course.value as CourseRow;
    const ids = Array.isArray(row.lesson_ids) ? row.lesson_ids.filter((id): id is string => typeof id === 'string' && lessons.has(id)) : [];
    return { id: course.id, title: text(row.title) ?? course.id, about: text(row.about), lessons: ids.map(id => ({ id, title: text(lessons.get(id)?.title) ?? id })) };
  });
}

/** Opens a lesson where the row's DATA says: the catalog entry `open_lesson` names, or the lesson screen on it. */
function openLesson(lesson: Pick<HomeLesson, 'course_id' | 'lesson_id' | 'title'>, openEntry: string | undefined, videoField: string | undefined) {
  if (openEntry) {
    emitPlaceableSurfaceIntent({ id: fillWords(openEntry, lesson) });
    return;
  }
  emitPlaceableSurfaceIntent({
    title: lesson.title,
    packageEntry: { packageName: 'lessons-and-learning-paths', entryName: LESSON_SCREEN_ENTRY },
    surfaceInput: { lesson_id: lesson.lesson_id, course_id: lesson.course_id, ...(videoField ? { video_field: videoField } : {}) },
  });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Container as="section" layout="vertical" gap="md" width="full" aria-label={title}>
      <Text as="h2" variant="heading" color="strong">{title}</Text>
      {children}
    </Container>
  );
}

function Loading({ words }: { words: Words }) {
  return (
    <Container layout="vertical" width="full" className="gap-10" aria-busy="true" aria-label={words.loading}>
      <Container layout="vertical" gap="sm" width="full">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-72" />
      </Container>
      <Container layout="responsive-split" gap="xl" width="full">
        <Skeleton className="aspect-video w-full sm:w-1/2 rounded-[var(--radius-card,0.75rem)]" />
        <Container layout="vertical" gap="md" flex={1} justifyContent="center">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-7 w-3/4" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-10 w-32" />
        </Container>
      </Container>
      <Container layout="vertical" gap="sm" width="full">
        {[0, 1, 2].map(row => (
          <Container key={row} layout="horizontal" gap="md" alignItems="center" width="full">
            <Skeleton className="aspect-video w-20 sm:w-28" />
            <Container layout="vertical" gap="xs" flex={1}>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/4" />
            </Container>
          </Container>
        ))}
      </Container>
    </Container>
  );
}

function Hero({ home, words, open }: { home: Home; words: Words; open: (lesson: HomeLesson) => void }) {
  const lesson = home.resume!;
  const started = home.started;
  const named = fillWords(started ? words.resume_named : words.start_named, lesson);
  return (
    <Container layout="responsive-split" gap="xl" width="full" alignItems="center">
      <Button type="button" variant="plain" onClick={() => open(lesson)} aria-label={named} className="h-auto w-full p-0 sm:w-1/2 sm:shrink-0">
        <MediaStill src={lesson.still} length={lesson.length} size="hero" />
      </Button>
      <Container layout="vertical" gap="md" flex={1} width="full" className="min-w-0">
        <Text variant="label" color="secondary" weight="medium">
          {started ? lesson.course_title : words.kicker_new}
        </Text>
        <Text as="p" variant="heading-xl" color="strong" clamp={3} className="text-balance">{lesson.title}</Text>
        {started ? (
          <Container layout="vertical" gap="sm" width="full">
            <Container layout="horizontal" gap="sm" justifyContent="between" width="full">
              <Text variant="label" color="secondary">{fillWords(words.lesson_of, lesson)}</Text>
              <Text variant="label" color="secondary" tabular>{fillWords(words.percent_done, lesson)}</Text>
            </Container>
            <ProgressBar percentage={lesson.percent} color={PROGRESS_COLOUR} height="0.375rem" aria-label={fillWords(words.percent_done, lesson)} />
          </Container>
        ) : (
          <Text as="p" variant="body" color="secondary" className="text-pretty">{fillWords(words.start_why, { course: lesson.course_title })}</Text>
        )}
        <Container layout="horizontal" gap="sm">
          <Button type="button" variant="primary" size="lg" onClick={() => open(lesson)} aria-label={named}>
            <NamedIcon name="Play" size="md" aria-hidden="true" />
            {started ? words.resume : words.start}
          </Button>
        </Container>
      </Container>
    </Container>
  );
}

function LearnerHome({ input }: { input: HomeInput }) {
  const words = React.useMemo(() => ({ ...WORDS, ...(input.words ?? {}) }) as Words, [input.words]);
  const [home, setHome] = React.useState<Home | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const { video_field: videoField, length_field: lengthField, open_lesson: openEntry, open_plans: plansEntry, closed_courses: closed } = input;
  React.useEffect(() => {
    let gone = false;
    setFailed(false);
    void (async () => {
      try {
        const [courseRows, lessonRows, doneRows] = await Promise.all([
          listRecords({ type: COURSE_ROW_TYPE }),
          listRecords({ type: LESSON_ROW_TYPE }),
          listRecords({ type: LESSON_DONE_TYPE }),
        ]);
        const lessons = new Map(lessonRows.map(record => [record.id, (record.value ?? {}) as Record<string, unknown>]));
        const courses = showTheCoursesALearnerIsOn({ courses: coursesOf(courseRows, lessons), done: finishedLessonsOf(doneRows) });
        const shown = learnerHomeOf({
          courses,
          lessons: Object.fromEntries(lessons),
          done: doneRows.map(record => record.value),
          videoField: videoField ?? null,
          lengthField: lengthField ?? null,
          closed: Array.isArray(closed) ? closed : [],
        });
        if (!gone) setHome(shown);
      } catch {
        if (!gone) setFailed(true);
      }
    })();
    return () => { gone = true; };
  }, [attempt, closed, lengthField, videoField]);

  const open = React.useCallback((lesson: Pick<HomeLesson, 'course_id' | 'lesson_id' | 'title'>) => openLesson(lesson, openEntry, videoField), [openEntry, videoField]);
  const name = text(input.first_name);
  const started = Boolean(home?.started);

  let body: React.ReactNode;
  if (failed) {
    body = <EmptyState tone="error" icon={<NamedIcon name="CloudOff" size="lg" />} title={words.failed} description={words.failed_why} action={words.retry} onAction={() => setAttempt(count => count + 1)} />;
  } else if (!home) {
    body = <Loading words={words} />;
  } else if (!home.courses.length) {
    body = (
      <Container layout="vertical" width="full" className="gap-10">
        <EmptyState icon={<NamedIcon name="GraduationCap" size="lg" />} title={words.none} description={words.none_why} action={plansEntry ? words.closed_action : undefined} onAction={plansEntry ? () => emitPlaceableSurfaceIntent({ id: plansEntry }) : undefined} />
      </Container>
    );
  } else {
    body = (
      <Container layout="vertical" width="full" className="gap-10">
        <Container layout="vertical" gap="xs" width="full">
          {name ? <Text variant="body" color="secondary">{fillWords(started ? words.greeting : words.greeting_new, { name })}</Text> : null}
          <Text as="h1" variant="title" color="strong" className="text-balance">{started ? words.title : words.title_new}</Text>
        </Container>
        {home.resume ? <Hero home={home} words={words} open={open} /> : <Text variant="body" color="secondary">{words.all_done}</Text>}
        {home.up_next.length ? (
          <Section title={words.up_next}>
            <Container as="ul" layout="vertical" gap="xs" width="full" className="list-none">
              {home.up_next.map(lesson => (
                <Container as="li" key={`${lesson.course_id}/${lesson.lesson_id}`} layout="vertical" gap="none" width="full">
                  <MediaItem title={lesson.title} description={fillWords(words.lesson_of, lesson)} still={lesson.still} length={lesson.length} onPress={() => open(lesson)} />
                </Container>
              ))}
            </Container>
          </Section>
        ) : null}
        <Section title={words.my_courses}>
          <Container as="ul" layout="vertical" gap="xs" width="full" className="list-none">
            {home.courses.map(course => (
              <Container as="li" key={course.course_id} layout="vertical" gap="none" width="full">
                <Button
                  type="button"
                  variant="ghost"
                  size="option-row"
                  fullWidth
                  disabled={!course.opens}
                  aria-label={fillWords(words.open_course, course)}
                  onClick={() => { if (course.opens) open(course.opens); }}
                  className="items-center gap-4"
                >
                  <Container layout="vertical" gap="sm" flex={1} className="min-w-0">
                    <Text as="span" variant="body" weight="medium" color="strong" truncate>{course.title}</Text>
                    <Container layout="horizontal" gap="md" alignItems="center" width="full">
                      <ProgressBar percentage={course.percent} color={PROGRESS_COLOUR} height="0.25rem" className="flex-1" />
                      <Text as="span" variant="label" color="secondary" tabular wrap="nowrap">{fillWords(words.course_done, course)}</Text>
                    </Container>
                  </Container>
                  <NamedIcon name="ChevronRight" size="sm" aria-hidden="true" />
                </Button>
              </Container>
            ))}
          </Container>
          {home.closed.length ? (
            <Container layout="vertical" gap="sm" width="full" className="pt-4">
              <Text as="h3" variant="label" color="secondary" weight="medium">{words.closed_heading}</Text>
              <Container as="ul" layout="vertical" gap="xs" width="full" className="list-none">
                {home.closed.map(course => (
                  <Container as="li" key={course.title} layout="horizontal" gap="sm" alignItems="center" width="full" className="px-3 py-1.5">
                    <NamedIcon name="Lock" size="sm" color="faint" aria-hidden="true" />
                    <Text as="span" variant="body" color="faint" truncate>{course.title}</Text>
                  </Container>
                ))}
              </Container>
              {plansEntry ? (
                <Container layout="horizontal" gap="sm" className="px-3">
                  <Button type="button" variant="outline" size="sm" onClick={() => emitPlaceableSurfaceIntent({ id: plansEntry })}>{words.closed_action}</Button>
                </Container>
              ) : null}
            </Container>
          ) : null}
        </Section>
      </Container>
    );
  }

  return (
    <FloatingMaterialFrame frame={input.floating_frame}>
      <ErrorBoundary zoneName="learner home">
        {/* Flat in the pane: the column scrolls inside it with no frame of its own (no card inside the pane's card). */}
        <Container layout="vertical" gap="none" width="full" height="full" overflow="y-auto">
          <Container layout="vertical" gap="none" width="full" className="mx-auto max-w-[880px] px-4 py-8 sm:px-8 sm:py-10">
            {body}
          </Container>
        </Container>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mount(element: HTMLElement, props: HomeInput = {}) {
  return mountReactSurface(element, <LearnerHome input={props} />);
}
