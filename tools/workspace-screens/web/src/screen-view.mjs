// src/screen-view.mjs
//
// Purpose
//   Trillion's screens drawn inside an AI app (ChatGPT, Claude) through the MCP Apps standard: the tool names a `ui://`
//   view, the app loads it in its own frame, and the view mounts the very screen the person sees in Trillion
//   (src/workspace/screen-view.tsx, mounting from src/workspace/screen-mounts.ts). This module is the server half:
//   show_screen (any screen by its id, name, address or tool), the view every tool in ./screen-view.json `tools` shows
//   its answer in, the view document itself, and screen_read, the one road a screen in a chat reads and changes the
//   person's Trillion by.
//
// Non-Negotiable Invariants
//   1. One screen implementation: nothing here draws; the view mounts the workspace's own screens in the person's look.
//   2. No screen, tool or address is named in code: which screens exist is src/workspace/screens.mjs, which tools show
//      one and which addresses a screen in a chat may read are ./screen-view.json.
//   3. A screen in a chat never holds a credential. Its reads are tool calls the app makes as the person who connected
//      it (screen_read), answered by the same workspace routes the signed-in page reads, for that person only; what is
//      done only in Trillion itself (sign-in methods, keys, saved logins, devices) is refused there.
//   4. Where an AI app opens a screen from besides the model's own call (ChatGPT's sidebar home and side panel) is DATA:
//      the `placements` in ./screen-view.json. placementEntrypoints below is the one adapter from those rows to
//      ChatGPT's `_meta["openai/ui"].entrypoints`; no tool is named or patched for a host here. A tool with a placement
//      is opened with `{}` by the host, so it must run with no input.
//   5. screen_read is for the view alone: the app keeps it from the AI (`_meta.ui.visibility`), and its calls leave no
//      AI activity and take no notices meant for the AI (src/worker.mjs).
//
import settings from './screen-view.json' with { type: 'json' };
import { pathWithin } from 'trillion-workshop/tools/http-client/do-work/same-origin.mjs';
import workspaceScreens from './workspace/screens.mjs';
import firstAnswers from './workspace/first-answers.json' with { type: 'json' };
import { screenOfAddress } from './workspace/addresses.mjs';
import { aiAppViewDocument } from '../parts/ui/show/ai-app-bridge/ai-app-view-document.mjs';
import { VIEW_DATA, withSaid, withViewData } from './tool-reply.mjs';
import { wornLook } from './page-look.mjs';
import { lookDocumentCss } from 'trillion-workshop/tools/screen-look/read-data/look-document-css.js';
import { EMBEDDED_SHELL_CSS } from 'trillion-workshop/tools/screen-look/embedded-shell-css.mjs';
import { PARTS_SCREEN, partsGuide, screenSpecAi, screenSpecLimits, specFromText } from './screen-spec.mjs';

export const SCREEN_VIEW_URI = settings.view.uri;
const VIEW_MIME_TYPE = 'text/html;profile=mcp-app';
/** Where a tool's answer says, for the view alone, which screen to draw: `{ id, input, address }`. */
export const SCREEN_DATA_KEY = 'trillion/screen';
export const SCREEN_VIEW_HOST_ID = 'trillion-screen';
export const SCREEN_VIEW_WORDS_ID = 'trillion-screen-words';
const { words } = settings;
// The app's own name in its screen ids (`trillion.decisions`), from its screens list's address.
const APP = String(workspaceScreens.address_label).split('::').at(-1);
const rows = workspaceScreens.surfaces;

// The address a screen row opens at, with its input when the row takes one from its address.
function addressOf(row, input) {
  if (row.route_prefix && row.route_input && typeof input?.[row.route_input] === 'string') return `${row.route_prefix}${encodeURIComponent(input[row.route_input])}`;
  return row.route_paths?.[0] ?? null;
}

// Trillion itself, the whole workspace (./screen-view.json `whole`): the view draws the person's sidebar and arrangement.
const WHOLE_NAMES = new Set(settings.whole.names.map(name => name.toLowerCase()));
const wholeWorkspace = input => ({ id: `${APP}.workspace`, label: settings.whole.label, input, address: settings.whole.address, whole: true });

