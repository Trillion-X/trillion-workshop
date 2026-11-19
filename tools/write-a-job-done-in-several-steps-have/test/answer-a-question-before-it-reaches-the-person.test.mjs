// A question put to the person is answered first from their own rulings. The engine refuses an answer that sends it to
// them without naming one of the three things only they hold, or keeps it away without quoting the ruling that decides it.
// Made-up rulings only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workflowEngine } from '../read-data/run-a-workflow.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';

const { definitions } = JSON.parse(await readFile(new URL('../../workflows/definitions/answer-a-question-before-it-reaches-the-person.json', import.meta.url), 'utf8'));
const run = answers => makeWorkflowDefinitionRunner(workflowEngine).runWorkflowDefinition(
  { definitions, workflow_id: 'workflow:answer-a-question-before-it-reaches-the-person', input: { question: 'Remove the second copy of the meeting?', why_it_came_up: 'a made-up test' }, answers });
const ruling = { where: 'rules.md:5', quote: 'Fix a known defect without asking first.' };
const read = { 'read-the-rulings': { question: 'Remove the second copy of the meeting?', read: [ruling] } };
const ended = async judge => { try { return (await run({ ...read, judge })).status; } catch { return 'refused'; } };

test('the run reads the rulings first, then judges', async () => {
  const asked = await run({});
  assert.equal(asked.status, 'paused');
  assert.equal(asked.waiting[0].step_id, 'read-the-rulings');
});

test('an answer that keeps the question away quotes the ruling that decides it, and completes', async () => {
  assert.equal(await ended({ reaches_the_person: false, ruling, answer: 'Yes, it is a known defect.', next_step: 'Remove it and read the calendar back.' }), 'completed');
});

test('an approval ask is refused: reaching the person names a device, a payment, or two of their own rules', async () => {
  assert.notEqual(await ended({ reaches_the_person: true, ask: 'Shall I go ahead and remove it?' }), 'completed');
  assert.notEqual(await ended({ reaches_the_person: true, holds: 'their approval', what_only_they_can_do: 'say yes to the change', ask: 'Shall I remove it?' }), 'completed');
  assert.notEqual(await ended({ reaches_the_person: true, holds: 'a choice between two of their own rules', rules: [ruling], ask: 'Which wins?' }), 'completed');
  assert.notEqual(await ended({ reaches_the_person: false, answer: 'Yes.', next_step: 'Remove it.' }), 'completed', 'keeping it away needs the ruling');
});

test('a question only the person can answer reaches them', async () => {
  assert.equal(await ended({ reaches_the_person: true, holds: 'a device in their hand', what_only_they_can_do: 'approve the passkey prompt on their phone', ask: 'Approve the sign-in on your phone.' }), 'completed');
  assert.equal(await ended({ reaches_the_person: true, holds: 'a choice between two of their own rules', rules: [ruling, { where: 'rules.md:9', quote: 'Never change a live page without a backup.' }], ask: 'Fix now without a backup, or back up first?' }), 'completed');
});
