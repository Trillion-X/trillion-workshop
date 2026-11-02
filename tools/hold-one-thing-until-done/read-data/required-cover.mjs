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
