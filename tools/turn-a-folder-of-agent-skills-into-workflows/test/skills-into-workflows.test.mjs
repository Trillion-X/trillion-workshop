// A person's own skills become workflows in their own account; a skill holding a secret, a computer path, an address, a
// phone number or one of their private words stays home. Synthetic skills only: the secret is built here, never written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { turnSkillsIntoWorkflows, workflowsFromRows, filesOfRows } from '../read-data/skills-into-workflows.mjs';

const SECRET = ['sk', 'live', 'x'.repeat(24)].join('_');
const row = (path, value, part = null, parts = null) => ({
  id: `record:agent-skill:s~${path}${part > 1 ? `#text-part-${part}` : ''}`,
  value: { 'file.path': path, 'file.folder': path.slice(0, path.lastIndexOf('/')), 'file.name': path.split('/').pop(), 'file.ext': path.split('.').pop(), ...(part ? { 'document.parent': path, 'document.part': part, 'document.parts': parts } : {}), 'document.text': value },
});
const skill = (name, description, body, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;
const SKILLS = [
  row('/skills/tidy-notes/SKILL.md', skill('tidy-notes', 'Tidies a pile of notes into one page.', 'Read every note. Group them. Write one page.')),
  row('/skills/tidy-notes/template.md', 'A page: title, three groups, one next step.'),
  row('/skills/tidy-notes/photo.png', null),
  row('/skills/long-one/SKILL.md', skill('long-one', 'A skill long enough to arrive in two parts.', 'Step one.\n'), 1, 2),
  row('/skills/long-one/SKILL.md', 'Step two: finish.', 2, 2),
  row('/skills/leaky/SKILL.md', skill('leaky', 'Calls a service.', `Use the key ${SECRET} to call it.`)),
  row('/skills/pathy/SKILL.md', skill('pathy', 'Reads a folder.', 'Open ~/Documents/notes and read them.')),
  row('/skills/named/SKILL.md', skill('named', 'Writes to a person.', 'Write to Zorblax Industries about the order.')),
  row('/skills/licensed/SKILL.md', skill('licensed', 'Has a licence.', 'Do the thing.', 'license: MIT\n')),
  row('/skills/torn/SKILL.md', skill('torn', 'Lost a part.', 'Start.\n'), 1, 2),
];

function fakeDoor(rows, existing = []) {
  const writes = [];
  return {
    writes,
    async *list({ type }) { for (const item of type === 'record:agent-skill' ? rows : existing) yield { ...item, type }; },
    async write(records, { key }) { writes.push({ records, key }); return { ok: true }; },
  };
}

test('parts of one file are joined in order, and a file missing a part is incomplete', () => {
  const files = filesOfRows([SKILLS[4], SKILLS[3], SKILLS[9]]);
  assert.match(files.get('/skills/long-one/SKILL.md').text, /Step one\.\n\nStep two: finish\.$|Step two: finish\.$/);
  assert.equal(files.get('/skills/torn/SKILL.md').text, null);
  assert.equal(files.get('/skills/torn/SKILL.md').incomplete, true);
});

test('skills with nothing to filter become workflows; the one with a secret stays home and its secret is never quoted', () => {
  const { made, home } = workflowsFromRows(SKILLS);
  assert.deepEqual(made.map(item => item.id), ['workflow:skill-licensed', 'workflow:skill-long-one', 'workflow:skill-named', 'workflow:skill-tidy-notes']);
  const leaky = home.find(item => item.skill === 'leaky');
  assert.deepEqual(leaky.reasons, ['SKILL.md holds what looks like a secret key or token']);
  assert.ok(!JSON.stringify(home).includes(SECRET));
  assert.deepEqual(home.find(item => item.skill === 'pathy').reasons, ['SKILL.md names a folder on one person\'s computer']);
  assert.deepEqual(home.find(item => item.skill === 'torn').reasons, ['SKILL.md is not whole in the skills list']);
});

test('a private word keeps a skill home, whatever its case', () => {
  const { made, home } = workflowsFromRows(SKILLS, { privateWords: ['zorblax'] });
  assert.ok(!made.some(item => item.id === 'workflow:skill-named'));
  assert.deepEqual(home.find(item => item.skill === 'named').reasons, ['SKILL.md names one of your private people, businesses or systems']);
});

test('the rows are the workflow and step rows the account reads back, with files riding along and the licence on the source', () => {
  const tidy = workflowsFromRows(SKILLS).made.find(item => item.id === 'workflow:skill-tidy-notes');
  const [step, recipe] = tidy.rows;
  assert.equal(recipe.id, 'record:workflow-recipe:skill-tidy-notes');
  assert.equal(recipe.value.recipe, 'workflow:skill-tidy-notes');
  assert.deepEqual(Object.keys(JSON.parse(recipe.value.files)), ['template.md']);
  assert.deepEqual(recipe.value.files_left_out, ['photo.png']);
  assert.equal(step.id, 'record:workflow-step:skill-tidy-notes--follow-the-skill');
  assert.deepEqual(step.value.recipe, ['skill-tidy-notes']);
  assert.match(step.value.do, /Read every note\./);
  const licensed = workflowsFromRows(SKILLS).made.find(item => item.id === 'workflow:skill-licensed');
  assert.equal(JSON.parse(licensed.rows[1].value.source).licence, 'MIT');
});

test('a run writes the workflows into the account in batches under the run key, and names a workflow whose skill is gone', async () => {
  const stale = { id: 'record:workflow-recipe:skill-old', value: { recipe: 'workflow:skill-old', source: JSON.stringify({ from: 'agent skill' }) } };
  const own = { id: 'record:workflow-recipe:skill-hand', value: { recipe: 'workflow:skill-hand', source: JSON.stringify({ from: 'me' }) } };
  const door = fakeDoor(SKILLS, [stale, own]);
  const answer = await turnSkillsIntoWorkflows({ input: {}, task: { request_key: 'k1' } }, { door });
  assert.equal(answer.written, 8);
  assert.deepEqual(answer.stale, ['workflow:skill-old']);
  assert.equal(door.writes.length, 1);
  assert.equal(door.writes[0].key, 'k1:0');
  assert.deepEqual(answer.home.map(item => item.skill).sort(), ['leaky', 'pathy', 'torn']);
});

test('a dry run writes nothing', async () => {
  const door = fakeDoor(SKILLS);
  const answer = await turnSkillsIntoWorkflows({ input: { dry_run: true } }, { door });
  assert.equal(door.writes.length, 0);
  assert.equal(answer.written, 0);
  assert.equal(answer.made.length, 4);
});

test('the rows read back as the recipe the account runs, files and all, and it passes the recipe validator', async () => {
  const { recipeFromRows } = await import('../../workflows/read-data/recipe-rows.mjs');
  const { recipeProblems } = await import('../../workflows/read-data/recipe-problems.mjs');
  const [step, recipeRow] = workflowsFromRows(SKILLS).made.find(item => item.id === 'workflow:skill-tidy-notes').rows;
  const recipe = recipeFromRows(recipeRow, [step]);
  assert.equal(recipe.id, 'workflow:skill-tidy-notes');
  assert.deepEqual(Object.keys(recipe.files), ['template.md']);
  assert.deepEqual(recipeProblems(recipe), []);
});

test('an email address and a phone number keep a skill home, and an illustration address does not', () => {
  const at = ['sam', 'realcorp.com'].join('@');
  const illustration = ['sam', 'example.com'].join('@');
  const rows = [
    row('/s/mails/SKILL.md', skill('mails', 'Sends mail.', `Write to ${at}.`)),
    row('/s/calls/SKILL.md', skill('calls', 'Rings someone.', 'Ring +1 415 555 0132 first.')),
    row('/s/fine/SKILL.md', skill('fine', 'Sends mail to an example.', `Write to ${illustration}.`)),
  ];
  const { made, home } = workflowsFromRows(rows);
  assert.deepEqual(made.map(item => item.id), ['workflow:skill-fine']);
  assert.deepEqual(home.map(item => item.reasons), [['SKILL.md holds a phone number'], ['SKILL.md holds an email address']]);
});
