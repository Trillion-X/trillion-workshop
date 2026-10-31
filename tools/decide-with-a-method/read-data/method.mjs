// tools/decide-with-a-method/read-data/method.mjs
//
// The method a decision is walked through, one question at a time. Ported from the old app's src/private-method.mjs.
// The one change: the methods in use are not a module-wide catalogue loaded from the app's own files; they are the
// rows the caller passes (the person's own Methods and Method checks lists), and `methodCatalogue(methods, checks)`
// returns every function over them. A method may extend another and
// reword or preset it; a check sharpens one step and applies when its switch is on. No code here names a method: the
// default for each purpose is the row whose `default_for` lists that purpose.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every stage of a method's backbone keeps a step no switch can turn off; a set of rows that breaks this, or
//      names an unknown `extends`, is refused whole.
//   2. A decision runs under the method snapshot it was opened with; later edits to the rows never rewrite it.
//   3. The question's answer_schema is built from the same rows validation reads, so the two cannot disagree.
import { publicAddressOrNull } from './public-address.mjs';

// A field's shape: its declared kind, or a list of texts when it only says list.
export const kindOf = spec => spec.kind ?? (spec.list ? 'list' : 'text');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function loadMethods(methodData) {
  const raw = new Map(methodData.map(data => [data.id, data]));
  const resolved = new Map();
  const resolve = id => {
    if (resolved.has(id)) return resolved.get(id);
    const data = raw.get(id);
    if (!data) throw new Error(`Unknown method ${id}`);
    const base = data.extends ? resolve(data.extends) : { checks: [], steps: [], preset: {} };
    const method = {
      id: data.id, name: data.name, about: data.about,
      checks: data.checks && Array.isArray(data.checks) ? data.checks : base.checks,
      preset: { ...base.preset, ...(Array.isArray(data.checks) ? {} : data.checks ?? {}) },
      steps: (data.steps ?? base.steps).map(step => ({ ...step, question: data.questions?.[step.id] ?? step.question })),
      backbone: data.backbone ?? base.backbone,
      answer_rules: data.answer_rules ?? base.answer_rules,
      observers: data.observers ?? base.observers,
      decision_fields: data.decision_fields ?? base.decision_fields ?? [],
      workflows: data.workflows ?? base.workflows ?? [],
    };
    assertBackbone(method);
    resolved.set(id, method);
    return method;
  };
  for (const id of raw.keys()) resolve(id);
  return resolved;
}

// The algorithm's stages are the backbone of every method: each step belongs to exactly one stage, and every stage
// has a step no switch can turn off, so no answer to the scope question removes a stage of the algorithm.
export function assertBackbone(method) {
  const stageOf = new Map();
  for (const stage of method.backbone ?? []) for (const id of stage.steps) {
    if (stageOf.has(id)) throw new Error(`Method ${method.id}: step ${id} is in two stages`);
    stageOf.set(id, stage);
  }
  for (const step of method.steps) if (step.kind !== 'scope' && !stageOf.has(step.id)) throw new Error(`Method ${method.id}: step ${step.id} belongs to no stage`);
  for (const stage of method.backbone ?? []) {
    const steps = method.steps.filter(step => stage.steps.includes(step.id));
    if (!steps.some(step => !step.when)) throw new Error(`Method ${method.id}: stage ${stage.id} can be switched off`);
  }
  const order = method.steps.filter(step => step.kind !== 'scope').map(step => step.id);
  if (order.join() !== (method.backbone ?? []).flatMap(stage => stage.steps).join()) throw new Error(`Method ${method.id}: steps are not in the order of the stages`);
}

// Every problem in one answer, reported together: each independent part is checked, and what failed is gathered.
export class AnswerProblems extends Error {
  constructor(problems) { super(problems.join('; ')); this.problems = problems; }
}
function gather(units) {
  const problems = [];
  for (const unit of units) {
    try { unit(); } catch (error) { problems.push(...(error.problems ?? [error.message])); }
  }
  if (problems.length) throw new AnswerProblems(problems);
}

const words = text => String(text).trim().split(/\s+/).filter(Boolean).length;
const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const isPublicUrl = value => publicAddressOrNull(value) !== null;

// A check may be skipped only when neither its row nor its step forbids it; the step-0 checks never can be.
const skippable = (step, row) => step.checks_skippable !== false && row.skip !== false;

