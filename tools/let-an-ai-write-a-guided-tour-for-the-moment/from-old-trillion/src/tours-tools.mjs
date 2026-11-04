// src/tours-tools.mjs
//
// Purpose
//   The MCP tools over the person store's /tours routes (src/tours.mjs), with their titles and hints. Kept apart from
//   src/tours.mjs, which reads the page's own parts, so the tool list (src/tools.mjs) loads in node without them.
//

const idField = description => ({ type: 'string', description });

/** The MCP tools over the person store's /tours routes. */
export const tourTools = call => [
  { name: 'read_tours', description: 'The guided tours this person\'s AIs wrote: each tour (tour_id, title, steps, category, who wrote it, when, whether the person took it), the categories in order, the most recent, the card kinds a step can show (card_kinds) and the fields of a step (step_fields). This lists only tours written by the person’s AIs. Trillion’s built-in welcome and screen guides are separate; an empty result does not establish that onboarding is absent. This read does not observe the currently visible guide. Read it before save_tour. It changes nothing.', inputSchema: { type: 'object', properties: {} }, run: () => call('/tours') },
  { name: 'save_tour', description: 'Keeps a guided tour you write for this moment, as DATA the person\'s Trillion runs: the page dims and blurs, each step points at an element (target_ref, a CSS selector) or shows centred, and each card is a glance card (icon, tone, title, the one key value, facts, chips, a chart), never a paragraph. tour is { id?, title, summary?, steps: [step], entry_step? } with steps as read_tours step_fields says; category files it (made when new; "From your AIs" when left out); show_now true starts it at once on the person\'s open Trillion page. The same id again changes that tour. remove true with tour.id takes it away. Returns the tour kept.', inputSchema: {
    type: 'object',
    properties: {
      tour: { type: 'object', description: '{ id?, title, summary?, urgency? (low, normal or urgent: an urgent tour that starts by itself passes the person\'s rules that hold the rest), triggers? (when it starts by itself, as walkthrough triggers), look?: { spotlight?: { click_behavior?: all | target | none } }, steps: [{ id, content: { content_kind, payload }, target_ref?, target_preparation?, placement?, centered_when_target_missing?, look?: { spotlight?: { click_behavior?: all | target | none } }, nav? }], entry_step? }. Click behavior defaults to all; target lets only the highlighted control take clicks; none makes the page read-only.' },
      category: { type: 'string', description: 'The category to file it in, in a few words, such as "Your week" or "Launch"' },
      show_now: { type: 'boolean', description: 'true starts it now on the person\'s open page' },
      remove: { type: 'boolean', description: 'true with tour.id removes that tour' },
      by: idField('Your name as the person knows you, such as Claude or ChatGPT'),
    },
  }, run: ({ remove, ...input }) => (remove === true ? call('/tours/remove', { tour_id: input.tour?.id }) : call('/tours/save', input)) },
  { name: 'show_tour', description: 'Starts a tour now on the person\'s open Trillion page: one your AIs wrote (tour_id from read_tours) or one of Trillion\'s own, or with next true the next tour waiting to show by itself (What\'s new). The person can skip a step or end it. To show the next one on the person\'s own schedule or when something happens, use set_schedule or set_rule with then { "tool_id": "tool:show-a-tour", "input": { "next": true } }; their show rules (subject tour, started_by asked) still decide.', inputSchema: {
    type: 'object',
    properties: { tour_id: idField('A tour_id from read_tours'), next: { type: 'boolean', description: 'true: the next tour waiting to show by itself' }, by: idField('Your name as the person knows you') },
  }, run: input => call('/tours/show', input) },
];

export const tourAnnotations = {
  read_tours: { title: 'Read the tours my AIs wrote', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  save_tour: { title: 'Write a guided tour on my screen', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  show_tour: { title: 'Show me a tour now', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
