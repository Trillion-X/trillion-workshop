// Every workflow is a candidate branch: tool:choose-the-workflows-that-fire is given every workflow row the person has, as
// values, beside every recipe the Workshop installs, and the formulas engine chooses by the conditions each carries on its own row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { chooseTheWorkflowsThatFire } from '../read-data/choose-the-workflows-that-fire.mjs';
import { conditionProblems, FIRES_WHEN } from '../read-data/fires-when.mjs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';
import { runWorkflow } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';
import { rowOf, runRow } from '../../../test-helpers/run-a-row.mjs';

// Every recipe file the Workshop installs, as the chooser reads them (the first file holding an id wins).
const RECIPES = new URL('../recipes/', import.meta.url);
const installed = [...new Map(readdirSync(RECIPES).filter(name => name.endsWith('.json')).sort()
  .flatMap(name => JSON.parse(readFileSync(new URL(name, RECIPES), 'utf8')).records.map(({ payload }) => payload))
  .reverse().map(recipe => [recipe.id, recipe])).values()];

// The person's own workflow rows, exactly these ({ slug, value }), as the input field the chooser is given them in.
const handedIn = rows => ({ own: rows.map(row => ({ id: row.slug, value: row.value })) });

const kinds = values => ({ fields: [{ id: 'kinds', kind: 'tags', path: ['kinds'] }], tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'kinds', operator: 'has_any_of', params: { values } }] } });
const condition = (label, values, extra = {}) => ({ label, condition: kinds(values), made_by: 'the person', state: 'On', ...extra });
const ownRow = (slug, value) => ({ slug, value: { recipe: `workflow:${slug}`, ...value } });

test('on a blank account the installed workflows choose by their own conditions, and every installed workflow is a candidate', async () => {
  const answer = await chooseTheWorkflowsThatFire({ explain: true, parts: [{ words: 'Most teams skip the plan.', kinds: ['claim'], subjects: ['planning'] }], ...handedIn([]) });
  assert.equal(answer.workflows, installed.length);
  assert.equal(answer.own, 0);
  assert.ok(answer.chosen.some(item => item.workflow === 'workflow:research-what-everyone-says' && item.part === 0 && item.from === 'catalog'));
  // A recipe whose fires_when is empty, or holds only conditions that are Off, is unconditioned.
  const conditioned = new Set(installed.filter(recipe => (recipe.fires_when ?? []).some(item => !FIRES_WHEN.off_states.includes(item?.state))).map(recipe => recipe.id));
  assert.equal(answer.unconditioned.length, installed.length - conditioned.size);
  assert.ok(answer.unfinished.every(item => item.incomplete.every(text => /does not carry/.test(text))), 'a part that lacks a field is named, and nothing else is unfinished');
});

test('a workflow added to the person\'s list is chosen at once, with no list of branches edited', async () => {
  const added = ownRow('research-to-plan', { title: 'Research to plan', job: 'Turn research findings into a facts-first plan.', fires_when: JSON.stringify([condition('a research finding arrives', ['finding'])]) });
  const parts = [{ words: 'A finding: most small teams never write their plan down.', kinds: ['finding'] }, { words: 'Buy milk.', kinds: ['errand'] }];
  const before = await chooseTheWorkflowsThatFire({ explain: true, parts, ...handedIn([]) });
  assert.ok(!before.chosen.some(item => item.workflow === 'workflow:research-to-plan'));
  const after = await chooseTheWorkflowsThatFire({ explain: true, parts, ...handedIn([added]) });
  assert.deepEqual(after.chosen.filter(item => item.workflow === 'workflow:research-to-plan').map(({ workflow, label, part, condition, made_by, from }) => ({ workflow, label, part, condition, made_by, from })), [
    { workflow: 'workflow:research-to-plan', label: 'Research to plan', part: 0, condition: 'a research finding arrives', made_by: 'the person', from: 'own' },
  ]);
  assert.ok(after.unmatched_parts.includes(1), 'a part no condition keeps is named');
  assert.equal(after.workflows, before.workflows + 1);
});

