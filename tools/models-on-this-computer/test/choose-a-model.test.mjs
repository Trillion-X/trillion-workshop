// A job that says `choose` asks the shared chooser first: the subscription row answers while its limits read through its
// own door show room under the threshold, and the job's own local models answer when the window is near full, when the
// door said 429 (a rest the chooser reads as a cool-down), or when the door is not reported.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { askLocal, chosenRow, localModelSettings, reviewerNeed } from '../read-data/models-on-this-computer.mjs';

const words = { none: 'No model on this computer answered.', needs_input: 'Give messages or state and questions.' };

// A stand-in codex-lb: its accounts with their weekly use, its live models, and the Responses route; `status` makes the
// Responses route answer that status instead.
function codexDoor({ remaining = [95, 98], status = 200, asked = [] } = {}) {
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/accounts') return response.end(JSON.stringify({ accounts: remaining.map((left, index) => ({ accountId: `a${index}`, status: 'active', usage: { secondaryRemainingPercent: left } })) }));
      if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'gpt-big' }, { id: 'gpt-other' }] }));
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        asked.push(JSON.parse(body).model);
        response.statusCode = status;
        response.end(status === 200 ? JSON.stringify({ model: 'gpt-big', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":"from the subscription"}' }] }] }) : '{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function localServer(asked = []) {
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { asked.push(JSON.parse(body).model); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"from the local model"}' } }] })); });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const settingsFor = (door, local, { threshold = 70 } = {}) => ({
  most_tokens: 2000, retry_after_seconds: 60, words, classify: [],
  chat: [
    { id: 'subscription', url: `http://127.0.0.1:${door.address().port}/v1/responses`, model: 'gpt-big', api_shape: 'responses', timeout_seconds: 5 },
    { id: 'local', url: `http://127.0.0.1:${local.address().port}/v1/chat/completions`, model: 'local-model', timeout_seconds: 5 },
  ],
  jobs: { step: { choose: { kind: 'ai', fit: [] }, models: ['local'], most_tokens: 2000 } },
  answerers: {
    threshold_percent: threshold,
    limits: { codex: { url: `http://127.0.0.1:${door.address().port}`, reader: 'codex-lb-accounts' } },
    rows: [{ id: 'codex-rows', provider: 'codex', kinds: ['ai'], fit: [], models: ['gpt-big'], account_pool: ['codex-lb account 1', 'codex-lb account 2'], window_name: 'weekly', weight: 2, prefer_below_percent: 50, chat: 'subscription' }],
  },
});
const ask = { job: 'step', messages: [{ role: 'system', content: 'Do the task.' }, { role: 'user', content: 'Write it.' }] };

test('with room in the window the subscription row answers first, with the model and the reason the chooser gave', async () => {
  const asked = [], localAsked = [];
  const door = await codexDoor({ remaining: [95, 98], asked });
  const local = await localServer(localAsked);
  try {
    const reply = await askLocal(ask, settingsFor(door, local));
    assert.equal(reply.served_by, 'subscription');
    assert.equal(reply.model, 'gpt-big');
    assert.match(reply.chosen_because, /codex-rows: 5% used on codex-lb account 1/);
    assert.deepEqual(asked, ['gpt-big']);
    assert.deepEqual(localAsked, [], 'the local model is not asked when the subscription answered');
  } finally { door.close(); local.close(); }
});

test('when every account is at or over the threshold the job\'s own local model answers and the subscription is not asked', async () => {
  const asked = [], localAsked = [];
  const door = await codexDoor({ remaining: [25, 20], asked });
  const local = await localServer(localAsked);
  try {
    const reply = await askLocal(ask, settingsFor(door, local, { threshold: 70 }));
    assert.equal(reply.served_by, 'local');
    assert.match(reply.chosen_because, /Nothing fits the need: codex codex-lb account 1: 75% used, at or over 70%; codex codex-lb account 2: 80% used, at or over 70%/);
    assert.deepEqual(asked, [], 'the reserve above the threshold is kept for interactive work');
    assert.deepEqual(localAsked, ['local-model']);
  } finally { door.close(); local.close(); }
});

test('a 429 from the subscription falls back to the local model, and the rest it leaves is a cool-down the next choice reads', async () => {
  const asked = [], localAsked = [];
  const door = await codexDoor({ remaining: [95, 98], status: 429, asked });
  const local = await localServer(localAsked);
  const settings = settingsFor(door, local);
  try {
    const first = await askLocal(ask, settings);
    assert.equal(first.served_by, 'local');
    assert.deepEqual(asked, ['gpt-big'], 'the subscription was tried once and said 429');
    const second = await askLocal(ask, settings);
    assert.equal(second.served_by, 'local');
    assert.match(second.chosen_because, /cooling until/);
    assert.deepEqual(asked, ['gpt-big'], 'while it cools the subscription is not asked again');
    assert.deepEqual(localAsked, ['local-model', 'local-model']);
  } finally { door.close(); local.close(); }
});

test('a door this computer does not report gives no reading, so nothing is picked and the local model answers', async () => {
  const localAsked = [];
  const local = await localServer(localAsked);
  const door = await codexDoor();
  const settings = settingsFor(door, local);
  delete settings.answerers.limits.codex.url;
  try {
    const picked = await chosenRow(settings.jobs.step, settings);
    assert.equal(picked.row, null);
    assert.match(picked.why, /none of its models is on the live list/);
    const reply = await askLocal(ask, settings);
    assert.equal(reply.served_by, 'local');
  } finally { door.close(); local.close(); }
});

test('a job that does not say choose is asked exactly as before, with no chooser read', async () => {
  let reads = 0;
  const settings = { chat: [], answerers: { rows: [{ provider: 'codex' }], limits: { codex: { url: 'http://127.0.0.1:9', reader: 'codex-lb-accounts' } } } };
  const picked = await chosenRow({ models: [] }, settings, { readers: { 'codex-lb-accounts': async () => { reads += 1; return []; } } });
  assert.deepEqual(picked, { row: null, why: null });
  assert.equal(reads, 0);
});

test('the shipped DATA: do-a-task-step chooses, each answerer row answers through a chat row, and each limits row names a known reader and door', () => {
  const settings = localModelSettings();
  assert.deepEqual(settings.jobs['do-a-task-step'].choose, { kind: 'ai', fit: [] });
  assert.ok(settings.jobs['do-a-task-step'].models.length > 0, 'the local models stay as the fallback');
  for (const row of settings.answerers.rows) {
    assert.ok(settings.chat.some(chat => chat.id === row.chat), `${row.id} answers through a chat row`);
    assert.ok(settings.answerers.limits[row.provider], `${row.provider} has a limits row`);
  }
  for (const source of Object.values(settings.answerers.limits)) {
    assert.equal(source.reader, 'codex-lb-accounts');
    assert.ok(settings.chat.some(chat => chat.door === source.door), `${source.door} is a door a chat row already uses`);
  }
  assert.ok(settings.answerers.threshold_percent < 85, 'unattended work stops before the chooser\'s default threshold, keeping a reserve');
});

// A judge reviews another step's answer: { review_of: { served_by, model } } of that answer.
const reviewing = (settings, maker) => askLocal({ ...ask, review_of: maker }, settings);

test('a reviewer never answers with the maker\'s model: with room, the subscription answers with another of its models', async () => {
  const asked = [], localAsked = [];
  const door = await codexDoor({ remaining: [95, 98], asked });
  const local = await localServer(localAsked);
  const settings = settingsFor(door, local);
  settings.answerers.rows[0].models = ['gpt-big', 'gpt-other'];
  try {
    const reply = await reviewing(settings, { served_by: 'subscription', model: 'gpt-big' });
    assert.equal(reply.served_by, 'subscription');
    assert.equal(reply.model, 'gpt-other');
    assert.deepEqual(asked, ['gpt-other'], 'the maker\'s model is not asked');
    assert.match(reply.chosen_because, /reviewer/);
  } finally { door.close(); local.close(); }
});

test('a reviewer of a local maker takes the subscription while it has room', async () => {
  const asked = [], localAsked = [];
  const door = await codexDoor({ remaining: [95, 98], asked });
  const local = await localServer(localAsked);
  try {
    const reply = await reviewing(settingsFor(door, local), { served_by: 'local', model: 'local-model' });
    assert.equal(reply.served_by, 'subscription');
    assert.deepEqual(localAsked, []);
  } finally { door.close(); local.close(); }
});

test('with no room, a reviewer\'s local fallback asks another local model before the maker\'s', async () => {
  const asked = [], localAsked = [];
  const door = await codexDoor({ remaining: [25, 20], asked });
  const local = await localServer(localAsked);
  const settings = settingsFor(door, local);
  settings.chat.push({ ...settings.chat[1], id: 'local-two', model: 'other-local' });
  settings.jobs.step.models = ['local', 'local-two'];
  try {
    const reply = await reviewing(settings, { served_by: 'local', model: 'local-model' });
    assert.equal(reply.served_by, 'local-two');
    assert.deepEqual(localAsked, ['other-local']);
    assert.deepEqual(asked, [], 'the reserve above the threshold is kept');
  } finally { door.close(); local.close(); }
});

test('reviewerNeed names the maker\'s provider by its answerer row, else by the row that served it; no review_of is no need', () => {
  const settings = { answerers: { rows: [{ provider: 'codex', chat: 'subscription' }] } };
  assert.deepEqual(reviewerNeed({ review_of: { served_by: 'subscription', model: 'gpt-big' } }, settings), { role: 'reviewer', avoid: { provider: 'codex', model: 'gpt-big' } });
  assert.deepEqual(reviewerNeed({ review_of: { served_by: 'local', model: 'qwen' } }, settings), { role: 'reviewer', avoid: { provider: 'local', model: 'qwen' } });
  assert.equal(reviewerNeed({}, settings), null);
  assert.equal(reviewerNeed({ review_of: {} }, settings), null);
});
