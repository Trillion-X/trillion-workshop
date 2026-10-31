# tools/reply-templates/

Fills a canned reply template with the details of a request and gives back the finished reply. A template is any JSON; the places to fill are bindings. Ported from bitfield-packages `reply-template`, a thin slot around the old projection compiler: its three source tests and four contract tests are carried as tests here with made-up values.

`tool:expand-a-reply-template` knows no kind of reply, so a button description, a line of text and a clip reference all expand by one rule. It sends nothing and keeps nothing; whoever asked delivers the reply.

## Template language

| Form | Meaning |
|------|---------|
| `{ "$kind": "binding", "select": { "from": "dataSource", "key": K, "path": P, "required"?: true }, "default"?: V }` | Replaced by the value at path `P` (a dotted string such as `rows.0.n`, or a list of steps) inside the data source named `K`. `K` may itself be a binding. No path means the whole source. |
| Anything else | Kept as it is, at any depth. |

Data sources: `provider_record`, `caller_request`, `data`, and each top-level entry of `data` by its own name. A binding that finds nothing gives its `default`, else `null`; `required: true` changes nothing, as in the old compiler, where a missing required value was recoverable too. An object key named `itemTemplate` is passed through unexpanded, at any depth, because its bindings read each item of a list and that loop is not part of this tool. A template that is present but `null` gives `null`; an absent one is refused. A binding that reads from any other source, or has a `transform`, is refused by name rather than skipped: the old compiler's other sources and operators belonged to screen building.

## Files

| File | Purpose |
|------|---------|
| `read-data/expand.mjs` | `expandReplyTemplate`: the rule above. Header lists the invariants. |
| `do-work/expand-a-reply-template.mjs` | The row's command. |
| `tool-rows.json` | The row, with a sample run. |
| `test/reply-templates.test.mjs` | The carried cases and the refusals. |

## Not carried

`browser-reply-templates` held one stored template, a styled button (class names and an element tree): a screen, left to the screens owner. The package's workflow actions (find-reply, use-reply), input descriptor, published-record aggregate and iOS JavaScriptCore mount belonged to the old engine and its screens.

## Dependencies

**Depends on:** Node 24 only.

**Depended on by:** `tool-rows.json`.
