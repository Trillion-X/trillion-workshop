// src/sidebar-tools.mjs
//
// Purpose
//   The MCP tools over the account's /sidebar routes (src/sidebar.mjs): read_sidebar, note_in_sidebar and
//   change_sidebar, with their titles and hints. Kept apart from src/sidebar.mjs, which reads the sidebar through the
//   page's own parts, so the tool list (src/tools.mjs) loads in node without them.
//

const idField = description => ({ type: 'string', description });
const placementFields = {
  before: idField('Put it just before this row_id in the same list'),
  after: idField('Put it just after this row_id in the same list'),
  at: { type: 'string', enum: ['start', 'end'], description: 'Put it first or last' },
};

/** The MCP tools over the account's /sidebar routes. */
export const sidebarTools = call => [
  { name: 'read_sidebar', description: 'What this person\'s Trillion sidebar shows: every list (list_id, name, the list it sits inside) with its rows in order (row_id, label), every row a list can hold (each screen and tool), and the notes on lists and rows. Read it to find the ids note_in_sidebar and change_sidebar take. It changes nothing.', inputSchema: { type: 'object', properties: {} }, run: () => call('/sidebar') },
  { name: 'note_in_sidebar', description: 'Points the person to a list or row in their sidebar: on is a list_id or row_id from read_sidebar; message is what you want them to do there, in a sentence; count a number to show on it; highlight true marks it; opens names screens (row_ids) offered in its hover card. The note shows on that list or row and when the person points at it, and a message also reaches their notifications once. One note per list or row: a new one replaces it, and a note with only on takes it off. Take it off once they did it.', inputSchema: {
    type: 'object',
    required: ['on'],
    properties: {
      on: idField('A list_id or row_id from read_sidebar'),
      message: { type: 'string', description: 'What you want the person to do there, in one sentence' },
      count: { type: 'integer', minimum: 1, description: 'A number to show on it, such as how many things wait there' },
      highlight: { type: 'boolean', description: 'true marks it so it stands out' },
      opens: { type: 'array', items: { type: 'string' }, description: 'row_ids of screens to offer in its hover card' },
      by: { type: 'string', description: 'Your name as the person knows you, such as Claude or ChatGPT' },
    },
  }, run: input => call('/sidebar/note', input) },
  { name: 'change_sidebar', description: 'Changes the person\'s sidebar lists, in order, as one change: { do: "make_list", name, list_id?, holds?, order_by?, shown_when? } makes a list; { do: "set_rule", list_id, row_id?, holds?, order_by?, shown_when? } puts rules on one of their own lists, or on one row of it (shown_when only), null taking a rule off. holds is a rule over each row\'s facts and the list holds every row it is true for (beside that row\'s own list); shown_when is a rule over the list\'s facts (or, with row_id, the row\'s) and it shows only while the rule holds; order_by is { path: ["listed_on"], descending: true }. A rule is the formula engine\'s tree { kind: "group", combinator: "and" | "or", negate: false, rules: [{ kind: "rule", field, operator, params }] } over the facts read_sidebar lists under facts (now is a date in milliseconds; days_since_made, days_since_listed and the like are numbers). For 7 days after it is made: { field: "days_since_made", operator: "less_than", params: { value: 7 } }; until a time: { field: "now", operator: "before", params: { value: <ms> } }. Rules are decided again as time passes, so a list or row comes and goes by itself; read_sidebar shows those hidden now under not_shown_now; { do: "rename_list", list_id, name }; { do: "remove_list", list_id } deletes one of their own lists; { do: "add", list_id, row_id } puts any row (a screen or a tool) in a list, which may hold rows of any kind; { do: "remove", list_id, row_id } takes it out; { do: "order", list_id, row_id, before | after | at } moves it within the list; { do: "move", from_list_id, list_id, row_id } moves it to another list; { do: "style", row_id, colour?, place? } draws a row in a colour (grey, blue, turquoise, green, yellow, orange, red, pink, purple) and keeps it in a place of the sidebar ("bottom": at the foot below every list; "controls": among the icons at the top), null putting either back. A list of Trillion\'s own becomes the person\'s copy on its first change. Returns the lists as they are now.', inputSchema: {
    type: 'object',
    required: ['changes'],
    properties: {
      changes: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['do'],
          properties: {
            do: { type: 'string', enum: ['make_list', 'rename_list', 'remove_list', 'add', 'remove', 'order', 'move', 'style', 'set_rule'] },
            list_id: idField('A list_id from read_sidebar (for make_list, an id of your choosing, made for you when left out)'),
            from_list_id: idField('For move: the list the row is in now'),
            row_id: idField('A row_id from read_sidebar'),
            name: { type: 'string', description: 'For make_list and rename_list: what the list is called' },
            colour: { type: ['string', 'null'], description: 'For style: a colour of the palette, or null for the app\'s own' },
            place: { type: ['string', 'null'], description: 'For style: bottom or controls, or null to keep it in its lists' },
            holds: { type: ['object', 'null'], description: 'For make_list and set_rule: a rule tree over each row\'s facts; the list holds every row it is true for' },
            order_by: { type: ['object', 'null'], description: 'With holds: { path, descending? }, the row value its rows are ordered by' },
            shown_when: { type: ['object', 'null'], description: 'For make_list and set_rule: a rule tree over the list\'s facts (or, with row_id, the row\'s); it shows only while the rule holds' },
            ...placementFields,
          },
        },
      },
    },
  }, run: input => call('/sidebar/change', input) },
];

export const sidebarAnnotations = {
  read_sidebar: { title: 'Read my sidebar', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  note_in_sidebar: { title: 'Point to a list or row in my sidebar', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  change_sidebar: { title: 'Change my sidebar lists', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
