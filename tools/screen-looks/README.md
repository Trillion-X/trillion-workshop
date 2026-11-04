# tools/screen-looks/

A look is tokens; this resolves them into concrete colours and fonts and one stylesheet any page or slide can carry. The look record is the person's own (the colours, sizes and fonts they chose), and so are the font files: nothing here names a colour, a font or a brand. `tool:read-current-worn-look` reads the person's current look records through the selected workspace door and combines them with app-owned look, schedule and rule DATA the caller passes in. It returns the device token payload, scheduled blends and upcoming changes.

## Files

| File | Purpose |
|------|---------|
| `read-data/resolve-screen-look-palette.js` | `resolveScreenLookPalette(look)`: the one token-to-value resolver. A look's tokens in, `{ '--variable': 'concrete value' }` out (colours, type sizes, radii, spacing, motion, fonts). Zero dependencies. |
| `read-data/device-look-tokens.js` | `deviceLook(look, palette, button)`: converts that resolved palette to the exact colours, lengths, faces and button fields native devices carry. |
| `read-data/look-document-css.js` | `lookDocumentCss(palette, faces)`: a `@font-face` (bytes as a data: address) for each face whose family the look's font variables name, then the look's variables as one `:root` rule. Unsafe names, values and faces are left out. |
| `do-work/resolve-a-look.mjs` | `node do-work/resolve-a-look.mjs <request.json> [--css <out.css>]`: reads the look and the face files, prints the values, writes the stylesheet. |
| `do-work/read-current-worn-look.mjs` | `readCurrentWornLook(input, { door })`: reads the current screen-look and own-theme records plus the day plan and look rules; returns `DeviceLooks` tokens, current blend, ahead changes and next read time. |
| `read-data/look-over-time.mjs`, `read-data/look-scheme.mjs` | Pure schedule placement/blending and colour/readability behavior used by the account look reader; `.d.mts` files preserve TypeScript signatures. |
| `read-data/colour-ladder.ts` (+ `colour-ladder.json`) | `isColour`, `degradeColour`, `clampToBounds`, `isSafeText`: a value a look cannot draw takes the next rung (as authored, the default look's, a neutral grey) instead of failing the look. |
| `read-data/read-editable-screen-look-themes.ts`, `read-data/screen-look-record.ts` | A look as a `{ address, payload }` record: read, validated per token kind and bounds (`changeScreenLookTokens`), tinted from one colour (`tintScreenLook`), and its scheme read from its ground. |
| `read-data/tint-look.ts` (+ `tint-rules.json`) | Any-tint looks in OKLCH: the picked colour keeps only its hue; each role's lightness is pinned and its chroma clamped to the sRGB gamut, so contrast holds whatever is picked. |
| `read-data/type-register.ts` (+ `type-registers.json`, `look-tuning.json`) | `wearRegister(theme, id)`: one choice swaps every type role between the compact sans and the editorial serif register. |
| `read-data/theme-from-inputs.ts` (+ `theme-inputs.json`) | `themeFromInputs({ base, accent, contrast })`: a whole look derived in OKLCH from three picks and held to contrast floors; a floor it cannot hold is named in `unmet`. |
| `tool-rows.json` | `tool:resolve-a-look`, an `on-your-computer` row. |
| `part.json` | Public palette, stylesheet and look DATA for other tools to import. |
| `test/resolve-a-look.test.mjs` | A made-up look and made-up face bytes: concrete values, only the named faces, unsafe values refused. |
| `test/read-current-worn-look.test.mjs` | Record identities, native token payload, absent-versus-unavailable behavior, matching rules and scheduled blends. |
| `test/colour-ladder.test.ts`, `test/tint-look.test.ts`, `test/type-register.test.ts`, `test/theme-from-inputs.test.ts` | The moved look modules' own tests (the `save_look` cases stay with their caller in old trillion). |
| `test/focus-ring.test.mjs` | The resolver's focus ring: a page-coloured gap, an ink ring and a soft accent glow, with a danger twin of the same shape. |

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

**Depends on:** Node's standard library and the shared `wall-time` zone validator. The records-door action also composes the shared `formulas` rule evaluator and the `records-door` runner. Its `app_data` input is the app owner's `{ looks, look_over_time, where_looks_apply }` DATA; it must name a starting look, and the two settings records must use `screen-look-over-time` and `where-looks-apply` as their record keys.

**Depended on by:** Native device hosts for their current look; `tools/turn-frames-into-slides` and `tools/workflows/recipes/make-a-brand-book-and-decks.json` for resolved document styles.

## Invariants

- One resolver: every surface that wears a look reads these values; none recomputes them.
- No font file ships here. A face is written only when the person passes its file and the look names its family.
- A variable value that could end the rule or the style element (`{ } ; < > \`, `url(`, `@import`, a comment) is never written.
