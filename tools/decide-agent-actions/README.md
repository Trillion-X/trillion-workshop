# tools/decide-agent-actions/

One gate for every action an AI agent is about to take (send, post, delete, run a command, pay): it answers allow, ask the person first, or refuse, from the person's action policy rows, the grants they gave and the actions they declined. Refusals are checked before allowances, a rule the gate cannot evaluate refuses (never allows), a declined action stays declined until the person has spoken again, and a dry run decides and reports without blocking. The tool names no action, field, rule or word of a person: the action, the fields the rules may read, the policy, the grants, the declines and the clock all arrive in the request.

The decision order, the first that applies decides:

1. A paused policy refuses.
2. Refusing rules, in order. A refusing rule whose `when` the gate cannot evaluate (an unknown field or comparison, a comparison the field's kind does not offer, missing values) refuses too, and is named in `unevaluated`.
3. An action declined earlier (same identity) with a decline later than the person's last message (or no last message given) is refused, with guidance to ask again only after the person has spoken.
4. A grant for the same identity that has not expired and whose scope matches: `once` while unused (the answer names it in `grant_used` for the caller to mark used), `thread` in the thread it was made for, `always`.
5. The other rules in order (`allow`, `ask`, `allow-when-asked-for`). A rule that cannot be evaluated is skipped and listed, it never allows. `allow-when-asked-for` allows only an action whose identity is in `asked_for`, otherwise it asks.
6. No rule holds: the policy's `otherwise` if it is a known verdict, else the vocabulary default (ask).
7. A final ask when `can_ask` is false becomes a refusal with guidance to continue without it.

With `dry_run: true` the same decision is computed and answered with `enforced: false`, so the caller lets the action run and keeps what would have been decided. The tool has no clock: `now` is required.

An action's identity is the BLAKE3 identity (`1f:` and 64 hex digits, from `tools/content-identity`) of the canonical JSON of the action's identity fields (`tool`, `target`, `arguments` unless the request names others). A rule's `when` is a rule tree over the fields, evaluated by `tools/formulas` over the one action.

The verdicts, the behaviours a rule may name in `then`, the default verdict, the grant scopes, the guidance words and the sentences of the policy check are rows of data in `read-data/action-policy-vocabulary.json`; adding a behaviour or scope is one row there.

## Files

| File | Purpose |
|------|---------|
| `read-data/action-policy-vocabulary.json` | Verdicts, behaviours, default verdict, outcomes, grant scopes, retry guidance, default identity fields and policy-check sentences as data |
| `do-work/decide-action.mjs` | The decision core (`decideAction`), the action identity and the policy check (`checkPolicy`); pure |
| `do-work/requests.mjs` | One function per row; the core refuses a bad request with a sentence that says what to send |
| `do-work/run-request.mjs` | `node do-work/run-request.mjs <function>`: the request on standard input, `{ result }` or `{ error }` out |
| `part.json` | The one public module |
| `tool-rows.json` | The two Workshop rows |
| `test/*.test.mjs` | The decision order, grants, declines, the dry run and the policy check; each row's sample run in the container shape and the refusals |

## The rows

| Row | Does |
|-----|------|
| `tool:decide-an-agent-action` | An action, the policy, grants, declines and the time in; allow, ask or refuse, what decided, its words, retry guidance, the action's identity, the grant to mark used and the rules it could not evaluate out |
| `tool:check-an-action-policy` | The fields and the policy in; whether it is ok and each problem (a behaviour not in the vocabulary, a `when` it cannot fully evaluate, a repeated id, a rule that can never decide) out |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| policy | `{ rules: [{ id, says, when?, then }], otherwise?, paused? }` | The person's rows; no `when` means the rule always holds; `then` is a behaviour of the vocabulary |
| grant | `{ id, identity, scope, thread?, used?, expires_at? }` | A permission the person gave for one action identity |
| `decideAction(request)` | `-> { verdict, enforced, decided_by: { kind, id? }, says, retry, identity, grant_used, unevaluated, checked_rules }` | The decision; `kind` is rule, grant, declined, paused or default |
| `checkPolicy(request)` | `{ fields, policy, operators? } -> { ok, problems: [{ rule, problem, says }] }` | Problems found before the policy is relied on |
| `actionIdentity(action, identityFields)` | `-> "1f:<hex>"` | The identity grants, declines and `asked_for` are keyed on |

## Dependencies

`tools/formulas` (`filterRecords`, to evaluate a rule's `when`) and `tools/content-identity` (the BLAKE3 identity, with the `@noble/hashes` module), both packed into the row's container. No records access, no credential and no network (`internet: false` on every row).
