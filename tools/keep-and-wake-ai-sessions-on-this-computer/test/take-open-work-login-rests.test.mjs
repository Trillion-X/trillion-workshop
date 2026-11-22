// test/take-open-work-login-rests.test.mjs
// Each login of an AI's pool rests on its own (harness/ai-auth.mjs, harness/take-open-work.mjs): a run takes the first
// login that is neither resting nor held, a limit rests only the login that hit it, every login resting leaves the work
// untaken until the earliest reset, and a rest kept for the whole AI before rests were per login holds one login only.
// The logins are values a run was handed (vault `run mounts`), so no vault command and no secret is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { acquireAiAuth, restingLogins } from '../harness/ai-auth.mjs';
import { keepRunValues } from '../harness/vault-value.mjs';
import { chosenAi, parkedOnlyByLimits, plan, restOf, restsByLogin, runPass, startedRecords, takerCard } from '../harness/take-open-work.mjs';
import settingsFile from '../harness/take-open-work.json' with { type: 'json' };

const NOW = '2026-11-22T11:00:00.000Z';
const LATER = '2026-11-25T03:00:00.000Z';
const SOONER = '2026-11-23T23:00:00.000Z';
const POOL = { claude_env: 'CLAUDE_CODE_OAUTH_TOKEN', claude_token_names: ['login-5', 'login-1'] };
const VAULT = { from: 'run mounts' };
keepRunValues({ 'login-5': 'value-five', 'login-1': 'value-one', 'login-2': 'value-two' });
const settings = { ...settingsFile, max_concurrent: 1, use_ai: 'claude', ai_order: ['claude'], working_folder: '/work', triage: undefined, work_mcp: undefined, vault: VAULT, ai_auth: { claude: POOL } };
const located = name => `/fake/bin/${name}`;
const job = id => ({ handoff_id: id, state: 'open', status: 'open', to_agent: null, input: {}, handed_at: '2026-11-22T10:00:00.000Z', hold_until: null });

test('a rest on one login does not block another: the run takes the next login, and the AI is not resting', () => {
  const folder = tempFolder(join(tmpdir(), 'login-rests-one-'));
  const resting = { 'login-5': LATER };
  const auth = acquireAiAuth(POOL, { folder, runId: 'r1', vault: VAULT, staleMs: 60_000, resting, now: NOW });
  assert.equal(auth.login, 'login-1');
  assert.deepEqual(auth.env, { CLAUDE_CODE_OAUTH_TOKEN: 'value-one' });
  auth.done();
  const rested = { ...settings, resting, resting_because: { 'login-5': 'weekly limit' } };
  assert.equal(restOf(rested, 'claude', NOW), null);
  assert.equal(chosenAi(rested, NOW).id, 'claude');
  assert.equal(takerCard(rested, 'Mac', NOW).capacity.resting, undefined, 'one login resting is no rest of the AI on the card');
  // A login with no rest kept is untested, not full: it is the one taken.
  const fresh = acquireAiAuth({ claude_token_names: ['login-2'] }, { folder, runId: 'r2', vault: VAULT, staleMs: 60_000, resting, now: NOW });
  assert.equal(fresh.login, 'login-2');
  fresh.done();
});

test('every login resting leaves the work untaken, and the card and the log name the earliest reset', async () => {
  const folder = tempFolder(join(tmpdir(), 'login-rests-all-'));
  const resting = { 'login-5': LATER, 'login-1': SOONER };
  assert.equal(acquireAiAuth(POOL, { folder, runId: 'r1', vault: VAULT, staleMs: 60_000, resting, now: NOW }), null);
  assert.deepEqual(restingLogins(POOL, resting, NOW), { logins: ['login-5', 'login-1'], resting: ['login-5', 'login-1'], all: true, earliest: SOONER });
  const rested = { ...settings, resting, resting_because: { 'login-5': 'five', 'login-1': 'one' }, state_folder: folder };
  assert.deepEqual(restOf(rested, 'claude', NOW), { until: SOONER, because: 'one', login: 'login-1' });
  const card = takerCard(rested, 'Mac', NOW);
  assert.equal(card.capacity.all_resting, true);
  assert.match(card.description, new RegExp(`resting until ${SOONER}`));
  const calls = [];
  const lines = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/open-page') return { work: [job('h1')], agents: [], next_after: null };
    return {};
  };
  const pass = await runPass({ locate: located, settings: rested, call, computer: 'Mac', spawnRun: () => { throw new Error('must not start'); }, now: () => new Date(NOW), log: entry => lines.push(entry) });
  await Promise.all(pass.runs);
  assert.equal(calls.some(([path]) => path === '/handoffs/take'), false, 'nothing is taken while every login rests');
  assert.deepEqual(lines.find(entry => entry.did === 'every login rests'), { did: 'every login rests', ai: 'claude', handoff_id: 'h1', until: SOONER });
});

