import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/lessons-and-learning-paths/do-work/show-the-courses-a-learner-is-on.mjs
//
// tool:show-the-courses-a-learner-is-on, run as a function in the tool container:
//
//   node do-work/show-the-courses-a-learner-is-on.mjs < <the input as JSON>
//
// and prints { result } on its last line (or { error } with exit 1). It is the learning page's own read: the function
// lives in ../read-data/courses-of-a-learner.mjs, shared with the course list screen. The caller reads the courses and
// the lessons this learner has finished and hands them over.
//
// Port of old trillion src/community-activity.mjs `coursesFor(community, relay)` (commit HEAD at the time of this port),
// with its path from src/community-logic/project-progress-to-path.ts: a done lesson is complete, the first lesson not done
// is active, the rest are locked. A lesson's interactive module is not carried: it was shared only inside one relay.
import { readFileSync } from 'node:fs';
import { showTheCoursesALearnerIsOn } from '../read-data/courses-of-a-learner.mjs';

export { showTheCoursesALearnerIsOn };

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    process.stdout.write(JSON.stringify({ result: { courses: showTheCoursesALearnerIsOn(JSON.parse(readFileSync(0, 'utf8') || '{}')) } }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
