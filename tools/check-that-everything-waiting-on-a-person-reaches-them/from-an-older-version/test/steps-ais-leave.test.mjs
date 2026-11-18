// What any AI leaves the person to do reaches them (src/steps-ais-leave.mjs): the last AI message of each turn in every
// app is asked of the classifier on the person's own computer, each yes is handed to their AIs once to run
// workflow:file-what-needs-the-person, a message in the middle of a turn or one still being written is never asked,
// and when no computer answers nothing is guessed, the place waits and one more run is named for that turn end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { turnEnds, nextTry, weighStepsAisLeft, stepsAisLeaveSettings as settings } from '../src/steps-ais-leave.mjs';

const NOW = Date.parse('2026-10-07T06:00:00.000Z');
const minutesAgo = minutes => new Date(NOW - minutes * 60_000).toISOString();
const message = (id, app, conversation_id, speaker, minutes, text = '') => ({ id, app, conversation_id, speaker, recorded_at: minutesAgo(minutes), text });

// A store of messages answering the field reads the weigher uses (fields.after over recorded_at, oldest first).
function storeOf(messages) {
  return {
    fields: { after: (type, field, after, names, { limit }) => {
      assert.equal(type, 'message');
      assert.equal(field, 'recorded_at');
      return messages.filter(row => row.recorded_at > after).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at)).slice(0, limit)
        .map(row => ({ id: row.id, recorded_at: row.recorded_at, ...Object.fromEntries(names.map(name => [name, row[name]])) }));
    } },
    // Like the store, a read answers the record's value, which does not hold its own id.
    readMessage: id => valueOf(messages.find(row => row.id === id)),
  };
}
function valueOf(row) {
  if (!row) return null;
  const { id, ...value } = row;
  return value;
}

const conversation = [
  message('m1', 'Codex', 'c1', 'person', 50, 'Make the hold usable.'),
  message('m2', 'Codex', 'c1', 'ai', 49, 'Reading the hold cover now.'),
  message('m3', 'Codex', 'c1', 'ai', 40, 'Done. One switch is left: go to /connections and press "Let my AIs read all my logins". Only you can.'),
  message('m4', 'Codex', 'c1', 'person', 30, 'ok'),
  message('m5', 'ChatGPT', 'g1', 'ai', 20, 'I opened the page and it loads in 1.2 s.'),
  message('m6', 'Codex', 'c1', 'ai', 10, 'The hold card is full width now; nothing is left for you.'),
  message('m7', 'Claude Code', 'k1', 'ai', 1, 'Still building, sign in to Stripe when I ask.'),
];

test('a turn ends where the next message in its conversation is not an AI\'s, or after the quiet time; a fresh one waits', () => {
  const { ends, open } = turnEnds(conversation, { now: NOW, quietMs: settings.quiet_minutes * 60_000, aiSpeakers: settings.ai_speakers });
  assert.deepEqual(ends.map(index => conversation[index].id), ['m3', 'm5', 'm6'], 'the middle of a turn (m2) is never asked; every app is read');
  assert.equal(conversation[open].id, 'm7', 'a message written a minute ago may still be followed by more of the same turn');
});

