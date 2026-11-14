// src/work-workshop.mjs
//
// PURPOSE
//   The Workshop screens of the signed-in workspace (src/workspace/workshop-screen.tsx) read the person's tools and
//   runs through this page's own session: the same person-side Workshop routes an AI uses (src/workshop.mjs through the
//   person's store), turned into what a person reads: a card per tool (who made it, what it does, where it runs, what
//   people reported after using it), a row per run, one tool opened with what it needs and its runs, and one run
//   opened with its result as labelled lines and the files it made.
//
//   GET /work/api/workshop              every tool this person can use, and every run they started
//   GET /work/api/workshop/tool/<id>    one tool: its card, what it does, what it needs, and its runs
//   GET /work/api/workshop/run/<id>     one run: its state, its result as labelled lines, its files, what was said
//   POST /work/api/workshop/run/<id>/result  keep the signed-in person's outcome report ({ result, summary, request_key })
//   GET /work/api/workshop/describe/<id>  one tool's whole descriptor, which its own screen is drawn from
//   GET /work/api/workshop/for-thing?type=&name=&carries=  what a thing's ⋯ menu and a file's card offer: every tool
//                                           this person can use whose screen marks an input as taking a file of that
//                                           kind, every screen that opens on one, and every tool whose required inputs
//                                           are all formats the thing carries (thingActions), so a tool added to the
//                                           Workshop shows on every menu it applies to
//   GET /work/api/workshop/find?job=    tools for a job in the person's words across the whole Marketplace (the same find
//                                       find_tool_for_job makes), one bounded page, for adding one to a space
//   POST /work/api/workshop/run/<task_id>/input  supply the current non-secret missing fields ({ input_version, replay_key, input })
//   POST /work/api/workshop/send-quietly/<id>  send one quiet web row ({ input }) and answer what the service said,
//                                           keeping nothing (a light following the sound; src/workshop.mjs sendQuietly)
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read only, except these: POST /work/api/workshop/send-quietly/<id> sends a row marked runs_quietly and keeps
//      nothing (a page's tool run is the engine's POST /work/api/door/tools:run, src/workspace/workshop-tool-api.ts). POST /run/<id>/result records a person's report through its own session and the narrow person-side RPC,
//      which derives the trusted source itself. Nothing else here runs, saves, publishes or reports. Reading a run is the Workshop's own read, which also
//      finishes a run whose result arrived since, exactly as an AI's read_task does.
//   2. Every word a fact is said in comes from src/workshop-looks.json (who made it, states, reports, where it runs and its icon); a
//      new state, maker or place is a row there. Nothing here names a tool.
//   3. A refusal from the person's store (a plan that does not include the Workshop, a missing tool) is passed on as
//      the store said it, with its status, so the screen draws the same plan and failure states every screen draws.
//   4. What a run returned is shown as its own values under labels made from their field names; nothing is invented,
//      and a value too deep to read as a line is shown as its text.
import looks from './workshop-looks.json' with { type: 'json' };
import { personReportVerified } from './check-uses.mjs';
import firstAnswers from './workspace/first-answers.json' with { type: 'json' };
import workspaceScreens, { SCREEN_TOOL_ROWS } from './workspace/screens.mjs';
import { passing } from './cut-off.mjs';
import { takesFile, takesOf } from '../parts/ui/show/file-field/takes-file.mjs';

const json = (value, status = 200) => Response.json(value, { status });
export const isWorkWorkshopPath = path => path === '/work/api/workshop' || path.startsWith('/work/api/workshop/');

// The store's refusal, kept whole so its words, status and plan facts reach the screen.
class Refusal extends Error {
  constructor(body, status) { super(body?.error ?? 'This could not be read.'); this.body = body; this.status = status; }
}
async function ask(person, method, path, body, named = {}) {
  const answer = await person.fetch(new Request(`https://person${path}`, { method, headers: { 'content-type': 'application/json', ...named }, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) }));
  const value = await answer.json().catch(() => ({ error: 'The answer could not be read.' }));
  if (!answer.ok) throw new Refusal(value, answer.status);
  return value;
}

