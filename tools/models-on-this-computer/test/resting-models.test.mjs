// A model that failed rests for retry_after_seconds and is passed over without being asked. When a row passed over was
// only resting the answer is retryable with retry_at; when every row was resting it says so and until when; a row whose
// rest has passed is asked again. A resting local model leaves the subscription route to the chooser when it has room.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { askLocal } from '../read-data/models-on-this-computer.mjs';

const words = { none: 'No model on this computer answered in time.', resting: 'Every model for this job is resting after a failure until {until}; ask again then.' };

// A chat server whose answer can be switched: `state.failing` makes it answer 503.
function chatServer(state, asked = []) {
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        asked.push(JSON.parse(body).model);
        response.setHeader('content-type', 'application/json');
        if (state.failing) { response.statusCode = 503; return response.end('{}'); }
        response.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const chatRow = (id, server) => ({ id, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: id, timeout_seconds: 5 });
const ask = job => ({ job, messages: [{ role: 'user', content: 'Write it.' }] });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a resting row is passed over without being asked, and the next row answers', async () => {
  const one = { failing: true }, two = { failing: false };
  const askedOne = [], askedTwo = [];
  const first = await chatServer(one, askedOne), second = await chatServer(two, askedTwo);
  const settings = { most_tokens: 100, retry_after_seconds: 60, words, classify: [], chat: [chatRow('rest-a', first), chatRow('rest-b', second)], jobs: { job: { models: ['rest-a', 'rest-b'] } } };
  try {
    assert.equal((await askLocal(ask('job'), settings)).served_by, 'rest-b', 'the failing row rests and the next answers');
    const again = await askLocal(ask('job'), settings);
    assert.equal(again.served_by, 'rest-b');
    assert.deepEqual(askedOne, ['rest-a'], 'the resting row is not asked again while it rests');
  } finally { first.close(); second.close(); }
});

test('when every row is resting the answer says until when, and is retryable at that time', async () => {
  const state = { failing: true };
  const asked = [];
  const server = await chatServer(state, asked);
  const settings = { most_tokens: 100, retry_after_seconds: 60, words, classify: [], chat: [chatRow('all-a', server), chatRow('all-b', server)], jobs: { job: { models: ['all-a', 'all-b'] } } };
  try {
    const failed = await askLocal(ask('job'), settings);
    assert.equal(failed.error, words.none, 'the first failure is a failure, not a rest');
    assert.equal(failed.retryable, undefined);
    const before = Date.now();
    const resting = await askLocal(ask('job'), settings);
    assert.equal(resting.retryable, true);
    assert.ok(Date.parse(resting.retry_at) > before && Date.parse(resting.retry_at) <= before + 60000, 'retry_at is when the first rest ends');
    assert.equal(resting.error, words.resting.replace('{until}', resting.retry_at));
    assert.deepEqual(resting.tried.map(item => item.why), ['is resting after a failure', 'is resting after a failure']);
    assert.deepEqual(asked, ['all-a', 'all-b'], 'no resting row was asked');
  } finally { server.close(); }
});

test('a row whose rest has passed is asked again, and answers once it has recovered', async () => {
  const state = { failing: true };
  const asked = [];
  const server = await chatServer(state, asked);
  const settings = { most_tokens: 100, retry_after_seconds: 0.2, words, classify: [], chat: [chatRow('recover-a', server)], jobs: { job: { models: ['recover-a'] } } };
  try {
    await askLocal(ask('job'), settings);
    assert.equal((await askLocal(ask('job'), settings)).retryable, true);
    state.failing = false;
    await pause(300);
    const reply = await askLocal(ask('job'), settings);
    assert.equal(reply.served_by, 'recover-a');
    assert.deepEqual(asked, ['recover-a', 'recover-a']);
  } finally { server.close(); }
});

test('with the local model resting, the chooser\'s subscription pick answers while its limits have room', async () => {
  const local = { failing: true };
  const localAsked = [];
  const localServer = await chatServer(local, localAsked);
  const door = await new Promise(resolve => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/accounts') return response.end(JSON.stringify({ accounts: [{ accountId: 'a', status: 'active', usage: { secondaryRemainingPercent: 90 } }] }));
      if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'gpt-big' }] }));
      request.resume();
      request.on('end', () => response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":"sub"}' }] }] })));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const port = door.address().port;
  const settings = { most_tokens: 100, retry_after_seconds: 60, words, classify: [],
    chat: [chatRow('rest-local', localServer), { id: 'sub', url: `http://127.0.0.1:${port}/v1/responses`, model: 'gpt-big', api_shape: 'responses', timeout_seconds: 5 }],
    jobs: { plain: { models: ['rest-local'] }, step: { choose: { kind: 'ai', fit: [] }, models: ['rest-local'] } },
    answerers: { threshold_percent: 70, limits: { codex: { url: `http://127.0.0.1:${port}`, reader: 'codex-lb-accounts' } },
      rows: [{ id: 'codex-rows', provider: 'codex', kinds: ['ai'], models: ['gpt-big'], account_pool: ['codex-lb account 1'], window_name: 'weekly', chat: 'sub' }] } };
  try {
    assert.equal((await askLocal(ask('plain'), settings)).error, words.none, 'the local model failed and now rests');
    assert.equal((await askLocal(ask('plain'), settings)).retryable, true, 'a job with only the local model waits for it');
    const reply = await askLocal(ask('step'), settings);
    assert.equal(reply.served_by, 'sub', 'a job that chooses is answered by the subscription while the local model rests');
    assert.deepEqual(localAsked, ['rest-local']);
  } finally { localServer.close(); door.close(); }
});
