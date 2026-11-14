# content-production/show/

**Purpose:** Surface entries for the content-production package — the original "Make content" panel and the content workspace shell that hosts every content surface as screen-arrangement tabs.

## Files

| File | Purpose |
|------|---------|
| `mount-content-production.tsx` | Entry adapter for the "Make content" panel (`FloatingMaterialFrame` + `ErrorBoundary` + `ContentProduction`) |
| `ContentProduction.tsx` | The "Make content" run-submission panel |
| `mount-content-workspace.tsx` | Entry adapter for the workspace shell (`FloatingMaterialFrame` + `ErrorBoundary` + `ContentWorkspaceShell`) |
| `ContentWorkspaceShell.tsx` | Root workspace shell: Fey-style header + `EmbeddedScreenArrangement` hosting all content surfaces as tabs |

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `mountContentWorkspace` | `({ el, props }) => unmount` | Mounts the workspace shell entry |
| `ContentWorkspaceShell` | `() => JSX` | Header + arrangement host; logs `[ui:content-workspace] mounted input=<n> records` on mount |
| `default` (mount-content-production) | `({ el, props }) => unmount` | Mounts the "Make content" panel entry |

## Architecture

### Workspace shell (U01, plan §13A)
- The shell is a blind host: a header (logo mark + title) over `EmbeddedScreenArrangement`, whose default layout (`read-data/read-content-workspace-state.ts`) defines one tab per content surface (Library, Style, Compose, Deliverables, Distribution, Connections, Settings).
- Tabs carry `placeable_surface_id` metadata; the arranger resolves each id against published `placeable-surface` records. Surfaces that have not been published yet render as empty containers — adding a surface is a data registration in its own package, zero shell code changes.
- Embedded empty states and picker actions read `placeable-surface-list::content-workspace`, not the top-level main workspace list.
- Tab switching, drag-arrange, and layout persistence run through the real screen-arrangement engine (`persistence.valueAddressLabel: "content-workspace-layout-state"`, persisted-state acceptance via `acceptsContentWorkspaceLayoutState`).
- Search and account controls belong to the surfaces that own those jobs, not to the blind host shell.

### Decoupling (NON-NEGOTIABLE)
- Reads only via `useBitfieldData` (`published-records`); zero `slot::workflow`/`slot::eeaf` imports.
- Components only from `@/packages/ui`; zero inline `style={{}}` objects — layout via `Container` variants (`layout`/`gap`/`padding`/`border`/`flex`/`height`/`overflow`).
- Cross-package UI reuse limited to `@/packages/screen-arrangement` (`EmbeddedScreenArrangement` + layout types), the same dependency `media-composition` uses.

## Dependencies

**Depends on:** `@/packages/ui` (Container, Icon, Text, ErrorBoundary, FloatingMaterialFrame, mountReactSurface), `@/packages/screen-arrangement` (EmbeddedScreenArrangement, layout-types, normalizeLayoutState), `@bitfield/runtime-kit/react` (useBitfieldData), `lucide-react`, `../read-data/read-content-workspace-state` and `../read-data/read-content-production`.

**Depended on by:** package entries declared in `entry-to-package-data-map.json` (`content-production`, `content-workspace`); surfaces register against the shell purely via `placeable-surface` records in their own packages.
