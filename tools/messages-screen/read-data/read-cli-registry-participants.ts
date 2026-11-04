// PORTED FROM: bitfield-packages/packages/chat/read-data/read-cli-registry-participants.ts @ e99ac5976
// packages/chat/read-data/read-cli-registry-participants.ts
//
// PURPOSE
// Project the canonical `cli-registry` substrate into the picker's
// AddressedParticipantInfo shape. The chat model picker's OPTIONS come from
// cli-registry (the SSOT every AI runner resolves from), NOT a chat-owned
// participant registry that re-declares codex/claude/gemini/hermes (L030 — the
// owner flagged the duplicate). Selecting a row writes the selected-agent SSOT
// (set-selected-agent.ts); the producer resolves selected-agent → cli, so the
// chosen model replies.
//
// This is a PURE projection of shared DATA (cli_registry attribute_facts) — it
// owns no model catalog, declares no provider/model names, and adds no code per
// new CLI. A new CLI in cli-registry appears in the picker with zero chat code.
//
// NON-NEGOTIABLE INVARIANTS
//   - Pure decode only (no React, no writes). Mirrors terminal/read-cli-registry.
//   - Zero hardcoded provider/model/cli names (L090 self-describing rows).
//   - Produces the existing AddressedParticipantInfo type so every downstream
//     consumer (UnifiedAgentPicker, ParticipantBrowser, marks) is unchanged.

import type {
  AddressedParticipantInfo,
  AddressedParticipantModelOption,
  AddressedParticipantAccount,
} from './read-addressed-exchange-participants';

