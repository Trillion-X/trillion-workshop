// The MCP tools for a person's saved logins (src/saved-logins.mjs): listing them without their values, keeping one,
// importing a pasted export, reading one the person let their AIs read, and turning that permission on from the person's
// own words (let_ais_read_logins: their kept message and the exact words in it) or off. No tool shows a value the person
// kept to themselves, and none turns reading on without the person's own message.
const login = {
  type: 'object',
  required: ['fields'],
  properties: {
    site: { type: 'string', description: 'The site or app, such as an address' },
    title: { type: 'string', description: 'The name it is listed under; the site\'s name when left out' },
    user_name: { type: 'string' },
    fields: { type: 'array', minItems: 1, items: { type: 'object', required: ['label', 'value'], properties: { label: { type: 'string', description: 'Like Password, Notes, PIN or API token' }, value: { type: 'string' } } } },
  },
};

export const savedLoginTools = call => [
  { name: 'list_saved_logins', description: 'Lists the logins this person keeps in Trillion (Saved logins on their Connections screen): each login_id, title, site, user_name, the names of its values (never the values), whether they let their AIs read it (ai_can_read), and when each value was last shown and to whom. It changes nothing.', inputSchema: { type: 'object', properties: {} }, run: () => call('/saved-logins') },
  { name: 'save_login', description: 'Keeps one login for this person, its values locked in their account: site, user_name and fields (each { label, value }, such as Password, Notes or a PIN). The same title and user name again replaces those values and keeps the others. The person sees and copies each value on their Connections screen after confirming it is them. Save only logins the person gave you or asked you to keep, never one you found that is not theirs.', inputSchema: login, run: input => call('/saved-logins', { save: input }) },
  { name: 'import_logins', description: 'Keeps many logins for this person at once from text: a CSV export from a password manager or browser (a header row such as name, url, username, password, notes), or the text of a page where they keep logins (each service a toggle or indented item holding its user names, each user name holding its password). Same title and user name replaces. Returns how many were saved and replaced and which lines were skipped and why. Never echo the text back.', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, run: ({ text }) => call('/saved-logins', { import: text }) },
  { name: 'let_ais_read_logins', description: 'Turns on "Let my AIs read" for this person\'s own saved logins because they already said so in their own words: approval_message_id names a kept message the person typed themselves (read_messages, speaker person; one recorded from their Claude Code or Codex session or typed on their signed-in page, never one an AI wrote with record_messages, which is refused) and quote is the exact words in it that let their AIs use their logins (at least 4 words, copied as written). all: true covers every login they keep now and any they keep later; login_ids covers only those. The grant is kept with that message and shown on their Connections screen with one Stop. Use it instead of asking the person again when they already said their AIs may use their logins; never for someone else\'s logins. on: false (with all or login_ids) turns reading off and needs no message.', inputSchema: { type: 'object', properties: { all: { type: 'boolean' }, login_ids: { type: 'array', items: { type: 'string' } }, approval_message_id: { type: 'string' }, quote: { type: 'string' }, on: { type: 'boolean' } } }, run: ({ on, all, login_ids, approval_message_id, quote }) => call('/saved-logins', on === false ? { stop: { all: all === true, login_ids: login_ids ?? [] } } : { grant: { all: all === true, login_ids: login_ids ?? [], approval_message_id, quote } }) },
  { name: 'read_saved_login', description: 'Reads every value of one saved login (login_id from list_saved_logins), only when the person turned on "Let my AIs read this login" for it; otherwise it is refused. The person turns it on on their Connections screen, or, when they already said their AIs may use their logins, let_ais_read_logins turns it on from that message without asking them again. Each read is listed for the person under the login with this app\'s name. Use the values only for what the person asked (such as signing in), never repeat them in chat, files or logs.', inputSchema: { type: 'object', required: ['login_id'], properties: { login_id: { type: 'string' } } }, run: ({ login_id }) => call('/saved-logins', { read: login_id }) },
];

export const savedLoginAnnotations = {
  list_saved_logins: { title: 'List my saved logins', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  save_login: { title: 'Save a login for me', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  import_logins: { title: 'Import my logins', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  let_ais_read_logins: { title: 'Let my AIs read my logins, as I said', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_saved_login: { title: 'Read a login I let my AIs use', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
