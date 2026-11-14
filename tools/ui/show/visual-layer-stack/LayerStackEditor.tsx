// packages/ui/show/visual-layer-stack/LayerStackEditor.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The SHARED, blind editor for a visual-layer-stack — composed by ANY layer host
// (screen-arrangement regions, group board items, future surfaces) so a card and
// a region are edited by the SAME primitive (L069). It owns ZERO domain
// vocabulary: it reads the injected capability map and renders, per capability,
// whatever that capability self-describes (its `presentation`, its `editor`, its
// `addAffordance`, and — for geometry operators — its `resolveStyle`).
//
// A layer's settings are three blind sub-editors, all driven by capability
// self-description (Physics-vs-Society):
//   1. PAINT    — the layer's body capability `editor` (color/gradient/grain/…)
//   2. EDGE     — pick any capability that provides `resolveStyle` (a silhouette/
//                 clip operator) → its `editor` writes the layer's `frame.clip`
//   3. (filters/transform reuse the same operator mechanism; surfaced as edge for
//      now — the host can extend with more operator slots with zero new code.)
//
// The component never enumerates capability ids, never switches on kind. Adding a
// fill, an edge generator, or an effect = ONE registry entry, ZERO edits here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. ZERO Society vocabulary / capabilityId literals in this file.
// 2. Pure layer-mutation helpers (exported) — host persists `onChange(next)`.
// 3. Deterministic new-layer ids (no Math.random) — stable identity for delta.
// =============================================================================

'use client';

import React from 'react';
import { Button } from '../button/Button';
import { Text } from '../text/Text';
import { Inline } from '../inline/Inline';
import { RangeInput } from '../range-input';
import { ColorDot } from '../color-dot';
import { ColorPickerPopover } from '../color-picker-popover';
import { Tooltip } from '../tooltip';
import {
  LayerStackPanel,
  type LayerAddOption,
  type LayerRowInfo,
} from '../node-editors/LayerStackPanel';
import type { VisualLayerCapability } from './visual-layer-registry';
import { readFrameBorder, type FrameBorderSpec } from './frame-border';

/** The stack-root card-frame chrome: corner radius (px), border show/hide, and item
 *  opacity (0..1, default 1). A self-describing visual DATA record edited by the
 *  `FrameControl`; the consumer applies it (border/radius on the card, opacity on the
 *  node). Absent fields → defaults (square-ish, bordered, opaque). */
export interface FrameDef {
  cornerRadius?: number;
  /** Border chrome. `false` hides it; `true`/absent shows the default; an object
   *  `{show?,color?,width?}` is a CUSTOM stroke (color + px width). Read through
   *  `readFrameBorder` so the boolean and object forms never diverge (#200). */
  border?: boolean | FrameBorderSpec;
  opacity?: number;
}
import type {
  AddressRef,
  CapabilityInvocation,
  VisualLayerDescriptor,
} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';

// ============================== pure helpers =================================
// Each returns a NEW array; the host persists it. No I/O, no React.

type Layers = readonly VisualLayerDescriptor[];

