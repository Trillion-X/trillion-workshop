// packages/command-palette/show/CommandPaletteGate.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Feature-owned runtime gate for the command palette. It asks the existing slot
// graph for bounded blank items or descriptor-owned text results, renders replies it can use, and sends selected
// replies back to the producer target.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No sibling package feeds or screen-arrangement React context
// 2. Ranking is slot-composed, not local browser scoring
// 3. Search remains debounced at 100ms; workflow requests are cancellable
// 4. Selection uses target invocation or the generic placeable-surface intent
// 5. Opening asks the same workflow graph for empty-query suggestions
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CommandPalette, type CommandPaletteFrameProps } from './CommandPalette';
import { LoadingOverlay } from '../../ui/show/loading-overlay/LoadingOverlay';
import {
  askCurrentItemsForBlankPalette,
} from '../do-work/ask-current-items-ranked-by-text';
import {
  askAllPaletteSourcesByText,
  askPaletteSourceDescriptors,
  type PaletteSourceDescriptor,
} from '../do-work/ask-palette-sources-by-text';
import {
  askPaletteBulkActionDescriptors,
  runPaletteBulkAction,
  type PaletteBulkActionDescriptor,
} from '../do-work/ask-palette-bulk-actions-by-descriptor';
import {
  runSelectedPaletteResult,
} from '../do-work/run-selected-palette-result';
import {
  readPaletteResultsFromReplies,
} from './read-palette-results';
import type {
  PaletteSearchResult,
} from './palette-types';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/** Debounce delay in milliseconds for search input. */
const SEARCH_DEBOUNCE_MS = 100;
const MAX_PALETTE_RESULTS = 30;
const STILL_LOOKING_EVERY_MS = 4000;
const STILL_LOOKING_ASKS = 8;

export interface CommandPaletteGateProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The window the palette is drawn in; FloatingPanel when left out. */
  readonly frame?: React.ComponentType<CommandPaletteFrameProps>;
  /** Wraps each drawn result (a hover preview around it). */
  readonly wrapResult?: (result: PaletteSearchResult, row: React.ReactElement) => React.ReactNode;
}

