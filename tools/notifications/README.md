# tools/notifications/

A person's notification choices and the notices recorded for them, kept in their own records and reached through the
run's records door (`tools/records-door`). Nothing here delivers a notice, and nothing names a choice or an audience:
the options of a setting, and who an event is for, are what the person's records say. Sending a notice is the job of
a tool that sends messages; what was sent and where the person saw it is read by `tools/tell-the-person`.

Ported from bitfield-packages `packages/notifications`: its policy reader and the write of a chosen option, and its
record-a-notification-event action. Its mode list (the options of one setting), its screen model and its iOS surface are
not carried: the options are now the person's own `notification-setting` record, and the surfaces belong to the screens.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:my-notification-choice` | The options a setting offers, which one is chosen, and whether the choice is still one of the options (`ready`, `empty`, `missing`, `invalid`); a setting the person has not described is answered in words, not refused | reads `notification-setting`, `notification-choice` |
| `tool:choose-my-notification-choice` | Keeps one described option as the person's choice; an option the setting does not describe is refused with the options named; a setting that is not described, or has no options, is said in words and nothing is kept | reads `notification-setting`, writes `notification-choice` |
| `tool:record-a-notification` | Keeps one audience-scoped event as it was given, delivers nothing; the same event again changes nothing, a different one under the same id is refused | reads and writes `notification-event` |
| `tool:my-notification-events` | The events that name one audience, newest first | lists `notification-event` |

## Records

| Type | Id | Value |
|------|----|-------|
| `notification-setting` | `notification-setting:<setting name>` | `{ title?, description?, options: [{ id, value or key, label?, description? }], default? }` (an option is named by its `id`, else its `value`, else its `key`), written by the person |
| `notification-choice` | `notification-choice:<setting name>` | `{ value, at }` |
| `notification-event-rules` | `notification-event-rules:events` | `{ kinds?, privacy_classes? }`, written by the person: the names an event's `kind` and `privacy_class` may take. With no record, or no list, any words are accepted. |
| `notification-event` | `notification-event:<notification_id>` | the event: `notification_id`, `kind`, `conversation_ref`, `privacy_class`, `title`, `body`, `occurred_at`, `audience_refs`, `source_refs`, `proof_refs`, optional `operationId`, `transitionId`, `idempotencyKey` |

## Not carried

The old action fixed an event's `kind` to one name and its `privacy_class` to one value; here both are words the caller gives, limited to the lists in the person's `notification-event-rules` record when they saved one. The old trigger rule, which watched progression results and sent any that carried a complete notification event to the record action, is not carried: it was wiring in the old engine, and whoever owns the finished effect calls `tool:record-a-notification` itself. The old policy's action routes, proof refs, `dirty` and `Save` / `Revert` states belonged to its screen and its write path and are not carried.

## Files

| File | Purpose |
|------|---------|
| `read-data/notifications.mjs` | `myNotificationChoice`, `chooseMyNotificationChoice`, `recordANotification`, `myNotificationEvents`, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `tool-rows.json` | The four rows. |
| `part.json` | The folder's public files. |
| `test/notifications.test.mjs` | The rows against the fake records door with exactly their rights: options and defaults, invalid and empty settings, choosing, refusals, recording, repeats, clashes and reads. |

## Dependencies

**Depends on:** `tools/records-door`.
