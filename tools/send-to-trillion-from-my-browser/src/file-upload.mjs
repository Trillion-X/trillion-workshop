// The browser-side client for the Namespace's addressed, resumable file write.
// It transports only source bytes and an opaque upload token; the Namespace
// computes and returns the file identity after verifying the complete upload.

export const FILE_UPLOAD_PIECE_BYTES = 32_768;
export const FILE_UPLOAD_MCP_MAX_BYTES = 65_536;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const uploadId = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const identity = value => typeof value === 'string' && /^1f:[0-9a-f]{64}$/.test(value);

function invalid(message, upload_id = null) {
  const error = new Error(message);
  error.name = 'FileUploadError';
  if (upload_id) error.upload_id = upload_id;
  return error;
}

export function validUploadName(name) {
  if (typeof name !== 'string' || !name.startsWith('/') || name === '/' || new TextEncoder().encode(name).byteLength > 2048
      || name.endsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) return false;
  return name.split('/').slice(1).every(segment => segment && segment !== '.' && segment !== '..');
}

export function absoluteUploadName(name) {
  if (typeof name !== 'string' || !name.trim()) throw invalid('Name the file to keep.');
  const path = name.startsWith('/') ? name : `/${name}`;
  if (!validUploadName(path)) throw invalid('The file name must be an absolute path inside your files.');
  return path;
}

function makeUploadId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function sourceFor({ bytes, blob }) {
  if (blob !== null && blob !== undefined) {
    if (!Number.isSafeInteger(blob.size) || blob.size <= 0 || typeof blob.slice !== 'function') throw invalid('This file has no bytes to keep.');
    return { size: blob.size, readAt: async (offset, count) => new Uint8Array(await blob.slice(offset, offset + count).arrayBuffer()) };
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength <= 0) throw invalid('This file has no bytes to keep.');
  return { size: bytes.byteLength, readAt: async (offset, count) => bytes.subarray(offset, offset + count) };
}

function bytesBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + 8192)));
  }
  return btoa(binary);
}

function validOffset(value, byteLength) {
  return safeInteger(value) && value <= byteLength
    && (value === byteLength || value % FILE_UPLOAD_PIECE_BYTES === 0);
}

function requireReceipt(answer, upload_id) {
  if (!object(answer) || answer.upload_id !== upload_id) throw invalid('The Namespace returned an invalid upload receipt.', upload_id);
  return answer;
}

async function invoke(operation, method, input, context, requestKey) {
  const answer = await operation(method, input, { context, requestKey, replayTransportOnce: true });
  if (!object(answer)) throw invalid('The Namespace did not confirm this upload.');
  return answer;
}

/** Upload a Blob or Uint8Array through start, sequential 32 KiB pieces and finish. */
export async function uploadFile({ bytes = null, blob = null, name, mediaType = 'application/octet-stream', app = undefined,
  upload_id = undefined, context = null, operation }) {
  if (typeof operation !== 'function') throw new TypeError('A Namespace operation is required.');
  const path = absoluteUploadName(name);
  if (typeof mediaType !== 'string' || new TextEncoder().encode(mediaType).byteLength > 256 || /[\u0000-\u001f\u007f]/.test(mediaType)) throw invalid('The file type is invalid.');
  if (app !== undefined && (typeof app !== 'string' || !app || new TextEncoder().encode(app).byteLength > 256 || /[\u0000-\u001f\u007f]/.test(app))) throw invalid('The file source is invalid.');
  const source = sourceFor({ bytes, blob });
  const token = upload_id ?? makeUploadId();
  if (!uploadId(token)) throw invalid('The upload token is invalid.', typeof token === 'string' ? token : null);
  const base = { upload_id: token, name: path, byte_length: source.size, media_type: mediaType, ...(app === undefined ? {} : { app }) };
  try {
    const started = requireReceipt(await invoke(operation, 'write_file_start', base, context, crypto.randomUUID()), token);
    if (started.state === 'finished') {
      if (started.name !== path || started.byte_length !== source.size || !identity(started.identity)) throw invalid('The Namespace returned an invalid finished-file receipt.', token);
      return started.identity;
    }
    if (started.state === 'cancelled') {
      if (started.byte_length !== source.size || started.bytes_retained !== true) throw invalid('The Namespace returned an invalid cancelled-file receipt.', token);
      throw invalid('This file upload was cancelled. Its uploaded bytes remain available for recovery.', token);
    }
    if (started.state !== 'open' || started.byte_length !== source.size || !validOffset(started.next_offset, source.size)) {
      throw invalid('The Namespace returned an invalid upload position.', token);
    }

    let offset = started.next_offset;
    while (offset < source.size) {
      const count = Math.min(FILE_UPLOAD_PIECE_BYTES, source.size - offset);
      const bytes = await source.readAt(offset, count);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== count) throw invalid('The file changed while it was being read.', token);
      const input = { upload_id: token, name: path, offset, content_base64: bytesBase64(bytes) };
      const piece = requireReceipt(await invoke(operation, 'write_file_piece', input, context, crypto.randomUUID()), token);
      const next = piece.next_offset;
      if (!safeInteger(piece.accepted_bytes) || piece.accepted_bytes !== count || typeof piece.already_received !== 'boolean'
          || !validOffset(next, source.size) || next < offset + count || (!piece.already_received && next !== offset + count)) {
        throw invalid('The Namespace returned an invalid piece receipt.', token);
      }
      offset = next;
    }

    const finished = requireReceipt(await invoke(operation, 'write_file_finish', { upload_id: token, name: path }, context, crypto.randomUUID()), token);
    if (finished.state !== 'finished' || finished.name !== path || finished.byte_length !== source.size || !identity(finished.identity)) {
      throw invalid('The Namespace did not confirm this file was saved.', token);
    }
    return finished.identity;
  } catch (error) {
    if (error && typeof error === 'object' && !('upload_id' in error)) error.upload_id = token;
    throw error;
  }
}

/** Cancel an open upload without deleting its already accepted bytes. */
export async function cancelFileUpload({ upload_id, name, byte_length = undefined, context = null, operation }) {
  if (!uploadId(upload_id) || !validUploadName(name) || typeof operation !== 'function') throw invalid('Name a valid upload and file.');
  const answer = requireReceipt(await invoke(operation, 'write_file_cancel', { upload_id, name }, context, crypto.randomUUID()), upload_id);
  if (answer.state !== 'cancelled' || answer.bytes_retained !== true || !safeInteger(answer.byte_length) || answer.byte_length <= 0
      || byte_length !== undefined && answer.byte_length !== byte_length) throw invalid('The Namespace returned an invalid cancellation receipt.', upload_id);
  return answer;
}

