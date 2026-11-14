// packages/ai-instruction-blocks/do-work/materialize-harness-prompt-entry.ts
//
// THIN ENTRY for the `materialize-harness-prompt` package-target op. The runner
// dispatches a package-target op by reading its entry-bytes record
// (`package::ai-instruction-blocks::entry-bytes::materialize-harness-prompt`) and
// running this module's `materializeHarnessPrompt` export in a node subprocess
// (bitfield-runner/src/package_target_handlers.rs:130-148,499-516). The op is NOT
// executable from its `stored_bytes` source alone: without this entry-bytes
// record the dispatch throws FE_ADDRESS_NOT_FOUND.
//
// This file stays tiny and is the ONLY part that touches `@bitfield/runtime-kit`,
// so the pure core (`materialize-harness-prompt.mjs`) remains import-free and
// unit-testable under `node --test`. It injects the real engine sender and
// decodes read-current replies (so the op sees `contentHash`, the BLAKE3 CAS
// hash) before handing them to the pure `...WithSender` logic.
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
// eslint-disable-next-line import/extensions -- explicit .mjs keeps the pure core test-clean
import { bindServingPartition, materializeHarnessPromptWithSender } from './materialize-harness-prompt.mjs';

const READ_CURRENT_OPERATION = 'engine.operation.read-current';
const replyDecoder = new TextDecoder();

/**
 * Package-target entry (export_name matches the descriptor + entry records).
 * The runner calls `materializeHarnessPrompt(input, context)`; the trusted runtime
 * context supplies the serving partition label before the prompt is written/read.
 */
export async function materializeHarnessPrompt(input: unknown, context: unknown): Promise<unknown> {
  const send = async (request: any): Promise<any> => {
    const raw = await sendRequestToBitfieldTarget(request);
    // All three owner calls used by this entry return JSON bodies. Decode the
    // package-target sender's Uint8Array wrapper once so the pure core receives
    // ordinary objects for group.load-graph, find-current-items, and read-current.
    const replyBytes =
      raw && (raw as any).payload instanceof Uint8Array
        ? (raw as any).payload
        : raw instanceof Uint8Array
          ? raw
          : null;
    if (replyBytes) {
      try {
        return JSON.parse(replyDecoder.decode(replyBytes));
      } catch {
        return request?.payload?.operation_label === READ_CURRENT_OPERATION ? {} : raw;
      }
    }
    return raw;
  };
  return materializeHarnessPromptWithSender(bindServingPartition(input, context), send);
}
