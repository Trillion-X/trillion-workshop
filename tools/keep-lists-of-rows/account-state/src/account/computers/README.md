# The computers of one account

`../computers.rs` holds an account's signed computers row (which computers keep a copy, may answer and vote) and each
computer's report. The files here:

| File | What it does |
| --- | --- |
| `settings.json` | The numbers of copies, the writer turn and the forwarder |
| `copies.rs` | One computer's copies of an account: the writer turn (claim, renew, give up, hand over), pushes, pulls, catching up and admitting from its own copy. `Copies::hand_over_held` hands a held writer turn over at once; a computer about to stop for an engine release (`src/native_entry/computer/releases.rs`) calls it |
| `messages.rs` | The messages computers send each other through the forwarder |
| `writer_row.rs` | The writer row and its votes |
| `rows_copy.rs` | The account's own rows (computers rows and lists) at every computer that may answer |
| `sealed.rs`, `sealed.json` | Record values sealed at a computer that only holds a copy |
| `copy_rule.rs` | How many copies: the account's copies row (`settings:copies:<user id>`: `least_copy_keepers`, `least_voters`, `least_may_answer`, `least_always_on`), its formula field `short_by`, the trigger rule that reads it and the workflow `add-a-computer` it starts, the offered-computers list, the runs, the computers row shown as the list `computers`, and the refusal `computers_below_copy_rule` |
| `copies_tests.rs`, `membership_tests.rs`, `move_tests.rs`, `copy_rule_tests.rs` | In-process proofs of the above (`membership_tests.rs` also: removing a computer fires the copy rule and its workflow adds another) |

## The copy rule

the person, 2026-11-03: no single folder or computer may ever hold the only copy, configurable per account as rows edited
like the rest of his lists and wired to the formula, trigger and workflow engines.

- The rows are made with the account from the making computer's config `new_accounts` (`copies`, `copies_rules`;
  `src/account/rows/new-accounts.json` is the synthetic one, defaults 3, 3, 2, 0: no always-on rule by default, principle 4) and travel with the copies (`lists` is
  one of the account's own row families, `rows_copy.rs`).
- Command line (`src/native_entry/computer/join.rs`, `hosted.rs`): `trillion-local computer set-host-kind STATE_FOLDER JSON` with `{"computer": ID, "kind": KIND, "expected_revision": N}` (the same owner function as the door's `sign-in:set-host-kind`). `trillion-local computer owner-operation STATE_FOLDER JSON` takes a `computers::Operation` (`deny_unknown_fields`, tagged `op`, kebab-case): `{"op": "add-computer", "computer": ID, "may_answer": true|false, "voter": true|false}`, with an optional `"pursuit"`. Those are the `AddComputer` fields of the enum in `computers.rs`. It calls `computers::apply` with no caller, so a computer that is itself the caller gets no own-device kind; its kind row must already exist.
- Door operations (scope `sign-in`, `src/account/account_routes.rs`): `sign-in:copies` (rows, live counts, `short_by`, runs),
  `sign-in:set-copies`, `sign-in:set-copies-rules`, `sign-in:set-offered-computers`, `sign-in:set-host-kind` (`{computer, kind,
  expected_revision}`, a host kind list row, `copy_rule.rs` `set_host_kind`) (each `{expected_revision, ...}`,
  stale: `copies_revision_changed`), `sign-in:computers-list`, `sign-in:set-computers-list-row` (`{row: {computer,
  keeps_copy, may_answer, votes, writer}}`, the computers operation that row is). `sign-in:set-places` and
  `sign-in:set-computers-list-row` take `copies` to lower the rule in the same edit.
- After every such write, and at each sweep (`copy_rule.sweep_every_ms`, the port of old trillion
  `src/keep-running.mjs`'s hourly sweep; only the writer sweeps), `short_by` is worked out, the rule fires when it is
  above 0, and its workflow adds the first offered computer with room, then makes it a voter once it reports caught up.
  `short_by` is the rules row's own formula (the largest of `short_by_each` and 0, one `op:core.max` over a list of
  selections). The offered list fills from the computers' own reports (each computer posts its report to the forwarder
  every `copy_rule.report_every_ms` and hears the others'); the computer that writes tells a newly named computer at once
  so it joins by itself; the writer runs the rule as soon as a computer reports it caught up.

## Joining by itself

`messages.rs` `Message::Holding` asks a computer that serves the account for what a computer the row names needs to join
it by itself (`src/native_entry/computer/join_itself.rs`): ids, the key and computers rows and, to one that may answer,
the account stores' rows. No record value, secret or root travels in it. Status and gaps:
`docs/placement-decision/stage-2-status.md`.
