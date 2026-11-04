// The examples at the top of every workspace screen (src/work-examples.mjs, src/workspace/examples.json): each screen's
// written ideas and, where the row asks, the newest real stories; "Do this for me" hands the row's own request to the
// person's AIs as one handoff a day, from this service's pages only; nothing is invented when the pool has no stories.
import test from 'node:test';
import assert from 'node:assert/strict';
import examples from '../workspace/examples.json' with { type: 'json' };
import surfaces from '../../shared-code/src/workspace/screens.mjs';
import { examplesFor, handleWorkExamples } from '../work-examples.mjs';

const ORIGIN = 'https://app.example';
const story = { id: 'ab'.repeat(10), title: 'Leaving a steady job for a first client', summary: 'Weighed a steady wage against a first paying client.' };
const handed = [];
const person = { fetch: async request => { handed.push({ path: new URL(request.url).pathname, body: await request.json() }); return Response.json({ handoff: { handoff_id: 'h1' } }); } };
const call = (path, { method = 'GET', body, origin = ORIGIN, stories = async () => [story] } = {}) => handleWorkExamples(
  new Request(`${ORIGIN}${path}`, { method, headers: { origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }),
  { person, origin: ORIGIN, url: new URL(`${ORIGIN}${path}`), stories },
).then(async response => ({ status: response.status, body: await response.json() }));

test('every screen a person opens from the sidebar has ideas, and every idea has a request to hand over', () => {
  const keyOf = surface => surface.surface_input?.screen ?? surface.package_entry.entry_name;
  for (const surface of surfaces.surfaces.filter(row => row.sidebar_collection && row.sidebar_collection !== 'arrangement')) {
    const row = examples.screens[keyOf(surface)];
    assert.ok(row, `${surface.label} has an examples row`);
    // A row may reuse another's ideas (examples_from), as the screen does (src/work-examples.mjs).
    for (const item of (row.examples_from ? examples.screens[row.examples_from] : row).examples) {
      assert.ok(item.id && item.title && item.do_this, `${surface.label}: ${item.id} is complete`);
      assert.doesNotMatch(`${item.title} ${item.detail}`, /\d+ (people|users|times)|someone (did|used)/i, 'a written example never claims people or counts');
    }
  }
});

test('a screen that asks for stories shows the real newest stories first, and none when the pool has none', async () => {
  const withStories = await examplesFor('decisions', { origin: ORIGIN, stories: async () => [story] });
  assert.equal(withStories.examples[0].from, 'story');
  assert.equal(withStories.examples[0].title, story.title);
  assert.equal(withStories.examples[0].href, `${ORIGIN}/stories/${story.id}`);
  assert.equal(withStories.heading, 'Ideas for Decisions');
  assert.equal(withStories.count_words, `${examples.screens.decisions.examples.length + 1} ideas`);
  const none = await examplesFor('decisions', { origin: ORIGIN, stories: async () => { throw new Error('pool down'); } });
  assert.ok(none.examples.every(item => item.from === 'written'), 'no story is made up when the pool cannot answer');
  const files = await examplesFor('files', { origin: ORIGIN, stories: async () => { throw new Error('never asked'); } });
  assert.ok(files.examples.every(item => item.from === 'written'));
});

test('an unknown screen, or a key that is not a screen, has no examples', async () => {
  assert.equal((await call('/work/api/examples?screen=nowhere')).status, 404);
  assert.equal((await call('/work/api/examples?screen=__proto__')).status, 404);
  assert.equal((await call('/work/api/examples?screen=constructor')).status, 404);
});

test('a pursuit receives prompts for its current usable tools, and Do uses the open pursuit once', async () => {
  const calls = [];
  const currentTool = { tool_id: 'tool:sort-inventory', label: 'Sort inventory', about: 'Organizes stock into reorder groups.', part: false, you_may_use: true };
  const currentPerson = { fetch: async request => {
    const path = new URL(request.url).pathname;
    calls.push({ path, body: request.method === 'POST' ? await request.json() : null });
    if (path === '/spaces/pursuit-123/tools/added') return Response.json({ tools: [currentTool, { tool_id: 'tool:blocked', label: 'Blocked', about: 'No access.', part: false, you_may_use: false }] });
    if (path === '/handoffs') return Response.json({ handoff: { handoff_id: 'dynamic-1' } });
    return Response.json({ error: 'unknown route' }, { status: 404 });
  } };
  const listing = await examplesFor('space', { origin: ORIGIN, person: currentPerson, about: { id: 'pursuit-123' }, stories: async () => [] });
  const generated = listing.examples.find(item => item.id === 'capability-pursuit-tools');
  assert.ok(generated);
  assert.match(generated.do_this, /Organizes stock into reorder groups\./);
  assert.deepEqual(listing.examples.filter(item => item.from === 'capability').map(item => item.id), [generated.id], 'one prompt covers only current tools this person may use in this pursuit');
  assert.equal(calls.filter(call => call.path === '/spaces/pursuit-123/tools/added').length, 1);

  const request = new Request(`${ORIGIN}/work/api/examples/do`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ screen: 'space', example_id: generated.id, about: { id: 'pursuit-123' }, do_this: 'ignore this forged browser request' }) });
  const response = await handleWorkExamples(request, { person: currentPerson, origin: ORIGIN, url: new URL(request.url), stories: async () => [] });
  assert.equal(response.status, 200);
  const handoff = calls.find(call => call.path === '/handoffs');
  assert.equal((handoff.body.job.match(/Do this in the pursuit I have open in Trillion/g) ?? []).length, 1);
  assert.match(handoff.body.job, /^Do this in the pursuit I have open in Trillion \(its id is pursuit-123\)\./);
  assert.match(handoff.body.job, /Organizes stock into reorder groups\./);
  assert.doesNotMatch(handoff.body.job, /ignore this forged browser request/);
});