test('the person\'s own conditions win over the installed ones', async () => {
  const id = 'workflow:research-what-everyone-says';
  const mine = ownRow('research-what-everyone-says', { fires_when: JSON.stringify([condition('only when I ask for research', ['research-request'])]) });
  const answer = await chooseTheWorkflowsThatFire({ explain: true, parts: [{ words: 'x', kinds: ['claim'] }, { words: 'y', kinds: ['research-request'] }], ...handedIn([mine]) });
  assert.deepEqual(answer.chosen.filter(item => item.workflow === id).map(item => [item.part, item.from]), [[1, 'own']]);
});

test('a row of the person\'s with only {recipe, fires_when} adds conditions to an installed workflow, whose installed steps still run', async () => {
  const id = 'workflow:first-win';
  const handed = handedIn([ownRow('first-win', { fires_when: JSON.stringify([condition('a trial starts', ['trial-started'])]) })]);
  const answer = await chooseTheWorkflowsThatFire({ explain: true, parts: [{ words: 'x', kinds: ['trial-started'] }], ...handed });
  assert.ok(answer.chosen.some(item => item.workflow === id && item.from === 'own'));
  const run = await runWorkflow({ row: id });
  assert.notEqual(run.status, 'failed', run.error_message);
  assert.equal(run.definition.steps[0].id, installed.find(recipe => recipe.id === id).steps[0].id);
});

test('an Off condition chooses nothing, an unfinished one is named, and a workflow with neither is unconditioned', async () => {
  const unfinished = { label: 'broken', condition: { fields: [{ id: 'kinds', kind: 'tags', path: ['kinds'] }], tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'nope', operator: 'has_any_of', params: { values: ['x'] } }] } }, made_by: 'the person', state: 'On' };
  const handed = handedIn([
    ownRow('off-one', { title: 'Off', fires_when: JSON.stringify([condition('retired', ['x'], { state: 'Off' })]) }),
    ownRow('broken-one', { title: 'Broken', fires_when: JSON.stringify([unfinished]) }),
    ownRow('bare-one', { title: 'Bare' }),
  ]);
  const answer = await chooseTheWorkflowsThatFire({ explain: true, parts: [{ words: 'x', kinds: ['x'] }], ...handed });
  assert.ok(!answer.chosen.some(item => ['workflow:off-one', 'workflow:broken-one'].includes(item.workflow)));
  const broken = answer.unfinished.filter(item => !item.incomplete.every(text => /does not carry/.test(text)));
  assert.deepEqual(broken.map(item => item.workflow), ['workflow:broken-one']);
  assert.ok(answer.unconditioned.some(item => item.workflow === 'workflow:off-one'));
  assert.ok(answer.unconditioned.some(item => item.workflow === 'workflow:bare-one' && item.label === 'Bare'));
});

test('every installed condition is one the engine evaluates; one it cannot, or that keeps every part, is named', () => {
  for (const recipe of installed) assert.deepEqual(conditionProblems(recipe.fires_when, recipe.id), [], `${recipe.id} conditions`);
  const keepsAll = { label: 'always', condition: { fields: [], tree: { kind: 'group', combinator: 'and', negate: false, rules: [] } }, made_by: 'x', state: 'On' };
  assert.deepEqual(conditionProblems([keepsAll]), ['fires_when[0].condition reads no field, so it would keep every part.']);
  assert.match(conditionProblems({})[0], /must be a list of conditions/);
  const base = installed.find(recipe => recipe.id === 'workflow:first-win');
  assert.deepEqual(recipeProblems({ ...base, fires_when: [keepsAll] }), ['fires_when[0].condition reads no field, so it would keep every part.'], 'the validator refuses it too');
});

