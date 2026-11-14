# touch-equivalence

Gives a finger every gesture a mouse has, once for the whole page, so a control drawn for a mouse works on a phone with no code of its own.

| Mouse | Finger |
|---|---|
| Pointer resting on something (`:hover`) | The last tap landed in it; held until the next tap elsewhere (`data-touch-hover` on the element and every ancestor) |
| Right click (`contextmenu`) | Long press (500 ms), never followed by a click or a lift, so the menu it opens stays open when the finger comes up |
| Double click (`dblclick`) | Double tap (two taps within 320 ms and 24 px) |
| Pressed (`:active`) | `data-touch-press` on what was pressed for a moment |

The workspace stylesheet's `hover` variant (screen-look `coss-workspace.css`) matches `data-touch-hover` as well as `:hover`, so every `hover:` and `group-hover:` reveal shows on a tap.

## Files

| File | Purpose |
|---|---|
| `touch-equivalence.ts` | `installTouchEquivalence(document)`: the listeners on the document's window (capture phase, ahead of every other listener) that mark taps and send `contextmenu` / `dblclick` for long press and double tap. |
| `touch-equivalence.json` | The timings (DATA): long press, double tap time and distance, how far a finger may move before a tap becomes a scroll, how long a press shows. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|---|---|---|
| `installTouchEquivalence` | `(doc?: Document, settings?: TouchTimings) => () => void` | Installs once per document (a second call returns the first teardown); returns the teardown. |
| `TOUCH_HOVER_ATTRIBUTE` | `'data-touch-hover'` | The finger's `:hover`, read by the stylesheet's hover variant and by screen-look `touch.css`. |
| `TOUCH_PRESS_ATTRIBUTE` | `'data-touch-press'` | The finger's `:active`, read by screen-look `touch.css` and `close-control.css`. |
| `TouchTimings` | `{ long_press_ms, double_tap_ms, double_tap_distance_px, move_slop_px, press_flash_ms }` | The DATA shape. |

## Invariants

1. Only touch pointers are mapped; a mouse and a pen keep their own hover, right click and double click.
2. A long press never also clicks, and its lift (`pointerup`, `touchend`) reaches no other listener; a gesture the browser already sends (Android's long-press menu, a native dblclick) is never sent twice.
3. Text fields keep their own long press (caret magnifier, selection) and double tap (select a word).
4. A finger that moves past the slop is scrolling or dragging: no press, no long press, no tap.

## Dependencies

**Depends on:** nothing but the DOM.

**Depended on by:** `screen-arrangement/show/mount-screen-arrangement.tsx` (installs it with the stage); screen-look `coss-workspace.css` (hover variant), `touch.css`, `close-control.css`; `test/touch-equivalence.test.mjs`.
