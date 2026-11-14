# server-rendered-page

The one place a server-drawn page is written as HTML, and the one check that every failure a browser opens leaves the service as such a page.

## Files

| File | Purpose |
|------|---------|
| `page-sections-html.mjs` | The page shell: turns a page description (title, sections, actions, icons, look) into a whole HTML document. The only HTML sink for server-drawn pages. |
| `markup-tree.mjs` | `element`, `textOf`, `serialise`: markup built as a tree of plain elements and written once through the one escape, for documents that are not pages (the standalone SVG of `../layer-diagram/graph-svg.mjs`, the copied answer of `../clipboard/answer-copy.mjs`). |
| `page-work.mjs` | `startWork(action, words)`: a pressed page action says its work in itself (21st.dev Loading Button anatomy): the one loading animation and its pending words while it runs, changing as it runs long and saying when it was asked again (`../still-working`, the page's chosen words), no more presses; a check and its done words when it worked; a mark and "Try again" when it failed, then its own label. `loadingMark()` draws the needle and thread for a page that only waits. Bundled into a page's own script (Trillion `src/client/passkey.mjs`); it wears screen-look's `loading-mark.css`. |
| `escape-html.mjs` | `escapeHtml`, the one escape every server-side sink in `parts/ui/show` shares; it imports nothing, so the share row and the document page use it without importing a sink. |
| `page-egress.mjs` | Where answers leave a service: a failure (status 400 and up) that a browser navigation gets as text, JSON, unmarked HTML or an empty body is replaced by the caller's shell page with the same status and the route's plain words. Everything else passes untouched. |

## Key types / functions

| Export | Signature / shape | Role |
|--------|-------------------|------|
| `pageShellHtml` | `(description, { stateScripts }) => string` | The whole document for a page description. The page's sections always sit in one `<main>` landmark (inside the layout's own when there is one). |
| `description.dates` | `{ published?, modified? }`, each `{ label, iso, text }` | The page's publish and last-change dates: written as `article:published_time` / `article:modified_time` meta tags and once more where a reader sees them, a quiet closing line "Published <time> · Updated <time>" with each date in a `<time datetime>` element. `label` and `text` are the caller's own words. Without `iso` that date is left out. |
| `description.meta_description` | `string` | The page's description for engines and link previews. Left out, the first words of the first section with a body (cut at a word, 160 characters) are used; a page with no words writes none. |
| `description.island` | `{ bundle_url, bundle_type?: 'module', bundle_async?: true, preload_urls?, stylesheet_url?, mount_element_id?, inline_css?, noscript_route? }` | The page's script: a classic deferred script, or with `bundle_type: 'module'` a module script whose `preload_urls` are each a `modulepreload` link fetched alongside it; `bundle_async` runs it as soon as it is loaded instead of after the whole page has arrived. |
| `pageSectionsHtml` / `sectionHtml` | `(sections) => string` | Sections only, for a page drawn inside another frame. A section's `markdown` (with `markdown_breaks: true` for plain words whose every line break counts) is drawn after its body by the one markdown renderer (`../document-page` `markdownHtml`) as `.page-prose`, a reading column; a share link to a file of words was one (`src/record-share-pages.mjs`, now the Workshop tool tools/write-public-share-files). A section's `share: { url, text, compact? }` draws the shared share row (`../share-row`) at its end; its rules and script are added to the page only when a row is drawn. |
| card `cover` | `{ label?, glyph?, src?, alt?, text? }` | A browsable card's visual cover. A safe picture wins when supplied; otherwise `text` shows escaped, caller-bounded words in the cover, and a glyph remains the fallback. The renderer does not fetch content to make the cover. |
| section `views` | `[{ as, label, settings?, fields, rows }]` | One empty host per saved view a page shows (a `page-view` group named by `label`, carrying `data-list-view=as`), holding the view's settings, the list's fields and the rows it keeps as one inert JSON script (`script.page-view-data`, with the angle brackets, ampersand and line separators escaped so nothing can close it). The page's script (`src/workspace/shared-list-views.tsx`) draws the view `as` names; nothing here names a kind of view. A page that carries one loads its `island`. |
| section `choices` | `{ href, values, groups: [{ name, label?, multiple?, options: [{ value, label, detail?, checked?, depth? }] }], fields?: [Field], submit: { label, tone? } }` | One form that works with no script: a group with `multiple` draws a tick box per option, otherwise one round choice per option; an option's `depth` sets it in under the one above it (tree order); `fields` are text boxes after the groups; pressing the button posts every ticked value under its group's name, every field's words under its name, plus the plain `values`. Names are plain words from DATA. |
| `Field` | `{ name, label, kind?, placeholder?, lines?, max_length?, min_length?, required?, autocomplete?, inputmode?, value?, label_action?: { label, href }, reveal?: { show, hide }, hint?, strength?, hidden?, length? }` | A labelled text box (a section's or an item's `fields`, or a choice form's). `lines` above 1 is a box for several lines (at most 12); `max_length` caps what can be typed; `min_length` and `required` let the browser ask for enough before the form is sent; `label_action` is a quiet link on the label's line ("Forgot password?"); `reveal` puts an eye button inside a one-line box that shows and hides what was typed, its `show`/`hide` words read aloud (`PAGE_REVEAL_SCRIPT` is added to the page only when one is drawn); `hint` is a line of words under the box, read with it, and `strength: true` marks a new password whose hint the page's script rewrites as it is typed; `hidden: true` draws the field hidden for the page's script to show when its step comes; `autocomplete` and `inputmode` are plain words for the browser's own fill-in and the phone keyboard; `value` is what the box already holds (the account page after paying puts the checkout email there). The Android share page's "Note for your AI" is one. |
| `kind: 'code'` field | `{ name, label, kind: 'code', length? }` | A one-time code typed one digit per box, `length` boxes (4 to 8, 6 when left out): typing moves on, Backspace and the arrows move back and forth, a pasted or filled-in code fills every box (the first box takes the phone's own `one-time-code` fill-in), and a whole code fires `page-code-complete` on the boxes for the page's script; a `page-code-clear` event empties them. The joined digits are one hidden input under `name`. The label is read aloud, not shown. `PAGE_CODE_SCRIPT` is added to the page only when one is drawn. |
| section `step`, `hidden` | `string`, `boolean` | Which step of the page the section is (a plain word, `data-page-step`), for the page's script to show one step at a time; `hidden: true` draws it out of sight until its step comes. The sign-in pages ask for an email on step `ask` and take the code on its own step `code`. |
| section `sent_to` | `{ text, change?: { label, href } }` | "Sent to <address>. Change email": the address is written in by the page's script (`data-page-sent-to`) once it knows it. |
| action `cooldown_seconds`, `skip` | `number`, `string` | `cooldown_seconds` keeps an action (sending a code again) waiting that long after each press, the page's script counting down on the link (`data-page-cooldown`); `skip` names what a link declines (an offer after signing in), for the page's script to remember (`data-page-skip`). |
| section `divider` | `string` | Words between two hairlines ("or"), drawn after the section's `choices` form and before its other fields and actions. |
| section `prompt` | `{ text?, action: { label, href } }` | One line ending in a link, after the status line: "Don't have an account? Sign up". |
| section `status` | `string` | The live line a page's script writes into; `''` draws it empty, ready to be written. |
| action `tone` | `quiet` \| `link` \| any plain word | `quiet` is an outlined button whose surface gets darker under the pointer (`--page-card-hover`, with a darker border), never the page's own background, `link` plain words with no button around them; any other word is the stylesheet's to give meaning. |
| action `mark`, `mark_after` | `{ src, alt?, loading?, underline?: 'stitch' }`, `boolean` | Places an accessible image before or after the action words. `underline: 'stitch'` wraps the mark with the shared decorative loading-mark drawing so the page look can animate a needle beneath it; ordinary marks keep their original markup. |
| layout `auth` | `description.layout: 'auth'` | One centred 24rem column on the page's own background (no card): the logo `mark`, the title, the form, the "or" line, the other ways in and the prompt; a `card` section below is a further step after a hairline (typing a code), a `fine` section quiet links. Every Trillion sign-in, sign-up and code page wears it. |
| `PAGE_REVEAL_SCRIPT` | `string` | The inline script that makes every `reveal` eye button show and hide its box. |
| `PAGE_CODE_SCRIPT` | `string` | The inline script that runs every `code` field's boxes. |
| action / submit `pending`, `done` | `string`, `string` | What the action says in itself while its work runs and once it is done (`data-page-pending`, `data-page-done`, read by `page-work.mjs`); without them the page's script names the words for the work it starts. |
| `PAGE_PROSE_CSS` | `string` | The reading column for a section's `markdown`: a 44rem measure, headings in the page's display face with a hairline above each after the first, a held quote and code and tables in tinted frames of `--page-tint`, task boxes, links underlined in the page's thread colour; added to a page only when it draws prose. |
| `PAGE_WORK_CSS` | `string` | The looks of a pressed action's work, after every other action look so it wins wherever an action is drawn: waiting takes no presses, done is `--page-good` with a check, failed is `--page-bad` with a mark; a failed status line (`data-page-tone="error"`) reads in `--page-bad`. |
| `startWork` | `(action, { pending?, done? }) => { done(words?), failed(words?), idle() }` | From `page-work.mjs`. |
| `PAGE_WORK_ERROR_MS` | `2400` | How long "Try again" shows before the action's own label returns. |
| section `steps` | `[{ heading, body?, image?: { src, alt, width?, height? }, actions? }]` | Steps to follow in order: an ordered list, each step's number in a round badge on one rail down the left (the connection guide's numbered steps on the changelog's rail), with a framed picture where one helps and its own buttons. A step with no heading draws nothing; the numbers come from the order. The welcome after paying (`src/checkout-return.mjs`) is one. |
| layout `sheet` | `description.layout: 'sheet'` | One narrow column for a short task on a phone: a card with `tone: 'preview'` is a link preview (picture, site, title, words), a choices form's button stays in reach at the bottom, a lone section sits lower as a finished message. |
| `escapeHtml` | `(value) => string` | Escaping for text and quoted attributes (from `escape-html.mjs`, re-exported). |
| `SHELL_PAGE_HEADER` | `'x-page-shell'` | Header every shell-drawn page carries. |
| `markShellPage` | `(headers) => Headers` | The same headers, marked as a shell page. |
| `isShellPage` | `(response) => boolean` | Whether a response is already a designed page. |
| `isBrowserNavigation` | `(request) => boolean` | `Sec-Fetch-Mode: navigate`, else an Accept header preferring text/html to JSON; never a WebSocket upgrade. |
| `shouldBecomePage` | `(request, response) => boolean` | A browser navigation, status >= 400, not a shell page, not an attachment, and text/JSON/HTML/empty. |
| `routeWords` | `(response) => Promise<string \| null>` | The route's plain words (JSON `error_description`/`message`/`error`, or text), trimmed to 300 characters; never a stack trace or HTML. |
| `pageForBrowser` | `(request, response, pageFor) => Promise<Response>` | The answer that leaves: unchanged, or `pageFor({ status, words, request })` with the route's status, marked, keeping `retry-after`, `www-authenticate` and `allow`. |

## Dependencies

**Depends on:** the Fetch standard, `../share-row/share-row-html.mjs` (the share row a section may carry), and for `page-work.mjs` `../loading-mark/stitch.ts` plus `parts/screen-look/show/loading-mark.css`.

**Depended on by:** Trillion `src/html-page.mjs` (marks every page), `src/browser-pages.mjs` + `src/worker.mjs` (the app's egress, words in `src/page-words.json`), `parts/public-sales-page`; gettrillion.ai `worker/common.js`, `worker/landing.js`, `worker/index.js` (the site's egress).

## Invariants

- This folder names no route, page or product; page words are the caller's DATA.
- Wrapping twice is wrapping once: a marked page is never touched.
- Programs (no navigation) get the route's own Response object back.
- A page waits with the one loading animation (`../loading-mark`), never a spinner of its own; a pressed action never shrinks while it works. Checked by Trillion `test/button-work.test.mjs` over every tone of action.
- Checked by `test/every-browser-answer-is-a-page.test.mjs` in both repositories, which sends browser navigations to every address the source names.

Card covers with pictures use `../media-preview/picture-readiness.mjs`, the server-rendered adapter of the existing
MediaPreview loading, ready and failed states. Readiness requires both `complete` and `naturalWidth > 0`, so old
dimensions cannot make a pending source replacement ready.
SSR leaves the picture visible and does not set an active loading state. With JavaScript disabled, normal image
bytes still decode and paint; only the running adapter activates scripted loading opacity and the loading mark.
Loading keeps image geometry present with zero opacity, so the browser's lazy request can start. A final failure
hides the broken image. The existing needle loading mark stays visible while recovering, followed by
`Preview unavailable` if its exact same-origin URL cannot recover. At most two bounded HEAD checks classify the
current answer using the shared quiet-retry busy statuses. Permission, payment, missing-file and redirect answers
stop, including a manual redirect exposed as `opaqueredirect` with status zero; no alternate picture, original
bytes, blob URL, cache query or permission bypass is used. A successful HEAD
only permits another ordinary image read; the actual image load makes it ready. Healthy pictures add no requests
or timers. One page observer admits added cards, follows source and containing-frame changes, and cleans up
removed ones; navigation cancels recovery. A page with a growing list carries the adapter even when its initial
cards have only text, because scripts in later adopted cards do not execute.

Design discovery for this correction: real 21st.dev search `image loading error fallback` returned 7042 Lazy Image,
7007 Image Gallery and Avatar alternatives. 7042 was retrieved in full on 2026-10-10; it has no license field, so it
was used only as readiness/fallback anatomy inspiration and none of its code was copied. Its `complete` check
does not check loaded dimensions; the existing MediaPreview's stronger `naturalWidth` check is retained here.
Mobbin tools were unavailable in the session. The real local shadcn source reference was also read: MIT,
`https://github.com/shadcn-ui/ui` at `3ba91b1cc83e1bbe4ab35a422ff2a694849c5048`, Empty/Skeleton anatomy,
inspiration only. Existing loading-mark graphics and the current card layout are reused. No new UI library is added.

The `.page-view` rule in `page-sections-html.mjs` maps the chart and view roles (`--color-foreground`, `--color-muted-foreground`, `--color-card`, `--color-border`, `--color-ring`) onto the page's own `--page-*` roles, which are derived from the worn look's text, surface and border colours, so a view drawn in the page wears the look's ink instead of the light fallback.
