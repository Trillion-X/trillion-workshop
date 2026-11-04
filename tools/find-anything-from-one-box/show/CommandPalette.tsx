// packages/command-palette/show/CommandPalette.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Floating glassmorphism command palette overlay. Renders a search input at top,
// grouped results below with type icons and match highlighting. Implements
// full keyboard navigation (arrow keys, Enter, Escape) and a focus trap.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Overlay uses design-system-guide.md glassmorphism: bg-[#11111198], backdrop-blur-md
// 2. Focus trap: Tab cycles within the palette, never escapes to background
// 3. Input auto-focuses on open
// 4. Results grouped by CommandItemType with section headers
// 5. Match characters highlighted with bold
// 6. Selected result has visible focus ring
// 7. Multi-select via Cmd/Ctrl+Click; aria-selected reflects both single and multi state
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useRef, Fragment } from 'react';
import { groupResults } from './read-palette-results';
import { matchRanges } from './match-ranges';
import type { PaletteSearchResult } from './palette-types';
import { Button } from '../../ui/show/button';
import { BulkSelectBar } from '../../ui/show/bulk-select-bar/BulkSelectBar';
import { Container } from '../../ui/show/container';
import { Input } from '../../ui/show/input';
import { NamedIcon } from '../../ui/show/icon';
import { Kbd } from '../../ui/show/kbd';
import { PickerTile } from '../../ui/show/picker-tile';
import { Spinner } from '../../ui/show/spinner/Spinner';
import { Text } from '../../ui/show/text';
import { TextColumn } from '../../ui/show/text-column';
import { FloatingPanel } from '../../screen-arrangement/show/FloatingPanel';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

/** The window the palette is drawn in: FloatingPanel by default, or the caller's own (a screen in a layer). */
export interface CommandPaletteFrameProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly label: string;
  readonly width: number;
  readonly children: React.ReactNode;
}

