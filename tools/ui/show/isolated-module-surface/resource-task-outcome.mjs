const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const TASK_STATES = new Set(['working', 'scheduled', 'waiting', 'failed', 'cancelled', 'unknown']);
const EFFECT_STATES = new Set(['dispatching', 'unknown', 'rejected', 'succeeded']);

/** Project an addressed task to the small status record safe for a saved module. */
export function resourceTaskOutcome(value, requestKey) {
  if (!object(value) || typeof value.task_id !== 'string' || !value.task_id.trim() || value.task_id.length > 200
    || typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 200) return null;
  return {
    task_id: value.task_id,
    request_key: requestKey,
    state: TASK_STATES.has(value.state) ? value.state : 'unknown',
    ...(EFFECT_STATES.has(value.effect_state) ? { effect_state: value.effect_state } : {}),
  };
}

/** Read only our typed action rejection and drop any extra owner-supplied fields. */
export function resourceTaskOutcomeFromError(error) {
  if (!object(error) || error.code !== 'resource_task_outcome' || !object(error.task)) return null;
  return resourceTaskOutcome(error.task, error.task.request_key);
}
