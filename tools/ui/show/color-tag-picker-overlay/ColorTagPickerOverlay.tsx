// packages/ui/show/color-tag-picker-overlay/ColorTagPickerOverlay.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A data-driven list of color/tag options anchored to a trigger button.
// Uses AnchoredOverlay for positioning (anchored, auto-flip, viewport-clamp).
// Uniform row anatomy: dot (color indicator) + label + delete affordance on
// every row, consistent sizing, proper density. Built for option fields
// (status, priority, category) that need color-coded selection UI.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Data-driven, never enum-based: options come as DATA rows, not TS types
// 2. Uniform row anatomy: every row has identical structure (dot + label + delete)
// 3. Proper anchoring: uses AnchoredOverlay for viewport-aware positioning
// 4. Zero domain vocabulary: knows nothing about "status" or "priority" specifics
// 5. No inline styling: all visual design through ui components and tokens
// =============================================================================

import React from 'react';
import { AnchoredOverlay } from '../anchored-overlay';
import { Button } from '../button';
import { ColorDot } from '../color-dot';
import { Container } from '../container';
import { Icon } from '../icon';
import { Text } from '../text';
import { X } from 'lucide-react';

export interface ColorTagOption {
  id: string;
  label: string;
  color?: string;
}

export interface ColorTagPickerOverlayProps {
  anchorRef: React.RefObject<HTMLElement>;
  /** Stable identity shared by the trigger's aria-controls and this listbox. */
  id: string;
  /** Trigger that names this single-select listbox. */
  labelledBy: string;
  open: boolean;
  onDismiss: () => void;
  options: readonly ColorTagOption[];
  selectedId?: string;
  onSelect: (optionId: string) => void;
  onDelete?: (optionId: string) => void;
  placement?: 'above' | 'below';
  label?: string;
  showDelete?: boolean;
}

export function ColorTagPickerOverlay({
  anchorRef,
  id,
  labelledBy,
  open,
  onDismiss,
  options,
  selectedId,
  onSelect,
  onDelete,
  placement = 'below',
  label = 'Pick an option',
  showDelete = true,
}: ColorTagPickerOverlayProps) {
  const listboxRef = React.useRef<HTMLDivElement | null>(null);
  const optionIds = React.useMemo(
    () => new Set(options.map((option) => option.id)),
    [options],
  );
  const initialActiveId = optionIds.has(selectedId ?? '')
    ? selectedId
    : options[0]?.id;
  const [activeId, setActiveId] = React.useState<string | undefined>(initialActiveId);
  const optionIdentity = options.map((option) => option.id).join('\u0000');

  React.useLayoutEffect(() => {
    if (!open) return;
    const nextActiveId = options.some((option) => option.id === selectedId)
      ? selectedId
      : options[0]?.id;
    setActiveId(nextActiveId);
    listboxRef.current?.focus({ preventScroll: true });
  }, [open, optionIdentity, selectedId]);

  const activeIndex = options.findIndex((option) => option.id === activeId);
  const moveActive = (offset: number) => {
    if (options.length === 0) return;
    if (activeIndex < 0) {
      setActiveId(options[offset < 0 ? options.length - 1 : 0].id);
      return;
    }
    setActiveId(options[(activeIndex + offset + options.length) % options.length].id);
  };
  const selectActive = () => {
    const active = options.find((option) => option.id === activeId);
    if (active) onSelect(active.id);
  };

  return (
    <AnchoredOverlay
      anchorRef={anchorRef}
      open={open}
      placement={placement}
      onDismiss={onDismiss}
    >
      <Container
        ref={listboxRef}
        id={id}
        layout="vertical"
        gap="xs"
        padding="xs"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-activedescendant={activeId ? `${id}-option-${encodeURIComponent(activeId)}` : undefined}
        aria-orientation="vertical"
        role="listbox"
        tabIndex={-1}
        onKeyDown={(event: React.KeyboardEvent) => {
          switch (event.key) {
            case 'ArrowDown':
              event.preventDefault();
              event.stopPropagation();
              moveActive(1);
              break;
            case 'ArrowUp':
              event.preventDefault();
              event.stopPropagation();
              moveActive(-1);
              break;
            case 'Home':
              event.preventDefault();
              event.stopPropagation();
              setActiveId(options[0]?.id);
              break;
            case 'End':
              event.preventDefault();
              event.stopPropagation();
              setActiveId(options[options.length - 1]?.id);
              break;
            case 'Enter':
            case ' ':
              event.preventDefault();
              event.stopPropagation();
              selectActive();
              break;
            case 'Escape':
              event.preventDefault();
              event.stopPropagation();
              onDismiss();
              break;
            case 'Delete':
            case 'Backspace':
              if (!showDelete || !onDelete || !activeId) break;
              event.preventDefault();
              event.stopPropagation();
              onDelete(activeId);
              break;
            default:
              break;
          }
        }}
      >
        {options.length === 0 ? (
          <Text variant="body-sm" color="muted">
            No options
          </Text>
        ) : (
          options.map((option) => (
            <Container
              key={option.id}
              layout="horizontal"
              alignItems="center"
              gap="xs"
              padding="none"
              role="presentation"
              className="group"
            >
              <button
                id={`${id}-option-${encodeURIComponent(option.id)}`}
                type="button"
                onPointerMove={() => setActiveId(option.id)}
                onClick={() => {
                  setActiveId(option.id);
                  onSelect(option.id);
                }}
                className={`flex w-full flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--glass-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)] ${activeId === option.id ? 'bg-[var(--glass-bg-active)]' : ''}`}
                role="option"
                aria-selected={selectedId === option.id}
                data-active={activeId === option.id || undefined}
                tabIndex={-1}
              >
                <ColorDot color={option.color || 'var(--border-secondary)'} size="md" />
                <Text variant="body-sm" color="primary">{option.label}</Text>
              </button>
              {showDelete && onDelete ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(option.id);
                  }}
                  aria-label={`Delete ${option.label}`}
                >
                  <Icon icon={X} size="xs" />
                </Button>
              ) : null}
            </Container>
          ))
        )}
      </Container>
    </AnchoredOverlay>
  );
}
