# tools/read-and-edit-the-saved-configurations-others-shared/

Read and edit the saved configurations others shared with me, by link or offer, and keep a receipt of each change.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## The route tool

`tool:answer-the-configurations-page` (`do-work/answer-the-configurations-page.mjs`, `tool-rows.json`) answers the
saved-configurations routes, `/configurations` and `/configurations/...`, the way the old account owner did. It uses the
old owner itself, `makeConfigurations` and `handleConfigurationsRequest` from `tools/query-and-change-list-rows/src/configurations.mjs`,
over the person's `record:configuration` records and their `list:` records, reached through the records door. The
engine runs it as a `@workshop-routes` tool.

Configurations other accounts shared with this one by link or offer (`?visibility=shared`, `/configurations/shared/<code>`,
`/configurations/offers/<code>`) and the time-bound context go through record sharing between accounts. No
records-door run can reach record sharing, so those routes return the old handler's own 503 `configuration_unavailable`.
`test/answer-the-configurations-page.test.mjs` ports the tag's `test/configurations-record-engine.test.mjs` owner cases
and runs the row against the fake records door.
