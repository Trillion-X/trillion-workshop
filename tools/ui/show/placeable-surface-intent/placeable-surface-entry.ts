import type {
  PlaceableSurfacePackageEntryReference,
  PlaceableSurfacePayload,
} from './placeable-surface-intent';
import {
  admitPlaceableSurfaceSubject,
  type PlaceableSurfaceSubjectRef,
} from './placeable-surface-subject';

type JsonRecord = Record<string, unknown>;

export interface PlaceableSurfaceAdmissionSurface {
  readonly id: string;
  readonly label: string;
  readonly target?: string;
  readonly packageEntry?: PlaceableSurfacePackageEntryReference;
  readonly materialTarget: string;
  readonly icon?: string;
  readonly disabled?: boolean;
  readonly order?: number;
  readonly payload?: unknown;
}

export interface PlaceableSurfaceEntryDescriptor {
  readonly version: 1;
  readonly source: 'browser.data_transfer';
  readonly title: string;
  readonly items: readonly JsonRecord[];
  readonly handle?: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function hasAdmissionData(surface: PlaceableSurfaceAdmissionSurface): boolean {
  if (surface.disabled) return false;
  if (!isRecord(surface.payload)) return false;
  return isRecord(surface.payload.admission)
    || isRecord(surface.payload.entry_admission)
    || surface.payload.accepts_entry === true;
}

/**
 * Structured intra-app drags declare a namespaced type ('application/x-*').
 * Those are NEVER external content to admit — every package's internal
 * drag-and-drop (records, tabs, views, anything future) is excluded by this
 * one rule, without this module knowing any of their names.
 */
function isInternalStructuredDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types ?? []).some((type) => type.startsWith('application/x-'));
}

function hasDeferredCarrier(dataTransfer: DataTransfer): boolean {
  if (isInternalStructuredDrag(dataTransfer)) return false;
  const types = Array.from(dataTransfer.types ?? []);
  if (types.includes('Files')) return true;
  if (types.includes('text/uri-list')) return true;
  if (types.includes('text/plain')) return true;
  return Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file' || item.kind === 'string');
}

function fileItem(file: File): JsonRecord {
  return {
    kind: 'browser.file',
    name: file.name,
    content_type: file.type || 'application/octet-stream',
    byte_length: file.size,
  };
}

function textItem(kind: string, value: string): JsonRecord {
  return {
    kind,
    value,
    byte_length: new TextEncoder().encode(value).byteLength,
  };
}

function firstFile(dataTransfer: DataTransfer): File | null {
  return dataTransfer.files && dataTransfer.files.length > 0
    ? dataTransfer.files.item(0)
    : null;
}

function readTextValue(dataTransfer: DataTransfer, mime: string): string | null {
  if (!Array.from(dataTransfer.types).includes(mime)) return null;
  try {
    return readString(dataTransfer.getData(mime));
  } catch {
    return null;
  }
}

export function readPlaceableSurfaceEntryDescriptor(
  dataTransfer: DataTransfer,
): PlaceableSurfaceEntryDescriptor | null {
  if (isInternalStructuredDrag(dataTransfer)) return null;
  const items: JsonRecord[] = [];
  const handle = firstFile(dataTransfer);

  if (dataTransfer.files) {
    for (const file of Array.from(dataTransfer.files)) {
      items.push(fileItem(file));
    }
  }

  const uri = readTextValue(dataTransfer, 'text/uri-list');
  if (uri) items.push(textItem('browser.uri-list', uri));

  const text = readTextValue(dataTransfer, 'text/plain');
  if (text) items.push(textItem('browser.text', text));

  if (items.length === 0) return null;

  const firstName = readString(items[0]?.name);
  return {
    version: 1,
    source: 'browser.data_transfer',
    title: firstName ?? `${items.length} dropped item${items.length === 1 ? '' : 's'}`,
    items,
    ...(handle ? { handle } : {}),
  };
}

export function hasPlaceableSurfaceEntryData(
  dataTransfer: DataTransfer,
  surfaces: readonly PlaceableSurfaceAdmissionSurface[],
): boolean {
  return surfaces.some(hasAdmissionData) && readPlaceableSurfaceEntryDescriptor(dataTransfer) !== null;
}

