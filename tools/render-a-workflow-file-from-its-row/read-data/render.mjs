// tools/render-a-workflow-file-from-its-row/read-data/render.mjs
//
// A workflow's file under tools/workflows/recipes is rendered from its workflow_recipes row, never written by hand. This
// module is the one place that makes the file from a row, and the one place that checks an existing file against its row.
// A row is read through tool:run-sql-in-my-database; this module takes its values as plain objects.
//
// fileFromRow(row) -> { about, records: [{ payload }] }: the payload keeps the row's own steps (as `definition`), its
// job, produces, input schema, source and fires_when, and each wake with its input cut to its start step. The store names
// and account are not in the file: they come with each person's switch.
// checkFile(file, row) -> problems: the file must be stamped with the row's kept_at, its name must be the id without
// "workflow:" and hold no colon, and the row must be complete enough for the recipe validator to accept it.

import { inputsChecked, unresolvedInputBindings } from './input-bindings.mjs';

const PREFIX = 'workflow:';
const VAULT_KEY = /credential_name$|secret_name$/;

export function fileNameOf(id) {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) throw new Error(`a recipe id starts with ${PREFIX}: ${id}`);
  const slug = id.slice(PREFIX.length);
  if (slug.includes(':')) throw new Error(`a recipe file name holds no colon: ${slug}`);
  return `${slug}.json`;
}

const asObject = value => (typeof value === 'string' ? JSON.parse(value) : value);
const isEmpty = value => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

function handAsks(definition) {
  return (definition?.steps ?? [])
    .filter(step => step.kind === 'ask' && ['anyone', 'ai', 'actor', ''].includes(step.config?.name ?? ''))
    .map(step => `hand ask: ${step.id}`);
}

// A run of a listed workflow row starts only the tools its row names in records.runs (the engine run_capability.rs
// Rights::declared; the engine hands no host actions to a row that names none), so a row whose steps ask a tool but whose
// records name none fails every woken run at its first ask: a-piece-to-run (workflow:run-one-piece) and at-its-time
// (workflow:send-each-post-at-its-time) on the Mac, 9:4x PM CST Nov 21 2026, "This run was not handed its host actions".
// The tools a definition asks (every ask step, at any depth: loops, actions and its uses, whose name is a tool id) are
// what its runs start, so the file names them with the row's own, as DATA read from the steps. A step that tells a fact
// (an ask of wake:arrive with a literal kind) needs the right to tell that kind at the run's own records, so it is named
// the same way; a kind made at run time is the row's own to name.
const TOOL_ID_START = 'tool:';
const TELL = 'wake:arrive';
const OWN_RECORDS = '@own-records';
const MOST_RUNS = 32; // the engine tool-runs.json runs.most: a row naming more is refused whole.

export function toolsAsked(definition) {
  const asked = new Set();
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value === null || typeof value !== 'object') return;
    const name = value.kind === 'ask' ? value.config?.name : undefined;
    if (typeof name === 'string' && name.startsWith(TOOL_ID_START) && name.length > TOOL_ID_START.length) asked.add(name);
    Object.values(value).forEach(walk);
  };
  walk(definition);
  return [...asked].sort();
}

export function kindsTold(definition) {
  const told = new Set();
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value === null || typeof value !== 'object') return;
    const kind = value.kind === 'ask' && value.config?.name === TELL ? value.config?.input?.kind : undefined;
    if (typeof kind === 'string' && kind) told.add(kind);
    Object.values(value).forEach(walk);
  };
  walk(definition);
  return [...told].sort();
}

