// tools/workflows/read-data/workflow-run-holder.mjs
//
// Who may answer or cancel a run started by the door. The holder is the run's starter. Until the engine records the starter on
// each run's envelope (run.started_by, as the engine writes it from the start fact), no caller is shown to be the starter, so every check refuses,
// and the refusal says what is missing. The check is one function both the cancel and the answer programs call.
export const UNNAMED = 'the run does not record its starter yet (the engine must write started_by on the run envelope); no one is shown to hold it';

/** run: the run's envelope fields ({ actor, started_by }); caller: the account asking. Returns { ok: true } or { ok: false, why }. */
export function holderCheck(run, caller) {
  if (!caller) return { ok: false, why: 'the caller is not known; nothing was done' };
  if (!run?.started_by) return { ok: false, why: UNNAMED };
  if (run.started_by !== caller) return { ok: false, why: `the run was started by ${run.started_by}, not ${caller}; nothing was done` };
  return { ok: true };
}
