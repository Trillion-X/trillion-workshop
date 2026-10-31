# Trillion Workshop

The open-source tools [Trillion](https://gettrillion.ai) offers to every person's AI. When an AI asks Trillion for a job ("work out my unit economics", "read this web page", "who is connected to whom"), Trillion finds the tool here by its job, runs it, checks what it gave back and hands the answer to the AI.

Each tool is one folder: its code, the rows that tell Trillion what it does and how to run it, a README and its tests. Fork the repository, add or improve a tool, and open a pull request. Once it is merged, Trillion offers it to everyone.

## Files

| File | Purpose |
|------|---------|
| `export-records-as-list-rows` | Turns records kept in files (JSON, tab-separated text, markdown tables) into the rows that fill a person's Trillion lists, by a mapping the person writes (runs on the person's computer; sends nothing) | `tool:export-records-as-list-rows` |
| `tools/<name>/` | One tool folder: its code (`do-work/`, often `read-data/`), `tool-rows.json` (the rows Trillion reads), `README.md`, `part.json` and `test/`. |
| `tools/tools-from-github/` | Other people's open-source repositories offered as tools that run on the person's own computer, read from GitHub by `index-github-tools.mjs`. |
| `licence-classes.json` | The licence classes a row may name, which licences each covers and where each lets a tool run. |
| `test/every-tool-row.test.mjs` | Checks every folder's rows the way Trillion reads them: files named exist, licence classes are listed, ids are unique. |
| `test-helpers/vitest-shim.mjs` | The part of vitest's API the `.test.ts` files use, on `node:test`. |
| `package.json` | `npm test` runs every test here. |
| `CONTRIBUTING.md` | How to add or change a tool. |
| `LICENSE` | Apache License 2.0. |

## The tools