export function CommandPaletteGate({ open, onOpenChange, frame, wrapResult }: CommandPaletteGateProps) {
  const [query, setQueryRaw] = useState('');
  const [results, setResults] = useState<PaletteSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isStillLooking, setIsStillLooking] = useState(false);
  const stillLookingAsksRef = useRef(0);
  // Multi-select state: tracks selected item IDs for bulk actions
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  // Bulk action state: descriptors for the current selection, and running action IDs
  const [bulkActionDescriptors, setBulkActionDescriptors] = useState<PaletteBulkActionDescriptor[]>([]);
  const [runningBulkActionIds, setRunningBulkActionIds] = useState<Set<string>>(new Set());

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sourceDescriptorsRef = useRef<readonly PaletteSourceDescriptor[] | null>(null);
  const askForResultsRef = useRef<(query: string, debounceMs: number, again?: boolean) => void>(() => {});

  useEffect(() => {
    if (!open || sourceDescriptorsRef.current) return;
    askPaletteSourceDescriptors().then((descriptors) => {
      sourceDescriptorsRef.current = descriptors;
    }).catch(() => {
      sourceDescriptorsRef.current = [];
    });
  }, [open]);

  const resetPalette = useCallback(() => {
    setQueryRaw('');
    setResults([]);
    setSelectedIndex(0);
    setIsLoading(false);
    setIsStillLooking(false);
    stillLookingAsksRef.current = 0;
    setSelectedItems(new Set());
    setBulkActionDescriptors([]);
    setRunningBulkActionIds(new Set());
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, []);

  const askForResults = useCallback((nextQuery: string, debounceMs: number, again = false) => {
    if (!again) {
      stillLookingAsksRef.current = 0;
      setIsStillLooking(false);
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    if (!again) setIsLoading(true);

    debounceRef.current = setTimeout(() => {
      const abortController = new AbortController();
      abortRef.current = abortController;
      const trimmed = nextQuery.trim();

      const query = trimmed.length === 0
        ? askCurrentItemsForBlankPalette(MAX_PALETTE_RESULTS, abortController.signal).then((reply) => [reply])
        : askAllPaletteSourcesByText(
          sourceDescriptorsRef.current ?? [], trimmed, abortController.signal,
        );
      query.then((replies) => {
        if (abortController.signal.aborted) return;
        setResults(
          readPaletteResultsFromReplies(replies, trimmed),
        );
        const stillLooking = trimmed.length > 0 && replies.some((reply) => reply.stillLooking === true);
        setIsStillLooking(stillLooking);
        setIsLoading(false);
        if (stillLooking && stillLookingAsksRef.current < STILL_LOOKING_ASKS) {
          stillLookingAsksRef.current += 1;
          askForResultsRef.current(nextQuery, STILL_LOOKING_EVERY_MS, true);
        }
      }).catch((error: unknown) => {
        if (abortController.signal.aborted) return;
        console.error('[command-palette] source query failed:', error);
        setResults([]);
        setIsStillLooking(false);
        setIsLoading(false);
      });
    }, debounceMs);
  }, []);
  askForResultsRef.current = askForResults;

  const closePalette = useCallback(() => {
    resetPalette();
    onOpenChange(false);
  }, [onOpenChange, resetPalette]);

  useEffect(() => {
    resetPalette();
    if (open) askForResults('', 0);
  }, [askForResults, open, resetPalette]);

  const setQuery = useCallback(
    (nextQuery: string) => {
      setQueryRaw(nextQuery);
      setSelectedIndex(0);
      setIsStillLooking(false);
      askForResults(nextQuery, SEARCH_DEBOUNCE_MS);
    },
    [askForResults],
  );

  const selectResult = useCallback((result: PaletteSearchResult | undefined) => {
    if (!result) return;
    void runSelectedPaletteResult(result);
    closePalette();
  }, [closePalette]);

  const selectCurrent = useCallback(() => {
    selectResult(results[selectedIndex]);
  }, [results, selectedIndex, selectResult]);

  const selectIndex = useCallback((index: number) => {
    setSelectedIndex(index);
    selectResult(results[index]);
  }, [results, selectResult]);

  const toggleItemSelection = useCallback((itemId: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  // Load bulk action descriptors based on the groups of selected items
  useEffect(() => {
    if (selectedItems.size === 0) {
      setBulkActionDescriptors([]);
      return;
    }

    const selectedResults = results.filter((r) => selectedItems.has(r.item.id));
    const groups = new Set(selectedResults.map((r) => r.item.group));

    askPaletteBulkActionDescriptors(Array.from(groups))
      .then((descriptors) => setBulkActionDescriptors(descriptors))
      .catch(() => setBulkActionDescriptors([]));
  }, [selectedItems, results]);

  const handleClearSelection = useCallback(() => {
    setSelectedItems(new Set());
  }, []);

  const handleBulkAction = useCallback(
    (descriptor: PaletteBulkActionDescriptor) => {
      const selectedResults = results.filter((r) => selectedItems.has(r.item.id));
      const selectedRaw = selectedResults.map((r) => r.item.raw);

      setRunningBulkActionIds((prev) => new Set(prev).add(descriptor.id));

      runPaletteBulkAction(descriptor, selectedRaw)
        .then(() => {
          // On success, clear the selection and refresh
          handleClearSelection();
        })
        .catch((error: unknown) => {
          console.error('[command-palette] bulk action failed:', error);
        })
        .finally(() => {
          setRunningBulkActionIds((prev) => {
            const next = new Set(prev);
            next.delete(descriptor.id);
            return next;
          });
        });
    },
    [results, selectedItems, handleClearSelection],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) =>
            results.length === 0 ? 0 : (prev + 1) % results.length,
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) =>
            results.length === 0
              ? 0
              : (prev - 1 + results.length) % results.length,
          );
          break;
        case 'Enter':
          e.preventDefault();
          selectCurrent();
          break;
        case 'Escape':
          e.preventDefault();
          closePalette();
          break;
      }
    },
    [closePalette, results.length, selectCurrent],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // Transform descriptors into BulkSelectBar actions
  const bulkSelectActions = bulkActionDescriptors.map((descriptor) => ({
    label: descriptor.label,
    variant: descriptor.variant || 'default' as const,
    disabled: runningBulkActionIds.has(descriptor.id),
    onClick: () => handleBulkAction(descriptor),
  }));

  const isRunningBulkAction = runningBulkActionIds.size > 0;
  const runningActionLabel = bulkActionDescriptors.find(
    (d) => runningBulkActionIds.has(d.id),
  )?.label;

  return (
    <>
      {isRunningBulkAction ? (
        <LoadingOverlay
          title={runningActionLabel || 'Processing...'}
          subtitle={`${selectedItems.size} item${selectedItems.size === 1 ? '' : 's'} selected`}
        />
      ) : null}
      <CommandPalette
        frame={frame}
        wrapResult={wrapResult}
        open={open}
        query={query}
        onQueryChange={setQuery}
        results={results}
        selectedIndex={selectedIndex}
        isLoading={isLoading}
        isStillLooking={isStillLooking}
        onClose={closePalette}
        onSelectIndex={selectIndex}
        onKeyDown={onKeyDown}
        selectedItems={selectedItems}
        onToggleItemSelection={toggleItemSelection}
        selectedCount={selectedItems.size}
        onClearSelection={handleClearSelection}
        bulkSelectActions={bulkSelectActions}
      />
    </>
  );
}

export function CommandPaletteRoot() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const openFromKeyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };

    window.addEventListener('keydown', openFromKeyboard);
    return () => window.removeEventListener('keydown', openFromKeyboard);
  }, []);

  return <CommandPaletteGate open={open} onOpenChange={setOpen} />;
}
