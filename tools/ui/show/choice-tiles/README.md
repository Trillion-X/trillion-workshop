# Choice Tiles

The one picker of a choice drawn as tiles (which AI app you use, say), the button that goes to the chosen one, and the
choice remembered across every place that offers it.

| File | Purpose |
|---|---|
| `ChoiceTiles.tsx` | Equal bordered tiles in a wrapping grid, each a logo or icon and a name, the chosen one ringed; as a tablist (the guide's "Pick the AI you use") or as buttons. A tile may copy its words when picked and say Copied on itself. |
| `OpenChoice.tsx` | A button that opens the remembered choice's address in a new tab ("Ask Claude"), a small button beside it to choose another; before any choice it opens the tiles. A choice whose address takes no words copies them first. |
| `remembered-choice.ts` | The choice kept in this browser's storage and in a cookie a server page reads (`trillion_choice_<key>`); one event keeps every place on the page current. |
| `index.ts` | Public barrel. |

| Name | Signature / Shape | Role |
|---|---|---|
| `ChoiceTile` | `{ id, label, picture?, icon?, copy?: { text, copied_label } }` | One tile. |
| `ChoiceTiles` | `({ tiles, chosen, onPick, kind?: 'tabs' \| 'buttons', label? }) => JSX` | Draws the tiles; `onPick(tile)` is the caller's. |
| `OpenableChoice` | `ChoiceTile & { href, paste? }` | A tile with the address its press opens. |
| `OpenChoiceWords` | `{ chosen: 'Ask {label}', unchosen, choose, icon? }` | The button's words. |
| `OpenChoice` | `({ choices, remember, labels, words?, variant? }) => JSX` | The go-to-your-choice button. |
| `rememberedChoice` / `rememberChoice` / `useRememberedChoice` | `(key) => id \| null` / `(key, id) => void` / `(key) => [id, choose]` | The remembered choice. |
| `choiceCookie` | `(key) => string` | The cookie's name, for a server page. |

**Depends on:** `../coss/ui/button`, `../coss/ui/popover`, `../coss/logo`, `../icon/NamedIcon`, `../copy-button/CopyButton` (`useCopy`, `CopyMark`, `CopyWords`, `CopyStatusLine`), `../clipboard/copy-text`; look in `parts/screen-look/show/choice-tiles.css`.

**Depended on by:** `../coss/guide.tsx` (a section's `tabs`, the "Pick the AI you use" step on Use Trillion in your AI and the welcome tour), `../screen-state/ScreenState.tsx` (the Ask your AI button of every failed state).