test('each turn end leaving a step goes to the person\'s AIs once, a report goes nowhere, and the place stops before what still waits', async () => {
  const store = storeOf(conversation);
  const asked = [];
  const handed = [];
  let kept = null;
  const io = {
    ...store,
    ask: async input => { asked.push(input.state); return /press|sign in|only you/i.test(input.state) ? 0.92 : 0.04; },
    handOff: job => { handed.push(job); return { handoff_id: `h_${handed.length}` }; },
    kept: { through: minutesAgo(60) },
    keep: value => { kept = value; },
    now: () => NOW,
  };
  const run = await weighStepsAisLeft(io);
  assert.deepEqual(run.weighed.map(item => [item.message_id, item.verdict]), [['m3', 'leaves-a-step'], ['m5', 'nothing'], ['m6', 'nothing']]);
  assert.equal(asked.length, 3);
  assert.ok(asked[0].includes('Codex') && asked[0].includes('/connections'), 'the classifier reads the app and the words');
  assert.equal(handed.length, 1);
  assert.equal(handed[0].once_per, 'steps-ais-leave:m3', 'one message is one job however often it is weighed');
  assert.equal(handed[0].priority, settings.hand.priority, 'a reply ask reaches the worker ahead of routine background work');
  assert.ok(handed[0].job.includes(`purpose "${settings.hand.purpose}"`) && handed[0].job.includes('Let my AIs read all my logins'));
  assert.deepEqual(handed[0].input.said_by_ai, { message_id: 'm3', app: 'Codex', conversation_id: 'c1' });
  assert.equal(run.weighed[0].handoff_id, 'h_1');
  assert.equal(kept.through, conversation[5].recorded_at, 'the place stops before the message still being written');
  assert.match(run.said, /3 turn ends weighed: 1 left you/);
  const quiet = new Date(Date.parse(conversation[6].recorded_at) + settings.quiet_minutes * 60_000).toISOString();
  assert.deepEqual(run.again, { at: quiet, key: `steps-ais-leave-again:m7:${quiet}` }, 'the open turn end names the one run that decides it, at its quiet time');

  // The next run reads from that place: nothing is asked twice, and the fresh message is weighed once it is quiet.
  const later = await weighStepsAisLeft({ ...io, kept, keep: value => { kept = value; }, now: () => NOW + 5 * 60_000 });
  assert.deepEqual(later.weighed.map(item => item.message_id), ['m7']);
  assert.equal(handed.length, 2);
  assert.equal(handed[1].once_per, 'steps-ais-leave:m7');
  assert.equal(later.again, null, 'nothing left open: no run is asked for');
});

test('when no computer answers nothing is guessed: nothing is handed and the place waits before the first turn end', async () => {
  const handed = [];
  let kept = null;
  const run = await weighStepsAisLeft({
    ...storeOf(conversation), ask: async () => null, handOff: job => { handed.push(job); return { handoff_id: 'h' }; },
    kept: { through: minutesAgo(60) }, keep: value => { kept = value; }, now: () => NOW,
  });
  assert.deepEqual(run.weighed, []);
  assert.equal(handed.length, 0);
  assert.equal(kept.through, conversation[1].recorded_at, 'm3 is asked again next run');
  assert.match(run.said, /classifier on your computer/);
  // One more run is named for that turn end at the next try on its ladder, counted from m3's own time (40 minutes ago:
  // tries at 5, 15, 35 and 75 minutes after it), so the next one is 35 minutes from now; every later AI message starts a
  // run too.
  const next = new Date(Date.parse(conversation[2].recorded_at) + 75 * 60_000).toISOString();
  assert.deepEqual(run.again, { at: next, key: `steps-ais-leave-retry:m3:${next}` });
});

test('a first run looks back only as far as its DATA says, and a run weighs at most most_per_run turn ends', async () => {
  const many = Array.from({ length: settings.most_per_run + 3 }, (_, n) => message(`q${n}`, 'Muse', `t${n}`, 'ai', 30 - n, `Please approve item ${n}.`));
  const old = message('old', 'Codex', 'z', 'ai', settings.first_look_minutes + 5, 'Press the old switch.');
  let kept = null;
  const run = await weighStepsAisLeft({
    ...storeOf([old, ...many]), ask: async () => 0.9, handOff: job => ({ handoff_id: job.once_per }), kept: null, keep: value => { kept = value; }, now: () => NOW,
  });
  assert.equal(run.weighed.length, settings.most_per_run);
  assert.ok(!run.weighed.some(item => item.message_id === 'old'), 'history before the first look is never weighed');
  assert.equal(kept.through, many[settings.most_per_run - 1].recorded_at, 'the rest are weighed next run');
  assert.deepEqual(run.again, { at: new Date(NOW).toISOString(), key: `steps-ais-leave-again:q${settings.most_per_run}:${new Date(NOW).toISOString()}` }, 'and that run starts at once');
});

