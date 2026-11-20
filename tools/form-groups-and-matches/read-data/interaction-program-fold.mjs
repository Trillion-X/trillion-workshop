// tools/form-groups-and-matches/read-data/interaction-program-fold.mjs
//
// The reader for the `interaction-program` descriptor and for its per-day context sequence. A raw record off the log
// (an object payload, or the same payload as JSON text) folds into a typed program; a daily-sequence payload folds into
// its days in day order. Pure: no I/O, no clock, no store.
//
// A program is data. A weekly circle, a book club and a mentorship are three descriptor records with different fields
// and the same code path. A field this reader does not know is kept on `extra`, never dropped. The program's own fields
// are read as plain values; nothing here turns a field into an address or a storage key.

const KNOWN_PROGRAM_FIELDS = new Set(['kind', 'id', 'partition_key', 'label', 'pairing']);

/** A payload as it sits on the log: an object, or JSON text. Anything else, or text that is not a JSON object, is no payload. */
function payloadOf(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Fold one raw record into a typed program, or null when it is not an `interaction-program` descriptor with a string id.
 * `pairing` is the program's own grouping data (group size, order, roles, exclusion); this reader does not interpret it.
 * @param {{payload?: unknown, value_json?: unknown}} record
 */
export function foldInteractionProgram(record) {
  const payload = payloadOf(record?.payload ?? record?.value_json);
  if (!payload || payload.kind !== 'interaction-program' || typeof payload.id !== 'string') return null;
  const extra = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!KNOWN_PROGRAM_FIELDS.has(key)) extra[key] = value;
  }
  return {
    id: payload.id,
    label: typeof payload.label === 'string' ? payload.label : payload.id,
    pairing: payload.pairing && typeof payload.pairing === 'object' ? payload.pairing : {},
    extra,
  };
}

/** Fold raw records into a map of programs by id. The later record wins, so records come in newest last. */
export function foldInteractionPrograms(records) {
  const out = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const program = foldInteractionProgram(record);
    if (program) out.set(program.id, program);
  }
  return out;
}

/**
 * The per-day context sequence of a program: its days in day order, each with its title and prompt. `payload` is the
 * sequence's own payload (`id`, `for_program`, `days: [{ day, title, prompt_text }]`). Null when it has no string id.
 */
export function readDailySequence(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || payload.id.length === 0) return null;
  const days = Array.isArray(payload.days) ? payload.days : [];
  return {
    id: payload.id,
    forProgram: typeof payload.for_program === 'string' ? payload.for_program : '',
    days: days
      .filter((day) => day && typeof day === 'object' && !Array.isArray(day))
      .map((day) => ({
        day: Number(day.day) || 0,
        title: typeof day.title === 'string' ? day.title : '',
        prompt: typeof day.prompt_text === 'string' ? day.prompt_text : '',
      }))
      .sort((a, b) => a.day - b.day),
  };
}
