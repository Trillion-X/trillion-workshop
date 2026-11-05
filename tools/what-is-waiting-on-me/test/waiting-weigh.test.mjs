// Waiting on you shows only what is the person's (src/waiting-weigh.mjs at the reader, person-store waitingOnYou):
// every section's things are weighed by src/who-does-it.mjs on the section's `step` (DATA) before any section is cut,
// what the AIs can do is handed to them and never shown, consent given once is not asked again, and one order runs
// across sections. The owner, 2026-10-11: drafts under his auto-approval, files from AI tests, stuck AI jobs and decisions
// his AIs opened from his own words were all on his list.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readCardSections } from '../../browse-inspiration-clips/card-sections.mjs';
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json' with { type: 'json' };
import { whoDoesEachStep } from '../../say-for-each-step-of-a-plan-who-should-do/src/who-does-it.mjs';
import who from '../../shared-code/src/who-does-it.json' with { type: 'json' };
import { inOrder, oneOrder, sameOnce, stepOf, weighCards } from '../from-old-trillion/src/waiting-weigh.mjs';

const weigh = input => whoDoesEachStep(input);

/** The reader's own pass: readCardSections with the weighing as its sift, as person-store waitingOnYou runs it. */
async function read(answers, given = {}) {
  const toAis = [];
  const sift = (section, cards) => {
    const weighed = weighCards([{ section, cards: sameOnce(cards) }], { settings, weigh, given });
    toAis.push(...weighed.toAis);
    return weighed.rows[0].cards;
  };
  const sources = Object.fromEntries(Object.keys(settings.sources).map(name => [name, async () => answers[name] ?? {}]));
  const answer = await readCardSections(sources, settings, { origin: 'https://app.example', sift });
  return { answer, toAis, shown: id => answer.sections.find(section => section.id === id)?.cards ?? [] };
}

