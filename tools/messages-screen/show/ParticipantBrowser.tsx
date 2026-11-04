// PORTED FROM: bitfield-packages/packages/chat/show/ParticipantBrowser.tsx @ e99ac5976
// packages/chat/show/ParticipantBrowser.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Full-screen overlay browser for discovering and adding participants to a chat
// session. Groups participants by self-described presentation DATA, falling
// back to transport kind only when no human-facing group label exists.
// Each participant card shows its display mark, label, and a connection-state
// CTA verb derived from participant data — never from hardcoded connector logic.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Completely blind to participant identity — no name checks, no kind switches
// 2. Groups prefer metadata.brandLabel and only title-case adapter.kind as fallback
// 3. All styling via @/packages/ui — zero raw HTML, zero className, zero inline
//    styles (maxHeight on Container uses the Container.maxHeight prop)
// 4. Adding a new participant tomorrow requires zero changes to this file
// 5. Visible copy is in user language only — no internal field names as labels
// 6. CTA verbs are actions the user can take — not system state labels
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState, useMemo } from 'react';
import { Search, SlidersHorizontal, Users } from 'lucide-react';
import {
  Container,
  Card,
  Badge,
  Input,
  Text,
  EmptyPlaceholder,
  ActionControl,
  Divider,
  AvatarGroup,
  Icon,
  Tooltip,
} from '../../ui';
import { DisplayMark } from '../../ui/show/display-mark';
import { participantToMarkSpec } from './participant-mark-spec';
import type { AddressedParticipantInfo } from '../read-data/read-addressed-exchange-participants';
import { FloatingPanel } from '../../screen-arrangement/show/FloatingPanel';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ParticipantBrowserProps {
  /** Whether the browser overlay is visible */
  open: boolean;
  /** Called when the browser should dismiss */
  onClose: () => void;
  /** Presented agent profiles and connected people; execution transports stay routing-only */
  participants: readonly AddressedParticipantInfo[];
  /** Currently selected participant refs */
  selectedParticipantRefs: readonly string[];
  /** Called with the participantRef when the user toggles a participant */
  onSelectParticipant: (participantRef: string) => void;
  /** Called when the selected set should be accepted */
  onDone: () => void;
  /** Called when the user triggers the connect flow for a participant */
  onConnectParticipant: (participant: AddressedParticipantInfo) => void;
  /** DATA/capability check for the current placeable-surface catalog. */
  canConfigureParticipant?: (participant: AddressedParticipantInfo) => boolean;
  /** Emits a generic material intent; the browser never selects an owner. */
  onConfigureParticipant?: (participant: AddressedParticipantInfo) => void;
}

// ---------------------------------------------------------------------------
// GROUP DERIVATION
//
// Grouping prefers participant metadata.brandLabel, then falls back to the
// transport kind. Internal kinds therefore never leak when presentation DATA
// exists. No kind present → group key '' → group label 'Other'.
// Fallback labels are title-cased from the kind string:
//   "process-session" → "Process Session"
//   "api"             → "Api"
//   ""                → "Other"
// There is no hardcoded kind→label mapping anywhere in this file.
// ---------------------------------------------------------------------------