const capital = text => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
const counted = ([one, many], n) => (n === 1 ? one : many.replace('{n}', String(n)));
const madeBy = words => looks.made_by[words] ?? { label: capital(words), order: 99 };

/** What people reported after runs of a tool, across every account: words, a tone, and the filter value it counts as. */
export function workedOf(runs) {
  const met = runs?.reported_met ?? 0;
  const failed = runs?.reported_failed ?? 0;
  const { worked } = looks;
  if (!met && !failed) return { label: worked.none.label, tone: worked.none.tone, filter: worked.none.filter };
  const label = met && failed ? `${counted(worked.met_words, met)}, ${counted(worked.failed_words, failed)}`
    : met ? counted(worked.met_words, met) : counted(worked.failed_alone_words, failed);
  const side = met >= failed ? worked.mostly_met : worked.mostly_failed;
  return { label, tone: side.tone, filter: side.filter };
}

// Prose titles can contain punctuation; a single token can still be an action id.
const looksLikeId = text => !/\s/.test(text) && (/[_:/]/.test(text) || /^[a-z0-9]+(-[a-z0-9]+)+$/.test(text));
const wordsOf = token => capital(token.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase());

/** What a tool is called for a person: its own title, name or label when that reads as words; otherwise the action its
 *  id names (`agentmail-list_messages` is "List messages", from the service "Agentmail"). */
export function titleOf(tool) {
  const named = [tool.title, tool.name, tool.label].find(text => typeof text === 'string' && text.trim() && !looksLikeId(text.trim()));
  // A name is kept as written except a leading lowercase word, so iMessage stays iMessage and "count letters" reads as a title.
  if (named) return { title: /^[a-z](?![A-Z])/.test(named.trim()) ? capital(named.trim()) : named.trim(), service: null };
  const bare = String(tool.tool_id ?? tool.label ?? '').replace(/^[a-z-]+:/, '');
  // The service is the hyphen-joined words before the action; the action is the first word that joins with `_`.
  const split = bare.match(/^(.*?)-([^-]*_.*)$/);
  return split ? { title: wordsOf(split[2]), service: wordsOf(split[1]) } : { title: wordsOf(bare), service: null };
}

/** Where something runs, in the person's words, from the place's id; a place not in the looks keeps its own label. */
export function placeWords(id, label) {
  return looks.places[id]?.words ?? (label ? capital(label) : null);
}

/** One tool as the card a person reads (parts/ui ListingCard) plus the facts the screen filters by. */
export function toolListing(card) {
  const maker = madeBy(card.made_by);
  const worked = workedOf(card.earlier_runs);
  const where = [...new Set((card.places ?? []).map((id, at) => placeWords(id, card.runs_on?.[at])).filter(Boolean))];
  const { title, service } = titleOf(card);
  return {
    id: card.tool_id,
    title,
    byline: service ? `${maker.label} · ${service}` : maker.label,
    text: card.description ?? card.job ?? '',
    icon: (looks.places[card.places?.[0]] ?? looks.places.default).icon,
    ...(card.published_by_you ? { badge: looks.published_by_you } : maker.badge ? { badge: maker.badge } : {}),
    // What it costs is the card's one key value, alone on the right with its unit small (`$0.01` `/call`).
    ...(card.price?.amount ? { value: String(card.price.amount), ...(card.price.per ? { unit: `/${card.price.per}`, valueLabel: `${card.price.amount} a ${card.price.per}` } : {}) } : {}),
    facts: where.length ? [{ ...looks.facts.runs_on, value: where.join(' · ') }] : [],
    signal: { label: worked.label, tone: worked.tone },
    made_by: maker.label,
    made_by_order: maker.order,
    ...(maker.shareable ? { shareable: true } : {}),
    ...(maker.own ? { own: true } : {}),
    // A tool with its own screen for a person opens it from its page (the same screen its sidebar row opens).
    ...(typeof card.screen?.kind === 'string' ? { has_screen: true } : {}),
    service: service ?? '',
    runs_on: where,
    worked: worked.filter,
    runs: card.earlier_runs?.runs ?? 0,
  };
}