/** Next deterministic id for a capability (max existing numeric suffix + 1). */
export function nextLayerId(layers: Layers, capabilityId: string): string {
  const prefix = `${capabilityId}-`;
  let max = 0;
  for (const l of layers) {
    if (l.id.startsWith(prefix)) {
      const n = Number.parseInt(l.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${max + 1}`;
}

/** Append a layer painted by `capabilityId` with `input`/`z` from its add-affordance. */
export function addLayer(
  layers: Layers,
  registry: AddressRef,
  capabilityId: string,
  input: Record<string, unknown>,
  z: number,
): VisualLayerDescriptor[] {
  return [
    ...layers,
    {
      id: nextLayerId(layers, capabilityId),
      order: { z },
      paint: { capability: { registry, capabilityId }, input },
    },
  ];
}

export function removeLayer(layers: Layers, id: string): VisualLayerDescriptor[] {
  return layers.filter((l) => l.id !== id);
}

/** Reorder to match `orderedIds` (front-to-back); unknown ids are ignored. */
export function reorderLayers(layers: Layers, orderedIds: readonly string[]): VisualLayerDescriptor[] {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter((l): l is VisualLayerDescriptor => !!l);
  for (const l of layers) if (!orderedIds.includes(l.id)) ordered.push(l);
  return ordered.map((l, index) => ({ ...l, order: { ...l.order, z: index } }));
}

function mapLayer(layers: Layers, id: string, fn: (l: VisualLayerDescriptor) => VisualLayerDescriptor): VisualLayerDescriptor[] {
  return layers.map((l) => (l.id === id ? fn(l) : l));
}

export function patchLayerInput(layers: Layers, id: string, patch: Record<string, unknown>): VisualLayerDescriptor[] {
  return mapLayer(layers, id, (l) => ({ ...l, paint: { ...l.paint, input: { ...l.paint.input, ...patch } } }));
}

export function setLayerOpacity(layers: Layers, id: string, opacity: number): VisualLayerDescriptor[] {
  return mapLayer(layers, id, (l) => ({ ...l, composite: { ...l.composite, opacity } }));
}

export function setLayerEnabled(layers: Layers, id: string, enabled: boolean): VisualLayerDescriptor[] {
  return mapLayer(layers, id, (l) => ({ ...l, enabled }));
}

/** Set (or clear, when `capabilityId` is null) a layer's silhouette clip operator. */
export function setLayerClip(
  layers: Layers,
  id: string,
  registry: AddressRef,
  capabilityId: string | null,
  input: Record<string, unknown> = {},
): VisualLayerDescriptor[] {
  return mapLayer(layers, id, (l) => {
    if (!capabilityId) {
      const frame = { ...l.frame };
      delete (frame as { clip?: unknown }).clip;
      return { ...l, frame };
    }
    return { ...l, frame: { ...l.frame, clip: { capability: { registry, capabilityId }, input } } };
  });
}

export function patchLayerClipInput(layers: Layers, id: string, patch: Record<string, unknown>): VisualLayerDescriptor[] {
  return mapLayer(layers, id, (l) => {
    const clip = l.frame?.clip as CapabilityInvocation | undefined;
    if (!clip?.capability) return l;
    return { ...l, frame: { ...l.frame, clip: { ...clip, input: { ...clip.input, ...patch } } } };
  });
}

// ============================== add-option derivation ========================

/** A subject the owner resolved by running its file picker + byte store. Generic:
 *  `ui` is blind to HOW the bytes were chosen/stored (local-files + cas-store live
 *  in the owner). The owner hands back the resolved URL + its content type. */
export interface LayerSubjectPick {
  readonly url: string;
  readonly contentType: string;
}

/** "Add layer" rows DERIVED from the capability map — every capability that
 *  declares an `addAffordance` becomes a row (sorted by order). No hardcoded list.
 *
 *  A capability that self-describes `requiresSubject` (image/video/…) cannot be
 *  added from a static default — it needs real bytes. When the owner injects
 *  `pickSubject`, that row OPENS the owner's picker (the native Finder), ingests
 *  the chosen file, and stamps the resolved `{ url, contentType }` onto the new
 *  layer's input. Without an injected picker, a subject capability falls back to a
 *  plain (empty) add — the `ui` package never owns the file/CAS I/O itself. */
export function addOptionsFromCapabilities(
  capabilities: Readonly<Record<string, VisualLayerCapability>>,
  onAdd: (capabilityId: string, input: Record<string, unknown>, z: number) => void,
  pickSubject?: (prefixes: readonly string[]) => Promise<LayerSubjectPick | null>,
): LayerAddOption[] {
  return Object.entries(capabilities)
    .filter(([, cap]) => cap.addAffordance && cap.render) // a paint layer (geometry-only ops are not "layers")
    .sort(([, a], [, b]) => (a.addAffordance?.order ?? 999) - (b.addAffordance?.order ?? 999))
    .map(([capabilityId, cap]) => {
      const aff = cap.addAffordance!;
      const baseInput = { ...(aff.defaultInput ?? {}) };
      const z = aff.defaultZ ?? -1;
      const run =
        aff.requiresSubject && pickSubject
          ? () => {
              void (async () => {
                const picked = await pickSubject(aff.subjectPrefixes ?? []);
                if (!picked) return; // picker cancelled / returned no usable bytes
                onAdd(
                  capabilityId,
                  { ...baseInput, url: picked.url, contentType: picked.contentType, fit: baseInput.fit ?? 'cover' },
                  z,
                );
              })();
            }
          : () => onAdd(capabilityId, { ...baseInput }, z);
      return {
        id: `add-${capabilityId}`,
        label: cap.presentation?.label ?? capabilityId,
        icon: cap.presentation?.icon,
        run,
      };
    });
}

/** Capabilities usable as silhouette/clip operators = those that provide `resolveStyle`. */
export function geometryOperatorIds(capabilities: Readonly<Record<string, VisualLayerCapability>>): string[] {
  return Object.entries(capabilities).filter(([, cap]) => cap.resolveStyle).map(([id]) => id);
}

// ============================== component ====================================

export interface LayerStackEditorProps {
  readonly layers: Layers;
  readonly capabilities: Readonly<Record<string, VisualLayerCapability>>;
  /** Registry ref stamped onto new layers/clips (lookup is by capabilityId; this is provenance). */
  readonly registry: AddressRef;
  /** Persist the new layer set. */
  readonly onChange: (layers: VisualLayerDescriptor[]) => void;
  /** The whole-surface SILHOUETTE operator (card edge). When `onClipChange` is
   *  provided, a top-level always-visible "Edge" control is shown. */
  readonly clip?: CapabilityInvocation;
  readonly onClipChange?: (clip: CapabilityInvocation | null) => void;
  /** Plain card-frame chrome (corner radius + border show/hide + opacity). When
   *  `onFrameChange` is provided, a top-level "Frame" control is shown — the
   *  user's direct "round the card / hide the border / fade the item" control,
   *  independent of the silhouette edge operator. */
  readonly frame?: FrameDef;
  readonly onFrameChange?: (frame: FrameDef) => void;
  /** Image color-filter presets (DATA the caller supplies — the editor is blind to what
   *  a filter IS; it renders labels and reports the chosen `id`). When `filterPresets` +
   *  `onFilterChange` are provided, a "Filter" chip row is shown; `imageFilterId` marks
   *  the active chip. Only the caller (for image items) wires this. */
  readonly filterPresets?: readonly { id: string; label: string }[];
  readonly imageFilterId?: string;
  readonly onFilterChange?: (id: string) => void;
  /** Owner-injected subject picker. Capabilities that self-describe `requiresSubject`
   *  (image/video) use it to open the native Finder, ingest the chosen file, and add
   *  the layer pointed at the resolved bytes. Absent → subject capabilities add empty. */
  readonly pickSubject?: (prefixes: readonly string[]) => Promise<LayerSubjectPick | null>;
  readonly onDone: () => void;
  readonly emptyMessage?: string;
}

/** Blind operator picker: None + every capability that provides `resolveStyle`,
 *  then the active operator's own editor. Used for the card edge and per-layer. */
function EdgeOperatorControl({
  label,
  active,
  input,
  capabilities,
  operatorIds,
  registry,
  onPick,
  onPatch,
}: {
  label: string;
  active: string | null;
  input: Record<string, unknown>;
  capabilities: Readonly<Record<string, VisualLayerCapability>>;
  operatorIds: readonly string[];
  registry: AddressRef;
  onPick: (op: CapabilityInvocation | null) => void;
  onPatch: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  const activeCap = active ? capabilities[active] : undefined;
  return (
    <div className="flex flex-col gap-2">
      <Text variant="label">{label}</Text>
      <Inline gap="xs" className="flex-wrap">
        <Button variant={active === null ? 'solid' : 'ghost'} size="xs" onClick={() => onPick(null)}>
          None
        </Button>
        {operatorIds.map((opId) => (
          <Button
            key={opId}
            variant={active === opId ? 'solid' : 'ghost'}
            size="xs"
            onClick={() =>
              onPick({
                capability: { registry, capabilityId: opId },
                input: { ...(capabilities[opId]?.addAffordance?.defaultInput ?? {}) },
              })
            }
          >
            {capabilities[opId]?.presentation?.label ?? opId}
          </Button>
        ))}
      </Inline>
      {activeCap?.editor?.({ input, patchInput: onPatch })}
    </div>
  );
}

/** Border stroke-width presets (px). A small closed ladder of tasteful weights,
 *  cycled by one button — the SAME UX as the connector line-weight control so both
 *  stroke pickers feel identical. Width itself is a free number in the DATA (any
 *  value round-trips through `readFrameBorder`); this is just the click ladder. */
const BORDER_WIDTH_PRESETS = [1, 2, 3, 4] as const;

/** Border color swatches offered in the picker. Society DATA (a starting palette);
 *  the wheel still yields any hex, so this is a convenience row, not an enum. */
const BORDER_COLOR_PRESETS = [
  '#111827', '#ffffff', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899',
] as const;

/** Advance to the next width preset: snap to the nearest rung, then step up (wrap).
 *  Mirrors the connector `nextThickness` cycle so a custom width still lands on a
 *  predictable next value. */
function nextBorderWidth(current: number): number {
  let idx = 0;
  let best = Infinity;
  BORDER_WIDTH_PRESETS.forEach((p, i) => {
    const d = Math.abs(p - current);
    if (d < best) { best = d; idx = i; }
  });
  return BORDER_WIDTH_PRESETS[(idx + 1) % BORDER_WIDTH_PRESETS.length];
}

/** The plain card-frame control: show/hide the border, its stroke color + width, a
 *  corner-radius slider, and item opacity. Independent of the silhouette edge
 *  operator — this is the direct "round the card / recolor the border / kill the
 *  extra border" control. Writes the stack root `frame` DATA.
 *
 *  Border is written in the object form `{show,color,width}` (#200) so a chosen
 *  color/width SURVIVES a hide→show toggle; every reader collapses it back through
 *  the one canonical `readFrameBorder`, so the boolean and object forms never
 *  diverge into two schemas. */
function FrameControl({
  frame,
  onChange,
}: {
  frame?: FrameDef;
  onChange: (frame: FrameDef) => void;
}): React.ReactElement {
  const radius = frame?.cornerRadius ?? 0;
  const border = readFrameBorder(frame?.border);
  const opacityPct = Math.round((frame?.opacity ?? 1) * 100);
  const colorAnchor = React.useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const width = border.width ?? 1;

  // Always write the OBJECT form, carrying the current color/width forward so a
  // show/hide toggle never discards a custom stroke (readFrameBorder normalizes).
  const writeBorder = (patch: Partial<FrameBorderSpec>): void =>
    onChange({
      ...frame,
      border: { show: border.show, color: border.color, width: border.width, ...patch },
    });

  return (
    <div className="flex flex-col gap-2">
      <Text variant="label">Frame</Text>
      <Inline gap="xs" className="flex-wrap items-center">
        <Button variant={border.show ? 'solid' : 'ghost'} size="xs" onClick={() => writeBorder({ show: true })}>
          Border
        </Button>
        <Button variant={!border.show ? 'solid' : 'ghost'} size="xs" onClick={() => writeBorder({ show: false })}>
          No border
        </Button>
        {border.show ? (
          <>
            <Tooltip label="Border color">
              <Button
                ref={colorAnchor}
                variant="ghost"
                size="icon"
                aria-label="Border color"
                onClick={() => setPickerOpen((o) => !o)}
              >
                <ColorDot color={border.color || 'var(--border-strong)'} size="md" />
              </Button>
            </Tooltip>
            <ColorPickerPopover
              anchorRef={colorAnchor}
              open={pickerOpen}
              value={border.color || '#111827'}
              presets={BORDER_COLOR_PRESETS}
              title="Border color"
              // Live recolor while dragging the wheel (no undo flood); Done commits.
              onChange={(hex) => writeBorder({ color: hex })}
              onSave={(hex) => { writeBorder({ color: hex }); setPickerOpen(false); }}
              saveLabel="Done"
              onDismiss={() => setPickerOpen(false)}
            />
            <Tooltip label="Border width">
              <Button variant="ghost" size="xs" aria-label="Border width" onClick={() => writeBorder({ width: nextBorderWidth(width) })}>
                {width}px
              </Button>
            </Tooltip>
          </>
        ) : null}
      </Inline>
      <Inline gap="sm" className="items-center">
        <Text variant="caption" color="muted">Corners</Text>
        <RangeInput value={radius} min={0} max={48} step={1} onValueChange={(v) => onChange({ ...frame, cornerRadius: v })} />
        <Text variant="caption" color="muted">{radius}px</Text>
      </Inline>
      <Inline gap="sm" className="items-center">
        <Text variant="caption" color="muted">Opacity</Text>
        <RangeInput value={opacityPct} min={10} max={100} step={1} onValueChange={(v) => onChange({ ...frame, opacity: v / 100 })} />
        <Text variant="caption" color="muted">{opacityPct}%</Text>
      </Inline>
    </div>
  );
}

/** The image color-filter chip row: the user picks a named preset; the editor reports
 *  the chosen id and never knows what the filter DOES (the caller maps id → CSS). */
function FilterControl({
  presets,
  activeId,
  onChange,
}: {
  presets: readonly { id: string; label: string }[];
  activeId?: string;
  onChange: (id: string) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <Text variant="label">Filter</Text>
      <Inline gap="xs" className="flex-wrap items-center">
        {presets.map((p) => (
          <Button key={p.id} variant={p.id === activeId ? 'solid' : 'ghost'} size="xs" onClick={() => onChange(p.id)}>
            {p.label}
          </Button>
        ))}
      </Inline>
    </div>
  );
}

/** Blind editor: list ops via LayerStackPanel + per-layer paint/edge sub-editors,
 *  all driven by capability self-description. */
export function LayerStackEditor({
  layers,
  capabilities,
  registry,
  onChange,
  clip,
  onClipChange,
  frame,
  onFrameChange,
  filterPresets,
  imageFilterId,
  onFilterChange,
  pickSubject,
  onDone,
  emptyMessage,
}: LayerStackEditorProps): React.ReactElement {
  const describeLayer = React.useCallback(
    (layer: VisualLayerDescriptor): LayerRowInfo => {
      const cap = capabilities[layer.paint.capability.capabilityId];
      return { label: cap?.presentation?.label ?? layer.paint.capability.capabilityId, icon: cap?.presentation?.icon };
    },
    [capabilities],
  );

  const addOptions = React.useMemo(
    () =>
      addOptionsFromCapabilities(
        capabilities,
        (id, input, z) => onChange(addLayer(layers, registry, id, input, z)),
        pickSubject,
      ),
    [capabilities, layers, registry, onChange, pickSubject],
  );

  const operatorIds = React.useMemo(() => geometryOperatorIds(capabilities), [capabilities]);

  const renderLayerSettings = React.useCallback(
    (layer: VisualLayerDescriptor): React.ReactNode => {
      const paintCap = capabilities[layer.paint.capability.capabilityId];
      const layerClip = layer.frame?.clip as CapabilityInvocation | undefined;
      return (
        <div className="flex flex-col gap-3">
          {paintCap?.editor?.({
            input: layer.paint.input,
            patchInput: (patch) => onChange(patchLayerInput(layers, layer.id, patch)),
          })}
          <EdgeOperatorControl
            label="Layer edge"
            active={layerClip?.capability?.capabilityId ?? null}
            input={layerClip?.input ?? {}}
            capabilities={capabilities}
            operatorIds={operatorIds}
            registry={registry}
            onPick={(op) => onChange(setLayerClip(layers, layer.id, registry, op?.capability.capabilityId ?? null, op?.input ?? {}))}
            onPatch={(patch) => onChange(patchLayerClipInput(layers, layer.id, patch))}
          />
        </div>
      );
    },
    [capabilities, layers, operatorIds, registry, onChange],
  );

  // The CARD edge is a stack-level silhouette (always visible, even with zero
  // layers) — the user's "give the card a torn/scalloped edge" control. The
  // per-layer edge (above) stays for clipping one specific fill/image.
  const cardEdge = onClipChange ? (
    <EdgeOperatorControl
      label="Edge"
      active={clip?.capability?.capabilityId ?? null}
      input={clip?.input ?? {}}
      capabilities={capabilities}
      operatorIds={operatorIds}
      registry={registry}
      onPick={onClipChange}
      onPatch={(patch) => clip?.capability && onClipChange({ ...clip, input: { ...clip.input, ...patch } })}
    />
  ) : null;

  const cardFrame = onFrameChange ? <FrameControl frame={frame} onChange={onFrameChange} /> : null;
  const cardFilter = onFilterChange && filterPresets && filterPresets.length > 0
    ? <FilterControl presets={filterPresets} activeId={imageFilterId} onChange={onFilterChange} />
    : null;

  return (
    <div className="flex flex-col gap-3">
      {cardFrame}
      {cardFilter}
      {cardEdge}
      <LayerStackPanel
        layers={layers}
        describeLayer={describeLayer}
        onReorder={(ids) => onChange(reorderLayers(layers, ids))}
        onSetOpacity={(id, opacity) => onChange(setLayerOpacity(layers, id, opacity))}
        onToggleVisible={(id, visible) => onChange(setLayerEnabled(layers, id, visible))}
        onRemove={(id) => onChange(removeLayer(layers, id))}
        addOptions={addOptions}
        renderLayerSettings={renderLayerSettings}
        emptyMessage={emptyMessage}
        onDone={onDone}
      />
    </div>
  );
}
