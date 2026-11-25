// tools/gather-words-from-people/routes/check-a-words-ask.ts
//
// PURPOSE
//   The words page's /target/words route as one tool, ported from the old program's wordsPage: a person who was asked for words
//   comes back with the token of their ask. Without `words` the tool only checks the token and answers whether the page is a form
//   for it (state `form`) or knows nobody by it (`not_found`); with `words` and `consent` it keeps what the person said with the
//   consent they chose (keepTheWordsAPersonGave) and answers `thanks`, or the page's own words for why not. The asks are rows of
//   `words_asks` in one database (`asks_database`); the words, the page's words and the list are rows of the words table (`words_table`)
//   and `words_gathering` in another (`database`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A token that is not shaped as one is refused before any database is touched, and a token no ask holds is answered as not found
//      without saying which of the two it was.
//   2. The table name is checked as a plain identifier before it is put in a statement; every value is a parameter.
//   3. Sending the same words with the same consent again changes nothing; a withdrawn row takes no more words (409).
//   4. The write is one statement that names the row as it was read: a row that moved since is refused (409), never overwritten.
//   5. Nothing but the page's own words is answered as a refusal; no database text reaches the person.
//   6. Reading asks and writing words are two logins of two databases: the asks login only ever reads.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runSql, sayWithout } from '../../run-sql-in-my-database/do-work/run-sql.mjs';
import { sharedConnection } from '../../ask-questions-sort-answers-follow-up/steps/serve-steps.ts';
import type { Execute } from '../../ask-questions-sort-answers-follow-up/steps/store.ts';
import { keepTheWordsAPersonGave } from '../do-work/gather-words.mjs';
import { consentOf, readGathers } from '../read-data/gathered-words.mjs';

export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,64}$/;
const WORDS_MOST = 1500;

export type Given = { database: string; asks_database: string; token: string; words?: unknown; consent?: unknown; site: string; words_table: string };
export type Answer = { status: number; state?: 'form' | 'thanks' | 'not_found'; error?: string };

// A row as the tools read it: every list field, the table's columns and words_state together; and split back again.
const valueOf = (row: any) => ({ ...row.words_state, text: row.text, author: row.author, consent_basis: row.consent_basis });
function columnsOf(value: Record<string, unknown>) {
  const { text, author, consent_basis, ...rest } = value;
  return { text: text ?? null, author: author ?? null, consent_basis: consent_basis ?? null, words_state: rest };
}

export async function checkAWordsAsk(input: Given, { content, asks }: { content: Execute; asks: Execute }): Promise<Answer> {
  if (typeof input.site !== 'string' || input.site === '') throw new Error('Give site: the words_gathering row\'s site.');
  const site = input.site;
  if (typeof input.words_table !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(input.words_table)) throw new Error('Give words_table: a plain lower-case table name.');
  const table = input.words_table;
  const [words] = await content('SELECT ask_days, page_url, "case", came_from, list, page FROM words_gathering WHERE site = $1', [site]) as any[];
  if (!words) throw new Error('No words_gathering row for this site.');
  const page = words.page;
  const gathers = readGathers(words.list);
  const notFound: Answer = { status: 404, state: 'not_found', error: page.not_found.body };
  const token = typeof input.token === 'string' ? input.token : '';
  if (!TOKEN_SHAPE.test(token)) return notFound;
  const [asked] = await asks('SELECT row_id FROM words_asks WHERE token = $1', [token]) as any[];
  if (!asked) return notFound;
  if (input.words === undefined && input.consent === undefined) return { status: 200, state: 'form' };
  const said = typeof input.words === 'string' ? input.words.replace(/\r\n/g, '\n').trim() : '';
  const consent = consentOf(gathers, input.consent);
  if (!said || !consent) return { status: 400, error: page.invalid };
  if (said.length > WORDS_MOST) return { status: 400, error: page.too_long };
  const [found] = await content(`SELECT id, text, author, consent_basis, words_state FROM ${table} WHERE id = $1`, [asked.row_id]) as any[];
  if (!found) return notFound;
  const row = { id: found.id, value: valueOf(found) };
  let answer;
  try {
    // The note is the same for the same choice, so sending the same words and consent again changes nothing (the Workshop's rule).
    answer = keepTheWordsAPersonGave({ list: words.list, rows: [row], row_id: row.id, words: said, consent: consent.id, consent_note: `Chosen on the words page: "${consent.label}"` });
  } catch {
    return { status: 409, error: page.closed.body };
  }
  if (answer.keep.length > 0) {
    const { id, value, expected } = answer.keep[0];
    const next = columnsOf(value);
    const changed = expected === null
      ? await content(`INSERT INTO ${table} (id, author, text, consent_basis, words_state, came_from, created, changed_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, now()) ON CONFLICT (id) DO NOTHING RETURNING id`, [id, next.author, next.text, next.consent_basis, JSON.stringify(next.words_state), null, new Date().toISOString()])
      : await content(`UPDATE ${table} SET author = $2, text = $3, consent_basis = $4, words_state = $5, changed_at = now()
          WHERE id = $1 AND author IS NOT DISTINCT FROM $6 AND text IS NOT DISTINCT FROM $7 AND consent_basis IS NOT DISTINCT FROM $8 AND words_state = $9::jsonb RETURNING id`,
        [id, next.author, next.text, next.consent_basis, JSON.stringify(next.words_state), ...(({ author, text, consent_basis, words_state }) => [author, text, consent_basis, JSON.stringify(words_state)])(columnsOf(expected.value))]);
    if (changed.length !== 1) return { status: 409, error: page.changed.body };
  }
  return { status: 200, state: 'thanks' };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const held: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as Given;
    const contentConnection = readFileSync(3, 'utf8').trim();
    const asksConnection = readFileSync(4, 'utf8').trim();
    held.push(contentConnection, asksConnection);
    const executeOn = (connection: string): Execute => {
      const shared = sharedConnection(connection);
      closers.push(shared.close);
      return async (sql, params = []) => (await runSql({ connection, input: { sql, params }, connect: shared.connect as never })).rows;
    };
    console.log(JSON.stringify(await checkAWordsAsk(input, { content: executeOn(contentConnection), asks: executeOn(asksConnection) })));
  } catch (error) {
    console.error(sayWithout(error, ...held));
    process.exitCode = 1;
  } finally {
    for (const close of closers) await close();
  }
}
