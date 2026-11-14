# adaptive-program-landing/do-work

Producers that turn this package's landing source plus one package set's DATA into bytes: a local render proof, and the island a hosted application serves.

## Files

| File | Purpose |
|---|---|
| `render-landing-proof.mjs` | Builds a browser-openable render of the landing from source + a package set's `adaptive-program-landing.json` into `proof/rendered-screens/<set>/`. Used by `tests/the-proof-rail-actually-moves.test.mjs`. |
| `landing-proof-shell.html` | The HTML shell the render proof writes beside its bundle. |
| `publish-hosted-landing-island.mjs` | Builds the self-mounting island (`/assets/program-landing/app.js` + `app.css`), copies the set's `public-assets/` and `commercial-offer-records.json`, stacks them onto the image the provider is running now, and deploys through `hosted-public-app`'s package-owned `fly-remote-only` plan. `--build-only` builds and reports sizes without deploying. |

## Key Functions

| Function | Signature | Role |
|---|---|---|
| `buildLandingIsland` | `({ packageSet, assetsDir }) => Promise<esbuild.BuildResult>` | Bundles `ProgramLanding` with the set's DATA inlined as a classic IIFE that mounts on `#root`, writing `program-landing/app.{js,css}` under `assetsDir`. |

## Usage

```bash
# from /workspace/the-owner/dev/bitfield-packages
node packages/adaptive-program-landing/do-work/publish-hosted-landing-island.mjs \
  --package-set ethos-school-of-tennis --application ethos-school-of-tennis
```

## Why This Design

The hosted island used to be built by `hosted-public-app/processes/build-public-entry-server.mjs`, deleted 2026-09-17. No package set had moved to its successor, so a landing already live could no longer be rebuilt. The publisher carries the running image forward (server, runtime, environment, volume) and replaces only the island bytes and public assets, so it cannot change anything else about the app. Its workspace is its own temporary folder, created and removed by the process; a caller names a package set and an application, never a directory. The managed builder cannot re-export a running image's layers, so the deploy asks for the in-account builder.

## Invariants

- **Checkout must travel over HTTP on a hosted page.** The pricing card's default sender is a runtime-kit target request, which waits forever on a page with no runtime connection, so a pay click does nothing and shows nothing. The island sets `window.__programStartCheckout__` to POST `/target/checkout.start-checkout`, which the public entry server answers. Verify by clicking a pay button on the live page and landing on `checkout.stripe.com`.
- **The image carries the set's current prices.** The entry server falls back to `/app/commercial-offer-records.json`, and a provider deploy resets per-machine settings such as `BITFIELD_COMMERCIAL_OFFERS_FILE`. Carrying the running image's copy forward put a months-old $0.50 membership floor back on the live page on 2026-09-22.
- **The target machine must carry Fly's `fly_process_group` label.** A machine recreated by hand (for example during a volume restore) has none, and the provider deploy then treats the app as having no machines: it creates a NEW machine on a NEW empty volume at a default size and leaves the real one on the old image. Seen on `ethos-school-of-tennis` 2026-09-22. Repair: remove the stray machine and its empty volume, then move the real machine onto the new image in place and give it the `app` process-group label so the next deploy updates it.

## Dependencies

**Depends on:** `../show/ProgramLanding.tsx`, `../read-data/program-landing-data`, `hosted-public-app/processes/run-provider-deploy.mjs` (`currentContainerBaseResult`, `runProviderDeployment`), `esbuild`, `package-sets/<set>/package-set-records/adaptive-program-landing.json`, `package-sets/<set>/public-assets/`.

**Depended on by:** `../tests/the-proof-rail-actually-moves.test.mjs` (render proof); the hosted tennis site (island publish).
