// Old trillion's test/needs-you-hold.test.mjs (tag old-trillion-before-worker-retire), the tests whose subject moved
// here with the needs-you-hold route: old src/waiting-nudge.mjs and src/waiting-weigh.mjs (read-data/, byte copies
// with their import paths changed) and old src/native-waiting-account-owner.mjs's held fact and device runs (the
// route, do-work/needs-you-hold-route.mjs). Assertions unchanged except where named:
//   - the doer gate is tools/who-does-each-step's whoDoesEachStep over the old DATA (tools/shared-code/src/who-does-it.json),
//     where old trillion's src/who-does-it.mjs read that same DATA itself;
//   - 'the held fact and its devices ...' runs on the route over the person's own records instead of the old person
//     store: its device runs are started through the run's door (`runs`), keyed `native-hold-devices:` as old
//     src/native-waiting-account-owner.mjs keyed them (the person store this old test drove keyed them `hold-devices:`).
// Not here: 'startup hold reads current ranked cards without waiting for voice clip enrichment' (voices and their
// Namespace clip searches are not records; see README.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseStake, stakeJob, withoutHanded } from '../read-data/needs-you-hold.mjs';
import { makeWaitingNudge } from '../read-data/waiting-nudge.mjs';
import { whoDoesEachStep as whoDoes } from '../../who-does-each-step/read-data/who-does.mjs';
import whoData from '../../shared-code/src/who-does-it.json' with { type: 'json' };
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json' with { type: 'json' };
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const whoDoesEachStep = input => whoDoes({ ...whoData, ...input });
const hold = { ...settings.hold, default_on: true };
const MINUTE = 60_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = minutes => new Date(NOW - minutes * MINUTE).toISOString();

test('AI-doable waiting cards are handed back and removed before the hold picks the next human item', async () => {
  const phrase = whoData.doers.find(row => !row.spends && !row.reaches_others)?.does[0];
  assert.ok(phrase, 'the shared doer table has a free doer');
  assert.equal(whoDoesEachStep({ steps: [{ id: 'ai', words: phrase, needs: [phrase] }] }).steps[0].who, 'trillion');
  const handed = [];
  const answer = { sections: [{ id: 'asks', title: 'Your AIs need you to', cards: [
    { id: 'asks:ai', title: 'An AI-doable job', needs: phrase, at: ago(60) },
    { id: 'asks:human', title: 'A human-only job', needs: 'sign in to a bank', only_you_because: 'The bank needs their sign-in', at: ago(60) },
  ] }] };
  const nudge = makeWaitingNudge({ read: async () => answer, tell: async () => null,
    weigh: input => whoDoesEachStep(input), handOff: async job => { handed.push(job); },
    kept: { read: () => null, write: () => {} }, alongside: async () => null, settings, now: () => NOW });
  const prepared = await nudge.prepareForHold(answer, hold.after_minutes);
  assert.deepEqual(prepared.handed, ['asks:ai']);
  assert.equal(handed.length, 1);
  const after = withoutHanded(answer, prepared.handed);
  assert.deepEqual(after.sections[0].cards.map(card => card.id), ['asks:human']);
});

test('walking away carries out the stake: the walked-away rung hands its job to the AIs once a day', async () => {
  const state = chooseStake({}, hold, { stake: 'tell-someone', values: { who: 'Morgan', how: 'morgan@example.com' } }, NOW).state;
  assert.equal(stakeJob({}, hold, NOW), null, 'a delay-only stake carries nothing');
  const handed = [];
  let kept = null;
  const old = { sections: [{ id: 'asks', title: 'Your AIs need you to', cards: [{ id: 'asks:x', title: 'Pay the invoice', at: new Date(NOW - 3000 * MINUTE).toISOString() }] }] };
  const nudge = makeWaitingNudge({
    read: async () => old, tell: async notice => notice, handOff: async job => { handed.push(job); return job; },
    walkedAway: named => stakeJob(state, hold, NOW, named), kept: { read: () => kept, write: value => { kept = value; } },
    alongside: async () => null, settings, now: () => NOW,
  });
  const ran = await nudge.runDue();
  assert.equal(ran.rung, 'walked-away');
  assert.equal(handed.length, 1);
  assert.match(handed[0].job, /Tell Morgan/);
  assert.match(handed[0].job, /Pay the invoice/);
  assert.equal(handed[0].once_per, 'hold-walked-away:2026-10-06');
});

test('the held fact and its devices name the person\'s own card, not one the AIs take', async () => {
  const ROUTE = rowOf(JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')), 'tool:answer-the-needs-you-hold-route');
  const row = (id, values) => ({ id: `record:waiting-on-you:${id}`, type: 'record:waiting-on-you', value: values });
  const records = [{ id: 'setting:needs_you_hold_rules', type: 'setting', value: { value: hold } },
    row('print', { what: 'Print the shelf cards', needs: 'print labels', added: ago(600), status: 'Open' }),
    row('mom', { what: 'Reply to Mom', needs: 'write', only_you_because: 'their-own-relationship', added: ago(600), status: 'Open' })];
  const run = await answerOf(ROUTE, { path: '/needs-you-hold', method: 'GET', query: {}, body: {}, browser: {} }, { records });
  assert.equal(run.result.status, 200, JSON.stringify(run.result.body));
  const held = run.kept.find(record => record.id === 'setting:needs_you_held').value.value;
  assert.equal(held.title, 'Reply to Mom', 'the held fact names the card the person is shown');
  const runs = run.runs.map(item => ({ tool_id: item.tool, input: item.input, request_key: item.key }));
  assert.ok(runs.length && runs.every(item => !String(item.request_key).includes('print')), 'no device run starts for the AI card');
  for (const device of hold.devices.when_held) {
    assert.ok(runs.some(item => item.tool_id === device.tool_id && String(item.request_key).startsWith(`native-hold-devices:${device.tool_id}:${held.key}:`)), `${device.tool_id} runs for the person's card`);
  }
  const reach = runs.find(item => item.tool_id === 'tool:take-me-there');
  assert.equal(reach.input.thing, held.key);
  assert.equal(reach.input.key, `hold:${held.key}`);
  assert.equal(reach.input.say.title, 'Reply to Mom');
});