// A refusal names the check and the words of the check the answer does not address, so the caller knows what to add.
export const refusalWords = (prefix, verdict) => `${prefix}${verdict.id}: ${verdict.why}${verdict.missing ? ` The check asks: "${String(verdict.missing).trim()}".` : ''}`;
export function judgedProblems(verdicts) {
  return (verdicts ?? []).filter(verdict => verdict.meets === false).map(verdict => refusalWords(String(verdict.id).startsWith('workflow_runs.') ? '' : 'checklist.', verdict));
}
export const stepAnswers = (step, answer) => Object.fromEntries((step.fields ?? []).filter(field => answer?.[field.name] !== undefined).map(field => [field.name, answer[field.name]]));

// The exact shape of a valid answer, built from the same rows validation reads.
const minWords = n => (n > 1 ? `^\\s*\\S+(\\s+\\S+){${n - 1},}\\s*$` : '\\S');
const refsSchema = rules => ({ type: 'array', minItems: rules.evidence_min ?? 1, items: { type: 'string', minLength: 1 }, description: 'Refs of the case evidence (or the person\'s pursuits) this rests on' });
const withRefs = (schema, rules) => ({ ...schema, required: [...schema.required, 'evidence_refs'], properties: { ...schema.properties, evidence_refs: refsSchema(rules) } });

// Scope selects candidates to assess. Planning records applicability and the phase that needs the result;
// execution can follow the choice. The original accepted answer remains immutable.
const workflowReason = { name: 'because', kind: 'text', min_words: 1, ask: 'Which case evidence makes a separate workflow run necessary or unnecessary? Existing evidence may remove duplicate work.' };
const workflowPlan = { name: 'plan', kind: 'text', min_words: 1, ask: 'What distinct work is required, what will it prove, and why is it needed before the decision or during execution? Reuse an existing applicable run when available.' };
// A due workflow is one check of its step, judged like a checklist item: its id is `workflow_runs.<workflow_id>`.
function workflowCheck(row) {
  return {
    id: `workflow_runs.${row.workflow_id}`,
    check: `Does the case need an additional run of this workflow, and when is its proof required? ${row.use}`,
    good_answer: 'Use the cited case evidence and already completed work to assess whether a separate run is necessary; reuse an existing applicable run instead of duplicating it. If applicable, explain the distinct work and required phase. Evidence needed to choose safely, including authority, belongs to the decision phase. Work that validates the chosen change belongs to execution. A plan remains unfinished; an ID alone does not prove completion. An inapplicable answer names the concrete evidence that makes an additional run unnecessary.',
    skippable: false,
  };
}

/**
 * Every method function over the person's method rows and check rows (each check names the step it sharpens). `grader` is
 * who judges the checks and the words the calling AI is given for it ({ grader, words }); the calling AI judges, so no
 * model is asked here.
 */
