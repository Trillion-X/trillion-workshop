# tools/brand-kit/

A brand is rows of a list, one per logo variant, and one selection row names the family in use. This folder picks the variant a light or a dark page draws: the black wordmark on a light page, the white one on a dark page, a mark on its own square of the page colour. The rows are the person's own and stay in their list; changing a brand is writing rows there. Ported from the account's brand kit (its share pages and emails read the same rows): the resolver unchanged in behaviour, with the list writes handed back as keep rows for the caller to store.

## Files

| File | Purpose |
|------|---------|
| `read-data/brand-assets.mjs` | `assetForBrand(rows, { role, format, tone })`, `presentationFromBrand(rows, tone)`, `selectedFamily(rows)`, `BRAND_FIELDS`: the pure picks. |
| `do-work/resolve-a-brand.mjs` | `node do-work/resolve-a-brand.mjs <request.json>`: prints the family in use, every variant for both tones and the ones the asked tone draws. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:resolve-a-brand`, an `on-your-computer` row. |
| `part.json` | `read-data/brand-assets.mjs`, which other tools may import. |
| `test/resolve-a-brand.test.mjs` | A made-up brand: the selected family only, both row shapes, unsafe addresses refused, local copies named. |
| `src/brand-assets.mjs` | The held old brand API: worn-look palette, bundled fallback selection, brand list actions, and supplied admitted presentation readers. |
| `read-data/brand-asset-actions.mjs` | `runBrandKit(input)`: create, read, edit, import, export, save, remove, select, resolve and delete, over the list, rows, worn look and in-use flag handed in as `input.stored`. Writes come back as `keep`, each with the value it expected. A field left out is a `needs` answer that keeps nothing. |
| `test/brand-assets.test.mjs`, `test/brand-keep.test.mjs` | The selection and fallback picks, and the list actions run against a store that applies `keep` only when each record still holds its expected value. |

The full brand API is a library port, separate from the existing resolver command. It does not install a new tool row or publish a service brand. Its caller reads the list, its rows, the worn look and the in-use flag from its own store and hands them in; the retired Worker service actor is not recreated. The service presentation record is read by its caller and handed in as well.

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
