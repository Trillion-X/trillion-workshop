# ui/show/react-surface-mount/

React root lifecycle adapter for renderer-provided DOM elements.

| Path | Purpose |
|---|---|
| `mount-react-material.tsx` | Mount one React root inside the shared floating material frame and error boundary |
| `mount-react-surface.tsx` | Mount/unmount one React root per target. The root draws into its own `display: contents` box inside the target, so a host that empties the target when it lets go never pulls nodes out from under React, and the root is taken down right after the drawing that let it go (a screen is often let go while the arrangement holding it draws). |
| `index.ts` | Re-export the mount primitive and its public types |

This folder owns only React root lifecycle. Package descriptor/data binding is
owned by Runtime Kit generated package entry/root mounting so UI helpers do not
absorb Runtime Kit read mechanics.
