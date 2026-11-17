# Calendar Booker Show

The React presentation layer: a blind, data-driven descriptor renderer plus the package surfaces and mount entries that feed it.

The active React surfaces render a descriptor-backed work graph. They may keep
draft input and last-click UI feedback, but they do not own durable scheduling
records, generate sample times, mutate booking state, or call provider APIs.

## Files

| File | Purpose |
|------|---------|
| `view-descriptor.ts` | Generic descriptor model types (`ViewDescriptor`, `StatusDescriptor`, `ActionDescriptor`, `ViewOption`). Zero scheduling vocabulary — pure shape. |
| `descriptor-surface.tsx` | The blind renderer: one O(1) `caps.get(node.render_kind)` lookup; unknown kinds → `UnknownDescriptorFallback`. Contains zero `render_kind` literals and zero identity branches. |
| `render-capability-map.tsx` | The leaf capability pack — the SOLE place `render_kind` strings are bound to ui/screen-look components, and the SOLE place owner `tone_ref` maps to a ui tone (never a color). |
| `CalendarBookerSurface.tsx` | Active owner surface: renders current fields, states, actions, and projection proof from package-owned descriptor rows. |
| `CalendarAvailabilitySetupSurface.tsx` | Active setup surface: renders setup fields and readiness proof from the same descriptor rows. |
| `mount-calendar-booker.tsx` | Mount entry for the owner booker surface. |
| `mount-calendar-availability-setup.tsx` | Mount entry for the availability setup surface. |
| `__tests__/` | Renderer + model invariant tests (test-only). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `ViewDescriptor` | `{id, render_kind, label?, help?, value?, options?, status?, actions?, editable?, children?}` | The one node shape every surface emits and the renderer consumes. |
| `StatusDescriptor` | `{tone_ref, label, reason?}` | Owner-translated status; `tone_ref` is the OPEN owner tone vocabulary. |
| `ActionDescriptor` | `{action_ref, label, arg_schema_ref?, disabled_reason?}` | A human-labelled action over an internal `action_ref`. |
| `DescriptorSurface` | `(props: {node, caps, onAction?, onValueChange?}) => ReactElement` | Blind dispatcher — looks the node's `render_kind` up in `caps`, renders the fallback if unbound. |
| `RENDER_CAPABILITIES` / `calendarBookerRenderCapabilities` | `ReadonlyMap<string, RenderComponent>` | The 12-kind binding table — the data the blind renderer dispatches through. |

## Dependencies

**Depends on:** `tools/ui` (Container, Text, StatusDot, Button, Input, EmptyPlaceholder, `statusView`, …), `react`. The capability map binds these; no other file in this folder imports ui directly.

**Depended on by:** `do-work/scheduling-offer-feed.ts` (emits `ViewDescriptor[]` consumed here), the mount entries, and the package mount/show bindings. The blind renderer is the only consumer of `RENDER_CAPABILITIES`.

## Why This Design

The renderer is **blind** (L090 / enum dissolution): adding a new node kind is one DATA row in `render-capability-map.tsx`, zero edits to `descriptor-surface.tsx`. All product vocabulary and human labels are produced upstream in the `do-work` feed (L098 — single translation boundary); this layer prints labels verbatim and never humanizes.
