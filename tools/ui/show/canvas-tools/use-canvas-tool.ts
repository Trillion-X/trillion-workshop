// packages/ui/show/canvas-tools/use-canvas-tool.ts
//
// The active-tool state owner. Holds the persistent active tool, tracks Space-
// held / middle-button for temporary overrides, binds keyboard shortcuts, and
// exposes the pure interpreter as `resolveIntent(hit, phase, chord)` so a canvas
// has ONE place to ask "what does this gesture mean right now."
//
// GENERIC: speaks only the tool registry (DATA) + the pure resolvers. Zero
// knowledge of boards/items/workflows. A board, a workflow canvas, and any
// future canvas all use this one hook; new tools are DATA rows, not new code.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CANVAS_TOOLS,
  TEMPORARY_TOOLS,
  chordOf,
  resolveIntent as resolveIntentPure,
  resolveTemporaryTool,
  toolForShortcut,
} from './canvas-tools';
import type {
  CanvasHit,
  CanvasHitKind,
  CanvasIntent,
  CanvasToolDescriptor,
  GestureChord,
  GesturePhase,
  TemporaryToolRule,
} from './canvas-tool-types';

export interface UseCanvasToolOptions {
  tools?: readonly CanvasToolDescriptor[];
  temporaryTools?: readonly TemporaryToolRule[];
  initialToolId?: string;
  /** Disable shortcut/Space key binding (e.g. when the canvas is not focused). */
  bindKeys?: boolean;
}

export interface CanvasToolApi {
  tools: readonly CanvasToolDescriptor[];
  activeToolId: string;
  setActiveTool: (id: string) => void;
  /** The persistent active tool descriptor. */
  activeTool: CanvasToolDescriptor;
  /** True while Space is held (drives the temporary hand override). */
  spaceHeld: boolean;
  /**
   * The tool that ACTUALLY governs a gesture right now, accounting for temporary
   * overrides (Space → hand, middle-button → hand). Pass the pointer button for
   * button-based rules; omit for the idle/cursor case.
   */
  effectiveTool: (opts?: { button?: GestureChord['button']; inTextInput?: boolean }) => CanvasToolDescriptor;
  /** Resolve a gesture to its intent through the effective tool. */
  resolveIntent: (hit: CanvasHit, phase: GesturePhase, chord: GestureChord) => CanvasIntent;
  /** Build a chord from a PointerEvent (folds in current spaceHeld). */
  chord: (event: PointerEvent) => GestureChord;
}

/** True if the active element is a text-entry surface (so Space/shortcuts pass through). */
function inTextInputNow(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

export function useCanvasTool(options: UseCanvasToolOptions = {}): CanvasToolApi {
  const tools = options.tools ?? CANVAS_TOOLS;
  const temporaryTools = options.temporaryTools ?? TEMPORARY_TOOLS;
  const bindKeys = options.bindKeys ?? true;
  const [activeToolId, setActiveToolId] = useState(options.initialToolId ?? tools[0]?.id ?? '');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceRef = useRef(false);

  const setActiveTool = useCallback((id: string) => setActiveToolId(id), []);

  const activeTool = useMemo(
    () => tools.find((t) => t.id === activeToolId) ?? tools[0],
    [tools, activeToolId],
  );

  const effectiveTool = useCallback(
    (opts?: { button?: GestureChord['button']; inTextInput?: boolean }) =>
      resolveTemporaryTool(
        { spaceHeld: spaceRef.current, button: opts?.button, inTextInput: opts?.inTextInput },
        activeToolId,
        tools,
        temporaryTools,
      ),
    [activeToolId, tools, temporaryTools],
  );

  const resolveIntent = useCallback(
    (hit: CanvasHit, phase: GesturePhase, chord: GestureChord): CanvasIntent => {
      const tool = resolveTemporaryTool(
        { spaceHeld: chord.spaceHeld, button: chord.button, inTextInput: false },
        activeToolId,
        tools,
        temporaryTools,
      );
      return resolveIntentPure(tool, hit.kind as CanvasHitKind, phase);
    },
    [activeToolId, tools, temporaryTools],
  );

  const chord = useCallback((event: PointerEvent) => chordOf(event, spaceRef.current), []);

  // Keyboard: Space → temporary hand; single keys → activate the tool that owns them.
  useEffect(() => {
    if (!bindKeys || typeof window === 'undefined') return;
    const onDown = (e: KeyboardEvent) => {
      if (inTextInputNow()) return;
      if (e.key === ' ') {
        if (!spaceRef.current) {
          spaceRef.current = true;
          setSpaceHeld(true);
        }
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tool = toolForShortcut(e.key, tools);
      if (tool) {
        setActiveToolId(tool.id);
        e.preventDefault();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        spaceRef.current = false;
        setSpaceHeld(false);
      }
    };
    const onBlur = () => {
      spaceRef.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [bindKeys, tools]);

  return {
    tools,
    activeToolId,
    setActiveTool,
    activeTool,
    spaceHeld,
    effectiveTool,
    resolveIntent,
    chord,
  };
}
