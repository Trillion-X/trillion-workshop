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
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runSql, sayWithout } from '../../run-sql-in-my-database/do-work/run-sql.mjs';
import { sharedConnection } from '../../ask-questions-sort-answers-follow-up/steps/serve-steps.ts';
import { goRedirect } from '../do-work/journey.mjs';

export type Given = { database: string; code: string; cookie_header?: string; referer?: string; consent_cookie_name: string };
export type Followed = { status: number; location: string | null; set_cookie: string | null; retry_after?: number };
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;

export async function followAShortLink(input: Given, query: Query): Promise<Followed> {
  if (typeof input.code !== 'string' || input.code === '') throw new Error('Give code: the tracked link\'s id.');
  if (typeof input.consent_cookie_name !== 'string' || input.consent_cookie_name === '') throw new Error('Give consent_cookie_name: the name of the site\'s consent cookie.');
  const went = await goRedirect(query, input.code, { cookieHeader: input.cookie_header ?? '', refererHeader: input.referer, consentCookieName: input.consent_cookie_name }) as { status: number; location: string | null; setCookie: string | null; retryAfter?: number };
  return { status: went.status, location: went.location, set_cookie: went.setCookie, ...(went.retryAfter === undefined ? {} : { retry_after: went.retryAfter }) };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let connection = '';
  let close = async () => {};
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as Given;
    connection = readFileSync(3, 'utf8').trim();
    const shared = sharedConnection(connection);
    close = shared.close;
    const query: Query = async (sql, params = []) => {
      const answer = await runSql({ connection, input: { sql, params }, connect: shared.connect as never }) as { rows: Record<string, unknown>[]; row_count: number };
      return { rows: answer.rows, rowCount: answer.row_count };
    };
    console.log(JSON.stringify(await followAShortLink(input, query)));
  } catch (error) {
    console.error(sayWithout(error, connection));
    process.exitCode = 1;
  } finally {
    await close();
  }
}