export function hasPlaceableSurfaceEntryCarrier(
  dataTransfer: DataTransfer,
  surfaces: readonly PlaceableSurfaceAdmissionSurface[],
): boolean {
  return surfaces.some(hasAdmissionData) && hasDeferredCarrier(dataTransfer);
}

function chooseAdmissionSurface(
  surfaces: readonly PlaceableSurfaceAdmissionSurface[],
): PlaceableSurfaceAdmissionSurface | null {
  return surfaces.find(hasAdmissionData) ?? null;
}

/** Whether this arrangement has a screen that declares it can receive local files. */
export function canAdmitPlaceableSurfaceFiles(
  surfaces: readonly PlaceableSurfaceAdmissionSurface[],
): boolean {
  return chooseAdmissionSurface(surfaces) !== null;
}

/** Admit files from a picker as one tab input while keeping each File handle
 *  browser-local. The receiving file screen can show them together, then replace
 *  these transient handles with the stored file identities after upload. */
export function admitPlaceableSurfaceFiles(
  files: readonly File[],
  surfaces: readonly PlaceableSurfaceAdmissionSurface[],
): PlaceableSurfacePayload | null {
  const surface = chooseAdmissionSurface(surfaces);
  const chosen = files.filter((file) => file instanceof File);
  if (!surface || chosen.length === 0) return null;
  const refs: Array<PlaceableSurfaceSubjectRef & { name: string; content_type: string; byte_length: number }> = [];
  for (const file of chosen) {
    const item = fileItem(file);
    const subject = admitPlaceableSurfaceSubject({
      origin: { source: 'browser.local_files', items: [item] },
      display: { name: file.name, content_type: file.type || 'application/octet-stream', byte_length: file.size },
      content: { items: [item] },
      handle: file,
    });
    refs.push({ ...subject.ref, name: file.name, content_type: file.type || 'application/octet-stream', byte_length: file.size });
  }
  const title = chosen.length === 1 ? chosen[0].name : `${chosen.length} files`;
  return {
    version: 1,
    id: `${surface.id}:${refs[0].address}`,
    title,
    target: surface.target ?? null,
    packageEntry: surface.packageEntry ?? null,
    materialTarget: surface.materialTarget,
    icon: surface.icon,
    surfaceInput: {
      filePresentationSurfaceId: surface.id,
      subjectRefs: refs,
      frame_fit: 'fill',
    },
  };
}

function subjectRefSurfaceInput(subjectRef: PlaceableSurfaceSubjectRef): JsonRecord {
  // A dropped file opens a preview surface that should FIT its host pane (image
  // contained, pdf/video filling the box), never grow to the asset's native
  // pixels and force the page to scroll. `frame_fit: 'fill'` is the host's
  // generic, data-declared contract for "give me a definite height".
  return { subjectRef, frame_fit: 'fill' };
}

export function admitPlaceableSurfaceEntry(
  dataTransfer: DataTransfer,
  surfaces: readonly PlaceableSurfaceAdmissionSurface[],
): PlaceableSurfacePayload | null {
  const descriptor = readPlaceableSurfaceEntryDescriptor(dataTransfer);
  if (!descriptor) return null;

  const files = dataTransfer.files ? Array.from(dataTransfer.files) : [];
  if (files.length > 1) return admitPlaceableSurfaceFiles(files, surfaces);

  const surface = chooseAdmissionSurface(surfaces);
  if (!surface) return null;

  const subject = admitPlaceableSurfaceSubject({
    origin: {
      source: descriptor.source,
      items: descriptor.items,
    },
    display: {
      name: descriptor.title,
      content_type: readString(descriptor.items[0]?.content_type) ?? undefined,
      byte_length: typeof descriptor.items[0]?.byte_length === 'number'
        ? descriptor.items[0].byte_length
        : undefined,
    },
    content: {
      items: descriptor.items,
    },
    handle: descriptor.handle,
  });

  return {
    version: 1,
    id: `${surface.id}:${subject.ref.address}`,
    title: descriptor.title,
    target: surface.target ?? null,
    packageEntry: surface.packageEntry ?? null,
    materialTarget: surface.materialTarget,
    icon: surface.icon,
    surfaceInput: subjectRefSurfaceInput(subject.ref),
  };
}