/** The screen `asked` names: Trillion itself (any `whole.names`: the whole workspace, `whole: true`), an address
 * (`/decisions/<id>`), a screen id (`trillion.files` or `files`), a screen's name (`Files`) or a tool id (`tool:drives`,
 * its own screen). Answers `{ id, label, input, address, whole? }` or null. */
export function screenFor(asked, input = {}) {
  const text = String(asked ?? '').trim();
  if (!text) return null;
  if (WHOLE_NAMES.has(text.toLowerCase())) return wholeWorkspace(input && typeof input === 'object' ? input : {});
  const opened = text.startsWith('/') ? new URL(text, 'https://trillion.invalid') : null;
  const path = opened?.pathname ?? (text.startsWith('tool:') ? `/use/${encodeURIComponent(text)}` : null);
  const routed = path ? screenOfAddress(rows, path, opened?.search ?? '') : null;
  const lower = text.toLowerCase();
  const row = routed?.row ?? rows.find(item => item.id === text || item.id === `${APP}.${text}` || String(item.label ?? '').toLowerCase() === lower);
  if (!row) return null;
  const onOwnPath = Object.fromEntries(Object.entries(row.route_query_on_path ?? {}).flatMap(([field, name]) => (opened?.searchParams.get(field) ? [[name, opened.searchParams.get(field)]] : [])));
  const given = { ...(routed?.input ?? {}), ...onOwnPath, ...(input && typeof input === 'object' ? input : {}) };
  return { id: row.id, label: row.label, input: given, address: opened ? `${opened.pathname}${opened.search}` : addressOf(row, given) };
}

// The address a tools row names, from the call's input and answer, or null when a value it needs is missing.
function addressFrom(parts, input, result) {
  if (!Array.isArray(parts)) return null;
  const values = parts.map(part => (typeof part === 'string' ? part : ({ input, result })[part.from]?.[part.field]));
  return values.every(value => typeof value === 'string' && value) ? values.map((value, at) => (typeof parts[at] === 'string' ? value : encodeURIComponent(value))).join('') : null;
}

export function focusedIfMatches(rule, input, result) {
  if (!rule) return false;
  const source = rule.from === 'input' ? input : rule.from === 'result' ? result : null;
  return source?.[rule.field] === rule.equals;
}

/** The ChatGPT entrypoints (`[{ type: 'global' }]` for the sidebar home, `[{ type: 'thread' }]` for a side panel) a
 * ./screen-view.json `tools` row's `placements` name, or [] when it has none. */
export function placementEntrypoints(row) {
  return (row?.placements ?? []).flatMap(placement => (settings.placements?.[placement.in]?.chatgpt ? [{ type: settings.placements[placement.in].chatgpt }] : []));
}

/** The title a tool's placement gives it (the host shows it on the sidebar entry or the side-panel tab), or null. */
export const placementTitle = name => settings.tools[name]?.placements?.find(placement => placement.title)?.title ?? null;

const viewMeta = { ui: { resourceUri: SCREEN_VIEW_URI }, 'openai/outputTemplate': SCREEN_VIEW_URI, 'openai/toolInvocation/invoking': words.invoking, 'openai/toolInvocation/invoked': words.invoked };

// A tool's view is declared before its answer exists. Only attach it when the address can be made
// from fixed parts or required string inputs; a result-dependent address may never be returned. A row's `otherwise`
// address, used when its `address` cannot be made (an optional input left out, an answer without the value), counts
// as well, so a tool whose own address may be missing still always names a screen.
function alwaysNamesScreen(tool, parts) {
  const required = new Set(tool.inputSchema?.required ?? []);
  return Array.isArray(parts) && parts.every(part => typeof part === 'string' || (part.from === 'input'
    && required.has(part.field) && tool.inputSchema?.properties?.[part.field]?.type === 'string'));
}

// A tool's answer with the screen it is shown in attached for the view (a list answer stays a list).
function withScreen(result, screen) {
  if (!screen || result === null || typeof result !== 'object') return result;
  const data = { ...(result[VIEW_DATA] ?? {}), [SCREEN_DATA_KEY]: screen };
  return Array.isArray(result) ? Object.assign(result.slice(), { [VIEW_DATA]: data }) : withViewData({ ...result, open_path: screen.address }, data);
}

