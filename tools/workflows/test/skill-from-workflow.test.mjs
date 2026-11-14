// tools/workflows: a skill made from a workflow's rows holds every step, its agents and lanes, and the checks, and the
// same rows always make the same bytes. Every recipe here is made up.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recipeFromRows } from '../read-data/recipe-rows.mjs';
import { skillFromWorkflow } from '../read-data/skill-from-workflow.mjs';

const CLI = new URL('../do-work/skill-from-workflow.mjs', import.meta.url).pathname;
const recipeRow = { id: 'record:workflow-recipe:made-up-dig', value: { recipe: 'workflow:made-up-dig', title: 'Made-up dig', job: 'Dig up a made-up topic.', input_schema: '{"type":"object","required":["topic"],"properties":{"topic":{"type":"string"}}}' } };
const check = says => JSON.stringify([{ kind: 'distinct-at-least', path: ['this', 'parts', '*', 'id'], count: 1, says }]);
const stepRows = [
  { id: 'a', value: { recipe: ['made-up-dig'], step: 'split', position: 1, title: 'Split it', do: 'Split the   topic\ninto parts.', submit: '{"type":"object","required":["parts"]}', checks: check('Each part has an id') } },
  { id: 'b', value: { recipe: ['made-up-dig'], step: 'dig', position: 2, title: 'Dig each part', do: 'Dig.', submit: '{"type":"object","required":["lanes"]}', lanes_from: '["steps","split","parts","*","id"]', checks: JSON.stringify([{ kind: 'lane-jobs', path: ['this', 'lanes'], lane: 'id', job: 'job', says: 'Each part comes from its own job' }]) } },
  { id: 'c', value: { recipe: ['made-up-dig'], step: 'write', position: 3, title: 'Write it up', do: 'Write.', submit: '{"type":"object","required":["lanes"]}', lanes: '["writer"]', checks: JSON.stringify([{ kind: 'lane-jobs', path: ['this', 'lanes'], lane: 'id', job: 'job', says: 'A separate agent wrote it' }]) } },
];
const text = () => skillFromWorkflow(recipeFromRows(recipeRow, [...stepRows].reverse()));

test('the skill holds the name, the job, every step in position order, agents, lanes and checks', () => {
  const skill = text();
  assert.match(skill, /^---\nname: made-up-dig\ndescription: "Use when asked to: Dig up a made-up topic\. Runs workflow:made-up-dig;/);
  assert.ok(skill.includes('`{"row":"workflow:made-up-dig"}`') && skill.includes('`topic` (required)'));
  const order = ['### 1. Split it (`split`)', '### 2. Dig each part (`dig`)', '### 3. Write it up (`write`)'].map(heading => skill.indexOf(heading));
  assert.ok(order.every(at => at > 0) && order.join() === [...order].sort((a, b) => a - b).join());
  assert.ok(skill.includes('Split the topic into parts.'));
  assert.ok(skill.includes('Agents: one per lane, the lanes being read from the answer of step `split`'));
  assert.ok(skill.includes('Agents: 1, one per lane (writer)'));
  assert.ok(skill.includes('- Each part has an id') && skill.includes('- A separate agent wrote it'));
  assert.ok(skill.includes('Hands back: `parts`.'));
});

test('the same rows make the same bytes, and a changed row changes the skill', () => {
  assert.equal(text(), text());
  const changed = skillFromWorkflow(recipeFromRows(recipeRow, stepRows.map((row, at) => (at ? row : { ...row, value: { ...row.value, do: 'Split it another way.' } }))));
  assert.notEqual(changed, text());
  assert.ok(changed.includes('Split it another way.'));
});

test('the command writes the skill, and --check refuses a hand edit and a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-from-workflow-'));
  writeFileSync(join(dir, 'recipe.json'), JSON.stringify(recipeRow));
  writeFileSync(join(dir, 'steps.json'), JSON.stringify({ records: stepRows }));
  const run = (...rest) => spawnSync('node', [CLI, '--recipe', join(dir, 'recipe.json'), '--steps', join(dir, 'steps.json'), ...rest], { encoding: 'utf8' });
  const file = join(dir, 'SKILL.md');
  assert.equal(run('--check', file).status, 1);
  assert.equal(run('--out', file).status, 0);
  assert.equal(readFileSync(file, 'utf8'), text());
  assert.equal(run('--check', file).status, 0);
  writeFileSync(file, `${readFileSync(file, 'utf8')}\nA hand-written line.\n`);
  const drift = run('--check', file);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /DRIFT/);
});

test('a recipe row\'s skill field gives the trigger and the extra sections, placed at the start or the end, and without it nothing is added', () => {
  const skill = { description: 'Use when someone says dig.', sections: [{ title: 'Judgments', text: 'Answer plainly.', at: 'start' }, { title: 'Where output goes', text: 'Only into rows.' }] };
  const row = { ...recipeRow, value: { ...recipeRow.value, skill: JSON.stringify(skill) } };
  const made = skillFromWorkflow(recipeFromRows(row, stepRows));
  assert.ok(made.includes('description: "Use when someone says dig."'));
  assert.ok(made.indexOf('## Judgments') > 0 && made.indexOf('## Judgments') < made.indexOf('## Run the workflow'));
  assert.ok(made.indexOf('## Where output goes') > made.indexOf('### 3. Write it up'));
  assert.ok(made.includes('Answer plainly.') && made.includes('Only into rows.'));
  assert.ok(!text().includes('## Judgments'));
});

test('the skill is deterministic and a document the skill-row refresh can read: name, description and a source line naming the workflow row, no machine path or time', () => {
  const skill = text();
  const front = skill.split('---\n')[1];
  assert.match(front, /^name: made-up-dig\ndescription: ".+"\nsource: record:workflow-recipe:made-up-dig\n$/);
  assert.doesNotMatch(skill, /\/Users\/|~\/|\d{4}-\d{2}-\d{2}T\d{2}:/);
  assert.equal(skillFromWorkflow(recipeFromRows(recipeRow, [...stepRows])), skillFromWorkflow(recipeFromRows(recipeRow, [...stepRows].reverse())));
});
