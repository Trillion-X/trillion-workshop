// packages/addressed-marks/show/MarkSessionContext.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Owner of the ephemeral drawing session: whether drawing is active and which
// tool/style records the next operation references. Mark vocabulary lives in
// the addressed-marks package; arrangement/space owners only mount the
// provider and consume the hook (L098 — callers speak their own language,
// marks own mark state).
//
// Session state is ephemeral UI state. Mark truth (operations/styles/tools)
// stays in admitted records in current log state.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No persistence here — records own truth, this owns the live session only
// 2. toolRef/styleRef are record ids (data), never hardcoded behavior
// 3. Any package may mount the provider; nothing here knows who mounted it
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client';

import React from 'react';
import type { MarkOperationRecord, MarkTarget } from '../read-data/addressed-marks';

export interface MarkSession {
  /** Drawing input is active (the input layer captures pointer events). */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** Where the space owner takes strokes (an id the owner gives meaning, such as one pane or the whole screen;
   *  '' = the owner's own default). This package never interprets it. */
  area: string;
  /** Turn drawing on in one area (or off with enabled false). */
  drawIn: (area: string, enabled?: boolean) => void;
  /** Active tool record id ('' = first available tool). */
  toolRef: string;
  setToolRef: (toolRef: string) => void;
  /** Active style record id ('' = first available style). */
  styleRef: string;
  setStyleRef: (styleRef: string) => void;
  /** Optional per-session stroke width override in screen px (null = style's width). */
  strokeWidth: number | null;
  setStrokeWidth: (strokeWidth: number | null) => void;
  /** When true, recorded shapes carry a fill (the active style's color) as operation-local style data. */
  fillEnabled: boolean;
  setFillEnabled: (fillEnabled: boolean) => void;
  /** Display toggle: when false, mark display layers render nothing (ink stays in the log, untouched). */
  marksVisible: boolean;
  setMarksVisible: (marksVisible: boolean) => void;
  /**
   * Operations recorded this session that may not be in the live feed yet.
   * Display layers merge these (by id) with feed operations so ink never
   * blinks out between pointer-up and log materialization.
   */
  optimisticOperations: readonly MarkOperationRecord[];
  addOptimisticOperation: (operation: MarkOperationRecord) => void;
  /** The target of the most recent recorded operation (undo/clear scope). */
  lastTarget: MarkTarget | null;
  setLastTarget: (target: MarkTarget | null) => void;
}

export const MarkSessionContext = React.createContext<MarkSession | null>(null);

export function useMarkSession(): MarkSession | null {
  return React.useContext(MarkSessionContext);
}

export function MarkSessionProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = React.useState(false);
  const [area, setArea] = React.useState('');
  const [toolRef, setToolRef] = React.useState('');
  const [styleRef, setStyleRef] = React.useState('');
  const [strokeWidth, setStrokeWidth] = React.useState<number | null>(null);
  const [fillEnabled, setFillEnabled] = React.useState(false);
  const [marksVisible, setMarksVisible] = React.useState(true);
  const [optimisticOperations, setOptimisticOperations] = React.useState<readonly MarkOperationRecord[]>([]);
  const [lastTarget, setLastTarget] = React.useState<MarkTarget | null>(null);

  const addOptimisticOperation = React.useCallback((operation: MarkOperationRecord) => {
    setOptimisticOperations((current) => [...current, operation]);
  }, []);

  // Drawing implies seeing: enabling the session always restores visibility.
  const setEnabledAndShow = React.useCallback((nextEnabled: boolean) => {
    setEnabled(nextEnabled);
    if (nextEnabled) setMarksVisible(true);
  }, []);

  const drawIn = React.useCallback((nextArea: string, nextEnabled = true) => {
    setArea(nextArea);
    setEnabledAndShow(nextEnabled);
  }, [setEnabledAndShow]);

  const session = React.useMemo<MarkSession>(() => ({
    enabled,
    setEnabled: setEnabledAndShow,
    area,
    drawIn,
    toolRef,
    setToolRef,
    styleRef,
    setStyleRef,
    strokeWidth,
    setStrokeWidth,
    fillEnabled,
    setFillEnabled,
    marksVisible,
    setMarksVisible,
    optimisticOperations,
    addOptimisticOperation,
    lastTarget,
    setLastTarget,
  }), [enabled, setEnabledAndShow, area, drawIn, toolRef, styleRef, strokeWidth, fillEnabled, marksVisible, optimisticOperations, addOptimisticOperation, lastTarget]);

  return (
    <MarkSessionContext.Provider value={session}>
      {children}
    </MarkSessionContext.Provider>
  );
}
