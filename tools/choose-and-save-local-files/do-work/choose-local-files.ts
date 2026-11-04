//
// Opens the native operating-system file picker and returns selected file
// metadata/bytes for package surfaces that need upload-style inputs.

import {
  invokeLocalFilesTarget,
  type LocalFilesTargetFile,
} from '../read-data/invoke-local-files-target';

const DEFAULT_PICKER_PROMPT = 'Choose files';

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  aac: 'audio/aac',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'video/webm',
};

export interface ChooseLocalFilesOptions {
  prompt?: string;
  multiple?: boolean;
  includeBytes?: boolean;
  allowedContentPrefixes?: string[];
  allowedExtensions?: string[];
}

export interface LocalChosenFile {
  path: string;
  name: string;
  byteLength: number;
  contentType: string;
  bytes?: Uint8Array;
}

function extensionFor(name: string): string {
  const lastDot = name.lastIndexOf('.');
  return lastDot >= 0 ? name.slice(lastDot + 1).toLowerCase() : '';
}

function inferContentType(name: string, contentType: string): string {
  if (contentType && contentType !== 'application/octet-stream') return contentType;
  return CONTENT_TYPE_BY_EXTENSION[extensionFor(name)] ?? contentType ?? 'application/octet-stream';
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeLocalFilePayload(payload: LocalFilesTargetFile): LocalChosenFile {
  const contentType = inferContentType(payload.name, payload.content_type);
  return {
    path: payload.path,
    name: payload.name,
    byteLength: payload.byte_length,
    contentType,
    ...(payload.bytes_base64 ? { bytes: decodeBase64Bytes(payload.bytes_base64) } : {}),
  };
}

export async function readLocalFile(path: string, options: Pick<ChooseLocalFilesOptions, 'includeBytes'> = {}): Promise<LocalChosenFile> {
  const result = await invokeLocalFilesTarget({
    operation: 'read_file',
    path,
    include_bytes: options.includeBytes !== false,
  });
  const file = result.files?.[0];
  if (!file) throw new Error(`local.files returned no file for ${path}.`);
  return decodeLocalFilePayload(file);
}

function allowedExtensions(options: ChooseLocalFilesOptions): Set<string> {
  return new Set((options.allowedExtensions ?? []).map((extension) => extension.replace(/^\./, '').toLowerCase()));
}

function isAllowedFile(file: LocalChosenFile, options: ChooseLocalFilesOptions): boolean {
  const extensions = allowedExtensions(options);
  const prefixes = options.allowedContentPrefixes ?? [];
  if (extensions.size === 0 && prefixes.length === 0) return true;

  const extension = extensionFor(file.name);
  if (extensions.has(extension)) return true;
  return prefixes.some((prefix) => file.contentType.startsWith(prefix));
}

export async function chooseLocalFiles(options: ChooseLocalFilesOptions = {}): Promise<LocalChosenFile[]> {
  const result = await invokeLocalFilesTarget({
    operation: 'choose_files',
    prompt: options.prompt ?? DEFAULT_PICKER_PROMPT,
    multiple: options.multiple !== false,
    include_bytes: options.includeBytes !== false,
  });
  if (result.cancelled) return [];
  const files: LocalChosenFile[] = [];

  for (const payload of result.files ?? []) {
    const file = decodeLocalFilePayload(payload);
    if (!isAllowedFile(file, options)) {
      throw new Error(`Selected file is not an accepted type: ${file.name} (${file.contentType})`);
    }
    files.push(file);
  }

  return files;
}
