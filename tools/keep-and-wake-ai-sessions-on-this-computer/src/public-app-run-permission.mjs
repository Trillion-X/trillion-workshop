// Public app runs are a platform-paid capability, so admission is deliberately
// narrower than ordinary Marketplace use and every publication names a daily
// ceiling. Visitor input is bounded separately at the public app host.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_RUNS_PER_DAY = 100;
const MAX_INPUT_BYTES = 16_384;

export function checkedPublicRunPermission(value) {
  if (value === undefined || value === null || value === false) return null;
  if (!object(value) || Object.keys(value).some(key => !['runs_per_day', 'max_input_bytes'].includes(key))) {
    throw new Error('public_run must name runs_per_day and optional max_input_bytes.');
  }
  const runs = value.runs_per_day;
  const bytes = value.max_input_bytes ?? MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > MAX_RUNS_PER_DAY) {
    throw new Error(`public_run.runs_per_day must be from 1 to ${MAX_RUNS_PER_DAY}.`);
  }
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_INPUT_BYTES) {
    throw new Error(`public_run.max_input_bytes must be from 1 to ${MAX_INPUT_BYTES}.`);
  }
  return { runs_per_day: runs, max_input_bytes: bytes };
}

export function publicRunEligible(tool) {
  const invoke = tool?.invoke;
  const fields = tool?.input_schema?.properties;
  const safeFields = object(fields) && Object.values(fields).every(field => object(field) &&
    ['string', 'number', 'integer', 'boolean'].includes(field.type) &&
    field.format !== 'namespace-file' && !Array.isArray(field['x-your-records']));
  const simpleInput = tool?.input_schema?.type === 'object' && object(fields) && Object.keys(fields).length > 0 && Object.keys(fields).length <= 20 &&
    safeFields;
  return tool?.show_on_public_site === true && tool?.price_ref === undefined && !tool?.billing &&
    simpleInput &&
    invoke?.kind === 'container' && Array.isArray(invoke.argv) && invoke.argv.length > 0 &&
    (invoke.workdir === undefined || invoke.workdir === '/work') && invoke.internet !== true &&
    !invoke.external_effect && !invoke.credential_injections?.length && !invoke.credential_mounts?.length &&
    !invoke.credentials?.length && !invoke.mounts?.length && !invoke.gateway_relay &&
    (invoke.outputs === undefined || (Array.isArray(invoke.outputs) && invoke.outputs.length === 0)) &&
    !tool?.needs?.secret_names?.length && !tool?.keeps_records?.length && !tool?.result_saved_as_tool;
}

export function publicRunPermissionFor(tool) {
  if (!publicRunEligible(tool)) return null;
  try { return checkedPublicRunPermission(tool.public_run); } catch { return null; }
}

export const publicRunLimits = Object.freeze({ max_runs_per_day: MAX_RUNS_PER_DAY, max_input_bytes: MAX_INPUT_BYTES });