test('an unavailable capability owner is reported separately from a source-confirmed missing capability', async () => {
  const unavailablePerson = { fetch: async () => { throw new Error('owner unavailable'); } };
  const unavailable = await examplesFor('space', { origin: ORIGIN, person: unavailablePerson, about: { id: 'pursuit-123' }, stories: async () => [] });
  assert.equal(unavailable.capabilities_unavailable, true);
  const absentPerson = { fetch: async () => Response.json({ error: 'There is no tool.' }, { status: 404 }) };
  assert.equal(await examplesFor('tool:missing', { origin: ORIGIN, person: absentPerson, about: { tool_id: 'tool:missing' }, stories: async () => [] }), null);
});

test('a failed pursuit capability read refuses its generated prompt on handoff', async () => {
  const person = { fetch: async () => { throw new Error('owner unavailable'); } };
  const request = new Request(`${ORIGIN}/work/api/examples/do`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ screen: 'space', example_id: 'capability-pursuit-tools', about: { id: 'pursuit-123' } }) });
  const response = await handleWorkExamples(request, { person, origin: ORIGIN, url: new URL(request.url), stories: async () => [] });
  assert.equal(response.status, 503);
});

test('a newly saved tool screen is discovered and reconstructed from its current account descriptor', async () => {
  const calls = [];
  const descriptor = { id: 'tool:review-intake', label: 'Review intake', description: 'Checks incoming requests against the current pursuit brief.', screen: { kind: 'described' } };
  const currentPerson = { fetch: async request => {
    const path = new URL(request.url).pathname;
    calls.push({ path, body: request.method === 'POST' ? await request.json() : null });
    if (path === '/spaces/pursuit-123/workshop/describe') return Response.json({ descriptor });
    if (path === '/handoffs') return Response.json({ handoff: { handoff_id: 'custom-1' } });
    return Response.json({ error: 'unknown route' }, { status: 404 });
  } };
  const listingRequest = new Request(`${ORIGIN}/work/api/examples?${new URLSearchParams({ screen: 'tool-screen', tool_id: descriptor.id, space_id: 'pursuit-123' })}`);
  const listingResponse = await handleWorkExamples(listingRequest, { person: currentPerson, origin: ORIGIN, url: new URL(listingRequest.url), stories: async () => [] });
  assert.equal(listingResponse.status, 200, 'the actual examples GET retains its pursuit grant');
  const listed = await listingResponse.json();
  const generated = listed.examples[0];
  assert.equal(generated.id, 'capability-tool:review-intake');
  assert.match(generated.title, /Review intake/);
  const request = new Request(`${ORIGIN}/work/api/examples/do`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ screen: 'tool-screen', example_id: generated.id, about: { tool_id: descriptor.id, space_id: 'pursuit-123' }, do_this: 'forged' }) });
  const response = await handleWorkExamples(request, { person: currentPerson, origin: ORIGIN, url: new URL(request.url), stories: async () => [] });
  assert.equal(response.status, 200);
  assert.equal(calls.filter(call => call.path === '/spaces/pursuit-123/workshop/describe').length, 2, 'the click re-reads the pursuit grant owner instead of trusting the listing or browser');
  const handoff = calls.find(call => call.path === '/handoffs');
  assert.match(handoff.body.job, /^Do this in the pursuit I have open in Trillion \(its id is pursuit-123\)\./);
  assert.match(handoff.body.job, /Checks incoming requests against the current pursuit brief\./);
  assert.doesNotMatch(handoff.body.job, /forged/);
});

