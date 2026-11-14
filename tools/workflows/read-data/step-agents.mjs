// tools/workflows/read-data/step-agents.mjs
//
// How many agents run a recipe step is one whole number on the step's own row (`agents`, 1 when left out), and the
// lanes they run are named by the step's own data: its `lanes` when it lists them, else its id and the lane's place.
// Nothing here knows a number or a recipe; the starter, the validator and the check all read the step through these.
//
//   agentsOf(step) -> whole number >= 1       (throws when `agents` is anything else)
//   runsLaneJobs(step) -> boolean             true when the step's agents run as their own jobs: `agents` above 1, a `lanes`
//                                             list (even of one lane, so a lone separate agent can be required), or `lanes_from`
//   laneIds(step, answers) -> [lane id]       one per agent, each different; a step with `lanes_from` reads them from the answers
//                                             kept for earlier steps (`answers.<step id>`), so the count comes from an earlier answer
//   laneJobId(run, step, lane) -> job id      the id of the ai-job that runs that lane of that step in that run
//   laneAiId(run, lane) -> AI id            the AI id the lane's job is taken and finished under, its own, never the session's
//   laneCommands(run, step, lane) -> { as, take, finish }   the exact commands that take and finish that lane's job under that id
//   agentProblems(step, name) -> [problem]    what is wrong with a step's agents and lanes, for the recipe validator
//   runStep(step, input) -> step              the step as one run runs it: the run's input `agents_per_step` under the step's
//                                             id overrides the row's `agents`, so the row's number is the default and the run's wins

export function agentsOf(step) {
  if (step?.agents === undefined) return 1;
  if (!Number.isInteger(step.agents) || step.agents < 1) throw new Error(`Step ${step?.id}: agents must be a whole number from 1 up, got ${JSON.stringify(step.agents)}.`);
  return step.agents;
}

// One number per step, kept in two places: the step row (the default every run gets) and the run's input under
// `agents_per_step` (this run's width). The starter, the step start and the submit all read the step through this, so
// they agree on how many lanes the run has. A step whose lanes are named (`lanes`, `lanes_from`) has its width fixed by
// those names, and a step with no lane-jobs check cannot be widened, since its lanes would never be judged.
export const AGENTS_INPUT = 'agents_per_step';
export function runStep(step, input) {
  const given = input?.[AGENTS_INPUT]?.[step?.id];
  if (given === undefined) return step;
  if (!Number.isInteger(given) || given < 1) throw new Error(`The run's ${AGENTS_INPUT}.${step.id} must be a whole number from 1 up, got ${JSON.stringify(given)}.`);
  if (step.lanes_from !== undefined || step.lanes !== undefined) throw new Error(`Step ${step.id} names its lanes on its row (${step.lanes_from !== undefined ? 'lanes_from' : 'lanes'}), so the run's ${AGENTS_INPUT} cannot change how many agents run it.`);
  if (given > 1 && !(step.checks ?? []).some(check => check?.kind === 'lane-jobs')) throw new Error(`Step ${step.id} has no lane-jobs check, so the run's ${AGENTS_INPUT} cannot give it more than one agent: each lane must come from its own job.`);
  return { ...step, agents: given };
}

export const runsLaneJobs = step => step?.lanes_from !== undefined || Array.isArray(step?.lanes) || agentsOf(step) > 1;

const LANE_ID = /^[a-z0-9][a-z0-9_-]*$/;

// The values a `lanes_from` path ends on: ['steps', <earlier step id>, ...keys], `*` walking every item of a list.
function lanesAt(step, answers) {
  const [, from, ...keys] = step.lanes_from;
  if (answers?.[from] === undefined) throw new Error(`Step ${step.id}: its lanes come from the answer of step "${from}", which has no answer kept yet.`);
  let at = [answers[from]];
  for (const key of keys) at = key === '*' ? at.flatMap(value => (Array.isArray(value) ? value : [])) : at.map(value => (value != null && typeof value === 'object' ? value[key] : undefined));
  return at.flatMap(value => (Array.isArray(value) ? value : [value])).filter(value => value !== undefined);
}

export function laneIds(step, answers) {
  if (step.lanes_from !== undefined) {
    const lanes = lanesAt(step, answers);
    if (lanes.length < 1 || !lanes.every(lane => typeof lane === 'string' && LANE_ID.test(lane)) || new Set(lanes).size !== lanes.length)
      throw new Error(`Step ${step.id}: the answer it takes its lanes from must give one or more different lane ids (lowercase letters, numbers, dashes or underscores), got ${JSON.stringify(lanes)}.`);
    return lanes;
  }
  const agents = agentsOf(step);
  return Array.isArray(step.lanes) ? [...step.lanes] : Array.from({ length: agents }, (_, at) => `${step.id}-${at + 1}`);
}

// The answers kept so far for the run's steps before `stepId`, by step id: what `lanes_from` and the checks read.
export const answerId = (run, step) => `${run}#answer:${step}`;
export async function keptAnswers(door, run, steps, stepId) {
  const answers = {};
  for (const before of steps.slice(0, steps.findIndex(item => item.id === stepId))) {
    const kept = await door.read('ai-job', answerId(run, before.id));
    if (kept) answers[before.id] = kept.answer;
  }
  return answers;
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
  if (step.lanes_from !== undefined) {
    const path = step.lanes_from;
    const wrong = [];
    if (!(Array.isArray(path) && path.length >= 3 && path[0] === 'steps' && path.every(key => typeof key === 'string' && key))) wrong.push(`${name}.lanes_from must be a path ['steps', <earlier step id>, ...keys] that ends on the lane ids.`);
    if (step.lanes !== undefined || step.agents !== undefined) wrong.push(`${name}.lanes_from takes the lanes and their number from an earlier answer, so ${name} has no lanes or agents of its own.`);
    return wrong;
  }
  if (step.agents !== undefined && !(Number.isInteger(step.agents) && step.agents >= 1)) return [`${name}.agents must be a whole number from 1 up.`];
  if (step.lanes === undefined) return [];
  const agents = agentsOf(step);
  const named = Array.isArray(step.lanes) && step.lanes.every(lane => typeof lane === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(lane));
  return named && step.lanes.length === agents && new Set(step.lanes).size === agents ? []
    : [`${name}.lanes must list exactly ${agents} different lane ids (lowercase letters, numbers, dashes or underscores), one per agent.`];
}
