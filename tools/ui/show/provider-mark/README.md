# Provider Mark

`ProviderMark` renders provider identity from the caller's registry rows. It
uses the bundled full-color SVG when the artwork has brand colors and falls back
to the provider-name monogram when no safe registry mark exists.

Single-color near-black SVG artwork is detected from the asset itself. That
artwork is sanitized into an inline `currentColor` SVG so it stays readable in
light and dark themes. Width and height are also applied as explicit component
styles; a consuming bundle does not need to discover this shared package's
Tailwind size utilities for the mark to remain compact.

The renderer contains no provider-name branches. Anthropic, Ollama, OpenAI, and
any future near-black silhouette follow the same visual rule; multicolor artwork
such as Google stays unchanged.

## Profile links (DATA)

A `provider-icon` row may carry `profile_link: {prefix, suffix}` (https only). `providerProfileUrl(registry, providerSlug, handle)` returns `prefix + handle + suffix` for a plain handle, or `''` when the provider declares no profile link. `linked-identity` uses it to open an account when the connected account reports no address of its own.

## Files

| File | Purpose |
|---|---|
| `ProviderMark.tsx` | Draws one provider mark (bundled SVG, inline near-black silhouette, or monogram). |
| `provider-icon-registry.ts` | Reads and validates `provider-icon` rows; resolves a mark; builds profile links. |
| `provider-icon-assets.ts` | The bundled SVG sources the rows reference by asset id. |
| `shipped-provider-icons.ts` | The `provider-icon` rows this part ships in `things-to-store-and-run.json`, read once for every consumer. |
| `index.ts` | Public barrel. |

## Key exports

| Name | Signature / Shape | Role |
|---|---|---|
| `ProviderMark` | `({providerSlug, providerName, registry, size?, decorative?}) => JSX` | The mark. |
| `providerIconRegistry` | `ProviderIconRegistryRow[]` (`shipped-provider-icons.ts`, re-exported by `parts/ui/index.ts`) | The one shipped list; `workspace-controls`, `use-mark`, `next-step-card` and workspace screens read it, so a new logo is one DATA row. |
| `readProviderIconRegistry`, `resolveProviderMark`, `providerProfileUrl`, `normalizeProviderSlug` | see `provider-icon-registry.ts` | Row reading and resolution. |

## Dependencies

**Depends on:** `../../things-to-store-and-run.json` (the rows), `provider-icon-assets.ts`.

**Depended on by:** `coss/workspace-controls.tsx`, `use-mark/use-mark-content.tsx`, `next-step-card/mount-next-step-card.tsx`, `linked-identity`, `connection-list`, `src/workspace/activity-screen.tsx`, `src/workspace/ai-work-screen.tsx`.
