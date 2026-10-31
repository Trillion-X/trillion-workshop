// tools/published-destinations/do-work/find-a-destination.mjs
//
// `tool:find-a-destination` in the tool container:
//
//   node do-work/find-a-destination.mjs < <the input as JSON>
//
// and prints { found, descriptor, finished_refs } as JSON on its last line. Nothing is kept between runs.
import { text } from 'node:stream/consumers';
import { findDestinationDescriptor, finishedCelebratingRefs } from '../read-data/read-destination.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
const descriptor = findDestinationDescriptor(input.rows, input.ref, input.subject_ref);
console.log(JSON.stringify({
  found: descriptor !== null,
  descriptor,
  finished_refs: descriptor ? finishedCelebratingRefs(descriptor) : [],
}));
