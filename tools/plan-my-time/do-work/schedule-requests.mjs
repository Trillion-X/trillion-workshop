// tools/plan-my-time/do-work/schedule-requests.mjs
//
// The two Workshop rows over the moved calendar planner, each one object in (run-an-export calls fn(input)):
//   planScheduleAroundEvents({ tasks, events, options, time_zone? }) -> planSchedule(tasks, events, options)
//   timeboxEventFor({ policy, task, proposal, todo_privacy? })       -> { event: timeboxEvent(...) | null, policies }
// `time_zone` (an IANA name) is the zone the planner's local day keys and working hours are read in; the planner itself
// reads the process's local zone, so it is set before planning. Nothing else is decided here.
import { planSchedule } from './schedule-planner.mjs';
import { timeboxEvent, timeboxPolicies } from './timebox-policy.mjs';

export function planScheduleAroundEvents({ tasks, events = [], options = {}, time_zone: zone } = {}) {
  if (zone !== undefined) {
    if (typeof zone !== 'string' || !Intl.supportedValuesOf('timeZone').includes(zone)) throw new TypeError('time_zone must be an IANA time zone name.');
    process.env.TZ = zone;
  }
  return planSchedule(tasks, events, options);
}

export function timeboxEventFor({ policy, task, proposal, todo_privacy: privacy } = {}) {
  if (!task || typeof task !== 'object' || !proposal || typeof proposal !== 'object') throw new TypeError('Send task and proposal (the planner\'s placement, with starts_at and ends_at).');
  return { event: timeboxEvent(policy, task, proposal, privacy), policies: timeboxPolicies };
}
