// Setting a sent deal's follow-ups as the person's own rules (run when the deal is paid) and schedules (run at a set
// time). Port of setDealFollowUps in the old native commercial owner (src/native-commercial-domain.mjs at 3b7063d6f3).
// Storage-free: the caller passes the checked steps, the fill of their words, and the automation action that keeps each
// rule or schedule; a step the action refuses is reported with its reason and the rest still go.
import data from './set-follow-up-rules-and-schedules.json' with { type: 'json' };

/**
 * checked: [{ kind: 'rule' | 'schedule', input }] from the follow-up planner; facts: the deal's facts for the words;
 * fill(steps, facts) → the steps with their words filled; setAction(action_name, args) → { rule_id } | { schedule_id }.
 * → { follow_ups: [{ label, rule_id } | { label, schedule_id, once_at } | { label, refused }] }, or {} when there are none.
 */
export async function setDealFollowUps({ checked, facts, fill, setAction }) {
  if (!checked.length) return {};
  const steps = fill(checked, facts);
  const follow_ups = [];
  for (const step of steps) {
    const action = step.kind === 'rule' ? data.rule_action : data.schedule_action;
    try {
      const set = await setAction(action, { operation: data.operation, ...step.input });
      follow_ups.push({
        label: step.input.label,
        ...(step.kind === 'rule' ? { rule_id: set.rule_id } : { schedule_id: set.schedule_id, once_at: step.input.once_at }),
      });
    } catch (error) {
      follow_ups.push({ label: step.input.label, refused: String(error?.message ?? error) });
    }
  }
  return { follow_ups };
}
