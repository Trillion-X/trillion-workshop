// tools/published-destinations/do-work/check-a-destination-is-honest.mjs
//
// `tool:check-a-destination-is-honest` in the tool container:
//
//   node do-work/check-a-destination-is-honest.mjs < <the input as JSON>
//
// and prints { honest, problems } as JSON on its last line. A problem is reported, not thrown, because finding them
// is this tool's job.
import { text } from 'node:stream/consumers';
import { honestStateProblems } from '../read-data/check-honest-state.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
const problems = honestStateProblems(input.descriptor, { refuseKeys: Array.isArray(input.refuse_keys) ? input.refuse_keys : [] });
console.log(JSON.stringify({ honest: problems.length === 0, problems }));
