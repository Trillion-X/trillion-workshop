// packages/calendar/read-data/read-calendar-lens-feeds.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The live enumeration boundary for time-block lenses. This module answers two
// questions with real engine reads, never with fixtures:
//
//   1. Which `time-block-lens` DATA rows exist right now?
//   2. For each lens, which rows does its declared input hold right now?
//
// A lens is pure DATA. Its `input` field is a SELF-DESCRIBING engine request
// (`{ target, payload, rows_path }`): this module dispatches it blindly through
// the injected sender and extracts rows from the reply. It never names a source,
// never branches on a source kind, and never knows what the rows mean — the
// lens selectors (applied by `readCalendarTimeBlocks`) carry all meaning.
// Adding a new event source = one lens DATA row. Zero code change (L069/L090).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Transport is injected (`CalendarRequestSender`) — pure in tests, real
//    `sendRequestToBitfieldTarget` in the mount. No other file touches transport
//    for lens reads.
// 2. A lens whose input read fails yields ZERO rows plus a diagnostic issue —
//    one broken source never takes down the surface (fail-visible, not fail-dead).
// 3. Replies are treated as opaque JSON; rows are extracted by the lens's own
//    `rows_path` DATA (default `items`, honoring the engine's flattened-item
//    reply shapes). No reply-shape enumeration beyond structural decoding.

import {
  readCalendarTimeBlocks,
  type CalendarRow,
  type CalendarTimeBlockLens,
  type CalendarTimeBlockReadResult,
} from './read-calendar-time-blocks';

export type CalendarRequestSender = (request: {
  target: string;
  payload: unknown;
}) => Promise<unknown>;

/** Self-describing engine read carried BY the lens DATA row. */
export type CalendarLensInput = {
  target: string;
  payload: Record<string, unknown>;
  /** Dot path into the decoded reply that holds the row array. Default: 'items'. */
  rows_path?: string;
};

export type CalendarLiveLens = CalendarTimeBlockLens & {
  input?: CalendarLensInput;
};

export type CalendarLensReadIssue = {
  id: string;
  tone: 'warning' | 'error';
  label: string;
  detail?: string;
};

export type CalendarLensEnumerationResult = CalendarTimeBlockReadResult & {
  issues: CalendarLensReadIssue[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeReply(reply: unknown): unknown {
  if (typeof reply === 'string') return safeJson(reply);
  if (reply instanceof Uint8Array) return safeJson(new TextDecoder().decode(reply));
  if (ArrayBuffer.isView(reply)) {
    const view = reply as ArrayBufferView;
    return safeJson(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
  }
  if (reply instanceof ArrayBuffer) return safeJson(new TextDecoder().decode(new Uint8Array(reply)));
  if (isRecord(reply) && 'payload' in reply) return decodeReply((reply as { payload: unknown }).payload);
  return reply;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.').filter(Boolean)) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Extract the row array a lens's reply holds, honoring the lens's `rows_path`
 *  DATA and the engine's `output`-wrapped reply variant. */
export function rowsFromLensReply(reply: unknown, rowsPath = 'items'): CalendarRow[] {
  const decoded = decodeReply(reply);
  const candidates = [
    valueAtPath(decoded, rowsPath),
    valueAtPath(decoded, `output.${rowsPath}`),
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

/** Structural validator for a lens DATA row (payload of a `time-block-lens`
 *  record). Malformed rows are dropped by the caller, never thrown on. */
export function parseCalendarLiveLens(value: unknown): CalendarLiveLens | null {
  if (!isRecord(value)) return null;
  const selectors = value.selectors;
  if (
    value.kind !== 'time-block-lens'
    || typeof value.lens_id !== 'string' || !value.lens_id
    || typeof value.input_address !== 'string'
    || typeof value.owner_ref !== 'string' || !value.owner_ref
    || !isRecord(selectors)
    || selectors.identity === undefined
    || selectors.start === undefined
    || selectors.end === undefined
  ) return null;

  const input = value.input;
  if (input !== undefined) {
    if (!isRecord(input) || typeof input.target !== 'string' || !input.target || !isRecord(input.payload)) {
      return null;
    }
  }
  return value as unknown as CalendarLiveLens;
}

/** Read the live `time-block-lens` DATA rows through the injected sender. */
export async function readCalendarLenses(
  sender: CalendarRequestSender,
): Promise<CalendarLiveLens[]> {
  const reply = await sender({
    target: 'slot::find-current-items',
    payload: {
      operation: 'find-current-items',
      in: 'time-block-lens',
      where: { all: [{ field: 'kind', in: ['time-block-lens'] }] },
    },
  });
  return rowsFromLensReply(reply)
    .map(parseCalendarLiveLens)
    .filter((lens): lens is CalendarLiveLens => lens !== null);
}

/**
 * Enumerate every lens: dispatch each lens's own `input` request, project rows
 * through `readCalendarTimeBlocks`, and surface per-lens read failures as
 * diagnostic issues. Lenses without an `input` descriptor contribute rows from
 * `feedsByAddress` (values already present in the entry read scope).
 */
export async function enumerateCalendarLenses(
  lenses: CalendarLiveLens[],
  sender: CalendarRequestSender,
  feedsByAddress: Record<string, unknown> = {},
): Promise<CalendarLensEnumerationResult> {
  const issues: CalendarLensReadIssue[] = [];
  const feeds: Record<string, unknown> = { ...feedsByAddress };

  await Promise.all(lenses.map(async (lens) => {
    if (!lens.input) return;
    try {
      const reply = await sender({ target: lens.input.target, payload: lens.input.payload });
      feeds[lens.input_address] = rowsFromLensReply(reply, lens.input.rows_path);
    } catch (error) {
      feeds[lens.input_address] = [];
      console.error(`calendar: lens-read failed for ${lens.lens_id}:`, error);
      issues.push({
        id: `calendar-lens-read-failed:${lens.lens_id}`,
        tone: 'warning',
        label: `${lens.owner_label ?? lens.owner_ref} events could not load.`,
        detail: 'We couldn\'t reach this calendar. Reconnect the account and try again.',
      });
    }
  }));

  const result = readCalendarTimeBlocks(lenses, feeds);
  if (result.diagnostics.skippedRowCount > 0) {
    issues.push({
      id: 'calendar-lens-rows-skipped',
      tone: 'warning',
      label: `${result.diagnostics.skippedRowCount} item(s) could not be shown.`,
      detail: 'Some connected items were missing a start or end time.',
    });
  }
  return { ...result, issues };
}