function deriveGroupLabel(kind: string | null | undefined): string {
  if (!kind || kind.trim() === '') return 'Other';
  return kind
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

interface ParticipantGroup {
  key: string;
  label: string;
  participants: AddressedParticipantInfo[];
}

function groupParticipants(participants: readonly AddressedParticipantInfo[]): ParticipantGroup[] {
  const groupMap = new Map<string, ParticipantGroup>();
  const groupOrder: string[] = [];

  for (const participant of participants) {
    const brandLabel = typeof participant.metadata?.brandLabel === 'string'
      ? participant.metadata.brandLabel.trim()
      : '';
    const adapterKind = participant.adapter?.kind ?? '';
    const key = brandLabel ? `brand:${brandLabel}` : `kind:${adapterKind}`;
    if (!groupMap.has(key)) {
      groupOrder.push(key);
      groupMap.set(key, {
        key,
        label: brandLabel || deriveGroupLabel(adapterKind),
        participants: [],
      });
    }
    groupMap.get(key)!.participants.push(participant);
  }

  return groupOrder.map((key) => groupMap.get(key)!);
}

// ---------------------------------------------------------------------------
// CONNECTION CTA LOGIC
//
// Derives a user-facing CTA verb from participant data only.
//
// no service refs                         → "Add to chat"
// service refs + auth required            → "Connect"
// service refs + auth not required        → "Add to chat"
// is_pending                              → "Setting up..."
// can_send                                → "Connected"
// can_retry                               → "Reconnect"
// ---------------------------------------------------------------------------

type CtaState = 'add' | 'connect' | 'setting-up' | 'connected' | 'reconnect';

export function deriveParticipantConnectionCta(
  connectionStates: AddressedParticipantInfo['connectionStates'],
  serviceConnectionRefs: readonly string[],
  requiresAuth: boolean,
): CtaState {
  if (serviceConnectionRefs.length === 0) return 'add';
  if (connectionStates.some((state) => state.isPending)) return 'setting-up';
  if (connectionStates.some((state) => state.canSend)) return 'connected';
  if (connectionStates.some((state) => state.canRetry)) return 'reconnect';
  if (!requiresAuth) return 'add';
  return 'connect';
}

function deriveCtaState(participant: AddressedParticipantInfo): CtaState {
  return deriveParticipantConnectionCta(
    participant.connectionStates,
    participant.serviceConnectionRefs,
    participant.requiresAuth,
  );
}

const CTA_LABELS: Record<CtaState, string> = {
  add: 'Add to chat',
  connect: 'Connect',
  'setting-up': 'Setting up…',
  connected: 'Connected',
  reconnect: 'Reconnect',
};

type ActionControlVariant = React.ComponentProps<typeof ActionControl>['variant'];

const CTA_VARIANTS: Record<CtaState, ActionControlVariant> = {
  add: 'secondary',
  connect: 'accent',
  'setting-up': 'ghost',
  connected: 'success',
  reconnect: 'secondary',
};

// ---------------------------------------------------------------------------
// PARTICIPANT CARD
//
// The atomic building block of the browser grid. Renders participant identity,
// an optional capability-backed configuration control, and the primary CTA.
// inside a nested card — mark on the left, label in the middle (truncates),
// CTA on the right edge.
// ---------------------------------------------------------------------------

function ParticipantCard({
  participant,
  selected,
  onSelect,
  onConnect,
  canConfigure,
  onConfigure,
}: {
  participant: AddressedParticipantInfo;
  selected: boolean;
  onSelect: (participantRef: string) => void;
  onConnect: (participant: AddressedParticipantInfo) => void;
  canConfigure: boolean;
  onConfigure?: (participant: AddressedParticipantInfo) => void;
}) {
  const ctaState = deriveCtaState(participant);
  const isLoading = ctaState === 'setting-up';
  const isActive = ctaState === 'connected';

  function handleCta() {
    if (selected) {
      onSelect(participant.participantRef);
      return;
    }
    if (ctaState === 'add' || ctaState === 'connected') {
      onSelect(participant.participantRef);
    } else {
      onConnect(participant);
    }
  }

  return (
    <Card
      variant="nested"
      padding="sm"
      layout="row"
      interactive={false}
    >
      {/* Display mark — logo, glyph, or icon from participant data */}
      <DisplayMark spec={participantToMarkSpec(participant)} size="md" />

      {/* Label — fills middle space; truncates on overflow */}
      <Container layout="vertical" flex={1} gap="none" overflow="hidden">
        <Text variant="body" weight="medium" truncate>
          {participant.label}
        </Text>
      </Container>

      {canConfigure && onConfigure ? (
        <Tooltip label={`Configure ${participant.label}`}>
          <ActionControl
            variant="ghost"
            size="icon"
            onClick={() => onConfigure(participant)}
            aria-label={`Configure ${participant.label}`}
          >
            <Icon icon={SlidersHorizontal} size="sm" />
          </ActionControl>
        </Tooltip>
      ) : null}

      {/* Primary CTA — verb derived from participant connection state */}
      <ActionControl
        variant={selected ? 'success' : CTA_VARIANTS[ctaState]}
        size="sm"
        loading={isLoading}
        active={selected || isActive}
        disabled={isLoading}
        onClick={handleCta}
        aria-label={`${selected ? 'Remove from chat' : CTA_LABELS[ctaState]}: ${participant.label}`}
      >
        {!isLoading && (selected ? 'Remove' : CTA_LABELS[ctaState])}
      </ActionControl>
    </Card>
  );
}

function SelectedParticipantsFooter({
  selectedParticipants,
  onRemoveParticipant,
  onDone,
}: {
  selectedParticipants: readonly AddressedParticipantInfo[];
  onRemoveParticipant: (participantRef: string) => void;
  onDone: () => void;
}) {
  return (
    <Card variant="nested" padding="sm" borderless>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" padding="none">
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none" overflow="hidden">
          <Badge variant="muted" size="md">
            {selectedParticipants.length} selected
          </Badge>
          <AvatarGroup
            size="xs"
            ringToken="glass-subtle"
            ariaLabel="Selected participants"
            items={selectedParticipants.map((participant) => ({
              key: participant.participantRef,
              node: (
                <ActionControl
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemoveParticipant(participant.participantRef)}
                  aria-label={`Remove ${participant.label}`}
                >
                  <DisplayMark spec={participantToMarkSpec(participant)} size="xs" />
                </ActionControl>
              ),
            }))}
          />
        </Container>
        <ActionControl
          variant="accent"
          size="sm"
          onClick={onDone}
          disabled={selectedParticipants.length === 0}
        >
          Done
        </ActionControl>
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PARTICIPANT BROWSER — main export
// ---------------------------------------------------------------------------

export function ParticipantBrowser({
  open,
  onClose,
  participants,
  selectedParticipantRefs,
  onSelectParticipant,
  onDone,
  onConnectParticipant,
  canConfigureParticipant,
  onConfigureParticipant,
}: ParticipantBrowserProps) {
  const [query, setQuery] = useState('');
  const selectedParticipantRefSet = useMemo(
    () => new Set(selectedParticipantRefs),
    [selectedParticipantRefs],
  );

  // Filter by label — case-insensitive substring match
  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return participants;
    return participants.filter((p) => p.label.toLowerCase().includes(trimmed));
  }, [participants, query]);

  const groups = useMemo(() => groupParticipants(filtered), [filtered]);
  const selectedParticipants = useMemo(
    () => participants.filter((participant) => selectedParticipantRefSet.has(participant.participantRef)),
    [participants, selectedParticipantRefSet],
  );

  function handleClose() {
    setQuery('');
    onClose();
  }

  return (
    <FloatingPanel
      open={open}
      onClose={handleClose}
      title="Add a participant"
      width={672}
    >
      <Container layout="vertical" gap="lg" padding="none">

        {/* Search — filters participant list by label as the user types */}
        <Input
          label="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          icon={<Search />}
          autoFocus
          aria-label="Search participants"
        />

        {/* Scrollable group area — bounded so the modal stays on-screen */}
        <Container
          layout="vertical"
          gap="xl"
          overflow="y-auto"
          padding="none"
          maxHeight="60vh"
        >
          {groups.length === 0 ? (
            <EmptyPlaceholder
              icon={Users}
              message="No participants match your search."
            />
          ) : (
            groups.map((group, groupIndex) => (
              <Container key={group.key} layout="vertical" gap="sm" padding="none">

                {/* Section header — only rendered when multiple groups exist */}
                {groups.length > 1 && (
                  <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
                    <Text variant="caption" color="faint">
                      {group.label}
                    </Text>
                    <Divider size="xs" />
                  </Container>
                )}

                {/* 2-column card grid */}
                <Container
                  layout="grid"
                  gridCols={2}
                  gap="sm"
                  padding="none"
                >
                  {group.participants.map((participant) => (
                    <ParticipantCard
                      key={participant.participantRef}
                      participant={participant}
                      selected={selectedParticipantRefSet.has(participant.participantRef)}
                      onSelect={onSelectParticipant}
                      onConnect={onConnectParticipant}
                      canConfigure={canConfigureParticipant?.(participant) === true}
                      onConfigure={onConfigureParticipant}
                    />
                  ))}
                </Container>

                {/* Visual separator between adjacent groups */}
                {groupIndex < groups.length - 1 && (
                  <Divider size="xs" />
                )}

              </Container>
            ))
          )}
        </Container>

        <Divider size="xs" />
        <SelectedParticipantsFooter
          selectedParticipants={selectedParticipants}
          onRemoveParticipant={onSelectParticipant}
          onDone={onDone}
        />

      </Container>
    </FloatingPanel>
  );
}
