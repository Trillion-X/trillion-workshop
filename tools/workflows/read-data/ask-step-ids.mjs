// tools/workflows/read-data/ask-step-ids.mjs
//
// wf finds an ask step's kept answer by its context.step_id (workflow-host step_of), so an ask whose context.step_id is
// another step's id is asked and answered as that step: it completes with that step's answer and is never asked. Found
// Nov 24 2026: picture-the-live-page-before-the-apply and compare-the-rendered-page-with-the-one-before of
// workflow:put-a-sites-commit-live-on-the-sellers-own-computer were copied from prove-the-commit-is-what-runs with its
// step_id, and a run completed both with no answer of their own.
//
// askStepIdProblems refuses every ask step whose context.step_id is present and not its own id, and every step_id that
// two ask steps share. An ask with no step_id is left alone (wf then names it by its place in the run).
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** One refusal per ask step of `definition` ({ steps: [...] }) whose context.step_id is not its own id, and one per
 *  step_id that two ask steps share. */
export function askStepIdProblems(definition, name = 'definition') {
  const problems = [];
  const owners = new Map();
  for (const step of Array.isArray(definition?.steps) ? definition.steps : []) {
    if (!object(step) || step.kind !== 'ask') continue;
    const said = step.config?.context?.step_id;
    if (said === undefined || said === null) continue;
    if (said !== step.id) problems.push(`${name}.steps.${step.id}.config.context.step_id is ${JSON.stringify(said)}, not the step's own id ${JSON.stringify(step.id)}: wf finds the step's answer by that id, so it would be answered by the step ${JSON.stringify(said)} and never asked. Set it to ${JSON.stringify(step.id)} or remove it.`);
    owners.set(said, [...(owners.get(said) ?? []), step.id]);
  }
  for (const [said, ids] of owners) if (ids.length > 1) problems.push(`${name}: the ask steps ${ids.map(id => JSON.stringify(id)).join(', ')} share the context.step_id ${JSON.stringify(said)}, so they would share one answer.`);
  return problems;
}
