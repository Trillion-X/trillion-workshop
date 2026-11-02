// tools/judge-words/do-work/make-a-plain-work-title.mjs
//
// Run by the Workshop tool `tool:make-a-plain-work-title` in the tool container:
//
//   node do-work/make-a-plain-work-title.mjs < {"job": "...", "said"?: "...", "fallback"?: "..."}
//
// and prints { result: { title, from } } as JSON on its last line; `from` is "said" when the caller's own title was
// kept, "job" when one was derived, "fallback" when the job held no sentence a person reads. A request that is not
// JSON, or has no job text, is refused with { error } and why.
import { text } from 'node:stream/consumers';
import { FALLBACK, titleOf } from './plain-work-title.mjs';

try {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  if (typeof input?.job !== 'string') throw new Error('give the job as text in "job"');
  for (const key of ['said', 'fallback']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`"${key}" must be text when given`);
  }
  const fallback = input.fallback?.trim() ? input.fallback : FALLBACK;
  const title = titleOf(input.said, input.job, fallback);
  const from = input.said?.trim() ? 'said' : title === fallback ? 'fallback' : 'job';
  console.log(JSON.stringify({ result: { title, from } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