export function taskReportWords(result, by, personVerified = false) {
  if (!result) return looks.reported.none;
  const rows = by === 'person' ? personVerified ? looks.reported : looks.reported_for_person : looks.reported_by_other;
  const row = rows[result] ?? looks.reported.none;
  return { ...row, label: row.label.replace('{by}', typeof by === 'string' && by.trim() ? by.trim() : looks.reporter_unknown) };
}

/** One run as a row a person reads. */
export function runRow(run) {
  const state = looks.run_states[run.state] ?? { label: capital(String(run.state).replace(/_/g, ' ')), tone: 'quiet' };
  return {
    id: run.task_id,
    tool_id: run.tool_id,
    title: titleOf({ tool_id: run.tool_id, label: run.label }).title,
    job: run.job,
    state: state.label,
    tone: state.tone,
    reported: taskReportWords(run.reported, run.reported_by, run.report_person_verified).label,
    started_at: run.started_at ?? run.due_at ?? null,
    ...(run.finished_at ? { finished_at: run.finished_at, seconds: run.seconds } : {}),
    ...(run.place || run.runs_on ? { runs_on: placeWords(run.place, run.runs_on) } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

const labelOf = key => capital(String(key).replace(/[_-]+/g, ' ').trim());

/** A run's result kept as its actual value for the shared schema-aware renderer. Files are listed apart so each can
 *  be opened, and are not repeated among the readable fields or exposed as identifiers before the raw-data reveal. */
export function resultOf(output) {
  if (output === undefined) return { output: undefined, files: [] };
  const files = output && typeof output === 'object' && !Array.isArray(output) && output.files && typeof output.files === 'object'
    ? Object.entries(output.files).flatMap(([name, kept]) => (Array.isArray(kept) ? kept : [kept]).filter(item => item?.identity).map(item => ({ name: item.name ?? name, identity: item.identity, media_type: item.media_type ?? null, bytes: item.bytes ?? null })))
    : [];
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { output, files };
  const visible = Object.fromEntries(Object.entries(output).filter(([key]) => key !== 'files'));
  return { output: Object.keys(visible).length ? visible : undefined, files };
}

const inputsOf = schema => Object.entries(schema?.properties ?? {}).map(([name, field]) => {
  const required = (schema.required ?? []).includes(name);
  return { name, label: labelOf(field?.title ?? name), about: field?.description ?? null, required, status: looks.inputs[required ? 'required' : 'optional'] };
});

// The colour each value of a table's tag column takes, from the tone its row carries.
const tagsOf = (rows, field) => Object.fromEntries(rows.map(row => [row[field], { tone: looks.tag_colours[row.tone] ?? looks.tag_colours.quiet }]));

/** Every tool that declares a screen of its own (`screen.kind`), as the placeable screen the workspace lists, arranges
 *  and opens: one row per tool whose id IS the tool's id, with where it came from (`source`) so lists hold it by a rule
 *  over rows. A tool with no `screen.kind` has no tab: its job is done on the screen that already hosts it, or by the
 *  person's AI. Nothing here or in the tool names a list, a place in the sidebar or an address; they all derive from
 *  this row. */
/** What a thing's ⋯ menu and a file's card offer, from the tools this person can use (the cards /tools/list answers).
 *  A thing carries values by the input `format` they fill (`carries`: `namespace-file` for a file, `trillion:<kind>`
 *  for any thing's own id, such as `trillion:decision` or `trillion:screen`; the page says which, menu-rows.json).
 *  For a file (a media type or a name), a tool whose screen marks an input as taking a file of its kind
 *  (`screen.inputs.<field>.file.takes`, a kind of file-takes.json) and a screen row that opens on one
 *  (`screen.takes_file`, opened with the file: `open`). For any thing, a tool whose every required input has a
 *  `format` the thing carries, each format filling one input. A tool is offered only when the thing is all it needs
 *  (`run`, with `fills`: input name to the format whose value it takes), so no press can fail for want of another
 *  input. Nothing here names a tool or a kind of thing. */
export function thingActions(tools, { type = '', name = '', carries = [] } = {}) {
  const isFile = Boolean(type || name);
  const held = new Set(carries);
  return tools.flatMap(tool => {
    const screen = tool.screen ?? {};
    // `group` is the folder the tool sits in (its screen's `group`), so a menu nests the actions by the same folders the
    // sidebar holds tools in.
    const titled = { id: tool.tool_id, label: screen.label ?? titleOf(tool).title, icon: screen.icon ?? 'Wrench', about: screen.about ?? tool.description ?? tool.job ?? '', ...(typeof screen.group === 'string' && screen.group ? { group: screen.group } : {}) };
    // A screen of the app's own names its surface; a tool's own screen is the screen row whose id is the tool's id
    // (toolSurfaces), opened with the tool's id in its input.
    if (screen.takes_file) {
      if (!isFile) return [];
      const opens = screen.takes_file;
      const surface = screen.surface?.id ?? tool.tool_id;
      const input = { ...(screen.surface?.id ? {} : { tool_id: tool.tool_id }), ...(opens.input ?? {}) };
      return takesFile(takesOf(opens.takes).accept, type, name)
        ? [{ ...titled, label: opens.label ?? titled.label, icon: opens.icon ?? titled.icon, kind: 'open', surface, input }]
        : [];
    }
    // A screen that opens on a thing of a kind (a screen, a tour, a decision): offered on every thing carrying one of
    // its formats, opened with the thing's own values in its input (`{ from: "thing", field }`: id, kind or address).
    if (screen.takes_thing) {
      const takes = screen.takes_thing;
      if (isFile || !(takes.formats ?? []).some(format => held.has(format))) return [];
      return [{ ...titled, label: takes.label ?? titled.label, icon: takes.icon ?? titled.icon, kind: 'open', surface: screen.surface?.id ?? tool.tool_id, input: takes.input ?? {} }];
    }
    if (!tool.next_call || tool.runs_here === false) return [];
    const required = tool.input_schema?.required ?? [];
    const field = isFile ? Object.entries(screen.inputs ?? {}).find(([, shown]) => shown?.file && takesFile(takesOf(shown.file.takes).accept, type, name))?.[0] : undefined;
    if (field) return required.some(other => other !== field) ? [] : [{ ...titled, kind: 'run', fills: { [field]: NAMESPACE_FILE } }];
    // Every required input filled by a format the thing carries, no format filling two. A file input is offered only
    // through its screen's `file.takes` above, which says which kinds of file it takes.
    const formats = required.map(input => tool.input_schema?.properties?.[input]?.format);
    if (!required.length || formats.some(format => format === NAMESPACE_FILE || !held.has(format)) || new Set(formats).size !== formats.length) return [];
    return [{ ...titled, kind: 'run', fills: Object.fromEntries(required.map((input, index) => [input, formats[index]])) }];
  });
}
const NAMESPACE_FILE = 'namespace-file';

export function toolSurfaces(tools) {
  const defaults = looks.tool_surface_defaults;
  const named = value => typeof value === 'string' && value.length > 0;
  if (!defaults || !named(defaults.package_entry?.package_name) || !named(defaults.package_entry?.entry_name)
    || !named(defaults.material_target) || !Array.isArray(defaults.placement_labels)
    || !defaults.placement_labels.length || !defaults.placement_labels.every(named)) {
    throw new TypeError('Tool screen mount DATA is missing or invalid.');
  }
  return (tools ?? []).filter(card => card?.tool_id && typeof card.screen?.kind === 'string' && card.screen.kind).map(card => replacing(card, {
    id: card.tool_id,
    surface_id: card.tool_id,
    kind: 'placeable-surface',
    label: card.screen?.label ?? titleOf(card).title,
    icon: card.screen?.icon ?? looks.screen_icon,
    package_entry: { ...defaults.package_entry },
    surface_input: { tool_id: card.tool_id },
    // Its own address, derived from its id, so a tab opened there carries the tool's own name.
    route_paths: [`/use/${encodeURIComponent(String(card.tool_id).replace(/^tool:/, ''))}`],
    placement_labels: [...defaults.placement_labels],
    placement_order_key: `tool:${card.tool_id}`,
    wrap_material: false,
    // The shared screen list reads a row only when it names what it puts on screen.
    material_target: defaults.material_target,
    description: card.screen?.about ?? card.description ?? card.job ?? '',
    // The words that asked for this screen (`screen.asked`), so the same words typed again pick it at once
    // (src/instant-screens.mjs).
    ...(Array.isArray(card.screen?.asked) && card.screen.asked.length ? { asked: card.screen.asked.filter(words => typeof words === 'string') } : {}),
    // When the tool was first offered: a sidebar list may hold what is new by it (surfaces.json `list_rule_facts`).
    ...(card.listed_on ? { listed_on: card.listed_on } : {}),
    // A tool kept new until a date (its screen's `new_until`) stays in New until then (surfaces.json sidebar_row_facts).
    ...(typeof card.screen?.new_until === 'string' ? { sidebar_new_until: card.screen.new_until } : {}),
    // Which folder the tool sits in is its own screen's `group`: a sidebar list holds rows by it (surfaces.json `holds`).
    source: { kind: 'tool', tool_id: card.tool_id, ...(typeof card.screen?.group === 'string' && card.screen.group ? { group: card.screen.group } : {}) },
    actions: [],
  }));
}

// A tool whose screen names `replaces` (the id of one of the workspace's own screens, src/workspace/screens.mjs) takes
// that screen's id and place: its list, order, addresses and what opens it, with this tool's words and screen in it.
const SHIPPED = new Map(workspaceScreens.surfaces.map(row => [row.id, row]));
function replacing(card, row) {
  const replaced = SHIPPED.get(card.screen?.replaces);
  if (!replaced) return row;
  // A screen that is the replaced screen itself (an app-entry naming its entry) keeps opening it straight away, with no
  // Workshop read first, so it opens on every plan.
  const same = card.screen.kind === 'app-entry' && card.screen.entry === replaced.package_entry?.entry_name;
  const { label, icon, description, source, listed_on, sidebar_new_until, asked } = row;
  const { package_entry, surface_input, material_target } = same ? replaced : row;
  return { ...replaced, label, icon, package_entry, ...(surface_input ? { surface_input } : {}), material_target, description, source, ...(asked ? { asked } : {}), ...(listed_on ? { listed_on } : {}), ...(sidebar_new_until ? { sidebar_new_until } : {}), route_paths: [...new Set([...(replaced.route_paths ?? []), ...row.route_paths])] };
}

export async function handleWorkWorkshop(request, { person, url, userId }) {
  const rest = url.pathname.slice('/work/api/workshop'.length);
  if (rest === '/screen-context' && request.method === 'POST') {
    try {
      const input = await request.json();
      return json(await ask(person, 'POST', '/tools/screenContext', input));
    } catch (error) {
      if (error instanceof Refusal) return json(error.body, error.status);
      return json({ error: error.message }, error.status ?? 400);
    }
  }
  const providing = request.method === 'POST' ? rest.match(/^\/run\/([^/]+)\/input$/) : null;
  const quiet = request.method === 'POST' ? rest.match(/^\/send-quietly\/([^/]+)$/) : null;
  const reporting = request.method === 'POST' ? rest.match(/^\/run\/([^/]+)\/result$/) : null;
  // A person deletes a screen their AI saved for them (one of this account's saved tools), as delete_tool does: the
  // Workshop refuses a shared tool, another account's and a published one (src/workshop.mjs deleteTool).
  const deleting = request.method === 'POST' ? rest.match(/^\/delete-tool\/([^/]+)$/) : null;
  // A person renames one of their own tools from its page, as save_tool does: a rename keeps everything else as saved.
  const renaming = request.method === 'POST' ? rest.match(/^\/tool\/([^/]+)\/rename$/) : null;
  if (request.method !== 'GET' && !providing && !quiet && !reporting && !deleting && !renaming) return json({ error: 'Not found' }, 404);
  try {
    if (deleting) {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
      return json(await ask(person, 'POST', '/tools/delete', { tool_id: decodeURIComponent(deleting[1]) }));
    }
    if (renaming) {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
      const tool_id = decodeURIComponent(renaming[1]);
      const sent = await request.json().catch(() => ({}));
      const label = typeof sent.label === 'string' ? sent.label.trim() : '';
      if (!label || label.length > 120) return json({ error: looks.own_tool.name_needed }, 400);
      const { descriptor, made_by } = await ask(person, 'POST', '/tools/describe', { tool_id, include_files: false });
      if (!looks.made_by[made_by]?.own) return json({ error: looks.own_tool.not_yours }, 403);
      const { status: _status, saved_at: _saved, kind: _kind, listed_on: _listed, ...kept } = descriptor;
      const screen = kept.screen && typeof kept.screen === 'object' && kept.screen.label !== undefined ? { ...kept.screen, label } : kept.screen;
      return json(await ask(person, 'POST', '/tools/save', { descriptor: { ...kept, label, ...(screen ? { screen } : {}) }, check: false, open_now: false }));
    }
    if (reporting) {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
      // Bound the request before parsing it; the only promoted fields are the person's answer and retry key.
      const reader = request.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32768) { await reader.cancel(); return json({ error: 'This report is too long.' }, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let sent;
      try { sent = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return json({ error: 'Give the outcome report as JSON.' }, 400); }
      if (!sent || typeof sent !== 'object' || Array.isArray(sent)) return json({ error: 'Give one outcome report.' }, 400);
      return json(await person.reportTaskAsPerson({ task_id: decodeURIComponent(reporting[1]), result: sent.result, summary: sent.summary, request_key: sent.request_key }));
    }
    if (quiet) {
      const sent = await request.json().catch(() => ({}));
      return json({ answer: await ask(person, 'POST', '/tools/send-quietly', { tool_id: decodeURIComponent(quiet[1]), input: sent.input ?? {} }) });
    }
    if (providing) {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
      const sent = await request.json().catch(() => ({}));
      const task = await ask(person, 'POST', `/tasks/${encodeURIComponent(decodeURIComponent(providing[1]))}/input`, sent, { 'x-trillion-user': userId });
      return json({ task_id: task.task_id, state: task.state, output: task.output, error: task.error ?? null, pending_input: task.pending_input ?? null, repeated: task.repeated ?? false });
    }
    // Any tool for a job in the person's words, across the whole Marketplace one bounded page at a time, the same find
    // an AI's find_tool_for_job makes (a space's Tools place adds what it finds, community-screen.tsx).
    if (rest === '/accounts') {
      const vendor = url.searchParams.get('vendor');
      if (!vendor || vendor.length > 200) return json({ error: 'Choose a connected service.' }, 400);
      const rows = await person.connectionsOfVendors([vendor]);
      return json({ accounts: rows.map(row => ({ connection_id: row.connection_id, connected_at: row.connected_at, account_label: row.account_label ?? row.service, status: row.status, can_send: row.can_send })) });
    }
    if (rest === '/find') {
      const job = (url.searchParams.get('job') ?? '').trim();
      if (!job) return json({ job, candidates: [] });
      const found = await ask(person, 'POST', '/tools/find', { job, limit: firstAnswers.tools_found_per_search, search_mode: 'space-tools' });
      return json({ job, candidates: (found.candidates ?? []).map(card => ({ tool_id: card.tool_id, label: card.label, job: card.job ?? null, description: card.description ?? null, made_by: card.made_by ?? null })) });
    }
    const describing = rest.match(/^\/describe\/([^/]+)$/);
    if (describing) return json(await ask(person, 'POST', '/tools/describe', { tool_id: decodeURIComponent(describing[1]), include_files: false }));
    if (rest === '/for-thing') {
      const for_thing = { type: url.searchParams.get('type') ?? '', name: url.searchParams.get('name') ?? '', carries: (url.searchParams.get('carries') ?? '').split(',').filter(Boolean) };
      const { tools } = await ask(person, 'POST', '/tools/list', { for_thing });
      // The workspace's own screens are not in the Workshop list (they are the page's), so a screen that opens on a file
      // or a thing is read from its own row; the page offers it only when that screen is one it offers this person.
      const screens = SCREEN_TOOL_ROWS.filter(row => row.screen.takes_file || row.screen.takes_thing).map(row => ({ tool_id: row.id, label: row.label, description: row.description, screen: row.screen }));
      return json({ actions: thingActions([...tools, ...screens], for_thing) });
    }
    if (rest === '') {
      const { tools, runs } = await ask(person, 'POST', '/tools/list', url.searchParams.get('runs_only') === 'true' ? { runs_only: true } : {});
      const rows = runs.map(runRow);
      return json({
        tools: tools.map(toolListing).sort((a, b) => a.made_by_order - b.made_by_order || a.title.localeCompare(b.title)),
        runs: rows,
        tags: { state: tagsOf(rows, 'state') },
      });
    }
    const opened = rest.match(/^\/(tool|run)\/([^/]+)$/);
    if (!opened) return json({ error: 'Not found' }, 404);
    const id = decodeURIComponent(opened[2]);
    if (opened[1] === 'tool') {
      const [{ tools, runs }, described] = await Promise.all([ask(person, 'POST', '/tools/list', { tool_id: id }), ask(person, 'POST', '/tools/describe', { tool_id: id })]);
      const card = tools[0];
      return json({
        tool: toolListing(card),
        about: described.descriptor?.description ?? null,
        inputs: inputsOf(described.descriptor?.input_schema),
        tiles: looks.tool_tiles.map(({ from, ...tile }) => ({ ...tile, value: String(card.earlier_runs?.[from] ?? 0) })),
        runs: runs.map(runRow),
      });
    }
    const task = await ask(person, 'GET', `/tasks/${encodeURIComponent(id)}`);
    const listed = await ask(person, 'POST', '/tools/list', { tool_id: task.tool_id }).catch(() => null);
    const tool = listed?.tools?.[0] ?? null;
    let outputSchema = tool?.output_schema;
    if (!outputSchema) {
      const described = await ask(person, 'POST', '/tools/describe', { tool_id: task.tool_id }).catch(() => null);
      outputSchema = described?.descriptor?.output_schema;
    }
    const where = placeWords(listed?.runs?.find(run => run.task_id === task.task_id)?.place, task.runs_on);
    const state = looks.run_states[task.state] ?? { label: capital(String(task.state).replace(/_/g, ' ')), tone: 'quiet' };
    const { output, files } = resultOf(task.output);
    return json({
      id: task.task_id,
      tool_id: task.tool_id,
      title: titleOf(tool ?? { tool_id: task.tool_id }).title,
      job: task.job,
      state: state.label,
      can_report: ['completed', 'failed', 'for_you_to_run'].includes(task.state),
      tone: state.tone,
      status_tone: looks.status_tones[state.tone] ?? 'neutral',
      started_at: task.started_at ?? task.due_at ?? null,
      ...(task.finished_at ? { finished_at: task.finished_at, seconds: task.seconds } : {}),
      ...(where ? { runs_on: where } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(task.contract?.problems?.length ? { problems: task.contract.problems } : {}),
      ...(task.pending_input ? { pending_input: task.pending_input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(outputSchema ? { output_schema: outputSchema } : {}),
      files,
      reports: (task.reports ?? []).map(report => ({ said: taskReportWords(report.result, report.answered_by, personReportVerified(report)).label,
        tone: taskReportWords(report.result, report.answered_by, personReportVerified(report)).tone, summary: report.summary, at: report.reported_at,
        answered_by: report.answered_by ?? null, source_ref: report.source_ref ?? null })),
    });
  } catch (error) {
    if (error instanceof Refusal) return json(error.body, error.status);
    // A call the platform cut off in passing (a deploy reset the person's store) goes to the Worker's one catch, which
    // answers 503 "send this again" in plain words; the platform's own message never reaches the screen.
    if (passing(error)) throw error;
    return json({ error: error.message }, 500);
  }
}
