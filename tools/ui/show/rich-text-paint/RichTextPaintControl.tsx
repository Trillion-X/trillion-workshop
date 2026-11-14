// packages/ui/show/rich-text-paint/RichTextPaintControl.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The toolbar control that gives a run of text the SAME infinite paint a card
// region gets: solid colour, gradient, mesh, grain/tint, edge — composed in the
// SHARED `LayerStackEditor` (the exact editor used for board items and regions,
// #78) and clipped to the glyphs. No 12-swatch palette, no closed font list:
// infinite colour, infinite gradient, infinite mesh, angles and borders on the
// text — or on a single selected letter (a user's requirement).
//
// =============================================================================
// HOW IT STAYS GENERIC + DECOUPLED
// =============================================================================
// • It reuses the visual-layer-stack capability map + LayerStackEditor verbatim.
//   The capabilities offered are filtered by CAPABILITY-DECLARED text support
//   (`resolveCssPaint` for fills / `resolveStyle` for operators) — never by id
//   (Codex correction F). A new text-paintable fill appears here automatically.
// • It is editor-agnostic: it takes the contentEditable root via a ref + an
//   `onCommit(root)` the host wires to persist innerHTML. It never imports the
//   board, the note, or documents (L098 / package isolation).
// • Selection survival: the trigger fires on pointer-DOWN + preventDefault so the
//   editor keeps its selection; on open we wrap the selection ONCE into a paint
//   span and patch THAT span as the stack is edited (no repeated range surgery).
// =============================================================================

import React from 'react';
import { Palette } from 'lucide-react';
import { Button } from '../button';
import { Icon } from '../icon';
import { AnchoredOverlay } from '../anchored-overlay';
import {
  LayerStackEditor,
  createCapabilityMap,
  composeStackTextStyle,
} from '../visual-layer-stack';
import type { VisualLayerCapability } from '../visual-layer-stack';
import type {
  AddressRef,
  CapabilityInvocation,
  VisualLayerDescriptor,
} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';
import {
  ensurePaintTarget,
  setSpanPaint,
  readSpanStack,
  normalizePaintSpans,
} from './apply-selection-paint';

export interface RichTextPaintControlProps {
  /** The contentEditable root whose current selection will be painted. */
  readonly editorRootRef: React.RefObject<HTMLElement | null>;
  /** The visual-layer capability pack (e.g. builtinVisualLayerCapabilities). */
  readonly capabilities: Readonly<Record<string, VisualLayerCapability>>;
  /** Registry ref stamped onto new layers/clips (provenance; lookup is by id). */
  readonly registry: AddressRef;
  /** Persist the editor's current HTML — called after every paint mutation. */
  readonly onCommit?: (root: HTMLElement) => void;
  /** Accessible label / tooltip for the trigger. */
  readonly label?: string;
}

/** The stack a painted text run carries (mirrors VisualLayerStackRecord). */
interface TextPaintStack {
  readonly layers: VisualLayerDescriptor[];
  readonly clip?: CapabilityInvocation;
}

function readStack(span: HTMLElement | null): TextPaintStack {
  const raw = span ? (readSpanStack(span) as Partial<TextPaintStack> | null) : null;
  return { layers: Array.isArray(raw?.layers) ? (raw!.layers as VisualLayerDescriptor[]) : [], clip: raw?.clip };
}

export function RichTextPaintControl({
  editorRootRef,
  capabilities,
  registry,
  onCommit,
  label = 'Paint text',
}: RichTextPaintControlProps) {
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState<HTMLElement | null>(null);
  const [stack, setStack] = React.useState<TextPaintStack>({ layers: [], clip: undefined });
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  // Only text-paintable capabilities: fills declare `resolveCssPaint`, operators
  // (edge/clip) declare `resolveStyle`. Filtered by capability, never by id.
  const textCapabilities = React.useMemo(
    () =>
      Object.fromEntries(
        Object.entries(capabilities).filter(([, c]) => c.resolveCssPaint || c.resolveStyle),
      ) as Record<string, VisualLayerCapability>,
    [capabilities],
  );
  const map = React.useMemo(() => createCapabilityMap(textCapabilities), [textCapabilities]);

  const paint = React.useCallback(
    (next: TextPaintStack, span: HTMLElement) => {
      const css = composeStackTextStyle(next.layers, next.clip, map);
      const json = JSON.stringify({ kind: 'visual-layer-stack', version: 1, layers: next.layers, clip: next.clip });
      setSpanPaint(span, css, json);
      const root = editorRootRef.current;
      if (root) onCommit?.(root);
    },
    [map, editorRootRef, onCommit],
  );

  const openEditor = React.useCallback(() => {
    const root = editorRootRef.current;
    if (!root) return;
    // Never show an empty stub: fall back to the whole run when nothing is selected.
    const t = ensurePaintTarget(root);
    setTarget(t);
    setStack(readStack(t));
    setOpen(true);
  }, [editorRootRef]);

  const onLayersChange = React.useCallback(
    (layers: VisualLayerDescriptor[]) => {
      setStack((prev) => {
        const next = { ...prev, layers };
        if (target) paint(next, target);
        return next;
      });
    },
    [target, paint],
  );

  const onClipChange = React.useCallback(
    (clip: CapabilityInvocation | null) => {
      setStack((prev) => {
        const next = { ...prev, clip: clip ?? undefined };
        if (target) paint(next, target);
        return next;
      });
    },
    [target, paint],
  );

  const onDone = React.useCallback(() => {
    const root = editorRootRef.current;
    if (root) {
      normalizePaintSpans(root);
      onCommit?.(root);
    }
    setOpen(false);
  }, [editorRootRef, onCommit]);

  return (
    <span className="inline-flex">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-rich-text-paint-trigger
        // pointer-DOWN + preventDefault keeps the editor's selection alive.
        onMouseDown={(e) => {
          e.preventDefault();
          if (open) {
            onDone();
          } else {
            openEditor();
          }
        }}
      >
        <Icon icon={Palette} size="sm" />
      </Button>
      {/* Portaled + height-clamped + draggable so it can NEVER be clipped by the
          note card and the user can park it anywhere (a user's bug 3). */}
      <AnchoredOverlay
        anchorRef={triggerRef}
        open={open}
        placement="above"
        draggable
        title="Paint text"
        onDismiss={onDone}
        dismissPreservesSelection
        flagAttr="data-rich-text-paint-panel"
      >
        <div
          role="dialog"
          aria-label={label}
          style={{ backgroundColor: 'var(--black-rich)', borderBottomLeftRadius: 'var(--radius-lg)', borderBottomRightRadius: 'var(--radius-lg)' }}
          className="w-72 border border-t-0 border-[var(--border-primary)] p-3 shadow-xl"
        >
          <LayerStackEditor
            layers={stack.layers}
            capabilities={textCapabilities}
            registry={registry}
            onChange={onLayersChange}
            clip={stack.clip}
            onClipChange={onClipChange}
            onDone={onDone}
            emptyMessage="Add a color, gradient, or mesh — it fills the selected text."
          />
        </div>
      </AnchoredOverlay>
    </span>
  );
}