test('a rest kept for the whole AI before rests were per login holds the pool\'s first login only', () => {
  assert.deepEqual(restsByLogin({ claude: POOL }, { claude: LATER }, { claude: 'old words' }),
    { resting: { 'login-5': LATER }, resting_because: { 'login-5': 'old words' } });
  // The login's own rest, when it keeps one, wins over the old AI-wide record.
  assert.deepEqual(restsByLogin({ claude: POOL }, { claude: LATER, 'login-5': SOONER }, {}), { resting: { 'login-5': SOONER }, resting_because: {} });
  // An AI on its own sign-in keeps its rest under its own id.
  assert.deepEqual(restsByLogin({}, { claude: LATER }, {}), { resting: { claude: LATER }, resting_because: {} });
  const folder = tempFolder(join(tmpdir(), 'login-rests-old-'));
  const { resting } = restsByLogin({ claude: POOL }, { claude: LATER }, {});
  assert.equal(acquireAiAuth(POOL, { folder, runId: 'r1', vault: VAULT, staleMs: 60_000, resting, now: NOW }).login, 'login-1');
});

test('two runs at the same moment never take the same login: the lock is taken before the value is read', () => {
  const folder = tempFolder(join(tmpdir(), 'login-rests-two-'));
  const first = acquireAiAuth(POOL, { folder, runId: 'r1', vault: VAULT, staleMs: 60_000, resting: {}, now: NOW });
  const second = acquireAiAuth(POOL, { folder, runId: 'r2', vault: VAULT, staleMs: 60_000, resting: {}, now: NOW });
  assert.deepEqual([first.login, second.login], ['login-5', 'login-1']);
  assert.equal(acquireAiAuth(POOL, { folder, runId: 'r3', vault: VAULT, staleMs: 60_000, resting: {}, now: NOW }), null, 'a third waits for a free login');
  first.done();
  assert.equal(acquireAiAuth(POOL, { folder, runId: 'r4', vault: VAULT, staleMs: 60_000, resting: {}, now: NOW }).login, 'login-5');
});

test('a run that hits its limit rests the login it used, gives the work back naming it, and the next pass runs on the next login', async () => {
  const folder = tempFolder(join(tmpdir(), 'login-rests-run-'));
  mkdirSync(join(folder, 'runs'), { recursive: true });
  const calls = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/open-page') return { work: [job('h1')], agents: [], next_after: null };
    if (path === '/handoffs/take') return { handoff: { handoff_id: body.handoff_id, state: 'taken' } };
    if (path === '/handoffs/read') return { handoff: { handoff_id: 'h1', state: 'taken', taken_by: 'take-open-work-mac' } };
    return { handoff: { handoff_id: 'h1' } };
  };
  const environments = [];
  const spawnRun = (command, args, options) => {
    environments.push(options.env.CLAUDE_CODE_OAUTH_TOKEN);
    const listeners = {};
    writeFileSync(join(folder, 'runs', 'h1.log'), "You've hit your weekly limit · resets Nov 24 at 9pm (America/Chicago)\n");
    setTimeout(() => listeners.close?.(1), 5);
    return { pid: process.pid, on: (name, fn) => { listeners[name] = fn; } };
  };
  const pass = await runPass({ locate: located, settings: { ...settings, state_folder: folder, resting: {}, resting_because: {} }, call, computer: 'Mac', spawnRun, now: () => new Date(NOW) });
  await Promise.all(pass.runs);
  const kept = JSON.parse(readFileSync(join(folder, 'resting.json'), 'utf8'));
  assert.deepEqual(Object.keys(kept), ['login-5']);
  assert.equal(kept['login-5'].until, LATER);
  assert.match(calls.find(([path]) => path === '/handoffs/release')[1].because, new RegExp(`login-5 reached its usage limit and rests until ${LATER}`));
  // A run that only met a spent limit did no work: it is not one of the task's attempts, and the work is not parked.
  assert.equal(startedRecords(folder).all().get('h1').executor_starts, 0);
  assert.equal(calls.find(([path]) => path === '/handoffs/release')[1].park, undefined);
  // The given-back work is tried again after its retry wait (retry_unfinished_minutes), on the login that is not resting.
  const retryAt = new Date(Date.parse(NOW) + (settings.retry_unfinished_minutes[1] + 1) * 60_000);
  const next = await runPass({ locate: located, settings: { ...settings, state_folder: folder, resting: { 'login-5': LATER }, resting_because: {} }, call, computer: 'Mac', spawnRun, now: () => retryAt });
  await Promise.all(next.runs);
  assert.deepEqual(environments, ['value-five', 'value-one']);
});

