// src/workspace/panel-setup.mjs
//
// PURPOSE
//   The message contract of the panel's "Set up this Mac" section (macos/App/MenuBarPanel.swift, F-0061 placement and
//   F-0074 permission guide), kept apart from the rows that draw it so both ends and the test read one definition.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The page asks with { kind: 'placement' } and { kind: 'permissions' }. It changes one placement step with
//      { kind: 'placement', id, action: 'apply' | 'undo' } and opens one permission guide with { kind: 'permissions', id }.
//      The host answers every one of them: window.trillionAlone.placement({ steps }) and
//      window.trillionAlone.permissions({ switches }).
//   2. What a row shows is what the host answered (a step is done only when the host says so); an answer that is not that shape
//      is taken as no answer, so a host that does not know the message shows no section.
//   3. The steps and switches are the host's DATA (App/placement.json, computer/computer-sources.json gates); this file names none.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const text = value => typeof value === 'string' && value !== '';

/** Ask the host for the placement steps and whether each is done. */
export const askPlacement = () => ({ kind: 'placement' });
/** Apply (`done` false) or take back (`done` true) one placement step. */
export const changePlacement = (id, done) => ({ kind: 'placement', id, action: done ? 'undo' : 'apply' });
/** Ask the host for the permission switches it can guide. */
export const askPermissions = () => ({ kind: 'permissions' });
/** Open the guide for one permission switch. */
export const openPermissionGuide = id => ({ kind: 'permissions', id });

/** The host's placement answer as the rows show it, or null when it is not an answer. */
export function placementState(answer) {
  if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.steps)) return null;
  const steps = answer.steps.filter(row => row && text(row.id) && text(row.title) && text(row.done_title) && typeof row.done === 'boolean');
  if (steps.length !== answer.steps.length || steps.length === 0) return null;
  return { steps: steps.map(({ id, title, done_title, done }) => ({ id, title, done_title, done })) };
}

/** The host's permission answer as the rows show it, or null when it is not an answer. */
export function permissionsState(answer) {
  if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.switches)) return null;
  const switches = answer.switches.filter(row => row && text(row.id) && text(row.title));
  if (switches.length !== answer.switches.length || switches.length === 0) return null;
  return { switches: switches.map(({ id, title }) => ({ id, title })) };
}
