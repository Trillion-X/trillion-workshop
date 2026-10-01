// tools/person-profile/do-work/lay-out-a-profile.mjs
//
// Lays out one person's (or any record's) profile from a description of what to show: its title and subtitle, each
// field with its value, related lists (their activity, their deals) and the actions that apply, each shown only when
// its visibleWhen rules hold. Run by the Workshop tool `tool:lay-out-a-profile` in the tool container:
//
//   node do-work/lay-out-a-profile.mjs < <the input as JSON>
//
// `layout` is the description (surfaceId, identity, fields, relationships, actions) and `sources` the records it reads
// by name (`record` is the one read when a field names none). Prints the laid-out profile on its last line.
import { text } from 'node:stream/consumers';
import { projectDescribedRecordSurface } from '../read-data/described-record-surface.ts';

const input = JSON.parse((await text(process.stdin)) || '{}');
if (!input.layout || typeof input.layout !== 'object') throw new Error('Send layout: what the profile shows (surfaceId, identity, fields, relationships, actions).');
console.log(JSON.stringify(projectDescribedRecordSurface({ descriptor: { kind: 'described-record-surface', ...input.layout }, sources: input.sources ?? {}, readerId: input.reader })));
