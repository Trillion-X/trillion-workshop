# tools/tell-one-person-something-through-every-way-they/

Tell one person something through every way they chose to hear that kind of news, and stop when the thing it was about is settled.

Old trillion's owner of this, `src/tell-the-person.mjs` (tag `old-trillion-before-worker-retire`), is `read-data/tell-the-person.mjs`: a byte copy first (3cffafe5), then adapted as `ports/tell-the-person.json` says (import paths, and `GET /tell/feeds` answering the shipped glance feeds). Its rows (`records/tell-the-person.json`), quiet-hours row, glance feeds and run-progress rows came with it, and its test runs here with its assertions unchanged. The parked copies under `from-old-trillion/` were these files; `moved-from.json` records where each went.

## Files

| File | Purpose |
|------|---------|
| `read-data/tell-the-person.mjs` | `makeTellThePerson` (tell, report, recent, forDevice, markRead, act, settings, ...), `handleTellRequest` and the routes it answers |
| `read-data/tell-the-person.json` | The channels, kinds, actions and words (old `records/tell-the-person.json`) |
| `read-data/tell-quiet-hours.json`, `read-data/glance-feeds.json`, `read-data/run-progress.json` | Old `src/tell-quiet-hours.json`, `records/glance-feeds.json`, `records/run-progress.json` |
| `do-work/tell-routes.mjs` | `answerTellNoticesRoute`, `tool:answer-the-tell-notices-route`: the page route GET /work/api/tell/notices as a route tool, the moved route over the person's `told-the-person` records (read as `tools/tell-the-person` reads them). Contract `ports/tell-routes.json` |
| `tool-rows.json` | The route row |
| `test/tell-the-person.test.mjs` | Old trillion's test, its assertions unchanged (paths only) |
| `test/tell-routes.test.mjs` | The route row against the records door stand-in, checked against the moved owner |

## Not a route yet

`GET /work/api/tell` answers the Notification settings: every channel with whether it can send now (`settings`, each sender's `state`). Old trillion's senders were the engine's (src/native-tell-senders.mjs: Worker secrets, the person's carried connections, their registered devices, the workshop shop). A route run reads the person's records and nothing of the engine's senders, so it cannot say whether a way can send.

## Dependencies

**Depends on:** `tools/tell-the-person` (its reader of `told-the-person` records), `tools/tell-the-person-something-on-all-of-their-own-phones-computers` (`src/tell-devices.mjs`), `tools/shared-code` (`src/workspace/screens.mjs`, `src/web-push.mjs`), `tools/hand-off-jobs-between-agents` (`src/workspace/addresses.mjs`), `tools/keep-and-wake-ai-sessions-on-this-computer` (surfaces and screen rows read by screens.mjs; account tool rows and waiting-on-you rows read by the test), `tools/starting-set` (the test), `tools/records-door`.
