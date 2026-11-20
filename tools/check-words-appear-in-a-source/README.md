# tools/check-words-appear-in-a-source/

Check that exact words appear on the page they are quoted from, said by the person named, before anyone uses them as a quote. It runs on the person's own computer and keeps nothing: the answer is the record of the check.

## Files

| File | Purpose |
|------|---------|
| `do-work/check_words.py` | The check: one JSON request (a file named as the first argument, or standard input), one JSON answer as the last line. |
| `tool-rows.json` | The row `tool:check-words-appear-in-a-source` (`on-your-computer`). |
| `kits/check-words-appear-in-a-source.json` | How to start, the steps and one worked example. |
| `test/test_check_words.py` | 9 tests on made-up pages: exact words under the right speaker, words another speaker said, words only inside a script, a paraphrase, curly quotes and dashes, a page with no speaker labels, a page that cannot be read, one read per page, the command's answer and refusal. |
| `test/check-words-appear-in-a-source.test.mjs` | Runs the Python tests under `npm test` and checks the row names a script in this folder. |

## Request and answer

```json
{"checks": [{"id": "optional", "words": "the exact words", "url": "https://... or", "file": "/absolute/path", "speaker_label": "NAME as the page labels it"}]}
```

The last line is `{"result": {"checks": [{"id", "found", "speaker_seen", "verified", "bytes", "checked_at", "error"?}]}}`, one per check in request order; a check with no id takes its index, and other fields of a check are ignored, so a list of candidates can be passed as it is.

## How it checks

- The page's words are the words a reader sees: scripts and styles are removed, tags are removed, entities are read, curly quotes, dashes, ellipses and spaces are made one form on both sides.
- `found` is an exact match of the words in that text. A paraphrase is not found.
- When the page labels its speakers in capitals (`NAME:`, as press-conference transcripts do), the last label before the words is `speaker_seen`, and `verified` is true only when it is the `speaker_label` asked for. Words a moderator, a reporter or another guest said on the same page are refused.
- A page with no capital labels is trusted as one speaker's page (an essay, a speech); `speaker_seen` is null.
- A page that cannot be read is a failed check with the reason in `error`.

## Dependencies

**Depends on:** Python 3 standard library only (`urllib`, `html`, `re`, `json`).
**Depended on by:** `tools/workflows/recipes/make-a-quote-card-deck.json` (its `check` step).
