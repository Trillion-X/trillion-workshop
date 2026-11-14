import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

function readQuestions(value: unknown) {
  const entries = record(value, 'questions');
  if (Object.keys(entries).length === 0) throw new Error('questions must not be empty.');
  for (const [id, raw] of Object.entries(entries)) {
    const question = record(raw, `questions.${id}`);
    if (!['choice', 'score', 'noul'].includes(String(question.type))) throw new Error(`questions.${id}.type is unsupported.`);
    if (typeof question.instructions !== 'string' || !question.instructions.trim()) throw new Error(`questions.${id}.instructions is required.`);
  }
  return entries;
}

function unwrap(value: unknown) {
  const outer = record(value, 'model response');
  const payload = 'payload' in outer ? outer.payload : outer;
  if (payload instanceof Uint8Array) return record(JSON.parse(new TextDecoder().decode(payload)), 'model response payload');
  if (typeof payload === 'string') return record(JSON.parse(payload), 'model response payload');
  return record(payload, 'model response payload');
}

// The schema names every question id the caller asked about. A schema that says
// only `answers: object` tells the model nothing about which keys to return, so
// it invents its own and the completeness check below fails on a reply that was
// otherwise correct. Naming the ids is what makes the reply checkable.
const ANSWER_SHAPE_BY_QUESTION_TYPE: Record<string, JsonRecord> = {
  choice: { type: 'string', minLength: 1 },
  score: { type: 'number' },
  noul: { type: 'string', minLength: 1 },
};

function buildResponseSchema(questions: JsonRecord) {
  const properties: JsonRecord = {};
  for (const [id, raw] of Object.entries(questions)) {
    const type = String(record(raw, `questions.${id}`).type);
    properties[id] = ANSWER_SHAPE_BY_QUESTION_TYPE[type] ?? {};
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['model', 'answers'],
    properties: {
      model: { type: 'string', minLength: 1 },
      answers: {
        type: 'object',
        required: Object.keys(questions),
        properties,
        additionalProperties: false,
      },
      usage: { type: 'object' },
    },
    additionalProperties: true,
  };
}

export async function answerStateQuestions(value: unknown) {
  const input = record(value, 'typed question request');
  if (input.state === undefined || input.state === null) throw new Error('state is required.');
  const questions = readQuestions(input.questions);
  const reply = unwrap(await sendRequestToBitfieldTarget({
    target: 'model-response.request-model-response',
    payload: {
      // The state and the questions are written into the prompt text itself.
      // Passing them only as template bindings left the rendered prompt saying
      // "the supplied state" with nothing supplied, and the model answered that
      // it had received neither, in a reply that still satisfied the schema.
      body: [
        'Answer the typed questions about the state below.',
        'Return one answer for every question id, keyed by that id.',
        '',
        'State:',
        JSON.stringify(input.state, null, 2),
        '',
        'Questions:',
        JSON.stringify(questions, null, 2),
      ].join('\n'),
      request: {
        required_capabilities: ['typed-state-questions'],
        prompt_template: '{{body}}',
        template_bindings: { state: input.state, questions },
        response_schema: buildResponseSchema(questions),
        response_schema_ref: 'schema:typed-state-question-answers',
      },
      thread_ref: typeof input.thread_ref === 'string' && input.thread_ref ? input.thread_ref : 'typed-state-questions',
    },
  }));
  const message = record(reply.message, 'model response message');
  const structured = record(message.structured_response, 'model response structured_response');
  const result = record(structured.value, 'typed question result');
  const answers = record(result.answers, 'typed question answers');
  for (const id of Object.keys(questions)) if (!(id in answers)) throw new Error(`typed question answer ${id} is missing.`);
  return { model: message.model_ref, provider: message.provider_ref, answers, ...(result.usage === undefined ? {} : { usage: result.usage }) };
}