test('a completed reply is weighed immediately by its message id even while the older sweep is behind', async () => {
  const fresh = { ...message('fresh', 'Codex', 'fresh-chat', 'ai', 0, 'Sam, choose plum or teal for KITE-0930.'), final_reply: true };
  const handed = [];
  const io = {
    fields: { after: () => assert.fail('the historical cursor must not gate a completed reply') },
    readMessage: id => (id === fresh.id ? valueOf(fresh) : null),
    ask: async () => 0.95,
    handOff: job => { handed.push(job); return { handoff_id: 'h_fresh' }; },
    kept: { through: minutesAgo(90) },
    keep: () => assert.fail('a direct reply the computer answers writes nothing and must not move the historical cursor'),
    now: () => NOW,
    messageId: fresh.id,
  };
  const weighedFirst = await weighStepsAisLeft(io);
  const replay = await weighStepsAisLeft(io);
  assert.deepEqual(weighedFirst.weighed.map(item => [item.message_id, item.handoff_id]), [['fresh', 'h_fresh']]);
  assert.equal(weighedFirst.through, minutesAgo(90));
  assert.deepEqual(handed.map(job => job.once_per), ['steps-ais-leave:fresh', 'steps-ais-leave:fresh'], 'the handoff owner dedupes both direct replay and the later sweep');
  assert.deepEqual(replay.weighed, weighedFirst.weighed);
  let held = null;
  const unavailable = await weighStepsAisLeft({ ...io, ask: async () => null, handOff: () => assert.fail('no classifier answer cannot hand off'), keep: value => { held = value; } });
  const first = new Date(Date.parse(fresh.recorded_at) + settings.classify.retry.first_after_seconds * 1000).toISOString();
  assert.deepEqual(unavailable.again, { at: first, key: `steps-ais-leave-retry:fresh:${first}`, message_id: 'fresh' });
  assert.equal(held.through, minutesAgo(90), 'waiting never moves the historical cursor');
  assert.deepEqual(held.waiting, [{ id: 'fresh', recorded_at: fresh.recorded_at }]);
  assert.equal(held.silent_until, first);
  assert.match(unavailable.said, /waits until the classifier on your computer answers/, 'a waiting reply never says it was weighed');
  const progress = await weighStepsAisLeft({ ...io, readMessage: () => ({ ...valueOf(fresh), final_reply: false }), handOff: () => assert.fail('progress is not a completed reply') });
  assert.deepEqual(progress.weighed, []);
});

test('the weigher runs for a completed AI reply, never for progress or on a clock', () => {
  const { every_account: rows } = JSON.parse(readFileSync(new URL('../../../starting-set/starting-rules.json', import.meta.url), 'utf8'));
  const row = rows.find(item => item.then?.tool_id === 'tool:weigh-steps-ais-left-you');
  assert.ok(row && !row.every && !row.schedule_id, 'a schedule would keep a run every few minutes in every store, AI or not');
  assert.equal(row.when.recorded, 'message');
  assert.deepEqual(row.when.where, [{ field: 'speaker', one_of: settings.ai_speakers }, { field: 'final_reply', equals: true }]);
  assert.deepEqual(row.then.input, { message_id: { fill: { from: 'record', field: 'id' } } }, 'the completed reply goes straight to its own classifier run');
});

test('the sweep weighs every app\'s turn ends but never a completed reply, which its own run weighed', async () => {
  const thread = [
    message('p1', 'Claude Code', 'k1', 'person', 30, 'Fix the sound.'),
    { ...message('r1', 'Claude Code', 'k1', 'ai', 20, 'Paste this into Terminal; only you can.'), final_reply: true },
    message('p2', 'Codex', 'c9', 'person', 30, 'Ship it.'),
    message('r2', 'Codex', 'c9', 'ai', 20, 'Shipped. Sign in to Stripe so I can turn on payouts; only you can.'),
  ];
  const asked = [];
  let kept = null;
  const run = await weighStepsAisLeft({
    ...storeOf(thread), ask: async input => { asked.push(input.state); return 0.9; }, handOff: job => ({ handoff_id: job.once_per }),
    kept: { through: minutesAgo(60) }, keep: value => { kept = value; }, now: () => NOW,
  });
  assert.deepEqual(run.weighed.map(item => item.message_id), ['r2'], 'the Codex turn end is weighed; the completed reply is not asked twice');
  assert.equal(asked.length, 1);
  assert.equal(run.read, 4);
  assert.equal(kept.through, thread[3].recorded_at, 'the place moves past both');
});

