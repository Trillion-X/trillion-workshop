// tools/hold-one-thing-until-done/read-data/required-cover.mjs
//
// Moved from trillion src/setup-steps.mjs (setupScreenComplete), unchanged.

/** The workspace gate reads the existing Get started screen. Overall checklist progress includes optional steps. */
export function setupScreenComplete(screen) {
  if (screen?.ready === true) return true;
  if (screen?.ready === false) return false;
  if (screen?.policy !== undefined) {
    const policy = screen.policy;
    const steps = screen.requirements ?? screen.sections?.[0]?.steps;
    if (policy?.requirements_resolved !== true || !Number.isInteger(policy.required_count) || policy.required_count < 0 ||
      !Array.isArray(steps) || !steps.every(step => typeof step?.required === 'boolean')) return false;
    const required = steps.filter(step => step.required);
    return required.length === policy.required_count && required.every(step => step.done === true);
  }
  // During a rolling deployment an older server can still answer without `ready`.
  // Its all-done result is safe to accept; an incomplete legacy answer remains locked.
  const done = screen?.progress?.done;
  const total = screen?.progress?.total;
  return Number.isInteger(done) && Number.isInteger(total) && total > 0 && done === total;
}

/** The key the cover is held under when the gate row names none. A gate row that lost its key must never leave the
 *  workspace open: the cover stands under this key until required setup is done. */
export const DEFAULT_COVER_KEY = 'required-setup';

/** The cover a page draws over everything until required setup is done: `{ covered, key }`. `screen` is the Get
 *  started answer (setupScreenComplete reads it); `gate` is the person's gate row, whose `key` names the cover. */
export function requiredCover(screen, gate) {
  const key = typeof gate?.key === 'string' && gate.key.trim() ? gate.key : DEFAULT_COVER_KEY;
  return { covered: !setupScreenComplete(screen), key };
}

/** The same decision from the person's setup step rows (each `{ required, done }`): covered while any required row is
 *  not done. With no rows the rows decide nothing (`covered: null`), so the caller reads the Get started answer. */
export function requiredCoverOfRows(rows, gate) {
  const key = requiredCover(null, gate).key;
  if (!Array.isArray(rows) || !rows.length) return { covered: null, key };
  return { covered: rows.some(row => row?.required === true && row?.done !== true), key };
}
