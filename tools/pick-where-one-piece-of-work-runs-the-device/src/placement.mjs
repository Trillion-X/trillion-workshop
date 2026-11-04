// src/placement.mjs
//
// Purpose
//   Picks where one piece of work for a person runs (zero-cost Trillion X move 10): the device that captured it, the
//   strongest of their devices that is awake, the device they open it on, their own AI subscription or cloud, and only
//   then Trillion's own machines, within a budget the person set. The places, their order, which jobs each can do and
//   who pays are DATA (src/placement.json); the caller hands the facts it knows and the formula engine's matcher.
//
// Non-negotiable invariants
//   1. Nothing here names a place, a job or a fact; each is a row of placement.json.
//   2. Trillion pays only inside the person's own budget: the `trillion_budget_dollars` fact is read from the person's
//      own spend row (budget_row), else the file's default, which is 0. A caller never supplies it.
//   3. A job no place can take now answers the `otherwise` place (wait), never a guess.
//
// Shapes
//   placeFor({ job, facts, matches, budgets, devices }) -> Promise<{ id, label, pays, device? }>
//     job       a job id of placement.json
//     facts     what the caller knows about this piece of work (placement.json facts, less trillion_budget_dollars)
//     matches   (tree, facts) -> Promise<boolean>, the formula engine over placement.json facts
//     budgets   the person's own spend rows (the store's spend_budgets fact)
//     devices   devicesAwake(...) for this job; their count is the devices_awake_that_can fact, and a place that runs
//               on a device answers the first of them as `device`
//   trillionBudgetDollars(budgets) -> number
//   devicesAwake({ job, card, now }) -> [{ placement, tool_id, agent_id }]
//     card      agent_id -> the agent's card (src/agents.mjs cardOf), or null
//     the job's `devices` whose placement's agent (records/workshop-placement-records.json settings.agent_id) is taking
//     work now (a capacity claim that has not expired) and lists the device tool among its skills
//
import data from './placement.json' with { type: 'json' };
import placementRecords from '../records/workshop-placement-records.json' with { type: 'json' };
import { cardSkillFor, formerAgentIds } from '../../shared-code/src/renamed-tools.mjs';

const AGENT_OF = new Map(placementRecords.records.map(record => [record.payload.id, record.payload.settings?.agent_id ?? null]));

export const placementFacts = data.facts;

/** The day budget the person set for Trillion's own machines doing their work, or the default (0). */
export function trillionBudgetDollars(budgets = []) {
  const own = (Array.isArray(budgets) ? budgets : []).find(row => row?.id === data.budget_row);
  const dollars = Number(own?.most_dollars ?? data.default_trillion_budget_dollars);
  return Number.isFinite(dollars) && dollars > 0 ? dollars : 0;
}

/** The job's devices that can take it right now, strongest first as the job lists them. */
export function devicesAwake({ job, card, now = new Date(), places = data, agentOf = id => AGENT_OF.get(id) ?? null }) {
  const row = places.jobs.find(item => item.id === job);
  if (!row) throw new Error(`No job ${job} in placement.json.`);
  return (row.devices ?? []).flatMap(device => {
    // A device app published before the rename advertises the former agent id; the current id wins when both exist.
    const current = agentOf(device.placement);
    const agent_id = current ? [current, ...formerAgentIds(current)].find(id => card(id)) ?? current : null;
    const agent = agent_id ? card(agent_id) : null;
    const claim = agent?.capacity_claim;
    const taking = agent?.takes_work !== false && claim && claim.max_concurrent > 0 && Date.parse(claim.expires_at) > now.getTime();
    const keeps = cardSkillFor(agent, device.tool_id) !== null;
    return taking && keeps ? [{ placement: device.placement, tool_id: device.tool_id, agent_id }] : [];
  });
}

export async function placeFor({ job, facts = {}, matches, budgets = [], devices = [], places = data }) {
  const row = places.jobs.find(item => item.id === job);
  if (!row) throw new Error(`No job ${job} in placement.json.`);
  const known = { devices_awake_that_can: devices.length, ...facts, trillion_budget_dollars: trillionBudgetDollars(budgets) };
  for (const place of places.places) {
    if (!row.can.includes(place.id)) continue;
    if (place.runs_on === 'device' && !devices.length) continue;
    if (!place.when || await matches(place.when, known)) return { id: place.id, label: place.label, pays: place.pays, ...(place.runs_on === 'device' ? { device: devices[0] } : {}) };
  }
  return { id: places.otherwise.id, label: places.otherwise.label, pays: null };
}
