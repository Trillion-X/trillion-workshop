// The model on the person's own computer answers model calls: the first local server that answers takes a
// conversation or a yes-or-no question, a server that is not running is skipped, and none running is said in words.
// Moved from old trillion test/local-models.test.mjs (and the streaming case from test/keyed-parts.test.mjs).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { askLocal } from '../read-data/models-on-this-computer.mjs';

const serve = answer => new Promise(resolve => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(answer(JSON.parse(body)))); });
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const words = { none: 'No model on this computer answered.', needs_input: 'Give messages or state and questions.' };

test('a job selects its model, structured output and output limit from data', async () => {
  const asked = [];
  const server = await serve(body => { asked.push(body); return { choices: [{ message: { content: '{}' } }] }; });
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const settings = { most_tokens: 4000, words, classify: [], chat: [
    { id: 'large', url, model: 'large', timeout_seconds: 5 },
    { id: 'small', url, model: 'small', timeout_seconds: 5 },
  ], jobs: { awareness: { models: ['small'], most_tokens: 1200, response_format: { type: 'json_object' } } } };
  try {
    const reply = await askLocal({ job: 'awareness', messages: [{ role: 'user', content: 'Read this' }], max_tokens: 8000 }, settings);
    assert.equal(reply.served_by, 'small');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].max_tokens, 1200);
    assert.deepEqual(asked[0].response_format, { type: 'json_object' });
  } finally { server.close(); }
});

