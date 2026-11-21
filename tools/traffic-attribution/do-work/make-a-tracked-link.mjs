// tools/traffic-attribution/do-work/make-a-tracked-link.mjs
//
// The Workshop tool "Make a tracked link for a post, ad or bio". argv[2] is one JSON input:
//   { destination, project, source, campaign, medium?, content?, go_base? }
// Prints one JSON line: the link with its project and UTM fields set, and those fields one by one. With go_base (the
// client site's address) it also answers the touch row for journey_touches and the short /go/ link that sends a visitor
// through it (do-work/journey.mjs). The tool keeps no row: the caller writes `touch` into journey_touches itself.
import { buildTrackedLink } from '../read-data/tracked-link.mjs';
import { makeTouch } from './journey.mjs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export function makeATrackedLink(input) {
  const link = buildTrackedLink({ destination: input?.destination, projectId: input?.project, source: input?.source, campaign: input?.campaign, medium: input?.medium, content: input?.content });
  const fields = Object.fromEntries(new URL(link).searchParams);
  if (!input?.go_base) return { link, fields };
  const { row, short_link } = makeTouch({ destination: input.destination.trim(), source: fields, post_id: fields.utm_content ?? null, base: input.go_base });
  return { link, fields, touch: row, short_link };
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  try { process.stdout.write(`${JSON.stringify(makeATrackedLink(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