test('a turn end the computer does not answer is tried on one ladder: every run until a try names that same run, and after it the next', async () => {
  const from = Date.parse('2026-10-07T00:00:00.000Z');
  const { first_after_seconds: first, factor, longest_after_seconds: longest } = settings.classify.retry;
  // The tries: 5, 10, 20, 40 minutes apart, then never more than an hour apart.
  const tries = [];
  for (let at = from, n = 0; n < 8; n += 1) { at = nextTry(from, at); tries.push((at - from) / 60_000); }
  assert.deepEqual(tries, [5, 15, 35, 75, 135, 195, 255, 315]);
  assert.ok(first === 300 && factor === 2 && longest === 3600, 'the ladder in the test is the ladder in the DATA');
  assert.equal(nextTry(from, from + 6 * 60_000), nextTry(from, from + 14 * 60_000), 'two runs between the same tries name one time');

  // A reply the computer does not answer: two runs inside one window name exactly the same run (the Workshop returns it,
  // never refuses it), and the run that try starts names the next one.
  const reply = { ...message('r1', 'Claude Code', 'k9', 'ai', 0, 'Sign in to Stripe; only you can.'), final_reply: true };
  const io = at => ({ fields: { after: () => [] }, readMessage: id => (id === 'r1' ? valueOf(reply) : null), ask: async () => null,
    handOff: () => assert.fail('nothing is handed without an answer'), kept: null, keep: () => {}, now: () => NOW + at * 60_000, messageId: 'r1' });
  const a = await weighStepsAisLeft(io(1));
  const b = await weighStepsAisLeft(io(3));
  assert.deepEqual(a.again, b.again, 'runs before the first try name the one first try');
  const atFirst = await weighStepsAisLeft(io(5));
  assert.equal(atFirst.again.at, new Date(NOW + 15 * 60_000).toISOString(), 'the run that try starts names the next try, so the computer is asked until it answers');
  assert.notEqual(atFirst.again.key, a.again.key);

  // The sweep names its waiting turn end the same way.
  const swept = storeOf([message('s1', 'Codex', 'x', 'person', 12), message('s2', 'Codex', 'x', 'ai', 11, 'Press the switch.'), message('s3', 'Codex', 'x', 'person', 10)]);
  const run = at => weighStepsAisLeft({ ...swept, ask: async () => null, handOff: () => assert.fail('no answer, no job'), kept: { through: minutesAgo(30) }, keep: () => {}, now: () => NOW + at * 60_000 });
  assert.deepEqual((await run(0)).again, (await run(2)).again, 'two sweeps before the try name one run');
});

test('what attention keeps as context (brought-in history) is decided without asking the computer and never handed on', async () => {
  const old = (id, speaker, text, at) => ({ id, app: 'ChatGPT', conversation_id: 'old', speaker, text, at, recorded_at: minutesAgo(10) });
  const brought = [old('o1', 'person', 'Help me set up the account.', '2023-04-17T09:00:00.000Z'), old('o2', 'ai', 'Done. Press Connect on the settings page; only you can.', '2023-04-17T09:01:00.000Z'),
    old('o3', 'person', 'thanks', '2023-04-17T09:02:00.000Z')];
  const live = message('l2', 'Claude Code', 'live', 'ai', 8, 'Sign in to Stripe so I can turn payouts on; only you can.');
  const after = message('l3', 'Claude Code', 'live', 'person', 7, 'ok');
  const store = storeOf([...brought, live, after]);
  const asked = [];
  const handed = [];
  const seen = [];
  let kept = null;
  const run = await weighStepsAisLeft({
    ...store,
    attention: async row => { seen.push(row.id); return { opens: !(Date.parse(row.recorded_at) - Date.parse(row.at) >= 24 * 60 * 60_000), rule: null }; },
    ask: async input => { asked.push(input.state); return 0.95; },
    handOff: job => { handed.push(job.once_per); return { handoff_id: job.once_per }; },
    kept: { through: minutesAgo(30) }, keep: value => { kept = value; }, now: () => NOW,
  });
  assert.deepEqual(seen, ['o2', 'l2'], 'attention is asked about every turn end, with the times the sweep read');
  assert.equal(asked.length, 1, 'the brought-in turn end is never asked of the computer');
  assert.deepEqual(handed, ['steps-ais-leave:l2'], 'only the live step is handed on');
  assert.deepEqual(run.weighed.map(item => item.message_id), ['l2']);
  assert.equal(kept.through, after.recorded_at, 'the place moves past the history, which is decided');
});

