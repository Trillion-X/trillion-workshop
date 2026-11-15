// Plain words for what was answered at each step of a decision. Every word comes from the method DATA
// (methods/methods.json): a field's `label`, a list or check's `says` sentence, a choice's `choice_words`.
// No internal field name, evidence ref, or routing answer (scope switches, who answered) is ever turned into text.
import { kindOf } from './method.mjs';

// Words are the caller's screen-word rows; the record already carries its method snapshot.
export function answerWords(words, { methodWords = record => record.method } = {}) {

const blank = value => value === null || value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);
const day = value => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// What Trillion itself says at a moment of the decision (screen-words.json `decision`), filled from the decision.
const decisionWords = (name, parts) => words.decision[name].replace(/\{(\w+)\}/g, (_, key) => String(parts[key] ?? '').trim().replace(/[.\s]+$/, ''));
const fill = (template, specs, value, method) => template.replace(/\{(\w+)\}/g, (_, name) => valueWords(specs.find(spec => spec.name === name), value?.[name], method)).replace(/\s+/g, ' ').trim();

function valueWords(spec, value, method) {
  if (blank(value)) return '';
  const kind = kindOf(spec);
  if (kind === 'choice') return spec.choice_words?.[value] ?? String(value);
  if (kind === 'date') return day(value);
  if (kind === 'observer') { const row = method.observers.find(item => item.id === value.kind); return row ? fill(row.says, row.fields, value, method) : ''; }
  if (spec.item_fields) return fill(spec.says, spec.item_fields, value, method);
  return String(value).trim();
}

const answerer = who => words.answerers[who] ?? `from ${who}`;

// One labelled row per answered field; a list gives one row per entry. Empty answers are left out. A field the
// person (or anyone other than the AI) answered says so beside its label.
function answerRows(specs, answer, method) {
  return (specs ?? []).flatMap(spec => {
    const value = answer?.[spec.name];
    if (blank(value)) return [];
    const list = kindOf(spec) === 'list';
    const entries = list ? value : [value];
    const entrySpec = list ? { ...spec, list: false, kind: spec.item_fields ? 'items' : 'text' } : spec;
    const who = answer?.answered_by?.[spec.name];
    const label = who ? `${spec.label} (${answerer(who)})` : spec.label;
    return entries.map(entry => ({ label, text: valueWords(entrySpec, entry, method) })).filter(row => row.text);
  });
}

// The worked steps of a decision, each with its question and its labelled answers. The scope step only routes
// the method (which deeper checks apply), so it is not one of the worked steps.
function workedSteps(record) {
  const method = methodWords(record);
  const snapshot = new Map((record.method?.steps ?? []).map(step => [step.id, step]));
  return (record.guidance ?? []).flatMap(item => {
    const step = method.steps.find(row => row.id === item.step_id) ?? snapshot.get(item.step_id);
    if (!step || step.kind === 'scope') return [];
    return [{ step_id: step.id, question: step.question, rows: answerRows(step.fields, item.answer, method) }];
  });
}

// A checklist answer or a left-out check's reason, in the check's own labelled words.
function checkRows(record, given, specs) {
  const method = methodWords(record);
  const rules = method.answer_rules?.check ?? {};
  const shape = given?.handled === false ? [...(rules.skip ?? []), ...(specs ?? [])] : given?.handled === true ? rules.handled ?? [] : specs ?? [];
  return answerRows(shape, given, method);
}

return { decisionWords, answerRows, workedSteps, checkRows };
}
