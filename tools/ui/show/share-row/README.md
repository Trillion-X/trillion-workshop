# share-row

The row under an article, a changelog entry or a story that lets a reader pass it on: Copy link, one button per place (X and LinkedIn by default), and the phone's own share sheet, drawn as server HTML from DATA.

## Files

| File | Purpose |
|------|---------|
| `share-row-html.mjs` | `shareRowHtml` (the row's markup), `shareHref` (a place's filled address), `SHARE_ROW_CSS` (its look, from `--share-*` roles), `SHARE_ROW_SCRIPT` (shows and wires Copy link and the share sheet where the browser can do them) |
| `share-row.json` | The row's default words (`Share`, `Copy link`, `Link copied`, `More ways to share`), its places (X, LinkedIn: `{ id, label, aria_label, href, mark }`, `href` filling `{url}` and `{text}`) and its marks (link, check, share), with their licences |

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `shareRowHtml` | `(share: { url, text, compact?, words?: { label, copy, copied, more }, places?: Place[], native?: false }) => string` | The row; `''` when `url` is not an absolute web address. Words and places not given come from `share-row.json`. `places: []` with `native: false` is Copy link alone (the Android share page offers it for the link it just received). |
| `shareHref` | `(template, { url, text }) => string \| null` | `template` with `{url}` and `{text}` URI-encoded in; null unless the result is a web address. |
| `SHARE_ROW_CSS` | string | Rules for `.share-row` and its parts; colours only from `--share-ink`, `--share-muted`, `--share-line`, `--share-fill`, `--share-strong`, `--share-on-strong`, `--share-focus`, which each host maps from its theme roles. |
| `SHARE_ROW_SCRIPT` | string | For every `[data-share-row]`: shows Copy link where the clipboard can be written (the label says `Link copied` for 1.8 s, announced politely) and the share-sheet button where `navigator.share` exists and the pointer is coarse. |
| `Place` | `{ id, label, aria_label, href, mark: { view_box, filled, nodes: [[shape, attributes]] } }` | One place a link is sent; a new place is one row. |

## Dependencies

**Depends on:** `../server-rendered-page/escape-html.mjs` (`escapeHtml`).

**Depended on by:** `../document-page/document-page-html.mjs` (`article.share`, a block's `share`: gettrillion.ai articles and changelog entries), `../server-rendered-page/page-sections-html.mjs` (a section's `share`: Trillion's public stories). Tested by `test/share-row.test.mjs`.

## Invariants

- Every caller value is escaped; the shared address and every filled place address must be absolute web addresses.
- Without scripting the places still work as plain links; Copy link and the share sheet start hidden and appear only where they work.
- This folder names no product, page or colour.
