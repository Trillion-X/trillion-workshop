// tools/traffic-attribution/routes/follow-a-short-link.ts
//
// PURPOSE
//   The /go/<code> route of a site as one tool: finds the tracked link (journey_touches), keeps the click step and answers where to
//   send the visitor: the link's destination with its source fields and the touch id. The work is goRedirect (journey.mjs); this
//   file hands it the pursuit's database and the headers the visitor came with, and answers plain JSON for the site row to turn into a
//   redirect: { status, location, set_cookie, retry_after }.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An unknown code answers status 404 and no location; an unreadable link answers 503 with retry_after; neither keeps a step.
//   2. The click is one INSERT of the journey steps and is best effort: a click that cannot be kept never holds the visitor back.
//   3. Without the visitor's consent no visitor is kept and no cookie is answered (goRedirect, read-data/consent.json).
//   4. Nothing here reads or names a destination: it is the link row's.
//   5. The visitor's two cookies come in by name, `visitor_cookie` (the visitor's id) and `consent` (the value of the site's consent
//      cookie), never as the whole Cookie header: tool input is kept in the run journal, and the header also carries the sign-in
//      session. A value that could not be a cookie's own (it holds `;`, a space or a comma) counts as absent.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sayWithout, withSqlWrite } from '../../run-sql-in-my-database/do-work/run-sql.mjs';
import { goRedirect } from '../do-work/journey.mjs';
import settings from '../read-data/journey.json' with { type: 'json' };

export type Given = { database: string; code: string; visitor_cookie?: string; consent?: string; referer?: string; consent_cookie_name: string };
export type Followed = { status: number; location: string | null; set_cookie: string | null; retry_after?: number };
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;

const cookieValue = (value: unknown) => (typeof value === 'string' && /^[^;\s,]+$/.test(value) ? value : null);
// The two cookies the visitor sent, as the one header goRedirect reads: only the visitor id and the consent value, each by its name.
function cookieHeaderOf(input: Given) {
  const visitor = cookieValue(input.visitor_cookie);
  const consent = cookieValue(input.consent);
  return [visitor && `${settings.cookie.name}=${visitor}`, consent && `${input.consent_cookie_name}=${consent}`].filter(Boolean).join('; ');
}

export async function followAShortLink(input: Given, query: Query): Promise<Followed> {
  if (typeof input.code !== 'string' || input.code === '') throw new Error('Give code: the tracked link\'s id.');
  if (typeof input.consent_cookie_name !== 'string' || input.consent_cookie_name === '') throw new Error('Give consent_cookie_name: the name of the site\'s consent cookie.');
  const went = await goRedirect(query, input.code, { cookieHeader: cookieHeaderOf(input), refererHeader: input.referer, consentCookieName: input.consent_cookie_name }) as { status: number; location: string | null; setCookie: string | null; retryAfter?: number };
  return { status: went.status, location: went.location, set_cookie: went.setCookie, ...(went.retryAfter === undefined ? {} : { retry_after: went.retryAfter }) };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let connection = '';
  let input: Given | null = null;
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as Given;
    connection = readFileSync(3, 'utf8').trim();
    // One connection for the whole run (run-sql.mjs withSqlWrite), closed at the end.
    const followed = await withSqlWrite({ connection }, async (run: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; row_count?: number }>) => {
      const query: Query = async (sql, params = []) => {
        const answer = await run(sql, params);
        return { rows: answer.rows, rowCount: answer.row_count };
      };
      return followAShortLink(input, query);
    });
    console.log(JSON.stringify(followed));
  } catch (error) {
    console.error(sayWithout(error, connection));
    // A database that cannot be opened is an unreadable link (503 with when to retry), as when a statement fails; never a bare failure.
    if (input && connection) console.log(JSON.stringify(await followAShortLink(input, async () => { throw error; })));
    else process.exitCode = 1;
  }
}
