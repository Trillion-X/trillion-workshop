// PORTED FROM: bitfield-packages/packages/chat/show/ChatFilterPopover.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/ChatFilterPopover.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Participant multi-select filter popover for the chat conversation sidebar.
// Renders a glassmorphism dropdown with checkboxes for each detected participant,
// plus an "All" toggle. Uses Radix Popover with Portal so glass-popover backdrop-filter
// composites correctly against the full page background.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Multi-select: each participant is independently toggleable
// 2. "All" toggle selects/deselects every participant at once
// 3. Outside click or Escape key closes the popover (handled by Radix)
// 4. Portal rendering — backdrop-filter works correctly at body level
// 5. Participant list comes from addressed exchange participant records
// 6. Self-contained: trigger button included (Radix manages open/close state)
// 7. All styling through ui/ components — zero raw HTML
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useMemo } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, Filter } from 'lucide-react';
import { Badge, Button, Card, Container, Icon, Text } from '../../ui';

// ---------------------------------------------------------------------------
// PURE LOGIC — EXPORTED FOR TESTING
// ---------------------------------------------------------------------------

/** Determine if all participants are selected. */
export function isAllSelected(
  selectedParticipants: Set<string>,
  availableParticipants: string[],
): boolean {
  if (availableParticipants.length === 0) return true;
  return availableParticipants.every((participant) => selectedParticipants.has(participant));
}

/** Toggle a single participant in the selection set, returning a new Set. */
export function toggleParticipant(
  selectedParticipants: Set<string>,
  participantRef: string,
): Set<string> {
  const next = new Set(selectedParticipants);
  if (next.has(participantRef)) {
    next.delete(participantRef);
  } else {
    next.add(participantRef);
  }
  return next;
}

/** Toggle all participants: if all selected, deselect all; otherwise select all. */
export function toggleAll(
  selectedParticipants: Set<string>,
  availableParticipants: string[],
): Set<string> {
  if (isAllSelected(selectedParticipants, availableParticipants)) {
    return new Set<string>();
  }
  return new Set(availableParticipants);
}

// ---------------------------------------------------------------------------
// STYLE CONSTANTS
// ---------------------------------------------------------------------------

// Physics-level sizing for the checkbox indicator — no CVA equivalent exists.
const CHECKBOX_STYLE_CHECKED: React.CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: 3,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  background: 'var(--accent-purple)',
  opacity: 0.6,
  border: '1px solid var(--accent-purple)',
};

const CHECKBOX_STYLE_UNCHECKED: React.CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: 3,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  background: 'transparent',
  border: '1px solid var(--border-secondary)',
};

// Override Button's default justify-center for list items.
const LIST_ITEM_STYLE: React.CSSProperties = {
  justifyContent: 'flex-start',
  width: '100%',
};

// Portal popover panel sizing — no minWidth so it sizes to content.
const POPOVER_CONTENT_STYLE: React.CSSProperties = {
  zIndex: 50,
  padding: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

// ---------------------------------------------------------------------------
// CHECKBOX INDICATOR
// ---------------------------------------------------------------------------

function CheckboxIndicator({ checked }: { checked: boolean }) {
  return (
    <Container padding="none" style={checked ? CHECKBOX_STYLE_CHECKED : CHECKBOX_STYLE_UNCHECKED}>
      {checked && <Icon icon={Check} size="xs" />}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export interface ChatFilterPopoverProps {
  /** Human-facing participant descriptors; stable refs remain hidden filter keys */
  availableParticipants: readonly { participantRef: string; label: string }[];
  /** Currently selected participant refs */
  selectedParticipants: Set<string>;
  /** Callback when selection changes */
  onSelectionChange: (selected: Set<string>) => void;
  /** Number of active filters (shown as badge on trigger) */
  activeFilterCount?: number;
}

export function ChatFilterPopover({
  availableParticipants,
  selectedParticipants,
  onSelectionChange,
  activeFilterCount = 0,
}: ChatFilterPopoverProps) {
  const availableParticipantRefs = useMemo(
    () => availableParticipants.map((participant) => participant.participantRef),
    [availableParticipants],
  );
  const allSelected = isAllSelected(selectedParticipants, availableParticipantRefs);

  const handleToggleAll = useCallback(() => {
    onSelectionChange(toggleAll(selectedParticipants, availableParticipantRefs));
  }, [selectedParticipants, availableParticipantRefs, onSelectionChange]);

  const handleToggleParticipant = useCallback(
    (participantRef: string) => {
      onSelectionChange(toggleParticipant(selectedParticipants, participantRef));
    },
    [selectedParticipants, onSelectionChange],
  );

  return (
    <Popover.Root>
      {/* Trigger button */}
      <Popover.Trigger asChild>
        <Button
          variant={activeFilterCount > 0 ? 'secondary' : 'ghost'}
          size="icon"
        aria-label="Filter by participant"
        >
          <Icon icon={Filter} size="sm" />
          {activeFilterCount > 0 && (
            <Badge variant="accent" size="dot">
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </Popover.Trigger>

      {/* Dropdown panel — rendered via portal so backdrop-filter works at body level */}
      <Popover.Portal>
        <Popover.Content
          role="listbox"
          aria-label="Filter by participant"
          side="bottom"
          align="end"
          sideOffset={4}
          style={POPOVER_CONTENT_STYLE}
          asChild
        >
          <Card variant="popover" padding="none">
            {/* All toggle */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleToggleAll}
              role="option"
              aria-selected={allSelected}
              style={LIST_ITEM_STYLE}
            >
              <CheckboxIndicator checked={allSelected} />
              <Text variant="label" color={allSelected ? 'default' : 'subtle'}>All</Text>
            </Button>

            {/* Separator */}
            <Container padding="none" style={{ borderTop: '1px solid var(--border-primary)', margin: '2px 0' }} />

            {/* Individual participant checkboxes */}
            {availableParticipants.map((participant) => {
              const checked = selectedParticipants.has(participant.participantRef);
              return (
                <Button
                  key={participant.participantRef}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggleParticipant(participant.participantRef)}
                  role="option"
                  aria-selected={checked}
                  style={LIST_ITEM_STYLE}
                >
                  <CheckboxIndicator checked={checked} />
                  <Badge variant="neutral" size="sm">
                    {participant.label}
                  </Badge>
                </Button>
              );
            })}

            {availableParticipants.length === 0 && (
              <Container padding="sm">
                <Text variant="label" color="faint">No participants available</Text>
              </Container>
            )}
          </Card>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
