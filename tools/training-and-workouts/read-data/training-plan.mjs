// tools/training-and-workouts/read-data/training-plan.mjs
//
// A training plan as DATA: goals, phases in a goal, week blocks in a phase, and session prescriptions in a week. A
// prescription's `dose` and `intensity` are open records (any keys a person uses); nothing here names an activity,
// a movement or a unit. Pure: no clock, no I/O.

const objectOf = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const textOf = value => (typeof value === 'string' ? value : '');
const numberOf = value => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
const listOf = value => (Array.isArray(value) ? value : []);

// A week's load intent is open: a bare word, or a record with an id (or key, or name) and any other fields.
function decodeLoadIntent(value) {
  if (typeof value === 'string') return { id: value, label: value, data: {} };
  const row = objectOf(value);
  const id = textOf(row.id) || textOf(row.key) || textOf(row.name);
  return { id, label: textOf(row.label) || textOf(row.name) || id, data: row };
}

// Reads a plan from its raw records. Rows without an id are dropped; missing fields read as empty, never invented.
export function decodeTrainingPlan(raw) {
  const root = objectOf(raw);
  return {
    goals: listOf(root.goals).map(entry => {
      const row = objectOf(entry);
      return { id: textOf(row.id), name: textOf(row.name), domain: textOf(row.domain) };
    }).filter(goal => goal.id),
    phases: listOf(root.phases).map(entry => {
      const row = objectOf(entry);
      return { id: textOf(row.id), goalId: textOf(row.goalId), name: textOf(row.name), intent: textOf(row.intent), sequence: numberOf(row.sequence) };
    }).filter(phase => phase.id),
    weeks: listOf(root.weeks).map(entry => {
      const row = objectOf(entry);
      return { id: textOf(row.id), phaseId: textOf(row.phaseId), sequence: numberOf(row.sequence), loadIntent: decodeLoadIntent(row.loadIntent ?? row.load_intent) };
    }).filter(week => week.id),
    sessions: listOf(root.sessions).map(entry => {
      const row = objectOf(entry);
      const scheduledTaskRef = textOf(row.scheduledTaskRef);
      return {
        id: textOf(row.id),
        weekBlockId: textOf(row.weekBlockId),
        title: textOf(row.title),
        activity: textOf(row.activity),
        dose: objectOf(row.dose),
        intensity: objectOf(row.intensity),
        ...(scheduledTaskRef ? { scheduledTaskRef } : {}),
      };
    }).filter(session => session.id),
  };
}

export const sessionsForWeek = (plan, weekId) => plan.sessions.filter(session => session.weekBlockId === weekId);

export const trainingPlanSummary = plan => ({
  goals: plan.goals.length,
  phases: plan.phases.length,
  weeks: plan.weeks.length,
  sessions: plan.sessions.length,
});