| Folder | What it does | Tools |
|---|---|---|
| `ask-a-small-model-for-a-verdict` | Asks a small model a yes/no, which-of-a-list or how-much question about some text and trusts the answer only after it got the person's known cases right; picks which of their places holds an answer, scores the models on offer, measures a confidence line, turns a wrong verdict into a known case, recognises a repeat, answers typed questions about a state | `tool:ask-a-small-model-for-a-verdict`, `tool:route-to-the-owner-that-answers`, `tool:see-which-models-can-judge`, `tool:get-the-judges-ready`, `tool:find-where-the-line-should-go`, `tool:tell-it-when-it-was-wrong`, `tool:recognise-a-repeat`, `tool:answer-questions-about-a-state` |
| `ai-readiness` | Reads a public page the way a search or answer engine does (served HTML, no script run), scores it against editable check rows and says how to fix each miss; adds the language, address and dates a page leaves out; answers a page as Markdown when asked | `tool:check-a-page-for-search-and-answer-engines` |
| `ask-questions-sort-answers-follow-up` | Makes quiz questions from text, checks answers against a form, scores answers and picks a segment | `tool:make-quiz-questions`, `tool:check-form-answers`, `tool:score-answers-and-pick-segment` |
| `audio-transcription` | Transcribes a recording with a time for every word using the audio-transcription package's own local Whisper script, finds where Whisper got stuck repeating one sentence and hears again only those windows (runs on the person's computer) | `tool:transcribe-audio-and-repair-whisper-loops` |
| `brand-kit` | Picks the logo variant (wordmark or mark, SVG or PNG) a light or a dark page draws, from a brand kept as list rows (runs on the person's computer) | `tool:resolve-a-brand` |
| `browse-public-page` | Reads a public web page (its title, words, links and card) and reads one link into a card; the engine keeps both to public sites | `tool:read-public-web-page`, `tool:read-a-link` |
| `check-against-a-persons-rules-and-verdicts` | Checks words, a title, a script line or a plan against a person's own rules and the verdicts they already gave (their stands first, then their rows; nothing passes on silence), and turns their stands into labelled examples for a model; their rules and stands are input, nothing about a person is built in | `tool:check-against-a-persons-rules-and-verdicts`, `tool:make-examples-from-where-a-person-stands` |
| `connected-drives` | The drives connected to the person's Mac, what is in one folder on one, what is on one by kind, its icon, and which programs are using one (runs on the person's Mac with the drive access they granted) | `tool:list-connected-drives`, `tool:list-a-drive-folder`, `tool:see-what-is-on-a-drive`, `tool:get-a-drive-icon`, `tool:name-what-holds-a-drive` |
| `cite-principles-from-captions` | Keeps the principles people state or show in captioned videos, each with its exact quote and the second it is said, proves every quote against the captions, and ranks each principle by how many independent channels back it and how well their videos did (runs on the person's computer) | `tool:cite-principles-from-captions` |
| `check-a-folder-against-my-rules` | Checks a project folder's source files against rules the person wrote (the rule is data: path scope, a text condition, how to divide the text, what is forbidden, required or exempt), against a written baseline too, and rewrites a raw control byte hiding in source as its escape; both run on the person's computer with the folder they grant | `tool:check-a-folder-against-my-rules`, `tool:rewrite-control-bytes-as-escapes` |
| `check-a-port-against-its-source` | Checks a contract for work taken from a reference (a source or behaviour ported, a visual replica, an inspiration, an anti-reference): the source and its identity, what must be preserved, retained source lines, required mechanisms, measured pictures and the pixel difference | `tool:check-a-reference-adaptation-contract` |
| `check-bundle-package-boundaries` | Stops a build that takes a file from a package that did not declare it public: reads the bundler's list of what went into the finished bundle and reports each import that reaches into a package's private files | `tool:check-a-bundle-against-package-boundaries` |
| `check-declared-places-keep-what-is-written-there` | Reports which places declared writable keep nothing written there (no version history, no backup): which places, where they are declared, what counts as keeping and which are exempt are the person's data | `tool:check-declared-places-keep-what-is-written-there` |
| `check-documents-agree-with-their-source` | Reports which documents have fallen behind the source they claim to reflect (summaries, translations, copies): which source, what identifies a unit and which markers each must carry are the person's data | `tool:check-documents-agree-with-their-source` |
| `content-identity` | A library: the one BLAKE3 identity of exact bytes (`1f:` + 64 hex), whole or in chunks | (none: packed by `where-a-person-stands` and `media-composition`) |
| `copy-a-site` | Copies a live website (its pages as visitors see them, plus its pictures, styles and fonts) into the files a public app is published from | `tool:copy-a-site` |
| `customer-follow-up` | Each customer's steps and each product's progress toward its customer target | `tool:add-a-customer`, `tool:record-a-customer-step`, `tool:set-a-customer-target`, `tool:see-where-each-customer-is` |
| `document-sections` | Puts one named section into a markdown document without repeating it, and writes a section out of a list of entries with every entry's words kept exactly | `tool:place-a-section-in-a-markdown-document`, `tool:build-a-quoted-section-from-entries` |
| `email-sending-domains` | Which domains the person's email-sending account may send from and how each stands, with the key handed on a private pipe | `tool:list-email-sending-domains` |
| `file-spoken-moments-into-topic-buckets` | Cuts transcripts into moments, files each under topic buckets (the person's own vocabulary, grown by a local model) and rates how far it stands alone as a usable idea, story or lesson; nothing leaves the computer (runs on the person's computer) | `tool:file-spoken-moments-into-topic-buckets` |
| `funnels-and-offers` | Sales funnels and offers: walk a funnel (the price shown, where an outcome leads), read a funnel written as stages that point at workflow steps, offers and measures, count each stage's visits and conversions, draft a funnel | `tool:walk-a-funnel`, `tool:read-a-funnel-definition`, `tool:measure-funnel-stages`, `tool:draft-a-funnel` |
| `find-files-in-an-index` | Finds a person's files by words, name, place, kind or spoken words, in a file index already on their computer; a computer row that reads only the folder the index is in | `tool:find-files-in-an-index` |
| `guard-ai-spending` | Keeps an AI's own spending inside the budget its person set: reserve a spend before paying, check it just before, record it once after, reset the day's total, and the rails (card, bank, x402) that may pay | `tool:reserve-a-spend-within-budget`, `tool:may-this-spend-go-ahead`, `tool:record-a-spend`, `tool:reset-daily-spend`, `tool:read-spend-rails` |
| `headless-browser` | A library the browser tools pack: a headless Chromium spoken to over DevTools with the quiet switches, and a page clock that moves only when told | (none: packed by `page-critic`, `record-a-web-page` and `copy-a-site`) |
| `fill-a-template-without-changing-its-words` | Keeps a piece's own words fixed as a template where only the specifics are slots, fills the slots from sourced values, checks any rewrite for changed words and moves events tied to words when the words move (runs on the person's computer) | `tool:make-a-word-template`, `tool:fill-a-word-template`, `tool:check-words-against-a-word-template`, `tool:re-time-events-tied-to-words` |
| `internet-archive` | Searches the Internet Archive and reads one item's metadata and file list, keeping its rights fields | `tool:search-internet-archive`, `tool:read-internet-archive-item` |
| `judge-words` | Checks words, a plan or anything else made against a person's rule rows (by kind, by value path, with tests that say what must hold), saying what breaks which rule and why | `tool:judge-against-rules` |
| `keep-the-last-good-answer` | Asks a web address and keeps its answer in the person's records; when the address cannot answer, gives back the last answer it gave and when it was kept; the primitive (ask a live source, keep, fall back) is public | `tool:ask-a-web-address-or-give-the-last-answer` |
| `legal-document-builder` | Terms of service, privacy policy, refund policy and waiver from a business's own facts | `tool:write-legal-documents` |
| `meaning-search` | Finds the moments, pictures or lines in a person's own vector set closest in meaning to a query vector or to words, with the file and time each points to (the meaning-search package's own ranking, run on the person's index descriptor and files) | `tool:find-similar-to-a-vector`, `tool:find-similar-by-meaning` |
| `media-composition` | Edits video: finds the action, scene changes, silence and beats, reframes, changes speed over a range, captions, grades colour, lays sounds and pictures over it, renders an edit, measures loudness, picks a cover frame, exports an editor timeline, finds and names recurring voices, blurs faces that did not agree, and points editor projects at clips' new places | `tool:find-action-moments`, `tool:find-scene-changes`, `tool:find-silence`, `tool:find-beats`, `tool:reframe-video`, `tool:change-speed-over-a-range`, `tool:add-captions`, `tool:cut-and-caption`, `tool:arrange-videos`, `tool:render-an-edit`, `tool:measure-loudness`, `tool:pick-cover-frame`, `tool:export-editor-timeline`, `tool:extract-sound`, `tool:find-recurring-voices`, `tool:blur-faces-not-agreed`, `tool:name-a-voice`, `tool:mix-sound-layers`, `tool:layer-pictures-over-video`, `tool:point-editor-projects-at-new-places`, `tool:grade-a-video`, `tool:match-colour` |
| `formulas` | Keeps the rows of a list that match a person's rules (comparisons joined by all-of and any-of groups, three-state, never guessed) and evaluates a formula over rows, and gives a record the label of the first of a person's rules that holds; the comparisons are rows of data | `tool:filter-rows-by-rules`, `tool:evaluate-a-formula`, `tool:list-comparisons`, `tool:classify-a-record` |
| `move-records-through-declared-states` | Which stage a deal, order or applicant is in and where it may move next | `tool:check-a-stage-move`, `tool:check-a-pipeline` |
| `office-files` | Reads a spreadsheet, document or presentation as data, changes cells or words by rules while keeping everything else, and edits a presentation's text and slide order then reads it back as proof (all run on the person's own computer) | `tool:read-an-office-file`, `tool:change-cells-or-words-in-an-office-file`, `tool:edit-a-presentations-text`, `tool:describe-a-presentation-runtime` |
| `page-critic` | Judges a public page against craft rules at every width and keeps a marked picture of each width | `tool:critique-a-public-page` |
| `person-list` | Find people by any field; rank people by the points their activity earns | `tool:find-people`, `tool:rank-people-by-activity` |
| `person-profile` | Lays out one person's profile from a description of what to show | `tool:lay-out-a-profile` |
| `print-here` | Prints a file from the person's files on a printer their Mac already has, and lists its printers (runs on the person's Mac with the print system they granted) | `tool:printers`, `tool:print` |
| `record-a-web-page` | Records a web page as a demo: plays steps in a headless browser and returns a video, a GIF and one marked picture per step | `tool:record-a-web-demo` |
| `recently-deleted` | How long Recently Deleted and Archived keep files, with the person's own choice | `tool:read-deleted-files-keep-for` |
| `records-door` | A library: the client for the person's records door and the one command that runs a tool written as a function, handing it the door | (none: packed by `saved-examples`, `tell-the-person`, `social-posts`, `recently-deleted` and `print-here`) |
| `relationship-graph` | Who is connected to whom, from any records | `tool:map-who-is-connected` |
| `revenue-ledger` | Revenue, refunds, net revenue and recurring revenue from any provider's payment events | `tool:add-up-revenue` |
| `running-programs` | The programs running on the person's Mac and how much memory each one uses, the largest first (runs on the person's Mac with the process list they granted) | `tool:list-running-programs` |
| `saved-examples` | Lists the examples a person saved of posts, videos and pages that worked, and removes one, from their own records | `tool:list-saved-examples`, `tool:remove-a-saved-example` |
| `screen-looks` | Turns a look's colour, size and font tokens into concrete values and the stylesheet a document carries, with the person's own font faces (runs on the person's computer) | `tool:resolve-a-look` |
| `social-posts` | The person's posts on a calendar between two times, and the ones with no time yet | `tool:read-post-calendar` |
| `take-payments` | Sells with the person's own Stripe account: prices a sale from their offers, starts a hosted checkout, recovers and looks up checkouts, schedules later payments, counts pay-in-N installments, cancels subscriptions, keeps lasting payment links, checks a Stripe event before believing it, checks what a buyer paid, decides which offers a buyer may see, pays people through Stripe Connect | `tool:price-a-sale`, `tool:start-a-stripe-checkout`, `tool:start-a-stripe-checkout-that-pays-someone-else`, `tool:look-up-a-stripe-checkout`, `tool:find-a-completed-stripe-checkout`, `tool:schedule-the-later-payments-in-stripe`, `tool:count-a-paid-installment-in-stripe`, `tool:cancel-a-stripe-subscription`, `tool:tag-a-stripe-subscription`, `tool:set-up-stripe-payment-links`, `tool:check-a-stripe-event`, `tool:check-what-a-buyer-paid`, `tool:show-which-offers-a-buyer-may-see`, `tool:set-up-someone-i-pay-in-stripe`, `tool:pay-someone-a-share-through-stripe`, `tool:rehearse-a-payment-schedule-in-stripe-test-mode` |
| `tell-the-person` | What Trillion told the person: the newest notices, where each was seen and how far each way got | `tool:my-notices` |
| `traffic-attribution` | Tracked links, visitors and sales by where they came from, what ad spend brings back, and conversions prepared for the ad platforms | `tool:make-tracked-link`, `tool:break-down-visits-and-sales`, `tool:measure-ad-return`, `tool:prepare-ad-conversions` |
| `turn-frames-into-slides` | Turns a board's presentation frames into slides in story order, one page each, as SVG, printable HTML, a PDF and a picture of every page (runs on the person's computer) | `tool:turn-frames-into-slides` |
| `unit-economics` | ARPU, gross margin, CAC, LTV, LTV:CAC and payback from one period's numbers | `tool:work-out-unit-economics` |
| `what-runs-on-its-own` | Every schedule, record change and incoming event the account runs on its own: what each waits for, its state, its last and next run, red for the ones that should have run and did not, and a switch for each | `tool:see-what-runs-on-its-own` |
| `where-a-person-stands` | Keeps whether a person agrees, disagrees or partly agrees with something made for them, in their own words, and reads it back with every earlier stand; owns the one identity of a judged thing (folded text or bytes, BLAKE3) | `tool:keep-where-you-stand`, `tool:read-where-you-stand`, `tool:plan-a-stance-reload` |
| `wikimedia-commons` | Searches Wikimedia Commons files, reads one file's license metadata, and checks whether its license allows reuse and what credit it needs | `tool:search-wikimedia-commons-files`, `tool:read-wikimedia-commons-file-metadata`, `tool:assess-wikimedia-commons-file-reuse` |
| `words-as-picture-vector` | Words as the vector a picture model gives pictures that show them | `tool:words-as-picture-vector` |
| `work-breakdown` | A body of work as a tree: how much is really finished, new items, proof of finished work | `tool:roll-up-work-completion`, `tool:add-work-item`, `tool:check-proof-of-finished-work` |
| `tools-from-github` | 20 open-source repositories (captions, transcription, background removal, 3D and video rendering and more) that run on the person's own computer | `tool:github:*` |

