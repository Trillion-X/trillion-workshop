// tools/ask-questions-sort-answers-follow-up/do-work/forms-on-the-records-door.mjs
//
// The tools that keep a form's questions, answers and decisions as the person's own records, through the records
// door (tools/records-door). Each export is called by run-an-export.mjs as fn(input, { door }).
//
//   saveForm            write one form (a question-sequence record)
//   submitFormAnswers   check a respondent's answers against the saved form; when all are valid, write the answer
//                       facts, the score and segment decision, and a request record for each question's after-saved
//                       hand-off, together in one write
//   readFormResults     the segment each respondent was sorted into, newest first, with a count per segment
//   readAnswerProgress  one respondent's answers over time, as ordered rows and a numeric trend
//   readAnswerLines     the latest answers of a form as prose lines, each labelled with its question
//
// The pure logic (the form checker, scoring, the record builders, the folds) is the package's, unchanged; this
// file is the seam that reads and writes records. Record types: question-sequence, answer-fact,
// segment-assignment, score-rule, segment-rule, follow-up-sequence, owner-action-request.
import { buildFillScreenModel } from '../read-data/fill-screen-model.ts';
import { registry } from './check-answers.mjs';
import { coerceAnswer } from '../read-data/validate-answer.ts';
import { readFirstQuestionSequence } from '../read-data/read-forms-data.ts';
import { readDecideConfig } from '../read-data/read-decide-config.ts';
import { buildResultsModel } from '../read-data/results-model.ts';
import { buildProgressModel } from '../read-data/progress-model.ts';
import { answerLinesForSequence } from '../read-data/synthesis-answer-lines.ts';
import { payloadRows } from '../read-data/record-rows.ts';
import { buildSaveQuestionSequenceWrite, questionSequenceId } from './save-question-sequence.ts';
import { buildProcessSubmission } from './process-submission.ts';
import { runAfterSavedActions } from './run-after-saved-actions.ts';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
};

async function listAll(door, type, prefix) {
  const found = [];
  for await (const record of door.list(prefix === undefined ? { type } : { type, prefix })) found.push(record);
  return found;
}

export async function saveForm(input, { door }) {
  if (!object(input)) throw new Error('Give form_id, title and questions.');
  const formId = text(input.form_id, 'form_id');
  if (!Array.isArray(input.questions) || !input.questions.length) throw new Error('questions must be a list of the form\'s questions.');
  const unnamed = input.questions.findIndex(question => !object(question) || typeof question.questionId !== 'string' || typeof question.questionTypeId !== 'string');
  if (unnamed >= 0) throw new Error(`questions[${unnamed}] needs a questionId and a questionTypeId (${[...registry.keys()].join(', ')}).`);
  const write = buildSaveQuestionSequenceWrite({
    formId,
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : formId,
    ...(object(input.presentation) ? { presentation: input.presentation } : {}),
    questions: input.questions,
  });
  await door.write([write]);
  return { saved: true, form_id: formId, record_id: write.id, question_count: input.questions.length };
}

export async function submitFormAnswers(input, { door }) {
  if (!object(input)) throw new Error('Give form_id, respondent_id and answers.');
  const formId = text(input.form_id, 'form_id');
  const respondentId = text(input.respondent_id, 'respondent_id');
  const answers = object(input.answers) ? input.answers : {};
  const submissionId = typeof input.submission_id === 'string' && input.submission_id ? input.submission_id : undefined;
  const answeredAt = typeof input.answered_at === 'string' && input.answered_at ? input.answered_at : new Date().toISOString();

  const stored = await door.read('question-sequence', questionSequenceId(formId));
  const sequence = stored ? readFirstQuestionSequence([{ payload: stored }]) : null;
  if (!sequence) throw new Error(`No saved form ${formId}: save it first with the save-a-form tool.`);

  const model = buildFillScreenModel(sequence.questions, registry, answers, { revealErrors: true });
  if (!model.allValid) {
    return {
      accepted: false,
      first_invalid: model.firstInvalidId,
      questions: model.rows.map(row => ({ questionId: row.descriptor.questionId, valid: row.valid, message: row.error })),
    };
  }

  // Only the form's own questions are recorded, each as its type coerces it.
  const kept = {};
  for (const row of model.rows) {
    const id = row.descriptor.questionId;
    if (!Object.hasOwn(answers, id)) continue;
    const coerced = coerceAnswer(answers[id], row.coerce);
    const value = coerced.ok ? coerced.value : answers[id];
    if (value !== undefined) kept[id] = value;
  }

  const rules = await Promise.all(['score-rule', 'segment-rule', 'follow-up-sequence'].map(type => listAll(door, type)));
  const config = readDecideConfig(payloadRows(rules.flat()), formId);
  const plan = buildProcessSubmission(formId, respondentId, kept, config, answeredAt, submissionId);

  const requests = [];
  await runAfterSavedActions({ answers: kept, respondentId, runId: submissionId, sequence, now: new Date(answeredAt) }, async request => { requests.push(request); });
  const requestWrites = requests.map((request, index) => ({
    id: `owner-action-request:${formId}:${respondentId}:${submissionId ?? answeredAt}:${index}`,
    type: 'owner-action-request',
    value: { kind: 'owner-action-request', formId, respondentId, ...(submissionId ? { submissionId } : {}), owner: request.owner, actionRef: request.actionRef, input: request.input, status: 'requested', requested_at: answeredAt },
  }));

  const writes = [...plan.writes, ...requestWrites];
  await door.write(writes);
  return {
    accepted: true,
    decision: plan.decision,
    follow_up: plan.followUp,
    written: writes.length,
    action_requests: requestWrites.map(write => ({ id: write.id, owner: write.value.owner, actionRef: write.value.actionRef })),
    ignored: Object.keys(answers).filter(id => !Object.hasOwn(kept, id)),
  };
}

export async function readFormResults(input, { door }) {
  const formId = object(input) && typeof input.form_id === 'string' && input.form_id ? input.form_id : undefined;
  const records = await listAll(door, 'segment-assignment', formId ? `segment-assignment:${formId}:` : undefined);
  return buildResultsModel(payloadRows(records), formId);
}

export async function readAnswerProgress(input, { door }) {
  if (!object(input) || !object(input.field_map)) throw new Error('Give form_id, respondent_id and field_map (output field -> questionId).');
  const formId = text(input.form_id, 'form_id');
  const respondentId = text(input.respondent_id, 'respondent_id');
  const records = await listAll(door, 'answer-fact', `answer-fact:${formId}:${respondentId}:`);
  return buildProgressModel(payloadRows(records), {
    formId,
    respondentId,
    fieldMap: input.field_map,
    ...(typeof input.trend_field === 'string' && input.trend_field ? { trendField: input.trend_field } : {}),
  });
}

export async function readAnswerLines(input, { door }) {
  const formId = text(object(input) ? input.form_id : undefined, 'form_id');
  const respondentId = object(input) && typeof input.respondent_id === 'string' && input.respondent_id ? input.respondent_id : undefined;
  const [facts, forms] = await Promise.all([
    listAll(door, 'answer-fact', `answer-fact:${formId}:${respondentId ? `${respondentId}:` : ''}`),
    listAll(door, 'question-sequence', questionSequenceId(formId)),
  ]);
  return { lines: answerLinesForSequence(payloadRows([...facts, ...forms]), formId) };
}
