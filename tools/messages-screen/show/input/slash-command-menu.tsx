// PORTED FROM: bitfield-packages/packages/chat/show/input/slash-command-menu.tsx @ e99ac5976
// frontends/web/src/packages/chat/show/input/slash-command-menu.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Slash command dropdown for the chat composer. Triggered when the user types
// "/" at column 0. Shows /clear, /compact, /plan commands. Supports keyboard
// navigation (arrows, Enter, Escape) and portal rendering above the textarea.
//
// Adapted from 1code-main agents-slash-command.tsx to use AICC design system.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Renders via createPortal — always above all other UI regardless of stacking
// 2. Keyboard nav: ArrowUp/Down cycle, Enter/Tab select, Escape close
// 3. selectedIndex resets to 0 on open or when searchText changes
// 4. mousedown (not click) for selection — prevents textarea blur on pick
// 5. All styling through AICC Card, Container, Button, Text components
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Card, Container, Text } from '../../../ui';

// ---------------------------------------------------------------------------
// DATA — module-level constant (stable reference)
// ---------------------------------------------------------------------------

interface SlashCommand {
  id: string;
  command: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'clear',   command: '/clear',   description: 'Start a new conversation' },
  { id: 'compact', command: '/compact', description: 'Make room for a longer conversation' },
  { id: 'plan',    command: '/plan',    description: 'Switch to plan mode' },
];

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface SlashCommandMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (command: string) => void;
  /** Text typed after the "/" — used to filter commands */
  searchText: string;
  /** Ref to the anchor element (textarea) for positioning */
  anchorRef: React.RefObject<HTMLElement | null>;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function SlashCommandMenu({
  isOpen,
  onClose,
  onSelect,
  searchText,
  anchorRef,
}: SlashCommandMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Filter commands by searchText
  const filtered = searchText
    ? SLASH_COMMANDS.filter(
        (c) =>
          c.command.toLowerCase().includes(searchText.toLowerCase()) ||
          c.description.toLowerCase().includes(searchText.toLowerCase()),
      )
    : SLASH_COMMANDS;

  // Reset selection on open or search change
  useLayoutEffect(() => {
    setSelectedIndex(0);
  }, [isOpen, searchText]);

  // Clamp selectedIndex when filtered list shrinks
  useLayoutEffect(() => {
    if (filtered.length > 0 && selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  const handleSelect = useCallback(
    (command: string) => {
      onSelect(command);
      onClose();
    },
    [onSelect, onClose],
  );

  // Keyboard navigation — capture phase so it fires before the textarea
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          e.stopImmediatePropagation();
          if (filtered.length > 0) setSelectedIndex((p) => (p + 1) % filtered.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          e.stopImmediatePropagation();
          if (filtered.length > 0) setSelectedIndex((p) => (p - 1 + filtered.length) % filtered.length);
          break;
        case 'Enter':
          if (e.shiftKey) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          if (filtered[selectedIndex]) handleSelect(filtered[selectedIndex].command);
          break;
        case 'Tab':
          e.preventDefault();
          e.stopImmediatePropagation();
          if (filtered[selectedIndex]) handleSelect(filtered[selectedIndex].command);
          break;
        case 'Escape':
          e.preventDefault();
          e.stopImmediatePropagation();
          onClose();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, filtered, selectedIndex, handleSelect, onClose]);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!isOpen || !dropdownRef.current) return;
    const items = dropdownRef.current.querySelectorAll('[data-slash-index]');
    const el = items[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, isOpen]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Position above anchor
  const anchor = anchorRef.current;
  const rect = anchor?.getBoundingClientRect();
  const top = rect ? rect.top : 0;
  const left = rect ? rect.left : 0;

  const DROPDOWN_WIDTH = 300;
  const safeLeft = Math.min(left, window.innerWidth - DROPDOWN_WIDTH - 8);

  return createPortal(
    <Card
      ref={dropdownRef}
      variant="popover"
      padding="xs"
      style={{
        position: 'fixed',
        bottom: rect ? window.innerHeight - top + 8 : undefined,
        top: rect ? undefined : '50%',
        left: Math.max(8, safeLeft),
        width: `${DROPDOWN_WIDTH}px`,
        zIndex: 99999,
        maxHeight: '200px',
        overflowY: 'auto',
      }}
      role="listbox"
      aria-label="Message shortcuts"
    >
      <Container layout="vertical" gap="none">
        <Text variant="label" color="ghost" as="p" style={{ paddingInline: '8px', paddingBlock: '4px' }}>
          Shortcuts
        </Text>
        {filtered.map((cmd, index) => {
          const isSelected = selectedIndex === index;
          return (
            <Card
              key={cmd.id}
              variant={isSelected ? 'nested' : 'ghost'}
              padding="none"
              interactive={!isSelected}
              data-slash-index={index}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(cmd.command);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              role="option"
              aria-selected={isSelected}
              style={{ cursor: 'pointer', padding: '4px 6px' }}
            >
              <Container layout="horizontal" gap="sm" alignItems="center">
                <Text variant="label" weight="semibold" color="white">{cmd.command}</Text>
                <Text variant="caption" color="ghost" truncate>{cmd.description}</Text>
              </Container>
            </Card>
          );
        })}
        {filtered.length === 0 && (
          <Text variant="label" color="ghost" as="p" style={{ padding: '6px' }}>
          {searchText ? `No shortcuts matching "${searchText}"` : 'No shortcuts available'}
          </Text>
        )}
      </Container>
    </Card>,
    document.body,
  );
}
