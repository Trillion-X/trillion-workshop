# Screen After Sign-In UI

React surface for the sign-in gate. It renders the account login panel while
unsigned and the access-scoped content view after a verified browser session is
read.

`ScreenAfterSignInCheck.tsx` is the hook-using React component. The package
entry must point at `mount-screen-after-sign-in-check.tsx`, which mounts the
component through `mountReactSurface`. Do not export the component itself as the
browser `mount` entry.
