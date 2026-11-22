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
