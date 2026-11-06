// Ported from old trillion test/person-notifications.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The reader is src/person-notifications.mjs here. Its sources were the old Network Durable Object
// (src/network.mjs requestRecordsTo and spaces), which went with the Worker; the network here is a stand-in that keeps the
// records in the shapes the reader reads (a network-request record; a space with its unread count). Left out: answering the
// invitation through the workspace route (old src/work-spaces.mjs handleWorkSpaces over src/person-spaces.mjs and the
// Network) and the network's own decline, which no running code does (searched handleWorkSpaces' invitations answer,
// requestRecordsTo in trillion-workshop tools/, trillion-apps web/, trillion-rust src/); the stand-in network turns the
// request accepted or forgets a declined one, as the old Network's records then read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import kinds from '../../shared-code/src/person-notifications.json' with { type: 'json' };
import { markPersonNotifications, readPersonNotifications } from '../src/person-notifications.mjs';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return { exec: (query, ...binds) => { const statement = db.prepare(query); const rows = /^\s*(select|pragma)|returning/i.test(query) ? statement.all(...binds) : (statement.run(...binds), []); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } };
}

// Ana's space "A snack brand", and Bo's view of the network: the requests sent to Bo and the spaces Bo is in.
function world() {
  const space = 'mem_snack';
  const requests = new Map();
  let joined = false, unread = 0, activity = null, next = 1;
  const at = () => new Date().toISOString();
  const network = {
    request: ({ why }) => { const request = { request_id: `req_${next++}`, from: 'Ana', why, space: 'A snack brand', space_id: space, status: 'open', asked_at: at() }; requests.set(request.request_id, request); return request; },
    answer: (id, accept) => { if (!accept) { requests.delete(id); return; } Object.assign(requests.get(id), { status: 'accepted', answered_at: at() }); joined = true; },
    addSpaceItems: count => { unread += count; activity = at(); },
  };
  const boStore = sqlite();
  const work = { work: [], agents: [] };
  const sources = {
    requests: async () => [...requests.values()].map(record => ({ record: structuredClone(record) })),
    spaces: async () => (joined ? [{ space_id: space, title: 'A snack brand', unread, last_activity_at: activity }] : []),
    work: async () => work,
  };
  return { network, space, boStore, work, sources };
}

test('an invitation into a space is one unread notification with Accept and Decline, and accepting turns it into "You joined"', async () => {
  const { network, space, boStore, sources } = world();
  assert.deepEqual((await readPersonNotifications(boStore, sources)).items, [], 'nothing happened, nothing is listed');
  const invite = network.request({ why: 'Work on the brand with me' });
  const before = await readPersonNotifications(boStore, sources);
  assert.equal(before.unread, 1);
  const [row] = before.items;
  assert.equal(row.id, `request:${invite.request_id}`);
  assert.equal(row.kind, 'space-invitation');
  assert.match(row.title, /A snack brand/);
  assert.equal(row.detail, 'Work on the brand with me');
  assert.deepEqual(row.actions.filter(action => action.post).map(action => [action.label, action.post.path, action.post.body]), [
    ['Accept', '/work/api/spaces/invitations/answer', { request_id: invite.request_id, accept: true }],
    ['Decline', '/work/api/spaces/invitations/answer', { request_id: invite.request_id, accept: false }],
  ]);
  // A press on the notification's body opens where the invitation is answered (every kind names its press).
  assert.deepEqual(row.actions.filter(action => action.press).map(action => action.open.surface_id), ['trillion.network']);

  network.answer(invite.request_id, true);
  const after = await readPersonNotifications(boStore, sources);
  const joined = after.items.find(item => item.id === row.id);
  assert.equal(joined.kind, 'space-joined');
  assert.equal(joined.title, 'You joined A snack brand');
  assert.deepEqual(joined.actions.map(action => [action.label, action.open.surface_id, action.open.input, action.press]), [['Open pursuit', 'trillion.space', { id: space }, true]]);
});

test('every kind of notification opens its thing from a press on its body: one action of each kind is its press, and it opens', () => {
  for (const [kind, row] of Object.entries(kinds.kinds)) {
    const presses = row.actions.filter(action => action.press);
    assert.equal(presses.length, 1, `${kind} names one press`);
    assert.ok(presses[0].open?.surface_id, `${kind}'s press opens a screen`);
  }
});

test('read marks are the person\'s own: marking read lowers the count, unread raises it again; a decline leaves nothing', async () => {
  const { network, boStore, sources } = world();
  const invite = network.request({ why: 'Join us' });
  const id = `request:${invite.request_id}`;
  markPersonNotifications(boStore, { ids: [id] });
  assert.equal((await readPersonNotifications(boStore, sources)).unread, 0);
  markPersonNotifications(boStore, { ids: [id], read: false });
  assert.equal((await readPersonNotifications(boStore, sources)).unread, 1);
  assert.throws(() => markPersonNotifications(boStore, { ids: [] }), /list of their ids/);
  network.answer(invite.request_id, false);
  assert.deepEqual((await readPersonNotifications(boStore, sources)).items, []);
});

