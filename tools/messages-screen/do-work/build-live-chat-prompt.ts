// PORTED FROM: bitfield-packages/packages/chat/do-work/build-live-chat-prompt.ts @ e99ac5976
import type { ChatSelectedTextForNextAgentRequest } from '../read-data/read-selected-text-for-next-agent-request';
import type { AddressedContextGrant } from '../read-data/read-addressed-exchange';
import type { DiscoveredCapability } from './discover-capabilities';

export interface PromptHistoryWindowDescriptor { messageLimit?: number; characterLimit?: number; }
export interface PromptAssemblyDescriptor {
  historyWindow?: PromptHistoryWindowDescriptor | null;
  discoveryActionRef?: string;
  resultPolicyRef?: string;
  transitionDescriptorRef?: string;
}
export interface PromptHistoryMessage { role?: 'human' | 'assistant' | string; content: string; }
export interface BuildLiveChatPromptInput {
  userText: string; presetPrompt?: string | null; selection?: ChatSelectedTextForNextAgentRequest | null;
  historyMessages?: readonly PromptHistoryMessage[]; discoveredCapabilities?: readonly DiscoveredCapability[];
  contextGrants?: readonly AddressedContextGrant[]; promptAssembly?: PromptAssemblyDescriptor | null;
}
const positive = (v: unknown): number | null => typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
function history(messages: readonly PromptHistoryMessage[] | undefined, window: PromptHistoryWindowDescriptor | null | undefined): string | null {
  if (!messages?.length) return null;
  let used = 0; const cap = positive(window?.characterLimit) ?? Infinity;
  const rows = messages.slice(-(positive(window?.messageLimit) ?? messages.length)).flatMap((m) => {
    const content = m.content.trim().slice(0, Math.max(0, cap - used)); used += content.length;
    return content ? [`${m.role === 'human' ? 'Human' : 'Assistant'}:\n${content}`] : [];
  });
  return rows.length ? `--- Addressed Exchange Context ---\n${rows.join('\n')}\n--- End Addressed Exchange Context ---` : null;
}
function discovery(descriptor: PromptAssemblyDescriptor | null | undefined, capabilities: readonly DiscoveredCapability[] | undefined): string {
  const tools = (capabilities ?? []).map((c) => ({
    capabilityRef: { canonicalAddress: c.canonical_address, canonicalRevision: c.canonical_revision, payloadHash: c.payload_hash },
    title: c.title ?? c.canonical_address, description: c.description ?? '', inputSchema: c.input_schema,
  }));
  return [
    '--- Capability Discovery ---',
    'Use the discovery tool first when no listed capability fits. Its model-visible input is exactly {"query":"..."}.',
    'Discovery block shape: ```bitfield-capability-discovery {"query":"..."} ```.',
    'To invoke a listed capability, emit exactly one fenced JSON block:',
    '```bitfield-work-request',
    '{"capabilityRef":{"canonicalAddress":"...","canonicalRevision":"...","payloadHash":"..."},"input":{},"correlationId":"optional","proofRefs":[]}',
    '```',
    'A capabilityRef is valid only for this turn and this round. Never substitute an action ID or alter any member of the triple.',
    ...(descriptor?.discoveryActionRef ? [`Discovery action ref: ${descriptor.discoveryActionRef}`] : []),
    `Discovered capabilities: ${JSON.stringify(tools)}`,
    '--- End Capability Discovery ---',
  ].join('\n');
}
function grants(value: readonly AddressedContextGrant[] | undefined): string | null {
  return value?.length ? `--- Allowed Addressed Context ---\n${JSON.stringify(value)}\n--- End Allowed Addressed Context ---` : null;
}
export function buildLiveChatPrompt(input: BuildLiveChatPromptInput): string {
  return [history(input.historyMessages, input.promptAssembly?.historyWindow), grants(input.contextGrants), discovery(input.promptAssembly, input.discoveredCapabilities), input.presetPrompt?.trim(), input.userText.trim()].filter(Boolean).join('\n\n');
}
/** Legacy catalog keys are hostile migration inputs: never parse or project them. */
export function parsePromptAssemblyPayload(payload: unknown): PromptAssemblyDescriptor | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const allowed = new Set(['kind', 'history_window', 'discovery_action_ref', 'result_policy_ref', 'transition_descriptor_ref']);
  if (Object.keys(p).some((key) => !allowed.has(key))) return null;
  if ('kind' in p && p.kind !== 'addressed-exchange.prompt-assembly') return null;
  const historyWindow = p.history_window;
  const h = historyWindow && typeof historyWindow === 'object' && !Array.isArray(historyWindow) ? historyWindow as Record<string, unknown> : null;
  return {
    ...(h ? { historyWindow: { ...(positive(h.message_limit) ? { messageLimit: positive(h.message_limit)! } : {}), ...(positive(h.character_limit) ? { characterLimit: positive(h.character_limit)! } : {}) } } : {}),
    ...(typeof p.discovery_action_ref === 'string' ? { discoveryActionRef: p.discovery_action_ref } : {}),
    ...(typeof p.result_policy_ref === 'string' ? { resultPolicyRef: p.result_policy_ref } : {}),
    ...(typeof p.transition_descriptor_ref === 'string' ? { transitionDescriptorRef: p.transition_descriptor_ref } : {}),
  };
}