export function methodCatalogue(methodData, checkRows = [], { grader = { grader: 'self', words: '' } } = {}) {
  if (!Array.isArray(methodData) || !methodData.length) throw new Error('Install at least one method.');
  const methods = loadMethods(methodData);
  const voices = new Map();
  for (const data of methodData) if (data.voice) voices.set(data.id, { rows: data.voice, avoid: data.voice_avoid ?? [] });
  const checks = [...new Map(checkRows.map(row => [row.id, row])).values()];
  const defaults = new Map();
  for (const data of methodData) for (const purpose of data.default_for ?? []) if (!defaults.has(purpose)) defaults.set(purpose, data.id);
  const checksByStep = Map.groupBy(checks, row => row.step);
  const checksById = new Map(checks.map(row => [row.id, row]));

  // The method a purpose uses when none is chosen: the row whose `default_for` lists it, otherwise the decision
  // default, otherwise the first method.
  const defaultMethodId = (purpose = 'decision') => defaults.get(purpose) ?? defaults.get('decision') ?? methods.keys().next().value;
  const methodOf = record => record.method ?? methods.get(defaultMethodId());
  const voiceOf = id => voices.get(id) ?? (methodData.find(data => data.id === id)?.extends ? voiceOf(methodData.find(data => data.id === id).extends) : { rows: [], avoid: [] });

  // How the decision is told to the person: the method's voice rows, with the phrases each rules out.
  const howToSayIt = record => {
    const { rows: voice, avoid: all } = voiceOf(record.method?.id ?? defaultMethodId());
    const avoid = all.filter(item => item.shown_to_caller !== false);
    return voice.map(({ id, rule, good_answer }) => ({ id, rule, good_answer, ...(avoid.some(item => item.voice === id) ? { never_say: avoid.filter(item => item.voice === id).map(item => item.phrase) } : {}) }));
  };

  const listMethods = () => [...methods.values()].map(({ id, name, about }) => ({ id, name, about }));

  // A case keeps the exact method it was admitted under, so later edits to the rows never rewrite past runs.
  function snapshotMethod(id = defaultMethodId()) {
    const method = methods.get(id);
    if (!method) throw new Error(`Unknown method ${id}. Available: ${[...methods.keys()].join(', ')}`);
    return structuredClone(method);
  }

  function context(record) {
    const scope = record.guidance?.[0]?.answer;
    if (!scope) return null;
    const method = methodOf(record);
    const active = { ...scope.decision_context, ...method.preset };
    // A switch marked on_when_any_other_is_on is on whenever any other switch is; a case scoped before the switch
    // existed never answered it, so it keeps the full method it started with.
    for (const check of method.checks) if (check.on_when_any_other_is_on && (!(check.id in active) || method.checks.some(other => other.id !== check.id && active[other.id] === true))) active[check.id] = true;
    return active;
  }

  function stepsFor(record) {
    const method = methodOf(record);
    const active = context(record);
    if (!active) return method.steps.slice(0, 1);
    return method.steps.filter(step => !step.when || active[step.when] === true);
  }

  function methodCoverage(record) {
    const active = context(record);
    if (!active) return null;
    const method = methodOf(record);
    const reasons = record.guidance[0].answer.omission_reasons ?? {};
    const selected = stepsFor(record);
    return {
      method: method.id,
      stages: (method.backbone ?? []).map(stage => ({ id: stage.id, name: stage.name, steps: selected.filter(step => stage.steps.includes(step.id)).map(step => step.id) })),
      selected: selected.map(step => ({ step_id: step.id })),
      omitted: method.steps.filter(step => step.when && active[step.when] === false).map(step => ({
        step_id: step.id,
        reason: step.when in method.preset ? `Set by the ${method.name} method` : reasons[step.when] ?? `Implied: ${step.when} is off`,
      })),
    };
  }

  // A method and every method it extends, by id, from the rows in use.
  function methodLineage(id) {
    const seen = new Set();
    for (let at = id; at && !seen.has(at); at = methodData.find(data => data.id === at)?.extends) seen.add(at);
    return seen;
  }

  // The checks that apply to this step of this case: the step's rows whose switch is on (or that have none), then the
  // rows the step names by id (`check_ids`), whatever switch they carry. A method with no scope question has no
  // switches: its first step asks its rows without one.
  // A check row names its method: it is asked of that method and of the methods extending it.
  function checklistFor(record, step) {
    if (step.kind === 'scope') return [];
    const active = context(record) ?? {};
    const lineage = methodLineage(methodOf(record).id);
    const own = (checksByStep.get(step.id) ?? []).filter(row => (!row.method || lineage.has(row.method)) && (!row.when || active[row.when] === true));
    const named = (step.check_ids ?? []).map(id => checksById.get(id)).filter(row => row && !own.includes(row));
    return [...own, ...named];
  }

  function workflowsDue(record, step) {
    if (step.kind === 'scope' || stepsFor(record).find(item => item.kind !== 'scope')?.id !== step.id) return [];
    const active = context(record) ?? {};
    return (methodOf(record).workflows ?? []).filter(row => !row.when || active[row.when] === true);
  }

  // One value against its declared shape. Shapes are JSON value shapes (text with a word count, a list, one of a few
  // choices, a calendar date, a public web address, an observer from the method's observer rows); a field names its
  // own through `kind`, `min_words`, `min`, `choices` and `item_fields`.
  function checkShape(spec, value, label, method, rules) {
    const kind = kindOf(spec);
    if (spec.optional && (value === undefined || value === null || value === '')) return;
    if (kind === 'text') {
      const min = spec.min_words ?? rules.field_min_words ?? 1;
      if (!nonempty(value) || words(value) < min) throw new Error(`${label} needs at least ${min} word${min === 1 ? '' : 's'} about this decision`);
    } else if (kind === 'list') {
      const min = spec.min ?? 1;
      if (!Array.isArray(value) || value.length < min) throw new Error(`${label} needs at least ${min} item${min === 1 ? '' : 's'}`);
      gather(value.map((item, index) => () => (spec.item_fields
        ? checkFields(spec.item_fields, item, `${label}[${index}]`, method, rules)
        : checkShape({ kind: 'text', min_words: spec.min_words ?? rules.list_item_min_words ?? 1 }, item, `${label}[${index}]`, method, rules))));
      // Rules across one item's fields (`item_rules`), after each item has its shape: an item must name one of several
      // fields (`need_any`), or, when its own fields say so (`when`), a field that reads a certain way (`need`, `match`).
      gather(value.flatMap((item, index) => object(item) ? (spec.item_rules ?? []).map(rule => () => {
        if (rule.when && !Object.entries(rule.when).every(([name, expected]) => item[name] === expected)) return;
        const said = name => nonempty(item[name]);
        if (rule.need_any ? !rule.need_any.some(said) : !(said(rule.need) && (!rule.match || new RegExp(rule.match).test(item[rule.need].trim())))) throw new Error(`${label}[${index}] ${rule.because}`);
      }) : []));
    } else if (kind === 'choice') {
      if (!spec.choices.includes(value)) throw new Error(`${label} must be one of: ${spec.choices.join(', ')}`);
    } else if (kind === 'date') {
      if (typeof value !== 'string' || !isDate(value)) throw new Error(`${label} must be a date written YYYY-MM-DD`);
      if (value < new Date().toISOString().slice(0, 10)) throw new Error(`${label} must be today or later`);
    } else if (kind === 'url') {
      if (!isPublicUrl(value)) throw new Error(`${label} must be a public https address`);
    } else if (kind === 'observer') {
      const observer = (method.observers ?? []).find(row => row.id === value?.kind);
      if (!observer) throw new Error(`${label} must name how the result is checked: ${(method.observers ?? []).map(row => row.id).join(' or ')}`);
      checkFields(observer.fields, value, label, method, rules);
    } else throw new Error(`${label} has a shape this service does not know`);
  }
  function checkFields(specs, value, label, method, rules) {
    if (!object(value)) throw new Error(`${label} must be an object`);
    gather(specs.map(spec => () => checkShape(spec, value[spec.name], `${label}.${spec.name}`, method, rules)));
  }
  function checkEvidence(refs, label, evidence, rules) {
    const min = rules.evidence_min ?? 1;
    if (!Array.isArray(refs) || refs.length < min) throw new Error(`${label} must cite case evidence: evidence_refs lists at least ${min} ref${min === 1 ? '' : 's'} from the case evidence`);
    const unknown = refs.filter(ref => !evidence.has(ref));
    if (unknown.length) throw new Error(`${label} must cite case evidence: ${unknown.map(ref => JSON.stringify(ref)).join(', ')} is not a ref of this case`);
  }

  // What a rejected reason should look like, built from the same rows validation reads, so an AI that was told "no"
  // is also told the exact shape that says "yes" instead of being asked the same question again.
  function exampleOf(spec, method) {
    const kind = kindOf(spec);
    const say = spec.ask ?? spec.label ?? spec.name;
    if (kind === 'text') return `<${say}${spec.min_words > 1 ? ` (at least ${spec.min_words} words)` : ''}>`;
    if (kind === 'list') return [spec.item_fields ? examplesOf(spec.item_fields, method) : `<${say}>`];
    if (kind === 'choice') return spec.choices.join(' | ');
    if (kind === 'date') return 'YYYY-MM-DD';
    if (kind === 'url') return 'https://...';
    if (kind === 'observer') return { kind: (method.observers ?? []).map(row => row.id).join(' | ') };
    return `<${say}>`;
  }
  const examplesOf = (specs, method) => Object.fromEntries(specs.map(spec => [spec.name, exampleOf(spec, method)]));

  function validateUnderEarlierRules(record, step, answer, method) {
    if (step.kind === 'scope') {
      const given = answer.decision_context;
      if (!object(given)) throw new Error('Decision context is required');
      for (const check of method.checks) {
        if (check.id in method.preset) continue;
        const implied = check.on_when_any_other_is_on && method.checks.some(other => other.id !== check.id && (given[other.id] === true || method.preset[other.id] === true));
        if (typeof given[check.id] !== 'boolean' && !(implied && given[check.id] === undefined)) throw new Error(`${check.id} must be true or false`);
        if (!given[check.id] && !implied && !nonempty(answer.omission_reasons?.[check.id])) throw new Error(`Explain why ${check.id} is omitted`);
      }
      return;
    }
    const checklist = checklistFor(record, step);
    const missing = checklist.filter(row => !nonempty(answer.checklist?.[row.id])).map(row => row.id);
    if (missing.length) throw new Error(`Say how the answer handles each check: ${missing.join(', ')}`);
    for (const field of step.fields) checkShape(field, answer[field.name], field.name, method, {});
  }

  function validateMethodAnswer(record, step, answer, evidence) {
    if (!object(answer)) throw new Error('Answer must be an object');
    const method = methodOf(record);
    const rules = method.answer_rules ?? {};
    // A case runs under the method it was admitted with. A method from before answer rules existed asked only for
    // non-empty text per check and per omitted switch, and a case begun under it finishes under it.
    if (!method.answer_rules) {
      if (!Array.isArray(answer.evidence_refs) || answer.evidence_refs.length === 0 || answer.evidence_refs.some(ref => !evidence.has(ref))) throw new Error('Answer must cite case evidence');
      return validateUnderEarlierRules(record, step, answer, method);
    }
    const common = [
      () => checkEvidence(answer.evidence_refs, 'evidence_refs', evidence, rules),
      () => { if (answer.scratchpad !== undefined && typeof answer.scratchpad !== 'string') throw new Error('scratchpad must be text'); },
    ];
    if (step.kind === 'scope') {
      const given = answer.decision_context;
      if (!object(given)) return gather([...common, () => { throw new Error('decision_context is required'); }]);
      return gather([...common, ...method.checks.filter(check => !(check.id in method.preset)).map(check => () => {
        const implied = check.on_when_any_other_is_on && method.checks.some(other => other.id !== check.id && (given[other.id] === true || method.preset[other.id] === true));
        if (typeof given[check.id] !== 'boolean' && !(implied && given[check.id] === undefined)) throw new Error(`${check.id} must be true or false`);
        if (given[check.id] || implied) return;
        // Turning a switch off takes the reason that switch itself asks for, tied to the case's own evidence.
        const reason = answer.omission_reasons?.[check.id];
        if (!object(reason)) throw new Error(`Explain why ${check.id} is omitted: ${(check.skip_requires ?? []).map(spec => spec.ask ?? spec.name).join(' ')} Send omission_reasons.${check.id} as ${JSON.stringify({ ...examplesOf(check.skip_requires ?? [], method), evidence_refs: ['<case evidence ref>'] })}`);
        gather([
          () => checkFields(check.skip_requires ?? [], reason, `omission_reasons.${check.id}`, method, rules),
          () => checkEvidence(reason.evidence_refs, `omission_reasons.${check.id}`, evidence, rules),
        ]);
      })]);
    }
    const checklist = checklistFor(record, step);
    const units = [...common];
    if (checklist.length) {
      const given = object(answer.checklist) ? answer.checklist : {};
      const missing = checklist.filter(row => !object(given[row.id])).map(row => row.id);
      if (missing.length) units.push(() => { throw new Error(`Say how the answer handles each check: ${missing.join(', ')}`); });
      const said = new Map();
      for (const row of checklist.filter(item => !missing.includes(item.id))) units.push(() => {
        const item = given[row.id];
        const label = `checklist.${row.id}`;
        gather([
          () => {
            if (item.handled === true) checkFields(rules.check?.handled ?? [], item, label, method, rules);
            else if (item.handled === false) {
              if (!skippable(step, row)) throw new Error(`${row.id} cannot be skipped: say how the answer handles it`);
              checkFields([...(rules.check?.skip ?? []), ...(row.skip_requires ?? [])], item, label, method, rules);
            } else throw new Error(`${label}.handled must be true or false`);
          },
          () => { if (item.changed_answer !== undefined && typeof item.changed_answer !== 'boolean') throw new Error(`${label}.changed_answer must be true or false`); },
          () => checkEvidence(item.evidence_refs, label, evidence, rules),
          () => {
            // The same words pasted under two checks answer neither.
            const text = String(item.handled ? item.how : item.because).trim().toLowerCase().replace(/\s+/g, ' ');
            if (rules.check?.distinct && said.has(text)) throw new Error(`${row.id} repeats the answer given for ${said.get(text)}; each check needs its own answer`);
            said.set(text, row.id);
          },
        ]);
      });
    }
    const workflows = workflowsDue(record, step);
    const runs = object(answer.workflow_runs) ? answer.workflow_runs : {};
    if (answer.workflow_runs !== undefined) units.push(() => {
      if (!object(answer.workflow_runs)) throw new Error('workflow_runs must be an object');
      const candidates = new Set(workflows.map(row => row.workflow_id));
      for (const id of Object.keys(runs)) if (!candidates.has(id)) throw new Error(`workflow_runs.${id} is not a candidate at this planning step; later run bindings belong in decide or say_what_was_done`);
    });
    for (const row of workflows) units.push(() => {
      const item = runs[row.workflow_id];
      const label = `workflow_runs.${row.workflow_id}`;
      if (!object(item)) throw new Error(`Assess whether ${row.workflow_id} requires an additional run in ${label}, using case evidence. An applicable obligation needs its required_phase (decision or execution) and plan; no run must be started just to answer this question. ${row.use}`);
      gather([
        () => checkShape(workflowReason, item.because, `${label}.because`, method, rules),
        () => checkEvidence(item.evidence_refs, label, evidence, rules),
        () => {
          if (item.applicable === false) {
            if (['required_phase', 'plan', 'run_id'].some(key => item[key] !== undefined)) throw new Error(`${label}: an inapplicable candidate cannot also declare a phase, plan or run`);
          } else if (item.applicable === true) {
            if (!['decision', 'execution'].includes(item.required_phase)) throw new Error(`${label}.required_phase must be decision or execution`);
            checkShape(workflowPlan, item.plan, `${label}.plan`, method, rules);
            if (item.run_id !== undefined && !nonempty(item.run_id)) throw new Error(`${label}.run_id must name an actual existing run when supplied`);
          } else throw new Error(`${label}.applicable must be true or false`);
          const fields = new Set(['applicable', 'because', 'evidence_refs', ...(item.applicable ? ['required_phase', 'plan', 'run_id'] : [])]);
          if (Object.keys(item).some(key => !fields.has(key))) throw new Error(`${label}: only applicability, its evidence, the required phase, plan and optional run_id are accepted; completion is checked by the service`);
        },
      ]);
    });
    for (const field of step.fields) units.push(() => checkShape(field, answer[field.name], field.name, method, rules));
    gather(units);
  }

  // in the method (`decision_fields`), asked when its switch is on (`when`) and judged by its own check.
  const decisionFieldsFor = record => { const active = context(record) ?? {}; return (methodOf(record).decision_fields ?? []).filter(field => !field.when || active[field.when] === true); };
  const decisionFieldsToJudge = (record, decision) => decisionFieldsFor(record).map(field => ({ id: field.name, check: field.check, good_answer: field.good_answer, ...(field.refuses ? { refuses: field.refuses } : {}), handled: true, answer: decision[field.name] }));
  const decisionFieldsAsked = record => decisionFieldsFor(record).map(({ name, label, ask }) => ({ name, label, ask }));
  const decisionFieldsSaid = (record, decision) => decisionFieldsFor(record).filter(field => field.says && typeof decision[field.name] === 'string' && decision[field.name].trim()).map(field => field.says.replace('{value}', decision[field.name].trim().replace(/[.\s]+$/, '')));

  function checkAnswersToJudge(record, step, answer) {
    const asked = checklistFor(record, step).map(row => {
      const item = answer.checklist?.[row.id] ?? {};
      return { id: row.id, check: row.check, good_answer: row.good_answer, ...(row.refuses ? { refuses: row.refuses } : {}), skippable: skippable(step, row), handled: item.handled, answer: item.handled === false ? item.because : item.how };
    });
    return [...asked, ...workflowsDue(record, step).map(row => ({ ...workflowCheck(row), handled: true, answer: JSON.stringify(answer.workflow_runs?.[row.workflow_id] ?? {}) }))];
  }
  // Every id a caller's verdict may target at this step: the checklist ids and the due workflow ids.
  const verdictChecksFor = (record, step) => [
    ...checklistFor(record, step).map(({ id, check }) => ({ id, check })),
    ...workflowsDue(record, step).map(row => { const { id, check } = workflowCheck(row); return { id, check }; }),
  ];
  // What a judge reads each answer beside: the goal, the current evidence and the other answers at the same step.
  function judgeContext(record, answers) {
    const evidence = (record.input?.evidence ?? []).filter(item => !item.retracted_at).map(({ ref, claim }) => ({ ref, claim }));
    return { goal: record.input?.goal, evidence, answers };
  }

  function shapeSchema(spec, method, rules) {
    const kind = kindOf(spec);
    const describe = extra => ({ ...(spec.label ? { title: spec.label } : {}), ...(spec.ask ? { description: extra ? `${spec.ask} (${extra})` : spec.ask } : extra ? { description: extra } : {}) });
    if (kind === 'text') { const n = spec.min_words ?? rules.field_min_words ?? 1; return { type: 'string', pattern: minWords(n), ...describe(`at least ${n} word${n === 1 ? '' : 's'}`) }; }
    if (kind === 'list') return { type: 'array', minItems: spec.min ?? 1, items: spec.item_fields ? fieldsSchema(spec.item_fields, method, rules) : shapeSchema({ kind: 'text', min_words: spec.min_words ?? rules.list_item_min_words ?? 1 }, method, rules), ...describe() };
    if (kind === 'choice') return { type: 'string', enum: spec.choices, ...describe() };
    if (kind === 'date') return { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$', ...describe('YYYY-MM-DD, today or later') };
    if (kind === 'url') return { type: 'string', format: 'uri', pattern: '^https://', ...describe('a public https address') };
    if (kind === 'observer') return { oneOf: (method.observers ?? []).map(row => { const inner = fieldsSchema(row.fields, method, rules); return { ...inner, title: row.label, required: ['kind', ...inner.required], properties: { kind: { const: row.id, description: row.about }, ...inner.properties } }; }), ...describe('how the result will be checked independently') };
    throw new Error(`Unknown shape ${kind}`);
  }
  function fieldsSchema(specs, method, rules) {
    return { type: 'object', required: specs.filter(spec => !spec.optional).map(spec => spec.name), properties: Object.fromEntries(specs.map(spec => [spec.name, shapeSchema(spec, method, rules)])) };
  }

  function answerSchema(method, step, checklist, workflows = []) {
    const rules = method.answer_rules ?? {};
    const properties = { evidence_refs: refsSchema(rules), scratchpad: { type: 'string' } };
    const required = ['evidence_refs'];
    const defs = {};
    if (step.kind === 'scope') {
      const open = method.checks.filter(check => !(check.id in method.preset));
      properties.decision_context = { type: 'object', required: open.filter(check => !check.on_when_any_other_is_on).map(check => check.id), properties: Object.fromEntries(open.map(check => [check.id, { type: 'boolean', description: check.question }])) };
      properties.omission_reasons = { type: 'object', description: 'For every check set to false, the reason that check asks for, citing case evidence', properties: Object.fromEntries(open.map(check => [check.id, withRefs(fieldsSchema(check.skip_requires ?? [], method, rules), rules)])) };
      required.push('decision_context');
    } else {
      for (const field of step.fields) {
        properties[field.name] = shapeSchema(field, method, rules);
        required.push(field.name);
      }
      properties.answered_by = { type: 'object', description: 'Who gave each answer that did not come from the caller', additionalProperties: { type: 'string', minLength: 1 } };
      if (checklist.length) {
        const handled = withRefs(fieldsSchema(rules.check?.handled ?? [], method, rules), rules);
        // Optional on every check: whether asking it made the caller change the answer before sending it.
        const changed = { changed_answer: { type: 'boolean', description: 'true when this check made you change your answer before sending it' } };
        const yes = { ...handled, required: ['handled', ...handled.required], properties: { handled: { const: true }, ...handled.properties, ...changed } };
        const skipOf = extra => { const skip = withRefs(fieldsSchema([...(rules.check?.skip ?? []), ...extra], method, rules), rules); return { ...skip, required: ['handled', ...skip.required], properties: { handled: { const: false }, ...skip.properties } }; };
        // The two answers every check shares are written once (`$defs`) and named by each check; only a check with a
        // skip reason of its own carries its shape inline. The check's words are in the question's checklist.
        defs.handled = yes;
        if (checklist.some(row => skippable(step, row) && !row.skip_requires?.length)) defs.handled_or_skipped = { oneOf: [{ $ref: '#/$defs/handled' }, skipOf([])] };
        const answerFor = row => {
          if (!skippable(step, row)) return { $ref: '#/$defs/handled' };
          if (!row.skip_requires?.length) return { $ref: '#/$defs/handled_or_skipped' };
          return { oneOf: [{ $ref: '#/$defs/handled' }, skipOf(row.skip_requires)] };
        };
        properties.checklist = { type: 'object', description: 'For each check of the question\'s checklist, by its id: handled true with how, or handled false with the reason the check accepts; every answer cites case evidence and is in its own words', required: checklist.map(row => row.id), properties: Object.fromEntries(checklist.map(row => [row.id, answerFor(row)])) };
        required.push('checklist');
      }
      if (workflows.length) {
        const reason = withRefs(fieldsSchema([workflowReason], method, rules), rules);
        const skip = { ...reason, additionalProperties: false, required: ['applicable', ...reason.required], properties: { applicable: { const: false }, ...reason.properties } };
        const planned = { ...reason, additionalProperties: false, required: ['applicable', 'required_phase', 'plan', ...reason.required], properties: {
          applicable: { const: true }, ...reason.properties,
          required_phase: { type: 'string', enum: ['decision', 'execution'], description: 'decision: its result is required to choose safely; execution: it validates carrying out the chosen change. Choosing execution does not grant authority or satisfy a proof gate.' },
          plan: shapeSchema(workflowPlan, method, rules),
          run_id: { type: 'string', minLength: 1, description: 'Optional actual run already on this account. Reuse it; the service will verify its recipe and finished state at the required phase. Omission means planned and unfinished.' },
        } };
        // One shape for every workflow, written once; what each workflow is for is in the question's workflows.
        defs.workflow_run = { oneOf: [planned, skip] };
        properties.workflow_runs = { type: 'object', additionalProperties: false, description: 'Planning only: assess every candidate using case evidence. Declare whether a separate run is applicable and, if so, its required phase and plan. A plan is unfinished; no run is required merely to answer this question. Only applicable obligations are later checked for verified completion.', required: workflows.map(row => row.workflow_id), properties: Object.fromEntries(workflows.map(row => [row.workflow_id, { $ref: '#/$defs/workflow_run' }])) };
        required.push('workflow_runs');
      }
    }
    return { type: 'object', required, properties, ...(Object.keys(defs).length ? { $defs: defs } : {}) };
  }

  function currentQuestion(record) {
    if (record.decision) return null;
    const step = stepsFor(record)[record.guidance?.length ?? 0];
    if (!step) return null;
    const method = methodOf(record);
    const fields = step.kind === 'scope' ? ['decision_context', 'omission_reasons'] : step.fields.map(field => field.name);
    const checklist = checklistFor(record, step);
    const stage = (method.backbone ?? []).find(item => item.steps.includes(step.id));
    const question = { step_id: step.id, ...(stage ? { stage: { id: stage.id, name: stage.name } } : {}), question: step.question, fields: checklist.length ? [...fields, 'checklist'] : fields, requires: ['evidence_refs'], optional: ['scratchpad'], answer_schema: answerSchema(method, step, checklist, workflowsDue(record, step)) };
    // Each check as its id and its question; what a good answer does and what it refuses come by id on request
    // (checkTexts), so a step of many checks is not sent whole every time it is asked.
    if (checklist.length) question.checklist = checklist.map(({ id, check }) => ({ id, check }));
    // Every id a verdict may target (checklist and due workflow runs), so the calling AI names one list for all of them.
    const verdictChecks = verdictChecksFor(record, step);
    if (verdictChecks.length) question.verdict_checks = verdictChecks.map(({ id }) => id);
    // The AI calling Trillion may judge each check itself: its verdict goes beside this answer, keyed by the id in verdict_checks (read-data/verdicts.mjs takeCallerVerdicts).
    // Who judges and the words it is given are the caller's (methodCatalogue grader), so the words follow the grader.
    if (verdictChecks.length && grader.words) { question.verdicts = grader.words; question.grader = grader.grader; }
    if (step.kind === 'scope') question.checks = method.checks.filter(check => !(check.id in method.preset));
    // The method's workflows whose switch is on
    // (each { workflow_id, when?, use }): candidates for a plan, each a recipe the caller runs with tool:start-a-recipe-run
    // when distinct work is needed to answer the deeper steps.
    // These are candidates for a plan. Start only if distinct work is necessary; reuse existing evidence and runs.
    // An execution-phase run need not precede the decision.
    const workflows = workflowsDue(record, step);
    if (workflows.length) {
      question.workflow_phase = 'planning';
      question.workflows = workflows.map(({ workflow_id, use }) => ({ workflow_id, use, if_distinct_run_needed: { tool: 'tool:start-a-recipe-run', arguments: { row: workflow_id } } }));
    }
    // A field names who can truthfully answer it. Anyone other than the calling AI is asked directly, or the AI relays the exact question.
    const askOthers = (step.fields ?? []).filter(field => field.answered_by).map(field => ({ field: field.name, answered_by: field.answered_by, ask: field.ask ?? step.question }));
    if (askOthers.length) question.ask_others = askOthers;
    return question;
  }

  // The whole words of the named checks of the current question (its checklist and due workflow runs): the check, what a
  // good answer does and what it refuses. An id the question does not ask is named back, never guessed.
  function checkTexts(record, ids) {
    const step = record.decision ? null : stepsFor(record)[record.guidance?.length ?? 0];
    const asked = step ? [
      ...checklistFor(record, step).map(row => ({ id: row.id, check: row.check, good_answer: row.good_answer, ...(row.refuses ? { refuses: row.refuses } : {}), skippable: skippable(step, row) })),
      ...workflowsDue(record, step).map(row => { const { id, check, good_answer, skippable: may } = workflowCheck(row); return { id, check, good_answer, skippable: may }; }),
    ] : [];
    const byId = new Map(asked.map(row => [row.id, row]));
    return { texts: ids.filter(id => byId.has(id)).map(id => byId.get(id)), unknown: ids.filter(id => !byId.has(id)) };
  }

  return {
    defaultMethodId, methodOf, howToSayIt, listMethods, snapshotMethod, stepsFor, methodCoverage, checklistFor,
    workflowsDue, validateMethodAnswer, decisionFieldsFor, decisionFieldsToJudge, decisionFieldsAsked, decisionFieldsSaid,
    checkAnswersToJudge, verdictChecksFor, judgeContext, currentQuestion, checkTexts,
  };
}
