# tools/what-a-paste-becomes/

What a paste becomes. In a composer (a message to the AIs, a hand-off, a note) a short paste is a normal insert so the editor's own undo keeps working; a paste over 5,000 characters becomes a named text file; a pasted image attaches only when the clipboard's markup has no words of its own, so a copied web page keeps its text. In a document, a paste from another editor keeps its structure: the pasted HTML says where it came from (a signature that editor writes on its clipboard, such as the Google Docs guid, Word's Office namespace, Notion's comment, Confluence's generator footer) and each element is written as markdown by that source's own rules, then the default ones.

## Files

| File | Purpose |
|------|---------|
| `read-data/paste-policy.mjs` | `pasteDecision(clipboard, { settings, now })` and `markupHasText(markup)`, plus `decidePaste(input)`, the container's run of `tool:decide-what-a-paste-becomes`. |
| `read-data/paste-policy.json` | The threshold, the file name, the image prefix, the tags whose bodies are never words, and the words the person reads. |
| `show/paste-sources.ts` | `pasteSourceOf(html)`, `pastedMarkdown(html, parse?)` and `tableRows(html, parse?)`: the browser side, run where the paste lands (it reads the HTML with the page's `DOMParser`; nothing pasted is ever run). No row runs it. |
| `show/paste-sources.json` | The sources, their signatures and their rules, and the default rules. A new editor is one row. |
| `tool-rows.json` | `tool:decide-what-a-paste-becomes`, a `container` row with no internet. |
| `part.json` | The code and its DATA are public. |
| `test/paste-policy.test.mjs` | The original tests (short insert, threshold, long attachment and its words, image-only versus a copy with text, style bodies, `&nbsp;`) and the row's sample run. |
| `test/paste-sources.test.mjs` | In Chromium (`test-helpers/chromium.mjs`): Google Docs, Word and Notion pastes keep their structure, an unknown editor falls to the default rules, an empty paste keeps the plain text, a pasted script is never run, a pasted table becomes rows. |

## Moved from Trillion

Moved from Trillion-X/trillion `parts/chat/read-data/paste-policy.mjs` (+ `.json`) and `parts/documents/read-data/paste-sources.ts` (+ `.json`), code unchanged except the header paths and the container entry added to `paste-policy.mjs`. The tests moved with them. The old copies stay in Trillion while their callers import them: `parts/chat/show/ChatInput.tsx` (paste policy), `src/workspace/row-clipboard.ts` and `parts/documents/show/DocumentEditor.tsx` (paste sources). The editor, composer and board clipboard parts of `test/paste-and-row-clipboard-browser.test.mjs` stay with those callers.

## Dependencies

**Depends on:** Node's standard library; a browser's `DOMParser` for `show/paste-sources.ts`; Playwright's Chromium for its test.

**Depended on by:** `tool-rows.json`.
