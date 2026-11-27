# tools/publish-articles/

The published articles of one pursuit, their RSS feed, and a double opt-in newsletter signup, all read from that pursuit's own rows (`articles`, `courses`, `subscribers`). It replaces `tools/serve-articles-and-signup`. It serves no page: the site tool draws the screens.

## Files

| File | Purpose |
|------|---------|
| `do-work/articles.ts` | `tool:read-published-articles` (newest first) and `tool:read-a-published-article` (sections, sources, related, course). Only a published row whose date has passed is answered. Markdown becomes data, never HTML. |
| `do-work/rss.ts` | `tool:read-the-articles-feed`: RSS 2.0 text with every value escaped. |
| `do-work/signup.ts` | `tool:plan-a-newsletter-signup` and `tool:plan-a-newsletter-confirmation`: plans only. They answer the statements to run and the message to send; nothing is sent or written here. |
| `do-work/serve.ts` | The one main of the reads: `node serve.ts <reader name>`. It answers a read; it serves no page. |
| `show/ArticleList.tsx`, `show/Article.tsx`, `show/Inline.tsx` | The screens; each `View(props)` is pure and its props are the answer of its read. |
| `tests/` | Reads, feed, signup plans and the screens drawn to markup. |
| `what-this-tool-does-and-how-to-run-it.json` | The cards. |

## Known gaps

- `tool:prepare-a-newsletter-audience` and the unsubscribe routes still live in `tools/serve-articles-and-signup`, which is deleted after this tool serves the site.