test('matches are ranked by how rare the tags they met are, times the condition\'s measured weight', async () => {
  const both = (slug, values, extra) => ownRow(slug, { title: slug, fires_when: JSON.stringify([condition(slug, values, extra)]) });
  // common-tag is held by four workflows, rare-tag by three; c meets the part on both, d and e on rare-tag alone.
  const handed = handedIn([both('a', ['common-tag']), both('b', ['common-tag']), both('f', ['common-tag']), both('c', ['common-tag', 'rare-tag']), both('d', ['rare-tag'], { weight: 0.5 }), both('e', ['rare-tag'])]);
  const answer = await chooseTheWorkflowsThatFire({ explain: true, parts: [{ words: 'x', kinds: ['common-tag', 'rare-tag'] }], ...handed });
  const mine = answer.chosen.filter(item => ['a', 'b', 'c', 'd', 'e', 'f'].includes(item.workflow.replace('workflow:', '')));
  const score = id => mine.find(item => item.workflow === `workflow:${id}`).score;
  assert.ok(score('c') > score('e') && score('e') > score('a'), 'two tags met beat one, and the rarer tag beats the commoner');
  assert.ok(Math.abs(score('d') - score('e') / 2) < 1e-5, 'half the measured weight, half the score');
  assert.equal(score('a'), score('b'));
  const three = await chooseTheWorkflowsThatFire({ explain: true, parts: [{ words: 'x', kinds: ['common-tag', 'rare-tag'] }, { words: 'y', kinds: ['common-tag'] }, { words: 'z', kinds: [] }], ...handed });
  const broad = three.broad.map(entry => entry.workflow);
  assert.ok(broad.includes('workflow:a') && !broad.includes('workflow:e'), 'a condition keeping 2 of 3 parts is broad, one keeping 1 of 3 is not');
  assert.equal(mine.find(item => item.workflow === 'workflow:c').matched.length, 2);
  const ranks = answer.chosen.filter(item => item.part === 0).map(item => item.rank);
  assert.deepEqual(ranks, ranks.map((_, at) => at + 1), 'ranks run 1, 2, 3 within a part, best first');
});

test('a workflow in the chain of runs the choice is made inside is never chosen again, at any depth, and is named in within', async () => {
  const handed = handedIn([
    ownRow('plant-trees', { title: 'Plant trees', fires_when: JSON.stringify([condition('anything that should grow a tree', ['seed'])]) }),
    ownRow('split-notes', { title: 'Split notes', fires_when: JSON.stringify([condition('a note to split', ['seed', 'note'])]) }),
    ownRow('file-notes', { title: 'File notes', fires_when: JSON.stringify([condition('a note to file', ['note'])]) }),
  ]);
  const parts = [{ words: 'The whole seed again.', kinds: ['seed', 'note'] }];
  const top = await chooseTheWorkflowsThatFire({ parts, ...handed });
  assert.ok(top.chosen.some(item => item.workflow === 'workflow:plant-trees') && !top.within.length);
  const nested = await chooseTheWorkflowsThatFire({ parts, within: ['workflow:plant-trees', 'workflow:split-notes'], ...handed });
  assert.deepEqual(nested.chosen.map(item => item.workflow).filter(id => id.startsWith('workflow:plant') || id.startsWith('workflow:split') || id.startsWith('workflow:file')), ['workflow:file-notes']);
  assert.deepEqual(nested.within, [
    { workflow: 'workflow:plant-trees', part: 0, condition: 'anything that should grow a tree' },
    { workflow: 'workflow:split-notes', part: 0, condition: 'a note to split' },
  ]);
  assert.equal(nested.chosen.find(item => item.workflow === 'workflow:file-notes').rank, 1, 'ranks count only what may start');
  await assert.rejects(chooseTheWorkflowsThatFire({ parts, within: 'workflow:plant-trees', ...handed }), /within must be a list/);
});

