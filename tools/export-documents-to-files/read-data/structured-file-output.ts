// packages/structured-file-output/read-data/structured-file-output.ts
//
// Generic request and format descriptors for turning structured rows into files.

import packageData from '@/packages/structured-file-output/things-to-store-and-run.json';

export type StructuredFileOutputFormatId = 'pdf' | 'docx' | 'csv' | 'xlsx' | 'markdown' | 'txt';

export type StructuredFileOutputFormatDescriptor = {
  id: StructuredFileOutputFormatId;
  label: string;
  extension: string;
  mimeType: string;
};

export type StructuredFileOutputSection = {
  heading?: string;
  lines?: string[];
  rows?: string[][];
  blocks?: StructuredFileOutputBlock[];
};

export type StructuredFileOutputBlock =
  | { kind: 'heading'; text: string; level?: number }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; rows: string[][] };

export type StructuredFileOutputRequest = {
  kind: 'structured-file-output.request';
  requestId: string;
  title: string;
  fileStem: string;
  createdAt: string;
  formats: StructuredFileOutputFormatId[];
  sections: StructuredFileOutputSection[];
  source?: Record<string, unknown>;
};

export type StructuredFileOutputArtifactDescriptor = {
  id: string;
  requestId: string;
  formatId: StructuredFileOutputFormatId;
  fileName: string;
  mimeType: string;
  byteLength: number;
};

type PackageThing = {
  address?: string;
  payload?: unknown;
};

const DEFAULT_FORMATS: StructuredFileOutputFormatDescriptor[] = [
  { id: 'pdf', label: 'PDF', extension: 'pdf', mimeType: 'application/pdf' },
  { id: 'docx', label: 'Word', extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { id: 'csv', label: 'CSV', extension: 'csv', mimeType: 'text/csv;charset=utf-8' },
  { id: 'xlsx', label: 'Excel', extension: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { id: 'markdown', label: 'Markdown', extension: 'md', mimeType: 'text/markdown;charset=utf-8' },
  { id: 'txt', label: 'Plain Text', extension: 'txt', mimeType: 'text/plain;charset=utf-8' },
];

const FORMAT_IDS = new Set(DEFAULT_FORMATS.map((format) => format.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function formatId(value: unknown): StructuredFileOutputFormatId | null {
  return typeof value === 'string' && FORMAT_IDS.has(value as StructuredFileOutputFormatId)
    ? value as StructuredFileOutputFormatId
    : null;
}

function formatDescriptor(value: unknown): StructuredFileOutputFormatDescriptor | null {
  if (!isRecord(value)) return null;
  const id = formatId(value.id);
  if (!id) return null;
  const fallback = DEFAULT_FORMATS.find((format) => format.id === id);
  return {
    id,
    label: text(value.label, fallback?.label ?? id),
    extension: text(value.extension, fallback?.extension ?? id),
    mimeType: text(value.mime_type ?? value.mimeType, fallback?.mimeType ?? 'application/octet-stream'),
  };
}

export function safeStructuredFileStem(value: string, fallback = 'structured-file-output'): string {
  return (value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || fallback;
}

export function readStructuredFileOutputFormats(): StructuredFileOutputFormatDescriptor[] {
  const things = Array.isArray((packageData as { things?: PackageThing[] }).things)
    ? (packageData as { things: PackageThing[] }).things
    : [];
  const payload = things.find((thing) => thing.address === 'package::structured-file-output::formats')?.payload;
  const records = isRecord(payload) && Array.isArray(payload.formats) ? payload.formats : [];
  const formats = records.map(formatDescriptor).filter((format): format is StructuredFileOutputFormatDescriptor => !!format);
  return formats.length > 0 ? formats : DEFAULT_FORMATS;
}

export function structuredFileOutputFormatById(
  id: StructuredFileOutputFormatId,
  formats = readStructuredFileOutputFormats(),
): StructuredFileOutputFormatDescriptor | null {
  return formats.find((format) => format.id === id) ?? null;
}

export function structuredFileOutputFormatByExtension(
  extension: string | undefined,
  formats = readStructuredFileOutputFormats(),
): StructuredFileOutputFormatDescriptor | null {
  if (!extension) return null;
  return formats.find((format) => format.extension === extension) ?? null;
}

export function selectedStructuredFileOutputFormats(
  request: StructuredFileOutputRequest,
  formats = readStructuredFileOutputFormats(),
): StructuredFileOutputFormatDescriptor[] {
  return request.formats
    .map((id) => structuredFileOutputFormatById(id, formats))
    .filter((format): format is StructuredFileOutputFormatDescriptor => !!format);
}

export function structuredFileOutputArtifactId(
  requestId: string,
  formatId: StructuredFileOutputFormatId,
): string {
  return `structured-file-output:${safeStructuredFileStem(requestId, 'request')}:${formatId}`;
}