test('new items in a space and work handed to an AI are listed from their records; a source that fails leaves only its rows out', async () => {
  const { network, space, boStore, work, sources } = world();
  const invite = network.request({ why: 'Join us' });
  network.answer(invite.request_id, true);
  network.addSpaceItems(2);
  const now = new Date().toISOString();
  work.agents.push({ agent_id: 'agent_1', name: 'Writer', app: 'Claude Code' });
  // Each job holds the AI's instructions (`job`) and the work as the person sees it (`said`); only `said` is shown.
  const forTheAi = words => `${words}. Read it with list_pursuits, take it with take_work (handoff_id "h_9"), then finish_work.`;
  work.work.push({ handoff_id: 'h1', state: 'open', job: forTheAi('Draft the launch post'), said: 'Draft the launch post', to_agent: 'agent_1', handed_at: now });
  work.work.push({ handoff_id: 'h3', state: 'taken', job: forTheAi('Plan the week'), said: 'Plan the week', taken_by: 'agent_1', handed_at: now, taken_at: now, steps: 3 });
  work.work.push({ handoff_id: 'h4', state: 'finished', job: forTheAi('Name the plan'), said: 'Name the plan', taken_by: 'claude', handed_at: now, finished_at: now, summary: null, result: { outcome: 'Called it Trillion X' } });
  work.work.push({ handoff_id: 'h2', state: 'finished', job: forTheAi('Sort the receipts'), said: 'Sort the receipts', to_agent: 'agent_1', taken_by: 'agent_1', handed_at: now, finished_at: now, summary: '42 receipts sorted', steps: 1 });
  work.work.push({ handoff_id: 'h5', state: 'open', job: forTheAi('Tidy the folder'), said: null, to_agent: null, handed_at: now });
  work.work.push({ handoff_id: 'h6', state: 'open', job: forTheAi('Look into the goal'), said: 'Look into the goal', input: { arrived: { asked_id: 'asked:9' } }, handed_at: now });
  const { items } = await readPersonNotifications(boStore, sources);
  const byKind = Object.fromEntries(items.map(item => [item.kind, item]));
  assert.equal(byKind['space-new-items'].title, '2 new in A snack brand');
  const byHandoff = Object.fromEntries(items.map(item => [item.id, item]));
  // Work reads in one glance: its whole title, who has it as a face (the app it came in as), and one quiet line of how
  // far it has got; no chips, and the whole row opens the job (its one action is the row's own press).
  assert.equal(byHandoff['handoff:h1:waiting'].title, 'Draft the launch post');
  assert.deepEqual(byHandoff['handoff:h1:waiting'].face, { name: 'Writer', app: 'Claude Code' });
  assert.equal(byHandoff['handoff:h1:waiting'].detail, 'Waiting for Writer');
  assert.equal(byHandoff['handoff:h1:waiting'].working, false, 'waiting is not working, so the face does not turn');
  assert.deepEqual(byHandoff['handoff:h1:waiting'].chips, []);
  assert.deepEqual(byHandoff['handoff:h1:waiting'].actions.map(action => [action.label, action.press, action.open.input]), [['See AI work', true, { handoff: 'h1' }]]);
  assert.equal(byHandoff['handoff:h5:waiting'].title, 'Sent to your AIs');
  assert.equal(byHandoff['handoff:h5:waiting'].face, null, 'no one named, no face: the kind\'s icon leads');
  assert.equal(byHandoff['handoff:h5:waiting'].detail, 'Waiting for any of your AIs', 'work with no words for the person shows none of the job');
  assert.equal(byHandoff['handoff:h4:finished'].title, 'Name the plan');
  assert.deepEqual(byHandoff['handoff:h4:finished'].face, { name: 'claude', app: null }, 'an AI with no card is named by its id');
  for (const item of items) for (const words of [item.title, item.detail ?? '', item.face?.name ?? '']) {
    assert.doesNotMatch(words, /take_work|finish_work|list_pursuits|handoff_id|h_9/, `${item.id} shows no instruction to an AI`);
  }
  assert.equal(byKind['work-finished'].title, 'Sort the receipts');
  assert.equal(byKind['work-taken'].title, 'Plan the week');
  assert.deepEqual(byKind['work-taken'].face, { name: 'Writer', app: 'Claude Code' });
  assert.equal(byKind['work-taken'].working, true, 'the AI at it now turns');
  assert.equal(byKind['work-taken'].detail, 'Working · 3 steps');
  const byId = Object.fromEntries(items.map(item => [item.id, item]));
  // Finished work says what came back: the AI's summary, else its result in words, else how far it got.
  assert.equal(byId['handoff:h2:finished'].detail, '42 receipts sorted');
  assert.equal(byId['handoff:h4:finished'].detail, 'Called it Trillion X', 'with no summary, the result is said in words');
  // Work still going on is running and names what it is about: the press that asked for it, else the handoff.
  assert.equal(byId['handoff:h1:waiting'].running, true);
  assert.equal(byId['handoff:h3:taken'].running, true);
  assert.equal(byId['handoff:h2:finished'].running, false);
  assert.equal(byId['handoff:h6:waiting'].about, 'asked:9');
  assert.equal(byId['handoff:h1:waiting'].about, 'h1');
  assert.equal(byKind['space-new-items'].running, false);
  const broken = { ...sources, spaces: async () => { throw new Error('network away'); } };
  const partial = await readPersonNotifications(boStore, broken);
  assert.ok(!partial.items.some(item => item.kind === 'space-new-items'));
  assert.ok(partial.items.some(item => item.kind === 'work-finished'));
});
