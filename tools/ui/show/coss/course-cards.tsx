// parts/ui/show/coss/course-cards.tsx
//
// PURPOSE
//   Cards in a grid that wraps to the pane's width, drawn from a guide section's `courses` DATA: each a thing with parts
//   to finish (a course, a set of lessons). A tinted band on top holds its icon (an open book when it names none); under
//   it the title, a line cut to two lines, a thin bar for how far along with its words (`progress_label`, else
//   "<done> of <of>"), and a status badge. When the card carries an action, the whole card is that action. Modelled on
//   Skool's classroom cards (cover on top, title, two-line description, progress bar with its words), with Descript's
//   "Learn Descript" grid (Mobbin screen 9859433a: cover, title, quiet line, one small pill) for the pill and spacing.
//   Checked against 21st.dev's "Project Item Card" (sean0205 c-item-10, id 28524): a label and status badge, title
//   over a two-line description, a progress bar with its words in the footer. Dropped from them: cover photographs the
//   caller does not have, the avatar group, and the separate Open button (the card is the press).
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no product words: title, line, status and progress words are the caller's DATA. The only word it
//      adds is "of" between `done` and `of` when the caller sends counts without their own words.
//   2. A bar is drawn only when the caller sends `of` greater than zero; `done` is clamped to 0..of.
//   3. Controls are the licensed Coss sources (Badge, Button through press-action.tsx) and NamedIcon; appearance lives
//      in screen-look/show/guide.css (`.course-*`).

import { Badge } from './ui/badge';
import { NamedIcon } from '../icon/NamedIcon';
import { PressAction } from './press-action';
import type { GuideActionHandler, GuideCourse } from './guide';

const BADGE_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'info' | 'outline'> = { good: 'success', attention: 'warning', bad: 'error', info: 'info', quiet: 'outline' };

function CourseBody({ course }: { course: GuideCourse }) {
  const of = typeof course.of === 'number' && course.of > 0 ? course.of : 0;
  const done = of ? Math.min(of, Math.max(0, course.done ?? 0)) : 0;
  const words = course.progress_label ?? (of ? `${done} of ${of}` : undefined);
  return (
    <>
      <span className="course-cover" aria-hidden>
        <NamedIcon name={course.icon ?? 'BookOpen'} className="course-cover-icon" />
      </span>
      <span className="course-text">
        <span className="course-title">{course.title}</span>
        {course.about ? <span className="course-about">{course.about}</span> : null}
      </span>
      {of || course.status || words ? (
        <span className="course-foot">
          {of ? (
            <span className="course-bar" role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={done} aria-label={words ?? course.title}>
              <span className="course-bar-fill" style={{ width: `${(done / of) * 100}%` }} />
            </span>
          ) : null}
          <span className="course-foot-line">
            {words ? <span className="course-progress-words">{words}</span> : null}
            {course.status ? <Badge variant={BADGE_VARIANT[course.status.tone ?? 'quiet'] ?? 'outline'} className="guide-status course-status" data-tone={course.status.tone ?? 'quiet'}><span className="guide-status-dot" aria-hidden />{course.status.label}</Badge> : null}
          </span>
        </span>
      ) : null}
    </>
  );
}

export function CourseCards({ courses, onAction }: { courses: GuideCourse[]; onAction: GuideActionHandler }) {
  return (
    <ul className="course-cards">
      {courses.map(course => (
        <li key={course.id} className="course-card-slot">
          {course.action
            ? <PressAction action={course.action} onAction={onAction} className="course-card"><CourseBody course={course} /></PressAction>
            : <div className="course-card"><CourseBody course={course} /></div>}
        </li>
      ))}
    </ul>
  );
}
