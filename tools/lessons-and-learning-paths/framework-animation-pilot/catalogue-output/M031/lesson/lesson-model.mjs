export const INITIAL_SESSION = Object.freeze({
  objective: 'capacity',
  preparation: 'ratio-card',
  scenario: 'field-pack',
  feedback: 'diagnostic',
});

export function scenarioPlan(content, session) {
  const task = content.scenarios[session.scenario];
  if (!task) throw new RangeError(`Unknown task: ${session.scenario}`);
  const capacities = task.materials.map(material => ({
    ...material,
    capacity: Math.floor(material.stock / material.perPack),
    remainder: material.stock % material.perPack,
  }));
  const capacity = Math.min(...capacities.map(row => row.capacity));
  const limiting = capacities.filter(row => row.capacity === capacity);
  const answerOptions = session.objective === 'capacity'
    ? [...new Set([Math.max(0, capacity - 1), capacity, capacity + 1])].sort((a, b) => a - b).map(value => ({ id: String(value), label: `${value} complete ${task.title === 'Field packs' ? 'packs' : 'kits'}` }))
    : capacities.map(row => ({ id: row.id, label: row.name }));
  return { task, capacities, capacity, limiting, answerOptions };
}

export function attemptFeedback(content, session, answer) {
  const plan = scenarioPlan(content, session);
  if (typeof answer !== 'string' || !answer) return null;
  const correct = session.objective === 'capacity'
    ? Number(answer) === plan.capacity
    : plan.limiting.some(row => row.id === answer);
  const answerLabel = session.objective === 'capacity'
    ? `${plan.capacity} complete ${plan.task.title === 'Field packs' ? 'packs' : 'kits'}`
    : plan.limiting.map(row => row.name).join(' and ');
  const detail = plan.capacities.map(row => `${row.name}: floor(${row.stock} ÷ ${row.perPack}) = ${row.capacity} complete`).join('; ');
  return {
    correct,
    answerLabel,
    detail,
    message: correct
      ? `That answer fits the stock constraints: ${answerLabel}.`
      : `Check the whole-run limit. The supported answer is ${answerLabel}.`,
    diagnostic: correct
      ? `The other material capacities are ${detail}. The smallest capacity sets the run; ${plan.limiting.map(row => row.name.toLowerCase()).join(' and ')} limit${plan.limiting.length === 1 ? 's' : ''} it.`
      : `Compare each material's stock with the amount needed per ${plan.task.title === 'Field packs' ? 'pack' : 'kit'}: ${detail}. Keep only complete packs or kits. The smallest capacity sets the run.`,
  };
}

export function transferState(content, session, answer) {
  const plan = scenarioPlan(content, session);
  const feedback = attemptFeedback(content, session, answer);
  return {
    session: { ...session },
    attempt: answer,
    target: session.objective,
    scenario: session.scenario,
    performance: feedback ? {
      response: answer,
      correct: feedback.correct,
      expected: feedback.answerLabel,
      observedAt: 'one checked attempt; no improvement or retention inferred',
    } : null,
    limitingComponents: plan.limiting.map(row => row.id),
    taskConditions: plan.task.materials.map(({ id, name, perPack, stock }) => ({ id, name, perPack, stock })),
  };
}
