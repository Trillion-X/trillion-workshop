import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  capturedProcessFdText,
  decodeProcessResultWireShape,
  processExitedCode,
} from '@bitfield/runtime-kit/protocol';

const COMPUTE_PROCESS_TARGET = 'compute.process';
const WRITE_CONTENT_MOUNT_PATH = 'content.txt';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function processResultPayload(reply: unknown): Uint8Array {
  if (!reply || typeof reply !== 'object') throw new Error('compute.process returned no envelope.');
  const payload = (reply as { payload?: unknown }).payload;
  if (!ArrayBuffer.isView(payload) || payload.constructor.name !== 'Uint8Array') {
    throw new Error('compute.process returned no byte payload.');
  }
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

export async function writeFileEditorTextFile(path: string, content: string): Promise<void> {
  const contentBytes = new TextEncoder().encode(content);

  const reply = await sendRequestToBitfieldTarget({
    target: COMPUTE_PROCESS_TARGET,
    payload: {
      argv: [
        'sh',
        '-lc',
        'mkdir -p "$(dirname "$2")" && cp "$1" "$2"',
        '--',
        WRITE_CONTENT_MOUNT_PATH,
        path,
      ],
      cwd: null,
      timeout_ms: 300_000,
      termination_grace_ms: 1_000,
      expected_termination: null,
      env: {},
      inputs: [
        {
          mount_path: WRITE_CONTENT_MOUNT_PATH,
          source: {
            kind: 'inline',
            bytes: bytesToBase64(contentBytes),
          },
          content_type: 'text/plain',
        },
      ],
      input_trees: [],
      outputs: [],
      containment: {
        kind: 'descendant_effect_contained',
        pipe_eof_timeout_ms: 1_000,
        publications: [],
      },
      capture_fds: [1, 2],
      collected_files: [],
    },
  });

  const result = decodeProcessResultWireShape(processResultPayload(reply));
  if (processExitedCode(result) !== 0) {
    throw new Error(capturedProcessFdText(result, 2).trim() || `Failed to write file: ${path}`);
  }
}
