// The tool row run the way the engine runs it (test-helpers/run-a-row.mjs: its packed files laid under /opt, the stand-in
// records door with exactly the row's rights): synthetic skills in, workflows written into the stand-in account, the
// skill holding a secret left out. The secret is built here, never written into a file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload;
const SECRET = ['sk', 'live', 'y'.repeat(24)].join('_');
const file = (path, text) => ({ id: `record:agent-skill:scratch~${path}`, type: 'record:agent-skill', value: { 'file.path': path, 'file.folder': path.slice(0, path.lastIndexOf('/')), 'file.ext': path.split('.').pop(), 'document.text': text } });
const skill = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

test('on a scratch door the clean skill becomes a workflow and the skill naming a secret does not', async () => {
  const records = [
    file('/s/plan-a-trip/SKILL.md', skill('plan-a-trip', 'Plans a trip from a few wishes.', 'Ask for dates. List three options.')),
    file('/s/plan-a-trip/checklist.md', 'Passport. Charger. Tickets.'),
    file('/s/call-the-service/SKILL.md', skill('call-the-service', 'Calls a paid service.', `Send the key ${SECRET} with every call.`)),
  ];
  const run = await runRow(row, { private_words: [] }, { records });
  assert.equal(run.code, 0, run.stderr);
  const answer = run.last.result;
  assert.deepEqual(answer.made, ['workflow:skill-plan-a-trip']);
  assert.deepEqual(answer.home, [{ skill: 'call-the-service', reasons: ['SKILL.md holds what looks like a secret key or token'] }]);
  assert.equal(answer.written, 2);
  const workflows = run.kept.filter(item => item.type.startsWith('record:workflow-'));
  assert.deepEqual(workflows.map(item => item.id).sort(), ['record:workflow-recipe:skill-plan-a-trip', 'record:workflow-step:skill-plan-a-trip--follow-the-skill']);
  assert.ok(!JSON.stringify(workflows).includes(SECRET), 'the secret is in no workflow the door now holds');
  assert.deepEqual(Object.keys(JSON.parse(workflows.find(item => item.type === 'record:workflow-recipe').value.files)), ['checklist.md']);
  assert.ok(!JSON.stringify(run.last).includes(SECRET));
});
