// packages/addressed-marks/show/use-mark-data.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Shared mark data reads for every addressed-marks surface/layer. Reads the
// package inputs (mark-operations / mark-styles / mark-tools) through the
// mounting entry's generated read scope. Entries that consume mark layers
// declare the cross-package read dependency as DATA in their package's
// entry-read-scope-packages.json — see screen-arrangement for the canonical
// declaration. Entries without the declaration degrade to empty data instead
// of crashing (unknown-reader tolerance), but persistence REQUIRES the
// declaration: the band-aid is not the contract.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client';

import React from 'react';
import { useBitfieldData } from '#workspace-records';
import {
  readMarkOperationRecords,
  readMarkStyles,
  readMarkTools,
  type MarkOperationRecord,
  type MarkStyleRecord,
  type MarkToolRecord,
} from '../read-data/addressed-marks';
import starting from '../starting-marks.json';
// Loading any mark surface starts the one keeper of ink, colours and tools.
import './keep-marks';
import { useShownMarks } from './shown-marks';

export function useOptionalBitfieldData(selector: string): unknown {
  try {
    return useBitfieldData<unknown>(selector);
  } catch (error) {
    if (error instanceof Error && error.message.includes(`no input named "${selector}"`)) {
      return [];
    }
    throw error;
  }
}

export function useMarkOperations(): readonly MarkOperationRecord[] {
  const raw = useOptionalBitfieldData('mark-operations');
  const shown = useShownMarks();
  // The person's kept ink, then the marks shown on this page and never kept (shown-marks.ts).
  return React.useMemo(() => readMarkOperationRecords(shown.length ? [raw ?? [], ...shown] : raw), [raw, shown]);
}

/** The starting rows, then the person's saved rows: a saved row with a starting row's id replaces it. */
function withStarting(first: readonly unknown[], saved: unknown): unknown[] {
  const own = Array.isArray(saved) ? saved : [];
  const ids = new Set(own.map((row) => (row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined)));
  return [...first.filter((row) => !ids.has((row as { id?: unknown }).id)), ...own];
}

export function useMarkStyles(): readonly MarkStyleRecord[] {
  const raw = useOptionalBitfieldData('mark-styles');
  return React.useMemo(() => readMarkStyles(withStarting(starting.styles, raw)), [raw]);
}

export function useMarkTools(): readonly MarkToolRecord[] {
  const raw = useOptionalBitfieldData('mark-tools');
  return React.useMemo(() => readMarkTools(withStarting(starting.tools, raw)), [raw]);
}
