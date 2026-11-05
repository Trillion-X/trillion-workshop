// Old trillion's test/needs-you-hold.test.mjs (tag old-trillion-before-worker-retire), the tests whose subject is in this
// folder: read-data/needs-you-hold.mjs over the shipped Waiting on you DATA (src/waiting-on-you.json, the same bytes
// in tools/keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json). Their assertions are unchanged; only
// the import paths differ. The old file's other tests have their subject elsewhere and run with it:
//   - 'startup hold reads current ranked cards without waiting for voice clip enrichment': old
//     src/native-waiting-account-owner.mjs's whole Waiting on you read and its voice clips, which are not records;
//   - 'the held fact and its devices name the person's own card, not one the AIs take', 'AI-doable waiting cards are
//     handed back ...' and 'walking away carries out the stake ...': test/needs-you-hold-nudge-old.test.mjs;
//   - 'the held thing reaches a chat by Trillion itself ...': harness/decisions-since.mjs, the AI session harness;
//   - 'the setup gate reads Get started through readJson ...': the page (trillion-apps web);
//   - 'the held thing seen on an open page is read there ...' and 'a tap on the phone's notice is where the held thing
//     was seen ...': carried onto the route in test/needs-you-hold-route.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { askOff, chooseStake, handBack, heldThing, holdView, isOn, setAside, stakeNow, turnOn } from '../read-data/needs-you-hold.mjs';
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json' with { type: 'json' };

// The hold's behaviour while it is on, whatever the shipped DATA defaults to (waiting-on-you.json `hold.default_on`).
const hold = { ...settings.hold, default_on: true };
const MINUTE = 60_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = minutes => new Date(NOW - minutes * MINUTE).toISOString();
const voiceSection = settings.sections.find(section => section.id === 'voices');
const voices = { ...voiceSection, total: 52, cards: [{ id: 'voices:a', title: 'Someone (voice-1)', clip: '/a.mp3', at: ago(600) }, { id: 'voices:b', title: 'Someone (voice-2)', clip: '/b.mp3', at: ago(600) }] };
// Batch behavior is a generic DATA option, independent of the shipped per-row voice naming flow.
const reviewBatch = {
  id: 'review-fixture', title: 'Recordings to review', total: 52,
  batch: { title: 'Review these recordings', detail: 'Playable recordings ready to review: {count}', requires: 'recording' },
  cards: [{ id: 'review-fixture:a', title: 'First recording', recording: '/a.mp3', at: ago(600) },
    { id: 'review-fixture:b', title: 'Second recording', recording: '/b.mp3', at: ago(600) }],
};
const asks = { id: 'asks', title: 'Your AIs need you to', cards: [{ id: 'asks:sign', title: 'Sign in to the bank', at: ago(600) }, { id: 'asks:pay', title: 'Pay the invoice', at: ago(600) }] };
const look = { id: 'look', title: 'New things to look at', hold: false, cards: [{ id: 'made:a', title: 'A new video', at: ago(600) }] };
const answer = { sections: [look, voices, asks], finishes: settings.finishes };


test('the shipped DATA names voices one row at a time and says which sections never hold', () => {
  assert.equal(voiceSection.batch, undefined, 'voice naming is a per-row flow');
  assert.equal(voiceSection.form.title, 'Name this voice');
  assert.equal(voiceSection.form.submit, 'Name');
  assert.equal(settings.sections.find(section => section.id === 'look').hold, false);
  assert.ok(settings.carried.includes('hold'));
});

test('the hold shows one voice row with its own identity and recording', () => {
  const held = heldThing(answer, {}, hold, NOW);
  assert.equal(held.key, 'voices:a');
  assert.deepEqual(held.card, voices.cards[0]);
  assert.equal(held.card.batch, undefined);
  assert.equal(held.section.form, voiceSection.form);
});

