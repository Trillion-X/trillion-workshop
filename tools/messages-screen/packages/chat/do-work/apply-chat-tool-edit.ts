import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  capturedProcessFdText,
  decodeProcessResultWireShape,
  processExitedCode,
} from '@bitfield/runtime-kit/protocol';
import chatRecordsContract from '../../../../chat/things-to-store-and-run.json';
import { readConfiguredTimedTarget } from '../../../../process-session/read-data/read-process-session-launch';

const CHAT_TOOL_EDIT_APPLY_ROUTE = readConfiguredTimedTarget(chatRecordsContract, 'tool-edit-apply');
const WRITE_INPUT_MOUNT = 'content.txt';

function processResultPayload(reply: unknown): Uint8Array {
  if (!reply || typeof reply !== 'object') throw new Error('compute.process returned no envelope.');
  const payload = (reply as { payload?: unknown }).payload;
  if (!ArrayBuffer.isView(payload) || payload.constructor.name !== 'Uint8Array') {
    throw new Error('compute.process returned no byte payload.');
  }
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

export async function applyChatToolEdit(filePath: string, newContent: string): Promise<void> {

  const reply = await sendRequestToBitfieldTarget({
    target: CHAT_TOOL_EDIT_APPLY_ROUTE.target,
    payload: {
      argv: [
        'sh',
        '-lc',
        'mkdir -p "$(dirname "$2")" && cp "$1" "$2"',
        '--',
        WRITE_INPUT_MOUNT,
        filePath,
      ],
      cwd: null,
      timeout_ms: CHAT_TOOL_EDIT_APPLY_ROUTE.timeoutMs,
      termination_grace_ms: 1_000,
      expected_termination: null,
      env: {},
      inputs: [
        {
          mount_path: WRITE_INPUT_MOUNT,
          source: {
            kind: 'inline',
            bytes: Array.from(new TextEncoder().encode(newContent)),
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
    throw new Error(
      capturedProcessFdText(result, 2).trim() || `Failed to write file: ${filePath}`,
    );
  }
}
