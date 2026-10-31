// Answer a set of typed questions about one state, in one request to a model
// served on the person's computer, and refuse a reply that does not answer
// every question in its declared type.
//
// questions: {<id>: {type: 'choice' | 'score' | 'noul', instructions, criteria?}}
//   choice  the answer is one of the names in `criteria` (an object of name to
//           what it means), or any non-empty string when there is no `criteria`
//   score   the answer is a number
//   noul    a yes/no question: the answer is the likelihood of yes, 0 to 1
//
// The state and the questions are written into the prompt text itself. Passing
// them only as template bindings leaves the rendered prompt saying "the
// supplied state" with nothing supplied, and the model answers that it
// received neither, in a reply that still satisfies the schema. The schema
// names every question id, because one that says only `answers: object` tells
// the model nothing about which keys to return, so it invents its own and the
// completeness check below fails on a reply that was otherwise correct.

import {VerdictRefused} from './ask-for-a-verdict.mjs'

const ANSWER_TYPES = {
  choice: question => (isRecord(question.criteria) && Object.keys(question.criteria).length > 0
    ? {type: 'string', enum: Object.keys(question.criteria)}
    : {type: 'string', minLength: 1}),
  score: () => ({type: 'number'}),
  noul: () => ({type: 'number', minimum: 0, maximum: 1}),
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function readQuestions(value) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new VerdictRefused('questions must be an object with at least one question, keyed by question id')
  }
  for (const [id, question] of Object.entries(value)) {
    if (!isRecord(question) || !Object.hasOwn(ANSWER_TYPES, question.type)) {
      throw new VerdictRefused(`questions.${id}.type must be one of: ${Object.keys(ANSWER_TYPES).join(', ')}`)
    }
    if (typeof question.instructions !== 'string' || !question.instructions.trim()) {
      throw new VerdictRefused(`questions.${id}.instructions is required`)
    }
  }
  return value
}

/** The JSON Schema the model is asked to answer in: one required key per question id. */
export function answerSchema(questions) {
  const properties = Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, ANSWER_TYPES[question.type](question)]))
  return {
    type: 'object',
    properties,
    required: Object.keys(questions),
    additionalProperties: false,
  }
}

export function promptFor(state, questions) {
  return [
    'Answer the typed questions about the state below.',
    'Return one answer for every question id, keyed by that id, as a JSON object. Nothing else.',
    '',
    'State:',
    JSON.stringify(state, null, 2),
    '',
    'Questions:',
    JSON.stringify(questions, null, 2),
  ].join('\n')
}

const describe = schema => schema.enum
  ? `one of: ${schema.enum.join(', ')}`
  : schema.type === 'number'
    ? `a number${schema.maximum === undefined ? '' : ` from ${schema.minimum} to ${schema.maximum}`}`
    : 'a non-empty string'

/** The answers, each checked against its question's type; anything missing or mistyped is refused. */
export function checkAnswers(questions, answers) {
  if (!isRecord(answers)) throw new VerdictRefused('the model did not reply with a JSON object of answers')
  for (const [id, question] of Object.entries(questions)) {
    if (!(id in answers)) throw new VerdictRefused(`the answer to question ${id} is missing`)
    const schema = ANSWER_TYPES[question.type](question)
    const given = answers[id]
    const ok = schema.type === 'number'
      ? typeof given === 'number' && Number.isFinite(given) && given >= (schema.minimum ?? -Infinity) && given <= (schema.maximum ?? Infinity)
      : typeof given === 'string' && given.trim() !== '' && (schema.enum === undefined || schema.enum.includes(given))
    if (!ok) throw new VerdictRefused(`the answer to question ${id} is not ${describe(schema)}`)
  }
  return Object.fromEntries(Object.keys(questions).map(id => [id, answers[id]]))
}

export async function answerStateQuestions({state, questions, endpoint, model, timeout_seconds}, post = fetch) {
  if (state === undefined || state === null) throw new VerdictRefused('state is required')
  if (typeof endpoint !== 'string' || typeof model !== 'string') {
    throw new VerdictRefused('endpoint and model are required: where the model server is and which model to ask')
  }
  if (typeof timeout_seconds !== 'number' || !Number.isFinite(timeout_seconds) || timeout_seconds <= 0) {
    throw new VerdictRefused('timeout_seconds is required: how many seconds the model server may take, as a number above zero')
  }
  const asked = readQuestions(questions)
  let reply
  try {
    reply = await post(`${endpoint}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeout_seconds * 1000),
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        model,
        stream: false,
        format: answerSchema(asked),
        messages: [{role: 'user', content: promptFor(state, asked)}],
      }),
    })
  } catch {
    throw new VerdictRefused(`the model server at ${endpoint} did not answer within ${timeout_seconds} seconds or could not be reached`)
  }
  if (!reply.ok) {
    throw new VerdictRefused(`the model server answered ${reply.status}; check that ${model} is served at ${endpoint}`)
  }
  let body
  try {
    body = await reply.json()
  } catch {
    throw new VerdictRefused('the model server did not reply with JSON')
  }
  let parsed
  try {
    parsed = JSON.parse(body?.message?.content)
  } catch {
    throw new VerdictRefused('the model did not reply with JSON')
  }
  return {model, answers: checkAnswers(asked, parsed)}
}
