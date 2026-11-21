# messages-screen

The Messages screen: the person's conversations (what their apps told them, and the conversations kept with their AIs) in a list beside the one open, drawn as bubbles by side, grouped by day and time. The screen itself (`web/src/workspace/messages-screen.tsx`) runs in the app; this folder's row runs the conversation list without it.

## Files

| File | Purpose |
|------|---------|
| `show/build-chat-conversation-list.ts` | The list helpers the screen's sidebar uses: newest first, filter by words, participant or project, group by date |
| `show/list-conversations.mjs` | `listConversations({ conversations, search, participant, project })`: the list as one run (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:list-my-conversations-newest-first`, with a sample run that finds one conversation by a word of its title |
| `README.md` | This file |
| `web/src/workspace/messages-screen-mount.tsx` | The screen's module entry, the file its row (`tool:screen-messages`) names: `mount` is the screen's own mount function. |
| `web/src/workspace/messages-screen.tsx` | The screen: the conversation list (search, newest first, app picture or initials) beside the open conversation; the conversation's messages as bubbles (the person's on the right), grouped by day, by who is talking and by time; a photo as a tile with its name; forgetting a told message on hover; the composer, disabled with the words saying replying is not built yet. Every word comes from `messages-words.json`. |
| `web/src/workspace/messages-owner.json` | DATA: the owners' stores and their SQL (the told messages in `statements`, the kept conversations in `old_store`), read with the store's own connection. |
| `web/src/workspace/messages-words.json` | DATA: every word the screen and its records show. |
| `web/src/workspace/messages-turns.ts`, `messages-turns.test.ts` | Pure helpers: a stored time as milliseconds; a conversation's lines grouped into days and turns of talk. Tested with `node --test`. |
| `web/src/workspace/chat-records.ts` | The records seam the screen reads and writes through: the conversation list (`chat-session-window`), each open conversation's lines, and forgetting one told message. Every read is the owner's SQL (`messages-owner.json`) through `tool:run-sql-in-my-database`. |

The other folders (`chat/`, `conversations/`, `do-work/`, `read-data/`, `show/`) are the screen's code as it was moved here in a9ee258. The chat part itself is tools/chat's: the copies of it this folder held, which nothing imported, are deleted; `tools/chat/read-data/read-chat-sessions.ts`, `stream-parse-spec.ts` and `paste-policy.mjs` stay while other code imports them here.