## Key Types / Functions

| Type | Shape | Role |
|---|---|---|
| `tool-rows.json` | `{ "records": [{ "payload": <row> }] }` | The rows Trillion reads from a tool folder. |
| Tool row | `{ "kind": "ai-tool-descriptor", "id": "tool:<name>", "label", "job", "description", "input_schema", "output_schema", "invoke", "result_selector", "licence_class", "placements", "verify" }` | One tool: the job it is found by, what it takes and gives back, how it runs, where it may run, and a sample run that proves it works. |
| `invoke` (container) | `{ "kind": "container", "files": { "package_files": { "package": "<folder>", "paths": ["do-work"], "at": "/opt/<folder>" } }, "workdir", "argv": ["node", "do-work/<file>.mjs"], "stdin": { "fill": { "from": "input" } }, "stdout": "json" }` | Trillion packs the named files from this folder, runs `argv` in a sealed container with the input on standard input, and reads the last JSON line printed. |
| Row source | `{ "kind": "tool-row-source", "id": "source:<name>", "list": { "records": { "package": "<folder>", "kind": "ai-tool-descriptor" } } }` | Lists the rows kept in a folder's `records.json` instead of `tool-rows.json`. |
| `verify` | `[{ "kind": "sample-run", "input": {...}, "output_selector": "$.x", "contains": "..." }]` | Trillion runs the sample before offering the tool and refuses it when the output does not contain the expected text. |

