# tools/notifications/

A person's notification choices, device registrations, recorded notice events and device delivery, kept in their own
records and reached through the run's records door (`tools/records-door`). A notice is delivered only when a caller
names an already recorded event and an audience that event names. Push-token addresses stay in the person's records;
Apple and Web Push credentials arrive only on declared private pipes. A provider accepting a push does not mean the person saw it.
`tools/tell-the-person` reads the stored notice and the first surface where the person marked it read.

Ported from bitfield-packages `packages/notifications` and the native device/tell/APNs owners: the options reader and
choice write, event record with its offered actions, private device registry, queued device-pull notices, APNs and
browser alerts, and Live Activity start, update and end. The old service's account screens and non-device channels
remain with their owners.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:my-notification-choice` | The options a setting offers, which one is chosen, and whether the choice is still one of the options (`ready`, `empty`, `missing`, `invalid`); a setting the person has not described is answered in words, not refused | reads `notification-setting`, `notification-choice` |
| `tool:choose-my-notification-choice` | Keeps one described option as the person's choice; an option the setting does not describe is refused with the options named; a setting that is not described, or has no options, is said in words and nothing is kept | reads `notification-setting`, writes `notification-choice` |
| `tool:record-a-notification` | Keeps one audience-scoped event as it was given, including offered action payloads; the same event again changes nothing, a different one under the same id is refused | reads and writes `notification-event` |
| `tool:my-notification-events` | The events that name one audience, newest first | lists `notification-event` |
| `tool:my-notification-devices` | Lists registered devices and their permission/presence state, never their private addresses | lists `notification-device` |
| `tool:my-browser-push-application-key` | Derives the browser enrollment key from the same held private key used to sign pushes; returns only its public point | reads `web_push` from held `notification-signing-keys` |
| `tool:register-my-notification-device` | Keeps a validated APNs token, Web Push subscription or device-pull id; re-registering the same address keeps the same opaque id | reads and writes `notification-device` |
| `tool:remove-my-notification-device` | Removes the named device and its private address | reads and writes `notification-device` |
| `tool:send-notification-to-my-devices` | Appends the recorded event and offered actions to `told-the-person`, queues device-pull readers and sends APNs/browser push; accepted is distinct from read and uncertain requests are not repeated blindly | reads the event, told-list and registered devices; writes the told-list |
| `tool:register-my-live-activity` | Keeps or ends a private iOS Live Activity token under its board key | reads and writes `notification-live-activity` |
| `tool:send-live-activity-update` | Starts one Live Activity board by push-to-start, updates returned activity tokens, or ends them when no work runs | reads and writes the activity tokens and durable delivery receipts; sends through APNs |

## Records

| Type | Id | Value |
|------|----|-------|
| `notification-setting` | `notification-setting:<setting name>` | `{ title?, description?, options: [{ id, value or key, label?, description? }], default? }` (an option is named by its `id`, else its `value`, else its `key`), written by the person |
| `notification-choice` | `notification-choice:<setting name>` | `{ value, at }` |
| `notification-event-rules` | `notification-event-rules:events` | `{ kinds?, privacy_classes? }`, written by the person: the names an event's `kind` and `privacy_class` may take. With no record, or no list, any words are accepted. |
| `notification-event` | `notification-event:<notification_id>` | the event: `notification_id`, `kind`, `conversation_ref`, `privacy_class`, `title`, `body`, `occurred_at`, `audience_refs`, `source_refs`, `proof_refs`, optional `open`, `actions` (offered `post`/`open`/`press` definitions), `operationId`, `transitionId`, `idempotencyKey` |
| `notification-device` | `notification-device:<BLAKE3 route and address>` | the private device address, route, label, app, environment, permission and presence reports. Tool output omits the address. At most 40 registrations are kept. |
| `notification-live-activity` | `notification-live-activity:<BLAKE3 board key and token>` | private activity push token, app, environment and registration time |
| `notification-live-activity-start` | `notification-live-activity-start:<BLAKE3 board key>` | last durable push-to-start attempt, so a repeated update does not start the same board again while its token is in flight |
| `notification-live-activity-delivery` | `notification-live-activity-delivery:<BLAKE3 board key and update id>` | attempt and result for one APNs Live Activity update; an unknown outcome stays held for reconciliation |

All three signing rows mount one private `notification-signing-keys` JSON bundle on descriptor 4:
`{ "apns": { "key_id", "team_id", "pem" }, "web_push": { "jwk", "contact" } }`. Either provider may be absent
when unused. This is a generic contract for the caller’s own signing keys; declaring it does not establish that a key
exists. Trillion platform push remains unconfigured pending an operator-owned host signing/send capability. Never copy
service-wide app keys into a personal vault or mount them into Workshop scripts.

APNs uses verified HTTP/2 through the engine’s declared HTTPS CONNECT proxy. Browser pushes use their own HTTPS
transport. Tool outputs expose accepted device ids per route, never tokens, subscription endpoints, signing values or
provider response bodies. Accepted and queued results do not mean read. Tests use generated keys and local/fake
providers; they do not prove that a credential is connected or a real device received a push.

An `apns-activity` registration requires the receiving app’s exact `attributes_type`. Push-to-start uses that registered
type per device and refuses missing/invalid types. The generic payload and category key is `notification`; receivers
may retain explicit legacy compatibility. Live Activity content keeps native progress fields flat: done, total, unit,
label.

## Not carried

The old action fixed an event's `kind` to one name and its `privacy_class` to one value; here both are words the caller gives, limited to the lists in the person's `notification-event-rules` record when they saved one. The old trigger rule, which watched progression results and sent any that carried a complete notification event to the record action, is not carried: it was wiring in the old engine, and whoever owns the finished effect calls `tool:record-a-notification` itself. The old policy's action routes, proof refs, `dirty` and `Save` / `Revert` states belonged to its screen and its write path and are not carried.

## Files

| File | Purpose |
|------|---------|
| `read-data/notifications.mjs` | `myNotificationChoice`, `chooseMyNotificationChoice`, `recordANotification`, `myNotificationEvents`, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `tool-rows.json` | The notification choice, event, device, delivery and Live Activity rows. |
| `part.json` | The folder's public files. |
| `test/notifications.test.mjs` | The rows against the fake records door with exactly their rights: options and defaults, invalid and empty settings, choosing, refusals, recording, repeats, clashes and reads. |
| `test/device-notifications.test.mjs` | Device registration, private addresses, dispatch receipts, retry safety and Live Activity lifecycle. |
| `read-data/http2-request.mjs` | Bounded HTTP/2 transport with verified TLS and the engine’s HTTPS CONNECT proxy. |
| `test/http2-request.test.mjs` | Local TLS/proxy, deadline, response bounds, certificate and cleanup checks. |
| `test/web-push.test.mjs` | Web Push subscription encryption and VAPID request validation. |

## Dependencies

**Depends on:** `tools/records-door`.
