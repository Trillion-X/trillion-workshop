# tools/read-the-menu-bar-settings/

The Mac menu bar item's own settings: whether the item shows, how far ahead a meeting counts down to, how long the title may be and the app icon. Each setting shows the value the Mac app last answered, or its default, and a change is accepted only when its setting allows the value.

Ported from trillion-apps `web/src/workspace/panel-settings.mjs` (`panelSettingsState`, the `KINDS` shape checks and the `setPanelSetting` message) and the rows in `macos/App/menu-bar-panel.json` `settings.rows`, at commit `21a2de08`. The row definitions are handed in by the caller, who keeps them as the app's DATA, so this folder holds no copy of them.

## Rules carried

- An answer of the wrong shape (an unknown row, a different kind, a value the row does not allow, no rows) is no answer: every row then shows its default.
- A switch takes true or false; a choice takes one of its choice ids; a range takes a number between its least and most. The range rule checks limits only, as the app's rule did, so a step is not enforced.
- A change to an unknown row, or to a value its row does not allow, is refused.

## Files

| File | Purpose |
|------|---------|
| `do-work/read-the-menu-bar-settings.mjs` | `tool:read-the-menu-bar-settings`: one JSON input on standard input, `{ result }` or `{ error }` on the last line. |
| `test/read-the-menu-bar-settings.test.mjs` | Tests for defaults, held answers, wrong-shape answers, accepted and refused changes, and bad definitions. |
| `tool-rows.json` | The Workshop row. |
| `part.json` | The entry the row runs is public. |

Not carried: the page's message that asks the host for the rows and sends one row's change (`askPanelSettings`, `setPanelSetting`) stays in the app, since it is the app's delivery to the Mac host.
