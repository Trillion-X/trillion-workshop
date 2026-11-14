# account-shell

Portal chrome for the Bitfield account portal: sidebar navigation over the published placeable-surface catalog plus the active surface panel, mounted by each surface's own package entry bytes.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Package barrel |
| `read-data/read-portal-surfaces.ts` | Decode surface catalog rows → `PortalSurface[]`, sidebar sections, default surface |
| `show/app-shell/AccountPortalShell.tsx` | Chrome component: sidebar + active panel host + `?surface=` URL state |
| `show/portal-surface-url.ts` | URL state helpers (`?surface=` read/resolve/write) |
| `show/mount-account-portal-shell.tsx` | Entry mount (`account-portal-shell`) |
| `things-to-store-and-run.json` | Package contract: stored bytes, contract record, `placeable-surface-list::main-workspace` fold, `portal-surface-list` input, entry |
| `tests/read-portal-surfaces.test.ts` | Decoder, sections, default-surface, URL-state tests |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `PortalSurface` | `{ id, label, description, materialTarget, target, order, sectionId, sectionLabel, showInNavigation, wrapMaterial, packageEntry }` | One decoded catalog row |
| `PortalSidebarSection` | `{ id, label, items: PortalSurface[] }` | Sidebar section grouping |
| `readPortalSurfaces` | `(raw: unknown) => PortalSurface[]` | Decode + dedupe + sort catalog rows |
| `readSidebarSections` | `(surfaces) => PortalSidebarSection[]` | Group navigable surfaces by section |
| `defaultPortalSurfaceId` | `(surfaces) => string \| null` | Prefer `account`, else first navigable |
| `findPortalSurface` | `(surfaces, id) => PortalSurface \| null` | Lookup by id |
| `requestedSurfaceFromSearch` | `(search: string) => string \| null` | Read `?surface=` |
| `resolveActiveSurfaceId` | `(surfaces, requested, fallback) => string \| null` | Validate requested id against the catalog |
| `surfaceUrl` | `(pathname, search, hash, surfaceId, defaultSurfaceId) => string` | Build the pushState URL (default surface clears the param) |
| `AccountPortalShell` | React component | The chrome |

## Data

- Reads input `portal-surface-list` → `placeable-surface-list::main-workspace`, a `record_from_matching_records` fold over placeable-surface records (kind `placeable-surface`, `placement_labels` contains `main-workspace`, ordered by `placement_order_key`) at paths `[current-item, published-record]` and `[published-records]`.
- A new portal surface = ONE placeable-surface DATA row with `package_entry` + `placement_labels` — zero shell changes.
- `wrap_material: false` rows render full-bleed without the sidebar (`data-account-portal-chrome="none"`).
- Styling comes from the portal stylesheet record `package::screen-look::stored-bytes::bitfield-site-global-look` (`.account-portal-body`, `[data-bitfield-account-sidebar]`, `.account-sidebar-*`, `.account-screen-arrangement*`).

## Dependencies

**Depends on:** `@bitfield/runtime-kit/react` (`useBitfieldData`), `packages/ui` (`PlaceableSurfaceHost`, `ErrorBoundary`, `mountReactSurface`).
**Depended on by:** the account portal entry scene (`component:account-portal-shell` via `package::account-shell::entry-bytes::account-portal-shell`).
