# Chat Read Data

This folder owns pure decoding and projection helpers for Chat package reads.

## Files

| File | Purpose |
| --- | --- |
| `README.md` | Documents the Chat read-data folder. |
| `__tests__/README.md` | Documents read-data proof files. |
| `__tests__/read-addressed-exchange-workspace.test.ts` | Proves the generic addressed exchange projection with chat and non-chat labels. |
| `chat-message-types.ts` | Defines the normalized package message shape consumed by renderers, plus the message-annotation types (`MessageIntent`, `MessageReaction`, `ReactionPaletteEntry`, `MessageActionDescriptor`). |
| `compaction-detection.ts` | Detects and parses transcript compaction/teammate markers. |
| `read-message-annotation-palette.ts` | Pure, fail-closed reader of the DATA-driven message-annotation palette (reaction glyphs + message actions). |
| `read-message-annotation-palette.test.ts` | Contract test for the palette reader — fail-closed empties + self-describing row parsing (8 cases). |
| `read-addressed-exchange-ledger.ts` | Decodes package-owned addressed exchange ledger conversations, turns, receipts, and event bridges. |
| `read-addressed-exchange-participants.ts` | Decodes addressed participant, route, connection, setup, and stream parse descriptors. |
| `read-addressed-exchange-workspace.ts` | Builds the generic exchange/action/proof workspace projection. |
| `read-addressed-exchange.ts` | Decodes generic exchange events and context grants. |
| `read-chat-launch-options.ts` | Decodes launch option records. |
| `read-chat-placeable-surface-segments.ts` | Reads inline placeable surface segment descriptors. |
| `read-chat-presets.ts` | Reads prompt preset records. |
| `read-chat-projects.ts` | Reads project/context records for the chat surface. |
| `read-chat-sessions.ts` | Decodes the current chat session window feed. |
| `read-chat-sidebar-panel.ts` | Decodes sidebar panel state. |
| `read-chat-work-actions.ts` | Discovers workflow-backed owner actions from self-described records. |
| `read-selected-text-for-next-agent-request.ts` | Reads selected source text for the next exchange request. |
| `read-session-transcripts.ts` | Decodes current transcript feeds and maps transcript lines to normalized messages. |
| `stream-parse-spec.ts` | Interprets participant-owned stream parse specs. |
| `use-chat-conversation-records.ts` | React hook for session-window reads and owner-backed rename/rescan actions. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
| --- | --- | --- |
| `readMessageAnnotationPalette` | `(records: readonly PublishedRecord[]) -> { reactionPalette, messageActions }` | Fail-closed reader for the annotation palette at `package::chat::message-annotation-palette::default`; empty arrays on absent/malformed DATA (L090 — no enumeration). |
| `readAddressedExchangeWorkspace` | `(input: AddressedExchangeWorkspaceInput) -> AddressedExchangeWorkspace` | Produces the generic exchange/action/proof projection used by package consumers. |
| `decodeAddressedExchangeEvent` | `(value: unknown) -> AddressedExchangeEvent | null` | Converts package ledger turns or owner exchange events into one event shape. |
| `decodeAddressedExchangeParticipantRows` | `(rows) -> AddressedParticipantInfo[]` | Reads participant and route descriptors without provider branches. |
| `findChatWorkflowActions` | `(records: PublishedRecord[]) -> ChatWorkflowAction[]` | Projects self-described workflow definitions into an action catalog. |
| `decodeActiveChatSessionWindowPayload` | `(raw: unknown) -> ActiveChatSessionWindowPayload` | Reads the windowed session feed. |
| `transcriptLinesToAgentMessages` | `(lines: TranscriptLine[]) -> AgentMessage[]` | Normalizes transcript lines for rendering. |
| `interpretStream` | `(text, spec, timestamp) -> AgentMessage[]` | Applies a data-owned stream parse spec to raw participant output. |

## Dependencies

**Depends on:** `@bitfield/runtime-kit/react`, `@/packages/ui`, and Chat package read-data helpers.

**Depended on by:** `packages/chat/show`, `packages/chat/do-work`, `packages/chat/show-ios-jscore`, and CS-031 backend proof tests.