function recordsOf(row, definition) {
  const own = isEmpty(row.records) ? {} : asObject(row.records);
  const runs = [...new Set([...(Array.isArray(own.runs) ? own.runs : []), ...toolsAsked(definition)])].sort();
  if (runs.length > MOST_RUNS) throw new Error(`${row.recipe}: its steps ask ${runs.length} tools; a row may name at most ${MOST_RUNS} in records.runs`);
  const rights = Array.isArray(own.rights) ? [...own.rights] : [];
  for (const kind of kindsTold(definition)) {
    if (!rights.some(right => right?.at === OWN_RECORDS && right?.id === kind && right?.operations?.includes(TELL))) {
      rights.push({ at: OWN_RECORDS, id: kind, operations: [TELL] });
    }
  }
  const records = { ...own, ...(rights.length ? { rights } : {}), ...(runs.length ? { runs } : {}) };
  return Object.keys(records).length ? records : null;
}

function vaultNames(input, at = '') {
  if (Array.isArray(input)) return input.flatMap((item, index) => vaultNames(item, `${at}[${index}]`));
  if (input === null || typeof input !== 'object') return [];
  return Object.entries(input).flatMap(([key, value]) => [
    ...(VAULT_KEY.test(key) && typeof value === 'string' ? [`${at}.${key}`] : []),
    ...vaultNames(value, `${at}.${key}`),
  ]);
}

// History notes (a step's context.changed_by, a fires_when rule's evidence) belong to the person's row, never to the shared file: they are dropped at render.
const HISTORY_KEYS = ['changed_by', 'evidence'];
export function withoutHistory(value) {
  if (Array.isArray(value)) return value.map(withoutHistory);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !HISTORY_KEYS.includes(key)).map(([key, item]) => [key, withoutHistory(item)]));
}

export function fileFromRow(row) {
  const definition = withoutHistory(asObject(row.definition));
  const wakes = isEmpty(row.wakes) ? [] : asObject(row.wakes);
  const problems = [];
  if (isEmpty(row.job)) problems.push('job is empty');
  if (isEmpty(row.produces)) problems.push('produces is empty');
  if (isEmpty(row.input_schema)) problems.push('input_schema is empty');
  if (problems.length) throw new Error(`${row.recipe}: ${problems.join('; ')}`);
  const payload = {
    source_kept_at: row.kept_at,
    kind: 'workflow-recipe',
    id: row.recipe,
    label: row.title,
    job: row.job,
    produces: row.produces,
    source: asObject(row.source) ?? {},
    input_schema: asObject(row.input_schema),
    definition,
  };
  if (wakes.length) payload.wakes = wakes.map(({ id, on, budget, input }) => ({ id, on, budget, input: { start_at: input?.start_at } }));
  if (!isEmpty(row.fires_when)) payload.fires_when = withoutHistory(asObject(row.fires_when));
  const records = recordsOf(row, definition);
  if (records) payload.records = records;
  return { about: `${row.recipe}: rendered from its workflow_recipes row.`, records: [{ payload }] };
}

// origin is the file the render replaces (null when the recipe is new). A render may not drop a payload key, a definition key or a step
// that origin has: the row must be backfilled from the file first, then rendered.
export function lostAgainstOrigin(payload, origin) {
  const before = origin?.records?.[0]?.payload;
  if (!before) return [];
  const lost = Object.keys(before).filter((k) => !(k in payload)).map((k) => k);
  const was = before.definition ?? {};
  const now = payload.definition ?? {};
  lost.push(...Object.keys(was).filter((k) => !(k in now)).map((k) => `definition/${k}`));
  const nowSteps = new Set((now.steps ?? []).map((s) => s.id));
  lost.push(...(was.steps ?? []).filter((s) => !nowSteps.has(s.id)).map((s) => `step ${s.id}`));
  return lost;
}

export function checkFile(file, row, fileName = fileNameOf(row.recipe), origin = null) {
  const problems = [];
  if (fileName.includes(':')) problems.push('the file name holds a colon');
  const payload = file.records?.[0]?.payload ?? {};
  if (payload.source_kept_at !== row.kept_at) problems.push(`stale: file is stamped ${payload.source_kept_at}, its row is at ${row.kept_at}`);
  const lost = lostAgainstOrigin(payload, origin);
  if (lost.length) problems.push(`lost against origin file: ${lost.join(', ')}`);
  problems.push(...handAsks(payload.definition ?? {}));
  for (const wake of payload.wakes ?? []) {
    for (const at of vaultNames(wake.input ?? {})) problems.push(`vault name in wake ${wake.id} input${at}`);
  }
  return problems;
}

