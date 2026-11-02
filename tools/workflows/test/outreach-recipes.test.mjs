// tools/workflows: the three outreach recipes (job posts, local businesses by zip code, a LinkedIn content system). Each
// step names exactly one tool the Workshop or the host offers and is checked to have run it; every step after the first
// has a check that reads the step just before it, so no step can be left out; and each method's own rules (21 days,
// 10 to 200 people, four sentences, gmail or info@, Saturday, the 100-point rubric, tracked apart from influence) are
// held by the step schemas and checks. Nothing here sends anything.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CHECK_VOCABULARY, HOST_TOOLS, recipeProblems, recipeToolGaps, recipeToolIds } from '../read-data/recipe-problems.mjs';
import { workshopRows } from '../read-data/workshop-tool-ids.mjs';

const tools = new URL('../../', import.meta.url).pathname;
const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const recipes = new Map(json('../recipes/workflows.json').records.map(({ payload }) => [payload.id, payload]));
const rows = workshopRows(tools);
const known = new Set(rows.map(({ payload }) => payload.id));
const folderOf = new Map(rows.map(({ folder, payload }) => [payload.id, folder]));
const hostRows = json('../host-tools.json').tools;
const OUTREACH = ['workflow:reach-companies-with-a-long-open-job-post', 'workflow:reach-local-businesses-by-zip-code', 'workflow:run-a-linkedin-content-system'];
const stepOf = (recipe, id) => recipes.get(recipe).steps.find(step => step.id === id);
const pathsOf = check => ['path', 'of', 'in'].map(field => check[field]).filter(Array.isArray);

test('each outreach recipe is shipped, valid and names no tool that nothing offers', () => {
  for (const id of OUTREACH) {
    const recipe = recipes.get(id);
    assert.ok(recipe, `${id} is in recipes/workflows.json`);
    assert.deepEqual(recipeProblems(recipe), [], id);
    assert.deepEqual(recipeToolGaps(recipe, { known }), [], id);
  }
});

test('every step names exactly one tool in its words, hands it back and is checked to have run it', () => {
  for (const id of OUTREACH) for (const step of recipes.get(id).steps) {
    const named = recipeToolIds({ steps: [{ do: step.do }] });
    assert.equal(named.length, 1, `${id} ${step.id} names one tool: ${named}`);
    assert.deepEqual(step.submit.properties.tool, { const: named[0] }, `${id} ${step.id} hands back its tool`);
    assert.ok(step.submit.required.includes('tool'));
    assert.ok(step.checks.some(check => check.kind === 'exists' && check.catalog === 'tool' && check.path.join('.') === 'this.tool'), `${id} ${step.id} checks its tool exists`);
  }
});

test('no step can be skipped: each step after the first checks the step just before it, and leaving one out is refused', () => {
  for (const id of OUTREACH) {
    const { steps } = recipes.get(id);
    steps.forEach((step, index) => {
      assert.ok(step.checks.length >= 2, `${id} ${step.id} has its own checks beyond the tool`);
      if (index === 0) return;
      const before = steps[index - 1].id;
      assert.ok(step.checks.some(check => pathsOf(check).some(path => path[0] === 'steps' && path[1] === before)), `${id} ${step.id} reads ${before}`);
      const without = { ...recipes.get(id), steps: steps.filter((_, at) => at !== index - 1) };
      assert.ok(recipeProblems(without).some(problem => problem.includes(`reads step "${before}", which is not an earlier step`)), `${id} without ${before} is refused`);
    });
  }
});

test('the recipes join the existing tools instead of building their own', () => {
  const folders = new Set(OUTREACH.flatMap(id => recipeToolIds(recipes.get(id))).map(tool => folderOf.get(tool)).filter(Boolean));
  for (const folder of ['find-signals-of-need', 'research-a-creator-or-topic', 'how-someone-does-their-thing', 'send-messages', 'customer-follow-up', 'traffic-attribution', 'judge-words', 'funnels-and-offers', 'run-experiments', 'social-posts']) {
    assert.ok(folders.has(folder), `a recipe step uses a tool of tools/${folder}`);
  }
});

test('the call step uses the one conversation exchange that exists outside this repository, found by its job', () => {
  const call = stepOf('workflow:reach-local-businesses-by-zip-code', 'call');
  const read = stepOf('workflow:reach-local-businesses-by-zip-code', 'call-outcomes');
  for (const [step, operation] of [[call, 'start_exchange'], [read, 'read_exchange']]) {
    const [tool] = recipeToolIds({ steps: [step] });
    const host = hostRows.find(row => row.tool === tool);
    assert.ok(HOST_TOOLS.has(tool) && host, `${tool} is a host tool`);
    assert.deepEqual([host.service, host.operation], ['agentphone', operation]);
    assert.ok(host.job && !known.has(tool), `${tool} has a job and no Workshop row builds a second one`);
  }
  assert.ok(call.do.includes(hostRows.find(row => row.tool === 'tool:start-an-exchange').job), 'the step names the tool by its job');
  assert.ok(!rows.some(({ payload }) => /\bexchange\b/i.test(payload.job ?? '') && /phone|call/i.test(payload.job ?? '')), 'no Workshop row places a phone call');
});

