// The MCP tools for links a person saved elsewhere (src/saved-links.mjs): a browser's saved-items file handed in, and
// one tool per list a connected service keeps (each `service_lists` row of src/saved-links.json names its own tool's
// title and words, so a new list is a DATA row, never an edit here). Each runs the Workshop tool of the same job
// (records/workshop-saved-links-tool-records.json), so a rule, a schedule and any AI calling run_tool do exactly the same thing.
import settings from '../../shared-code/src/saved-links.json' with { type: 'json' };

const run = (call, tool_id, input, job) => call('/tools/run', { tool_id, input, request_key: `${tool_id}:${crypto.randomUUID()}`, wait_seconds: 50, job });
const toolName = id => `save_${id.replace(/-/g, '_')}`;

const URL_WORDS = { type: 'string', description: 'The http or https address of the page' };
const KEY_WORDS = { type: 'string', description: 'The saved page key from read_saved_page, instead of its address' };
const HOURS_WORDS = { type: ['integer', 'null'], minimum: 1, maximum: 8760, description: 'Whole hours between refreshes; null for no refresh' };
const pageTool = (call, name, tool, description, properties, required, job) => ({ name, description, inputSchema: { type: 'object', required, properties }, run: input => run(call, `tool:${tool}`, input ?? {}, job) });

// Saved web pages (src/saved-pages.mjs): create, read, edit, refresh and delete a clip, and which provider handles a link.
const savedPageTools = call => [
  pageTool(call, 'save_page', 'save-page', 'Saves a web page as a clip in this person\'s files: its address, title, extracted text, a snapshot picture when the page-reading tool can draw one, a refresh policy and a last-refreshed stamp. Saving the same address again replaces its record. Returns the record and its file under /Saved pages.', { url: URL_WORDS, refresh_every_hours: HOURS_WORDS }, ['url'], 'save a web page'),
  pageTool(call, 'read_saved_page', 'read-saved-page', 'Reads one saved web page (by url or key): its text, title, snapshot reference, refresh policy and last-refreshed stamp. With neither, lists every saved page.', { url: URL_WORDS, key: KEY_WORDS }, [], 'read a saved page'),
  pageTool(call, 'edit_saved_page', 'edit-saved-page', 'Changes a saved page\'s refresh policy (refresh_every_hours, whole hours or null for none) and/or title; the page is not read again.', { url: URL_WORDS, key: KEY_WORDS, refresh_every_hours: HOURS_WORDS, title: { type: 'string' } }, [], 'edit a saved page'),
  pageTool(call, 'refresh_saved_pages', 'refresh-saved-pages', 'Reads again the saved pages whose refresh time has come (or the one given by url or key), updating text, snapshot and last-refreshed stamp; a page that fails keeps its last good text and records why. Put it on a schedule (set_schedule) to keep clips current.', { url: URL_WORDS, key: KEY_WORDS }, [], 'refresh saved pages'),
  pageTool(call, 'remove_saved_page', 'remove-saved-page', 'Deletes a saved page (by url or key) and its snapshot to Recently Deleted; put_back_file brings them back.', { url: URL_WORDS, key: KEY_WORDS }, [], 'delete a saved page'),
  pageTool(call, 'find_link_provider', 'find-link-provider', 'Says which registered provider a pasted address belongs to (by its host), the saved-list tools that read it and the names of the values its sign-in uses (never the values). An address no provider handles fails naming the registered ones.', { url: URL_WORDS }, ['url'], 'find a link provider'),
];

export const savedLinkTools = (call, data = settings) => [
  { name: 'save_browser_saved_items', description: 'Saves the links a person keeps in their browser (Arc: every pursuit\'s pinned tabs and folders, and the favorites along the top) into their Trillion files, one file per space under /Saved links, from the browser\'s own saved-items file. First send that file into their files: on their Mac, Arc keeps it at ~/Library/Application Support/Arc/StorableSidebar.json; send it with start_file_upload (or write_file), then give its identity or name as file. Each space\'s earlier file is replaced, because the browser\'s file is the whole truth. Returns each space\'s file and how many links it holds.', inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string', description: 'The saved-items file in their files: its identity (1f: then 64 hex) or its name, like /Arc/StorableSidebar.json' }, format: { type: 'string', description: 'The browser, when the file does not say: arc-sidebar' } } }, run: input => run(call, 'tool:save-browser-saved-items', input, 'save my browser\'s saved links') },
  ...Object.entries(data.service_lists).map(([id, list]) => ({ name: toolName(id), description: list.tool.description, inputSchema: { type: 'object', properties: { since: { type: 'string', description: list.tool.since } } }, run: input => run(call, `tool:save-${id}`, input ?? {}, list.tool.job) })),
  ...savedPageTools(call),
];

// Marketplace wrappers run an editable saved tool and may retain its task, receipts or effects.
// A job called read is not a server-owned promise that its current definition reads only.
export const savedLinkAnnotations = {
  save_page: { title: 'Save a web page as a clip', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  read_saved_page: { title: 'Read saved web pages', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  edit_saved_page: { title: 'Change a saved page\'s refresh or title', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  refresh_saved_pages: { title: 'Refresh saved pages that are due', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  remove_saved_page: { title: 'Delete a saved page', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  find_link_provider: { title: 'Find who handles a link', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  save_browser_saved_items: { title: 'Save my browser\'s pinned tabs and folders', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ...Object.fromEntries(Object.entries(settings.service_lists).map(([id, list]) => [toolName(id), { title: list.tool.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }])),
};
