// PORTED FROM: bitfield-packages/packages/chat/do-work/materialize-addressed-exchange.ts @ e99ac5976
import {
  buildLiveChatPrompt,
  parsePromptAssemblyPayload,
  type PromptHistoryMessage,
  type PromptAssemblyDescriptor,
} from './build-live-chat-prompt';
import type { ChatSelectedTextForNextAgentRequest } from '../read-data/read-selected-text-for-next-agent-request';
import type { AddressedContextGrant } from '../read-data/read-addressed-exchange';
import type { DiscoveredCapability } from './discover-capabilities';

export interface AddressedExchangeMaterializationInput {
  userText: string;
  presetPrompt?: string | null;
  selection?: ChatSelectedTextForNextAgentRequest | null;
  visibleMessages: readonly PromptHistoryMessage[];
  includeVisibleHistory: boolean;
  discoveredCapabilities?: readonly DiscoveredCapability[];
  contextGrants?: readonly AddressedContextGrant[];
  promptAssembly?: PromptAssemblyDescriptor | null;
}

export interface AddressedExchangeMaterialization {
  prompt: string;
  resumeSourceSession: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPromptAssemblyDescriptor(records: unknown): PromptAssemblyDescriptor | null {
  if (!isRecord(records) || !Array.isArray(records.things)) return null;
  for (const thing of records.things) {
    if (!isRecord(thing) || thing.address !== 'package::chat::prompt-assembly::default') continue;
    // One shared parser for bundled and live descriptors; the active shape is
    // discovery/result/transition refs plus history policy only.
    return parsePromptAssemblyPayload(thing.payload);
  }
  return null;
}

// The part's own records (240 KB) are read only when no live prompt assembly was published, and fetched only then.
let bundledAssembly: Promise<PromptAssemblyDescriptor | null> | null = null;
const readBundledAssembly = () => (bundledAssembly ??= import('../things-to-store-and-run.json').then(module => readPromptAssemblyDescriptor(module.default)));

export async function materializeAddressedExchange(input: AddressedExchangeMaterializationInput): Promise<AddressedExchangeMaterialization> {
  const promptAssembly = input.promptAssembly ?? await readBundledAssembly();
  return {
    prompt: buildLiveChatPrompt({
      userText: input.userText,
      presetPrompt: input.presetPrompt,
      selection: input.selection,
      historyMessages: input.includeVisibleHistory ? input.visibleMessages : [],
      contextGrants: input.contextGrants,
      discoveredCapabilities: input.discoveredCapabilities,
      promptAssembly,
    }),
    resumeSourceSession: !input.includeVisibleHistory,
  };
}
