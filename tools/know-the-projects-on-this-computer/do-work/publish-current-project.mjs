// tools/know-the-projects-on-this-computer/do-work/publish-current-project.mjs
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The pure parts of the retired publish-current-project action and its two
// triggers (verify-every-port lane L14, capabilities C8 to C10):
//   - the change predicate of trigger:publish-current-project-on-change
//     (a change to subject current-project:current, property
//     prop:current_project:id);
//   - the predicate of trigger:publish-current-project-on-runtime-loaded
//     (properties.event_type === "runtime_loaded");
//   - the payload the action wrote to the current-project sink: one row with
//     activeProject, which read-data/read-current-project.ts decodes.
//
// The wake that runs these on a change, and the store the selection is read
// from, are not here. They need the engine's waiter and a current store, and
// are held as To do rows with evidence (see the tool README).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The current project is one value: a non-empty string or nothing.
// 2. An empty or unreadable selection publishes an empty row list, which the
//    decoder reads as no current project. It never publishes a guessed one.
// 3. The payload text is JSON, the form read-json-payload.ts parses.
//
// =============================================================================

/** The subject and property of the one current-project selection fact. */
export const CURRENT_PROJECT_SUBJECT = 'current-project:current';
export const CURRENT_PROJECT_PROPERTY = 'prop:current_project:id';

/** The event that runs the publish when the runtime starts. */
export const RUNTIME_LOADED_EVENT = 'runtime_loaded';

/** True when a change is a write to the current-project selection. */
export function isCurrentProjectChange(change) {
  return change?.subject_id === CURRENT_PROJECT_SUBJECT && change?.property_id === CURRENT_PROJECT_PROPERTY;
}

/** True when the event is the runtime-loaded event. */
export function isRuntimeLoadedEvent(change) {
  return change?.properties?.event_type === RUNTIME_LOADED_EVENT;
}

/** The selected project id from the stored value_json text ("\"id\""), or null. */
export function activeProjectFromValueJson(valueJson) {
  if (typeof valueJson !== 'string') return null;
  let value;
  try {
    value = JSON.parse(valueJson);
  } catch {
    return null;
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The current-project sink payload: [{activeProject}] as JSON text, or [] when nothing is selected. */
export function currentProjectPayload(activeProject) {
  return JSON.stringify(typeof activeProject === 'string' && activeProject.length > 0 ? [{ activeProject }] : []);
}
