// tools/set-up-my-account/do-work/setup-actions.mjs
//
// PURPOSE
//   What the Get started screen's own buttons decide, as functions of their input. Ported from the retired repository
//   src/account-routes.mjs `actions` (tag before-worker-retire, b6ae0ebf81): 'setup/retry' (510), 'setup/stop' (511),
//   'setup/restart' (524) and 'setup/complete' (762). The screen (read-data/get-started-screen.mjs) draws the buttons whose
//   send paths are /work/api/setup/retry, /restart and /stop and the forms whose `complete_here` is in setup-policy.json.
//   Each function here only decides: it never calls an owner. The caller (the screen host's action runner) sends the
//   request this builds to the owner and hands the owner's answer to the matching *Answer function.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a step: completeSetupStep reads what a step writes from the policy DATA (complete_here.writes),
//      fills "{field}" from what the person typed, and leaves out a key whose words name an empty field, so an empty box never
//      overwrites what is saved.
//   2. A required field left empty is refused with the step's own words, and a refused step writes nothing.
//   3. A look or a viewer never stops setup. A stop names a run. A stop or a restart counts only when the owner's answer shows it.
//   4. Retry only re-reads the screen: it prepares nothing, restarts nothing and chooses no plan.
import words from '../read-data/setup-actions.json' with { type: 'json' };
import policy from '../read-data/setup-policy.json' with { type: 'json' };

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** setup/retry: the screen is read again; nothing else happens. */
export const retrySetup = () => ({ refresh: true });

/** setup/complete: the write one finished step asks for, or why it is refused.
 *  `requirements` defaults to the shipped policy; `body` is { step, values }. */
export function completeSetupStep({ body, requirements = policy.requirements, said = policy.words } = {}) {
  const complete = requirements.find(row => row.id === body?.step)?.complete_here;
  if (!complete?.writes) return { error: said.finished_elsewhere, status: 400 };
  const given = object(body.values) ? body.values : {};
  const values = Object.fromEntries(complete.fields.map(field => [field.name, typeof given[field.name] === 'string' ? given[field.name].trim() : '']));
  if (complete.fields.some(field => field.required && !values[field.name])) return { error: complete.missing, status: 400 };
  const filled = template => {
    if (Array.isArray(template)) return template.map(filled);
    if (object(template)) return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, filled(value)]).filter(([, value]) => value !== undefined));
    const named = [...String(template).matchAll(/\{(\w+)\}/g)].map(match => match[1]);
    return named.some(name => !values[name]) ? undefined : String(template).replace(/\{(\w+)\}/g, (_, name) => values[name]);
  };
  return { write: { method: complete.writes.method, path: complete.writes.path, body: filled(complete.writes.body) }, said: complete.said, refresh: true };
}

/** setup/stop: the request to stop one setup run, or why it is refused before any owner is asked.
 *  `refusedLook` is the refusal words a look or a viewer is given (the view-as owner's `read_only`). */
export function stopSetupRequest({ session = {}, body = {}, refusedLook } = {}) {
  if (session.look_only || session.viewer) return { error: refusedLook, code: 'look_read_only', status: 403 };
  if (typeof body.run_id !== 'string' || !body.run_id.trim()) return { error: words.stop_needs_a_run, status: 400 };
  return { request: { run_id: body.run_id, reason: words.stop_reason } };
}

/** The owner's answer to a stop: said only when it really stopped the run and left its withdrawal. */
export function stopSetupAnswer(answer, status = 200) {
  if (status >= 400) return { ...answer, status };
  if (answer?.stopped !== true || !answer.run?.withdrawal) return { error: words.stop_not_verified, status: 502 };
  return { stopped: true, run: answer.run, said: words.stopped, refresh: true };
}

/** The owner's answer to a restart ({ restart: true } asked of the setup runtime): said only when the workflow is live again. */
export function restartSetupAnswer(answer, status = 200) {
  if (status >= 400) return { ...answer, status };
  if (!answer?.workflow?.exists || answer.workflow.withdrawn || answer.workflow.state === 'failed' || answer.provisioned?.workflow?.state === 'failed') return { error: words.restart_not_done, status: 409 };
  return { said: words.restarted, refresh: true };
}