// Some owners create their destination during the call. They declare this result contract in DATA,
// so the host can load the shared view without another model call. An omitted target selects no screen.
function screenFromResult(result) {
  const given = result?.[VIEW_DATA]?.[SCREEN_DATA_KEY] ?? result?.[SCREEN_DATA_KEY];
  if (given === undefined) return null;
  const screen = typeof given?.address === 'string' && /^\/(?!\/)/.test(given.address) ? screenFor(given.address) : null;
  const input = given?.input ?? {};
  if (!screen || given.id !== screen.id || typeof input !== 'object' || input === null || Array.isArray(input)
    || Object.entries(screen.input).some(([key, value]) => key in input && input[key] !== value)) {
    throw new Error('The interface could not be opened: its screen does not match its address.');
  }
  if (given.presentation !== undefined && given.presentation !== 'focused') {
    throw new Error('The interface could not be opened: its presentation is not supported.');
  }
  return { ...screen, input: { ...input, ...screen.input }, ...(typeof given.label === 'string' && given.label.trim() ? { label: given.label } : {}),
    ...(given.presentation === 'focused' ? { presentation: 'focused' } : {}) };
}

function resultScreen(result, address, focused) {
  if (!address) return null;
  const route = screenFor(address);
  if (!route) return null;
  // Run every DATA-derived destination through the same exact address/input contract used by owner-selected screens.
  return screenFromResult({ [SCREEN_DATA_KEY]: { id: route.id, address, input: route.input,
    ...(focused ? { presentation: 'focused' } : {}) } }) ?? null;
}

/** Every tool ./screen-view.json names, shown in the screen view: it names the view, and its answer says which screen. */
export function withScreenViews(tools) {
  return tools.map(tool => {
    const row = settings.tools[tool.name];
    if (!row) return tool;
    const entrypoints = placementEntrypoints(row);
    const saveScreenInputs = tool.name === 'save_tool' && tool.inputSchema?.type === 'object'
      ? { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties ?? {}),
        open_now: { type: 'boolean', description: 'false saves without selecting a new screen; the MCP host may still show its statically declared outer panel' },
        screen_input: { type: 'object', description: 'Optional initial input for a saved module screen' },
      } } : null;
    return {
      ...tool,
      ...(saveScreenInputs ? { inputSchema: saveScreenInputs } : {}),
      description: `${tool.description ?? ''}${saveScreenInputs ? ' A saved module screen opens in the same response by default; open_now:false leaves it unselected and screen_input sets its optional initial input. MCP clients declare their result view statically, so an empty outer panel may still appear when no screen is selected.' : ''} When the reply includes open_path, use that actual Trillion browser path on the connected service when giving the person a link. Do not invent a path from a record id.`,
      _meta: row.result_screen === true || alwaysNamesScreen(tool, row.address) || (row.otherwise && alwaysNamesScreen(tool, row.otherwise))
        ? { ...(tool._meta ?? {}), ...viewMeta, ...(entrypoints.length ? { 'openai/ui': { entrypoints } } : {}) } : tool._meta,
      run: async input => {
        const result = await tool.run(input);
        if (row.result_screen === true) {
          const selected = screenFromResult(result);
          const address = selected?.address ?? addressFrom(row.address, input ?? {}, result ?? {})
            ?? (row.otherwise ? addressFrom(row.otherwise, input ?? {}, result ?? {}) : null);
          const focused = focusedIfMatches(row.focused_if, input, result);
          const screen = selected ?? resultScreen(result, address, focused);
          return screen ? withScreen(result, screen) : result;
        }
        const address = addressFrom(row.address, input ?? {}, result ?? {}) ?? (row.otherwise ? addressFrom(row.otherwise, input ?? {}, result ?? {}) : null);
        const focused = focusedIfMatches(row.focused_if, input, result);
        const screen = resultScreen(result, address, focused);
        return screen ? withScreen(result, screen) : result;
      },
    };
  });
}

/** A tool without the screen view, for a sign-in that cannot read the view (one held to shared spaces). */
export function withoutScreenView(tool) {
  if (tool._meta?.ui?.resourceUri !== SCREEN_VIEW_URI) return tool;
  const { ui, 'openai/ui': entrypoints, 'openai/outputTemplate': template, 'openai/toolInvocation/invoking': invoking, 'openai/toolInvocation/invoked': invoked, ...meta } = tool._meta;
  return { ...tool, _meta: meta };
}

