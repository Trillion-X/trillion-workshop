// Action rows over a site's real serve path (serve-a-sites-pages-from-its-rows serve.ts Site.act and its door), on a real PostgreSQL
// server in a temp folder. The front reads every rows read a row's later steps make before the row's own tool writes, so a read
// the site's reader login may not make keeps nothing, on any writing row: a site's /subscribe row (tool:keep-a-newsletter-signup,
// the real route run as the engine runs it, as a writer login holding exactly serve-articles-and-signup/read-data/writer-rights.json,
// then the confirmation mail through tool:send-an-email, a test transport here, its sender read from email_sender) and a /note row
// whose tool keeps a note. A mail the transport refuses after the signup was kept leaves that one pending signup with no send
// time, and the visitor's retry sends once to that same row. A then and an answer that read the table the row's tool writes, naming
// nothing of its answer, see it as it was before the write. Every address is invented.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { runTool } from '../../serve-a-sites-pages-from-its-rows/do-work/door.ts';
import type { ToolRun } from '../../serve-a-sites-pages-from-its-rows/do-work/door.ts';
import { pageStyles } from '../../serve-a-sites-pages-from-its-rows/do-work/page-styles.ts';
import { PageBundles } from '../../serve-a-sites-pages-from-its-rows/do-work/render.ts';
import { ScreenFiles } from '../../serve-a-sites-pages-from-its-rows/do-work/screen-files.ts';
import { settingsOf, Site } from '../../serve-a-sites-pages-from-its-rows/do-work/serve.ts';

const tools = join(import.meta.dirname, '..', '..');
const ROUTE = join(tools, 'serve-articles-and-signup', 'routes', 'keep-a-newsletter-signup.ts');
const RIGHTS = JSON.parse(readFileSync(join(tools, 'serve-articles-and-signup', 'read-data', 'writer-rights.json'), 'utf8')).writes;
const PORT = 57000 + (process.pid % 900);
const OWNER = ['postgres', 'made-up-admin-pw'];
const WRITER = ['newsletter_writer', 'made-up-writer-pw'];
const READER = ['site_reader', 'made-up-reader-pw'];
const login = ([user, word]: string[]) => `postgres://${user}:${word}@127.0.0.1:${PORT}/postgres`;
const SECRET = 'a-made-up-signup-secret-of-at-least-32-characters';
const SENDER_SQL = "SELECT substring(from_address from '<([^>]+)>') AS email, coalesce(nullif(trim(name), ''), trim(split_part(from_address, '<', 1))) AS name, reply_to FROM email_sender";
const FAILED = 'We could not send the email. Try again later.';

