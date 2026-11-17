import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  buildCloudFileOperationPayload,
  requireCloudFileOperation,
  type CloudFileSource,
} from './read-cloud-file-sources';

export interface CloudFileEntry {
  id: string;
  path: string;
  name: string;
  isDir: boolean;
  size?: number;
  modifiedAt?: string;
  mimeType?: string;
}

const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return parseMaybeJson(textDecoder.decode(value));
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function decodeCloudFileReplyPayload(reply: unknown): unknown {
  if (!isRecord(reply)) return reply;
  return parseMaybeJson(reply.payload ?? reply);
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function decodeEntry(value: unknown): CloudFileEntry | null {
  if (!isRecord(value)) return null;
  const path = readText(value.path ?? value.full_path ?? value.fullPath);
  const id = readText(value.id ?? value.file_id ?? value.fileId) || path;
  const name = readText(value.name) || path.split('/').filter(Boolean).pop() || id;
  if (!id || !path) return null;
  const kind = readText(value.kind ?? value.type).toLowerCase();
  const isDir = value.isDir === true || value.is_dir === true || kind === 'dir' || kind === 'folder';
  return {
    id,
    path,
    name,
    isDir,
    size: readNumber(value.size),
    modifiedAt: readText(value.modified_at ?? value.modifiedAt) || undefined,
    mimeType: readText(value.mime_type ?? value.mimeType) || undefined,
  };
}

export function decodeCloudDirectoryEntries(payload: unknown): CloudFileEntry[] {
  const decoded = parseMaybeJson(payload);
  const entries = Array.isArray(decoded)
    ? decoded
    : isRecord(decoded) && Array.isArray(decoded.entries)
      ? decoded.entries
      : isRecord(decoded) && Array.isArray(decoded.items)
        ? decoded.items
        : [];

  return entries
    .map(decodeEntry)
    .filter((entry): entry is CloudFileEntry => !!entry)
    .sort((left, right) =>
      Number(right.isDir) - Number(left.isDir) ||
      left.name.localeCompare(right.name) ||
      left.path.localeCompare(right.path),
    );
}

export async function invokeCloudFileReadOperation(
  source: CloudFileSource,
  operationKey: 'list_directory' | 'read_file_bytes',
  input: Record<string, unknown>,
): Promise<unknown> {
  const route = requireCloudFileOperation(source, operationKey);

  const reply = await sendRequestToBitfieldTarget({
    target: route.target,
    payload: buildCloudFileOperationPayload(route, {
      source_id: source.id,
      service_connection_ref: source.serviceConnectionRef,
      credential_handle_ref: source.credentialHandle,
      connection_enabled: source.connectionEnabled,
      ...input,
    }, true),
  });

  return decodeCloudFileReplyPayload(reply);
}

export async function readCloudDirectory(
  source: CloudFileSource,
  path: string = source.rootPath,
): Promise<CloudFileEntry[]> {
  const payload = await invokeCloudFileReadOperation(source, 'list_directory', { path });
  return decodeCloudDirectoryEntries(payload);
}
