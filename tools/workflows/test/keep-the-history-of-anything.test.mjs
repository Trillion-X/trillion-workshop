// tools/workflows: workflow:keep-the-history-of-anything's prove attempts, run through two example renderings (a server
// database and an embedded one, test/fixtures/keep-the-history-of-anything), give every answer the recipe writes. The
// attempts name no store; the renderings are examples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { DatabaseSync } from 'node:sqlite';
import { runField, postgresRunner, embeddedRunner } from './fixtures/keep-the-history-of-anything/runners.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const recipe = JSON.parse(read('../recipes/keep-the-history-of-anything.json')).records[0].payload;
const prove = recipe.steps.find((step) => step.id === 'prove');
const fields = JSON.parse(prove.do.slice(prove.do.indexOf('The attempts: ') + 'The attempts: '.length));
const server = read('./fixtures/keep-the-history-of-anything/server-database.sql');
const embedded = read('./fixtures/keep-the-history-of-anything/embedded-database.sql');
const written = (attempts) => attempts.map((attempt) => (attempt.answer === undefined ? null : attempt.answer));

for (const [field, attempts] of Object.entries(fields)) {
  test(`${field}: the server rendering gives every written answer`, async () => {
    const answers = await runField(await postgresRunner(PGlite, server), attempts.map(({ answer, ...a }) => a));
    assert.deepEqual(answers, written(attempts));
  });
  test(`${field}: the embedded rendering gives every written answer it can run`, async () => {
    const answers = await runField(embeddedRunner(DatabaseSync, embedded), attempts.map(({ answer, ...a }) => a));
    const ran = answers.map((answer, i) => [answer, written(attempts)[i]]).filter(([answer]) => !answer?.not_run);
    assert.ok(ran.length >= 10, `${field}: ${ran.length} attempts ran`);
    for (const [answer, want] of ran) assert.deepEqual(answer, want);
  });
}

test('the intent and its kit name no store', () => {
  const words = read('../recipes/keep-the-history-of-anything.json') + read('../kits/keep-the-history-of-anything.json');
  for (const marker of [/\bpostgres(ql)?\b/i, /\bpglite\b/i, /\bsqlite3?\b/i, /\b(create table|insert into|delete from)\b/i, /run-sql-in-my-database/]) assert.doesNotMatch(words, marker);
});