// A kit regenerated from its row may not drop a tool or a workflow the origin kit lists while the row still uses it. An entry the row
// no longer uses may go; it is reported in dropped so the change is visible.
export function kitChanges(origin, next, usedTools, usedWorkflows) {
  const refused = [];
  const dropped = [];
  for (const [field, used] of [['tools', usedTools], ['workflows', usedWorkflows]]) {
    const was = origin?.[field] ?? [];
    const now = new Set(next?.[field] ?? []);
    for (const entry of was) {
      if (now.has(entry)) continue;
      if (used.has(entry)) refused.push(`${field}: ${entry}`);
      else dropped.push(`${field}: ${entry}`);
    }
  }
  return { refused, dropped };
}

// ---- planning one row: the file, the kit, the gate report and the colon-body rule ----------------------------------------------

// A recipe file must not name a person, brand, store or connection. These words are the gate's own list (the recipe check reports them).
// The brand and owner words are not in this file: the caller passes them (input.gate_words), from the brand row of the site that runs it.
const GATE_PATTERN = /-connection\b|_for_who|instagram:\S+|@\w+/gi;
const TOOL_ID = /tool:[a-z0-9][a-z0-9._:-]*[a-z0-9]/g;
const WORKFLOW_ID = /workflow:[a-z0-9][a-z0-9:-]*[a-z0-9]/g;

export function gateWordsIn(text, words = []) {
  const brand = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = brand.length ? new RegExp(`${brand.join('|')}|${GATE_PATTERN.source}`, 'gi') : GATE_PATTERN;
  return [...new Set(text.match(pattern) ?? [])].sort();
}

// The tools and workflows a definition uses: its ask steps' names, every tool or definition_id key anywhere, and the ids its
// ask do and submit text names (top-level steps only).
export function usedIn(definition) {
  const tools = new Set();
  const workflows = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'name' && typeof item === 'string' && item.startsWith('tool:')) tools.add(item);
      if (key === 'tool' && typeof item === 'string' && item.startsWith('tool:')) tools.add(item);
      if (key === 'definition_id' && typeof item === 'string') workflows.add(item.split('#')[0]);
      walk(item);
    }
  };
  walk(definition);
  for (const step of definition?.steps ?? []) {
    const input = step?.config?.input ?? {};
    const text = JSON.stringify([input.do, input.submit]);
    for (const tool of text.match(TOOL_ID) ?? []) tools.add(tool);
    for (const workflow of text.match(WORKFLOW_ID) ?? []) workflows.add(workflow.split('#')[0]);
  }
  return { tools, workflows };
}

// The kit a recipe is served with: its tools and workflows as the walker finds them, the run tool always, and only recipe ids in
// workflows.
// The step a kit's worked example walks: the first top-level hand step (an ask that no tool answers), so the example names a step the person does.
function exampleStep(definition) {
  const hand = definition.steps.find(step => !step.id.includes('#') && step.kind === 'ask' && !String(step.config?.name ?? '').startsWith('tool:'));
  return hand ?? definition.steps[0];
}

