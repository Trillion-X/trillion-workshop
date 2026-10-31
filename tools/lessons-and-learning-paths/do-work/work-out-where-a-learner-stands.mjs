// tools/lessons-and-learning-paths/do-work/work-out-where-a-learner-stands.mjs
//
// Where a learner stands on each track: percent finished, the step to do next, the latest evaluation, recent evidence
// and the path of steps. Run by the Workshop tool `tool:work-out-where-a-learner-stands` in the tool container:
//
//   node do-work/work-out-where-a-learner-stands.mjs < <the input as JSON>
//
// and prints { views } as JSON on its last line. It keeps nothing and reads no storage: the caller hands over the
// records it read.
import { text } from 'node:stream/consumers';
import { learningProgressViews } from './learning-progress.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
console.log(JSON.stringify({ views: learningProgressViews(input, input.learner_id) }));
