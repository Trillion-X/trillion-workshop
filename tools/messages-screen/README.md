# messages-screen

The Messages screen: every conversation with AIs and in spaces, drawn with the shared chat part and its composer. The screen itself (`show/*.tsx`) runs in the app; this folder's row runs the screen's conversation list without it.

## Files

| File | Purpose |
|------|---------|
| `show/build-chat-conversation-list.ts` | The list helpers the screen's sidebar uses: newest first, filter by words, participant or project, group by date |
| `show/list-conversations.mjs` | `listConversations({ conversations, search, participant, project })`: the list as one run (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:list-my-conversations-newest-first`, with a sample run that finds one conversation by a word of its title |
| `README.md` | This file |
| `web/src/workspace/messages-screen-mount.tsx` | The screen's module entry, the file its row (`tool:screen-messages`) names: `mount` is the screen's own mount function. |
| `web/src/workspace/messages-screen.tsx` | Messages: every conversation with the person's AIs and in their spaces, drawn with the shared chat part (`parts/ui/show/chat`: list beside the open conversation, days, runs by speaker, hover times, newest at the bottom) and written with the one composer (`parts/ui/show/composer`, `@` mentions from `mentions.ts`). Reads `/work/api/messages/threads`, `/thread`, `/agents`, `/delivery` and `/work/api/spaces/...`; sends through `/send` (with the message's files), `/send-all` (the one owner `src/send-to-all-ais.mjs`, opened by New message as All your AIs) and space items, where each file is shared first, the words carry their mentions, and an AI at work in the space that is mentioned is handed the message as a job. Each AI shows its app's picture from `activity-providers.json`, initials otherwise. One conversation's messages are also one list (each message its words, who said it, when, and the message it answers), so the Chat leads and every view any list is offered draws the same messages: Draw (each message a card, a line to the one answering it), the Document, the Sheet, the Board, the Inbox and the rest. |
| `web/src/workspace/chat-records.ts` | The records seam the screen's chat reads and writes through: starts the chat's records, follows a conversation, sends in one. |
| `web/src/workspace/pending-lines.ts`, `web/src/workspace/pending-sends.json` | A message the account has not answered yet, shown in its conversation at once as one more line with Send again and Don't send; its words are the DATA file. |
| `web/src/workspace/conversation-presence.ts`, `web/src/workspace/conversation-presence.json` | Who else is in a conversation now and who is typing, and the words it says about them (DATA). |

The other folders (`chat/`, `conversations/`, `do-work/`, `read-data/`, `show/`) are the screen's code as it was moved here in a9ee258; `show/README.md` describes the chat part.
