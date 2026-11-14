// tools/workflows/read-data/start-a-steps-agents.mjs
//
// Starts the agents of one step of a recipe run: one waiting ai-job per lane of the step, and nothing else. The run is
// the ai-job tool:start-a-recipe-run wrote; its step rows say how many agents the step has (`agents`) and may name the
// lanes (`lanes`), or take them from an earlier step's answer (`lanes_from`, so the count is that answer's); the run's own
// input may override `agents` for this run (`agents_per_step`, read through runStep). A step with one agent
// and no lanes list is done by the run's own AI and starts nothing; a step that lists its lanes runs them as jobs even when there is one.
//
//   startAStepsAgents({ input: { run, step }, task: { request_key } }, { door, most_writes })
//     -> { jobs: [<job id>], status: 'written' | 'already-there' | 'one-agent' }
//
// A lane's job id is `<run id>:<step id>:<lane id>`, so the step's check can tell its lanes' jobs from any other.
// The lane jobs are written in batches that each fit the door (most_writes records and the door's byte bound), the step's
// first lane last: its job being there means every lane job is, so a start that comes again finds it and changes none,
// even one an AI already finished. A batch that fails midway is sent again with its same request key.

import { keptAnswers, laneCommands, laneIds, laneJobId, runStep, runsLaneJobs } from './step-agents.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';

const JOB_KIND = 'ai-job';
const DOOR_BYTES = 48 * 1024; // under the door's 64 KiB message bound, leaving room for the write's own words

export async function startAStepsAgents({ input = {}, task = {} } = {}, { door, most_writes = 256 }) {
  const { run, step: stepId } = input;
  if (typeof run !== 'string' || !run || typeof stepId !== 'string' || !stepId) throw new Error('input.run and input.step must name the run and its step.');
  if (typeof task.request_key !== 'string' || !task.request_key) throw new Error('task.request_key is missing.');
  const parent = await door.read(JOB_KIND, run);
  if (!parent) throw new Error(`There is no run ${run}.`);
  const row = (parent.job ?? []).find(item => item.id === stepId);
  if (!row) throw new Error(`Run ${run} has no step "${stepId}".`);
  const step = runStep(row, parent.input);
  if (!runsLaneJobs(step)) return { jobs: [], status: 'one-agent' };
  const lanes = laneIds(step, step.lanes_from === undefined ? {} : await keptAnswers(door, run, parent.job, stepId));
  const jobs = lanes.map(lane => laneJobId(run, stepId, lane));
  if (await door.read(JOB_KIND, jobs[0])) return { jobs, status: 'already-there' };
  const records = lanes.map((lane, at) => ({
    id: jobs[at],
    type: JOB_KIND,
    value: {
      kind: JOB_KIND, status: 'waiting', row: parent.row, label: `${parent.label}: ${step.title ?? step.id}, lane ${lane}`,
      parent: run, step: stepId, lane, of: lanes.length, job: [step], input: parent.input ?? {}, cause: parent.cause ?? null,
      take_as: laneCommands(run, stepId, lane).as,
      lane_note: `You are lane ${lane} (${at + 1} of ${lanes.length}) of this step. Take and finish this job under your own id, ${laneCommands(run, stepId, lane).as} (${laneCommands(run, stepId, lane).take}), never your session's, so the step's check counts you as a separate worker. Do only this lane's part, and hand back that lane's item of the step's answer with its id set to ${lane}.`,
    },
  }));
  const batches = writeBatches([...records.slice(1), records[0]], { rows: most_writes, bytes: DOOR_BYTES });
  for (const [at, batch] of batches.entries()) await door.write(batch, { key: `${run}:${stepId}:batch-${at}` });
  return { jobs, status: 'written' };
}
