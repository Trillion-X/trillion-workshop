# Trillion Workshop

The open-source tools [Trillion](https://gettrillion.ai) offers to every person's AI. When an AI asks Trillion for a job ("work out my unit economics", "read this web page", "who is connected to whom"), Trillion finds the tool here by its job, runs it, checks what it gave back and hands the answer to the AI.

Each tool is one folder: its code, the rows that tell Trillion what it does and how to run it, a README and its tests. Fork the repository, add or improve a tool, and open a pull request. Once it is merged, Trillion offers it to everyone.

## Files

| File | Purpose |
|------|---------|
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
| `ask-questions-sort-answers-follow-up` | Makes quiz questions from text, checks answers against a form, scores answers and picks a segment | `tool:make-quiz-questions`, `tool:check-form-answers`, `tool:score-answers-and-pick-segment` |
| `browse-public-page` | Reads a public web page: its title, words, links and card, refusing private addresses | `tool:read-public-web-page` |
| `content-identity` | A library: the one BLAKE3 identity of exact bytes (`1f:` + 64 hex), whole or in chunks | (none: packed by `where-a-person-stands` and `media-composition`) |
| `customer-follow-up` | Each customer's steps and each product's progress toward its customer target | `tool:add-a-customer`, `tool:record-a-customer-step`, `tool:set-a-customer-target`, `tool:see-where-each-customer-is` |
| `email-sending-domains` | Which domains the person's email-sending account may send from and how each stands, with the key handed on a private pipe | `tool:list-email-sending-domains` |
| `headless-browser` | A library the browser tools pack: a headless Chromium spoken to over DevTools with the quiet switches, and a page clock that moves only when told | (none: packed by `page-critic` and `record-a-web-page`) |
| `internet-archive` | Searches the Internet Archive and reads one item's metadata and file list, keeping its rights fields | `tool:search-internet-archive`, `tool:read-internet-archive-item` |
| `judge-words` | Checks words, a plan or anything else made against a person's rule rows (by kind, by value path, with tests that say what must hold), saying what breaks which rule and why | `tool:judge-against-rules` |
| `legal-document-builder` | Terms of service, privacy policy, refund policy and waiver from a business's own facts | `tool:write-legal-documents` |
| `media-composition` | Edits video: finds the action, scene changes, silence and beats, reframes, changes speed over a range, captions, grades colour, lays sounds and pictures over it, renders an edit, measures loudness, picks a cover frame, exports an editor timeline, finds and names recurring voices, blurs faces that did not agree, and points editor projects at clips' new places | `tool:find-action-moments`, `tool:find-scene-changes`, `tool:find-silence`, `tool:find-beats`, `tool:reframe-video`, `tool:change-speed-over-a-range`, `tool:add-captions`, `tool:cut-and-caption`, `tool:arrange-videos`, `tool:render-an-edit`, `tool:measure-loudness`, `tool:pick-cover-frame`, `tool:export-editor-timeline`, `tool:extract-sound`, `tool:find-recurring-voices`, `tool:blur-faces-not-agreed`, `tool:name-a-voice`, `tool:mix-sound-layers`, `tool:layer-pictures-over-video`, `tool:point-editor-projects-at-new-places`, `tool:grade-a-video`, `tool:match-colour` |
| `move-records-through-declared-states` | Which stage a deal, order or applicant is in and where it may move next | `tool:check-a-stage-move`, `tool:check-a-pipeline` |
| `page-critic` | Judges a public page against craft rules at every width and keeps a marked picture of each width | `tool:critique-a-public-page` |
| `person-list` | Find people by any field; rank people by the points their activity earns | `tool:find-people`, `tool:rank-people-by-activity` |
| `person-profile` | Lays out one person's profile from a description of what to show | `tool:lay-out-a-profile` |
| `record-a-web-page` | Records a web page as a demo: plays steps in a headless browser and returns a video, a GIF and one marked picture per step | `tool:record-a-web-demo` |
| `records-door` | A library: the client for the person's records door and the one command that runs a tool written as a function, handing it the door | (none: packed by `saved-examples`, `tell-the-person`, `social-posts` and `recently-deleted`) |
| `relationship-graph` | Who is connected to whom, from any records | `tool:map-who-is-connected` |
| `revenue-ledger` | Revenue, refunds, net revenue and recurring revenue from any provider's payment events | `tool:add-up-revenue` |
| `saved-examples` | Lists the examples a person saved of posts, videos and pages that worked, and removes one, from their own records | `tool:list-saved-examples`, `tool:remove-a-saved-example` |
| `traffic-attribution` | Tracked links, visitors and sales by where they came from, what ad spend brings back, and conversions prepared for the ad platforms | `tool:make-tracked-link`, `tool:break-down-visits-and-sales`, `tool:measure-ad-return`, `tool:prepare-ad-conversions` |
| `unit-economics` | ARPU, gross margin, CAC, LTV, LTV:CAC and payback from one period's numbers | `tool:work-out-unit-economics` |
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
