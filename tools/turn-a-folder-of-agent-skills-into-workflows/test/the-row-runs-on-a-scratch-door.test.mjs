// The tool row run the way the engine runs it (test-helpers/run-a-row.mjs: its packed files laid under /opt, no records
// door because the row declares none): synthetic skills in the request, workflows in the answer, the skill holding a
// secret left out and nothing kept. The secret is built here, never written into a file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

const row = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records[0].payload;
const SECRET = ['sk', 'live', 'y'.repeat(24)].join('_');
const file = (path, text) => ({ id: `record:agent-skill:scratch~${path}`, type: 'record:agent-skill', value: { 'file.path': path, 'file.folder': path.slice(0, path.lastIndexOf('/')), 'file.ext': path.split('.').pop(), 'document.text': text } });
const skill = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

test('the row declares no records door, and the clean skill becomes a workflow in the answer while the skill naming a secret does not', async () => {
  assert.equal(row.invoke.records, undefined);
  const records = [
    file('/s/plan-a-trip/SKILL.md', skill('plan-a-trip', 'Plans a trip from a few wishes.', 'Ask for dates. List three options.')),
    file('/s/plan-a-trip/checklist.md', 'Passport. Charger. Tickets.'),
    file('/s/call-the-service/SKILL.md', skill('call-the-service', 'Calls a paid service.', `Send the key ${SECRET} with every call.`)),
  ];
  const run = await runRow(row, { records, private_words: [] });
  assert.equal(run.code, 0, run.stderr);
  const answer = run.last.result;
  assert.deepEqual(answer.made, ['workflow:skill-plan-a-trip']);
  assert.deepEqual(answer.home, [{ skill: 'call-the-service', reasons: ['SKILL.md holds what looks like a secret key or token'] }]);
  assert.deepEqual(answer.workflows[0].rows.map(item => item.id).sort(), ['record:workflow-recipe:skill-plan-a-trip', 'record:workflow-step:skill-plan-a-trip--follow-the-skill']);
  const recipe = answer.workflows[0].rows.find(item => item.type === 'record:workflow-recipe');
  assert.deepEqual(Object.keys(JSON.parse(recipe.value.files)), ['checklist.md']);
  assert.equal((run.kept ?? []).length, 0);
  assert.ok(!JSON.stringify(run.last).includes(SECRET));
});