// The site's /subscribe row, as a site keeps it (its act's use left out: this server has no use binding).
const sender = (key: string) => ({ $: 'rows', key, sql: SENDER_SQL, database: 'postgres' });
// A second writing row: its tool keeps a note, then a mail step whose sender is read the same way.
const NOTE = {
  path: '/note', host: null, method: 'POST', access: 'public', tool: 'tool:keep-a-note', failed: 'The note was not kept.',
  input: { words: { $: 'body', key: 'words' } }, answer: { json: ['kept'] },
  next: [{ tool: 'tool:send-an-email', input: { to: 'owner@example.test', subject: 'A note', text: { $: 'input', key: 'words' }, reply_to: sender('0.reply_to') } }],
};
// A row whose then and answer read the table its own tool writes, with nothing of the answer in the read: both see the rows as they
// were before the write (reads are made once per request, before the tool writes), as the grammar says.
const COUNT_NOTES = { $: 'rows', sql: 'SELECT count(*)::int AS n FROM notes', key: '0.n', database: 'postgres' };
const NOTE_COUNTED = {
  path: '/note-counted', host: null, method: 'POST', access: 'public', tool: 'tool:keep-a-note', failed: 'The note was not kept.',
  input: { words: { $: 'body', key: 'words' } },
  answer: { redirect_to: { $: 'url', base: '/noted', query: { before: COUNT_NOTES } } },
  then: { tool: 'tool:remember', input: { notes: COUNT_NOTES } },
};
const SUBSCRIBE = {
  path: '/subscribe', host: null, method: 'POST', access: 'public', tool: 'tool:keep-a-newsletter-signup', failed: FAILED,
  input: {
    action: 'subscribe', secret: 'site-articles-secret', database: 'postgres', origin: { $: 'origin' }, email: { $: 'body', key: 'email' }, source: { $: 'body', key: 'source' },
    signup: { consent: 'Send me new articles.', confirm: { subject: 'Confirm your sign-up', body: 'Click the link to confirm.', button: 'Confirm' } },
  },
  answer: { redirect_to: '/subscribe/check-inbox' },
  next: [{
    when: { $: 'pick', of: { $: 'answer', key: 'outcome' }, from: { send_confirmation: true }, else: false },
    tool: 'tool:send-an-email',
    input: { to: { $: 'answer', key: 'mail.to' }, subject: { $: 'answer', key: 'mail.subject' }, text: { $: 'answer', key: 'mail.text' }, reply_to: sender('0.reply_to'), from: { name: sender('0.name'), email: sender('0.email') } },
    failed: { tool: 'tool:keep-a-newsletter-signup', input: { action: 'send_failed', id: { $: 'answer', key: 'attempt.id' }, digest: { $: 'answer', key: 'attempt.digest' }, secret: 'site-articles-secret', origin: { $: 'origin' }, database: 'postgres' } },
  }],
  outcomes: { outcome: { too_many: { words: 'Too many sign-ups from here', redraw: 429 }, invalid_email: { words: 'That address does not look right', redraw: 400 } } },
};

let server: EmbeddedPostgres;
let owner: pg.Client;
before(async () => {
  server = new EmbeddedPostgres({ databaseDir: tempFolder(join(tmpdir(), 'newsletter-unsent-')), user: OWNER[0], password: OWNER[1], port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  owner = new pg.Client({ connectionString: login(OWNER) });
  await owner.connect();
  await owner.query(`create table subscribers (id text primary key, email text unique not null, status text not null, confirm_digest text, confirm_sent_at timestamptz, source_path text,
    network_digest text, created_at timestamptz, tags jsonb default '[]', consent_text text, consent_at timestamptz, consent_page text, consent_ip_digest text,
    confirmed_at timestamptz, ended_at timestamptz, ended_reason text)`);
  await owner.query('create table email_sender (from_address text, name text, reply_to text)');
  await owner.query("insert into email_sender values ('The Site <hello@example.test>', 'The Site', 'reply@example.test')");
  await owner.query('create table notes (id serial primary key, words text not null)');
  await owner.query(`create role ${WRITER[0]} login password '${WRITER[1]}'`);
  await owner.query(`create role ${READER[0]} login password '${READER[1]}'`);
  for (const write of RIGHTS) {
    for (const right of ['select', 'insert', 'update'] as const) if (write[right]) await owner.query(`grant ${right} (${write[right].join(', ')}) on table ${write.table} to ${WRITER[0]}`);
    assert.equal(write.delete, undefined, 'the writer may delete no subscriber');
  }
});
after(async () => { await owner.end(); await server.stop(); });

// One run of the real route as the engine starts it: the input on standard input, the writer's connection on descriptor 3, the
// secret on descriptor 4; its answer is its one line of JSON, its refusal its words on standard error.
function runRoute(input: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ROUTE], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    (child.stdio[3] as NodeJS.WritableStream).end(login(WRITER));
    (child.stdio[4] as NodeJS.WritableStream).end(SECRET);
    child.stdin!.end(JSON.stringify(input));
  });
}

