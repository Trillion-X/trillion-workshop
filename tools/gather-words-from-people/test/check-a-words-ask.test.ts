// The words page route on two real Postgres engines (PGlite): asks in one, words in the other. A token of the wrong shape or no ask
// is not found, a check changes nothing, words are kept with the consent chosen, the same words again change nothing, a row that
// moved is refused, and a withdrawn row takes no more words. Every name and line is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createHmac, randomBytes } from 'node:crypto';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { checkAWordsAsk, type Given } from '../routes/check-a-words-ask.ts';
import { runSql } from '../../run-sql-in-my-database/do-work/run-sql.mjs';

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
    create table example_words (id text primary key, author text, text text, consent_basis text, words_state jsonb not null default '{}', came_from text, created text, changed_at timestamptz, ask_key_digest text);`);
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
// names (its words table given its own name), and the asks database's reader login, holding only the columns
// read-data/reader-rights.json names.
test('words are kept by logins holding only the column rights writer-rights.json and reader-rights.json name, the asks read only', async () => {
  const { content, asks } = await fresh();
  const rights = JSON.parse(readFileSync(new URL('../read-data/writer-rights.json', import.meta.url), 'utf8')).writes;
  await content.exec('create role words_writer nologin');
  for (const write of rights) {
    const table = write.table.replace('<words_table>', 'example_words');
    for (const right of ['select', 'insert', 'update'] as const) {
      if (write[right]) await content.exec(`grant ${right} (${write[right].map((column: string) => `"${column}"`).join(', ')}) on table ${table} to words_writer`);
    }
  }
  await asks.exec('create role asks_reader nologin');
  for (const read of JSON.parse(readFileSync(new URL('../read-data/reader-rights.json', import.meta.url), 'utf8')).reads) {
    await asks.exec(`grant select (${read.columns.map((column: string) => `"${column}"`).join(', ')}) on table ${read.table} to asks_reader`);
  }
  await content.exec('set role words_writer');
  await asks.exec('set role asks_reader');
  const on = (db: PGlite) => async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[];
  const ask = (extra: Partial<Given>) => checkAWordsAsk({ database: 'd', asks_database: 'a', site: 'example', words_table: 'example_words', token: TOKEN, ...extra } as Given, { content: on(content), asks: on(asks) });
  assert.equal((await ask({})).state, 'form');
  const notFound = await ask({ token: 'u'.repeat(43) });
  assert.deepEqual(notFound, await ask({ token: 'not a token' }), 'a well-formed token no ask holds answers as a malformed one does: 404 not_found, the same words');
  assert.equal(notFound.status, 404);
  assert.deepEqual(await ask({ words: 'It helped a lot.', consent: 'full-name' }), { status: 200, state: 'thanks' });
  await content.exec('reset role');
  assert.equal(((await content.query('select text from example_words')).rows[0] as { text: string }).text, 'It helped a lot.');
  await assert.rejects(asks.query("insert into words_asks values ('x@example.test', 'b', 'r')"), /permission denied/, 'the asks login only reads');
  await assert.rejects(asks.query('select email from words_asks'), /permission denied/, 'the asks login reads no address');
});

// Under a site's use the words login reaches only the row of the ask whose token the run presents (writer-rights.json `rows`), and
// never approves (keeps_out). The use binding and the writer's rights are made by run-sql's own role recipes, run on PGlite.
test('under a use the words login keeps words only in the row its token opens, and cannot approve them', async () => {
  const content = new PGlite({ extensions: { pgcrypto } });
  const KEY = randomBytes(32).toString('base64url');
  const tokenB = 'b'.repeat(43);
  await content.exec(`create role words_owner; create role words_reader; create role words_writer;
    alter database postgres owner to words_owner; grant all on schema public to words_owner; set role words_owner;
    create table words_gathering (site text primary key, ask_days int, page_url text, "case" text, came_from text, list jsonb, page jsonb);
    create table example_words (id text primary key, author text, text text, consent_basis text, words_state jsonb not null default '{}', came_from text, created text, changed_at timestamptz, shown boolean not null default false);`);
  await content.query('insert into words_gathering values ($1, $2, $3, $4, $5, $6, $7)', ['example', 14, WORDS_GATHERING.page_url, WORDS_GATHERING.case, WORDS_GATHERING.came_from, JSON.stringify(WORDS_GATHERING.list), JSON.stringify(WORDS_GATHERING.page)]);
  await content.query("insert into example_words (id, author, text, consent_basis, shown) values ('kept-before', 'Grace', 'Words shown on the page.', 'Told me in person', true)");
  // run-sql's own runSql, its client a PGlite session acting as the owner.
  const connect = async () => ({ query: async ({ text, values }: { text: string; values?: unknown[] }) => { const result = await content.query(text, values); return { fields: result.fields, rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; }, end: async () => {} });
  const connection = 'postgres://words_owner@127.0.0.1/postgres';
  await runSql({ connection, heldValue: KEY, connect, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: 'words_reader', tables: ['public.words_gathering'] } } });
  const writes = JSON.parse(JSON.stringify(JSON.parse(readFileSync(new URL('../read-data/writer-rights.json', import.meta.url), 'utf8')).writes).replaceAll('<words_table>', 'example_words'));
  await runSql({ connection, connect, input: { recipe: { name: 'may-write-named-columns-under-a-use', action: 'create', role: 'words_writer', writes } } });
  await content.exec('reset role');
  // The ask (after the recipe made the key column) makes each asked row as the owner, with its token's digest (the asking program's part).
  for (const [id, token] of [['asked-a', TOKEN], ['asked-b', tokenB]]) await content.query("insert into example_words (id, words_state, ask_key_digest) values ($1, '{\"status\": \"asked\"}', encode(sha256(convert_to($2, 'UTF8')), 'hex'))", [id, token]);
  const asks = new PGlite();
  await asks.exec('create table words_asks (email text primary key, token text not null unique, row_id text not null)');
  await asks.query('insert into words_asks values ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)', ['ada@example.test', TOKEN, 'asked-a', 'bo@example.test', tokenB, 'asked-b', 'eve@example.test', 'e'.repeat(43), 'kept-before']);
  const ticket = () => { const payload = Buffer.from(JSON.stringify({ nonce: randomBytes(16).toString('hex'), purpose: 'publish', surface: 'site/example.test', until: Date.now() + 60_000 })).toString('hex'); return `${payload}.${createHmac('sha256', KEY).update(payload).digest('hex')}`; };
  const on = (db: PGlite) => async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[];
  // One run as the site's act runs it: the writer login, one transaction that claims the use first.
  const send = async (token: string, extra: Partial<Given>) => {
    await content.exec('set role words_writer; begin');
    try {
      await content.query('select use_binding.claim_use($1)', [ticket()]);
      const answer = await checkAWordsAsk({ database: 'd', asks_database: 'a', site: 'example', words_table: 'example_words', token, use: { purpose: 'publish', surface: 'site/example.test' }, ...extra } as Given, { content: on(content), asks: on(asks) });
      await content.exec('commit');
      return answer;
    } catch (error) { await content.exec('rollback'); throw error; } finally { await content.exec('reset role'); }
  };
  const row = async (id: string) => (await content.query('select text, words_state, shown from example_words where id = $1', [id])).rows[0] as any;
  assert.deepEqual(await send(TOKEN, { words: 'It helped a lot.', consent: 'full-name' }), { status: 200, state: 'thanks' });
  assert.deepEqual(await send(tokenB, { words: 'My serve is new.', consent: 'private' }), { status: 200, state: 'thanks' });
  assert.deepEqual(await send(TOKEN, { words: 'It helped a great deal.', consent: 'full-name' }), { status: 200, state: 'thanks' }, 'its own row passes');
  assert.equal((await row('asked-a')).text, 'It helped a great deal.');
  // A token whose ask names a row kept before the fence (or anyone else's row) does not open it: the run cannot even read it.
  assert.deepEqual(await send('e'.repeat(43), { words: 'Rewritten.', consent: 'full-name' }), { status: 404, state: 'not_found', error: WORDS_GATHERING.page.not_found.body });
  assert.equal((await row('kept-before')).text, 'Words shown on the page.');
  // The login itself, holding A's token, cannot rewrite B's row nor approve its own.
  await content.exec('set role words_writer; begin');
  await content.query('select use_binding.claim_use($1)', [ticket()]);
  await content.query('select use_binding.present_key($1)', [TOKEN]);
  assert.equal((await content.query("update example_words set text = 'rewritten' where id = 'asked-b'")).affectedRows, 0, 'another use\'s row is refused');
  assert.equal((await content.query("update example_words set text = 'mine' where id = 'asked-a'")).affectedRows, 1, 'its own row passes');
  await content.exec('savepoint before_add');
  await assert.rejects(content.query("insert into example_words (id, text) values ('made-up', 'x')"), /row-level security|permission denied/, 'it adds no row of its own');
  await content.exec('rollback to savepoint before_add');
  await assert.rejects(content.query(`update example_words set words_state = words_state || '{"status": "approved", "approved_identity": "made-up"}' where id = 'asked-a'`), /row-level security/);
  await content.exec('rollback; reset role');
  assert.equal((await row('asked-b')).text, 'My serve is new.');
  assert.equal((await row('asked-a')).words_state.approved_identity, undefined);
  assert.deepEqual([(await row('asked-a')).shown, (await row('asked-b')).shown], [false, false]);
});