test('the installed one tree, started inside its own run, is refused for a part that holds a whole seed', async () => {
  const parts = [{ words: 'A thought, a note and an email, all at once.', kinds: ['seed'] }];
  const outside = await chooseTheWorkflowsThatFire({ parts, ...handedIn([]) });
  assert.ok(outside.chosen.some(item => item.workflow === 'workflow:grow-the-one-tree'), 'a seed arriving from outside starts the tree');
  const inside = await chooseTheWorkflowsThatFire({ parts, within: ['workflow:grow-the-one-tree'], ...handedIn([]) });
  assert.ok(!inside.chosen.some(item => item.workflow === 'workflow:grow-the-one-tree'));
  assert.ok(inside.within.some(item => item.workflow === 'workflow:grow-the-one-tree' && item.part === 0));
});

test('installed false leaves out the installed recipes and every own row that shares an id with one; a chosen own row hands on its definition', async () => {
  const definition = { id: 'workflow:greet-a-new-member', name: 'Greet', kind: 'workflow', is_active: true, version: 1, steps: [], edges: [] };
  const mine = ownRow('greet-a-new-member', { title: 'Greet a new member', fires_when: JSON.stringify([condition('a member joined', ['member-joined'])]), definition: JSON.stringify(definition) });
  const shipped = installed.find(recipe => recipe.fires_when);
  const copy = { slug: shipped.id.replace(/^workflow:/, ''), value: { recipe: shipped.id, title: shipped.label, fires_when: JSON.stringify([condition('a member joined', ['member-joined'])]) } };
  const parts = [{ kinds: ['member-joined'] }];
  const both = await chooseTheWorkflowsThatFire({ parts, ...handedIn([mine, copy]) });
  assert.ok(both.chosen.some(item => item.workflow === shipped.id), 'beside the installed ones, a copied row is chosen');
  const only = await chooseTheWorkflowsThatFire({ parts, ...handedIn([mine, copy]), installed: false });
  assert.deepEqual(only.chosen.map(item => item.workflow), ['workflow:greet-a-new-member']);
  assert.deepEqual(only.chosen[0].definition, definition);
  assert.equal(only.workflows, 1);
  assert.equal(both.chosen.find(item => item.workflow === shipped.id).definition, undefined, 'a row with no definition hands none on');
  await assert.rejects(chooseTheWorkflowsThatFire({ parts, installed: 'no' }), /installed must be true or false/);
  const moved = await chooseTheWorkflowsThatFire({ explain: true, parts, ...handedIn([mine, copy]), installed: false, over_installed: [shipped.id] });
  assert.deepEqual(moved.chosen.map(item => item.workflow).sort(), ['workflow:greet-a-new-member', shipped.id].sort(), 'a listed id is chosen from its own row');
  assert.equal(moved.chosen.find(item => item.workflow === shipped.id).from, 'own');
  await assert.rejects(chooseTheWorkflowsThatFire({ parts, installed: false, over_installed: 'x' }), /over_installed must be a list/);
});

test('a choice says whether an installed recipe holds it, and a row that says where it is kept is started from there only when nothing installed holds it or over_installed names it', async () => {
  const shipped = installed.find(recipe => recipe.fires_when);
  const kept = (slug, recipe) => ({ slug, value: { recipe, fires_when: [condition('a member joined', ['member-joined'])], kept_in: 'home-connection' } });
  const rows = [kept('greet-a-new-member', 'workflow:greet-a-new-member'), kept(shipped.id.replace(/^workflow:/, ''), shipped.id)];
  const parts = [{ kinds: ['member-joined'] }];
  const plain = await chooseTheWorkflowsThatFire({ parts, ...handedIn(rows) });
  const of = (answer, id) => answer.chosen.find(item => item.workflow === id);
  assert.deepEqual([of(plain, 'workflow:greet-a-new-member').installed, of(plain, 'workflow:greet-a-new-member').kept_in], [false, 'home-connection']);
  assert.deepEqual([of(plain, shipped.id).installed, of(plain, shipped.id).kept_in], [true, undefined], 'an installed id is started by its own wakes');
  const over = await chooseTheWorkflowsThatFire({ parts, ...handedIn(rows), over_installed: [shipped.id] });
  assert.deepEqual([of(over, shipped.id).installed, of(over, shipped.id).kept_in], [true, 'home-connection']);
  await assert.rejects(chooseTheWorkflowsThatFire({ parts, own: [{ id: 'x', value: { kept_in: 7 } }] }), /x kept_in must name where the row is kept/);
});

