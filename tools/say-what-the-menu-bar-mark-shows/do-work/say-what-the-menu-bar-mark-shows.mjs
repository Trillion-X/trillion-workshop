// tools/say-what-the-menu-bar-mark-shows/do-work/say-what-the-menu-bar-mark-shows.mjs
//
// tool:say-what-the-menu-bar-mark-shows, run as a function in the tool container:
//
//   node do-work/say-what-the-menu-bar-mark-shows.mjs < <the input as JSON>
//
// and prints { result } on its last line (or { error } with exit 1). It is what the Mac menu bar item's mark says: how
// many things are running, the newest running one with how far it has got, the unread count, and, when nothing is
// running, the next calendar line. The caller reads the person's running records and unread count and hands them over.
//
// Port of old trillion parts' alone-page glance (src/workspace/alone-page.tsx, the `glance` message built from the page's
// notification stream, commit cdb3894b25): the newest running record is "now", its progress rounded to two places when it
// has a numeric value, the list is the first eight running titles, and the "next" line stands in when nothing runs.
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const round2 = value => Math.round(value * 100) / 100;

export function sayWhatTheMenuBarMarkShows(input) {
  if (!object(input)) throw new Error('Send one JSON object: { records, unread_count, next? }.');
  if (!Array.isArray(input.records) || !input.records.every(record => object(record) && typeof record.title === 'string'
    && typeof record.kind === 'string' && typeof record.running === 'boolean' && Number.isFinite(record.updatedAt))) {
    throw new Error('records is a list of { title, kind, running, updatedAt (a number), progress? }.');
  }
  if (!Number.isInteger(input.unread_count) || input.unread_count < 0) throw new Error('unread_count is a whole number, 0 or more.');
  if (input.next !== undefined && input.next !== null && typeof input.next !== 'string') throw new Error('next, when supplied, is the next calendar line or null.');
  const running = input.records.filter(record => record.running).sort((a, b) => b.updatedAt - a.updatedAt);
  const top = running[0];
  const fraction = top?.progress && typeof top.progress.value === 'number' ? round2(top.progress.value) : null;
  const now = top ? { title: top.title, kind: top.kind, fraction } : input.next ? { title: input.next, kind: 'next', fraction: null } : null;
  return { kind: 'glance', count: input.unread_count, working: running.length > 0, running: running.length, now,
    list: running.slice(0, 8).map(record => record.title) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { readFileSync } = await import('node:fs');
  try {
    process.stdout.write(JSON.stringify({ result: sayWhatTheMenuBarMarkShows(JSON.parse(readFileSync(0, 'utf8') || '{}')) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
