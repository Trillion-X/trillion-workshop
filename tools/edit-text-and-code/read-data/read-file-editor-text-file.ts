import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  capturedProcessFdText,
  decodeProcessResultWireShape,
  processExitedCode,
} from '@bitfield/runtime-kit/protocol';

const COMPUTE_PROCESS_TARGET = 'compute.process';

function processResultPayload(reply: unknown): Uint8Array {
  if (!reply || typeof reply !== 'object') throw new Error('compute.process returned no envelope.');
  const payload = (reply as { payload?: unknown }).payload;
  if (!ArrayBuffer.isView(payload) || payload.constructor.name !== 'Uint8Array') {
    throw new Error('compute.process returned no byte payload.');
  }
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

export async function readFileEditorTextFile(path: string): Promise<string> {

  const reply = await sendRequestToBitfieldTarget({
    target: COMPUTE_PROCESS_TARGET,
    payload: {
      argv: ['cat', path],
      cwd: null,
      timeout_ms: 300_000,
      termination_grace_ms: 1_000,
      expected_termination: null,
      env: {},
      inputs: [],
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
    throw new Error(capturedProcessFdText(result, 2).trim() || `Failed to read file: ${path}`);
  }
  return capturedProcessFdText(result, 1);
}
