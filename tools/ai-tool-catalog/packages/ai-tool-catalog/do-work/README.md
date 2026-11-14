# ai-tool-catalog / do-work

Everything the tool catalog does to a tool CALL: admit the invocation, resolve which published tool a model named, and bound what that tool returned.

## Files

| File | Purpose |
|------|---------|
| `request-tool-run.ts` | Validates a model-visible input against the owner's JSON Schema, applies the owner's field mapping and fixed/trusted input, and dispatches the run to the owner's target. |
| `request-tool-run.test.ts` | Owner-binding, schema-violation, field-shadowing and aliasing proofs for `requestToolRun`. |
| `parse-agent-tool-requests.ts` | Decodes fenced tool-request blocks from model text into `{actionId, input}` and resolves a model-emitted id to the published action(s), tolerating a dropped `action:` prefix or a bare suffix. |
| `parse-agent-tool-requests.test.ts` | Fence decoding, custom fence tag, malformed-block tolerance, and the exact/prefixed/suffix resolution ladder. |
| `prepare-tool-result.ts` | Turns whatever a tool returned into the one bounded, policy-governed summary a caller may show, read through the owner's declared `result_selector`. |
| `derive-tool-rows-from-sources.mjs` | Reads each `tool-row-source` row's list (a live capability list at a web address, or a package's own records) and derives one decoder-checked `ai-tool-descriptor` per entry; nothing is written. |
| `prepare-tool-result.test.ts` | Declared-path selection, absent-selector evidence, addressed-result fallback, UTF-8 byte bounds, and the missing-policy refusal. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `TrustedToolBinding` | `{ target, toolRef, modelInputSchema, inputFieldMap?, fixedInput?, trustedContext? }` | Owner-hydrated binding; none of it is model-visible invocation input. |
| `requestToolRun` | `(modelInput: unknown, ownerBinding: TrustedToolBinding, signal?: AbortSignal)` | Validate, map, and dispatch one tool run to its owner target. |
| `DEFAULT_TOOL_REQUEST_FENCE_TAG` | `'bitfield-work-request'` | The default fenced-block language tag; the tag is a parameter, never a buried literal. |
| `AgentToolRequest` | `{ actionId: string; input: unknown; correlationId?: string \| null }` | One decoded tool request. |
| `ResolvableAction` | `{ actionId: string }` | The minimal shape the resolver matches; any published action satisfies it. |
| `parseAgentToolRequests` | `(text: string, fenceTag?: string) => AgentToolRequest[]` | Decode every fenced request in a model reply; malformed blocks are skipped, never thrown. |
| `resolveActionMatches` | `<A extends ResolvableAction>(actionId: string, actionsById: ReadonlyMap<string, A[]>) => A[]` | Exact, then `action:`-prefixed, then suffix match. An ambiguous suffix returns ALL matches so the caller reports the conflict. |
| `indexActionsById` | `<A extends ResolvableAction>(actions: readonly A[]) => Map<string, A[]>` | Build the resolver index, grouping duplicate ids. |
| `selectDeclaredToolOutput` | `= selectDeclaredValue` | Read a value at an owner-declared selector path. |
| `ToolResultPolicy` | `{ maxBytes: number; maxAddressBytes: number }` | Society DATA byte bounds for a rendered tool summary. |
| `fillFromEntry` | `(template, entry) => value` | Fill a row template's `{ fill: { from: 'entry', field } }` values from one list entry; run-time fills are left in place. |
| `rowsFromList` | `(source, list) => { rows, refused }` | One decoder-checked tool row per list entry; the row's `provenance` is its filled template plus the source id. |
| `recordsList` | `({ package, kind, each_of?, not_carried_into_each? }, folder?) => entry[]` | The payloads of one kind in one package's `things-to-store-and-run.json`, one entry each, or with `each_of` one entry per key of that object field (the key's fields laid over the payload's, less the fields `not_carried_into_each` names); each entry gains `record_address` and `record_name` (`<last address part>` or `<last address part>-<key>`). A package name that is not one path segment throws. |
| `readList` | `(source, request?) => Promise<unknown[]>` | Read a source's list: `list.records` through `recordsList`, otherwise the live `list.url`, refusing anything that is not a list. |
| `toolRowsFromSources` | `(payloads, request?) => Promise<{ rows, unread, refused }>` | Every row the source payloads yield now; an unreadable source is reported, never guessed. |
| `payloadsIn` | `(path) => payload[]` | The record payloads in a records file or folder. |
| `PreparedToolResult` | `{ summary: string; source: 'reply' \| 'address' \| 'status' }` | The bounded summary plus which source produced it. |
| `prepareToolResult` | `(input: { workflowReply?, addressedResult?, addressedResultRef?, resultSelector?, policy?, accepted, error? }) => PreparedToolResult` | Direct reply, then addressed result, then structured owner-contract evidence. Never scans undeclared fields. |
| `summarizeToolResult` | `(input: Parameters<typeof prepareToolResult>[0]) => string` | `prepareToolResult(...).summary`. |

## Why This Design

The package that admits a tool INVOCATION against its owner schema is the only package that can say which published tool a model-emitted id names, and what counts as that tool's declared OUTPUT. Splitting resolution or result-bounding into a caller lets an agent address a tool the catalog never admitted, or surface a field the owner never declared.

## Invariants

- A tool value is read only through the owner's declared `result_selector`. There is no field scan and no "best guess" fallback.
- A missing policy or a missing selector returns structured contract evidence, never an empty string and never the raw output.
- An over-long summary truncates on a UTF-8-safe boundary and points at the addressed full result; it is never silently dropped, and an addressed reference is never invented.
- An ambiguous action suffix resolves to every match so the caller reports the conflict instead of silently picking one.
- `parse-agent-tool-requests.ts` and `prepare-tool-result.ts` are pure leaves with zero I/O.

## Dependencies

**Depends on:** `@bitfield/runtime-kit` (`sendRequestToBitfieldTarget`), `ajv` (owner schema compilation), `packages/ui/read-data/declared-selector` (`selectDeclaredValue`).

**Depended on by:** `packages/chat/do-work/advance-chat-tool-round.ts`, `packages/chat/read-data/read-chat-result-policy.ts`, `packages/visual-database/do-work/performance-owner-probes.test.ts`, `packages/hosted-public-app/__tests__/t14-remaining-accessibility.browser.spec.ts`, and `packages/ai-work-control/do-work/bind-agent-turn-ports.ts` (`ResolvableAction`).
