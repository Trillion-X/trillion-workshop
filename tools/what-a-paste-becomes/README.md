# tools/what-a-paste-becomes/

What a paste becomes. In a composer (a message to the AIs, a hand-off, a note) a short paste is a normal insert so the editor's own undo keeps working; a paste over 5,000 characters becomes a named text file; a pasted image attaches only when the clipboard's markup has no words of its own, so a copied web page keeps its text. In a document, a paste from another editor keeps its structure: the pasted HTML says where it came from (a signature that editor writes on its clipboard, such as the Google Docs guid, Word's Office namespace, Notion's comment, Confluence's generator footer) and each element is written as markdown by that source's own rules, then the default ones.

## Files

| File | Purpose |
|------|---------|
| `read-data/paste-policy.mjs` | Calls the existing policy in `tools/messages-screen/read-data/paste-policy.mjs`, preserving this tool's settings, public functions and `decidePaste(input)` JSON command. |
| `read-data/paste-policy.json` | The threshold, the file name, the image prefix, the tags whose bodies are never words, and the words the person reads. |
| `show/paste-sources.ts` | Forwards `pasteSourceOf`, `pastedMarkdown` and `tableRows` to the existing converter in `tools/edit-a-document-together/read-data/paste-sources.ts`. No row runs it; the browser supplies `DOMParser`. |
| `show/paste-sources.json` | The sources, their signatures and their rules, and the default rules. A new editor is one row. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:decide-what-a-paste-becomes`, a `container` row with no internet. |
| `part.json` | The code and its DATA are public. |
| `test/paste-policy.test.mjs` | The original tests (short insert, threshold, long attachment and its words, image-only versus a copy with text, style bodies, `&nbsp;`) and the row's sample run. |
| `test/paste-sources.test.mjs` | In Chromium (`test-helpers/chromium.mjs`): Google Docs, Word and Notion pastes keep their structure, an unknown editor falls to the default rules, an empty paste keeps the plain text, a pasted script is never run, a pasted table becomes rows. |

## Moved from Trillion

The earlier move copied `tools/chat/read-data/paste-policy.mjs` and `tools/documents/read-data/paste-sources.ts` into this tool, while their migrated screen owners also retained the algorithms. This tool now exposes those existing canonical owners through forwarding entries, with no second active clipboard or HTML conversion algorithm. Its local policy settings and original public function names remain available.

The narrow entry contracts describe only this forwarding and JSON invocation seam; they do not claim that paste handling had no older owner. Tests run the actual packaged descriptor and import the browser entry with its canonical module.

## Dependencies

**Depends on:** the public paste-policy files in `tools/messages-screen` and paste-source files in `tools/edit-a-document-together`; Node's standard library; a browser's `DOMParser` for `show/paste-sources.ts`; Playwright's Chromium for its test.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`.