export function kitFromRow(row, used) {
  const rid = row.recipe;
  const definition = asObject(row.definition);
  const workflows = [rid, ...[...used.workflows].sort().filter((w) => w && w !== rid && w.startsWith('workflow:') && w.split(':').length === 2)];
  const tools = [...new Set([...used.tools, 'tool:run-workflow-definition'])].sort();
  return {
    start_here: `Say to your AI: "Run ${rid}." The wake starts it once its switch input is set.`,
    lists: [],
    no_lists_because: "The workflow works through the owner's own database tools and writes no list of its own.",
    workflows,
    tools,
    instructions: ["1. Set the wake's switch input with the owner's store names.", `2. Say "Run ${rid}".`, '3. Read the answer the run hands back.'],
    worked_examples: [{
      title: row.title,
      ask: `Run ${rid}.`,
      mcp: { server: '{cli}', tool: 'do_one_thing_in_my_account', input: { method: 'tools:run', input: { tool: 'tool:run-workflow-definition', input: { row: rid } } } },
      workflow: rid,
      step: exampleStep(definition).id,
      given: "The owner's own rows are in place.",
      hands_back: 'The run finishes at the step "done" and answers the quoted "done".',
    }],
    drafted_from: `${rid} rendered from its row`,
  };
}

// Sorted-key JSON, so two objects with the same content compare equal.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

// An id with two colons is a body that rides in its parent's definition.uses. It is not a file of its own: the body row and the parent's copy
// must match, or the render is refused.
export function bodyOf(id) {
  const parts = String(id).split(':');
  return parts.length === 3 ? parts.slice(0, 2).join(':') : null;
}

export function planRender(row, { origin = null, originKit = null, parent = null, allowLost = [], gateWords = [] } = {}) {
  const slug = row.recipe.slice(PREFIX.length).replace(/:/g, '_');
  const plan = { id: row.recipe, slug, kept_at: row.kept_at, problems: [], findings: [], gate_words: [], recipe: null, kit: null, rides_in_parent: false };
  const parentId = bodyOf(row.recipe);
  if (parentId) {
    const copy = (parent?.uses ?? []).find((body) => body.id === row.recipe);
    plan.rides_in_parent = Boolean(copy);
    if (copy && canonical(copy) === canonical(asObject(row.definition))) plan.note = `skipped: a body rides in its parent ${parentId}'s file`;
    else plan.problems.push(`REFUSED: body ${row.recipe} differs from its parent ${parentId} copy or the parent does not carry it`);
    return plan;
  }
  let file = null;
  try {
    file = fileFromRow(row);
  } catch (error) {
    plan.problems.push(`row is incomplete: ${error.message}`);
  }
  if (file) {
    const payload = file.records[0].payload;
    const lost = lostAgainstOrigin(payload, origin).filter((item) => !allowLost.includes(item));
    if (lost.length) plan.problems.push(`lost against origin file: ${lost.join(', ')}`);
    if ((payload.wakes ?? []).length) plan.problems.push(...handAsks(payload.definition ?? {}));
    plan.recipe = { text: `${JSON.stringify(file, null, 2)}\n` };
    plan.gate_words = gateWordsIn(plan.recipe.text, gateWords);
    plan.problems.push(...checkFile(file, row, fileNameOf(row.recipe), origin).filter((item) => item.startsWith('vault name') || item.startsWith('stale')));
  }
  // A step that reads a run-input key no start of the row gives fails every run that start makes. It is a finding, and the
  // file is written; a row its owner has fixed or confirmed (flag inputs-checked) is refused instead.
  const refuses = inputsChecked(row);
  for (const { line, declared } of unresolvedInputBindings(row)) {
    if (refuses && !declared) plan.problems.push(`REFUSED: ${line}`);
    else plan.findings.push(`FINDING: ${line}`);
  }
  if (!asObject(row.definition)?.steps?.length) {
    plan.problems.push('definition has no steps');
    return plan;
  }
  const used = usedIn(asObject(row.definition));
  const kit = kitFromRow(row, used);
  const { refused, dropped } = kitChanges(originKit, kit, new Set(kit.tools), new Set(kit.workflows));
  const seeAlso = [...new Set([...refused, ...dropped].map((entry) => entry.split(': ').slice(1).join(': ')))].sort();
  if (seeAlso.length) kit.see_also = seeAlso;
  plan.kit = { json: `${JSON.stringify(kit, null, 2)}\n`, refused, dropped, see_also: seeAlso };
  return plan;
}
