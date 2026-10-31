// The provider adapters read where to reach a model, and the key, only from the
// provider row the person gave. Nothing comes from the environment or a default.
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {candidates as hostedCandidates, ask as askHosted} from '../do-work/ask-a-hosted-classifier.mjs'
import {classifiersFrom, providersIn, whoCanBeAsked} from '../do-work/who-can-be-asked.mjs'
import {VerdictRefused} from '../do-work/ask-for-a-verdict.mjs'

const keyFile = contents => {
  const path = join(mkdtempSync(join(tmpdir(), 'key-')), 'key.txt')
  writeFileSync(path, contents)
  return path
}
const row = {endpoint: 'https://classifier.example.invalid/v1', model: 'small-judge'}

test('a hosted classifier offers nothing without an endpoint, a model and a key the row points at', async () => {
  assert.deepEqual(await hostedCandidates({...row}), [])
  assert.deepEqual(await hostedCandidates({key_file: keyFile('k'), model: 'm'}), [])
  assert.deepEqual(await hostedCandidates({key_file: keyFile('k'), endpoint: 'https://x'}), [])
  assert.deepEqual(await hostedCandidates({...row, key_file: '/nonexistent/key.txt'}), [])
  assert.deepEqual(await hostedCandidates({...row, key_file: keyFile('  \n')}), [])
})

test('the key is read from the named file and sent as a bearer token, and the request never carries it', async () => {
  const [offered] = await hostedCandidates({...row, key_file: keyFile('secret-value\n'), accepts_characters: 500, samples: 1})
  assert.equal(offered.name, 'small-judge')
  assert.equal(offered.accepts_characters, 500)
  assert.equal(offered.reach.credential, 'secret-value')
  let sent
  const answer = await askHosted(
    {candidate: offered, question: 'is it ready', shape: {kind: 'true-or-false'}, content: 'ready'},
    async (url, request) => {
      sent = {url, request}
      return {ok: true, status: 200, headers: new Headers(), json: async () => ({answers: {verdict: {noul: 0.9}}})}
    },
  )
  assert.equal(answer.answer, true)
  assert.equal(sent.url, row.endpoint)
  assert.equal(sent.request.headers.authorization, 'Bearer secret-value')
  assert.ok(!sent.request.body.includes('secret-value'))
  assert.equal(JSON.parse(sent.request.body).model, 'small-judge')
})

test('a server on the person\'s own computer can say it needs no key', async () => {
  const [offered] = await hostedCandidates({...row, needs_no_key: true})
  assert.equal(offered.reach.credential, 'not-needed')
})

test('no provider rows is refused with the row to add; a bare adapter name is a row; an unknown adapter offers nothing', async () => {
  assert.throws(() => providersIn({ask_in_order: []}), VerdictRefused)
  assert.throws(() => providersIn({}), /provider row is required/)
  assert.deepEqual(providersIn({ask_in_order: ['made-up']}), [{via: 'made-up'}])
  assert.deepEqual(await whoCanBeAsked({ask_in_order: [{via: 'made-up'}]}), [])
})

test('a row with no address, time limit or sample count is refused naming the field; nothing is filled in', () => {
  const needs = (row, field) => assert.throws(() => providersIn({ask_in_order: [row]}), error => error instanceof VerdictRefused && error.message.includes(`provider row 1 (${typeof row === 'string' ? row : row.via}) needs ${field}`))
  needs('locally-served', 'endpoint')
  needs({via: 'locally-served', endpoint: ' '}, 'endpoint')
  needs({via: 'locally-served', endpoint: 'http://x'}, 'timeout_seconds')
  needs({via: 'locally-served', endpoint: 'http://x', timeout_seconds: '3'}, 'timeout_seconds')
  needs({via: 'locally-served', endpoint: 'http://x', timeout_seconds: 0}, 'timeout_seconds')
  needs({via: 'hosted-classifier', model: 'm', samples: 2}, 'endpoint')
  needs({via: 'hosted-classifier', endpoint: 'https://x', samples: 2}, 'model')
  needs({via: 'hosted-classifier', endpoint: 'https://x', model: 'm'}, 'samples')
  needs({via: 'hosted-classifier', endpoint: 'https://x', model: 'm', samples: 0}, 'samples')
  const whole = {via: 'locally-served', endpoint: 'http://x', timeout_seconds: 3}
  assert.deepEqual(providersIn({ask_in_order: [whole]}), [whole])
})

test('a hosted candidate with no sample count is refused when asked, not given a count of its own', async () => {
  const [offered] = await hostedCandidates({...row, needs_no_key: true})
  await assert.rejects(askHosted({candidate: offered, question: 'q', shape: {kind: 'true-or-false'}, content: 'c'}, async () => { throw new Error('should not be sent') }), /samples is required/)
})

test('a calibration run gets the row\'s own longer time limit, and asking does not', async () => {
  const providers = [{via: 'hosted-classifier', ...row, needs_no_key: true, samples: 1, timeout_seconds: 3, calibration_timeout_seconds: 90}]
  const [calibrating] = await whoCanBeAsked({ask_in_order: providers}, {phase: 'calibration'})
  const [asking] = await whoCanBeAsked({ask_in_order: providers})
  assert.equal(calibrating.candidate.reach.timeoutSeconds, 90)
  assert.equal(asking.candidate.reach.timeoutSeconds, 3)
})

test('the one ask sends each question to the adapter that offered the candidate, and refuses a candidate it did not offer', async () => {
  const {candidates, ask} = await classifiersFrom({ask_in_order: [{via: 'hosted-classifier', ...row, needs_no_key: true, samples: 1}]})
  assert.equal(candidates.length, 1)
  assert.throws(() => ask({candidate: {name: 'someone-else'}}), VerdictRefused)
})
