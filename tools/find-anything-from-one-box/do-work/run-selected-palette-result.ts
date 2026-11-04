// packages/command-palette/do-work/run-selected-palette-result.ts
//
// Selection runner for palette results. The selected producer address receives
// the selected item bytes; command-palette does not know the producer's action.

import { sendRequestToBitfieldTarget } from '#workspace-records';

import type { PaletteSearchResult } from '../show/palette-types';
import {
  emitPlaceableSurfaceIntent,
  readPlaceableSurfacePayloadFromUnknown,
  readPlaceableSurfaceRecordFromUnknown,
  type PlaceableSurfacePayload,
} from '../../ui/show/placeable-surface-intent';

export interface RunSelectedPaletteResultRequest {
  published_record: unknown;
  caller_request: {
    selected_item: unknown;
    query_text: string;
  };
}

export type RunSelectedPaletteResultOutcome =
  | { readonly kind: 'placeable-surface-intent'; readonly accepted: boolean }
  | { readonly kind: 'target-invocation'; readonly reply: unknown }
  | { readonly kind: 'unhandled-result' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function isPlaceableSurfaceResult(result: PaletteSearchResult): boolean {
  const raw = result.item.raw;
  if (!isRecord(raw)) return false;
  const kind = readString(raw.kind) ?? readString(raw.type);
  return (
    kind === 'placeable-surface' ||
    readString(raw.materialTarget) !== null ||
    readString(raw.material_target) !== null ||
    isRecord(raw.packageEntry) ||
    isRecord(raw.package_entry)
  );
}

function hasMaterialKind(payload: PlaceableSurfacePayload): boolean {
  return isRecord(payload.material) && readString(payload.material.kind) !== null;
}

function hasRenderableSurfaceAddress(payload: PlaceableSurfacePayload): boolean {
  return !!payload.target || !!payload.packageEntry || !!payload.materialTarget || hasMaterialKind(payload);
}

function payloadFromSharedSurfaceRecord(
  surface: NonNullable<ReturnType<typeof readPlaceableSurfaceRecordFromUnknown>>,
): PlaceableSurfacePayload {
  return {
    version: 1,
    id: surface.id,
    title: surface.label,
    target: surface.target ?? null,
    packageEntry: surface.packageEntry ?? null,
    materialTarget: surface.materialTarget,
    icon: surface.icon,
    ...(surface.surfaceInput ? { surfaceInput: surface.surfaceInput } : {}),
  };
}

export function makePlaceableSurfacePayloadFromResult(
  result: PaletteSearchResult,
): PlaceableSurfacePayload | null {
  const surface = readPlaceableSurfaceRecordFromUnknown(result.item.raw);
  if (surface && !surface.disabled) return payloadFromSharedSurfaceRecord(surface);

  if (!isPlaceableSurfaceResult(result)) return null;
  const payload = readPlaceableSurfacePayloadFromUnknown(result.item.raw);
  if (!payload) return null;

  const candidate: PlaceableSurfacePayload = {
    version: payload.version ?? 1,
    id: payload.id ?? result.item.id,
    title: payload.title ?? result.item.title,
    target: payload.target ?? result.item.target ?? null,
    packageEntry: payload.packageEntry ?? null,
    materialTarget: payload.materialTarget ?? null,
    icon: payload.icon,
    ...(payload.material ? { material: payload.material } : {}),
    ...(payload.surfaceInput ? { surfaceInput: payload.surfaceInput } : {}),
  };

  return hasRenderableSurfaceAddress(candidate) ? candidate : null;
}

export function makeRunSelectedPaletteResultRequest(
  result: PaletteSearchResult,
): RunSelectedPaletteResultRequest {
  return {
    published_record: result.item.source.publishedRecord,
    caller_request: {
      selected_item: result.item.raw,
      query_text: result.queryText,
    },
  };
}

export async function runSelectedPaletteResult(
  result: PaletteSearchResult,
): Promise<RunSelectedPaletteResultOutcome> {
  const placeablePayload = makePlaceableSurfacePayloadFromResult(result);
  if (placeablePayload) {
    const accepted = emitPlaceableSurfaceIntent(placeablePayload);
    if (accepted || !result.item.target) {
      return { kind: 'placeable-surface-intent', accepted };
    }
  }

  if (!result.item.target) {
    return { kind: 'unhandled-result' };
  }

  const reply = await sendRequestToBitfieldTarget({
    target: result.item.target,
    payload: makeRunSelectedPaletteResultRequest(result),
  });
  return { kind: 'target-invocation', reply };
}
