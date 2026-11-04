// Queued turns drain on a timer with no new speech, at the pace in DATA (sending.pass); a pass that never finishes is ended
// and recorded, and the next one goes (6,323 turns waited, one queued turn unsent, 2026-10-22).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { send, turnOutbox } from '../listen.mjs';

const rows = JSON.parse(readFileSync(new URL(import.meta.resolve('../../bring-in-new-items-from-this-computer/computer/computer-sources.json')), 'utf8'));
const listening = Object.values(rows).flat().find?.(row => row?.id === 'listening') ?? rows.sources?.find?.(row => row.id === 'listening');
const listen = listening?.listen;
const waitingTurn = n => ({ source_id: `m${n}#1`, conversation_id: `c${n}`, from: 'me', text: `turn ${n}`, verdict: 'context' });
const answers = taken => async (route, { body }) => ({ status: 200, body: { items: body.items.map(item => { taken.push(item.source_id); return { message_id: `message:${item.source_id}` }; }) } });
const folder = () => mkdtempSync(path.join(os.tmpdir(), 'listen-pass-'));
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const until = async (done, ms = 3000) => { const stop = Date.now() + ms; while (!done() && Date.now() < stop) await new Promise(r => setTimeout(r, 10)); };

test('the sender has a pace in DATA', () => {
  const pass = listen.sending.pass;
  assert.ok(pass.turns_per_pass > 0 && pass.gap_seconds > 0 && pass.deadline_seconds > pass.gap_seconds && pass.hold_file);
});

