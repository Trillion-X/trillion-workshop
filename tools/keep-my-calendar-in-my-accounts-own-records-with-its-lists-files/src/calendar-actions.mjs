// The one Calendar's writes use the connected account's existing Workshop tools.
// A source may name only actions it actually provides in src/calendar.json. The
// request never chooses a tool; Workshop still checks its current input schema,
// connection and provider result, and its task key makes retries idempotent.
import settings from './calendar.json' with { type: 'json' };
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export class CalendarActionError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/** Run one source-declared write through the signed-in person's Workshop owner. */
export function prepareCalendarAction(request, { sources = settings.sources } = {}) {
  const { source: sourceId, action, input, request_key: requestKey } = request ?? {};
  if (!nonempty(sourceId)) throw new CalendarActionError('source is required.');
  if (!nonempty(action)) throw new CalendarActionError('action is required.');
  if (!object(input)) throw new CalendarActionError('input must be an object matching the connected tool input_schema.');
  if (!nonempty(requestKey)) throw new CalendarActionError('request_key is required so a retry cannot repeat a calendar change.');

  const source = sources.find(row => row.id === sourceId);
  const declaration = source?.calendar_actions?.[action];
  if (!declaration || !nonempty(declaration.tool)) throw new CalendarActionError(`The ${sourceId} source does not declare ${action}.`);
  const capabilityId = declaration.required_capability_id;
  // The Workshop request owner checks the current account immediately before
  // execution, including the legacy default-account path. This snapshot can
  // reject a known disabled choice, but cannot establish positive authority.
  if (nonempty(capabilityId) && source.capabilityChoices?.[capabilityId] === 'disabled') {
    throw new CalendarActionError('Calendar use is turned off for this connected account.');
  }

  // Calendar identity is owned by the source. A caller cannot redirect a row's
  // action to a different calendar by changing its input.
  const defaults = object(declaration.input_defaults) ? declaration.input_defaults : {};
  for (const [key, value] of Object.entries(defaults)) {
    if (Object.hasOwn(input, key) && JSON.stringify(input[key]) !== JSON.stringify(value)) {
      throw new CalendarActionError(`${key} is fixed by the selected calendar source.`);
    }
  }
  const toolInput = { ...input, ...defaults };
  const fullKey = `calendar:${sourceId}:${action}:${requestKey.trim()}`;
  const scopedKey = fullKey.length <= 200 ? fullKey : `calendar:1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([sourceId, action, requestKey.trim()]))))}`;
  if (declaration.request_key_field) {
    if (scopedKey.length > 200) throw new CalendarActionError('request_key is too long for this calendar action.');
    const field = declaration.request_key_field;
    if (Object.hasOwn(input, field) && input[field] !== scopedKey) {
      throw new CalendarActionError(`${field} is set from request_key for this calendar action.`);
    }
    toolInput[field] = scopedKey;
  }
  return { tool_id: declaration.tool, input: toolInput, request_key: scopedKey };
}

export async function runCalendarAction(request, { runTool, sources = settings.sources } = {}) {
  if (typeof runTool !== 'function') throw new TypeError('runTool is required.');
  const invocation = prepareCalendarAction(request, { sources });
  try {
    // Keep Workshop's result intact: working, for_you_to_run and failed are
    // distinct outcomes and the caller must be able to show them honestly.
    return await runTool(invocation.tool_id, invocation.input, invocation.request_key);
  } catch (error) {
    if (error?.missing_connection) {
      return { state: 'refused', connected: false, error: String(error.message ?? 'Connect this calendar first.') };
    }
    throw error;
  }
}
