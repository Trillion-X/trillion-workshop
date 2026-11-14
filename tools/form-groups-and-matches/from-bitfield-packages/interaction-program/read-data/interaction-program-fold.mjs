// packages/interaction-program/read-data/interaction-program-fold.mjs
//
// Purpose: The translation boundary (L098) for the `interaction-program` descriptor.
// Folds raw `interaction-program` records off the log into a typed, validated program
// object — the ONLY place that knows the descriptor record shape. Consumers (the match
// cycle, the CM console, the member feed) receive a finished `InteractionProgram`, never
// raw payloads or ref-address parsing.
//
// The descriptor is PURE DATA WIRING: ten Envelope-address refs, each pointing at a
// record owned by an existing package. This package owns NONE of the referenced behavior
// — it owns only the row that names the composition. A book club, a mastermind pod, and a
// dating cohort are three DIFFERENT descriptor rows with different refs and ZERO code
// change (L069/L090).
//
// Non-negotiable: the handler NEVER enumerates community types. There is no
// `if (kind === "book-club")`. Community identity is entirely in the DATA refs.

/** The ten composition refs, in canonical order. Each is an Envelope address string. */
export const PROGRAM_REFS = [
  "group_ref",                    // group — the member set (NUCLEUS)
  "participant_source_ref",       // person-profile / person-list — who is eligible
  "match_descriptor_ref",         // meaning-search descriptor — similarity + provenance
  "relationship_kind_ref",        // relationship-graph — pair/mentor/team edge kind
  "time_window_ref",              // notice-when-something-shows-up (clock waiter) + timed-action — the time-boxed window
  "daily_context_sequence_ref",   // context-feed — per-day theme sequence
  "ai_icebreaker_producer_ref",   // ai-records-producer — icebreaker recipe
  "access_rule_ref",              // access-rule — member types + permissions
  "score_measure_ref",            // progression-evaluator + formula-engine — points/season
  "surface_ref",                  // documents — landing/community page
];

/**
 * @param {unknown} raw  a payload as it sits on the log (object or JSON text)
 * @returns {Record<string, any>|null}
 */
function coercePayload(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  if (typeof raw === "object") return raw;
  return null;
}

/**
 * Fold one raw record into a typed InteractionProgram, or null if it is not a valid
 * interaction-program descriptor. Blind-tolerant: unknown extra fields are preserved on
 * `extra`, missing optional refs become null (never a throw).
 *
 * @param {{address?:string, value_json?:unknown, payload?:unknown}} record
 */
export function foldInteractionProgram(record) {
  const payload = coercePayload(record?.payload ?? record?.value_json);
  if (!payload || payload.kind !== "interaction-program" || typeof payload.id !== "string") {
    return null;
  }
  const refs = {};
  for (const key of PROGRAM_REFS) {
    refs[key] = typeof payload[key] === "string" ? payload[key] : null;
  }
  const known = new Set(["kind", "id", "partition_key", "label", "pairing", ...PROGRAM_REFS]);
  const extra = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!known.has(k)) extra[k] = v;
  }
  return {
    id: payload.id,
    label: typeof payload.label === "string" ? payload.label : payload.id,
    // `pairing` is DATA consumed by select-pairs (group_size/order/roles/exclusion).
    pairing: payload.pairing && typeof payload.pairing === "object" ? payload.pairing : {},
    refs,
    extra,
  };
}

/**
 * Read path: fold a set of raw records into a map of programs keyed by id (latest wins
 * by array order — caller passes records newest-last, matching the log fold contract).
 * @param {Array<object>} records
 * @returns {Map<string, ReturnType<typeof foldInteractionProgram>>}
 */
export function foldInteractionPrograms(records) {
  const out = new Map();
  for (const rec of Array.isArray(records) ? records : []) {
    const program = foldInteractionProgram(rec);
    if (program) out.set(program.id, program);
  }
  return out;
}

/** Storage-key SSOT for an interaction-program descriptor. */
export function interactionProgramAddress(id) {
  return `package::interaction-program::program::${id}`;
}
