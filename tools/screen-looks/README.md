# tools/screen-looks/

A look is tokens; this resolves them into concrete colours and fonts and one stylesheet any page or slide can carry. The look record is the person's own (the colours, sizes and fonts they chose), and so are the font files: nothing here names a colour, a font or a brand. Ported from the account screens' look owner: the token-to-value resolver unchanged, and the document stylesheet changed only so its faces are passed in instead of read from a bundled file.

## Files

| File | Purpose |
|------|---------|
| `read-data/resolve-screen-look-palette.js` | `resolveScreenLookPalette(look)`: the one token-to-value resolver. A look's tokens in, `{ '--variable': 'concrete value' }` out (colours, type sizes, radii, spacing, motion, fonts). Zero dependencies. |
| `read-data/look-document-css.js` | `lookDocumentCss(palette, faces)`: a `@font-face` (bytes as a data: address) for each face whose family the look's font variables name, then the look's variables as one `:root` rule. Unsafe names, values and faces are left out. |
| `do-work/resolve-a-look.mjs` | `node do-work/resolve-a-look.mjs <request.json> [--css <out.css>]`: reads the look and the face files, prints the values, writes the stylesheet. |
| `tool-rows.json` | `tool:resolve-a-look`, an `on-your-computer` row. |
| `part.json` | The two read-data files other tools may import. |
| `test/resolve-a-look.test.mjs` | A made-up look and made-up face bytes: concrete values, only the named faces, unsafe values refused. |

## How to run it

```
node tools/screen-looks/do-work/resolve-a-look.mjs request.json --css look.css
```

`request.json`:

```json
{
  "look": { "tokens": [ { "key": "accent-primary", "css_variable": "--accent-primary", "kind": "color", "value": "#0f7a6b" },
                        { "key": "displayFontFamily", "kind": "text", "value": "Tidewater Serif" } ] },
  "faces": [ { "family": "Tidewater Serif", "weight": 600, "file": "fonts/tidewater-semibold.woff2" } ]
}
```

It prints one JSON line `{ palette, families, faces_written, faces_missing, css_bytes }`, or `resolve-a-look: <what is wrong>` on standard error with exit 2.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `resolveScreenLookPalette` | `(look: { tokens }) => Record<string, string>` | Concrete values by CSS variable name. |
| `familiesNamedBy` | `(palette) => Set<string>` | The first family of each font variable's stack. |
| `lookDocumentCss` | `(palette, faces: { family, weight, style, format, data }[]) => string` | The stylesheet a document carries. |

## Dependencies

**Depends on:** Node's standard library.

**Depended on by:** `tools/turn-frames-into-slides` (slides wear the look through its values and stylesheet) and `tools/workflows/recipes/make-a-brand-book-and-decks.json`.

## Invariants

- One resolver: every surface that wears a look reads these values; none recomputes them.
- No font file ships here. A face is written only when the person passes its file and the look names its family.
- A variable value that could end the rule or the style element (`{ } ; < > \`, `url(`, `@import`, a comment) is never written.