interface CommandPaletteProps {
  readonly frame?: React.ComponentType<CommandPaletteFrameProps>;
  /** Wraps each drawn result (a hover preview around it); the result is drawn as is when left out. */
  readonly wrapResult?: (result: PaletteSearchResult, row: React.ReactElement) => React.ReactNode;
  readonly open: boolean;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly results: readonly PaletteSearchResult[];
  readonly selectedIndex: number;
  readonly isLoading: boolean;
  /** A source still searches some places; an empty answer is not final. */
  readonly isStillLooking?: boolean;
  readonly onClose: () => void;
  readonly onSelectIndex: (index: number) => void;
  readonly onKeyDown: (e: React.KeyboardEvent) => void;
  readonly selectedItems?: ReadonlySet<string>;
  readonly onToggleItemSelection?: (itemId: string) => void;
  readonly selectedCount?: number;
  readonly onClearSelection?: () => void;
  readonly bulkSelectActions?: Array<{
    readonly label: string;
    readonly variant?: 'default' | 'destructive' | 'secondary';
    readonly disabled?: boolean;
    readonly onClick: () => void;
  }>;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Read media family generically from item's raw payload using MIME-prefix keying.
 * Looks for common MIME type fields (mime_type, media_type, content_type, type).
 * Returns the family (video/audio/image/...) or 'unknown' as fallback.
 * This is a generic, domain-agnostic lookup — no hardcoded media vocabulary.
 */
function getMediaFamilyFromRaw(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return 'unknown';
  const record = raw as Record<string, unknown>;

  // Try common MIME-type field names
  for (const key of ['mime_type', 'media_type', 'content_type', 'type']) {
    const value = record[key];
    if (typeof value === 'string') {
      // Extract the family prefix (e.g., 'video' from 'video/mp4')
      const family = value.split('/')[0].toLowerCase();
      if (family && family.length > 0) {
        return family;
      }
    }
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// MATCH HIGHLIGHT RENDERER
// ---------------------------------------------------------------------------

/**
 * Render text with matched character ranges highlighted in bold and the warning tone.
 * Indices are [start, end] inclusive pairs returned by the routed target.
 */
function HighlightedText({
  text,
  indices,
}: {
  readonly text: string;
  readonly indices: ReadonlyArray<readonly [number, number]>;
}) {
  if (indices.length === 0) {
    return <>{text}</>;
  }

  const parts: Array<{ text: string; highlight: boolean }> = [];
  let lastEnd = 0;

  for (const [start, end] of indices) {
    if (start > lastEnd) {
      parts.push({ text: text.slice(lastEnd, start), highlight: false });
    }
    parts.push({ text: text.slice(start, end + 1), highlight: true });
    lastEnd = end + 1;
  }

  if (lastEnd < text.length) {
    parts.push({ text: text.slice(lastEnd), highlight: false });
  }

  return (
    <>
      {parts.map((part, i) =>
        part.highlight ? (
          <Text key={i} variant="body-xs" as="span" weight="semibold" color="warning">
            {part.text}
          </Text>
        ) : (
          <Text key={i} variant="body-xs" as="span">
            {part.text}
          </Text>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// RESULT ITEM
// ---------------------------------------------------------------------------

function ResultItem({
  result,
  isSelected,
  onSelect,
  isMultiSelected,
  onToggleSelection,
}: {
  readonly result: PaletteSearchResult;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
  readonly isMultiSelected?: boolean;
  readonly onToggleSelection?: (itemId: string) => void;
}) {
  const { item, matches } = result;
  // A result that names its own icon (`icon` on its row) draws it; otherwise its group's first letter.
  const named = item.raw && typeof item.raw === 'object' && typeof (item.raw as { icon?: unknown }).icon === 'string'
    ? (item.raw as { icon: string }).icon
    : null;
  const icon = item.group.slice(0, 1).toUpperCase();

  // Extract match indices for title and description
  const titleMatch = matches.find((m) => m.key === 'title') ?? { indices: matchRanges(result.queryText, item.title) };
  const descMatch = matches.find((m) => m.key === 'description') ?? { indices: matchRanges(result.queryText, item.description) };

  // Multi-select handler: Cmd/Ctrl+Click toggles selection, normal click selects
  const handleClick = (e: React.MouseEvent) => {
    const isMeta = e.metaKey || e.ctrlKey;
    if (isMeta && onToggleSelection) {
      onToggleSelection(item.id);
    } else {
      onSelect();
    }
  };

  // render_hint is a DATA field carried on the item (populated from the
  // owning descriptor's `result_mapping.render_hint`). The palette does not
  // know which source produced the row — it only knows which renderer a
  // hint string selects. Any unrecognized/absent hint falls back to the
  // default row renderer below, so new hints are additive, never branching
  // on domain identity.
  // A row reads as selected when the keyboard is on it or it is one of several picked; an empty multi-pick set leaves
  // the keyboard's row selected.
  const ariaSelected = isSelected || Boolean(isMultiSelected);
  if (item.renderHint === 'tile') {
    const family = getMediaFamilyFromRaw(item.raw);
    return (
      <PickerTile
        title={item.title}
        subtitle={item.description || undefined}
        family={family}
        compact
        onClick={handleClick}
        selected={ariaSelected}
        aria-label={item.title}
        aria-selected={ariaSelected}
      />
    );
  }

  return (
    <Button
      variant="ghost"
      size="option-row"
      onClick={handleClick}
      role="option"
      aria-selected={ariaSelected ? 'true' : 'false'}
      active={ariaSelected}
    >
      <Container layout="horizontal" gap="sm" alignItems="start" flex="1">
        {named ? (
          <NamedIcon name={named} size="sm" />
        ) : (
          <Text variant="body" as="span" mono color="subtle">
            {icon}
          </Text>
        )}
        <TextColumn>
          <Text variant="body" truncate>
            <HighlightedText
              text={item.title}
              indices={titleMatch.indices}
            />
          </Text>
          {item.description && (
            <Text variant="body-xs" color="subtle" truncate>
              <HighlightedText
                text={item.description}
                indices={descMatch.indices}
              />
            </Text>
          )}
        </TextColumn>
      </Container>
    </Button>
  );
}

// ---------------------------------------------------------------------------
// COMMAND PALETTE COMPONENT
// ---------------------------------------------------------------------------

export function CommandPalette({
  frame: Frame = FloatingPanel,
  wrapResult,
  open,
  query,
  onQueryChange,
  results,
  selectedIndex,
  isLoading,
  isStillLooking = false,
  onClose,
  onSelectIndex,
  onKeyDown,
  selectedItems,
  onToggleItemSelection,
  selectedCount,
  onClearSelection,
  bulkSelectActions,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Auto-focus input when palette opens
  useEffect(() => {
    if (open) {
      // Small delay to ensure the element is mounted
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Scroll selected result into view
  useEffect(() => {
    if (!resultsRef.current) return;
    const selected = resultsRef.current.querySelector('[aria-selected="true"]');
    if (selected && typeof (selected as any).scrollIntoView === 'function') {
      (selected as any).scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const grouped = open ? groupResults(results) : new Map<string, PaletteSearchResult[]>();

  // Flatten for index tracking across groups
  let flatIndex = 0;

  return (
    <Frame
      open={open}
      onClose={onClose}
      label="Search"
      width={672}
    >
      {/* Bulk select bar (appears above input when items selected) */}
      {selectedCount !== undefined && selectedCount > 0 && onClearSelection && (
        <BulkSelectBar
          selectedCount={selectedCount}
          onClearAll={onClearSelection}
          actions={bulkSelectActions ?? []}
          placement="top"
        />
      )}

      {/* Search input */}
      <Container padding="lg" border="bottom">
        <Input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search or ask..."
          aria-label="Find anything"
          aria-controls="palette-results"
          aria-activedescendant={
            results.length > 0 ? `palette-item-${selectedIndex}` : undefined
          }
          role="combobox"
          aria-expanded={results.length > 0}
          aria-haspopup="listbox"
        />
      </Container>

      {/* Results */}
      <Container
        ref={resultsRef}
        id="palette-results"
        overflow="y-auto"
        padding="sm"
        layout="vertical"
        maxHeight="60vh"
        role="listbox"
        style={{ position: 'relative' }}
      >
        {/* Loading overlay (covers results pane) */}
        {isLoading && results.length === 0 && (
          <Container
            padding="lg"
            layout="vertical"
            alignItems="center"
            justifyContent="center"
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 50,
              background: 'rgba(0, 0, 0, 0.5)',
              backdropFilter: 'blur(2px)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <Spinner size="md" aria-label="Loading palette results" />
            <Text variant="body-sm" color="secondary">
              Looking...
            </Text>
          </Container>
        )}

        {!isLoading && query.trim() && isStillLooking && (
          <Container padding={results.length ? 'sm' : 'lg'} layout="horizontal" alignItems="center" justifyContent="center" gap="sm" data-palette-still-looking="">
            <Spinner size="sm" aria-label="Still looking" />
            <Text variant="body-sm" color="faint">Still looking for &ldquo;{query}&rdquo;</Text>
          </Container>
        )}

        {!isLoading && query.trim() && results.length === 0 && !isStillLooking && (
          <Container padding="lg" layout="vertical" alignItems="center" justifyContent="center">
            <Text variant="body" color="faint">
              No results for &ldquo;{query}&rdquo;
            </Text>
          </Container>
        )}

        {!isLoading && !query.trim() && results.length === 0 && (
          <Container padding="lg" layout="vertical" alignItems="center" justifyContent="center">
            <Text variant="body" color="faint">
              Type to find a screen, a file, an AI or a person.
            </Text>
          </Container>
        )}

        {Array.from(grouped.entries()).map(([type, groupResults]) => {
          return (
            <Fragment key={type}>
              {/* Section header */}
              <Container padding="md" layout="vertical">
                <Text variant="label" color="faint">
                  <Text variant="label" color="faint" as="span">{type}</Text>{' '}
                  <Text variant="label" color="faint" as="span" data-group-count="">{groupResults.length}</Text>
                </Text>
              </Container>

              {/* Section results */}
              {groupResults.map((result) => {
                const currentIndex = flatIndex++;
                const isMultiSelected = selectedItems?.has(result.item.id);
                const row = (
                  <ResultItem
                    key={result.item.id}
                    result={result}
                    isSelected={currentIndex === selectedIndex}
                    onSelect={() => onSelectIndex(currentIndex)}
                    isMultiSelected={isMultiSelected}
                    onToggleSelection={onToggleItemSelection}
                  />
                );
                return wrapResult ? <Fragment key={result.item.id}>{wrapResult(result, row)}</Fragment> : row;
              })}
            </Fragment>
          );
        })}
      </Container>

      {/* Footer with shortcut hints */}
      <Container border="top" padding="md" layout="horizontal" gap="lg" alignItems="center">
        <Text variant="body-xs" color="secondary">
          <Kbd size="sm">
            &uarr;&darr;
          </Kbd>
          {' '}navigate
        </Text>
        <Text variant="body-xs" color="secondary">
          <Kbd size="sm">
            Enter
          </Kbd>
          {' '}select
        </Text>
        <Text variant="body-xs" color="secondary">
          <Kbd size="sm">
            Esc
          </Kbd>
          {' '}close
        </Text>
      </Container>
    </Frame>
  );
}
