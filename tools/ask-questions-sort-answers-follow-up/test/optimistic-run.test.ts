// The optimistic run of a form (show/optimistic-run.ts) without a browser: the page moves to the next question at once, the answers
// go to the step tool in the background in the order they were passed, a refused answer takes the visitor back to its question
// with the tool's words and keeps the other answers, a network failure is tried again, a question that needs the server's fact
// is waited for, and what is not yet kept is what a closing page sends. Every answer is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingBody, createRun, Refused, Retry, Stalled, type Check, type Definition, type Item, type Refused as RefusedType, type Sent } from '../show/optimistic-run.ts';
import type { Next } from '../show/FormSteps.tsx';

const TEXT: Check = { coerce: 'string', rules: { required: true, max: 20 } };
const EMAIL_LIKE: Check = { coerce: 'string', rules: { required: true, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', message: 'Enter an email like name@example.com' } };
const PICKS: Check = { coerce: 'picks', rules: { required: true }, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], multiple: false };
const question = (position: number, id: string, typeId = 'short-text'): Next => ({ key: `question:${position}`, kind: 'question', position, prompt: `Question ${id}`, required: true, question: { questionId: id, questionTypeId: typeId } });
const DEFINITION: Definition = {
  questions: [
    { next: question(0, 'name'), check: TEXT, conditional: false },
    { next: question(1, 'mail'), check: EMAIL_LIKE, conditional: false },
    { next: question(2, 'ready', 'picks'), check: PICKS, conditional: false },
    { next: question(3, 'why'), check: TEXT, conditional: true },
    { next: question(4, 'last'), check: TEXT, conditional: false },
  ],
};
const never = () => Promise.resolve();
const later = () => new Promise<void>(done => setImmediate(done));

// A step tool that answers after a pause and records what it was sent, in the order it was sent.
function tool(answer: (item: Item) => Sent | Error | Retry = () => ({ next: null })) {
  const seen: Item[] = [];
  const send = async (items: Item[]) => {
    await later();
    for (const item of items) {
      const given = answer(item);
      if (given instanceof Error) throw given;
      seen.push(item);
      return given;
    }
    throw new Error('nothing sent');
  };
  return { seen, send };
}

test('the next question is named at once, before any answer has reached the step tool', () => {
  const { seen, send } = tool();
  const run = createRun({ definition: DEFINITION, send, wait: never });
  const answered = run.answer(0, 'Invented Person');
  assert.equal(answered.kind, 'advance');
  assert.equal(answered.kind === 'advance' ? answered.next.question?.questionId : '', 'mail');
  assert.deepEqual(seen, []);
  assert.deepEqual(run.unsent(), [{ questionId: 'name', value: 'Invented Person' }]);
});

test('an answer that breaks the rules is not passed and nothing is sent', async () => {
  const { seen, send } = tool();
  const run = createRun({ definition: DEFINITION, send, wait: never });
  const empty = run.answer(0, '   ');
  assert.equal(empty.kind, 'invalid');
  const mail = run.answer(1, 'not an email');
  assert.deepEqual(mail, { kind: 'invalid', message: 'Enter an email like name@example.com.' });
  const long = run.answer(0, 'x'.repeat(21));
  assert.equal(long.kind, 'invalid');
  await later();
  assert.deepEqual(seen, []);
  assert.deepEqual(run.unsent(), []);
});

test('answers reach the step tool one at a time, in the order they were passed, each naming its question', async () => {
  const order: string[] = [];
  let open = 0;
  let most = 0;
  const send = async (items: Item[]) => {
    open += 1;
    most = Math.max(most, open);
    await later();
    order.push(items[0]!.questionId);
    open -= 1;
    return { next: null };
  };
  const run = createRun({ definition: DEFINITION, send, wait: never });
  run.answer(0, 'a');
  run.answer(1, 'a@example.test');
  run.answer(2, { picked: ['yes'] });
  await run.settled();
  assert.deepEqual(order, ['name', 'mail', 'ready']);
  assert.equal(most, 1);
  assert.deepEqual(run.unsent(), []);
});

test('a refused answer takes the visitor back to its question with the tool\'s words and keeps the other answers; none after it is sent', async () => {
  const refused: RefusedType[] = [];
  let refusing = true;
  const { seen, send } = tool(item => (item.questionId === 'mail' && refusing ? new Error('That address is not open to bookings.') : { next: null }));
  const run = createRun({ definition: DEFINITION, send, onRefused: given => refused.push(given), wait: never });
  run.answer(0, 'Invented Person');
  run.answer(1, 'a@example.test');
  const third = run.answer(2, { picked: ['no'] });
  // The question after `ready` is the conditional one, so the page waits on the server for it; the refusal of `mail` reaches it.
  assert.equal(third.kind, 'wait');
  await assert.rejects(third.kind === 'wait' ? third.settled : Promise.resolve(), Refused);
  await later();
  await later();
  await later();
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.message, 'That address is not open to bookings.');
  assert.equal(refused[0]!.position, 1);
  assert.equal(refused[0]!.questionId, 'mail');
  // The first was kept, the refused one and the one after it were not, and the one after it was never sent.
  assert.deepEqual(seen.map(item => item.questionId), ['name']);
  assert.deepEqual(run.unsent(), []);
  // Every answer the visitor gave is still held, so the screen shows it again.
  assert.equal(run.held('name'), 'Invented Person');
  assert.equal(run.held('mail'), 'a@example.test');
  assert.deepEqual(run.held('ready'), { picked: ['no'] });
  // The visitor corrects the refused one and sends it again; it is sent, and the held answer for the next question is offered.
  refusing = false;
  const again = run.answer(1, 'b@example.test');
  assert.deepEqual(again.kind === 'advance' ? again.held : null, { picked: ['no'] });
  await run.settled();
  assert.deepEqual(seen.map(item => item.questionId), ['name', 'mail']);
});

