# ai-readiness

Reads a page the way a search or answer engine does, from the HTML it is served with and no script run, and says which checks pass, which are missing and how to fix each. Also adds, to a published page that leaves them out, the language, address and dates an engine looks for, and answers a page as Markdown when a reader asks for it.

## Files

| File | Purpose |
|------|---------|
| `part.json` | What other parts and tools may use from this folder. |
| `tool-rows.json` | The Workshop row Trillion reads for this folder: `tool:check-a-page-for-search-and-answer-engines`. |
| `test/ai-readiness.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. Every page in them is made up. |
| `do-work/audit-served-html.mjs` | The audit engine: a small HTML reader, the shapes a check row can take, and the score. Knows no check by name. |
| `do-work/check_a_page.mjs` | The container tool: fetches one public page, its host's `robots.txt` and (up to the limit in the checks DATA) the pages it links to, runs the audit and answers the report as JSON on stdout. |
| `do-work/complete-served-html.mjs` | `completeServedHtml(html, facts)`: adds `<html lang>`, a canonical link and the published/updated meta tags only where the page has none. |
| `do-work/negotiate-markdown.mjs` | `prefersMarkdown(accept)`, `htmlToMarkdown(source, origin)`, `negotiateMarkdown(request, response, limits)`: a page a server draws as Markdown when the Accept header explicitly asks for `text/markdown` (`*/*` never counts; higher q wins; equal q, the range named first). Sets `x-markdown-tokens` and `x-original-tokens`, adds `Vary: Accept`, drops `content-length`, `content-encoding`, `content-range`, `etag` and `last-modified`. |
| `read-data/ai-readiness-checks.json` | The checks as DATA (id, area, words, fix, source, scored or not, and the check shape) and the limits. |
| `read-data/markdown-conversion.json` | The element names the Markdown conversion drops or breaks paragraphs on. |
| `read-data/served-page-completion.json` | The language and meta property names `completeServedHtml` writes. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `checkAPage` | `({ url, checks?, skip? }, getter?) => Promise<{ url, final_url, status, indexable, score, passed, failed, missing, suggestions, not_checked }>` | The tool's read. `checks` replaces the shipped check rows; `skip` names check ids not to run. Throws on a page that does not answer 2xx. |
| `auditServedHtml` | `({ html, robotsTxt?, resolveLink?, pageUrl?, now?, checks?, skip? }) => Promise<{ score, passed, failed, missing, suggestions, not_checked, results }>` | A page with a `noindex` robots meta gets `indexable: false`, no score and no checks. `score` is the share of scored checks that pass among those that apply and could be run (null when none). `missing` are failed scored checks with `says`, `fix` and up to three `examples`; `suggestions` are failed unscored checks; `not_checked` are checks that needed an input not given (`robotsTxt`, `resolveLink`). |
| `robotsAllows` | `(robotsTxt, agent, path?) => boolean` | The agent's own group, else `*`; the longest matching rule wins, an allow wins a tie. |
| `parseHtml` | `(html) => { elements, textOf, visibleText, mainText, structuredData }` (`mainText` is the `<main>` landmark's words, null without one; `text` checks with `first_words` read it, so a mega-menu before the page does not push the definition out of its first words) | The reader the checks share. |
| check shape | `elements` (selector or list: `tags`, `attr_present`, `attr_absent`, `attr_matches` with `a\|b` names, `attr_absent_values`, `text_pattern`, `within_main` (only inside the `<main>` landmark when the page has one)) with `each` (`named`, `labelled`, `attr_present`, `attr_not_matches`, `text_pattern`, `text_words`, `following_paragraph_words`), `nth`, `count`; or `text`, `words`, `head`, `headings_in_order`, `dates`, `robots`, `links`, `any_of`, `all_of`; any row may carry `applies_when` (the check runs only where it passes) or `skip_when` (it does not run where it passes; a page with a password field is a form, not an article). | A row combines these; a new check is a new row. |

## Dependencies

**Depends on:** nothing but the platform. The engine, the completion and the Markdown files use no file system and no network (the caller supplies the HTML, the robots.txt text and the link resolver). `check_a_page.mjs` uses Node's own `fetch`, which the engine routes through its public-only proxy because the tool row is `internet: true`.

**Depended on by:** `tool-rows.json` (ships `check_a_page.mjs`, `audit-served-html.mjs` and `ai-readiness-checks.json` into the container), `test/ai-readiness.test.mjs`, and the recipe `workflow-recipe:get-found-in-search-and-answer-engines` in `tools/workflows/recipes/`.

## Invariants

- The audit reads served bytes only: text a script would add is not counted, which is the point.
- A check lives in DATA. The engine holds no word list or threshold.
- A check that needs an input the caller did not give is `not_checked` and leaves the score alone; it is never a pass.
- `completeServedHtml` never changes anything the owner's page already says.
- The tool never asks for an address the engine's proxy would refuse; it checks only that an address is http or https with a host and no user name.
