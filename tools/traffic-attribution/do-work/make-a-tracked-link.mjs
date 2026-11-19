// tools/traffic-attribution/do-work/make-a-tracked-link.mjs
//
// The Workshop tool "Make a tracked link for a post, ad or bio". argv[2] is one JSON input:
//   { destination, project, source, campaign, medium?, content? }
// Prints one JSON line: the link with its project and UTM fields set, and those fields one by one.
import { buildTrackedLink } from '../read-data/tracked-link.mjs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export function makeATrackedLink(input) {
  const link = buildTrackedLink({ destination: input?.destination, projectId: input?.project, source: input?.source, campaign: input?.campaign, medium: input?.medium, content: input?.content });
  return { link, fields: Object.fromEntries(new URL(link).searchParams) };
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  try { process.stdout.write(`${JSON.stringify(makeATrackedLink(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
