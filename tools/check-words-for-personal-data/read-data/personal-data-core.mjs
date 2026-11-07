// tools/check-words-for-personal-data/read-data/personal-data.mjs (moved from Trillion computer/personal-data.mjs)
//
// Purpose: before words (or a file's words) go to a model that is not on this Mac, ask this Mac whether they hold
// personal data, and offer the person the choice: send as it is, do it on this Mac only, or keep it back. The check
// itself never leaves the Mac.
//
// Non-negotiable invariants
//   1. Shapes, questions, threshold and choices are DATA (read-data/personal-data.json); this file names no kind of data.
//   2. Two layers: rules (always) and a model on this Mac (when use_model is on and one answers). A model that does not
//      answer is said in words and never counts as "nothing found" for the questions it was asked.
//   3. Only counts and kinds are answered, never the matched text itself, so the answer carries nothing it checked.
//   4. The check is advice: it changes nothing and gates nothing; the person's choice is made by the caller.
//
// The model on this computer is asked through tools/ask-a-small-model-for-a-verdict (answer-state-questions.mjs), with
// the `model` the input names ({ endpoint, model, timeout_seconds }); with none named, only the rules run and the answer says so.
//
// USAGE
//   node /opt/records-door/do-work/run-an-export.mjs /opt/check-words-for-personal-data/read-data/personal-data.mjs check
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerStateQuestions } from '../../ask-a-small-model-for-a-verdict/do-work/answer-state-questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const personalDataSettings = () => JSON.parse(readFileSync(join(HERE, 'personal-data.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** The model on this computer the input names, asked the state questions; with none named, an answer that says so. */
const askNamed = (settings, model) => async body => (model ? answerStateQuestions({ ...body, ...model }) : { error: settings.words.no_model });

/** Whether a digit string passes the Luhn checksum. */
export function luhn(digits) {
  let sum = 0, double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) { n *= 2; if (n > 9) n -= 9; }
    sum += n; double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** → { contains, kinds: [{ kind, how: 'rule' | 'model', count?, share? }], model_checked, choices, said? } */
export async function checkPersonalData(input = {}, { settings = personalDataSettings(), ask = askNamed(settings, input.model) } = {}) {
  if (typeof input.text !== 'string' || !input.text.trim()) throw Object.assign(new Error(settings.words.needs_text), { status: 400 });
  const text = input.text.slice(0, settings.sample_chars);
  const kinds = [];
  for (const rule of settings.patterns) {
    let count = 0;
    for (const match of text.matchAll(new RegExp(rule.regex, rule.flags ?? 'g'))) {
      if (rule.luhn && !luhn(match[0].replace(/\D/g, ''))) continue;
      count += 1;
    }
    if (count) kinds.push({ kind: rule.kind, how: 'rule', count });
  }
  let modelChecked = false, said;
  if (settings.use_model && settings.model_questions.length) {
    try {
      const answer = await ask({ state: text, questions: Object.fromEntries(settings.model_questions.map(row => [row.kind, { instructions: row.instructions, type: 'noul' }])) });
      if (answer?.error || !answer?.answers) said = fill(settings.words.model_unchecked, { why: answer?.error ?? 'no answer' });
      else {
        modelChecked = true;
        for (const row of settings.model_questions) {
          const share = Number(answer.answers[row.kind]?.noul);
          if (Number.isFinite(share) && share >= settings.threshold) kinds.push({ kind: row.kind, how: 'model', share });
        }
      }
    } catch (error) { said = fill(settings.words.model_unchecked, { why: String(error.message ?? error).slice(0, 200) }); }
  }
  return { contains: kinds.length > 0, kinds, model_checked: modelChecked, choices: kinds.length ? settings.choices : [], ...(said ? { said } : kinds.length ? {} : { said: settings.words.clean }) };
}

/** The tool: tool:check-personal-data. */
export const personalDataTools = { async check(input) { return checkPersonalData(input); } };

/** The tool-table entry as a named function, for run-an-export.mjs. */
export const { check } = personalDataTools;
