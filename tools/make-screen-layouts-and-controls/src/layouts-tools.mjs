// src/layouts-tools.mjs
//
// Purpose
//   The MCP tools over the person store's /layouts routes (src/layouts.mjs), with their titles and hints. Kept apart from
//   src/layouts.mjs, which reads the page's own parts, so the tool list (src/tools.mjs) loads in node without them.
//

const idField = description => ({ type: 'string', description });

/** The MCP tools over the person store's /layouts routes. */
export const layoutTools = call => [
  { name: 'read_layouts', description: 'The screens this person can arrange (screen_id, label), the layouts their AIs made (each with its category), the categories they are filed in (in order) and the most recent, and the arrangement on their screen now (current) in the same short shape, so you can rearrange it, and each screen arranged inside itself (arranged: screen and arrangement). Each layout and each arranged screen carries identity (what is kept now; a layout also its edit count and its version, the number a part is pinned to), to send back as expected_identity when you change it. It changes nothing.', inputSchema: { type: 'object', properties: {} }, run: () => call('/layouts') },
  { name: 'save_layout', description: 'Makes a screen layout for the person, or rearranges the one on screen: layout is { id?, name, icon?, arrangement } where arrangement is a pane { kind: "pane", surfaces: [screen ids, or one thing such as the list you just made as { id, input, title? } with a screen from read_layouts opens_one_thing], show? } or a split { kind: "split", dir: "row" | "column", sizes? (relative, or pixels with unit: "px", 0 being the length of what it shows), stack? (a row narrower than this many pixels shows stacked), children: [...] } (read_layouts gives the screen ids and the current arrangement to change). With screen (a screen id) the arrangement becomes that screen\'s own instead, shown inside it wherever it is open (Home is one: an arrangement of screens); layout null with screen puts it back. It sits in their Layouts menu, under category when given (made when new; a layout sits in one category, so naming another moves it); open_now true opens it now on their open Trillion page, keeping the one it replaces as Previous layout. The same id again changes it; remove true with layout.id takes it away. expected_identity (the identity read_layouts gave, null for a new one) makes the save or removal happen only if nobody changed it since you read it; otherwise it is refused as stale and you read again. A layout can be a shared part of other layouts and screens: put { kind: "part", layout: <its layout_id>, version?: <its version from read_layouts to pin>, overrides?: { <key of a node inside it>: { surfaces?, show?, dir?, sizes?, hidden?: true } } } where a pane or split goes (give nodes a key to make them overridable). An unpinned part follows every change to it; a pinned one waits, listed in read_layouts updates_available until update_layout_parts. Removing a layout others use needs detach_users true, which writes its arrangement into each of them.', inputSchema: {
    type: 'object',
    properties: {
      layout: { type: 'object', description: '{ id?, name, icon? (a Lucide icon name), arrangement }' },
      category: idField('The category it is filed under in the Layouts menu, in a few words, such as "Launch" or "Writing"'),
      open_now: { type: 'boolean', description: 'true opens it now on the person\'s open page' },
      remove: { type: 'boolean', description: 'true with layout.id removes that layout' },
      detach_users: { type: 'boolean', description: 'With remove: when other layouts or screens use this layout as a part, write its arrangement into each of them and then remove it' },
      screen: idField('A screen_id from read_layouts: arrange inside that screen instead of making a layout'),
      by: idField('Your name as the person knows you, such as Claude or ChatGPT'),
      expected_identity: { type: ['string', 'null'], description: 'The identity read_layouts gave for this layout or arranged screen (null when it is not kept yet); a save from an older copy is refused' },
    },
  }, run: ({ remove, ...input }) => (remove === true ? call('/layouts/remove', { layout_id: input.layout?.id, ...(input.expected_identity !== undefined ? { expected_identity: input.expected_identity } : {}), ...(input.detach_users === true ? { detach_users: true } : {}) }) : call('/layouts/save', input)) },
  { name: 'open_layout', description: 'Opens a layout your AIs made (layout_id from read_layouts) now on the person\'s open Trillion page; the arrangement it replaces is kept as Previous layout. To open one at a time of day or when something happens, use set_schedule or set_rule with then { "tool_id": "tool:open-a-layout", "input": { "layout_id": "..." } }.', inputSchema: {
    type: 'object', required: ['layout_id'],
    properties: { layout_id: idField('A layout_id from read_layouts'), by: idField('Your name as the person knows you') },
  }, run: input => call('/layouts/open', input) },
  { name: 'update_layout_parts', description: 'Pins the layouts and screens that use a layout as a part (part: its layout_id) to one of its versions (version: a version number from read_layouts; left out, its version now) and redraws them from it. Without layouts or screens it updates every one that uses it; read_layouts updates_available lists who waits for a newer version. One rearranged by hand since it was drawn from its parts is left as it is and named in refused.', inputSchema: {
    type: 'object', required: ['part'],
    properties: {
      part: idField('The layout_id of the layout used as a part'),
      layouts: { type: 'array', items: { type: 'string' }, description: 'Only these layouts (layout_id)' },
      screens: { type: 'array', items: { type: 'string' }, description: 'Only these screens arranged in place (screen_id)' },
      version: { type: 'integer', minimum: 1, description: 'The part\'s version to pin to; left out, its version now' },
    },
  }, run: input => call('/layouts/sync', input) },
  { name: 'read_layout_versions', description: 'The kept versions of one layout (layout_id) or of a screen arranged in place (screen), newest first: each with its id, number, kind (save: the person\'s, ai: an AI\'s, manual and publish: kept on request), when and by whom. kind narrows to one kind; before (a next_cursor) reads older ones. It changes nothing.', inputSchema: {
    type: 'object',
    properties: { layout_id: idField('A layout_id from read_layouts'), screen: idField('A screen_id arranged in place'), kind: idField('Only versions of this kind'), before: { type: 'integer', minimum: 1, description: 'The next_cursor of the page before' } },
  }, run: input => call('/layouts/history', input) },
  { name: 'keep_layout_version', description: 'Keeps a layout (layout_id) or a screen\'s own arrangement (screen) as it is now as a version that is never pruned (kind manual, the default) or as a publish version.', inputSchema: {
    type: 'object',
    properties: { layout_id: idField('A layout_id from read_layouts'), screen: idField('A screen_id arranged in place'), kind: { type: 'string', enum: ['manual', 'publish'] } },
  }, run: input => call('/layouts/keep', input) },
  { name: 'restore_layout_version', description: 'Puts back a kept version (revision_id from read_layout_versions) of a layout or of a screen\'s own arrangement, exactly as it was, parts and pins included. A restored layout is kept in the Layouts menu, not opened (open_layout opens it). warnings name every screen and part that version uses that is gone. expected_identity (from read_layouts) refuses it if the layout changed since you read it.', inputSchema: {
    type: 'object', required: ['revision_id'],
    properties: { layout_id: idField('A layout_id from read_layouts'), screen: idField('A screen_id arranged in place'), revision_id: idField('A version id from read_layout_versions'), expected_identity: { type: ['string', 'null'], description: 'The identity read_layouts gave' } },
  }, run: input => call('/layouts/restore', input) },
];

export const layoutAnnotations = {
  read_layouts: { title: 'Read my screen layouts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  save_layout: { title: 'Make or rearrange a screen layout', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  open_layout: { title: 'Open a layout on my screen now', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  update_layout_parts: { title: 'Update the layouts that use a part', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_layout_versions: { title: 'Read the versions of a layout', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  keep_layout_version: { title: 'Keep this version of a layout', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  restore_layout_version: { title: 'Put back a version of a layout', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
