// fit-lines on made-up scores (the expected numbers were computed with the original Python calibration on the same
// scores), and the fresh local fetch against an in-process stand-in server.
import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {auc, fitLines, quantile, sentences} from '../do-work/fit-pass-and-fail-lines.mjs'
import {freshLocalClassifierFetch} from '../do-work/fresh-local-classifier-fetch.mjs'
import {ask} from '../do-work/ask-a-locally-served-model.mjs'

const entry = new URL('../do-work/ask-a-small-model.mjs', import.meta.url).pathname
const bars = {fail_good_share_at_most: 0.05, pass_bad_share_at_most: 0.10,
  usable_when: {auc_at_least: 0.75, bad_lines_at_least: 6, recall_at_least: 0.25, good_failed_or_uncertain_at_most: 0.35}}
const separated = {bad: [0.95, 0.9, 0.85, 0.97, 0.99, 0.92, 0.88], good: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05]}

test('fit-lines: well separated scores give two lines and a usable question, with held-out shares', () => {
  const found = fitLines({...separated, ...bars})
  assert.equal(found.status, 'usable')
  assert.deepEqual({auc: found.auc, t_pass: found.t_pass, t_fail: found.t_fail, recall: found.recall,
    good_failed: found.good_failed_held_out, loose: found.good_failed_or_uncertain_held_out, n_bad: found.n_bad, n_good: found.n_good},
  {auc: 0.964, t_pass: 0.85, t_fail: 0.9, recall: 0.571, good_failed: 0.1, loose: 0.1, n_bad: 7, n_good: 10})
  assert.equal(found.reason, undefined)
})

test('fit-lines: overlapping scores are unseparable, with every bar that failed named', () => {
  const found = fitLines({bad: [0.6, 0.4, 0.7], good: [0.5, 0.65, 0.3, 0.45], ...bars})
  assert.equal(found.status, 'unseparable')
  assert.equal(found.auc, 0.667)
  assert.equal(found.t_pass, 0.4)
  assert.equal(found.t_fail, 0.65)
  assert.equal(found.good_failed_held_out, 0.25)
  assert.equal(found.reason, 'AUC 0.67 < 0.75; only 3 bad lines; 75% of good lines fail or escalate')
})

test('fit-lines: a line scored per sentence counts its highest sentence; an unanswered line is left out', () => {
  const bad = separated.bad.map(score => [0.01, score, null])
  const found = fitLines({bad: [...bad, null, [null]], good: [...separated.good, null], ...bars})
  assert.equal(found.n_bad, 7)
  assert.equal(found.n_good, 10)
  assert.equal(found.t_fail, 0.9)
  const few = fitLines({bad: [0.9, null], good: [0.1], ...bars})
  assert.deepEqual(few, {status: 'unseparable', reason: 'only 1 bad lines and 1 good lines with answers'})
})

test('fit-lines: every bar is the caller\'s, and a missing or impossible one is refused by name', () => {
  assert.throws(() => fitLines({...separated, ...bars, fail_good_share_at_most: undefined}), /fail_good_share_at_most is required/)
  assert.throws(() => fitLines({...separated, ...bars, pass_bad_share_at_most: 1.5}), /pass_bad_share_at_most is required/)
  assert.throws(() => fitLines({...separated, ...bars, usable_when: {...bars.usable_when, bad_lines_at_least: 1}}), /bad_lines_at_least is required/)
  assert.throws(() => fitLines({...bars, good: separated.good}), /bad and good are required/)
  assert.throws(() => fitLines({...separated, ...bars, bad: [...separated.bad, 'high']}), /bad\[7\] must be a probability/)
})

test('fit-lines helpers: AUC counts ties as half, quantile is by index, sentences keep their closing marks', () => {
  assert.equal(auc([0.5, 0.9], [0.5, 0.1]), (0.5 + 1 + 1 + 1) / 4)
  assert.equal(quantile([3, 1, 2, 4], 0.95), 4)
  assert.equal(quantile([3, 1, 2, 4], 0), 1)
  assert.deepEqual(sentences('First one. Second? "Third!" tail'), ['First one.', 'Second?', '"Third!"', 'tail'])
  assert.deepEqual(sentences('no break'), ['no break'])
})

test('fit-lines as the tool runs it: one JSON request in, { result } on the last line', async () => {
  const output = await new Promise(resolve => {
    const child = execFile(process.execPath, [entry, 'fit-lines'], (_, stdout) => resolve(stdout))
    child.stdin.end(JSON.stringify({...separated, ...bars}))
  })
  const last = JSON.parse(output.trim().split('\n').at(-1))
  assert.equal(last.result.status, 'usable')
  assert.equal(last.result.t_fail, 0.9)
})

async function standIn(reply) {
  const seen = []
  const sockets = new Set()
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    sockets.add(request.socket)
    seen.push({path: request.url, method: request.method, connection: request.headers.connection,
      contentType: request.headers['content-type'], body: Buffer.concat(chunks)})
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(reply))
  })
  server.keepAliveTimeout = 100
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  return {origin: `http://127.0.0.1:${server.address().port}`, seen, sockets, close}
}

test('fresh local fetch: health and inference close their connections and keep the exact request bytes', async () => {
  const server = await standIn({received: true})
  const body = JSON.stringify({model: 'stand-in', state: 'A lantern hums. É × 4', questions: {}})
  try {
    await (await freshLocalClassifierFetch(`${server.origin}/health`)).json()
    // Stand in for the slow local work between two inference calls.
    await new Promise(resolve => setTimeout(resolve, 200))
    await (await freshLocalClassifierFetch(`${server.origin}/v1/answer`, {
      method: 'POST', headers: {'content-type': 'application/json'}, body,
    })).json()
    assert.deepEqual(server.seen.map(row => row.connection), ['close', 'close'])
    assert.equal(server.sockets.size, 2)
    assert.equal(server.seen[0].method, 'GET')
    assert.equal(server.seen[1].contentType, 'application/json')
    assert.deepEqual(server.seen[1].body, Buffer.from(body))
  } finally {
    await server.close()
  }
})

test('the locally-served adapter asks over a fresh connection by default', async () => {
  const server = await standIn({message: {content: '{"answer": true}'}})
  try {
    const answer = await ask({candidate: {name: 'stand-in', reach: {endpoint: server.origin, timeoutSeconds: 5, protocol: 'ollama'}},
      question: 'Is the kettle on?', shape: {kind: 'true-or-false'}, content: 'The kettle whistles.'})
    assert.deepEqual(answer, {answer: true, confidence: null, distribution: null})
    assert.equal(server.seen[0].path, '/api/chat')
    assert.equal(server.seen[0].connection, 'close')
  } finally {
    await server.close()
  }
})
