// Resolve both current account gates before the workspace and its automatic tour paint.
export const PERSONAL_HOLD_TOOL = 'tool:see-what-holds-me';

/** Read through the maintained Workshop descriptor; its setup input is the current page answer. */
export async function readPersonalHold(run, input) {
  const { result } = await run(PERSONAL_HOLD_TOOL, input);
  const hold = result?.hold;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(hold) || typeof hold.on !== 'boolean' ||
    !(hold.held === null || (object(hold.held) && typeof hold.held.key === 'string' && hold.held.key.length > 0 && object(hold.held.section) && object(hold.held.card))) ||
    !Array.isArray(hold.ranked) || !Array.isArray(hold.stakes) || !Array.isArray(hold.hand_back) || !Number.isFinite(hold.asides_left)) {
    throw new TypeError('The hold did not answer its current state.');
  }
  return hold;
}

export async function readInitialPersonalHold(readSetup, readHold) {
  const setup = await readSetup();
  // The hold's Workshop owner receives this same current setup answer, rather
  // than deriving a second gate from an older copy or a different setup list.
  const hold = await readHold(setup);
  if (!hold || typeof hold !== 'object' || typeof hold.on !== 'boolean' || !('held' in hold)) {
    throw new TypeError('The initial hold did not answer its current state.');
  }
  return { setup, hold };
}