test('a conversation goes to the first local server that answers; one not running is skipped', async () => {
  const asked = [];
  const server = await serve(body => { asked.push(body); return { choices: [{ message: { content: '{"verdicts":[]}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }; });
  const settings = { most_tokens: 512, words, classify: [], chat: [
    { id: 'not-running', url: 'http://127.0.0.1:9/v1/chat/completions', model: 'absent', timeout_seconds: 2 },
    { id: 'here', url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: 'small-local', timeout_seconds: 5 },
  ] };
  const reply = await askLocal({ messages: [{ role: 'user', content: 'judge this' }], max_tokens: 4000, temperature: 0 }, settings);
  server.close();
  assert.equal(reply.served_by, 'here');
  assert.equal(reply.model, 'small-local');
  assert.equal(reply.choices[0].message.content, '{"verdicts":[]}');
  assert.deepEqual({ model: asked[0].model, max_tokens: asked[0].max_tokens, temperature: asked[0].temperature, stream: asked[0].stream }, { model: 'small-local', max_tokens: 512, temperature: 0, stream: false });
});

test('the local owner forwards the judge seed to the server and leaves unspecified seeds absent', async () => {
  const asked = [];
  const server = await serve(body => { asked.push(body); return { choices: [{ message: { content: 'ok' } }] }; });
  const settings = { most_tokens: 4, words, chat: [{ id: 'local', model: 'model', url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, timeout_seconds: 2 }] };
  try {
    for (const seed of [1, 2, 3, undefined]) await askLocal({ messages: [], seed, temperature: 0 }, settings);
    assert.deepEqual(asked.map(body => body.seed), [1, 2, 3, undefined]);
    assert.equal(Object.hasOwn(asked[3], 'seed'), false);
  } finally { server.close(); }
});

test('an unresponsive local model is skipped while its retry pause is active', async () => {
  let failedCalls = 0;
  const unavailable = createServer((_request, response) => { failedCalls += 1; response.statusCode = 503; response.end(); });
  await new Promise(resolve => unavailable.listen(0, '127.0.0.1', resolve));
  const fallback = await serve(() => ({ choices: [{ message: { content: 'OK' } }] }));
  const settings = { most_tokens: 2, words, classify: [], retry_after_seconds: 60, chat: [
    { id: 'busy', url: `http://127.0.0.1:${unavailable.address().port}/v1/chat/completions`, model: 'busy', timeout_seconds: 1 },
    { id: 'free', url: `http://127.0.0.1:${fallback.address().port}/v1/chat/completions`, model: 'free', timeout_seconds: 1 },
  ] };
  try {
    assert.equal((await askLocal({ messages: [{ role: 'user', content: 'x' }] }, settings)).served_by, 'free');
    assert.equal((await askLocal({ messages: [{ role: 'user', content: 'x' }] }, settings)).served_by, 'free');
    assert.equal(failedCalls, 1, 'waiting Mac jobs do not each wait on the same known failure');
  } finally { unavailable.close(); fallback.close(); }
});

test('tool definitions and returned calls survive a fallback to another local model', async () => {
  const tools = [{ type: 'function', function: { name: 'read_task', description: 'Read a task', parameters: { type: 'object' } } }];
  const calls = [{ id: 'read-proof', type: 'function', function: { name: 'read_task', arguments: '{"task_id":"proof"}' } }];
  const asked = [];
  const server = await serve(body => { asked.push(body); return { choices: [{ message: { content: '', tool_calls: calls } }] }; });
  const settings = { most_tokens: 512, words, classify: [], chat: [
    { id: 'not-here', url: 'http://127.0.0.1:9/v1/chat/completions', model: 'absent', timeout_seconds: 1 },
    { id: 'local-tools', url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: 'local-tools', timeout_seconds: 2 },
  ] };
  try {
    const answer = await askLocal({ messages: [{ role: 'user', content: 'Read the proof task.' }], tools }, settings);
    assert.deepEqual(asked[0].tools, tools);
    assert.deepEqual(answer.choices[0].message.tool_calls, calls);
    assert.equal(answer.served_by, 'local-tools');
  } finally { server.close(); }
});

test('a model that refuses a request it cannot take is not rested, so its other asks still reach it', async () => {
  const noTools = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (JSON.parse(body).tools) { response.statusCode = 400; return response.end('{"error":"does not support tools"}'); }
      response.end(JSON.stringify({ choices: [{ message: { content: 'plain answer' } }] }));
    });
  });
  await new Promise(resolve => noTools.listen(0, '127.0.0.1', resolve));
  const withTools = await serve(() => ({ choices: [{ message: { content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }] } }] }));
  const settings = { most_tokens: 64, words, classify: [], retry_after_seconds: 60, chat: [
    { id: 'plain', url: `http://127.0.0.1:${noTools.address().port}/v1/chat/completions`, model: 'plain', timeout_seconds: 2 },
    { id: 'tools', url: `http://127.0.0.1:${withTools.address().port}/v1/chat/completions`, model: 'tools', timeout_seconds: 2 },
  ] };
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }];
  try {
    assert.equal((await askLocal({ messages: [{ role: 'user', content: 'x' }], tools }, settings)).served_by, 'tools');
    assert.equal((await askLocal({ messages: [{ role: 'user', content: 'x' }], tools }, settings)).served_by, 'tools');
    assert.equal((await askLocal({ messages: [{ role: 'user', content: 'x' }] }, settings)).served_by, 'plain', 'asked without tools it answers at once');
  } finally { noTools.close(); withTools.close(); }
});