test('turns already waiting go on the timer, with no new speech and at most turns_per_pass a pass', async () => {
  const state = folder();
  try {
    const waiting = path.join(state, 'waiting.json');
    writeFileSync(waiting, JSON.stringify([1, 2, 3, 4, 5].map(waitingTurn)));
    const taken = [];
    const row = { ...listen, sending: { ...listen.sending, pass: { ...listen.sending.pass, turns_per_pass: 2 } } };
    const status = { sent: 0, left_out: 0, waiting: 0 };
    const outbox = turnOutbox({ file: path.join(state, 'turns-to-send.json'), waiting, retryMs: 20,
      deliver: (turns, onPersisted, signal) => send(turns, { listen: row, account: answers(taken), log: () => {}, status, waiting, onPersisted, signal }) });
    outbox.drain();
    await until(() => taken.length === 5);
    outbox.close();
    assert.deepEqual(taken, [1, 2, 3, 4, 5].map(n => `m${n}#1`));
    assert.deepEqual(read(waiting), []);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a pass takes no more than turns_per_pass of the waiting turns', async () => {
  const state = folder();
  try {
    const waiting = path.join(state, 'waiting.json');
    writeFileSync(waiting, JSON.stringify([1, 2, 3, 4, 5].map(waitingTurn)));
    const taken = [];
    const row = { ...listen, sending: { ...listen.sending, pass: { ...listen.sending.pass, turns_per_pass: 2 } } };
    assert.equal(await send([], { listen: row, account: answers(taken), log: () => {}, status: { sent: 0, left_out: 0, waiting: 0 }, waiting }), 2);
    assert.equal(read(waiting).length, 3);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('while the hold file is there only its most_turns of the waiting turns are ever sent, and a turn heard goes at once', async () => {
  const state = folder();
  try {
    const waiting = path.join(state, 'waiting.json');
    writeFileSync(waiting, JSON.stringify([1, 2, 3, 4].map(waitingTurn)));
    writeFileSync(path.join(state, listen.sending.pass.hold_file), JSON.stringify({ most_turns: 1 }));
    const taken = [];
    const status = { sent: 0, left_out: 0, waiting: 0 };
    const pass = (turns = []) => send(turns, { listen, account: answers(taken), log: () => {}, status, waiting });
    assert.equal(await pass(), 1, 'the first pass sends the one turn');
    assert.equal(await pass(), 0, 'later passes send none of the held backlog');
    assert.equal(read(path.join(state, 'pass-sent.json')).sent, 1);
    assert.equal(read(waiting).length, 3);
    rmSync(path.join(state, listen.sending.pass.hold_file));
    assert.equal(await pass(), 3, 'lifting the hold lets the rest go');
    assert.deepEqual(taken, [1, 2, 3, 4].map(n => `m${n}#1`));
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a missing per-turn receipt stays queued for idempotent retry instead of becoming a permanent refusal', async () => {
  const state = folder();
  try {
    const waiting = path.join(state, 'waiting.json');
    writeFileSync(waiting, JSON.stringify([waitingTurn(1), { ...waitingTurn(2), conversation_id: 'c1' }]));
    const taken = [];
    let partial = true;
    const account = async (route, { body }) => {
      taken.push(...body.items.map(item => item.source_id));
      return { status: 200, body: { items: partial
        ? [{ message_id: 'receipt:m1#1' }]
        : body.items.map(item => ({ message_id: `receipt:${item.source_id}` })) } };
    };
    const status = { sent: 0, left_out: 0, waiting: 0 };
    let clock = 1_800_000_000_000;
    const pass = () => send([], { listen, account, log: () => {}, status, waiting, now: () => clock, random: () => 0 });
    await assert.rejects(pass(), /did not confirm this turn/);
    assert.deepEqual(read(waiting).map(item => item.source_id), ['m2#1']);
    assert.equal(read(path.join(state, 'tries.json'))['m2#1'].tries, 1);
    assert.equal(existsSync(path.join(state, 'rejected.json')), false);
    assert.equal(status.sent, 1);

    partial = false;
    clock += 31_000;
    assert.equal(await pass(), 1);
    assert.deepEqual(read(waiting), []);
    assert.deepEqual(taken, ['m1#1', 'm2#1', 'm2#1'], 'the same source identity is replayed, never a new turn');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a bare whole-request 200 leaves every turn queued because it confirms no receipts', async () => {
  const state = folder();
  try {
    const waiting = path.join(state, 'waiting.json');
    writeFileSync(waiting, JSON.stringify([waitingTurn(1), { ...waitingTurn(2), conversation_id: 'c1' }]));
    const status = { sent: 0, left_out: 0, waiting: 0 };
    const account = async () => ({ status: 200, body: { ok: true } });
    const pass = () => send([], { listen, account, log: () => {}, status, waiting, now: () => 1_800_000_000_000, random: () => 0 });
    await assert.rejects(pass(), /did not confirm this turn/);
    assert.deepEqual(read(waiting).map(item => item.source_id), ['m1#1', 'm2#1']);
    assert.deepEqual(Object.keys(read(path.join(state, 'tries.json'))).sort(), ['m1#1', 'm2#1']);
    assert.equal(existsSync(path.join(state, 'rejected.json')), false);
    assert.equal(status.sent, 0);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('ambiguous or malformed per-turn receipts are uncertain, not accepted or permanently refused', async () => {
  for (const [label, receipt] of [
    ['message id and error', { message_id: 'maybe-kept', error: 'ambiguous' }],
    ['non-string message id', { message_id: 42 }],
    ['empty message id', { message_id: '' }],
  ]) {
    const state = folder();
    try {
      const waiting = path.join(state, 'waiting.json');
      writeFileSync(waiting, JSON.stringify([waitingTurn(1)]));
      const status = { sent: 0, left_out: 0, waiting: 0 };
      const account = async () => ({ status: 200, body: { items: [receipt] } });
      await assert.rejects(send([], { listen, account, log: () => {}, status, waiting, now: () => 1_800_000_000_000, random: () => 0 }), /did not confirm this turn/, label);
      assert.deepEqual(read(waiting).map(item => item.source_id), ['m1#1'], label);
      assert.equal(read(path.join(state, 'tries.json'))['m1#1'].tries, 1, label);
      assert.equal(existsSync(path.join(state, 'rejected.json')), false, label);
      assert.equal(status.sent, 0, label);
    } finally { rmSync(state, { recursive: true, force: true }); }
  }
});

test('the singleton receipt shape is accepted only when it names the exact source', async () => {
  const state = folder();
  try {
    const waiting = path.join(state, 'waiting.json');
    writeFileSync(waiting, JSON.stringify([waitingTurn(1)]));
    const status = { sent: 0, left_out: 0, waiting: 0 };
    let exact = false;
    const account = async () => ({ status: 200, body: { source_id: exact ? 'm1#1' : 'other#1', message_id: 'receipt:single' } });
    let clock = 1_800_000_000_000;
    const pass = () => send([], { listen, account, log: () => {}, status, waiting, now: () => clock, random: () => 0 });
    await assert.rejects(pass(), /did not confirm this turn/);
    assert.deepEqual(read(waiting).map(item => item.source_id), ['m1#1']);
    assert.equal(status.sent, 0);
    exact = true;
    clock += 31_000;
    assert.equal(await pass(), 1);
    assert.deepEqual(read(waiting), []);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a pass that never finishes is ended and recorded, and the next pass goes', async () => {
  const state = folder();
  try {
    const waiting = path.join(state, 'waiting.json');
    writeFileSync(waiting, JSON.stringify([waitingTurn(1)]));
    const taken = [];
    const notes = [];
    let passes = 0;
    let running = 0;
    let most = 0;
    const outbox = turnOutbox({ file: path.join(state, 'turns-to-send.json'), waiting, retryMs: 20, deadlineMs: 80, settled: reason => notes.push(reason), log: () => {},
      deliver: async (turns, onPersisted, signal) => {
        passes += 1;
        running += 1; most = Math.max(most, running);
        try {
          if (passes === 1) { await new Promise(() => {}); }
          return await send(turns, { listen, account: answers(taken), log: () => {}, status: { sent: 0, left_out: 0, waiting: 0 }, waiting, onPersisted, signal });
        } finally { running -= 1; }
      } });
    outbox.drain();
    await until(() => taken.length === 1);
    outbox.close();
    assert.deepEqual(taken, ['m1#1']);
    assert.ok(notes.some(note => /did not finish in 0 seconds and was ended/.test(note ?? '')), `recorded: ${JSON.stringify(notes)}`);
    assert.ok(passes >= 2);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('two passes never run at once', async () => {
  const state = folder();
  try {
    const waiting = path.join(state, 'waiting.json');
    writeFileSync(waiting, JSON.stringify([waitingTurn(1)]));
    let running = 0;
    let most = 0;
    let passes = 0;
    const outbox = turnOutbox({ file: path.join(state, 'turns-to-send.json'), waiting, retryMs: 5, deadlineMs: 1000, log: () => {},
      deliver: async () => { passes += 1; running += 1; most = Math.max(most, running); await new Promise(r => setTimeout(r, 30)); running -= 1; } });
    outbox.drain(); outbox.drain(); outbox.drain();
    await until(() => passes >= 4, 2000);
    outbox.close();
    assert.equal(most, 1);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a pass ended after its deadline writes no file when it wakes', async () => {
  const state = folder();
  try {
    const waiting = path.join(state, 'waiting.json');
    writeFileSync(waiting, JSON.stringify([waitingTurn(1)]));
    const controller = new AbortController();
    let release;
    const slow = new Promise(r => { release = r; });
    const account = async () => { await slow; return { status: 200, body: { items: [{ message_id: 'x' }] } }; };
    const sending = send([], { listen, account, log: () => {}, status: { sent: 0, left_out: 0, waiting: 0 }, waiting, signal: controller.signal });
    await new Promise(r => setTimeout(r, 20));
    controller.abort();
    writeFileSync(waiting, JSON.stringify([waitingTurn(1), waitingTurn(2)]));
    release();
    await sending;
    assert.equal(read(waiting).length, 2, 'the later pass owns the file');
  } finally { rmSync(state, { recursive: true, force: true }); }
});
