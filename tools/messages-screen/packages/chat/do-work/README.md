# Chat Do Work

This folder owns Chat package commands that materialize exchanges, invoke owner targets, and write package-owned records.

## Files

| File | Purpose |
| --- | --- |
| `README.md` | Documents the Chat do-work folder. |
| `__tests__/README.md` | Documents do-work proof files. |
| `__tests__/addressed-exchange-backend.test.ts` | Proves prompt descriptors and structured action request materialization. |
| `apply-chat-tool-edit.ts` | Applies accepted tool edits. |
| `ask-file-classification-for-chat.ts` | Builds file classification requests for chat context. |
| `build-live-chat-prompt.ts` | Assembles participant prompts from selection, history, context grants, actions, surfaces, and descriptor-owned windows. |
| `create-idea-from-chat.ts` | Requests idea capture from chat text. |
| `execute-chat-work-requests.ts` | Converts assistant text adapters into structured owner action request records and invokes workflow targets. |
| `materialize-addressed-exchange.ts` | Builds an addressed exchange prompt and source-session decision from package data. |
| `process-reply.ts` | Processes generic replies from package targets. |
| `process-scripts/` | Holds process-backed transcript/history materialization scripts. |
| `publish-chat-session-window.ts` | Publishes a session window through the owner action path. |
| `read-chat-transcript-page.ts` | Reads a bounded transcript page. |
| `refresh-chat-history.ts` | Requests chat history refresh. |
| `rename-chat-conversation.ts` | Requests a session title rename. |
| `reveal-chat-source-file.ts` | Requests reveal/open of a source file. |
| `run-live-chat-turn.ts` | Starts and finalizes participant route turns through owner targets or process-session descriptors. |
| `write-addressed-exchange-through-conversations.ts` | Validates Chat drafts and dispatches the generic Conversations conversation/turn/projection owner actions. |
| `migrate-chat-ledger-conversation-to-conversations.ts` | Performs the idempotent, preservation-checked exact legacy-to-Conversations migration. |
| `submit-message-intent-from-chat.ts` | Writes a viewer annotation intent (reaction/pin/star/bookmark) to the durable viewer-intent ledger, then forwards real egress ONLY through a session-declared `reactCapability` (fail-closed). |
| `submit-connect-action.ts` | Submits setup/connect actions for addressed participants. |
| `update-chat-sidebar-panel.ts` | Writes sidebar panel state. |
| `write-addressed-exchange-ledger.ts` | Retired legacy ledger reader/writer retained only as migration evidence; production writes go through Conversations owner actions. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
| --- | --- | --- |
| `materializeAddressedExchange` | `(input: AddressedExchangeMaterializationInput) -> AddressedExchangeMaterialization` | Produces the participant prompt using the package prompt assembly descriptor. |
| `buildLiveChatPrompt` | `(input: BuildLiveChatPromptInput) -> string` | Assembles prompt blocks while keeping history/window policy in descriptor data. |
| `materializeAddressedExchangeActionRequest` | `(input) -> AddressedExchangeActionRequestRecord` | Converts an adapter request into the structured owner action request protocol. |
| `executeChatWorkRequests` | `(input) -> Promise<ChatWorkRequestResult[]>` | Invokes workflow-backed owner actions after request materialization. |
| `startLiveChatTurn` | `(input: RunLiveChatTurnInput) -> Promise<StartLiveChatTurnResult>` | Invokes an addressed participant route through its owner target or process-session descriptor. |
| `writeAddressedExchangeThroughConversations` | `(input: WriteAddressedExchangeThroughConversationsInput, dispatch?) -> Promise<{ action_refs: string[], conversation_ref: string, turn_refs: string[] }>` | Upserts, appends, and republishes through the canonical Conversations owner in one adapter. |
| `migrateChatLedgerConversationToConversations` | `(input: ChatLedgerConversationMigrationInput) -> Promise<ChatLedgerMigrationProof>` | Migrates one exact legacy conversation with all preservation checks and repeat-run idempotency. |
| `submitMessageIntentFromChat` | `(input: SubmitMessageIntentFromChatInput) -> Promise<void>` | Persists a viewer annotation intent (opaque `intentKind` + `symbol`) to the durable ledger; forwards a real reaction egress only when `reactCapability.frontDoorAction` is DATA-declared. |

## Dependencies

**Depends on:** `@bitfield/runtime-kit`, Chat read-data helpers, the `process-session` launch descriptor reader, and `things-to-store-and-run.json`.

**Depended on by:** `packages/chat/show`, Chat backend tests, and package owner actions declared in `things-to-store-and-run.json`.
