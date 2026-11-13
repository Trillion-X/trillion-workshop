// tools/workflows/read-data/step-agents.mjs
//
// How many agents run a recipe step is one whole number on the step's own row (`agents`, 1 when left out), and the
// lanes they run are named by the step's own data: its `lanes` when it lists them, else its id and the lane's place.
// Nothing here knows a number or a recipe; the starter, the validator and the check all read the step through these.
//
//   agentsOf(step) -> whole number >= 1       (throws when `agents` is anything else)
//   laneIds(step) -> [lane id]                one per agent, each different
//   laneJobId(run, step, lane) -> job id      the id of the ai-job that runs that lane of that step in that run
//   laneAiId(run, lane) -> AI id            the AI id the lane's job is taken and finished under, its own, never the session's
//   laneCommands(run, step, lane) -> { as, take, finish }   the exact commands that take and finish that lane's job under that id
//   agentProblems(step, name) -> [problem]    what is wrong with a step's agents and lanes, for the recipe validator

export function agentsOf(step) {
  if (step?.agents === undefined) return 1;
  if (!Number.isInteger(step.agents) || step.agents < 1) throw new Error(`Step ${step?.id}: agents must be a whole number from 1 up, got ${JSON.stringify(step.agents)}.`);
  return step.agents;
}

export function laneIds(step) {
  const agents = agentsOf(step);
  return Array.isArray(step.lanes) ? [...step.lanes] : Array.from({ length: agents }, (_, at) => `${step.id}-${at + 1}`);
}

export const laneJobId = (run, step, lane) => `${run}:${step}:${lane}`;

// Sub-agents and sessions started from one session otherwise act as that one AI, and the lane-jobs check, which wants a
// different taker for every lane, could not tell six lanes from one worker. Each lane is told its own id; the id is made
// only of the run and the lane, so a start that comes again hands the same one.
export const laneAiId = (run, lane) => `ai:${`${String(run).replace(/^ai-job:/, '')}-${lane}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

export function laneCommands(run, step, lane) {
  const as = laneAiId(run, lane), job = laneJobId(run, step, lane);
  return { as, take: `trillion take ${job} --as ${as}`, finish: `trillion finish ${job} "<result>" --as ${as}` };
}

export function agentProblems(step, name) {
  if (step.agents !== undefined && !(Number.isInteger(step.agents) && step.agents >= 1)) return [`${name}.agents must be a whole number from 1 up.`];
  if (step.lanes === undefined) return [];
  const agents = agentsOf(step);
  const named = Array.isArray(step.lanes) && step.lanes.every(lane => typeof lane === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(lane));
  return named && step.lanes.length === agents && new Set(step.lanes).size === agents ? []
    : [`${name}.lanes must list exactly ${agents} different lane ids (lowercase letters, numbers, dashes or underscores), one per agent.`];
}
