// Calibration is done once, away from the question, and kept; a question only
// reads what was kept. Synthetic judges, no server.
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {chooseCandidate, checkRubric, NotCalibratedYet, VerdictRefused, rememberedIn, calibrationKey} from '../do-work/ask-for-a-verdict.mjs'
import {candidates as localCandidates} from '../do-work/ask-a-locally-served-model.mjs'

const rubric = checkRubric({
  id: 'claims',
  question: 'Does it claim something is done without showing it?',
  answer_shape: {kind: 'true-or-false'},
  calibration: [{content: 'done, trust me', expect: true}, {content: 'ran it: 3 pass', expect: false}],
})
const judges = [{name: 'right'}, {name: 'wrong'}]
const scratch = () => rememberedIn(join(mkdtempSync(join(tmpdir(), 'judges-')), 'kept.json'))
const truthful = async ({candidate, content}) => ({answer: candidate.name === 'right' ? content.includes('trust') : true})

test('a question that only reads calibration, with nothing kept, refuses at once and asks nobody', async () => {
  let asked = 0
  await assert.rejects(
    chooseCandidate({candidates: judges, rubric, ask: async () => { asked += 1; return {answer: true} }, passes: 1, remember: scratch(), calibrate: false}),
    NotCalibratedYet,
  )
  assert.equal(asked, 0)
})

test('what a separate calibration run kept is what the question uses, without asking anything again', async () => {
  const kept = scratch()
  const first = await chooseCandidate({candidates: judges, rubric, ask: truthful, passes: 1, remember: kept})
  assert.equal(first.chosen.name, 'right')
  let asked = 0
  const later = await chooseCandidate({candidates: judges, rubric, ask: async () => { asked += 1 }, passes: 1, remember: kept, calibrate: false})
  assert.equal(later.chosen.name, 'right')
  assert.equal(asked, 0)
})

test('when every judge was measured and lost, the reader is told so instead of "not calibrated"', async () => {
  const kept = scratch()
  const lying = async () => ({answer: true})
  await assert.rejects(chooseCandidate({candidates: judges, rubric, ask: lying, passes: 1, remember: kept}), VerdictRefused)
  await assert.rejects(
    chooseCandidate({candidates: judges, rubric, ask: lying, passes: 1, remember: kept, calibrate: false}),
    error => error instanceof VerdictRefused && !(error instanceof NotCalibratedYet),
  )
})

test('a judge that could not be reached is measured again next run; one that answered too slowly is a real loss', async () => {
  const kept = scratch()
  const key = calibrationKey(rubric, judges, 1)
  kept.set(key, {chosen: null, scoreboard: [
    {candidate: 'right', passed: false, errors: 2, first_error: 'ECONNREFUSED'},
    {candidate: 'wrong', passed: false, errors: 2, first_error: 'TimeoutError'},
  ]})
  const asked = []
  const {chosen} = await chooseCandidate({candidates: judges, rubric, ask: async args => { asked.push(args.candidate.name); return truthful(args) }, passes: 1, remember: kept})
  assert.equal(chosen.name, 'right')
  assert.ok(!asked.includes('wrong'))
})

test('only models the server says can complete text are offered as judges', async () => {
  const served = {models: [
    {name: 'an-embedder', size: 1, capabilities: ['embedding']},
    {name: 'a-chat-model', size: 2, capabilities: ['completion', 'tools']},
    {name: 'too-big', size: 30, capabilities: ['completion']},
    {name: 'undescribed', size: 3},
  ]}
  const offered = await localCandidates({endpoint: 'http://x', timeout_seconds: 7, protocol: 'ollama', most_bytes: 10}, async () => served)
  assert.deepEqual(offered.map(one => one.name), ['a-chat-model', 'undescribed'])
  assert.deepEqual(offered[0].reach, {endpoint: 'http://x', timeoutSeconds: 7, protocol: 'ollama'})
  assert.ok(offered.every(one => one.accepts_characters === undefined))
  const limited = await localCandidates({endpoint: 'http://x', timeout_seconds: 7, protocol: 'ollama', accepts_characters: 400}, async () => served)
  assert.ok(limited.every(one => one.accepts_characters === 400))
})
