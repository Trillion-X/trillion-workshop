import { invokeLocalFilesTarget } from '../read-data/invoke-local-files-target.ts';

/** Save a new copy through the device-files owner and verify its exact bytes.
 * write_new_file publishes synced bytes atomically without replacing an existing
 * file. A failed write/readback is never reported as delivery; staged bytes stay
 * with the native owner for recovery. */
export async function saveLocalFileCopy(input: {
  fileName: string;
  bytes: Uint8Array;
  directory?: string;
  copyId: string;
}, invoke: typeof invokeLocalFilesTarget = invokeLocalFilesTarget): Promise<string> {
  if (input.bytes.byteLength > 16 * 1024 * 1024) throw new Error('This file is too large to save here.');
  if (!input.fileName || /[/\\\u0000-\u001f]/.test(input.fileName)
    || input.fileName === '.' || input.fileName === '..' || !/^[a-zA-Z0-9-]+$/.test(input.copyId)) {
    throw new Error('Choose a valid file name.');
  }
  const home = input.directory ? undefined : (await invoke({ operation: 'roots' })).home;
  const directory = input.directory ?? (home ? `${home}/Downloads` : '');
  if (!directory.startsWith('/') || directory.split('/').includes('..')) throw new Error('Choose a full folder path.');
  const dot = input.fileName.lastIndexOf('.');
  const stem = dot > 0 ? input.fileName.slice(0, dot) : input.fileName;
  const ext = dot > 0 ? input.fileName.slice(dot) : '';
  const path = `${directory.replace(/\/$/, '')}/${stem}-${input.copyId}${ext}`;
  let binary = '';
  for (const byte of input.bytes) binary += String.fromCharCode(byte);
  const content = btoa(binary);
  const saved = await invoke({ operation: 'write_new_file', path, content_base64: content });
  if (saved.operation !== 'write_new_file' || saved.path !== path) throw new Error('File saving has not been confirmed.');
  const readback = await invoke({ operation: 'read_file', path, include_bytes: true });
  const file = readback.files?.find((file) => file.path === path);
  if (readback.operation !== 'read_file' || file?.byte_length !== input.bytes.byteLength || file.bytes_base64 !== content) {
    throw new Error('The saved file could not be verified.');
  }
  return path;
}