test('a sweep that finds nothing new keeps nothing: the place is written only when it moves or a turn is weighed', async () => {
  let kept = null;
  const io = { ...storeOf(conversation), ask: async () => 0.04, handOff: () => ({ handoff_id: 'h' }), kept: { through: minutesAgo(60) }, keep: value => { kept = value; }, now: () => NOW };
  await weighStepsAisLeft(io);
  assert.equal(kept.through, conversation[5].recorded_at);
  // Every AI reply wakes one more sweep; with nothing new since (m7 still being written) it must not rewrite the place.
  const again = await weighStepsAisLeft({ ...io, kept, keep: () => assert.fail('an unchanged place is not written again'), now: () => NOW + 30_000 });
  assert.deepEqual(again.weighed, []);
  assert.ok(again.again, 'the open turn end still names its one run');
});

test('replies the computer does not answer wait together under one retry run, and the computer is asked once a try, not once a reply', async () => {
  const replies = Array.from({ length: 9 }, (_, n) => ({ ...message(`w${n}`, 'Codex', `chat${n}`, 'ai', 9 - n, `Please approve change ${n}; only you can.`), final_reply: true }));
  let kept = null;
  let asks = 0;
  let answering = false;
  const handed = [];
  const run = (id, at) => weighStepsAisLeft({
    fields: { after: () => [] }, readMessage: key => valueOf(replies.find(row => row.id === key)), messageId: id,
    ask: async () => { asks += 1; return answering ? 0.9 : null; }, handOff: job => { handed.push(job.once_per); return { handoff_id: job.once_per }; },
    kept, keptNow: () => kept, keep: value => { kept = value; }, now: () => NOW + at * 60_000,
  });

  // Nobody answers: the first reply asks once and sets the try; the rest join it without asking, under the same one run.
  const firstRun = await run('w0', 0);
  const names = [firstRun.again];
  for (const [n, row] of replies.slice(1).entries()) names.push((await run(row.id, (n + 1) / 10)).again);
  assert.equal(asks, 1, 'one ask for nine replies');
  assert.equal(new Set(names.map(name => name.key)).size, 1, 'one retry run, however many replies wait');
  assert.deepEqual(kept.waiting.map(item => item.id), replies.map(row => row.id), 'oldest first');
  assert.equal(kept.silent_until, names[0].at);
  assert.equal(names[0].message_id, 'w0');

  // The try comes and the computer answers: the run weighs up to most_per_run of them and names the next run at once.
  answering = true;
  const tryAt = (Date.parse(kept.silent_until) - NOW) / 60_000;
  const drain = await run('w0', tryAt);
  assert.equal(drain.weighed.length, settings.most_per_run);
  assert.equal(kept.waiting.length, replies.length - settings.most_per_run, 'what is left still waits');
  assert.equal(kept.silent_until, null);
  assert.equal(drain.again.at, new Date(NOW + tryAt * 60_000).toISOString());
  assert.equal(drain.again.message_id, kept.waiting[0].id);
  const rest = await run(kept.waiting[0].id, tryAt);
  assert.equal(rest.weighed.length, replies.length - settings.most_per_run);
  assert.deepEqual(kept.waiting, []);
  assert.equal(rest.again, null);
  assert.deepEqual(handed, replies.map(row => `steps-ais-leave:${row.id}`));
});

test('a sweep does not ask a computer that stayed silent before its next try, and keeps the replies waiting', async () => {
  const waiting = [{ id: 'r0', recorded_at: minutesAgo(30) }];
  const until = new Date(NOW + 40 * 60_000).toISOString();
  let kept = { through: minutesAgo(60), waiting, silent_until: until };
  const run = at => weighStepsAisLeft({
    ...storeOf(conversation), ask: async () => assert.fail('the computer was silent at its last try'), handOff: () => assert.fail('nothing is handed'),
    kept, keptNow: () => kept, keep: value => { kept = value; }, now: () => NOW + at * 60_000,
  });
  const quiet = await run(0);
  assert.deepEqual(quiet.weighed, []);
  assert.deepEqual(kept.waiting, waiting, 'the replies waiting are kept as they were');
  assert.equal(quiet.again.at, until, 'no run is named before the try');
});
