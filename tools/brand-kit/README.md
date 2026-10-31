# tools/brand-kit/

A brand is rows of a list, one per logo variant, and one selection row names the family in use. This folder picks the variant a light or a dark page draws: the black wordmark on a light page, the white one on a dark page, a mark on its own square of the page colour. The rows are the person's own and stay in their list; changing a brand is writing rows there. Ported from the account's brand kit (its share pages and emails read the same rows): the resolver unchanged in behaviour, with the list writes left to the list owner.

## Files

| File | Purpose |
|------|---------|
| `read-data/brand-assets.mjs` | `assetForBrand(rows, { role, format, tone })`, `presentationFromBrand(rows, tone)`, `selectedFamily(rows)`, `BRAND_FIELDS`: the pure picks. |
| `do-work/resolve-a-brand.mjs` | `node do-work/resolve-a-brand.mjs <request.json>`: prints the family in use, every variant for both tones and the ones the asked tone draws. |
| `tool-rows.json` | `tool:resolve-a-brand`, an `on-your-computer` row. |
| `part.json` | `read-data/brand-assets.mjs`, which other tools may import. |
| `test/resolve-a-brand.test.mjs` | A made-up brand: the selected family only, both row shapes, unsafe addresses refused, local copies named. |

## How to run it

```
node tools/brand-kit/do-work/resolve-a-brand.mjs request.json
```

`request.json`:

```json
{
  "rows": [
    { "id": "harbour", "values": { "name": "Harbour", "family": "original", "role": "selection" } },
    { "id": "wordmark-black", "values": { "family": "original", "role": "wordmark", "format": "svg",
      "background": "black on transparent", "url": "https://assets.example.test/brand/wordmark-black.svg" } }
  ],
  "tone": "light",
  "files_at": "brand-copies"
}
```

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| brand row | `{ id, values | value: { name, brand, family, role, format, background, url, source } }` | One logo variant, or (role `selection`) the family in use. |
| `assetForBrand` | `(rows, { role, format, tone }) => { url, row_id, family } | null` | The variant one page draws. |
| `presentationFromBrand` | `(rows, tone) => { family, tone, variants: { light, dark }, chosen }` | Every variant and the chosen ones. |

## Dependencies

**Depends on:** Node's standard library.

**Depended on by:** `tools/workflows/recipes/make-a-brand-book-and-decks.json` (the logo a slide draws).

## Invariants

- Only the selected family is drawn; a missing variant is null, never another family's file.
- An address is used only when it is HTTPS without credentials.
- Nothing here names a brand, an account or a colour.
