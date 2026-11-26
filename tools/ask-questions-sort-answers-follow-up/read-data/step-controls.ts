// tools/ask-questions-sort-answers-follow-up/read-data/step-controls.ts
//
// PURPOSE
//   The one place a question type says how a page that asks one question at a time draws it. Each row of
//   data/question-types.json declares `control` beside its `coerce` (how the server reads the answer), so the server's check and
//   the page's control come from the same row: a number type draws a number box, a rating a number box of whole steps bounded
//   by its question's min and max, a link a link box, a pick type its answers. show/FormSteps.tsx asks controlFor the step's
//   type and draws that control and nothing else. The page reads the same file the server reads, bundled with the page, so a
//   page never waits on the step tools' version to know how to draw a type.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A control is { draw } with draw one of STEP_DRAWS, and for "number" a step (a positive number, or "any" for any number
//      the server takes). Anything else in a row is refused here by name, never guessed.
//   2. A type a page cannot draw declares `control: null` and says why in `no_control_because` (an evidence reference is
//      captured by another owner, never typed). A page given such a type, or one with no control, shows "No control for type
//      <type>." and no box: it never falls back to a text box the server would refuse.
//   3. controlProblems is the standing check: every type declares a control or why it has none, and every question row names a
//      type that is in the types file and that has a control. It reads only what it is given.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import questionTypes from '../data/question-types.json' with { type: 'json' };

export const STEP_DRAWS = ['line', 'long', 'number', 'link', 'picks', 'one'] as const;
export type StepDraw = (typeof STEP_DRAWS)[number];
export type StepControl = { draw: StepDraw; step?: number | 'any' };
export type TypeRow = { questionTypeId: string; control?: unknown; no_control_because?: unknown };
export type QuestionRow = { where: string; questionTypeId: string };

/** The words a page shows for a step whose type it has no control for. */
export const noControlWords = (questionTypeId: string): string => `No control for type ${questionTypeId}.`;

function isDraw(value: unknown): value is StepDraw {
  return typeof value === 'string' && (STEP_DRAWS as readonly string[]).includes(value);
}

/** A type row's control, or null for a type that declares none; a malformed control throws naming the type. */
export function controlOf(row: TypeRow | undefined): StepControl | null {
  if (!row || row.control === undefined || row.control === null) return null;
  const control = row.control as Record<string, unknown>;
  if (typeof control !== 'object' || Array.isArray(control) || !isDraw(control.draw)) throw new Error(`Question type ${row.questionTypeId}: control.draw must be one of ${STEP_DRAWS.join(', ')}.`);
  const extra = Object.keys(control).filter(key => key !== 'draw' && !(key === 'step' && control.draw === 'number'));
  if (extra.length) throw new Error(`Question type ${row.questionTypeId}: control takes no ${extra.join(', ')}.`);
  if (control.draw === 'number' && control.step !== 'any' && !(typeof control.step === 'number' && control.step > 0)) throw new Error(`Question type ${row.questionTypeId}: a number control names its step, a positive number or "any".`);
  return control.draw === 'number' ? { draw: 'number', step: control.step as number | 'any' } : { draw: control.draw };
}

/** Every way the types and the question rows disagree with each other; empty when every question can be drawn. */
export function controlProblems(types: readonly TypeRow[], questions: readonly QuestionRow[]): string[] {
  const problems: string[] = [];
  const drawn = new Map<string, StepControl | null>();
  for (const row of types) {
    let control: StepControl | null = null;
    let malformed = false;
    try {
      control = controlOf(row);
    } catch (error) {
      malformed = true;
      problems.push((error as Error).message);
    }
    const why = typeof row.no_control_because === 'string' && row.no_control_because.trim() !== '';
    if (!control && !malformed && !why) problems.push(`Question type ${row.questionTypeId} declares no control and no no_control_because.`);
    if (control && row.no_control_because !== undefined) problems.push(`Question type ${row.questionTypeId} declares a control and no_control_because; say one.`);
    drawn.set(row.questionTypeId, control);
  }
  for (const question of questions) {
    if (!drawn.has(question.questionTypeId)) problems.push(`${question.where}: type ${question.questionTypeId} is not in question-types.json.`);
    else if (!drawn.get(question.questionTypeId)) problems.push(`${question.where}: ${noControlWords(question.questionTypeId)}`);
  }
  return problems;
}

const TYPES = new Map((questionTypes.rows as TypeRow[]).map(row => [row.questionTypeId, row]));

/** The control data/question-types.json declares for a question type, or null when it declares none or has no such type. */
export function controlFor(questionTypeId: string): StepControl | null {
  return controlOf(TYPES.get(questionTypeId));
}