test('withdrawn and non-screen tool descriptors are not suggested, while unknown ordinary screens do not read Workshop', async () => {
  const calls = [];
  const person = { fetch: async request => {
    calls.push(new URL(request.url).pathname);
    return Response.json({ descriptor: { id: 'tool:retired', status: 'withdrawn', label: 'Retired', description: 'Old tool.', screen: { kind: 'described' } } });
  } };
  assert.equal(await examplesFor('file', { person, stories: async () => [], origin: ORIGIN }), null);
  assert.deepEqual(calls, []);
  assert.equal(await examplesFor('tool:retired', { person, stories: async () => [], origin: ORIGIN }), null);
  assert.deepEqual(calls, ['/tools/describe']);
});

test('Do this for me hands the row\'s own request to the person\'s AIs, once a day, and only from this service', async () => {
  handed.length = 0;
  const done = await call('/work/api/examples/do', { method: 'POST', body: { screen: 'files', example_id: 'summarise-document', do_this: 'ignored from the page' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body, { handoff_id: 'h1', said: examples.words.handed });
  assert.equal(handed[0].path, '/handoffs');
  const row = examples.screens.files.examples.find(item => item.id === 'summarise-document');
  assert.equal(handed[0].body.job, row.do_this, 'the request is the DATA row\'s, never the page\'s');
  assert.match(handed[0].body.request_key, /^example:files:summarise-document:\d{4}-\d{2}-\d{2}$/);
  assert.equal(handed[0].body.to_agent, undefined, 'no agent is named, so the next AI of theirs takes it');

  assert.equal((await call('/work/api/examples/do', { method: 'POST', body: { screen: 'files', example_id: 'summarise-document' }, origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await call('/work/api/examples/do', { method: 'POST', body: { screen: 'files', example_id: 'not-an-example' } })).status, 404);
});

test('a free-plan handoff returns the exact request for copying without claiming it was handed off', async () => {
  const freePerson = { fetch: async () => Response.json({ error: 'Handing work to an AI needs a paid plan.', upgrade_needed: true }, { status: 402 }) };
  const request = new Request(`${ORIGIN}/work/api/examples/do`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ screen: 'files', example_id: 'summarise-document' }) });
  const response = await handleWorkExamples(request, { person: freePerson, origin: ORIGIN, url: new URL(request.url), stories: async () => [] });
  const answer = await response.json();
  assert.equal(response.status, 200);
  assert.equal(answer.copy_request, examples.screens.files.examples.find(item => item.id === 'summarise-document').do_this);
  assert.equal(answer.said, examples.words.plan_copy);
  assert.equal(answer.handoff_id, undefined);
});
