// The words page route on two real Postgres engines (PGlite): asks in one, words in the other. A token of the wrong shape or no ask
// is not found, a check changes nothing, words are kept with the consent chosen, the same words again change nothing, a row that
// moved is refused, and a withdrawn row takes no more words. Every name and line is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { checkAWordsAsk, type Given } from '../routes/check-a-words-ask.ts';

const field = (id: string) => ({ id, kind: 'text', label: id });
const WORDS_GATHERING = {
  ask_days: 14, page_url: 'https://app.example.test/target/words', case: 'asked-after-14-days', came_from: 'asked after 14 days',
  list: {
    label: 'Words from members', row_type: 'example-testimonial',
    fields: ['text', 'author', 'consent_basis', 'person', 'consent', 'status', 'case', 'win', 'asked_at', 'approved_identity'].map(field),
    gathers: {
      fields: { words: 'text', who: 'author', person: 'person', consent: 'consent', consent_note: 'consent_basis', status: 'status', case: 'case', win: 'win', asked_at: 'asked_at', approved_identity: 'approved_identity' },
      consents: [
        { id: 'full-name', label: 'Show my words with my full name', may_show: true, name_use: 'full' },
        { id: 'private', label: 'Keep my words private', may_show: false },
      ],
      anonymous_heading: 'A member', states: { asked: 'asked', received: 'received', approved: 'approved', declined: 'declined', withdrawn: 'withdrawn' },
      ask: { subject: 'How is it going, {name}?', body: 'Hi {name}, share: {words_link}' },
    },
  },
  page: {
    title: 'T', heading: 'H', body: 'B', words_label: 'W', words_hint: 'h', consent_legend: 'C', consent_note: 'n', button: 'Send',
    thanks: { heading: 'Thanks', body: 'Thanks.' }, not_found: { heading: 'Nope', body: 'This link is not valid.' }, closed: { heading: 'Closed', body: 'These words can no longer change here.' },
    changed: { heading: 'Changed', body: 'Your words changed while you wrote.' }, invalid: 'Please write a few words, and choose how I may show your name.', too_long: 'Please keep your words to 1,500 characters or fewer.',
  },
};
const TOKEN = 'a'.repeat(43);
const ROW = 'example-testimonial:asked-1';

async function fresh(state: Record<string, unknown> = { status: 'asked', person: 'ada@example.test', case: 'asked-after-14-days' }) {
  const content = new PGlite();
  await content.exec(`create table words_gathering (site text primary key, ask_days int, page_url text, "case" text, came_from text, list jsonb, page jsonb);
    create table example_words (id text primary key, author text, text text, consent_basis text, words_state jsonb not null default '{}', came_from text, created text, changed_at timestamptz);`);
  await content.query('insert into words_gathering values ($1, $2, $3, $4, $5, $6, $7)', ['example', 14, WORDS_GATHERING.page_url, WORDS_GATHERING.case, WORDS_GATHERING.came_from, JSON.stringify(WORDS_GATHERING.list), JSON.stringify(WORDS_GATHERING.page)]);
  await content.query('insert into example_words (id, words_state) values ($1, $2)', [ROW, JSON.stringify(state)]);
  const asks = new PGlite();
  await asks.exec('create table words_asks (email text primary key, token text not null unique, row_id text not null)');
  await asks.query('insert into words_asks values ($1, $2, $3)', ['ada@example.test', TOKEN, ROW]);
  const on = (db: PGlite) => async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[];
  return { content, asks, executors: { content: on(content), asks: on(asks) } };
}
const given = (extra: Partial<Given> = {}): Given => ({ database: 'c', asks_database: 'a', token: TOKEN, site: 'example', words_table: 'example_words', ...extra });
const kept = async (content: PGlite) => (await content.query('select author, text, consent_basis, words_state from example_words where id = $1', [ROW])).rows[0] as any;

test('a token of the wrong shape or one no ask holds is not found, and a check changes nothing', async () => {
  const { content, executors } = await fresh();
  for (const token of ["x' OR '1'='1", 'b'.repeat(43), '']) {
    const answer = await checkAWordsAsk(given({ token }), executors);
    assert.deepEqual([answer.status, answer.state, answer.error], [404, 'not_found', 'This link is not valid.']);
  }
  assert.deepEqual(await checkAWordsAsk(given(), executors), { status: 200, state: 'form' });
  assert.equal((await kept(content)).text, null);
});

