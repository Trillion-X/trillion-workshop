// test/take-open-work-check-resume.test.mjs
// Work the taker parked because its answer check refused the answer is resumed by the taker itself once the check it runs
// is another one, once per check (harness/take-open-work.mjs parkedByAnOlderCheck, ANSWER_CHECK). A park under the check it
// runs now, or a park for any other reason, stays for review. Nov 22 2026: an inventory step stayed parked at 6:44 AM CST
// after three refusals for minItems, which the next check (dcab08064) checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { ANSWER_CHECK, finishFromAnswer, parkedByAnOlderCheck, resultFileOf, runPass, startedRecords } from '../harness/take-open-work.mjs';
import settingsFile from '../harness/take-open-work.json' with { type: 'json' };

const NOW = '2026-11-22T13:00:00.000Z';
const ME = 'ai:take-open-work-mac';
const OLD = '1f:' + '0'.repeat(64);
const KEYWORD = 'The run\'s result does not match the step\'s answer shape (the step\'s submit names the keyword "minItems", which this computer does not check), so the task is given back; it is not finished.';
const NO_LINKS = 'The run\'s result does not match the step\'s answer shape (The run input holds only a fact, with no links), so the task is given back; it is not finished.';
const settings = { ...settingsFile, max_concurrent: 1, use_ai: 'claude', ai_order: ['claude'], working_folder: '/work', triage: undefined, work_mcp: undefined };

test('the answer check has a BLAKE3 identity of its own bytes', () => {
  assert.match(ANSWER_CHECK, /^1f:[0-9a-f]{64}$/);
});

test('a park by an older check is told apart from a park by this check, by another cause, or one already resumed for this check', () => {
  assert.equal(parkedByAnOlderCheck({ parked: true, check_refused: OLD }, KEYWORD), true);
  assert.equal(parkedByAnOlderCheck({ parked: true, check_refused: ANSWER_CHECK }, KEYWORD), false, 'parked under the check run now');
  assert.equal(parkedByAnOlderCheck({ parked: true, check_refused: OLD, check_resumed: ANSWER_CHECK }, KEYWORD), false, 'never twice for one check');
  assert.equal(parkedByAnOlderCheck({ parked: false, check_refused: OLD }, KEYWORD), false, 'not parked');
  // A record kept before checks were named: only an unchecked-keyword refusal, which a newer check can lift, counts.
  assert.equal(parkedByAnOlderCheck({ parked: true }, KEYWORD), true);
  assert.equal(parkedByAnOlderCheck({ parked: true }, NO_LINKS), false, 'the AI found nothing to answer: no check lifts that');
  assert.equal(parkedByAnOlderCheck(undefined, KEYWORD), false);
});

test('a refusal by the answer check names the check on the job; an answer the AI could not give does not', async () => {
  const folder = tempFolder(join(tmpdir(), 'check-resume-finish-'));
  const configured = { ...settings, state_folder: folder };
  const submit = { type: 'object', required: ['word'], properties: { word: { type: 'string', enum: ['ready'] } } };
  const finish = async (id, written, asks = { do: 'Say ready.', submit, checks: [] }) => {
    const file = resultFileOf(configured, id);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(written));
    const job = { handoff_id: id };
    const refusal = await finishFromAnswer(async () => { throw new Error('a refused answer is never sent'); }, configured, { job, read: { asks }, logPath: '/log' });
    return { refusal, job };
  };
  const wrong = await finish('t1', { result: { word: 'blue' }, evidence: 'I said blue.' });
  assert.match(wrong.refusal, /must be one of "ready"/);
  assert.equal(wrong.job.check_refused, ANSWER_CHECK);
  const unknown = await finish('t2', { result: { at: 'x' }, evidence: 'I wrote a time.' }, { do: 'Say when.', submit: { type: 'object', properties: { at: { type: 'string', format: 'date' } } }, checks: [] });
  assert.match(unknown.refusal, /names the keyword "format"/);
  assert.equal(unknown.job.check_refused, ANSWER_CHECK);
  const none = await finish('t3', { result: null, evidence: 'The run input holds no links.' });
  assert.equal(none.job.check_refused, undefined);
});

function taskCall(work, seen) {
  const call = async (path, body) => {
    seen.push([path, body]);
    if (path === '/handoffs/open-page') return { work, agents: [], next_after: null };
    if (path === '/handoffs/resume') return { moved: true };
    return {};
  };
  call.tasks = true;
  return call;
}
const parked = (id, reason) => ({ handoff_id: id, task: true, state: 'blocked', status: 'Waiting', assignees: [ME], to_agent: null, input: {},
  handed_at: NOW, hold_until: null, continuation: { owner: ME, after: NOW, reason } });
function parkedHere(folder, id, extra) {
  const records = startedRecords(folder);
  records.claim({ handoff_id: id, mode: 'claim', agent_id: ME, started_at: NOW, attempt: 3, executor_starts: 3 });
  records.update(id, { ended_at: NOW, parked: true, ...extra });
}

test('the taker resumes, as itself, work parked under an older check once, and leaves the others parked', async () => {
  const folder = tempFolder(join(tmpdir(), 'check-resume-pass-'));
  parkedHere(folder, 'older-check', { check_refused: OLD });
  parkedHere(folder, 'this-check', { check_refused: ANSWER_CHECK });
  parkedHere(folder, 'kept-before', {});
  parkedHere(folder, 'no-links', {});
  const work = [parked('older-check', KEYWORD), parked('this-check', KEYWORD), parked('kept-before', KEYWORD), parked('no-links', NO_LINKS)];
  const pass = async () => {
    const seen = [];
    const done = await runPass({ locate: name => `/fake/bin/${name}`, settings: { ...settings, state_folder: folder, resting: {}, resting_because: {} }, call: taskCall(work, seen), computer: 'Mac',
      spawnRun: () => { throw new Error('must not start'); }, now: () => new Date(NOW) });
    await Promise.all(done.runs);
    return seen.filter(([path]) => path === '/handoffs/resume').map(([, body]) => body);
  };
  const first = await pass();
  assert.deepEqual(first.map(body => [body.handoff_id, body.agent_id]), [['older-check', ME], ['kept-before', ME]]);
  assert.match(first[0].because, new RegExp(`\\(${OLD}\\).*\\(${ANSWER_CHECK}\\)`));
  // The same tasks read as parked again (no new attempt ran): no second resume under the same check.
  assert.deepEqual(await pass(), []);
});
