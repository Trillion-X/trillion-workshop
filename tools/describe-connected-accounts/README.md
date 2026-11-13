# tools/describe-connected-accounts/

What a person's connected accounts are, in plain words: which account of a service is the primary one (the earliest until the person chooses; a choice that no longer holds is ignored), what an account's sign-in allowed in plain groups (Calendar, Contacts, Email...; only what the provider reported), and what each account's card says: what Trillion copies from it, what stays live with the person's own sign-in, and what Trillion may do with it. Every sentence and group is a row of data (`src/connection-card-words.json`, `src/connection-accounts.json`); no service is named in code.

Moved byte for byte from Trillion-X/trillion (commit b92aa549f2) by `tools/move-code-between-trees`: `src/connection-accounts.mjs`, `src/connection-card-words.mjs` and their rows (`moved-from.json` names each file's source and both identities). The old copies stay until their callers, Trillion's Connections screen and account routes (`src/account-screens.mjs`, `src/connector-screen.mjs`, `src/account-routes.mjs`, `src/account-action-domain.mjs`, `src/person-store.mjs`), move. `test/connected-accounts.test.mjs` keeps the module assertions of the old `test/amie-integrations.test.mjs` and `test/connection-card-words.test.mjs`; the screen assertions stay with the screen.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:describe-connected-accounts` | The primary account of each service, and per account its allowed groups, its card words and its guide steps | in a small container, no internet |

## Files

| File | Purpose |
|------|---------|
| `src/connection-accounts.mjs` | `primaryAccounts`, `withPrimary`, `scopeGroupsOf`. |
| `src/connection-card-words.mjs` | `connectionCardFacts`, `connectionCardWords`, `connectionCardSteps`, `TOOL_SERVER_WORDS`. |
| `src/connection-accounts.json` | The primary fact, the minimum accounts and the permission groups. |
| `src/connection-card-words.json` | Every sentence a card says, chosen by its facts. |
| `do-work/describe-connected-accounts.mjs` | The row's run. |
| `test/connected-accounts.test.mjs` | The original module assertions. |
| `test/describe-connected-accounts.test.mjs` | The row's run. |
| `tool-rows.json` | The Workshop row. |
| `moved-from.json` | Where each moved file came from and its identities. |
| `part.json` | Public files. |
| `web/src/connector-screen.mjs` | The Find a connector section of Connections as guide DATA: a search box, then each connector the public catalogs answered with (name, what it does, where it was found) and Use, which adds it through the add-a-tool-server tool. Moved byte for byte from the web client (`moved-from.json`); it imports `src/connection-card-words.mjs` of this folder. |
