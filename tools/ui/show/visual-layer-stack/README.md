# ui/show/visual-layer-stack — composable visual layers for a node

A generic, capability-driven stack of visual layers (fills, gradients, images, effects) + a card-frame chrome (corner radius / border / opacity) that any canvas node can carry as self-describing DATA and render blindly.

## Files

| File | Purpose |
|------|---------|
| `VisualLayerStack.tsx` | `VisualLayerStack` — renders an ordered stack of layers behind/over a node's content by self-description; the content rides as a z:0 layer so authored fills (z<0) sit behind and effects (z>0) in front. Blind to what each layer "is". |
| `LayerStackEditor.tsx` | `LayerStackEditor` — the blind per-node editor: list/add/reorder/remove layers via `LayerStackPanel` + per-layer paint/edge sub-editors (capability self-description), the whole-surface silhouette `Edge` (clip) control, the `FrameControl` (`FrameDef`: border show/hide + corner-radius + **opacity** sliders), and the `FilterControl` (a chip row of caller-supplied color presets — shown only when `filterPresets` + `onFilterChange` are passed). Exports `FrameDef`, `setLayerOpacity`. |
| `visual-layer-types.ts` | The DATA schema: `VisualLayerStackRecord`, `VisualLayerDescriptor`, `VisualLayerOrder`, `VisualLayerFrame`, `VisualLayerComposite`, `CapabilityInvocation`/`CapabilityRef`, `AddressRef`. |
| `visual-layer-registry.ts` | The capability seam: `VisualLayerCapability`, `VisualLayerCapabilityMap`, render/style/editor contexts, `createCapabilityMap` — a layer's behavior is an injected capability, never a core enum. |
| `compose-text-style.ts` | `composeStackTextStyle` — fold a stack's text-relevant layers into a single CSS text style (the #88 saved-styles path). |
| `index.ts` | Barrel — re-exports the component, editor, types, `createCapabilityMap`, `builtinVisualLayerCapabilities`. |
| `capabilities/sound.ts` | `effect.sound` ("Moves with sound"): a layer painting a look that moves with the page's one sound reading, with the person's chosen lights following (`parts/ui/show/sound-signal`); its input is `{ look, custom, following }`. |
| `capabilities/builtin.ts` | The built-in layer capabilities; among them `effect.blur` ("Blur", `radius` 0 to 48 px) frosts whatever is beneath the layer (`backdrop-filter`), as behind a floating window. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `VisualLayerStack` | `(props: VisualLayerStackProps) => JSX` | Blind renderer of an ordered layer stack around node content. |
| `LayerStackEditor` | `(props: LayerStackEditorProps) => JSX` | Blind per-node editor; `frame`/`onFrameChange` (`FrameDef`) drive the card chrome incl. opacity; `filterPresets`/`imageFilterId`/`onFilterChange` drive the color-filter chip row (caller owns the catalog and reports a chosen id). |
| `FrameDef` | `{ cornerRadius?: number; border?: boolean; opacity?: number }` | The stack-root card-frame DATA (corner radius px, border on/off, opacity 0..1). |
| `VisualLayerStackRecord` | `{ layers, clip?, frame?, region }` | The whole self-describing stack DATA an item carries (`extra.visualLayerStack`). |
| `VisualLayerCapability` | `{ id, present(), render?, style?, editor?, ... }` | One injected layer behavior (fill/gradient/image/effect) — owner-provided, not a core enum. |
| `createCapabilityMap` | `(caps) => VisualLayerCapabilityMap` | Build the injected capability map the stack/editor dispatch through. |
| `composeStackTextStyle` | `(stack, ...) => CSSProperties` | Reduce a stack to a single text CSS style (saved text styles). |

## Dependencies

**Depends on:** `@/packages/ui/show/range-input`, `@/packages/ui/show/node-editors/LayerStackPanel`, `@/packages/ui` primitives (Text, Inline, Button); React.
**Depended on by:** `group/show` (board item background/edge/opacity via the Style popover), and any node surface that carries a `VisualLayerStackRecord`.

## Why This Design

Layers are DATA dispatched through an injected capability map (L090) — a new layer kind (gradient, blur, new effect) is a new capability registration, never a core `switch`. The `frame` chrome (border/corner/opacity) is the same shape: self-describing DATA edited by one `FrameControl`, applied by the consumer, so adding a chrome property (opacity beside corner-radius) is one field + one slider, not a new code path.
