// packages/ui/show/grouped-picker/grouped-picker.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic reusable grouped picker — a glassmorphism dropdown whose items can be
// grouped under faint section headers, each row showing a leading mark, a label,
// a one-line description, and an active checkmark (the Granola/ChatGPT/Vibecode
// model-picker anatomy). Framework-agnostic logic with React rendering. Fully
// keyboard-accessible with the ARIA listbox pattern.
//
// Elevated to the shared `ui` package from the former chat-local InlineDropdown
// so EVERY package composes ONE grouped picker (L069/L066) instead of hand-
// rolling its own. The chat participant/model picker and the preset picker are
// configurations of this single primitive.
//
// Uses Radix UI Popover for portal-based rendering — the panel escapes any
// parent overflow constraints and positions itself relative to the trigger.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic over T — works with any item type via getLabel/getKey extractors.
// 2. Outside click and Escape key close the picker (handled by Radix).
// 3. Glassmorphism tokens only — no gray-* colors.
// 4. ARIA: role="listbox" on panel, role="option" on items.
// 5. Disabled state prevents all interaction.
// 6. Portal rendering — never clipped by parent overflow.
// 7. Grouping is DATA-driven: consecutive items with a different getSection emit
//    a faint section header. Zero hardcoded group names.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check } from 'lucide-react';
import type { LucideProps } from 'lucide-react';
import { Button } from '../button';
import { Card } from '../card';
import { Container } from '../container';
import { Divider } from '../divider/Divider';
import { Icon } from '../icon';
import { Text } from '../text';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface GroupedPickerProps<T> {
  /** Available items to choose from */
  items: readonly T[];
  /**
   * Currently selected item. `undefined` is valid in two cases: the items list
   * is empty, OR this is an ACTION menu (e.g. presets) where picking a row fires
   * an action rather than persisting a selection — then no row shows a checkmark
   * and the trigger relies on `triggerLabel`/`triggerLeading`.
   */
  selected: T | undefined;
  /** Extract a display label from an item */
  getLabel: (item: T) => string;
  /** Extract a unique key from an item */
  getKey: (item: T) => string;
  /** Called when the user selects an item */
  onSelect: (item: T) => void;
  /** Currently selected item keys for multi-select mode */
  selectedKeys?: readonly string[];
  /** Keeps the picker open and toggles rows instead of replacing selection */
  multiSelect?: boolean;
  /** Lucide icon component rendered before the label, when provided */
  icon?: React.ElementType<LucideProps>;
  /** Data-driven leading mark rendered before each item label, when provided */
  renderLeading?: (item: T) => React.ReactNode;
  /** Disables the picker (e.g., during an active session) */
  disabled?: boolean;
  /** Groups items under faint section headers when consecutive items differ in section. */
  getSection?: (item: T) => string;
  getDescription?: (item: T) => string | undefined;
  /** Label shown on the collapsed trigger button. */
  triggerLabel?: string;
  /** Leading node shown on the collapsed trigger button. */
  triggerLeading?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function GroupedPicker<T>({
  items,
  selected,
  getLabel,
  getKey,
  onSelect,
  icon: LeadIcon,
  renderLeading,
  disabled = false,
  selectedKeys,
  multiSelect = false,
  getSection,
  getDescription,
  triggerLabel,
  triggerLeading,
}: GroupedPickerProps<T>) {
  const selectedKey = selected ? getKey(selected) : '';
  const selectedKeySet = new Set(selectedKeys ?? (selectedKey ? [selectedKey] : []));

  const handleSelect = useCallback(
    (item: T) => {
      onSelect(item);
    },
    [onSelect],
  );

  return (
    <Popover.Root>
      {/* Trigger button */}
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="px-2.5 py-1.5 gap-1.5"
        >
          {triggerLeading ?? (selected && renderLeading ? renderLeading(selected) : LeadIcon ? <Icon icon={LeadIcon} size="xs" color="faint" /> : null)}
          <Text variant="body-xs" color="subtle" as="span">{triggerLabel ?? (selected ? getLabel(selected) : '—')}</Text>
          <Text variant="caption" color="faint" as="span">&#9662;</Text>
        </Button>
      </Popover.Trigger>

      {/* Picker panel — rendered via portal, escapes overflow */}
      <Popover.Portal>
        <Popover.Content
          role="listbox"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="min-w-[140px] z-50 max-h-[420px] overflow-y-auto overscroll-contain"
          asChild
        >
          <Card variant="popover" padding="none">
          <Container layout="vertical" gap="sm" padding="sm">
          {items.map((item, index) => {
            const key = getKey(item);
            const isSelected = selectedKeySet.has(key);
            const section = getSection ? getSection(item) : '';
            const prevSection = getSection && index > 0 ? getSection(items[index - 1]) : '';
            const showSectionHeader = Boolean(section) && section !== prevSection;
            const description = getDescription ? getDescription(item) : undefined;
            const itemButton = (
              <Button
                variant="ghost"
                size="sm"
                role="option"
                aria-selected={isSelected}
                active={isSelected}
                onClick={() => handleSelect(item)}
                className="w-full justify-start px-3.5 py-2.5 gap-2.5"
              >
                {renderLeading ? renderLeading(item) : LeadIcon ? <Icon icon={LeadIcon} size="xs" color="faint" /> : null}
                {description ? (
                  <Container layout="vertical" gap="none" flex={1} alignItems="start" padding="none" overflow="hidden">
                    <Text variant="body-xs" as="span">{getLabel(item)}</Text>
                    <Text variant="caption" color="faint" as="span" truncate>{description}</Text>
                  </Container>
                ) : (
                  <Container layout="horizontal" flex={1} alignItems="center" padding="none" overflow="hidden">
                    <Text variant="body-xs" as="span" truncate>{getLabel(item)}</Text>
                  </Container>
                )}
                {isSelected ? <Icon icon={Check} size="xs" color="success" /> : null}
              </Button>
            );
            const sectionHeader = showSectionHeader ? (
              <Container layout="horizontal" alignItems="center" padding="xs">
                <Text variant="caption" color="faint" as="span">{section}</Text>
              </Container>
            ) : null;
            if (multiSelect) {
              return (
                <React.Fragment key={key}>
                  {sectionHeader}
                  {itemButton}
                </React.Fragment>
              );
            }
            return (
              <React.Fragment key={key}>
                {sectionHeader}
                <Popover.Close asChild>
                  {itemButton}
                </Popover.Close>
              </React.Fragment>
            );
          })}
          {multiSelect && (
            <>
              <Divider size="xs" />
              <Popover.Close asChild>
                <Button variant="ghost" size="sm" className="w-full justify-center px-3.5 py-2.5">
                  Done
                </Button>
              </Popover.Close>
            </>
          )}
          </Container>
          </Card>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
