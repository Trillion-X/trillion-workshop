// PORTED FROM: bitfield-packages/packages/chat/read-data/read-agent-profile-participants.ts @ e99ac5976
// packages/chat/read-data/read-agent-profile-participants.ts
//
// PURPOSE
// Project configured AGENT PROFILES (ai-agent-profile published records) into the
// picker's AddressedParticipantInfo shape, so the chat composer can select an
// AGENT (which carries its instruction_refs + tool_refs + bound model), not only
// a bare CLI/model row. Selecting an agent participant writes the selected-agent
// SSOT with the PROFILE id (set-selected-agent.ts, unchanged); the producer
// already hydrates that profile's instruction_refs into the system prompt, so the
// next turn is harness-governed. The model is the sub-choice UNDER the agent (the
// L063 category fix: picking a model must never strip the agent identity).
//
// This is a PURE projection of shared DATA (ai-agent-profile records). It owns no
// profile catalog, hardcodes no profile/model ids, and adds no code per new agent.
// A new agent profile appears in the picker with zero chat code. It decodes the
// addressed feed itself (the established read-cli-registry-participants pattern),
// so it never imports another package's read-data (no cross-package coupling).
//
// NON-NEGOTIABLE INVARIANTS
//   - Pure decode only (no React, no writes). Mirrors read-cli-registry-participants.
//   - Zero hardcoded profile/model/provider names (L090 self-describing rows).
//   - Produces the existing AddressedParticipantInfo type so every downstream
//     consumer (picker, marks, submit) is unchanged.

import type {
  AddressedParticipantInfo,
  AddressedParticipantModelOption,
} from './read-addressed-exchange-participants';
import { currentAvailableModelRefs } from './current-model-availability';

interface AgentProfilePayload {
  kind?: unknown;
  id?: unknown;
  label?: unknown;
  model_refs?: unknown;
  model_provider_refs?: unknown;
  instruction_refs?: unknown;
  tool_refs?: unknown;
  department?: unknown;
  role?: unknown;
  send_target?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

// Present a bare profile/model ref as a human label when the row carries no label.
// The leading reference namespace is stripped and `:`/`-`/`_`
// are treated as word boundaries so internal vocabulary never surfaces to the user
// (L114/L118), even for a future profile that ships without a label.
function humanizeRef(ref: string): string {
  return (
    ref
      .replace(/^[^:]+:/, '')
      .split(/[-_\s:]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || ref
  );
}

function toModelOptions(modelRefs: readonly string[]): AddressedParticipantModelOption[] {
  return modelRefs.map((ref, index) => ({
    id: ref,
    label: humanizeRef(ref),
    ...(index === 0 ? { isDefault: true } : {}),
  }));
}

// How a participant is reached is the participant's own DATA. A profile that
// declares `send_target` is reached that way; one that declares none keeps the
// request/reply producer it has always used. Nothing here knows the name of any
// route, so a profile can be pointed at a different one without touching code,
// and a route that exists in one app and not another is a DATA difference
// rather than a build difference.
function routeForProfile(payload: AgentProfilePayload, id: string) {
  const shared = {
    requiresAuth: false,
    sourceAdapterRef: id,
    capabilityRefs: [], routeRefs: [], setupRouteRefs: [], connectionStateRefs: [],
    ingestionRouteRefs: [], resultProjectionRefs: [], streamParseSpecRefs: [],
    proofRefs: [], blockerRefs: [], serviceConnectionRefs: [], credentialHandleRefs: [],
    permissionRef: null, guardRef: null, statusRef: null,
    metadata: {}, streamParseSpec: null,
  };
  const sendTarget = asRecord(payload.send_target);
  const target = sendTarget && asString(sendTarget.target);
  const payloadTemplate = sendTarget && asRecord(sendTarget.payload_template);
  if (target && payloadTemplate) {
    return {
      ...shared,
      kind: 'addressed-exchange' as const,
      ownerTargetRef: target,
      payload: { dispatch: { target, payload_template: payloadTemplate } },
    };
  }
  return { ...shared, kind: 'ai-records-producer' as const, ownerTargetRef: 'slot::workflow', payload: {} };
}

function participantFromProfile(payload: AgentProfilePayload): AddressedParticipantInfo | null {
  const id = asString(payload.id);
  if (!id) return null;
  const instructionRefs = stringList(payload.instruction_refs);
  const toolRefs = stringList(payload.tool_refs);
  const modelRefs = stringList(payload.model_refs);
  // A profile is a chattable AGENT only if it carries an identity to govern the
  // turn (instructions, tools, or a bound model). A bare record with none is not
  // a sendable agent. Self-describing discriminant (L090), never a hardcoded id.
  const isSendableAgent = instructionRefs.length > 0 || toolRefs.length > 0 || modelRefs.length > 0;
  if (!isSendableAgent) return null;
  const label = asString(payload.label) ?? humanizeRef(id);
  return {
    participantRef: id,
    wayToReachRef: `${id}-way`,
    label,
    version: '',
    accounts: [],
    models: toModelOptions(modelRefs),
    adapter: routeForProfile(payload, id),
    routeRefs: [],
    setupRouteRefs: [],
    connectionStateRefs: [],
    ingestionRouteRefs: [],
    resultProjectionRefs: [],
    streamParseSpecRefs: [],
    proofRefs: [],
    blockerRefs: [],
    routeDescriptors: [],
    connectionStates: [],
    badgeColor: null,
    providerRefs: [],
    capabilityRefs: [],
    serviceConnectionRefs: [],
    credentialHandleRefs: [],
    requiresAuth: false,
    permissionRef: null,
    guardRef: null,
    statusRef: null,
    metadata: { brandLabel: 'Your agents', participantKind: 'agent-profile', configuredModelRefs: modelRefs },
    displayMark: { iconName: null, logoUrl: null, text: null, background: null, foreground: null, border: null },
  };
}

export type AgentProfileParticipantRecord = { payload?: unknown };

/**
 * Presentation identity is not execution transport identity. Human-facing agent
 * catalogs project profiles only; provider processes remain routing-only even
 * while profile DATA is empty or loading.
 */
export function chooseAgentPresentationParticipants(
  _cliParticipants: readonly AddressedParticipantInfo[],
  profileParticipants: readonly AddressedParticipantInfo[],
): readonly AddressedParticipantInfo[] {
  return profileParticipants;
}

// Decode the ai-agent-profile published-record feed into picker participants. One
// participant per `kind:'ai-agent-profile'` record that declares an identity
// (instructions/tools/model). Pure decode; no owner import.
export function decodeAgentProfileParticipants(raw: unknown, availability?: { descriptors?: unknown }): AddressedParticipantInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: AddressedParticipantInfo[] = [];
  const seen = new Set<string>();
  for (const entry of raw as AgentProfileParticipantRecord[]) {
    const payload =
      entry && typeof entry === 'object' && 'payload' in entry ? (entry as AgentProfileParticipantRecord).payload : entry;
    if (!payload || typeof payload !== 'object' || (payload as AgentProfilePayload).kind !== 'ai-agent-profile') continue;
    const participant = participantFromProfile(payload as AgentProfilePayload);
    if (!participant || seen.has(participant.participantRef)) continue;
    if (availability) {
      const declaredRefs = new Set(participant.models.map(model => model.id));
      const available = new Set(currentAvailableModelRefs(availability.descriptors));
      participant.models = toModelOptions([...declaredRefs].filter(ref => available.has(ref)));
    }
    seen.add(participant.participantRef);
    out.push(participant);
  }
  return out;
}
