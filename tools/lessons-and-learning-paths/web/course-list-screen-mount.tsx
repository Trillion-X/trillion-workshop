// tools/lessons-and-learning-paths/web/course-list-screen-mount.tsx
//
// PURPOSE
//   The course list as a screen module: the one file the screen's row names (`screen.module.entry` of
//   tool:list-the-courses-a-learner-is-on), whose single export, `mount(element, props)`, is the contract of the module
//   kind (web/src/workspace/tool-screen.tsx). It reads the course rows, their lesson rows and the learner's done rows
//   through the records door, works out each course's lessons as complete, active or locked with the tool's own read
//   (read-data/courses-of-a-learner.mjs), and draws them with the shared components. Opening a lesson opens the lesson
//   screen (web/course-lesson-screen-mount.tsx) on that lesson.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Courses and lessons are the person's own rows, read through the records door; nothing here holds course text.
//      A course row names its lessons in order in `lesson_ids`; a lesson row a course names but the door does not hold
//      is left out.
//   2. The complete, active and locked states come from showTheCoursesALearnerIsOn only; nothing here re-derives them.
//   3. Nothing here writes a row. The lesson screen writes the done row when the person marks a lesson done.
//   4. The video field name the lesson screen reads is passed through from this screen's input (`video_field`), never
//      assumed here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Badge, Card, Container, ErrorBoundary, FloatingMaterialFrame, OpenSurfaceAction, ScrollableSurface, Text, mountReactSurface } from '../../ui';
import { listRecords, type StoredRecord } from '#workspace/records-door';
import { showTheCoursesALearnerIsOn } from '../read-data/courses-of-a-learner.mjs';
import { LESSON_DONE_TYPE, finishedLessonsOf } from '../read-data/lesson-done.mjs';

type CourseListInput = { video_field?: string; floating_frame?: unknown };
type LessonRow = { title?: unknown; body?: unknown };
type CourseRow = { title?: unknown; about?: unknown; lesson_ids?: unknown };
type CourseView = ReturnType<typeof showTheCoursesALearnerIsOn>[number];
type LessonView = CourseView['lessons'][number];

const COURSE_ROW_TYPE = 'record:course';
const LESSON_ROW_TYPE = 'record:lesson';
const LESSON_SCREEN_ENTRY = 'course-lesson-screen-mount';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The course rows, each with its lessons in order: a lesson the door does not hold is left out. */
function coursesOf(courses: StoredRecord[], lessons: StoredRecord[]) {
  const lessonById = new Map(lessons.map(record => [record.id, record.value as LessonRow]));
  return courses.map(course => {
    const row = course.value as CourseRow;
    const lessonIds = Array.isArray(row.lesson_ids) ? row.lesson_ids.filter((id): id is string => typeof id === 'string') : [];
    return {
      id: course.id,
      title: text(row.title) ?? course.id,
      about: text(row.about),
      lessons: lessonIds
        .filter(id => lessonById.has(id))
        .map(id => ({ id, title: text(lessonById.get(id)?.title) ?? id, body: text(lessonById.get(id)?.body) })),
    };
  });
}

function lessonPayload(course: CourseView, lesson: LessonView, videoField: string) {
  return {
    title: lesson.title,
    packageEntry: { packageName: 'lessons-and-learning-paths', entryName: LESSON_SCREEN_ENTRY },
    surfaceInput: { lesson_id: lesson.lesson_id, course_id: course.course_id, ...(videoField ? { video_field: videoField } : {}) },
  };
}

const STATUS_BADGE = { complete: { variant: 'success', label: 'Done' }, active: { variant: 'info', label: 'Next' }, locked: { variant: 'muted', label: 'Locked' } } as const;

function CourseList({ videoField, frame }: { videoField: string; frame: unknown }) {
  const [courses, setCourses] = React.useState<CourseView[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const [courseRows, lessonRows, doneRows] = await Promise.all([
          listRecords({ type: COURSE_ROW_TYPE }),
          listRecords({ type: LESSON_ROW_TYPE }),
          listRecords({ type: LESSON_DONE_TYPE }),
        ]);
        const shown = showTheCoursesALearnerIsOn({ courses: coursesOf(courseRows, lessonRows), done: finishedLessonsOf(doneRows) });
        if (!gone) setCourses(shown);
      } catch {
        if (!gone) setFailed(true);
      }
    })();
    return () => { gone = true; };
  }, []);
  return (
    <FloatingMaterialFrame frame={frame}>
      <ErrorBoundary zoneName="course list">
        <ScrollableSurface>
          <Container as="section" layout="vertical" gap="lg" width="full" className="mx-auto max-w-4xl" aria-label="Courses">
            <Text variant="heading-xl" color="strong">Courses</Text>
            {failed ? <Text variant="body" color="secondary">Your courses could not be read. Try again.</Text> : null}
            {courses?.length === 0 ? <Text variant="body" color="secondary">No courses yet.</Text> : null}
            {courses?.map(course => (
              <Card key={course.course_id} variant="surface" padding="lg">
                <Container layout="vertical" gap="md">
                  <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
                    <Container layout="vertical" gap="xs">
                      <Text variant="heading" color="strong">{course.title}</Text>
                      {course.about ? <Text variant="body" color="secondary">{course.about}</Text> : null}
                    </Container>
                    <Badge variant="info" size="sm">{course.done} of {course.of} done</Badge>
                  </Container>
                  <Container layout="vertical" gap="sm">
                    {course.lessons.map(lesson => (
                      <Container key={lesson.lesson_id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap data-lesson-status={lesson.status}>
                        <Text variant="body" color={lesson.status === 'locked' ? 'muted' : 'strong'}>{lesson.title}</Text>
                        <Container layout="horizontal" gap="sm" alignItems="center">
                          <Badge variant={STATUS_BADGE[lesson.status].variant} size="sm">{STATUS_BADGE[lesson.status].label}</Badge>
                          {lesson.status === 'locked' ? null : (
                            <OpenSurfaceAction
                              compact
                              size="xs"
                              variant="secondary"
                              label="Open"
                              ariaLabel={`Open ${lesson.title}`}
                              payload={lessonPayload(course, lesson, videoField)}
                            />
                          )}
                        </Container>
                      </Container>
                    ))}
                  </Container>
                </Container>
              </Card>
            ))}
          </Container>
        </ScrollableSurface>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mount(element: HTMLElement, props: CourseListInput = {}) {
  return mountReactSurface(element, <CourseList videoField={props.video_field ?? ''} frame={props.floating_frame} />);
}
