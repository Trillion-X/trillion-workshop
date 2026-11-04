//
// Typed browser adapter for the native device-files capability. Device paths
// never cross the contained compute.process boundary.

import { sendRequestToBitfieldTarget } from '#workspace-records';

const LOCAL_FILES_TARGET = 'local.files';

export interface LocalFilesTargetEntry {
  path: string;
  name: string;
  is_dir: boolean;
  relative_path?: string;
  modified_unix_nanos?: number;
}

export interface LocalFilesTargetFile {
  path: string;
  name: string;
  byte_length: number;
  content_type: string;
  bytes_base64?: string;
  relative_path?: string;
  modified_unix_nanos?: number;
  file_state?: string;
}

export interface LocalFilesTargetReply {
  success: boolean;
  operation: string;
  cancelled?: boolean;
  home?: string;
  roots?: string[];
  entries?: LocalFilesTargetEntry[];
  files?: LocalFilesTargetFile[];
  path?: string;
  error?: string;
  file_states?: Record<string, string>;
}

function decodePayload(reply: unknown): LocalFilesTargetReply {
  if (!reply || typeof reply !== 'object') {
    throw new Error('local.files returned no envelope.');
  }
  const payload = (reply as { payload?: unknown }).payload;
  if (!ArrayBuffer.isView(payload)) {
    throw new Error('local.files returned no byte payload.');
  }
  const bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  const decoded = JSON.parse(new TextDecoder().decode(bytes)) as LocalFilesTargetReply;
  if (decoded.success !== true) {
    throw new Error(decoded.error || `local.files ${decoded.operation || 'request'} failed.`);
  }
  return decoded;
}

export async function invokeLocalFilesTarget(
  payload: Record<string, unknown>,
  sender: (request: { target: string; payload: Record<string, unknown> }) => Promise<unknown> = sendRequestToBitfieldTarget,
): Promise<LocalFilesTargetReply> {
  const reply = await sender({
    target: LOCAL_FILES_TARGET,
    payload,
  });
  return decodePayload(reply);
}
