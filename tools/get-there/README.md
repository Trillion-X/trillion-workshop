# tools/get-there/

Gets a person somewhere with nothing to look up. `tool:route-buttons` turns a destination, and optionally a start and places on the way, into one button per maps app that opens the trip. `tool:find-nearest-places` finds the nearest places of a brand or a name around a start and gives each its own route buttons. Ported from the app's `src/getting-there.mjs` and its settings file.

Nothing about any brand, store, maps app or place service is in the code. The maps apps (an address template each, with the app's own word for each travel mode) and the places services (OpenStreetMap's open address and places services, which need no account, with several copies of the places service asked in turn when one is busy, then the address service's own search around the start) are DATA in `read-data/get-there.json`; a new maps app is a row. The user agent those open services ask every caller to send is there too. What a caller may ask for (`most`, `radius_km`) is bounded by the same file.

`tool:route-buttons` is pure and reaches no network. `tool:find-nearest-places` runs with internet on, so its requests go through the engine's public-only proxy; a service that does not answer is told in words, never guessed around.

## Files

| File | Purpose |
|------|---------|
| `read-data/get-there.mjs` | `routeButtons`, `stopWords`, `kmBetween`, `placesFrom` and `findNearestPlaces`. Its header lists the invariants. |
| `read-data/get-there.json` | The maps apps, the places services and their queries, the bounds and the words of every answer. |
| `do-work/route-buttons.mjs` | The command of `tool:route-buttons`. |
| `do-work/find-nearest-places.mjs` | The command of `tool:find-nearest-places`. |
| `tool-rows.json` | The two rows, with a sample run of the pure one. |
| `test/get-there.test.mjs` | The cases on made-up places with a stand-in for the network: both maps apps, stops, sorting and deduplication, a busy service handing on, the fallback search, none found, a start that is unknown, the bounds, and the rows. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| stop | words, `{ lat, lon }` (also `latitude`, `longitude`) or `{ address }` | A place as a maps app reads it. |
| `routeButtons` | `({ destination, origin?, stops?, mode? }) -> { buttons: [{ id, label, url }], said? }` | One button per maps app. |
| `findNearestPlaces` | `({ name, near, radius_km?, most?, mode? }, { fetch? }) -> { places, start, said }` | Nearest first; a place has `name, address, lat, lon, km, opening_hours, id, buttons`. |

## Dependencies

**Depends on:** Node 24 only, and for places the open services named in `get-there.json`.

**Depended on by:** `tool-rows.json`; the workflows that name `tool:route-buttons` and `tool:find-nearest-places`.