test('an explicitly batched section holds as one thing with every eligible card', () => {
  const held = heldThing({ sections: [look, reviewBatch, asks], finishes: settings.finishes }, {}, hold, NOW);
  assert.equal(held.key, 'batch:review-fixture');
  assert.equal(held.card.batch.length, 2);
  assert.deepEqual(held.card.batch.map(card => card.id), ['review-fixture:a', 'review-fixture:b']);
  assert.match(held.card.detail, /^Playable recordings ready to review: 2/);
  assert.equal(held.card.title, reviewBatch.batch.title);
  const noRequirement = { ...reviewBatch, batch: { title: 'Review all these rows' },
    cards: reviewBatch.cards.map(card => ({ ...card, recording: undefined })) };
  assert.deepEqual(heldThing({ sections: [noRequirement] }, {}, hold, NOW).card.batch.map(card => card.id),
    ['review-fixture:a', 'review-fixture:b'], 'a batch without requires retains rows without a recording');
});

test('a synthetic batch only holds rows carrying its declared required field', () => {
  const mixed = { ...reviewBatch, cards: [{ ...reviewBatch.cards[0], recording: undefined }, reviewBatch.cards[1]] };
  const held = heldThing({ sections: [mixed, asks], finishes: settings.finishes }, {}, hold, NOW);
  assert.equal(held.key, 'batch:review-fixture');
  assert.deepEqual(held.card.batch.map(card => card.id), ['review-fixture:b']);
  assert.equal(held.card.count, 1);
  assert.equal(held.section.total, 1);
  assert.match(held.card.detail, /^Playable recordings ready to review: 1/);
  const unavailable = { ...reviewBatch, cards: reviewBatch.cards.map(card => ({ ...card, recording: undefined })) };
  assert.equal(heldThing({ sections: [unavailable, asks], finishes: settings.finishes }, {}, hold, NOW).key, 'asks:sign');
});

test('a thing that has not waited after_minutes does not hold the page yet', () => {
  const fresh = { sections: [{ ...asks, cards: [{ id: 'asks:new', title: 'New', at: ago(1) }] }] };
  assert.equal(heldThing(fresh, {}, hold, NOW), null);
});

test('a thing Trillion checks itself with nothing to do never holds the page; the next one does', () => {
  const checked = settings.finishes.find(finish => !finish.press);
  assert.ok(checked, 'the DATA has a finish with nothing to press');
  const camera = { id: 'asks', title: 'Your AIs need you to', finish: 'Tap done', cards: [{ id: 'asks:camera', title: 'Have your camera send each clip', finish: checked.choice, at: ago(600) }, { id: 'asks:yes', title: 'Say yes', at: ago(600) }] };
  assert.equal(heldThing({ sections: [camera], finishes: settings.finishes }, {}, hold, NOW).key, 'asks:yes');
  const only = { ...camera, cards: [camera.cards[0]] };
  assert.equal(heldThing({ sections: [only], finishes: settings.finishes }, {}, hold, NOW), null);
  assert.equal(heldThing({ sections: [{ ...only, finish: checked.choice, cards: [{ ...only.cards[0], finish: undefined }] }], finishes: settings.finishes }, {}, hold, NOW), null, 'the section finish counts too');
  // With its steps it is something the person does on the held screen, while Trillion checks the rest.
  const steps = { ...only, cards: [{ ...only.cards[0], detail: 'On the camera, press MENU and set:\n1. Network > FTP Function: On' }] };
  assert.equal(heldThing({ sections: [steps], finishes: settings.finishes }, {}, hold, NOW).key, 'asks:camera');
});

test('setting aside needs a reason in words, moves the hold to the next thing, and hands the reason to the AIs', () => {
  assert.throws(() => setAside({}, hold, { key: 'voices:a', title: voices.cards[0].title, reason: 'busy' }, NOW), /at least 4 words/);
  const { state, jobs, until } = setAside({}, hold, { key: 'voices:a', title: voices.cards[0].title, reason: 'I am driving right now' }, NOW);
  assert.equal(Date.parse(until), NOW + hold.aside.minutes * MINUTE);
  assert.equal(heldThing(answer, state, hold, NOW).key, 'voices:b', 'only the selected voice is set aside');
  assert.deepEqual(Object.keys(state.aside), ['voices:a']);
  assert.equal(jobs[0].input.thing, 'voices:a');
  assert.match(jobs[0].job, /I am driving right now/);
  assert.match(jobs[0].job, /Never just accept the reason/);
  assert.equal(heldThing(answer, state, hold, NOW + (hold.aside.minutes + 1) * MINUTE).key, 'voices:a', 'the selected voice comes back');
});

