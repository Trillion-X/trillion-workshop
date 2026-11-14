# tools/join-a-shared-room-from-another-device/

The links and the Connect devices card that let another device join a shared room: a browser link built from a route and a location or base address (a loopback address is flagged so it is not offered as shareable), an app-open link that carries a scene, a copy button and the join QR payload, and a native iOS surface that renders the join form.

Moved here byte for byte from bitfield-packages `packages/shared-room-connection` by hand, with the receipt `from-bitfield-packages/shared-room-connection/moved-from.json`.

## Files

| File | Purpose |
|------|---------|
| `read-data/shared-room-connection.ts` | `makeSharedRoomOpenLinks`, `browserUrlForBase`, `browserUrlForRoute`, `bitfieldOpenUrlForScene`, `screenArrangementScene`, `isLoopbackUrl`. |
| `show/mount-shared-room-connection.tsx` | The Connect devices card. |
| `show-ios-jscore/mount-shared-room-connection-jscore.js` | The native iOS join surface (a README beside it). |
| `from-bitfield-packages/shared-room-connection/` | The package's README and its records file. |

## Not wired yet

The card imports `@/packages/ui`, the app link uses the `bitfield://` scheme and the iOS surface writes through the retired Bitfield runtime. Wiring is held for the lead.

## Dependencies

**Depends on:** `@/packages/ui` and the retired Bitfield runtime (neither is in this repository).

**Depended on by:** nothing yet.
