import type { PackageEntryReference, TabMeta } from '../read-data/layout-types'
import {
  admitPlaceableSurfaceEntry,
  admitPlaceableSurfaceFiles,
  type PlaceableSurfaceAdmissionSurface,
} from '../../ui/show/placeable-surface-intent/placeable-surface-entry'
import {
  hasPlaceableSurface,
  PLACEABLE_SURFACE_MIME,
  readPlaceableSurfacePayload,
  readPlaceableSurfacePayloadFromUnknown,
  type PlaceableSurfacePayload,
} from '../../ui/show/placeable-surface-intent/placeable-surface-intent'

export {
  hasPlaceableSurface,
  PLACEABLE_SURFACE_MIME,
  readPlaceableSurfacePayload,
  readPlaceableSurfacePayloadFromUnknown,
}

function transferTypes(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.types ?? [])
}

function hasScreenInternalDrag(dataTransfer: DataTransfer): boolean {
  const types = transferTypes(dataTransfer)
  return types.includes('application/x-tab-id') || types.includes('application/x-container-id')
}

function makeTabId(seed: string | null): string {
  const base = (seed ?? 'tab')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'tab'
  return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readMaterialKind(payload: PlaceableSurfacePayload): string | null {
  if (!isRecord(payload.material)) return null
  const kind = payload.material.kind
  return typeof kind === 'string' && kind.trim().length > 0 ? kind.trim() : null
}

function surfaceAcceptsMaterial(
  surface: PlaceableSurfaceAdmissionSurface,
  materialKind: string | null,
): boolean {
  if (!materialKind || surface.disabled) return false
  const accepted = isRecord(surface.payload)
    ? surface.payload.accepts_material_kinds ?? surface.payload.acceptsMaterialKinds
    : null
  return Array.isArray(accepted)
    && accepted.some((value) => typeof value === 'string' && value.trim() === materialKind)
}

function surfaceMatchesPayload(
  surface: PlaceableSurfaceAdmissionSurface,
  payload: PlaceableSurfacePayload,
  materialKind: string | null,
): boolean {
  if (surface.disabled) return false
  if (payload.materialTarget && surface.materialTarget === payload.materialTarget) return true
  return surfaceAcceptsMaterial(surface, materialKind)
}

function resolvePayloadSurface(
  payload: PlaceableSurfacePayload,
  surfaces: readonly PlaceableSurfaceAdmissionSurface[],
): PlaceableSurfacePayload {
  if (payload.target || payload.packageEntry) return payload
  const materialKind = readMaterialKind(payload)
  const surface = surfaces.find((candidate) => surfaceMatchesPayload(candidate, payload, materialKind))
  if (!surface) return payload
  return {
    ...payload,
    // A catalog row dragged into a pane is still that screen. Only a dropped
    // material needs a per-subject identity beneath the accepting screen.
    id: payload.id === surface.id && !payload.material
      ? surface.id
      : `${surface.id}:${payload.id ?? Date.now().toString(36)}`,
    target: surface.target ?? null,
    packageEntry: surface.packageEntry ?? null,
    materialTarget: surface.materialTarget,
    icon: payload.icon ?? surface.icon,
  }
}

function makePlaceableSurfaceTab(
  payload: PlaceableSurfacePayload,
  inputBinding: 'catalog' | 'invocation' = payload.surfaceInput ? 'invocation' : 'catalog',
): TabMeta {
  const packageEntry = payload.packageEntry as PackageEntryReference | null | undefined
  const title = payload.title ?? payload.packageEntry?.entryName ?? payload.materialTarget ?? payload.target ?? 'Thing'
  return {
    id: makeTabId(payload.id ?? packageEntry?.entryName ?? payload.materialTarget ?? payload.target ?? title),
    title,
    target: payload.target ?? null,
    packageEntry: packageEntry ?? null,
    materialTarget: payload.materialTarget ?? null,
    icon: payload.icon ?? 'Square',
    closable: true,
    metadata: {
      placeable_surface_id: payload.id ?? null,
      placeable_surface_label: title,
      placeable_surface_version: payload.version ?? null,
      surfaceInputBinding: inputBinding,
      ...(payload.surfaceInput ? { surfaceInput: payload.surfaceInput } : {}),
      ...(payload.recordKind ? { recordKind: payload.recordKind } : {}),
    },
  }
}

export function readPlaceableSurfaceTabFromPayload(
  value: unknown,
  inputBinding?: 'catalog' | 'invocation',
): TabMeta | null {
  const payload = readPlaceableSurfacePayloadFromUnknown(value)
  if (!payload) return null
  return makePlaceableSurfaceTab(payload, inputBinding)
}

/** File picking and file dropping create the same closable presentation tab. */
export function placeableSurfaceTabForFiles(
  files: readonly File[],
  surfaces: readonly PlaceableSurfaceAdmissionSurface[],
): TabMeta | null {
  const payload = admitPlaceableSurfaceFiles(files, surfaces)
  return payload ? readPlaceableSurfaceTabFromPayload(payload, 'invocation') : null
}

export function readPlaceableSurfaceTab(dataTransfer: DataTransfer): TabMeta | null {
  const payload = readPlaceableSurfacePayload(dataTransfer)
  return payload ? makePlaceableSurfaceTab(payload) : null
}

export function readPlaceableSurfaceTabOrAdmitEntry(
  dataTransfer: DataTransfer,
  surfaces: readonly PlaceableSurfaceAdmissionSurface[],
): TabMeta | null {
  const payload = readPlaceableSurfacePayload(dataTransfer)
    ?? (hasScreenInternalDrag(dataTransfer) ? null : admitPlaceableSurfaceEntry(dataTransfer, surfaces))
  return payload ? makePlaceableSurfaceTab(resolvePayloadSurface(payload, surfaces)) : null
}

export type { PlaceableSurfaceAdmissionSurface }