test('words are kept with the consent chosen, as received; the same words again change nothing', async () => {
  const { content, executors } = await fresh();
  const sent = given({ words: ' The forehand is back.\r\nI hit it on the rise. ', consent: 'full-name' });
  assert.deepEqual(await checkAWordsAsk(sent, executors), { status: 200, state: 'thanks' });
  const row = await kept(content);
  assert.equal(row.text, 'The forehand is back.\nI hit it on the rise.');
  assert.deepEqual([row.words_state.status, row.words_state.consent], ['received', 'full-name']);
  assert.equal(row.consent_basis, 'Chosen on the words page: "Show my words with my full name"');
  const before = (await content.query('select changed_at from example_words')).rows[0];
  assert.deepEqual(await checkAWordsAsk(sent, executors), { status: 200, state: 'thanks' });
  assert.deepEqual((await content.query('select changed_at from example_words')).rows[0], before);
});

test('no words, no consent, an unknown consent or too many words are refused in the page\'s own words and keep nothing', async () => {
  const { content, executors } = await fresh();
  for (const extra of [{ words: '  ', consent: 'full-name' }, { words: 'ok', consent: 'sell-it' }, { words: 'ok' }]) {
    assert.deepEqual(await checkAWordsAsk(given(extra), executors), { status: 400, error: WORDS_GATHERING.page.invalid });
  }
  assert.deepEqual(await checkAWordsAsk(given({ words: 'x'.repeat(1501), consent: 'private' }), executors), { status: 400, error: WORDS_GATHERING.page.too_long });
  assert.equal((await kept(content)).text, null);
});

test('a withdrawn row takes no more words, and a row that moved since it was read is refused, never overwritten', async () => {
  const withdrawn = await fresh({ status: 'withdrawn', person: 'ada@example.test' });
  assert.deepEqual(await checkAWordsAsk(given({ words: 'ok', consent: 'private' }), withdrawn.executors), { status: 409, error: WORDS_GATHERING.page.closed.body });
  assert.equal((await kept(withdrawn.content)).text, null);
  const { content, executors } = await fresh();
  const racing = { ...executors, content: async (sql: string, params: unknown[] = []) => {
    if (/^UPDATE example_words/.test(sql.trim())) await content.query("update example_words set text = 'moved' where id = $1", [ROW]);
    return executors.content(sql, params);
  } };
  assert.deepEqual(await checkAWordsAsk(given({ words: 'ok', consent: 'private' }), racing), { status: 409, error: WORDS_GATHERING.page.changed.body });
  assert.equal((await kept(content)).text, 'moved');
});

test('a site with no words_gathering row, or a table name that is not plain, is an error, not a page', async () => {
  const { executors } = await fresh();
  await assert.rejects(checkAWordsAsk(given({ words_table: 'x; drop table y' }), executors), /plain lower-case table name/);
  await assert.rejects(checkAWordsAsk(given({ site: 'other' }), executors), /No words_gathering row/);
});

// A site's act runs the tool as the words database's writer login, holding only the column rights read-data/writer-rights.json
// names (its words table given its own name), and the asks database's reader login, which only reads.
test('words are kept by logins holding only the column rights writer-rights.json names, the asks read only', async () => {
  const { content, asks } = await fresh();
  const rights = JSON.parse(readFileSync(new URL('../read-data/writer-rights.json', import.meta.url), 'utf8')).writes;
  await content.exec('create role words_writer nologin');
  for (const write of rights) {
    const table = write.table.replace('<words_table>', 'example_words');
    for (const right of ['select', 'insert', 'update'] as const) {
      if (write[right]) await content.exec(`grant ${right} (${write[right].map((column: string) => `"${column}"`).join(', ')}) on table ${table} to words_writer`);
    }
  }
  await asks.exec('create role asks_reader nologin; grant select on words_asks to asks_reader');
  await content.exec('set role words_writer');
  await asks.exec('set role asks_reader');
  const on = (db: PGlite) => async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[];
  const ask = (extra: Partial<Given>) => checkAWordsAsk({ database: 'd', asks_database: 'a', site: 'example', words_table: 'example_words', token: TOKEN, ...extra } as Given, { content: on(content), asks: on(asks) });
  assert.equal((await ask({})).state, 'form');
  assert.deepEqual(await ask({ words: 'It helped a lot.', consent: 'full-name' }), { status: 200, state: 'thanks' });
  await content.exec('reset role');
  assert.equal(((await content.query('select text from example_words')).rows[0] as { text: string }).text, 'It helped a lot.');
  await assert.rejects(asks.query("insert into words_asks values ('x@example.test', 'b', 'r')"), /permission denied/, 'the asks login only reads');
});
