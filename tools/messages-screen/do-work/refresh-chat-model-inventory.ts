// PORTED FROM: bitfield-packages/packages/chat/do-work/refresh-chat-model-inventory.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';

/** Dispatch the open provider-descriptor broker. No provider, runtime, or model inference lives here. */
export async function refreshChatModelInventory(): Promise<unknown> {
  const reply = await sendRequestToBitfieldTarget({ target: 'ai-cli-launch-adapters.discover-declared-ai-providers', payload: {} });
  const result = JSON.parse(new TextDecoder().decode(reply.payload));
  if (result.kind !== 'ai-provider-discovery-run' || !Array.isArray(result.results)) {
    throw new Error('AI availability could not be checked');
  }
  return result;
}