test('parts are required', async () => {
  await assert.rejects(chooseTheWorkflowsThatFire({ parts: [], ...handedIn([]) }), /parts must be a list/);
});

test('on a blank account a customer asking a price is not sent to price testing, a request for a name reaches the naming method first, and a person to be told something reaches outreach', async () => {
  // The three parts of the one-tree follow-up items 1 to 3 (Nov 14 2026), tagged as choose-branches tags them.
  const parts = [
    { words: 'is the 10 session pack still 480', kinds: ['pricing-question', 'thread-needs-answer'] },
    { words: 'the side project needs a name, something short', kinds: ['naming-request', 'app-idea'] },
    { words: 'someone needs to know the Thursday clinic moved', kinds: ['notify-a-person'], people: ['a coach'] },
  ];
  const answer = await chooseTheWorkflowsThatFire({ parts, ...handedIn([]) });
  const of = part => answer.chosen.filter(choice => choice.part === part);
  assert.ok(!of(0).some(choice => choice.workflow === 'workflow:test-prices-and-change-a-page-for-each-visitor'));
  assert.equal(of(1)[0]?.workflow, 'workflow:method-name-things-by-what-they-do');
  assert.ok(of(2).some(choice => choice.workflow === 'workflow:personalized-reach-out'));
});

test('on a blank account a message that needs an answer starts the installed inbox workflow first, which keeps its mailboxes as rows of the person\'s own database', async () => {
  const parts = [{ words: 'can we swap Saturday 9am to Sunday afternoon if there is room?', kinds: ['thread-needs-answer'] }];
  const answer = await chooseTheWorkflowsThatFire({ parts, ...handedIn([]) });
  assert.equal(answer.chosen.find(choice => choice.part === 0 && choice.rank === 1)?.workflow, 'workflow:handle-every-inbox-daily');
  const inbox = installed.find(recipe => recipe.id === 'workflow:handle-every-inbox-daily');
  const text = JSON.stringify(inbox.steps.map(step => step.do));
  for (const type of ['mailbox', 'inbox-summary', 'calendar-task']) assert.doesNotMatch(text, new RegExp(`type \\\\?"${type}\\\\?"|\\\\"type\\\\":\\\\"${type}\\\\"`), `${type} is read and written as record:${type}`);
  assert.match(text, /mailboxes/);
  assert.doesNotMatch(text, /record:mailbox|person's own store/);
});

test('the person\'s own row for an id shadows the installed copy of that id; an id with no row of the person\'s still uses the installed copy', async () => {
  const claim = { words: 'Most teams skip the plan.', kinds: ['claim'] };
  const installedCopy = await chooseTheWorkflowsThatFire({ explain: true, parts: [claim], ...handedIn([]) });
  assert.ok(installedCopy.chosen.some(item => item.workflow === 'workflow:research-what-everyone-says' && item.from === 'catalog'), 'with no row of the person\'s, the installed copy chooses');
  const shadowed = ownRow('research-what-everyone-says', { title: 'Research what everyone says', fires_when: JSON.stringify([condition('a shadow-only kind arrives', ['shadow-only'])]) });
  const onlyOwn = await chooseTheWorkflowsThatFire({ explain: true, parts: [claim, { words: 'x', kinds: ['shadow-only'] }], ...handedIn([shadowed]) });
  assert.ok(!onlyOwn.chosen.some(item => item.workflow === 'workflow:research-what-everyone-says' && item.part === 0), 'the installed condition no longer chooses it');
  assert.ok(onlyOwn.chosen.some(item => item.workflow === 'workflow:research-what-everyone-says' && item.part === 1 && item.from === 'own'), 'the own condition chooses it');
  const bare = ownRow('research-what-everyone-says', { title: 'Research what everyone says' });
  const noConditions = await chooseTheWorkflowsThatFire({ explain: true, parts: [claim], ...handedIn([bare]) });
  assert.ok(!noConditions.chosen.some(item => item.workflow === 'workflow:research-what-everyone-says'), 'an own row with no conditions shadows the installed one');
  assert.ok(noConditions.unconditioned.some(item => item.workflow === 'workflow:research-what-everyone-says'));
});

test('an id the person holds a row for, given as shadow_ids alone, takes its installed copy out of the choice', async () => {
  const claim = { words: 'Most teams skip the plan.', kinds: ['claim'] };
  const withoutShadow = await chooseTheWorkflowsThatFire({ explain: true, parts: [claim], ...handedIn([]) });
  assert.ok(withoutShadow.chosen.some(item => item.workflow === 'workflow:research-what-everyone-says'));
  const shadowed = await chooseTheWorkflowsThatFire({ explain: true, parts: [claim], shadow_ids: ['workflow:research-what-everyone-says'], ...handedIn([]) });
  assert.ok(!shadowed.chosen.some(item => item.workflow === 'workflow:research-what-everyone-says'), 'a shadowed installed copy is not chosen');
  assert.ok(!shadowed.unconditioned.some(item => item.workflow === 'workflow:research-what-everyone-says'), 'and is not listed either');
  await assert.rejects(chooseTheWorkflowsThatFire({ parts: [claim], shadow_ids: 'workflow:x', ...handedIn([]) }), /shadow_ids must be a list/);
});

test('a condition on a field a part does not carry is named as unfinished, never dropped silently', async () => {
  const stage = { fields: [{ id: 'place', kind: 'choice', path: ['place'] }, { id: 'state', kind: 'choice', path: ['state'] }], tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'place', operator: 'is_any_of', params: { values: ['product_stage'] } }, { kind: 'rule', field: 'state', operator: 'is_any_of', params: { values: ['ready'] } }] } };
  const row = ownRow('ready-piece-filler', { title: 'Fill a ready piece', fires_when: JSON.stringify([{ label: 'a piece is ready to be filled', condition: stage, made_by: 'the person', state: 'On' }]) });
  const parts = [{ words: 'A kinds-only seed.', kinds: ['finding'] }, { words: 'A stage row.', place: 'product_stage', state: 'ready' }];
  const answer = await chooseTheWorkflowsThatFire({ explain: true, parts, ...handedIn([row]) });
  assert.ok(answer.chosen.some(item => item.workflow === 'workflow:ready-piece-filler' && item.part === 1), 'a part that carries the fields is chosen');
  assert.ok(!answer.chosen.some(item => item.workflow === 'workflow:ready-piece-filler' && item.part === 0));
  const named = answer.unfinished.find(item => item.workflow === 'workflow:ready-piece-filler' && item.part === 0);
  assert.ok(named, 'the part without the fields is named, not dropped');
  assert.match(named.incomplete.join(' '), /does not carry place/);
  assert.match(named.incomplete.join(' '), /does not carry state/);
});

test('the shipped row, run as the engine runs it, reaches no database and chooses from the workflow rows it is given', async () => {
  const row = rowOf(JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')), 'tool:choose-the-workflows-that-fire');
  assert.equal(row.invoke.records, undefined, 'no records door');
  assert.equal(row.invoke.local_doors, undefined, 'no database door');
  assert.equal(row.invoke.credential_mounts, undefined, 'no held connection');
  const ran = await runRow(row, { parts: [{ words: 'A finding.', kinds: ['finding'] }], ...handedIn([ownRow('research-to-plan', { title: 'Research to plan', fires_when: JSON.stringify([condition('a research finding arrives', ['finding'])]) })]) });
  assert.equal(ran.code, 0, ran.stderr + ran.out);
  assert.equal(ran.last.result.own, 1);
  assert.ok(ran.last.result.chosen.some(item => item.workflow === 'workflow:research-to-plan' && item.installed === false));
});
