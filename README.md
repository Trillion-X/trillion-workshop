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
| `customer-follow-up` | Each customer's steps and each product's progress toward its customer target | `tool:add-a-customer`, `tool:record-a-customer-step`, `tool:set-a-customer-target`, `tool:see-where-each-customer-is` |
| `email-sending-domains` | Which domains the person's email-sending account may send from and how each stands, with the key handed on a private pipe | `tool:list-email-sending-domains` |
| `internet-archive` | Searches the Internet Archive and reads one item's metadata and file list, keeping its rights fields | `tool:search-internet-archive`, `tool:read-internet-archive-item` |
| `legal-document-builder` | Terms of service, privacy policy, refund policy and waiver from a business's own facts | `tool:write-legal-documents` |
| `move-records-through-declared-states` | Which stage a deal, order or applicant is in and where it may move next | `tool:check-a-stage-move`, `tool:check-a-pipeline` |
| `person-list` | Find people by any field; rank people by the points their activity earns | `tool:find-people`, `tool:rank-people-by-activity` |
| `person-profile` | Lays out one person's profile from a description of what to show | `tool:lay-out-a-profile` |
| `relationship-graph` | Who is connected to whom, from any records | `tool:map-who-is-connected` |
| `revenue-ledger` | Revenue, refunds, net revenue and recurring revenue from any provider's payment events | `tool:add-up-revenue` |
| `traffic-attribution` | Tracked links, visitors and sales by where they came from, what ad spend brings back, and conversions prepared for the ad platforms | `tool:make-tracked-link`, `tool:break-down-visits-and-sales`, `tool:measure-ad-return`, `tool:prepare-ad-conversions` |
| `unit-economics` | ARPU, gross margin, CAC, LTV, LTV:CAC and payback from one period's numbers | `tool:work-out-unit-economics` |
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

**Depends on:** Node 22.6 or later (type stripping for `.ts`), Python 3 for the Python tools.

**Depended on by:** Trillion, which installs this repository and reads every `tools/*/tool-rows.json` when it deploys.

## Licence

Apache License 2.0. See `LICENSE`.
