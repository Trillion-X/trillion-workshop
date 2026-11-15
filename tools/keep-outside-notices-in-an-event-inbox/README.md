Ports old trillion `src/event-inbox.mjs` and `src/inbox-handlers.mjs`. Notice-key deduplication, durable acknowledgement before apply, bounded retry, permanent refusals, alarms, upkeep and dependency wakeups remain the source algorithm.

The class no longer extends the retired `StoredObject`. A current admitted durable host must supply SQL storage and alarms, the source handler table and, for membership calls, its route membership owner. `createInboxHandlers` preserves Stripe request construction and upkeep but requires the admitted payment host's notice, price and account functions. No new local SQL engine, payment authority or substitute policy is introduced. The current native engine does not yet provide this hosted durable inbox/payment bridge; tests prove the algorithm against real SQLite and explicitly supplied handlers, not a deployed integration.

The source-first baseline is `24355f0b672afdec8fca930256eca1c07d1e0c06`. The apply timeout is cleared after an answer so native Node consumers do not retain a pending timer. Tests cover once-only delivery, all original permanent refusal statuses, transient status retries with an alarm, wakeups and exact payment request construction.

The current contracts name the later complete byte-copy baseline
`63c25819e8e2d75ee273b440c90c647785de775a`. Both are retained historical
captures; qualification also requires the declared baseline to be in the judged
tree's ancestry. The tests additionally cover thrown-handler retry, the one-hour
backoff cap, cross-inbox wakeups, failed hourly upkeep, removal of unowned upkeep,
and a route stop that completes while its legacy lookup is waiting.
