// tools/ask-questions-sort-answers-follow-up/do-work/check-answers.mjs
//
// The Workshop tool "Check a person's answers against a form's questions". argv[2] is one JSON input:
//   { questions: [{ questionId, questionTypeId, label, required?, options?, validation? }], answers: { <questionId>: value } }
// Each question's type is looked up in the question-type rows (data/question-types.json); its rules, with the
// question's own overrides laid over them, decide whether the answer is valid. Prints one JSON line: each question's
// verdict and message, whether every answer is valid, and the first one that is not.
import { readFileSync } from 'node:fs';
import { buildFillScreenModel } from '../read-data/fill-screen-model.ts';
import { indexCapabilities } from '../read-data/question-descriptor.ts';

const registry = indexCapabilities(JSON.parse(readFileSync(new URL('../data/question-types.json', import.meta.url), 'utf8')).rows);

export function checkAnswers(input) {
  const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!object(input) || !Array.isArray(input.questions) || !input.questions.length) throw new Error('questions must be a list of the form\'s questions.');
  const unnamed = input.questions.findIndex(question => !object(question) || typeof question.questionId !== 'string' || typeof question.questionTypeId !== 'string');
  if (unnamed >= 0) throw new Error(`questions[${unnamed}] needs a questionId and a questionTypeId (${[...registry.keys()].join(', ')}).`);
  const answers = object(input.answers) ? input.answers : {};
  const model = buildFillScreenModel(input.questions, registry, answers, { revealErrors: true });
  return {
    all_valid: model.allValid,
    first_invalid: model.firstInvalidId,
    questions: model.rows.map(row => ({
      questionId: row.descriptor.questionId, label: row.descriptor.label ?? '', type: row.descriptor.questionTypeId,
      known_type: registry.has(row.descriptor.questionTypeId), answer: row.value ?? null, valid: row.valid, message: row.error,
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(checkAnswers(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