const answers = {
  // An ask an AI filed that its own AIs can do, and one only the person can (their face on camera).
  asks: { rows: [
    { id: 'summary', values: { what: 'Write a summary of the call', needs: 'write a summary', asked_by: 'Claude', status: 'Waiting', added: '2026-10-11T06:00:00Z', where: 'https://app.example/files' } },
    { id: 'film', values: { what: 'Film the intro with your face', needs: 'record a video', reason_id: 'their-own-body', asked_by: 'Claude', status: 'Waiting', added: '2026-10-11T05:00:00Z', where: 'https://app.example/files' } },
  ] },
  posts: { posts: [
    { post_id: 'd1', caption: 'A new article', status: 'draft', updated_at: '2026-10-11T04:00:00Z' },
    { post_id: 'd2', caption: 'A new article', status: 'draft', updated_at: '2026-10-11T03:00:00Z' },
    { post_id: 'p1', caption: 'Already out', status: 'posted', updated_at: '2026-10-10T04:00:00Z' },
  ] },
  work: { work: [
    { handoff_id: 'h_1', said: 'Recover the test evidence', in_the_way: 'Historical evidence wall', status: 'blocked', handed_at: '2026-10-11T02:00:00Z' },
    // A job nobody took, marked stuck by Trillion: it already is the AIs' work, so no second job is made for it.
    { handoff_id: 'h_2', said: 'Getting stuck work moving again: Recover the test evidence', in_the_way: 'No AI took it', status: 'blocked', handed_at: '2026-10-11T03:00:00Z', from_agent: 'trillion-waiting-on-you' },
  ] },
  decisions: { summaries: [
    { case_id: 'c1', goal: 'that is apple garamond font', status: 'needs_decision', method: 'universal', created_at: '2026-10-11T06:00:00Z' },
    { case_id: 'c2', goal: 'Stop the setup gate holding him', status: 'needs_outcome', outcome_question: 'Does your workspace open now?', created_at: '2026-10-11T07:00:00Z' },
  ] },
  connections: { connections: [
    { vendor: 'bland', service: 'Bland', status: 'disconnected', connected_at: '2026-09-29T00:00:00Z' },
    { vendor: 'notion', service: 'Notion', status: 'connected' },
  ] },
  devices: { devices: [{ device_id: 'mac', route: 'live', label: 'Trillion for Mac', can_show: 'denied', turn_on: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=ai.gettrillion.macos', added_at: '2026-10-11T01:00:00Z' }] },
  made: { items: [{ item: 'made:f1', title: '/User testing/run-1/brief.md', label: 'Saved a file', at: '2026-10-11T07:10:00Z', tool: 'file_kept', opens_surface: 'trillion.file', opens_input: { id: 'f1' } }] },
};

test('every section declares the step its things are, so nothing reaches the person unweighed', () => {
  const reasons = new Set(who.only_a_person.map(reason => reason.id));
  for (const section of settings.sections) {
    if (section.id === 'asks' || section.id === 'given') continue; // each row an AI or a member files names its own needs
    assert.ok(section.step, `${section.id} declares a step`);
    assert.ok(Array.isArray(section.step.needs) && section.step.needs.length, `${section.id} names what it needs`);
    if (section.step.only_a_person_because) assert.ok(reasons.has(section.step.only_a_person_because), `${section.id} names a known reason`);
  }
});

test('what the AIs can do never reaches the person; a reason only they can meet does', async () => {
  const { answer, toAis, shown } = await read(answers);
  // An AI-doable ask goes to the AIs once; one that needs the person's own body stays theirs.
  assert.deepEqual(shown('asks').map(card => card.id), ['asks:film']);
  assert.ok(toAis.some(row => row.card.id === 'asks:summary' && row.handOff?.once_per === 'weighed:asks:summary'));
  // A stuck AI job, a decision its AIs opened, a question they can check themselves and a file from a test leave the
  // person's list, and each is handed to the AIs with its own section's words: nothing leaves without an AI holding it.
  for (const id of ['decide', 'answer', 'look']) {
    assert.deepEqual(shown(id), [], `${id} is the AIs' work`);
    const handed = toAis.filter(row => row.section.id === id);
    assert.ok(handed.length, `${id} is handed to the AIs`);
    for (const row of handed) {
      assert.ok(row.handOff?.job.includes(row.card.id), `${id} names its thing to the AIs`);
      assert.equal(row.handOff.once_per, `weighed:${row.card.id}`);
    }
  }
  assert.match(toAis.find(row => row.section.id === 'decide').handOff.job, /export_decision/);
  // Stuck work leaves the person's view and stays the AIs' job it already is: no second job is made for it.
  assert.deepEqual(shown('stuck'), []);
  assert.deepEqual(toAis.filter(row => row.section.id === 'stuck').map(row => [row.card.id, row.handOff]), [['work:h_2', null], ['work:h_1', null]]);
  // A sign-in goes to the AIs with the saved logins first, never to the person until they were stopped; a service
  // connected by any account never shows.
  assert.deepEqual(shown('sign-in'), []);
  assert.ok(toAis.find(row => row.section.id === 'sign-in').handOff.input.weighed.first_try === 'sign-in-with-a-saved-login');
  // Only the person can turn on notifications on their own Mac.
  assert.equal(shown('turn-on-notices').length, 1);
  // A published post is never a draft to approve; the same draft twice shows once.
  assert.deepEqual(shown('approve').map(card => card.title), ['A new article']);
  assert.equal(answer.sections.find(section => section.id === 'approve').total, 1);
});

test('consent the person gave once sends their drafts to the AIs to publish, never back to them', async () => {
  const { shown, toAis } = await read(answers, { approve: 'saved-instruction:consent-publish-my-posts' });
  assert.deepEqual(shown('approve'), []);
  const draft = toAis.find(row => row.section.id === 'approve');
  assert.equal(draft.handOff.input.weighed.who, 'trillion');
  assert.equal(draft.handOff.input.weighed.given_in, 'saved-instruction:consent-publish-my-posts');
  // A test draft ("Do not publish") is never posted: the AIs are told to delete it instead.
  assert.match(draft.handOff.job, /never publish it/);
  assert.match(draft.handOff.job, /delete the draft/);
});

test('a card an AI filed is weighed on its own needs and reason before its section\'s step', () => {
  const section = settings.sections.find(row => row.id === 'approve');
  assert.deepEqual(stepOf({ needs: 'write a summary' }, section, { approve: 'x' }), { needs: ['write a summary'], reason: null, past: [], given_in: null });
  assert.equal(stepOf({ reason_id: 'their-own-body', tried_doer: 'd' }, section).reason, 'their-own-body');
  assert.equal(stepOf({}, section, { approve: 'x' }).given_in, 'x');
});

test('one order across sections: what holds up the most first, then the newest', () => {
  const order = oneOrder([
    { id: 'a', cards: [{ id: 'a:old', at: '2026-10-01T00:00:00Z' }, { id: 'a:new', at: '2026-10-11T00:00:00Z' }] },
    { id: 'b', cards: [{ id: 'b:blocks', at: '2026-10-02T00:00:00Z', unlocks: ['x', 'y'] }] },
    { id: 'c', on_home: false, cards: [{ id: 'c:off', at: '2026-10-12T00:00:00Z' }] },
  ]);
  assert.deepEqual(order.map(row => row.card), ['b:blocks', 'a:new', 'a:old']);
  // What goes to the AIs is handed in the same order.
  const handed = inOrder([{ card: { id: 'old', at: '2026-10-01T00:00:00Z' } }, { card: { id: 'new', at: '2026-10-11T00:00:00Z' } }, { card: { id: 'blocks', at: '2026-10-02T00:00:00Z', unlocks: ['x'] } }]);
  assert.deepEqual(handed.map(row => row.card.id), ['blocks', 'new', 'old']);
});
