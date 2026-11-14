# share-card

A card of someone's numbers to share, the sheet that shares it, and the sheet that shares a link that already exists: the card is one SVG picture drawn from DATA, turned into a PNG in the browser, so the same picture is what the page shows, what "Save image" saves and what a shared link previews. No server draws pictures.

## Files

| File | Purpose |
|------|---------|
| `share-card.ts` | `shareCardSvg` lays out a `ShareCard` (headline, up to three stats, the line of every point, footer) as a 1200×630 SVG with every word escaped; `shareCardSrc` gives it as an image address; `cardPng` draws it into a canvas and returns a PNG; `improved` says whether a line moved the way that counts as better. |
| `LinkShareSheet.tsx` | `LinkShareSheet`: hands a link that already exists (an invite link, a sales page) to the one sharing sheet: the link as its preview, one place per DATA row that opens at once with `{url}` and `{text}` filled in, and Copy link and Share (the device's share sheet, or a copy where there is none) as its buttons. |
| `ShareSheet.tsx` | `ShareSheet`: makes the picture and the link and hands them to the one sharing sheet (`sharing-sheet/SharingSheet.tsx`): the card as its preview, one place per DATA row that opens at once, and Share (the device's share sheet, with the PNG attached where allowed), Copy link and Save image as its buttons. The first press makes the picture and calls `create`; later presses reuse the link. |

## Key Types / Functions

| Type / Export | Signature / Shape | Role |
|---------------|-------------------|------|
| `ShareCard` | `{ headline, stats: ShareCardStat[], line?: ShareCardLine, footer? }` | The card as DATA; no product words live here. |
| `ShareCardStat` | `{ label, value, detail?, tone? }` | One number; `tone: 'good'` colours its detail green. |
| `ShareCardLine` | `{ label?, points: number[], better?: 'lower' \| 'higher' }` | Every point oldest first; green when it moved the better way, amber otherwise. |
| `shareCardSvg` | `(card) => string` | The picture. |
| `cardPng` | `(card) => Promise<Blob>` | The picture as a PNG, made in this browser. |
| `SharePlace` | `{ id, label, href, logo?, icon? }` | A place to send the link; `href` fills `{url}` and `{text}`. |
| `ShareSheet` | `({ card, text, places, words, create })` | The sheet; `create({ image_base64? })` returns `{ url, text? }`. |
| `LinkShare` | `{ url, text, title, places: SharePlace[], words: LinkShareWords }` | A link to share, as DATA. |
| `LinkShareWords` | `{ link, share, copy, copied, failed }` | The sheet's words. |
| `LinkShareSheet` | `(share: LinkShare)` | The sheet for a link that already exists. |

## Dependencies

**Depends on:** `sharing-sheet/SharingSheet` (draws it), `coss/notifications`, `clipboard/copy-text`, `file-download/download-file`.
**Depended on by:** `coss/guide.tsx` (a guide section's `share`, which Trillion's Progress screen fills from `src/progress-trends.mjs`, and its `link_share`, which the Account screen's invite section fills from `src/referral-screen.mjs`).

## Invariants

- Nothing is public until a button is pressed.
- A place on the web opens in a window claimed at the press, so browsers that block windows opened after a wait let it through.
- A card that cannot be drawn still shares its link; every failure says what to do next.
