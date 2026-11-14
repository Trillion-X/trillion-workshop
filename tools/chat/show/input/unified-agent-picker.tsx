// PORTED FROM: bitfield-packages/packages/chat/show/input/unified-agent-picker.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/show/input/unified-agent-picker.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ONE composer control that replaces the old four-control ChatConfigBar row
// (participant avatar + participant dropdown + account dropdown + model
// dropdown). The same agent used to appear three times across those controls —
// the L118 "selectors for selectors' sake" violation the product owner flagged.
//
// This is the Notion-grade model: a single trigger reading "Auto" by default,
// opening a grouped catalog of agents -> their models. Choosing a model row
// selects BOTH the agent (participant) and the model in one action. With "Auto"
// the system resolves the configured default, so a user never HAS to choose
// anything before sending a message — the brain decides.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Fully DATA-driven (L090): every agent, model, and label comes from the
//    `participants` data. ZERO hardcoded provider/model/agent names here.
// 2. Composes the shared ui/ GroupedPicker primitive — no bespoke dropdown, no
//    raw markup, no className (L065/L069/DRY).
// 3. "Auto" is always first and is the selected state when nothing is pinned;
//    choosing it clears the explicit selection so the default resolves.
// 4. Account is not a top-level control. Multiple accounts on one agent are an
//    advanced detail, never an always-visible selector.
// 5. Read-only when canChange is false (locked to an in-flight session).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useMemo } from 'react';
import { Sparkles, Plug, SlidersHorizontal } from 'lucide-react';
import { Badge, Icon, Text, GroupedPicker, ActionControl, Container, Tooltip } from '../../../ui';
import { DisplayMark } from '../../../ui/show/display-mark';
import { participantToMarkSpec } from '../participant-mark-spec';
import type { ChatSessionConfig } from '../../read-data/read-chat-sessions';
import type { AddressedParticipantInfo } from '../../read-data/read-addressed-exchange-participants';

// ---------------------------------------------------------------------------
// CATALOG ITEM (flat list fed to GroupedPicker; sections group it visually)
// ---------------------------------------------------------------------------

type AgentPick =
  | { kind: 'auto'; key: 'auto' }
  | {
      kind: 'model';
      key: string;
      participant: AddressedParticipantInfo;
      modelId: string | null;
      modelLabel: string;
      rowLabel: string;
      modelDescription?: string;
    };

const AUTO_PICK: AgentPick = { kind: 'auto', key: 'auto' };

/**
 * Display hygiene for model labels coming from cli_registry DATA. Some providers
 * label a model with its raw id tail — an 8-digit release date (e.g. "Claude 3 7
 * Sonnet 20250219") or a long commit/hash suffix — which is noise in a product
 * chip (L114). This strips ONLY a trailing release-date or hash token; real names
 * ("GPT-5.4 High", "Opus 4.8", "Gemini 2.5 Flash") are untouched. Generic text
 * hygiene with zero model/provider vocabulary — the same blind-fallback class as
 * `humanizeRef`, so the package stays agnostic to which models exist (L090). Lives
 * in package source (not a live cli_registry write), so it survives label
 * re-derivation and restart and applies to every model row (L063).
 */
export function cleanModelLabel(raw: string): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const cleaned = trimmed.replace(/\s+(?:\d{8}|[0-9a-f]{16,})$/i, '').trim();
  return cleaned.length > 0 ? cleaned : trimmed;
}

/**
 * Presentation identity vs routing identity (the generative primitive here).
 * A user picks "a model from a brand" (presentation); the system routes to
 * "a transport carrying that model" (routing). Grouping the catalog by the
 * transport row's label leaked the routing table into the UI — the product
 * owner saw three sections for one vendor ("Codex" / "GPT-5 (cloud)" /
 * "OpenAI"), duplicated model rows across them, and fabricated "Default"
 * rows for model-less CLIs. Both grouping keys are registry DATA carried on
 * participant metadata: `brandLabel` (falls back to the first provider ref,
 * then the row label) names the section; `transportPriority` (lower wins)
 * decides which transport serves a model id that several transports carry.
 * No vendor names and no transport names live in this code (L090).
 */
const FALLBACK_TRANSPORT_PRIORITY = 100;

export function participantBrand(participant: AddressedParticipantInfo): string {
  const fromMetadata = participant.metadata?.brandLabel;
  if (typeof fromMetadata === 'string' && fromMetadata.length > 0) return fromMetadata;
  return participant.label;
}

