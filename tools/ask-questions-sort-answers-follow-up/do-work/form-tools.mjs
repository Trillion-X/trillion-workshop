// tools/ask-questions-sort-answers-follow-up/do-work/form-tools.mjs
//
// The form tools. Each is a function of its input (tools/workflows/do-work/run-a-function.mjs calls fn(input)): it reads the
// person's rows it is given as `rows` and answers the rows it makes as `keep`, which the caller writes to the person's own
// database (read-data/kept-rows.mjs). Nothing here reaches a database.
//
//   saveForm            check a form's questions and keep its question-sequence row
//   submitFormAnswers   check a respondent's answers against the form given; when all are valid, answer as rows to keep the
//                       answer facts, the score and segment decision, and a request row for each question's after-saved
//                       hand-off, all together
//   readFormResults     the segment each respondent was sorted into, newest first, with a count per segment
//   readAnswerProgress  one respondent's answers over time, as ordered rows and a numeric trend
//   readAnswerLines     the latest answers of a form as prose lines, each labelled with its question
//
// Kinds of row read and made: question-sequence, answer-fact, segment-assignment, score-rule, segment-rule, follow-up-sequence,
// owner-action-request.
import { buildFillScreenModel } from '../read-data/fill-screen-model.ts';
import { resolveAbout } from '../read-data/question-descriptor.ts';
import { registry } from './check-answers.mjs';
import { holds } from './rule-engine.mjs';
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
import { givenRows, readRows } from '../read-data/kept-rows.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
};

export async function saveForm(input) {
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
  return { form_id: formId, record_id: write.id, question_count: input.questions.length, record: write, keep: [write] };
}

export async function submitFormAnswers(input) {
  if (!object(input)) throw new Error('Give form_id, respondent_id, answers and rows.');
  const given = givenRows(input);
  const formId = text(input.form_id, 'form_id');
  const respondentId = text(input.respondent_id, 'respondent_id');
  const answers = object(input.answers) ? input.answers : {};
  const submissionId = typeof input.submission_id === 'string' && input.submission_id ? input.submission_id : undefined;
  const answeredAt = typeof input.answered_at === 'string' && input.answered_at ? input.answered_at : new Date().toISOString();

  const [stored] = readRows(given, 'question-sequence', { id: questionSequenceId(formId) });
  const sequence = stored ? readFirstQuestionSequence(payloadRows([stored])) : null;
  if (!sequence) throw new Error(`The rows given hold no form ${formId} (${questionSequenceId(formId)}): give its question-sequence row, or make it with the save-a-form tool.`);

  const model = buildFillScreenModel(sequence.questions, registry, answers, { revealErrors: true, holds });
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

  const rules = [];
  for (const kind of ['score-rule', 'segment-rule', 'follow-up-sequence']) rules.push(...readRows(given, kind));
  const config = readDecideConfig(payloadRows(rules), formId);
  // An answer about a thing (a question with `about`) keeps the thing it was asked about.
  const abouts = Object.fromEntries(sequence.questions.filter(question => question.about && Object.hasOwn(kept, question.questionId))
    .map(question => [question.questionId, resolveAbout(question, sequence.questions, kept).about]));
  const plan = buildProcessSubmission(formId, respondentId, kept, config, answeredAt, submissionId, abouts);

  const requests = [];
  await runAfterSavedActions({ answers: kept, respondentId, runId: submissionId, sequence, now: new Date(answeredAt) }, async request => { requests.push(request); });
  const requestWrites = requests.map((request, index) => ({
    id: `owner-action-request:${formId}:${respondentId}:${submissionId ?? answeredAt}:${index}`,
    type: 'owner-action-request',
    value: { kind: 'owner-action-request', formId, respondentId, ...(submissionId ? { submissionId } : {}), owner: request.owner, actionRef: request.actionRef, input: request.input, status: 'requested', requested_at: answeredAt },
  }));

  const records = [...plan.writes, ...requestWrites];
  return {
    accepted: true,
    keep: records,
    decision: plan.decision,
    follow_up: plan.followUp,
    records,
    action_requests: requestWrites.map(write => ({ id: write.id, owner: write.value.owner, actionRef: write.value.actionRef })),
    ignored: Object.keys(answers).filter(id => !Object.hasOwn(kept, id)),
  };
}

export async function readFormResults(input) {
  const formId = typeof input?.form_id === 'string' && input.form_id ? input.form_id : undefined;
  return buildResultsModel(payloadRows(readRows(givenRows(input), 'segment-assignment', { formId })), formId);
}

export async function readAnswerProgress(input) {
  if (!object(input) || !object(input.field_map)) throw new Error('Give form_id, respondent_id and field_map (output field -> questionId).');
  const formId = text(input.form_id, 'form_id');
  const respondentId = text(input.respondent_id, 'respondent_id');
  return buildProgressModel(payloadRows(readRows(givenRows(input), 'answer-fact', { formId, respondentId })), {
    formId,
    respondentId,
    fieldMap: input.field_map,
    ...(typeof input.trend_field === 'string' && input.trend_field ? { trendField: input.trend_field } : {}),
  });
}

export async function readAnswerLines(input) {
  const formId = text(object(input) ? input.form_id : undefined, 'form_id');
  const respondentId = typeof input.respondent_id === 'string' && input.respondent_id ? input.respondent_id : undefined;
  const given = givenRows(input);
  const facts = readRows(given, 'answer-fact', { formId, respondentId });
  const forms = readRows(given, 'question-sequence', { id: questionSequenceId(formId) });
  return { lines: answerLinesForSequence(payloadRows([...facts, ...forms]), formId) };
}