const screenList = () => [words.whole_described, ...rows.filter(row => row.listed !== false).map(row => `${row.label} (${addressOf(row, {}) ?? row.id})`)].join(', ');

// Find a person's tool by its name with one bounded job search, the Workshop's own find as the Workshop screen asks it
// (src/work-workshop.mjs /find), answered by the account's own records resource. A caller can also give its exact tool
// id, which screenFor resolves directly. Never load every screen page just to resolve one name.
async function toolScreenNamed(call, asked) {
  const page = await call('/tools/find', { job: asked, limit: firstAnswers.tools_found_per_search, search_mode: 'space-tools' }).catch(() => null);
  const lower = asked.toLowerCase();
  const card = (page?.candidates ?? []).find(row => typeof row?.tool_id === 'string' && row.tool_id.startsWith('tool:') && String(row.label ?? '').toLowerCase() === lower);
  return card ? { id: card.tool_id, label: String(card.label) } : null;
}

// make_screen: a screen the AI makes from shared parts as it writes it (src/screen-spec.mjs). The view draws its lines
// while they arrive (src/workspace/screen-view.tsx); the finished lines are kept as one of the person's tools (the
// Workshop checks and fixes the spec, src/workshop.mjs bindPartsScreen) and its saved screen is the one this answer opens.
async function showPartsScreen(call, { screen, parts, requests, label, job, asked: words }) {
  const asked = String(screen ?? '').trim();
  const existing = asked.startsWith('tool:') ? await call('/tools/describe', { tool_id: asked, include_files: false }) : null;
  // The person's own words for it, newest first and each once (the Workshop's save checks the same rule, src/screen-spec.json limits), so the instant matcher offers it when they ask alike.
  const askedNow = String(words ?? '').trim().slice(0, screenSpecLimits.asked_chars);
  const kept = Array.isArray(existing?.descriptor?.screen?.asked) ? existing.descriptor.screen.asked : [];
  const seen = new Set();
  const askedLines = [askedNow, ...kept].filter(line => {
    const key = typeof line === 'string' ? line.trim().toLowerCase() : '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, screenSpecLimits.asked_lines);
  const name = String(label ?? '').trim() || String(existing?.descriptor?.label ?? '').trim();
  if (!name) throw new Error(screenSpecAi.needs_label);
  const id = asked.startsWith('tool:') ? asked : `tool:screen-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'made'}`;
  const { spec, said } = specFromText(parts);
  const saved = await call('/tools/save', { check: false, descriptor: {
    id, label: name, job: String(job ?? '').trim() || existing?.descriptor?.job || name, input_schema: { type: 'object' },
    screen: { kind: PARTS_SCREEN, spec, requests: requests && typeof requests === 'object' ? requests : existing?.descriptor?.screen?.requests ?? {}, ...(askedLines.length ? { asked: askedLines } : {}) },
  } });
  const found = screenFor(saved.tool_id);
  const fixes = [...said, ...(saved.screen_fixes ?? [])];
  return withScreen({ shown: name, screen: found.id, address: found.address, tool_id: saved.tool_id, ...(fixes.length ? { fixes } : {}) }, { ...found, label: name, presentation: 'focused' });
}

/** open_trillion, show_screen, make_screen, and screen_read for the view alone. `call` is the MCP road to the person's Trillion. */
export const screenViewTools = call => [
  {
    name: 'show_screen',
    description: `Opens the person's full Trillion workspace right here in the chat, with their sidebar and arrangement, selecting the requested screen. The same workspace surrounds every screen returned by a tool; a special whole-workspace request is never required. They can navigate, arrange, open, sort, filter and act there as in Trillion. screen is Trillion (the whole workspace without selecting a particular screen), a screen's address (/decisions, /files, /decisions/<case_id>, /lists/<list_id>), its name (Decisions, Files, Progress, Spaces, Automations, Marketplace, Runs) or a tool id whose own screen to show (tool:drives); input (optional) is what that screen opens on. Use it whenever the person wants to see something Trillion keeps, instead of describing it or pasting its data: the screens are ${screenList()}. To make a new screen as you write it, use make_screen.`,
    inputSchema: { type: 'object', required: ['screen'], properties: { screen: { type: 'string', description: 'An address, a screen name or a tool id' }, input: { type: 'object', description: 'What the screen opens on, when its address does not say' } } },
    _meta: viewMeta,
    run: async ({ screen, input }) => {
      let found = screenFor(screen, input);
      // A name that is none of the workspace's own screens may be one of the person's tools' screens (Posts is a tool's).
      const asked = String(screen ?? '').trim().toLowerCase();
      const tool = !found && asked ? await toolScreenNamed(call, asked) : null;
      if (tool) found = { ...screenFor(tool.id, input), label: tool.label };
      if (!found) throw new Error(words.unknown_screen.replace('{asked}', String(screen ?? '')).replace('{screens}', screenList()));
      return withScreen({ shown: found.label, screen: found.id, address: found.address }, found);
    },
  },
  {
    name: 'screen_read',
    description: 'For the Trillion screen view only: one read or change the screen drawn in this chat makes in the person\'s Trillion, as the signed-in page would. An AI never calls it; show_screen shows a screen.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, method: { type: 'string' }, patchable: { type: 'boolean' }, have: { type: 'string' }, text: { type: 'string' }, base64: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } } } },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    // The view reads the answer from structuredContent; the text block says one line instead of the whole answer again.
    run: async asked => { const answer = await call('/screen-view/read', asked); return withSaid(answer, words.read_said.replace('{status}', String(answer?.status ?? ''))); },
  },
  {
    name: 'open_trillion',
    description: 'Opens the person\'s Trillion home right here in the chat: their sidebar and arrangement, with what waits on them. It takes no input and changes nothing.',
    inputSchema: { type: 'object', properties: {} },
    // Its screen is the row's `address` in ./screen-view.json (withScreenViews); the answer only says what was opened.
    run: async () => ({ shown: settings.whole.label }),
  },
  {
    name: 'make_screen',
    description: `Makes a new screen for the person right here in the chat, from shared parts, and keeps it as one of their tools so it reopens with no AI. ${partsGuide()}`,
    inputSchema: { type: 'object', required: ['parts'], properties: {
      label: { type: 'string', description: 'The screen\'s name; the same name changes the same screen' },
      job: { type: 'string', description: 'What the screen is for, in plain words' },
      asked: { type: 'string', description: 'The person\'s own words asking for this screen, exactly as they said them; Trillion offers it at once when they ask alike' },
      requests: { type: 'object', description: 'The named requests its actions and reads may send; send it before parts' },
      screen: { type: 'string', description: 'The tool id of one of the person\'s parts screens to change instead of naming it by label' },
      parts: { type: 'string', description: 'The screen as lines of JSON changes, root first; send it last' },
    } },
    _meta: viewMeta,
    run: input => showPartsScreen(call, input),
  },
];

export const screenViewAnnotations = {
  open_trillion: { title: 'Open Trillion home', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  show_screen: { title: 'Show a Trillion screen', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  make_screen: { title: 'Make a screen from shared parts', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  screen_read: { title: 'Read for a Trillion screen', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

/** Whether a tool is for a view alone, kept from the AI by the app. */
export const forViewAlone = tool => Array.isArray(tool?._meta?.ui?.visibility) && !tool._meta.ui.visibility.includes('model');

/** Whether a tools/call message is only calls a view makes for itself (screen_read): the screen reading, not the AI
 * acting, so it leaves no AI activity and takes none of the notices meant for the AI. `toolOf(name)` is the tool. */
export const forViewOnly = (message, toolOf) => {
  if (message?.method !== 'tools/call') return false;
  const calls = Array.isArray(message.params?.calls) ? message.params.calls : [message.params];
  return calls.length > 0 && calls.every(asked => forViewAlone(toolOf(asked?.name)));
};

// An import map with each address made absolute against `origin`.
function absoluteImports(map, origin) {
  if (!map?.imports || typeof map.imports !== 'object') return null;
  return { ...map, imports: Object.fromEntries(Object.entries(map.imports).map(([name, address]) => [name, new URL(String(address), `${origin}/`).href])) };
}

/** Whether a screen_read changes nothing: a GET or HEAD (or none named). Such a read takes no execution receipt
 * (src/worker.mjs), so the many reads a screen makes as it opens do not queue behind each other on the person's store. */
export const isScreenRead = (input = {}) => ['GET', 'HEAD'].includes(String(input?.method ?? 'GET').toUpperCase());

/** Whether a tool call changes nothing, so it takes no execution capture on any road: a tool declared read-only
 * (readOnlyHint, `reads`), or a screen_read that is a read. */
export const changesNothing = asked => Boolean(asked?.reads) || asked?.tool === 'screen_read' && isScreenRead(asked.input);

/** The stylesheet the view document carries itself: the shell and failed-state styles, then the look's faces and
 * variables. `worn` is what the person's store answers for their look (looks.mjs `page`: { worn, plan, looks }), or
 * nothing, in which case the look every page starts with. A look plan is not followed here (the document cannot know the
 * device's zone); the person's worn look is, and the view's own script follows the plan once it runs. */
export function screenLookCss(worn) {
  return lookDocumentCss(wornLook(worn).palette) + EMBEDDED_SHELL_CSS;
}

/** The screen view as an MCP resource. `origin` is where its script, look and every screen read point; `importMap`
 * answers the service page's own import map (src/workspace-files.mjs), so a screen that is a tool's own module
 * (`@trillion-screen/...`, src/workspace/screen-module-address.mjs) opens in the view by the same name as in Trillion.
 * `wornLook` answers the person's worn look when the resource is read with their sign-in (null otherwise). */
export const screenResources = (origin, importMap = async () => null, wornLook = async () => null) => [{
  uri: SCREEN_VIEW_URI, name: 'trillion-screen', title: words.title, mimeType: VIEW_MIME_TYPE,
  text: async () => aiAppViewDocument({
    hostId: SCREEN_VIEW_HOST_ID, wordsId: SCREEN_VIEW_WORDS_ID, module: true, baseUrl: `${origin}/`,
    inlineCss: screenLookCss(await Promise.resolve().then(wornLook).catch(() => null)),
    // Every address absolute: an app's frame may refuse the <base> (ChatGPT's base-uri 'self'), so a bare name must not
    // lean on it to reach this service.
    importMap: absoluteImports(await Promise.resolve().then(importMap).catch(() => null), origin),
    words: { ...words, origin },
    scriptUrl: `${origin}${settings.view.script}`, stylesheetUrl: `${origin}${settings.view.stylesheet}`,
  }),
  _meta: {
    ui: { csp: { resourceDomains: [origin], connectDomains: [origin], frameDomains: [origin] }, prefersBorder: true },
    'openai/widgetCSP': { resource_domains: [origin], connect_domains: [origin], frame_domains: [origin] },
    'openai/widgetDescription': words.description,
  },
}];

/** The request one screen_read asks for, for the workspace's own routes at `origin`, or a refusal in words. */
export function screenReadRequest(origin, asked = {}) {
  const url = new URL(String(asked.path ?? ''), origin);
  if (url.origin !== origin || !settings.reads.paths.some(path => pathWithin(url.pathname, path))) return { refused: words.outside_read };
  if (settings.reads.refused_paths.some(path => pathWithin(url.pathname, path))) return { refused: words.refused_read };
  const method = String(asked.method ?? 'GET').toUpperCase();
  const headers = new Headers({ origin });
  for (const name of settings.reads.headers) if (typeof asked.headers?.[name] === 'string') headers.set(name, asked.headers[name]);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  const body = method === 'GET' || method === 'HEAD' ? undefined
    : typeof asked.base64 === 'string' ? Uint8Array.from(atob(asked.base64), character => character.charCodeAt(0))
      : typeof asked.text === 'string' ? asked.text : undefined;
  return { url, request: new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }) };
}

/** A route's answer as screen_read hands it to the view: its status, type, and its body as text or base64. */
export async function screenReadAnswer(response) {
  const type = response.headers.get('content-type') ?? '';
  const bytes = new Uint8Array(await response.arrayBuffer());
  const textual = !type || settings.reads.text_types.some(kind => type.startsWith(kind));
  if (textual) return { status: response.status, content_type: type, text: new TextDecoder().decode(bytes) };
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return { status: response.status, content_type: type, base64: btoa(binary) };
}

export { settings as screenViewSettings };
