// packages/notifications/do-work/save-setting.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The write authority for a setting screen. It takes the canonical action route
// — already resolved by read-notifications-policy.ts as `policy.actionRoute`
// (SettingActionRouteView) — turns an OPAQUE option id into the owner's invoke
// envelope, and routes it to the named target. This file owns NO route truth:
// the policy reader is the single source that decides the route (graph route
// first, descriptor-write fallback). The renderer and projection are blind to
// the route; the assembly of the target envelope lives here.
//
// Because target, method, action definition, and value path all arrive as DATA
// on the SettingActionRouteView, this file contains ZERO domain literals. Adding
// a new write route, retargeting the action, or renaming the value path is a
// record-data edit — no change here (L090: self-describing data, generic
// handler; SSOT: one route, resolved once by the reader, consumed here).
//
// The target envelope is the generic runtime-kit invoke shape used across the
// codebase (see packages/journal/do-work/run-journal-ai-command.ts). The route's
// `payloadTemplate` IS that fixed base envelope (operation, definition_id, and any
// response-control flags the owner declared), resolved entirely from DATA by the
// policy reader; the send authority only inserts the selected value at the route's
// value path. The template keys are the target-invoke protocol, NOT notification
// Society — they are identical for every owner action, and which flags appear is a
// record-data decision, never a code branch here.
//
// Idempotency and the action receipt are owned by the target authority itself
// (the action-graph / side-effect-intent-route records declare
// `single_execution_owner` and `receipt.owner` = the workflow owner). This send
// authority never injects an idempotency key or receipt — it only routes the
// intent to the owner the route names, exactly as the route invariant requires.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain vocabulary. No mode keys, no target name, no `action:...`,
//    no method literal — every routing value is read from the SettingActionRouteView
//    at runtime.
// 2. The opaque option id is inserted verbatim at the route's declared value
//    path inside a freshly built envelope; the route object is never mutated.
// 3. The send path is the canonical runtime-kit target invoke
//    (sendRequestToBitfieldTarget) — notifications never owns a sender, it only
//    routes an intent to the owner the route names.
// 4. Returns a structured, machine-readable result — never throws across the
//    boundary for an expected write failure; the envelope renders the error.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { SettingActionRouteView } from '../read-data/read-notifications-policy';

type JsonObject = Record<string, unknown>;

export interface SaveSettingResult {
  ok: boolean;
  /** The opaque option id that was submitted, echoed for the caller. */
  optionId: string;
  /** Raw reply from the target on success. */
  reply?: unknown;
  /** Human-readable failure sentence on error (already user-safe). */
  error?: string;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) out[key] = cloneJson(nested);
    return out;
  }
  return value;
}

/**
 * Insert `value` at `valuePath` inside a clone of `template`. Missing
 * intermediate objects are created. An empty path returns the value itself
 * (the value IS the whole payload). Pure — the template is never mutated.
 */
export function insertValueAtPath(
  template: unknown,
  valuePath: readonly string[],
  value: unknown,
): unknown {
  if (valuePath.length === 0) return value;

  const payload = cloneJson(template);
  if (!isObject(payload)) {
    throw new Error('Setting write payload template must be an object when a value path is set');
  }

  let cursor: JsonObject = payload;
  for (const segment of valuePath.slice(0, -1)) {
    const next = cursor[segment];
    if (isObject(next)) {
      cursor = next;
    } else {
      const created: JsonObject = {};
      cursor[segment] = created;
      cursor = created;
    }
  }
  cursor[valuePath[valuePath.length - 1]] = value;
  return payload;
}

/**
 * Assemble the target invoke envelope from the canonical action route. The route
 * carries the owner's complete fixed base envelope as `payloadTemplate` (operation,
 * definition_id, response-control flags, any other declared field — all DATA); the
 * opaque option id is inserted at the route's value path into a clone of it. Every
 * value comes from the route DATA — this function names none of them, and the
 * template is never mutated (insertValueAtPath clones before writing).
 */
export function buildActionPayload(route: SettingActionRouteView, optionId: string): unknown {
  return insertValueAtPath(route.payloadTemplate, route.valuePath, optionId);
}

/**
 * The user-safe failure sentence for a thrown/rejected write. We never surface
 * the raw error to the product UI — the screen shows the copy table's error
 * sentence; this string is a fallback the envelope may display.
 */
const WRITE_FAILED_MESSAGE = 'That change did not save. Your choice is unchanged.';

/**
 * Submit an opaque option id through the canonical action route. Builds the
 * owner's invoke envelope from route DATA and sends it to the named target.
 */
export async function saveSetting(
  route: SettingActionRouteView | null | undefined,
  optionId: string,
): Promise<SaveSettingResult> {
  if (!route || !route.target) {
    return { ok: false, optionId, error: 'This setting is read-only and cannot be changed here.' };
  }
  try {
    const payload = buildActionPayload(route, optionId);
    const reply = await sendRequestToBitfieldTarget({ target: route.target, payload });
    return { ok: true, optionId, reply };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : WRITE_FAILED_MESSAGE;
    return { ok: false, optionId, error: message };
  }
}