test('when no local model answers, the error says for each model why it did not', async () => {
  const slow = createServer(() => {});
  const failing = createServer((_request, response) => { response.statusCode = 503; response.end(); });
  await Promise.all([slow, failing].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const at = server => `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const settings = { most_tokens: 8, words, classify: [], retry_after_seconds: 60, chat: [
    { id: 'slow', url: at(slow), model: 'slow-why', timeout_seconds: 0.3 },
    { id: 'failing', url: at(failing), model: 'failing-why', timeout_seconds: 1 },
    { id: 'gone', url: 'http://127.0.0.1:9/v1/chat/completions', model: 'gone-why', timeout_seconds: 1 },
  ] };
  try {
    const first = await askLocal({ messages: [{ role: 'user', content: 'x' }] }, settings);
    assert.equal(first.error, words.none);
    assert.deepEqual(first.tried, [{ id: 'slow', why: 'did not answer in time' }, { id: 'failing', why: 'answered 503' }, { id: 'gone', why: 'is not running' }]);
    const second = await askLocal({ messages: [{ role: 'user', content: 'x' }] }, settings);
    assert.deepEqual(second.tried.map(row => row.why), ['is resting after a failure', 'is resting after a failure', 'is resting after a failure']);
  } finally { slow.closeAllConnections(); slow.close(); failing.close(); }
});

test('a background ask timing out does not rest the model for the person\'s work, which tries it and rests it only for what is beneath it', async () => {
  let slow = true;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => { if (slow) return; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings = { most_tokens: 8, words, classify: [], retry_after_seconds: 60, chat: [
    { id: 'only', url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: 'rest-by-priority', timeout_seconds: 0.2 },
  ] };
  const ask = { messages: [{ role: 'user', content: 'x' }] };
  try {
    assert.deepEqual((await askLocal(ask, settings, { priority: 0 })).tried, [{ id: 'only', why: 'did not answer in time' }]);
    assert.deepEqual((await askLocal(ask, settings)).tried, [{ id: 'only', why: 'is resting after a failure' }], 'another background ask is held off');
    slow = false;
    assert.equal((await askLocal(ask, settings, { priority: 5 })).served_by, 'only', 'the person\'s work is not told the model is resting');
    slow = true;
    assert.deepEqual((await askLocal(ask, settings, { priority: 5 })).tried, [{ id: 'only', why: 'did not answer in time' }]);
    assert.deepEqual((await askLocal(ask, settings, { priority: 5 })).tried, [{ id: 'only', why: 'is resting after a failure' }], 'its own failure rests it for equal work');
    assert.deepEqual((await askLocal(ask, settings, { priority: 2 })).tried, [{ id: 'only', why: 'is resting after a failure' }], 'and for work beneath it');
  } finally { server.closeAllConnections(); server.close(); }
});

test('a yes-or-no question goes to the local classifier; nothing running answers in words', async () => {
  const server = await serve(body => ({ answers: { verdict: { type: 'noul', noul: body.state.includes('dentist') ? 0.86 : 0.03 } } }));
  const settings = { most_tokens: 512, words, chat: [], classify: [{ id: 'classifier', url: `http://127.0.0.1:${server.address().port}/v1/systemone`, timeout_seconds: 5 }] };
  const yes = await askLocal({ state: 'remind me to call the dentist', questions: { verdict: { type: 'noul', instructions: 'Does this call for action?' } } }, settings);
  server.close();
  assert.equal(yes.answers.verdict.noul, 0.86);
  assert.deepEqual(await askLocal({ state: 'x', questions: { verdict: {} } }, { ...settings, classify: [] }), { error: words.none, tried: [] });
  assert.deepEqual(await askLocal({}, settings), { error: words.needs_input });
});

test('a classify row asked as a chat answers the probability of yes from the model\'s own word probabilities', async () => {
  const asked = [];
  const server = await serve(body => {
    asked.push(body);
    const yes = body.messages[1].content.includes('Text Morgan') ? -0.01 : -6;
    return { choices: [{ message: { content: yes > -1 ? 'yes' : 'no' }, logprobs: { content: [{ token: yes > -1 ? 'yes' : 'no', logprob: -0.01, top_logprobs: [{ token: 'yes', logprob: yes }, { token: ' Yes', logprob: yes - 3 }, { token: 'no', logprob: yes > -1 ? -5 : -0.01 }] }] } }] };
  });
  const settings = { most_tokens: 512, words, chat: [], classify: [
    { id: 'chat-yes-no', ask: 'chat', url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: 'local-chat', prompt: 'Answer with one word: yes or no.', timeout_seconds: 5 },
    { id: 'classifier', url: 'http://127.0.0.1:9/v1/systemone', timeout_seconds: 2 },
  ] };
  const question = { verdict: { type: 'noul', instructions: 'Is there a task to do?', criteria: { true: 'a task to do', false: 'no task' } } };
  const request = await askLocal({ state: "Heard: \"Text Morgan that I'm running late.\"", questions: question }, settings);
  const chatter = await askLocal({ state: 'Heard: "So, let\'s go."', questions: question }, settings);
  server.close();
  assert.equal(request.served_by, 'chat-yes-no');
  assert.ok(request.answers.verdict.noul > 0.99, 'yes and Yes both count as yes');
  assert.ok(chatter.answers.verdict.noul < 0.01);
  assert.deepEqual({ model: asked[0].model, logprobs: asked[0].logprobs, temperature: asked[0].temperature, system: asked[0].messages[0].content }, { model: 'local-chat', logprobs: true, temperature: 0, system: 'Answer with one word: yes or no.' });
  assert.match(asked[0].messages[1].content, /Is there a task to do\? \(yes: a task to do; no: no task\)/);
});

test('yesShare reads the words a model said when it gives no probabilities, and nothing from neither', async () => {
  const { yesShare } = await import('../read-data/models-on-this-computer.mjs');
  assert.equal(yesShare({ message: { content: 'Yes.' } }), 1);
  assert.equal(yesShare({ message: { content: 'no' } }), 0);
  assert.equal(yesShare({ message: { content: 'maybe' } }), null);
});

test('models for this Mac: only models that fit are got, each through the server, and one it has is not got again', async () => {
  const { modelsForThisMac, localModelSettings } = await import('../read-data/models-on-this-computer.mjs');
  const have = new Set(['gemma3:4b']);
  const pulled = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') return response.end(JSON.stringify({ models: [...have].map(name => ({ name })) }));
      const { model } = JSON.parse(body);
      pulled.push(model); have.add(model);
      response.end(JSON.stringify({ status: 'success' }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const at = `http://127.0.0.1:${server.address().port}`;
  const real = localModelSettings();
  const settings = { ...real, disk_spare_gb: -1e9, server: { ...real.server, models: `${at}/api/tags`, pull: `${at}/api/pull` },
    offer: [{ id: 'small', model: 'gemma3:4b', job: 'a', min_memory_gb: 0, size_gb: 1 }, { id: 'mid', model: 'mid:1b', job: 'b', min_memory_gb: 0, size_gb: 1 }, { id: 'huge', model: 'huge:999b', job: 'c', min_memory_gb: 1e9, size_gb: 1 }] };
  try {
    const looked = await modelsForThisMac({}, settings);
    assert.equal(looked.server.running, true);
    assert.deepEqual(looked.models.map(model => [model.id, model.fits, model.have]), [['small', true, true], ['mid', true, false], ['huge', false, false]]);
    assert.ok(looked.mac.memory_gb > 0, 'the Mac says how much memory it has');
    const got = await modelsForThisMac({ get: 'fitting' }, settings);
    assert.deepEqual(pulled, ['mid:1b'], 'only the missing model that fits is downloaded');
    assert.deepEqual(got.got, [{ id: 'mid', done: true }]);
    const refused = await modelsForThisMac({ get: ['huge', 'nope'] }, settings);
    assert.deepEqual(refused.got.map(row => row.error), [settings.words.too_big, settings.words.not_offered]);
  } finally { server.close(); }
});


test('classifier receives its caller deadline while chat requests retain their protocol', async () => {
  const received = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      const deadline = request.headers['x-answer-within-seconds'];
      received.push({ body, deadline });
      response.setHeader('content-type', 'application/json');
      if (body.messages) return response.end(JSON.stringify({ choices: [{ message: { content: 'yes' } }] }));
      // The real classifier refuses a request when its own deadline elapses.
      // This bounded server uses milliseconds to exercise that HTTP contract.
      const patience = Number(deadline ?? 0.005);
      setTimeout(() => {
        response.statusCode = patience >= 0.025 ? 200 : 503;
        response.end(JSON.stringify(patience >= 0.025
          ? { answers: { reuse: { type: 'noul', noul: 0.9 } } }
          : { detail: 'decision did not answer within caller deadline' }));
      }, Math.min(patience * 1000, 25));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + server.address().port;
  const settings = { most_tokens: 10, words,
    classify: [{ id: 'deadline-classifier', url, timeout_seconds: 0.5 }],
    chat: [{ id: 'deadline-chat', url, model: 'chat', timeout_seconds: 0.5 }],
  };
  const input = { state: 'Existing shared owner is used.', questions: { reuse: { type: 'noul', instructions: 'Is the shared owner used?' } } };
  try {
    const classified = await askLocal(input, settings);
    assert.equal(classified.served_by, 'deadline-classifier');
    assert.equal(classified.answers.reuse.noul, 0.9);
    assert.equal(received[0].deadline, '0.5');
    assert.deepEqual(received[0].body, input);
    const chatted = await askLocal({ messages: [{ role: 'user', content: 'hello' }] }, settings);
    assert.equal(chatted.served_by, 'deadline-chat');
    assert.equal(received[1].deadline, undefined, 'the classifier header is not added to chat');
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});

// A yes-or-no question for a decision that was measured and wired to one judge (read-data/models-on-this-computer.json `wired`) is
// asked of that judge alone, so the judge that separated the cases is the one that answers; any other question keeps
// the first classifier that answers. 
test('a wired decision is asked of its own measured judge only', async () => {
  const asked = [];
  const judge = id => serve(() => { asked.push(id); return { answers: { verdict: { type: 'noul', noul: id === 'second' ? 0.9 : 0.1 } } }; });
  const [first, second] = await Promise.all([judge('first'), judge('second')]);
  const row = (id, server) => ({ id, url: `http://127.0.0.1:${server.address().port}/v1/systemone`, timeout_seconds: 2 });
  const settings = { words, chat: [], classify: [row('first', first), row('second', second)], wired: { 'a-decision': 'second' } };
  const question = { state: 'The words', questions: { verdict: { type: 'noul', instructions: 'Is it so?' } } };
  try {
    assert.equal((await askLocal({ job: 'a-decision', ...question }, settings)).served_by, 'second');
    assert.equal((await askLocal(question, settings)).served_by, 'first', 'an unwired question keeps the first classifier');
    assert.deepEqual(asked, ['second', 'first']);
    assert.match((await askLocal({ job: 'a-decision', ...question }, { ...settings, classify: [row('first', first)] })).error, /No model/, 'a wired judge that is not served answers nothing rather than another judge');
  } finally { first.close(); second.close(); }
});

test('the local model chat builds its streamed answer as keyed parts through askLocal', async () => {
  const { createServer } = await import('node:http');
  const { askLocal, localModelSettings } = await import('../read-data/models-on-this-computer.mjs');
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'text/event-stream');
    for (const piece of ['Trillion ', 'keeps ', 'records.']) response.write(`data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: piece } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const settings = { ...localModelSettings(), chat: [{ id: 'stand-in', model: 'm', url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, timeout_seconds: 5 }], jobs: {} };
    const reply = await askLocal({ messages: [{ role: 'user', content: 'hi' }], parts: true }, settings);
    assert.equal(reply.choices[0].message.content, 'Trillion keeps records.');
    assert.equal(reply.parts.answer.text, 'Trillion keeps records.');
    assert.equal(reply.seq, 3);
  } finally { server.close(); }
});

test('both rows run on the person\'s computer through run-an-export, with no capability and no internet', async () => {
  const { readFileSync } = await import('node:fs');
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  assert.deepEqual(rows.map(row => [row.id, row.invoke.argv.at(-1)]), [['tool:ask-a-model', 'ask'], ['tool:get-free-models', 'fit']]);
  const module = await import('../read-data/models-on-this-computer.mjs');
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.invoke.capabilities, []);
    assert.notEqual(row.invoke.internet, true);
    assert.deepEqual(row.placements, ['placement:your-computer']);
    assert.equal(row.result_selector, '$.result');
    assert.equal(row.invoke.argv[2], '/opt/models-on-this-computer/read-data/models-on-this-computer.mjs');
    assert.equal(typeof module[row.invoke.argv[3]], 'function');
  }
});

test('the shipped settings name every job\'s models, every wired judge and every offered model among the rows', async () => {
  const { localModelSettings } = await import('../read-data/models-on-this-computer.mjs');
  const settings = localModelSettings();
  const chat = new Set(settings.chat.map(row => row.id));
  for (const [id, job] of Object.entries(settings.jobs)) for (const model of job.models) assert.ok(chat.has(model), `${id} names ${model}`);
  for (const judge of Object.values(settings.wired)) assert.ok(settings.classify.some(row => row.id === judge), judge);
  const served = new Set([...settings.chat, ...settings.classify].map(row => row.model).filter(Boolean));
  for (const offer of settings.offer) assert.ok(served.has(offer.model), `${offer.id} answers at once once got`);
  assert.ok(settings.jobs.default, 'a conversation with no job has a default row');
});