interface CliRegistryRow {
  subject_id?: unknown;
  property_id?: unknown;
  value?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toModelOptions(value: unknown): AddressedParticipantModelOption[] {
  if (!Array.isArray(value)) return [];
  const out: AddressedParticipantModelOption[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = asString(r.id) ?? asString(r.model) ?? '';
    const label = asString(r.label) ?? asString(r.display_name) ?? id;
    if (!label) continue;
    const blurb = asString(r.description) ?? asString(r.blurb);
    out.push({
      id,
      label,
      ...(r.isDefault === true || r.is_default === true ? { isDefault: true } : {}),
      ...(blurb ? { description: blurb } : {}),
    });
  }
  return out;
}

function toAccounts(value: unknown): AddressedParticipantAccount[] {
  if (!Array.isArray(value)) return [];
  const out: AddressedParticipantAccount[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = asString(r.id) ?? asString(r.account_id);
    if (!id) continue;
    out.push({
      id,
      label: asString(r.label) ?? asString(r.display_name) ?? id,
      configDir: asString(r.configDir) ?? asString(r.config_dir) ?? '',
    });
  }
  return out;
}

/** Present a bare cli id as a human label when no display_name is in the feed
 *  (e.g. "codex" -> "Codex", "claude-code" -> "Claude Code", and a namespaced
 *  subject id "cli:ollama" -> "Ollama"). Cosmetic fallback only; a real
 *  display_name in cli-registry always wins. The leading `cli:` subject
 *  namespace is stripped and `:` is treated as a word boundary so the fallback
 *  can NEVER surface internal vocabulary like "Cli:ollama" to the user
 *  (L114/L118) — even if a future CLI ships without a display_name row. */
function humanizeCliId(cli: string): string {
  return cli
    .replace(/^cli:/i, '')
    .split(/[-_\s:]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || cli;
}

/** Build an AddressedParticipantInfo from one grouped cli_registry subject. */
function participantFromCli(cliId: string, fields: Record<string, unknown>): AddressedParticipantInfo {
  const cli = asString(fields['prop:cli_registry:cli']) ?? cliId;
  const label = asString(fields['prop:cli_registry:display_name']) ?? humanizeCliId(cli);
  const launch = fields['prop:cli_registry:chat_launch'];
  const models = toModelOptions(fields['prop:cli_registry:models']);
  const providerRefs = Array.isArray(fields['prop:cli_registry:provider_ids'])
    ? (fields['prop:cli_registry:provider_ids'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  // Presentation identity vs routing identity: the picker groups rows by BRAND
  // (a human vendor name), never by this transport row's label. Both values are
  // registry DATA — no vendor names live in code. brand_label falls back to the
  // first provider ref (humanized) so an un-annotated CLI still lands in a brand
  // section; transport_priority orders duplicate model ids across transports
  // (lower wins) so selection resolves to a pipe without asking the user.
  const brandLabel = asString(fields['prop:cli_registry:brand_label'])
    ?? (providerRefs[0] ? humanizeCliId(providerRefs[0]) : null);
  const rawPriority = fields['prop:cli_registry:transport_priority'];
  const transportPriority = typeof rawPriority === 'number' && Number.isFinite(rawPriority)
    ? rawPriority
    : null;
  // An AI-agent CLI is sendable through one of two generic owner paths. A launch
  // with argv is a real process-session adapter. HTTP launches (and catalog rows
  // whose executable launch is resolved producer-side) are request/reply turns
  // owned by ai-records-producer. Never label an HTTP descriptor process-session:
  // process consumers are entitled to read launch.argv, which HTTP correctly
  // does not have. The producer still resolves the selected agent's complete
  // current launch descriptor from DATA.
  // A row is an agent when it declares a launch, models, or providers — plain
  // non-agent rows (e.g. a shell) carry none of those and stay non-sendable.
  const hasLaunch = launch !== null && typeof launch === 'object';
  const hasProcessLaunch = hasLaunch
    && Array.isArray((launch as Record<string, unknown>).argv)
    && ((launch as Record<string, unknown>).argv as unknown[]).length > 0;
  const isSendableAgent = hasLaunch || models.length > 0 || providerRefs.length > 0;
  const adapter = isSendableAgent
    ? hasProcessLaunch
      ? {
          kind: 'process-session' as const,
          requiresAuth: false,
          ownerTargetRef: 'slot::process-session',
          launch,
        }
      : {
          kind: 'ai-records-producer' as const,
          requiresAuth: false,
          ownerTargetRef: 'slot::workflow',
        }
    : null;
  return {
    participantRef: cli,
    wayToReachRef: `${cli}-way`,
    label,
    version: asString(fields['prop:cli_registry:version']) ?? '',
    accounts: toAccounts(fields['prop:cli_registry:accounts']),
    models,
    // The picker groups by adapter.kind; a CLI is a process-session participant.
    adapter: adapter as AddressedParticipantInfo['adapter'],
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
    providerRefs,
    metadata: {
      ...(brandLabel ? { brandLabel } : {}),
      ...(transportPriority !== null ? { transportPriority } : {}),
    },
  } as AddressedParticipantInfo;
}

/** True for values that carry no information (empty array / empty string / null).
 *  The cli-registry fold aggregates matching records across partitions, so the
 *  SAME subject+property can appear twice — e.g. a populated `models` row from the
 *  canonical seed AND an empty `[]` row written by a model-discovery pass that
 *  found nothing (no provider auth). Blind last-wins would let the empty row
 *  shadow the real one. Prefer the informative value regardless of row order. */
function isEmptyValue(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.length === 0;
  return false;
}

/**
 * Decode the cli-registry addressed feed (flat {subject_id, property_id, value}
 * rows) into picker participants. One participant per cli subject.
 */
export function decodeCliRegistryParticipants(raw: unknown): AddressedParticipantInfo[] {
  if (!Array.isArray(raw)) return [];
  const grouped = new Map<string, Record<string, unknown>>();
  for (const entry of raw as CliRegistryRow[]) {
    if (!entry || typeof entry !== 'object') continue;
    const subjectId = asString(entry.subject_id);
    const propertyId = asString(entry.property_id);
    if (!subjectId || !propertyId) continue;
    const current = grouped.get(subjectId) ?? {};
    // An empty later row must not overwrite an already-populated value.
    if (!(propertyId in current) || !isEmptyValue(entry.value)) {
      current[propertyId] = entry.value;
    }
    grouped.set(subjectId, current);
  }
  const out: AddressedParticipantInfo[] = [];
  for (const [subjectId, fields] of grouped) {
    // A subject becomes a chattable AGENT participant only if it declares
    // agent-ness — a cli id, a launch config, models, or provider refs. A
    // registry subject that carries ONLY a conversation-source descriptor
    // (e.g. `cli:imessage` with just `prop:cli_registry:transcript_sources`,
    // the vehicle the materialize fold reads to list iMessage threads) is NOT
    // an AI you talk to; it must not appear in the Agents rail (it already
    // lives in the People rail as a service connection). Self-describing filter
    // (L090): the presence of an agent signal is the discriminant, never a
    // hardcoded id. Its transcript_sources still drive materialization.
    const declaresAgent =
      asString(fields['prop:cli_registry:cli']) !== null ||
      (fields['prop:cli_registry:chat_launch'] != null &&
        typeof fields['prop:cli_registry:chat_launch'] === 'object') ||
      (Array.isArray(fields['prop:cli_registry:models']) &&
        (fields['prop:cli_registry:models'] as unknown[]).length > 0) ||
      (Array.isArray(fields['prop:cli_registry:provider_ids']) &&
        (fields['prop:cli_registry:provider_ids'] as unknown[]).length > 0);
    if (!declaresAgent) continue;
    out.push(participantFromCli(subjectId, fields));
  }
  return out;
}
