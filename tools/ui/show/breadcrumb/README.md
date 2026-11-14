# breadcrumb/

A path of places above the one on screen, drawn with the Coss breadcrumb (`../coss/ui/breadcrumb.tsx`, from coss.com via 21st.dev component 11596, MIT).

## Files

| File | Purpose |
|------|---------|
| `mount-breadcrumb.tsx` | `mountBreadcrumb(host, {steps, onOpen})`: draws the steps; every step before the last opens its place. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `BreadcrumbStep` | `{id: string; label: string}` | One place on the path, as DATA. |
| `mountBreadcrumb` | `(host: HTMLElement, {steps: BreadcrumbStep[]; onOpen: (id: string) => void}) => () => void` | Mounts the path into a host; returns the teardown. |

## Dependencies

**Depends on:** `../coss/ui/breadcrumb.tsx`, `react`, `react-dom`, `lucide-react` (through the breadcrumb).

**Depended on by:** `src/workspace/files-screen.tsx` (the folder path above Files).