test('set-asides run out for the day, and a new day gives them back', () => {
  let state = {};
  for (let i = 0; i < hold.aside.most_per_day; i += 1) state = setAside(state, hold, { key: `k${i}`, title: 't', reason: 'one two three four' }, NOW).state;
  assert.throws(() => setAside(state, hold, { key: 'more', title: 't', reason: 'one two three four' }, NOW), /Nothing more can be set aside today/);
  assert.equal(holdView(answer, state, hold, NOW).asides_left, 0);
  assert.equal(holdView(answer, state, hold, NOW + 24 * 60 * MINUTE).asides_left, hold.aside.most_per_day);
});

test('a held thing whose part is done is handed back to the AIs even with no asides left, and leaves the hold', () => {
  let state = {};
  for (let i = 0; i < hold.aside.most_per_day; i += 1) state = setAside(state, hold, { key: `k${i}`, title: 't', reason: 'one two three four' }, NOW).state;
  assert.equal(holdView(answer, state, hold, NOW).asides_left, 0);
  const view = holdView(answer, state, hold, NOW);
  assert.deepEqual(view.hand_back.map(way => way.id), hold.hand_back.ways.map(way => way.id), 'the held screen offers every way');
  assert.ok(view.hand_back.every(way => way.label && way.title && way.submit && !('job' in way)), 'only what the person sees');
  assert.throws(() => handBack(state, hold, { key: 'voices:a', title: voices.cards[0].title, way: 'nope', reason: 'I did it already' }, NOW), /Choose one of the ways/);
  assert.throws(() => handBack(state, hold, { key: 'voices:a', title: voices.cards[0].title, way: 'done', reason: 'done' }, NOW), /at least 3 words/);
  const done = handBack(state, hold, { key: 'voices:a', title: voices.cards[0].title, way: 'done', reason: 'Named this voice on my phone' }, NOW);
  assert.equal(heldThing(answer, done.state, hold, NOW).key, 'voices:b', 'the next voice still needs its own answer');
  assert.deepEqual(Object.keys(done.state.handed_back), ['voices:a']);
  assert.equal(holdView(answer, done.state, hold, NOW).asides_left, 0, 'never counted against the asides');
  assert.equal(done.jobs.length, 1);
  assert.match(done.jobs[0].job, /Named this voice on my phone/);
  assert.ok(done.jobs[0].job.includes(voices.cards[0].title));
  assert.equal(done.jobs[0].input.thing, 'voices:a');
  assert.equal(done.jobs[0].once_per, 'hold-hand-back:voices:a', 'handed once per row');
  const second = handBack(done.state, hold, { key: 'voices:b', title: voices.cards[1].title, way: 'done', reason: 'Named the second voice too' }, NOW);
  assert.equal(heldThing(answer, second.state, hold, NOW).key, 'asks:sign');
  assert.equal(second.jobs[0].once_per, 'hold-hand-back:voices:b');
  assert.notEqual(second.jobs[0].once_per, done.jobs[0].once_per, 'each voice has its own handback identity');
  // A screen that does not work where the person is goes the same way, with its own job.
  const broken = handBack(second.state, hold, { key: 'asks:sign', title: 'Sign in to the bank', way: 'broken', reason: 'The button spins and nothing opens' }, NOW);
  assert.equal(heldThing(answer, broken.state, hold, NOW).key, 'asks:pay');
  assert.match(broken.jobs[0].job, /fix the cause/);
  assert.notEqual(broken.jobs[0].job, done.jobs[0].job);
  // After keep_days it may hold again, unless the AIs marked it done or filed a new row meanwhile.
  assert.equal(heldThing(answer, broken.state, hold, NOW + (hold.hand_back.keep_days * 1440 + 1) * MINUTE).key, 'voices:a');
});