## Folder layout

```
trillion-workshop/
├── tools/
│   ├── unit-economics/
│   │   ├── do-work/work-out-unit-economics.mjs   the command the container runs
│   │   ├── read-data/                             pure functions it uses
│   │   ├── records.json                           its row (listed by tool-rows.json)
│   │   ├── tool-rows.json                         what Trillion reads
│   │   ├── part.json                              which files other code may import
│   │   └── README.md
│   ├── …one folder per tool
│   └── tools-from-github/                         repositories that run on the person's computer
├── licence-classes.json
└── test/every-tool-row.test.mjs
```

## Add a tool

1. Make `tools/<your-tool>/` with a command in `do-work/` that reads one JSON request on standard input and prints one JSON answer as its last line (`{"result": ...}`). It may not reach the internet unless its row says `"internet": true`.
2. Add `tools/<your-tool>/tool-rows.json` with one row per tool. Copy a row from `tools/move-records-through-declared-states/tool-rows.json` and change the `id`, `job` (plain words a person would use), `description`, schemas, `invoke` paths and the `verify` sample.
3. Add tests in `tools/<your-tool>/test/` and a `README.md`.
4. Run `npm test`. It checks your rows the way Trillion reads them.
5. Open a pull request.

See `CONTRIBUTING.md` for the rules a tool must follow.

## Dependencies

**Depends on:** Node 22.6 or later (type stripping for `.ts`), Python 3 for the Python tools, `@noble/hashes` (BLAKE3 identities; `npm install`).

**Depended on by:** Trillion, which installs this repository and reads every `tools/*/tool-rows.json` when it deploys.

## Licence

Apache License 2.0. See `LICENSE`.
