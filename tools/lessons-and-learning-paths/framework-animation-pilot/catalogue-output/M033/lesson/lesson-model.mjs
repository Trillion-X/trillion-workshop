export const INITIAL_SESSION = Object.freeze({
  capability: 'retrieve',
  stage: 'starting',
  result: 'unknown',
  adjustment: 'repeat',
  dimension: 'support',
});

export function selectedChoice(content, group, id) {
  const choice = content.choices[id];
  if (!choice) throw new RangeError(`Unknown ${group} choice: ${id}`);
  return { ...choice, id };
}

export function sessionPlan(content, session, target = '') {
  const capability = selectedChoice(content, 'capability', session.capability);
  const stage = selectedChoice(content, 'stage', session.stage);
  const result = selectedChoice(content, 'result', session.result);
  const adjustment = selectedChoice(content, 'adjustment', session.adjustment);
  const dimension = selectedChoice(content, 'dimension', session.dimension);
  const instruction = content.teaching.plan.instructions[session.result][session.adjustment];
  return {
    capability,
    stage,
    result,
    adjustment,
    dimension,
    task: capability.label,
    target: target.trim() || content.teaching.plan.emptyTarget,
    taskPrompt: capability.description,
    resultInstruction: instruction,
    nextAttempt: instruction.replace('{dimension}', dimension.label),
  };
}

export function nextAttemptQuestion(content, session, target = '') {
  const plan = sessionPlan(content, session, target);
  return `${plan.taskPrompt}\n\n${plan.nextAttempt}\n\nTarget: ${plan.target}`;
}
