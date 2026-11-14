# In-place candidate field

`candidate-field.tsx` composes the existing pinned MIT Coss Card, Button, Checkbox and Menu components. It does not copy a proprietary UI. Alex's September 16 mixed-media references guide content-first spacing; his subsequent correction removes repeated kind/status eyebrows, modal reading and duplicate generation forms.

The caller owns records, selected identities, filtering, requests and errors. Text is readable in place; `onPreview` mounts the existing protected playback owner and returns its cleanup. Selection persists in the caller across filtering and view changes. Secondary controls are visible on hover, keyboard focus, selection or touch. No selection action implies taste feedback.

Alex clarified that the rolodex's ethos matters, not necessarily its literal rotating shape. The grid therefore opens an in-place focused option with a narrow strip of actual neighboring items. Arrow keys, Home/End, pointer selection and native horizontal scrolling navigate the strip; only the active media player mounts. Returning to comparison restores the focused item's place. Filters and selections persist. Text-only options use their real titles, never invented thumbnail imagery. Reduced motion disables smooth scrolling.

The conversation column uses `split-dividers/mount-resizable-columns.tsx`, a DOM mounting adapter for the existing shared `SplitDividers`. Pointer movement changes layout immediately without remounting chat or playback; arrows adjust by24px, Home/End select bounds, and Enter/double-click resets. The app persists the chosen width. Mobile stacks content and hides the horizontal divider. Keyboard roles and drag listener cleanup live in the shared primitive; styling remains in screen-look.

Consumer: Expansion `assistant-ui.js`, compiled by `build-shared-controls.mjs`. Focused regression: `mac-app/tests/candidate-browser.test.mjs` covers scoped selection, preference/undo, in-place text and image previews, mixed references reaching chat, refresh and mobile bounds.