test('off is never at once: it starts after the stake delay, comes back by itself, and asking again changes nothing', () => {
  const { state, at, until } = askOff({}, hold, NOW);
  const wait = hold.off.stakes.find(stake => stake.id === hold.off.default_stake).delay_minutes;
  assert.equal(Date.parse(at), NOW + wait * MINUTE);
  assert.equal(isOn(state, hold, NOW + 1), true, 'still held while the off waits');
  assert.equal(isOn(state, hold, Date.parse(at) + 1), false);
  assert.equal(isOn(state, hold, Date.parse(until) + 1), true, 'back by itself');
  assert.equal(askOff(state, hold, NOW + MINUTE).state, state);
  assert.equal(isOn(turnOn(state).state, hold, Date.parse(at) + 1), true, 'turning it on is at once');
});

test('each off within the week doubles the next wait', () => {
  let state = {};
  let now = NOW;
  const waits = [];
  for (let i = 0; i < 3; i += 1) {
    const off = askOff(state, hold, now);
    waits.push((Date.parse(off.at) - now) / MINUTE);
    state = off.state;
    now = Date.parse(off.until) + MINUTE;
  }
  assert.deepEqual(waits.map(wait => wait / waits[0]), [1, 2, 4]);
});

test('a stake asks for its fields, and a cheaper stake chosen now only counts after the one in force has run its delay', () => {
  assert.throws(() => chooseStake({}, hold, { stake: 'tell-someone', values: {} }, NOW), /needs/);
  const first = chooseStake({}, hold, { stake: 'tell-someone', values: { who: 'Morgan', how: 'morgan@example.com' } }, NOW).state;
  assert.equal(stakeNow(first, hold, NOW).id, 'tell-someone', 'the first choice counts at once');
  const lowered = chooseStake(first, hold, { stake: 'wait-an-hour' }, NOW).state;
  assert.equal(stakeNow(lowered, hold, NOW + MINUTE).id, 'tell-someone', 'not lowered in the moment');
  const off = askOff(lowered, hold, NOW + MINUTE);
  assert.match(off.jobs[0].job, /Tell Morgan at morgan@example.com/);
  assert.equal(stakeNow(lowered, hold, NOW + 61 * MINUTE).id, 'wait-an-hour');
});

test('the view carries the held section without its other cards, the finishes, and when it is read again', () => {
  const view = holdView(answer, {}, hold, NOW);
  assert.deepEqual(view.held.section.cards, []);
  assert.equal(view.held.section.id, 'voices');
  assert.ok(view.finishes.length);
  assert.equal(view.every_seconds, hold.every_seconds);
  assert.equal(holdView(answer, { on: false }, hold, NOW).held, null);
});

test('the most unblocking thing holds first: what others wait on, then what says what it unlocks, by the DATA\'s rank', () => {
  const camera = { id: 'asks:camera', source: 'asks', title: 'Set the camera to send clips', at: ago(600), waits_on: ['ai-read-saved-logins'], unlocks: 'Clips arrive by themselves' };
  const post = { id: 'asks:post', source: 'asks', title: 'Post the clip', at: ago(600), waits_on: 'camera' };
  const logins = { id: 'asks:ai-read-saved-logins', source: 'asks', title: 'Let your AIs read your saved logins', at: ago(60) };
  const ein = { id: 'asks:ein', source: 'asks', title: 'Paste the EIN', at: ago(900), unlocks: 'Payouts' };
  const ranked = { sections: [{ id: 'asks', title: 'Your AIs need you to', cards: [ein, camera, post, logins] }], finishes: settings.finishes };
  assert.equal(heldThing(ranked, {}, hold, NOW).key, 'asks:ai-read-saved-logins', 'two things wait on it, one through the other');
  const noLogins = { ...ranked, sections: [{ ...ranked.sections[0], cards: [ein, camera, post] }] };
  assert.equal(heldThing(noLogins, {}, hold, NOW).key, 'asks:camera', 'one thing waits on it');
  const none = { ...ranked, sections: [{ ...ranked.sections[0], cards: [{ ...post, waits_on: '' }, ein] }] };
  assert.equal(heldThing(none, {}, hold, NOW).key, 'asks:ein', 'then what says what it unlocks');
  assert.ok(hold.rank.every(rule => rule.by && rule.what), 'each rank rule is DATA with its reason');
});
