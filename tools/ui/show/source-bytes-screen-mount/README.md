# Source Bytes Screen Mount

This folder owns the browser-local lifecycle for putting already-read source bytes on screen.

It deliberately does not read Runtime Kit inputs, import owner packages, or interpret package state. Caller packages read their own package entry bytes, then pass those bytes plus opaque mount props into `SourceBytesScreenMount`.

The mount key is content-based, not `Uint8Array` object-identity based. Runtime Kit readers may hand React an equivalent fresh byte view while other app state changes; that must not clean up a mounted package surface or re-show the opening overlay.

What the mounted screen keeps for its placement (`../placement-kept`, input `kept`) is heard from the mount node and left out of the mount key, so keeping a filter or a level never remounts the screen; a different `kept` handed in from outside (another placement, a restore) does remount it.

Missing source bytes and stalled browser mounts must become visible failure states. This component must not leave the user on a permanent `Opening...` overlay when a caller input descriptor is absent, a selected payload read returns no bytes, or the browser mount promise never settles.