test('a job already started here lets go of the login it was given at once, so the login is free for the next run', async () => {
  const folder = tempFolder(join(tmpdir(), 'login-rests-held-'));
  const records = startedRecords(folder);
  records.claim({ handoff_id: 'h1', mode: 'claim', agent_id: 'take-open-work-mac', started_at: NOW, attempt: 1, executor_starts: 0 });
  records.update('h1', { ended_at: NOW, limit_hit: true });
  const lines = [];
  const call = async path => (path === '/handoffs/open-page' ? { work: [job('h1')], agents: [], next_after: null } : {});
  const pass = await runPass({ locate: located, settings: { ...settings, state_folder: folder, resting: {}, resting_because: {} }, call, computer: 'Mac', spawnRun: () => { throw new Error('must not start'); }, now: () => new Date(NOW), log: entry => lines.push(entry) });
  await Promise.all(pass.runs);
  assert.ok(lines.some(entry => entry.did === 'already started here'));
  const locks = join(folder, 'auth-locks');
  assert.deepEqual(existsSync(locks) ? readdirSync(locks) : [], [], 'no login stays locked');
});

test('work parked only because its runs met spent logins is told apart from work with a real failure', () => {
  const record = { handoff_id: 'h1', parked: true, limit_hit: true };
  const limitOnly = [{ handoff_id: 'h1', limit_hit: true }, { handoff_id: 'h1', limit_hit: true }, { handoff_id: 'other', limit_hit: false }];
  assert.equal(parkedOnlyByLimits(record, limitOnly), true);
  assert.equal(parkedOnlyByLimits(record, [...limitOnly, { handoff_id: 'h1' }]), false, 'one attempt that did not end at a limit keeps the park');
  assert.equal(parkedOnlyByLimits({ ...record, limit_hit: false }, limitOnly), false, 'the last attempt failed for real');
  assert.equal(parkedOnlyByLimits({ ...record, parked: false }, limitOnly), false, 'not parked: nothing to resume');
  assert.equal(parkedOnlyByLimits(undefined, limitOnly), false);
});

// A task transport like the taker's: open work in pages, the taker's own card, and each resume it asks for.
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
// One attempt's local record and its history, as runPass leaves them: `limits` says whether each attempt ended at a limit.
function parkedHere(folder, id, limits) {
  const records = startedRecords(folder);
  limits.forEach((limit, index) => {
    records.claim({ handoff_id: id, mode: 'claim', agent_id: 'ai:take-open-work-mac', started_at: NOW, attempt: index + 1, executor_starts: index + 1 });
    records.update(id, { ended_at: NOW, ...(limit ? { limit_hit: true } : {}) });
    if (index < limits.length - 1) records.rearm(id);
  });
  records.update(id, { parked: true });
}
const parked = id => ({ ...job(id), task: true, state: 'blocked', status: 'Waiting', assignees: ['ai:take-open-work-mac'], continuation: { owner: 'ai:take-open-work-mac', after: NOW } });

test('the taker resumes, as itself, work it parked only because its runs met spent logins, and leaves a real failure parked', async () => {
  const folder = tempFolder(join(tmpdir(), 'login-rests-park-'));
  parkedHere(folder, 'limits-only', [true, true, true]);
  parkedHere(folder, 'real-failure', [true, false, true]);
  const seen = [];
  const lines = [];
  const pass = await runPass({ locate: located, settings: { ...settings, state_folder: folder, resting: {}, resting_because: {} }, call: taskCall([parked('limits-only'), parked('real-failure')], seen), computer: 'Mac', spawnRun: () => { throw new Error('must not start'); }, now: () => new Date(NOW), log: entry => lines.push(entry) });
  await Promise.all(pass.runs);
  const resumes = seen.filter(([path]) => path === '/handoffs/resume').map(([, body]) => body);
  assert.deepEqual(resumes.map(body => [body.handoff_id, body.agent_id]), [['limits-only', 'ai:take-open-work-mac']]);
  assert.equal(resumes[0].because, settings.words.resumed_after_limits);
  assert.ok(lines.some(entry => entry.did === 'resumed work parked only by spent logins' && entry.handoff_id === 'limits-only'));
});

test('with take_unassigned_when empty, a task handed to nobody is not taken; one naming this taker is', () => {
  assert.deepEqual(settings.tasks.take_unassigned_when, [], 'the shipped settings take no unassigned work');
  const open = [{ ...job('nobody'), task: true, assignees: [] }, { ...job('mine'), task: true, assignees: ['ai:take-open-work-mac'] }];
  const { start } = plan({ open, agents: [], settings, started: new Map(), today: 0, running: 0, chats: new Map(), agent_id: 'ai:take-open-work-mac', computer: 'Mac', now: NOW });
  assert.deepEqual(start.map(item => item.handoff_id), ['mine']);
});
