// packages/ui/show/placeable-surface-intent/record-surface-intent.ts
//
// Turn a produced record that carries a surface-open intent at a DATA-named
// field path into OpenSurfaceAction props, gated by a data-owned permit policy.
// The producer (AI coach, operator push, scheduler) is a config, not named
// here. Fail-closed — an intent that no policy entry permits yields no button.

import type { OpenSurfaceActionProps } from '../open-surface-action/OpenSurfaceAction';
import {
  readPlaceableSurfacePayloadFromUnknown,
  type PlaceableSurfacePayload,
} from './placeable-surface-intent';

/**
 * One permit entry: an OPEN map of payload-field name -> expected value. The
 * matcher names no field — every key the entry specifies is compared
 * structurally against the payload, so entries can match materialTarget,
 * target, packageEntry, or any payload field a producer invents tomorrow,
 * with zero code change.
 */
export type SurfaceIntentAllowEntry = Readonly<Record<string, unknown>>;

/** Owner-dispatched validation: when supplied, the owner's predicate IS the policy. */
export type SurfaceIntentPermit = (
  payload: PlaceableSurfacePayload,
  allowList: readonly SurfaceIntentAllowEntry[],
) => boolean;

export interface RecordSurfaceIntentOptions {
  readonly intentPath: readonly string[];
  readonly allowList: readonly SurfaceIntentAllowEntry[];
  readonly permit?: SurfaceIntentPermit;
  readonly label?: string;
  readonly detail?: string;
  readonly unavailableMessage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function navigate(record: unknown, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function structurallyEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => structurallyEquals(left[key], right[key]));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => structurallyEquals(item, right[index]));
  }
  return false;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Read the surface-open intent a record carries at `intentPath`. Returns null
 * when the field is absent, null, or does not resolve any surface reference
 * (target / materialTarget / packageEntry) — i.e. a reply with no surface.
 */
export function readSurfaceIntentPayload(
  record: unknown,
  intentPath: readonly string[],
): PlaceableSurfacePayload | null {
  const raw = navigate(record, intentPath);
  const payload = readPlaceableSurfacePayloadFromUnknown(raw);
  if (!payload) return null;
  return payload.target || payload.materialTarget || payload.packageEntry ? payload : null;
}

/**
 * A permit entry matches a payload only when EVERY field the entry specifies
 * structurally equals the payload's, and the entry specifies at least one
 * field. An empty entry matches nothing (fail-closed). The matcher enumerates
 * no field names — entries are open data.
 */
export function surfaceIntentMatchesAllowEntry(
  payload: PlaceableSurfacePayload,
  entry: SurfaceIntentAllowEntry,
): boolean {
  const keys = Object.keys(entry).filter((key) => entry[key] != null);
  if (keys.length === 0) return false;
  const open = payload as Readonly<Record<string, unknown>>;
  return keys.every((key) => structurallyEquals(open[key], entry[key]));
}

/** Policy check: the owner's `permit` predicate when supplied, else entry matching. */
export function surfaceIntentAllowed(
  payload: PlaceableSurfacePayload,
  allowList: readonly SurfaceIntentAllowEntry[],
  permit?: SurfaceIntentPermit,
): boolean {
  if (permit) return permit(payload, allowList);
  return allowList.some((entry) => surfaceIntentMatchesAllowEntry(payload, entry));
}

/**
 * Exact catalog gate for an already-normalized payload. Identity plus mount
 * contract must match one current catalog row; an allowed package cannot smuggle
 * a different target or surfaceInput through a receipt/tool result.
 */
export function surfaceIntentMatchesCatalogPayload(
  payload: PlaceableSurfacePayload,
  catalog: readonly PlaceableSurfacePayload[],
): boolean {
  return catalog.some((candidate) => structurallyEquals(
    {
      packageEntry: payload.packageEntry ?? null,
      materialTarget: payload.materialTarget ?? null,
      target: payload.target ?? null,
      surfaceInput: payload.surfaceInput ?? null,
    },
    {
      packageEntry: candidate.packageEntry ?? null,
      materialTarget: candidate.materialTarget ?? null,
      target: candidate.target ?? null,
      surfaceInput: candidate.surfaceInput ?? null,
    },
  ));
}

/**
 * Compose a record's surface intent into OpenSurfaceAction props, or null when
 * there is no intent, the policy does not permit it (fail-closed), or no label
 * is available. The label prefers the intent's own title.
 */
export function recordSurfaceIntentToOpenSurfaceProps(
  record: unknown,
  options: RecordSurfaceIntentOptions,
): OpenSurfaceActionProps | null {
  const payload = readSurfaceIntentPayload(record, options.intentPath);
  if (!payload) return null;
  if (!surfaceIntentAllowed(payload, options.allowList, options.permit)) return null;
  const label = optionalString(payload.title) ?? options.label ?? null;
  if (!label) return null;
  return {
    payload,
    label,
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.unavailableMessage ? { unavailableMessage: options.unavailableMessage } : {}),
  };
}