test('a refusal reaches a visitor who is waiting on the server\'s fact, as a refusal with its question', async () => {
  const { send } = tool(item => (item.questionId === 'ready' ? new Error('Pick one of the choices.') : { next: null }));
  const run = createRun({ definition: DEFINITION, send, wait: never });
  run.answer(0, 'a');
  run.answer(1, 'a@example.test');
  const waiting = run.answer(2, { picked: ['yes'] });
  // The question after `ready` is the conditional one: the page does not name it, it waits.
  assert.equal(waiting.kind, 'wait');
  await assert.rejects(waiting.kind === 'wait' ? waiting.settled : Promise.resolve(), (caught: unknown) => caught instanceof Refused && caught.questionId === 'ready' && caught.position === 2 && caught.message === 'Pick one of the choices.');
});

test('a question that needs the server\'s fact is waited for, and the page is given the question the tool names', async () => {
  const why: Next = question(3, 'why');
  const { send } = tool(() => ({ next: why }));
  const run = createRun({ definition: DEFINITION, send, wait: never });
  run.answer(0, 'a');
  run.answer(1, 'a@example.test');
  const waiting = run.answer(2, { picked: ['no'] });
  assert.equal(waiting.kind, 'wait');
  assert.deepEqual(await (waiting.kind === 'wait' ? waiting.settled : null), { next: why });
  // The last question's answer is also the server's to answer: nothing after it is named by the page.
  const last = run.answer(4, 'done');
  assert.equal(last.kind, 'wait');
});

test('the network failing is tried again, in order, and the answers behind it wait their turn', async () => {
  let failures = 2;
  const seen: string[] = [];
  const waits: number[] = [];
  const send = async (items: Item[]) => {
    await later();
    if (items[0]!.questionId === 'name' && failures > 0) { failures -= 1; throw new Retry('offline'); }
    seen.push(items[0]!.questionId);
    return { next: null };
  };
  const run = createRun({ definition: DEFINITION, send, wait: async ms => { waits.push(ms); }, backoffMs: 100 });
  run.answer(0, 'a');
  run.answer(1, 'a@example.test');
  await run.settled();
  assert.deepEqual(seen, ['name', 'mail']);
  assert.deepEqual(waits, [100, 200]);
});

test('after the tries are spent the queue waits with every answer held, and the next answer starts it again', async () => {
  let online = false;
  const seen: string[] = [];
  const send = async (items: Item[]) => {
    await later();
    if (!online) throw new Retry('offline');
    seen.push(items[0]!.questionId);
    return { next: null };
  };
  const run = createRun({ definition: DEFINITION, send, wait: never, tries: 3 });
  run.answer(0, 'a');
  await assert.rejects(run.settled(), Stalled);
  assert.equal(run.stalled(), true);
  assert.deepEqual(run.unsent(), [{ questionId: 'name', value: 'a' }]);
  online = true;
  run.answer(1, 'a@example.test');
  await run.settled();
  assert.deepEqual(seen, ['name', 'mail']);
  assert.equal(run.stalled(), false);
});

test('what is not yet kept is what a closing page sends, in order, in one call', async () => {
  let release: () => void = () => {};
  const held = new Promise<void>(done => { release = done; });
  const send = async (_items: Item[]): Promise<Sent> => { await held; return { next: null }; };
  const run = createRun({ definition: DEFINITION, send, wait: never });
  run.answer(0, 'a');
  run.answer(1, 'a@example.test');
  // The first is on its way and not yet kept, so a closing page sends it again with the second; the step tool keeps it once.
  assert.deepEqual(run.unsent(), [{ questionId: 'name', value: 'a' }, { questionId: 'mail', value: 'a@example.test' }]);
  assert.equal(closingBody('attempt-1', run.unsent()), JSON.stringify({ attemptId: 'attempt-1', answers: run.unsent() }));
  assert.equal(closingBody('attempt-1', []), null);
  release();
  await run.settled();
  assert.deepEqual(run.unsent(), []);
});