function isAgentProfileParticipant(participant: AddressedParticipantInfo): boolean {
  return participant.metadata?.participantKind === 'agent-profile';
}

function participantPriority(participant: AddressedParticipantInfo): number {
  const raw = participant.metadata?.transportPriority;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : FALLBACK_TRANSPORT_PRIORITY;
}

/**
 * Builds the flat catalog: Auto first, then one row per (brand, model id),
 * deduped across transports — the best-priority transport wins the row, so
 * selecting it routes to that transport with zero user awareness of pipes.
 * A participant with zero models contributes no rows (no fabricated
 * "Default" row); it stays reachable through Auto / agent-default routing.
 */
export function buildAgentCatalog(participants: readonly AddressedParticipantInfo[]): AgentPick[] {
  const byIdentity = new Map<string, Extract<AgentPick, { kind: 'model' }>>();
  // Same-brand rows from DIFFERENT transports must land CONTIGUOUSLY — the
  // section header renders once per consecutive run, so participant-order
  // interleaving repeats the same brand header several times (the "three
  // OpenAI headers" screenshot). Bucket identities per brand (first-seen
  // brand order, first-seen row order inside a brand), then flatten.
  const brandOrder: string[] = [];
  const identitiesByBrand = new Map<string, string[]>();
  for (const participant of participants) {
    const brand = participantBrand(participant);
    const priority = participantPriority(participant);
    const isAgentProfile = isAgentProfileParticipant(participant);
    if (isAgentProfile) {
      if (participant.models.length === 0) continue;
      // Assistant identity is independent of its ordered execution routes.
      // Selecting an assistant leaves model resolution to its current owner.
      const identity = participant.participantRef;
      if (byIdentity.has(identity)) continue;
      if (!identitiesByBrand.has(brand)) {
        brandOrder.push(brand);
        identitiesByBrand.set(brand, []);
      }
      identitiesByBrand.get(brand)!.push(identity);
      byIdentity.set(identity, {
        kind: 'model', key: identity, participant, modelId: null,
        modelLabel: '', rowLabel: participant.label,
      });
      continue;
    }
    for (const model of participant.models) {
      const identity = isAgentProfile
        ? `${participant.participantRef}\u0000${model.id || model.label}`
        : `${brand}\u0000${model.id || model.label}`;
      const existing = byIdentity.get(identity);
      if (existing && participantPriority(existing.participant) <= priority) continue;
      const modelLabel = cleanModelLabel(model.label);
      if (!existing) {
        if (!identitiesByBrand.has(brand)) {
          brandOrder.push(brand);
          identitiesByBrand.set(brand, []);
        }
        identitiesByBrand.get(brand)!.push(identity);
      }
      byIdentity.set(identity, {
        kind: 'model',
        key: `${participant.participantRef}:${model.id}`,
        participant,
        modelId: model.id || null,
        modelLabel,
        rowLabel: modelLabel,
        modelDescription: 'description' in model ? model.description : undefined,
      });
    }
  }
  return [
    AUTO_PICK,
    ...brandOrder.flatMap((brand) => identitiesByBrand.get(brand)!.map((identity) => byIdentity.get(identity)!)),
  ];
}

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface UnifiedAgentPickerProps {
  participants: readonly AddressedParticipantInfo[];
  config: ChatSessionConfig;
  /** Select an agent + model together. modelId === null means "agent default". */
  onSelect: (participantRef: string, modelId: string | null) => void;
  /** Choose "Auto": clear the explicit selection, let the system resolve. */
  onSelectAuto: () => void;
  /** Locked to the active session (cannot change mid-conversation). */
  canChange: boolean;
  disabled?: boolean;
  /**
   * Opens the connect flow (ParticipantBrowser). When supplied and no agents
   * exist yet, the empty state becomes an actionable "Connect your AI" control
   * instead of a dead "No agents available" badge, so the user can act (L082/L169).
   */
  onConnect?: () => void;
  /** Current catalog admission for configuring a participant by semantic kind. */
  canConfigureParticipant?: (participant: AddressedParticipantInfo) => boolean;
  /** Emits a package-blind material intent for the selected participant. */
  onConfigureParticipant?: (participant: AddressedParticipantInfo) => void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function UnifiedAgentPicker({
  participants,
  config,
  onSelect,
  onSelectAuto,
  canChange,
  disabled = false,
  onConnect,
  canConfigureParticipant,
  onConfigureParticipant,
}: UnifiedAgentPickerProps) {
  const catalog = useMemo(() => buildAgentCatalog(participants), [participants]);

  const pinnedRef = config.participantRefs.length > 0 ? config.participantRefs[0] : config.participantRef;
  const pinnedParticipant = pinnedRef
    ? participants.find((candidate) => candidate.participantRef === pinnedRef)
    : undefined;
  const isAuto = !pinnedRef && !config.model;
  const selectedModelLabel = config.model
    ? cleanModelLabel(pinnedParticipant?.models.find((model) => model.id === config.model)?.label ?? config.model)
    : null;

  const selected = isAuto
    ? AUTO_PICK
    : catalog.find(
        (row) => row.kind === 'model'
          && row.participant.participantRef === pinnedRef
          && (isAgentProfileParticipant(row.participant) || (row.modelId ?? '') === (config.model ?? '')),
      ) ?? AUTO_PICK;

  // The chip names the profile + model for configured agents, otherwise the
  // transport brand + model fallback. Raw transport labels stay out of the
  // profile-first presentation path.
  const triggerLabel = isAuto
    ? 'Auto'
    : pinnedParticipant
      ? isAgentProfileParticipant(pinnedParticipant)
        ? pinnedParticipant.label
        : [participantBrand(pinnedParticipant), selectedModelLabel].filter(Boolean).join(' · ') || 'Auto'
      : 'Auto';
  const triggerLeading = isAuto || !pinnedParticipant
    ? <Icon icon={Sparkles} size="xs" color="faint" />
    : <DisplayMark spec={participantToMarkSpec(pinnedParticipant)} size="xs" />;

  if (participants.length === 0) {
    // No AI is connected yet. When the caller wires the connect flow, this is an
    // ACTION (open the provider catalog), not a dead status the user cannot act
    // on (L082/L169). Absent onConnect, fall back to the plain informational badge.
    if (onConnect) {
      return (
        <ActionControl variant="accent" size="sm" onClick={onConnect} aria-label="Connect your AI">
          <Icon icon={Plug} size="xs" />
          Connect your AI
        </ActionControl>
      );
    }
    return (
      <Badge variant="muted" size="lg" aria-label="No assistants available">
        <Icon icon={Sparkles} size="xs" color="faint" />
        <Text variant="body-xs" color="faint">No assistants available</Text>
      </Badge>
    );
  }

  if (!canChange) {
    return (
      <Badge variant="muted" size="lg" aria-label="Agent for this conversation" title="Locked to this conversation. Start a new chat to change it.">
        {triggerLeading}
        <Text variant="body-xs" color="faint" truncate>{triggerLabel}</Text>
      </Badge>
    );
  }

  const picker = (
    <GroupedPicker<AgentPick>
      items={catalog}
      selected={selected}
      getKey={(row) => row.key}
      getLabel={(row) => (row.kind === 'auto' ? 'Auto' : row.rowLabel)}
      getSection={(row) => (row.kind === 'auto' ? '' : participantBrand(row.participant))}
      getDescription={(row) => (row.kind === 'model' ? row.modelDescription : undefined)}
      renderLeading={(row) =>
        row.kind === 'auto'
          ? <Icon icon={Sparkles} size="xs" color="faint" />
          : <DisplayMark spec={participantToMarkSpec(row.participant)} size="xs" />
      }
      triggerLabel={triggerLabel}
      triggerLeading={triggerLeading}
      disabled={disabled}
      onSelect={(row) => {
        if (row.kind === 'auto') onSelectAuto();
        else onSelect(row.participant.participantRef, row.modelId);
      }}
    />
  );

  if (!pinnedParticipant
    || !onConfigureParticipant
    || canConfigureParticipant?.(pinnedParticipant) !== true) return picker;

  return (
    <Container layout="horizontal" gap="xs" alignItems="center" padding="none">
      {picker}
      <Tooltip label={`Configure ${pinnedParticipant.label}`}>
        <ActionControl
          variant="ghost"
          size="icon"
          onClick={() => onConfigureParticipant(pinnedParticipant)}
          aria-label={`Configure ${pinnedParticipant.label}`}
        >
          <Icon icon={SlidersHorizontal} size="sm" />
        </ActionControl>
      </Tooltip>
    </Container>
  );
}
