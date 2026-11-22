// tools/render-a-workflow-file-from-its-row/read-data/render.mjs
//
// A workflow's file under tools/workflows/recipes is rendered from its workflow_recipes row, never written by hand. This
// module is the one place that makes the file from a row, and the one place that checks an existing file against its row.
// A row is read through tool:run-sql-in-my-database; this module takes its values as plain objects.
//
// fileFromRow(row) -> { about, records: [{ payload }] }: the payload keeps the row's own steps (as `definition`), its
// job, produces, input schema, source and fires_when, each wake with its input cut to its start step, and its records
// with every tool its steps ask in records.runs. The store names
// and account are not in the file: they come with each person's switch.
// checkFile(file, row) -> problems: the file must be stamped with the row's kept_at, its name must be the id without
// "workflow:" and hold no colon, and the row must be complete enough for the recipe validator to accept it.

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

// A run of a listed workflow row starts only the tools its row names in records.runs (trillion-rust run_capability.rs
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
const MOST_RUNS = 32; // trillion-rust tool-runs.json runs.most: a row naming more is refused whole.

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

export function fileFromRow(row) {
  const definition = asObject(row.definition);
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
    wakes: wakes.map(({ id, on, budget, input }) => ({ id, on, budget, input: { start_at: input?.start_at } })),
    definition,
  };
  if (!isEmpty(row.fires_when)) payload.fires_when = asObject(row.fires_when);
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
