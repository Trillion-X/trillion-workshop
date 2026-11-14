// src/automation-open-id.mjs
//
// PURPOSE
//   The one place that says what id a trigger or schedule opens with: `automation:<id>` (its tab, its hover card, its
//   preview graph). A workflow or a run opens with its own id. Listings carry the result (`open_id`) so no screen or
//   card works it out again.

export const AUTOMATION_TAB = 'automation:';

/** The id a trigger or schedule (by its rule or schedule id) opens with. */
export const automationOpenId = id => `${AUTOMATION_TAB}${id}`;
