// Moved from Trillion-X/trillion test/tool-behavior-notes.test.mjs, assertions unchanged. Its last test (the hosted tools list,
// src/tools.mjs with src/mcp-tool-review.mjs) stays in trillion with its caller.
//
// A tool's description says in words what its four hints say to the AI app (src/tool-behavior-notes.mjs): sentences come from
// DATA rows, are not repeated when the description already says them, and every listed tool still passes the directory review.
import assert from 'node:assert/strict';
import test from 'node:test';
import notes from '../read-data/tool-behavior-notes.json' with { type: 'json' };
import { withBehaviorNotes } from '../read-data/tool-behavior-notes.mjs';

const hints = (overrides) => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...overrides });
const tool = (description, overrides) => ({ name: 't', description, annotations: hints(overrides) });

test('each hint adds its sentence from the matching row, after the description, in row order', () => {
  assert.equal(withBehaviorNotes(tool('Lists the things kept today.', { readOnlyHint: true, idempotentHint: true })).description,
    `Lists the things kept today. ${notes.rows[0].say}`);
  assert.equal(withBehaviorNotes(tool('Deletes one kept thing.', { destructiveHint: true })).description, `Deletes one kept thing. ${notes.rows[1].say}`);
  assert.equal(withBehaviorNotes(tool('Sets one value.', { idempotentHint: true })).description, `Sets one value. ${notes.rows[2].say}`);
  assert.equal(withBehaviorNotes(tool('Emails one person.', { openWorldHint: true })).description, `Emails one person. ${notes.rows[3].say}`);
  assert.equal(withBehaviorNotes(tool('Removes it from outside.', { destructiveHint: true, openWorldHint: true })).description,
    `Removes it from outside. ${notes.rows[1].say} ${notes.rows[3].say}`);
});

test('a description that already says it is left alone, and a tool with no hints is returned as it is', () => {
  const already = tool('It changes nothing and only looks.', { readOnlyHint: true });
  assert.equal(withBehaviorNotes(already), already);
  const sure = tool('Deletes a file. Confirm with the person first.', { destructiveHint: true });
  assert.equal(withBehaviorNotes(sure).description, sure.description);
  const bare = { name: 'b', description: 'Does a thing for someone.' };
  assert.equal(withBehaviorNotes(bare), bare);
  const partial = { name: 'p', description: 'Does a thing for someone.', annotations: { readOnlyHint: true } };
  assert.ok(withBehaviorNotes(partial).description.endsWith(notes.rows[0].say));
});

test('a row added to the DATA is a new sentence with no code change', () => {
  const rules = { rows: [...notes.rows, { when: { readOnlyHint: true, openWorldHint: true }, say: 'Reads from outside.', unless: [] }] };
  assert.ok(withBehaviorNotes(tool('Looks something up.', { readOnlyHint: true, openWorldHint: true }), rules).description.endsWith('Reads from outside.'));
});
