// Typed questions about a state: the schema names every question id, and a reply
// that leaves one out or answers it in the wrong type is refused. No server.
import test from 'node:test'
import assert from 'node:assert/strict'
import {answerSchema, answerStateQuestions, checkAnswers, promptFor, readQuestions} from '../do-work/answer-state-questions.mjs'
import {VerdictRefused} from '../do-work/ask-for-a-verdict.mjs'

const questions = {
  urgent: {type: 'noul', instructions: 'Is the delivery late?'},
  loaf: {type: 'choice', instructions: 'Which loaf?', criteria: {rye: 'dark', white: 'light'}},
  note: {type: 'choice', instructions: 'Say which shelf.'},
  rush: {type: 'score', instructions: 'How rushed?'},
}

test('the schema names every question id so the model cannot invent its own keys', () => {
  const schema = answerSchema(questions)
  assert.deepEqual(schema.required, ['urgent', 'loaf', 'note', 'rush'])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.loaf, {type: 'string', enum: ['rye', 'white']})
  assert.deepEqual(schema.properties.note, {type: 'string', minLength: 1})
  assert.deepEqual(schema.properties.urgent, {type: 'number', minimum: 0, maximum: 1})
})

test('the state and the questions are written into the prompt itself, not left as bindings', () => {
  const prompt = promptFor({shelf: 'top'}, questions)
  assert.match(prompt, /"shelf": "top"/)
  assert.match(prompt, /Is the delivery late\?/)
})

test('questions must be a non-empty object of known types with instructions', () => {
  assert.throws(() => readQuestions({}), VerdictRefused)
  assert.throws(() => readQuestions([]), VerdictRefused)
  assert.throws(() => readQuestions({a: {type: 'essay', instructions: 'x'}}), /questions\.a\.type must be one of/)
  assert.throws(() => readQuestions({a: {type: 'score', instructions: ' '}}), /instructions is required/)
})

test('answers are checked one by one and only the asked ids are returned', () => {
  const given = {urgent: 0.2, loaf: 'rye', note: 'top', rush: 4, extra: 'ignored'}
  assert.deepEqual(checkAnswers(questions, given), {urgent: 0.2, loaf: 'rye', note: 'top', rush: 4})
  assert.throws(() => checkAnswers(questions, {...given, loaf: 'seeded'}), /question loaf is not one of: rye, white/)
  assert.throws(() => checkAnswers(questions, {...given, rush: '4'}), /question rush is not a number/)
  assert.throws(() => checkAnswers(questions, {...given, note: ' '}), /question note is not a non-empty string/)
  assert.throws(() => checkAnswers(questions, null), /JSON object/)
})

const asking = {state: 1, questions, endpoint: 'http://x', model: 'm', timeout_seconds: 30}

test('asking needs a state, an endpoint, a model and a time limit, and nothing is guessed', async () => {
  await assert.rejects(answerStateQuestions({questions}), /state is required/)
  await assert.rejects(answerStateQuestions({state: 1, questions}), /endpoint and model are required/)
  await assert.rejects(answerStateQuestions({state: 1, questions, endpoint: 'http://x', model: 'm'}), /timeout_seconds is required/)
  await assert.rejects(answerStateQuestions({...asking, questions: {}}), VerdictRefused)
})

test('a time limit that is not a number above zero is refused in a sentence, not thrown as a type error', async () => {
  for (const bad of ['soon', '30', 0, -5, NaN, null, Infinity]) {
    await assert.rejects(answerStateQuestions({...asking, timeout_seconds: bad}), error => error instanceof VerdictRefused && /timeout_seconds is required/.test(error.message), String(bad))
  }
})

test('a reply that is not JSON is refused', async () => {
  const post = async () => ({ok: true, json: async () => ({message: {content: 'sure, it is rye'}})})
  await assert.rejects(answerStateQuestions(asking, post), /did not reply with JSON/)
})

test('an error status from the server is reported as that, not as a reply that was not JSON', async () => {
  const failing = status => async () => ({ok: false, status, json: async () => ({error: 'model not found'})})
  await assert.rejects(answerStateQuestions(asking, failing(404)), error => error instanceof VerdictRefused && /answered 404.*m is served at http:\/\/x/.test(error.message))
  await assert.rejects(answerStateQuestions(asking, failing(500)), /answered 500/)
})

test('a body that is not JSON and a server that cannot be reached are each refused in a sentence', async () => {
  const garbled = async () => ({ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token') }})
  await assert.rejects(answerStateQuestions(asking, garbled), error => error instanceof VerdictRefused && /server did not reply with JSON/.test(error.message))
  const unreachable = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(answerStateQuestions(asking, unreachable), error => error instanceof VerdictRefused && /could not be reached/.test(error.message))
})