// An engine door on loopback: the site's own row reads (its actions; nothing else), the sender read as the reader login, the
// signup's real route, and a mail transport that keeps each mail or refuses it.
async function door(transport: { mails: unknown[]; refuse: boolean; remembered?: unknown[] }, tools: string[] = []) {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      const run = JSON.parse(body).params.arguments.input as ToolRun & { input: Record<string, unknown> };
      if (run.tool !== 'tool:run-sql-in-my-database') tools.push(run.tool);
      const ran = (result: unknown) => response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { tool: run.tool, exit_code: 0, result } } }));
      const refused = (error: string) => response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { tool: run.tool, exit_code: 1, error, result: null } } }));
      if (run.tool === 'tool:run-sql-in-my-database') {
        const sql = String(run.input.sql);
        if (sql.includes('FROM row_changes')) return refused('permission denied for table row_changes');
        if (sql.includes('FROM "site_actions"')) return ran({ rows: [SUBSCRIBE, NOTE, NOTE_COUNTED] });
        if (sql.includes('FROM notes')) return ran({ rows: (await owner.query(sql)).rows });
        if (!sql.includes('email_sender')) return ran({ rows: [] });
        const reader = new pg.Client({ connectionString: login(READER) });
        await reader.connect();
        try { return ran({ rows: (await reader.query(sql, (run.input.params as unknown[]) ?? [])).rows }); } catch (error) { return refused((error as Error).message); } finally { await reader.end(); }
      }
      if (run.tool === 'tool:keep-a-newsletter-signup') {
        const out = await runRoute(run.input);
        return out.code === 0 ? ran(JSON.parse(out.stdout)) : refused(out.stderr.trim());
      }
      if (run.tool === 'tool:keep-a-note') {
        const writer = new pg.Client({ connectionString: login(OWNER) });
        await writer.connect();
        try { return ran({ kept: (await writer.query('insert into notes (words) values ($1) returning id', [run.input.words])).rows.length }); } finally { await writer.end(); }
      }
      if (run.tool === 'tool:remember') {
        (transport.remembered ??= []).push(run.input);
        return ran({ kept: true });
      }
      if (run.tool === 'tool:send-an-email') {
        if (transport.refuse) return refused('The mail provider refused the message.');
        transport.mails.push(run.input);
        return ran({ sent: true });
      }
      return refused(`No tool ${run.tool} here.`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, address: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const files = new ScreenFiles();
let styles: Awaited<ReturnType<typeof pageStyles>>;
before(async () => { styles = await pageStyles(tools, files); });

async function siteOn(address: string) {
  const site = new Site({
    settings: settingsOf({
      listen: '127.0.0.1:0', hosts: ['site.example.test'], origin: 'https://site.example.test', lang: 'en',
      door: { address, pass_credential: 'site-door-pass' },
      pages: { database: 'postgres', refresh_seconds: 60, answer_seconds: 60 }, actions: 'site_actions',
      sign_in: { address: 'http://127.0.0.1:1', page: '/sign-in', issuer: 'https://sign-in.example.test', audience: 'https://site.example.test', team_claim: 'team_ids', members_team: 'team-members' },
    }),
    tools, run: (pass, call) => runTool({ address }, pass, call), sitePass: 'the-site-pass',
    passes: { memberOfCookie: async () => null }, storeKey: null,
    bundles: new PageBundles(tools, styles, files), palette: theme => styles.palette(theme),
    keepFont: async src => files.keep(Buffer.from(`font bytes of ${src}`), 'woff2'), files, screens: new Map(), log: () => {},
  });
  await site.read();
  return site;
}

const post = (site: Site, path: string, body: Record<string, string>) => site.act(path, undefined, 'site.example.test', { contentType: 'application/json', bytes: Buffer.from(JSON.stringify(body)) });
const signUp = (site: Site, email: string) => post(site, '/subscribe', { email, source: '/articles' });
const kept = async (email: string) => (await owner.query('select id, status, confirm_sent_at from subscribers where email = $1', [email])).rows;
const notes = async () => Number((await owner.query('select count(*)::int as n from notes')).rows[0].n);

test('a rows read the reader may not make keeps nothing on any writing row: no signup, no note, and the row\'s failure', async () => {
  await owner.query(`revoke select on email_sender from ${READER[0]}`);
  const transport = { mails: [] as unknown[], refuse: false };
  const ran: string[] = [];
  const d = await door(transport, ran);
  try {
    const site = await siteOn(d.address);
    const signup = await signUp(site, 'refused-read@example.test');
    assert.deepEqual([signup.status, JSON.parse(String(signup.body))], [502, { error: FAILED }]);
    assert.deepEqual(await kept('refused-read@example.test'), [], 'no signup is kept');
    const note = await post(site, '/note', { words: 'kept?' });
    assert.deepEqual([note.status, JSON.parse(String(note.body))], [502, { error: 'The note was not kept.' }]);
    assert.equal(await notes(), 0, 'no note is kept');
    assert.deepEqual(ran, [], 'neither row\'s tool ran, and no mail went');
  } finally { d.server.close(); }
});

test('with the read allowed, each row keeps its write and sends its one mail', async () => {
  await owner.query(`grant select (from_address, name, reply_to) on email_sender to ${READER[0]}`);
  const transport = { mails: [] as unknown[], refuse: false };
  const d = await door(transport);
  try {
    const site = await siteOn(d.address);
    const answer = await signUp(site, 'good@example.test');
    assert.deepEqual([answer.status, JSON.parse(String(answer.body))], [200, { redirect: '/subscribe/check-inbox' }]);
    const rows = await kept('good@example.test');
    assert.deepEqual([rows.length, rows[0].status, rows[0].confirm_sent_at !== null], [1, 'pending', true]);
    const mail = transport.mails[0] as { to: string; text: string; reply_to: string; from: { name: string; email: string } };
    assert.deepEqual([mail.to, mail.reply_to, mail.from], ['good@example.test', 'reply@example.test', { name: 'The Site', email: 'hello@example.test' }]);
    assert.match(mail.text, /https:\/\/site\.example\.test\/subscribe\/confirm\?s=/);
    const note = await post(site, '/note', { words: 'a note' });
    assert.deepEqual([note.status, JSON.parse(String(note.body))], [200, { kept: 1 }]);
    assert.equal(await notes(), 1);
    assert.equal(transport.mails.length, 2, 'one mail each');
  } finally { d.server.close(); }
});

test('a mail refused after the signup was kept leaves one pending unsent row and a 502; the retry sends once to that same row', async () => {
  await owner.query(`grant select (from_address, name, reply_to) on email_sender to ${READER[0]}`);
  const transport = { mails: [] as unknown[], refuse: true };
  const d = await door(transport);
  try {
    const site = await siteOn(d.address);
    const refused = await signUp(site, 'retry@example.test');
    assert.deepEqual([refused.status, JSON.parse(String(refused.body))], [502, { error: FAILED }]);
    const [unsent, ...more] = await kept('retry@example.test');
    assert.deepEqual([more.length, unsent.status, unsent.confirm_sent_at], [0, 'pending', null], 'one pending row, honestly not sent yet');
    transport.refuse = false;
    const retried = await signUp(site, 'retry@example.test');
    assert.deepEqual([retried.status, JSON.parse(String(retried.body))], [200, { redirect: '/subscribe/check-inbox' }]);
    const after = await kept('retry@example.test');
    assert.deepEqual([after.length, after[0].id, after[0].confirm_sent_at !== null], [1, unsent.id, true], 'the same row, now sent');
    assert.equal(transport.mails.length, 1, 'the retry sent once');
    assert.equal((transport.mails[0] as { to: string }).to, 'retry@example.test');
  } finally { d.server.close(); }
});

test('a then and an answer that read the table the row\'s tool writes, naming nothing of its answer, see the rows as before the write', async () => {
  const transport = { mails: [] as unknown[], refuse: false, remembered: [] as unknown[] };
  const d = await door(transport);
  try {
    const before = await notes();
    const answer = await post(await siteOn(d.address), '/note-counted', { words: 'counted' });
    assert.deepEqual([answer.status, JSON.parse(String(answer.body))], [200, { redirect: `/noted?before=${before}` }], 'the answer read the count from before the write');
    assert.equal(await notes(), before + 1, 'the note was kept');
    assert.deepEqual(transport.remembered, [{ notes: before }], 'then read the same count, once, from before the write');
  } finally { d.server.close(); }
});