test('job posts: 21 days or more, 10 to 200 people, three problems from the day-to-day section, four sentences citing the role and days open', () => {
  const id = 'workflow:reach-companies-with-a-long-open-job-post';
  const source = json('../../find-signals-of-need/sources.json').records.find(row => row.id === 'open-job-posts');
  assert.deepEqual(source.filters.map(filter => filter.test), [{ between: [10, 200] }, { at_least: 21 }]);
  const prospect = stepOf(id, 'find').submit.properties.prospects.items.properties;
  assert.deepEqual([prospect.days_open.minimum, prospect.employees.minimum, prospect.employees.maximum], [21, 10, 200]);
  assert.deepEqual(stepOf(id, 'find').submit.properties.source, { const: 'open-job-posts' });
  const problems = stepOf(id, 'problems');
  assert.deepEqual([problems.submit.properties.briefs.items.properties.problems.minItems, problems.submit.properties.briefs.items.properties.problems.maxItems], [3, 3]);
  assert.ok(problems.checks.some(check => check.kind === 'mentioned-in' && check.in.join('.') === 'steps.read-post.posts.*.day_to_day'));
  const write = stepOf(id, 'write');
  const sentences = write.submit.properties.messages.items.properties.sentences;
  assert.deepEqual([sentences.minItems, sentences.maxItems], [4, 4]);
  const cited = write.checks.filter(check => check.kind === 'mentioned-in' && check.in.join('.') === 'this.messages.*.text').map(check => check.path.at(-1));
  assert.deepEqual(cited.sort(), ['days_open', 'role']);
  assert.ok(stepOf(id, 'pace').submit.properties.approved_by_person.const === true);
});

test('local businesses: review signals, a separate identity, gmail or info@ only, a local first line, Saturday, then the same list called', () => {
  const id = 'workflow:reach-local-businesses-by-zip-code';
  const identity = stepOf(id, 'identity');
  assert.ok(identity.checks.some(check => check.kind === 'differs-from' && check.path.join('.') === 'this.sending_domain' && check.of.join('.') === 'input.main_domain'));
  const source = json('../../find-signals-of-need/sources.json').records.find(row => row.id === 'local-businesses-by-place');
  assert.ok(['slow-quotes', 'review-spike'].every(signal => source.signals.some(row => row.id === signal)));
  assert.equal(source.signals.find(row => row.id === 'review-spike').within_days, 90);
  const pattern = new RegExp(stepOf(id, 'addresses').submit.properties.kept.items.properties.email.pattern);
  assert.deepEqual(['info@example.com', 'owner.name@gmail.com', 'owner@example.com', 'info@gmail', 'sales@gmail.co'].map(address => pattern.test(address)), [true, true, false, false, false]);
  assert.ok(stepOf(id, 'write').checks.some(check => check.kind === 'mentioned-in' && check.path.join('.') === 'this.messages.*.local_detail' && check.in.join('.') === 'this.messages.*.first_line'));
  const pace = stepOf(id, 'pace');
  assert.deepEqual(pace.submit.properties.send_day, { const: 'saturday' });
  assert.ok(pace.do.includes('saturday-local'));
  assert.deepEqual(json('../../send-messages/read-data/inbox-pacing.json').pacing.find(row => row.id === 'saturday-local').weekdays, ['saturday']);
  const ids = recipes.get(id).steps.map(step => step.id);
  assert.ok(ids.indexOf('call') > ids.indexOf('send'), 'calls come after the emails');
  assert.ok(stepOf(id, 'call').checks.some(check => check.kind === 'covers' && check.of.join('.') === 'steps.record.recorded.*.key'), 'the call list is the emailed list');
});

test('LinkedIn: a 100-point rubric where invented evidence blocks, tracked conversions apart from influence, edits only proposed', () => {
  const id = 'workflow:run-a-linkedin-content-system';
  const review = stepOf(id, 'review').submit.properties.reviews.items.properties;
  const weights = Object.fromEntries(Object.entries(review.scores.properties).map(([dimension, schema]) => [dimension, schema.maximum]));
  assert.deepEqual(weights, { relevance: 25, evidence: 25, argument: 20, voice: 20, readability: 10 });
  assert.equal(Object.values(weights).reduce((sum, weight) => sum + weight, 0), 100);
  assert.equal(review.total.maximum, 100);
  assert.equal(review.invented_evidence.maxItems, 0, 'one invented piece of evidence and the review cannot be handed back');
  assert.deepEqual(review.status, { const: 'passed' });
  const attribute = stepOf(id, 'attribute');
  const influenced = attribute.submit.properties.influenced.items;
  assert.equal(influenced.additionalProperties, false);
  assert.ok(!('conversions' in influenced.properties) && 'conversions' in attribute.submit.properties.tracked.items.properties);
  assert.ok(attribute.checks.some(check => check.path.join('.') === 'this.tracked.*.link' && check.of.join('.') === 'steps.track.links.*.link'));
  assert.deepEqual(stepOf(id, 'edits-to-rules').submit.properties.proposals.items.properties.status, { const: 'proposed' });
  assert.ok(stepOf(id, 'draft').checks.some(check => check.of?.join('.') === 'steps.objections.stalled.*.objection'), 'each post answers a stalled objection');
  assert.ok(stepOf(id, 'buyer-questions').checks.some(check => check.of?.join('.') === 'input.call_transcripts'));
});

test('the differs-from check kind is a DATA row of the vocabulary', () => {
  const row = CHECK_VOCABULARY.kinds.find(kind => kind.kind === 'differs-from');
  assert.deepEqual(row.fields.map(field => [field.field, field.shape, field.required]), [['path', 'path', true], ['of', 'path', true]]);
});

test('the recipes name no person, company, place or address of their own', () => {
  const text = JSON.stringify(OUTREACH.map(id => recipes.get(id)));
  assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[a-z]{2,}/, 'no email address');
  assert.doesNotMatch(text, /\b\d{5}\b/, 'no zip code');
});
