# Chat

Chat uses `sidebar/AppSidebar` for its single conversation navigation, with caller-fed rows. Private rooms supply only their authorized conversations and never mount global sidebar reads or placement writes. Other participants are optional collapsed sections; histories retain their original identities.

App-authored `surfaceInput.defaultParticipantRef` chooses the assistant for a new/reset conversation; it does not pin optional participant choices or rewrite existing sessions. `assistantLabel` names that assistant in navigation. `participantRef` remains the explicit handoff override. `navigationSections` selects the visible `conversations`, `people`, and `agents` sections. The shared navigation adapter also accepts additional owner-supplied sections and actions.

## Files

| File | Purpose |
| --- | --- |
| `things-to-store-and-run.json` | Active Chat package contract, including the mountable placeable-surface record, package entry, input descriptors, stored bytes, workflow actions, and triggers. |
| `show/`, `read-data/`, `do-work/`, `show-ios-jscore/` | Browser, data, worker, and JavaScriptCore package code for the Chat entry. |
| `read-data/read-addressed-exchange-workspace.ts` | Generic exchange/action/proof projection read model shared by package consumers. |
| `read-data/use-chat-conversation-projections.ts` | Reads the canonical addressed-exchange feeds owned by `conversations`. |
| `read-data/map-conversation-projections-to-chat.ts` | Maps canonical Conversations projections into Chat rows without a Chat-owned transcript store. |
| `read-data/read-addressed-exchange-ledger.ts` | Legacy addressed-exchange shape decoder retained for the proven migration path only. |
| `do-work/materialize-addressed-exchange.ts` | Descriptor-driven exchange prompt materializer. |
| `do-work/write-addressed-exchange-through-conversations.ts` | Production write adapter: Chat validates drafts and dispatches generic Conversations owner actions. |
| `do-work/migrate-chat-ledger-conversation-to-conversations.ts` | Idempotent, preservation-checked migration of an exact legacy Chat ledger conversation into Conversations. |
| `do-work/write-addressed-exchange-ledger.ts` | Retired legacy ledger reader/writer retained only as migration evidence; never the production Chat write path. |
| `do-work/submit-message-egress-from-chat.ts` | Blind courier: forwards a sendable thread's self-describing send capability + recipient handle to the egress front door via `slot::workflow` `execute_definition`. Names no channel, parses no phone number, picks no transport. |
| `read-data/read-chat-sessions.ts` | Decodes the `chat-sessions` addressed feed into `ChatConversationRecord`s, including the fail-closed `sendCapability`/`sendRef` sendable discriminant. |
| `do-work/process-scripts/materialize-conversations.py` (send join) | `thread_to_row` attaches `sendCapability` (from the source's `send_capability_ref`) and `sendRef` (from the decoder's `send_ref`) so a row is sendable only when BOTH are present. |
| `read-data/read-message-annotation-palette.ts` | Fail-closed reader of the DATA-driven message-annotation palette (`package::chat::message-annotation-palette::default`) — reaction glyphs + message actions as self-describing rows; the surface enumerates nothing (L090). |
| `do-work/submit-message-intent-from-chat.ts` | Writes a viewer annotation intent (reaction/pin/star/bookmark) to the durable viewer-intent ledger, then forwards real egress ONLY through a session-declared `reactCapability` (fail-closed: absent capability means the durable annotation is the whole effect). |
| `show/MessageAnnotations.tsx` | Palette-driven reaction bar + durable annotation badges on every message bubble; gates tone/visibility on the integer provenance scale (`AUTHORITATIVE=10`), names no symbol. |
| `do-work/process-scripts/decode_viewer_reactions.py` | Durable-readback decoder that projects persisted annotation intents into per-atom `MessageReaction` rows so an authored annotation converges from optimistic (provenance 0) to durable on reload. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
| --- | --- | --- |
| `readAddressedExchangeWorkspace` | `(input: AddressedExchangeWorkspaceInput) -> AddressedExchangeWorkspace` | Builds the generic exchange/action/proof projection. |
| `materializeAddressedExchange` | `(input: AddressedExchangeMaterializationInput) -> AddressedExchangeMaterialization` | Builds prompts from package-owned descriptor data. |
| `materializeAddressedExchangeActionRequest` | `(input) -> AddressedExchangeActionRequestRecord` | Converts assistant text adapters into structured owner action records. |
| `writeAddressedExchangeThroughConversations` | `(input: WriteAddressedExchangeThroughConversationsInput) -> Promise<{ action_refs, conversation_ref, turn_refs }>` | Upserts the conversation, appends turns, and republishes projections through the Conversations owner. |
| `migrateChatLedgerConversationToConversations` | `(input: ChatLedgerConversationMigrationInput) -> Promise<ChatLedgerMigrationProof>` | Proves the exact legacy conversation is identical after migration and is idempotent on repeat runs. |
| `ConversationSendCapability` | `{ frontDoorAction, channel, destinationId }` | Opaque source-declared outbound routing object the composer forwards verbatim; never interpreted by chat/host. |
| `submitMessageEgressFromChat` | `(input: SubmitMessageEgressFromChatInput) -> Promise<unknown>` | Dispatches the source-named front-door action to `slot::workflow`; blind forward, no channel switch. |
| `buildSubmitMessageEgressInput` | `(input) -> Record<string, unknown>` | Builds the egress front-door payload (intent id, destination, channel, recipient, body, reply_to_thread_ref) — carries no credential/consent. |
| `readMessageAnnotationPalette` | `(records) -> { reactionPalette, messageActions }` | Fail-closed palette reader; empty arrays on absent/malformed DATA, so the surface renders no affordance it was not given (L090). |
| `submitMessageIntentFromChat` | `(input: SubmitMessageIntentFromChatInput) -> Promise<void>` | Persists a viewer annotation intent (opaque `intentKind` + `symbol`) to the durable ledger; forwards a real reaction egress only when `reactCapability.frontDoorAction` is DATA-declared. |
| `MessageIntent` | `{ targetAtomRef, intentKind, symbol?, reactionKind? }` | Self-describing annotation intent the surface emits from a palette row; carries no channel and no enumeration. |

## Dependencies

**Depends on:** Runtime Kit package inputs, `process-session`, `workflow`, shared `ui`, and `screen-look`.

**Depended on by:** Bitfield Studio, a coaching app, Tribes, browser Chat entry, and Chat JavaScriptCore entry.
| `do-work/process-scripts/materialize-conversations.py` | Reader-keyed conversation-list materializer over descriptor-named observer and decoder capabilities. |
| `do-work/process-scripts/materialize-transcript.py` | Reader-keyed transcript-window materializer over the same source descriptor and decoder path. Carries the generic overlay-weave seam (`apply_overlays`): blindly decodes DATA-named overlay decoders (`descriptor.decoder_capability_ref`), filters their atoms to the open thread(s), and defers ALL dedup to `transcript_mapper.converge_atoms`. Names no overlay by string; a no-op (byte-identical output) when no overlays are present; older pages (`before_cursor` set) skip the seam. **`feed_mount` pairing (`_load_overlay_bundle`):** because inline mount grammar cannot embed a fixed literal descriptor around a bound feed value, the descriptor (a chat DATA literal in `overlays.json`) and the bound feed (the CD scoped-feed address, mounted as a sibling `egress-feed.json`) are mounted as SEPARATE files and paired here — an overlay entry names `feed_mount:"egress-feed.json"`, resolved against the overlay file's own directory (not cwd), and its rows become the decoder's `observation.payload`. The 7th positional argv (`overlays.json`) is optional; absent ⇒ pure single-source render. |
| `do-work/process-scripts/__tests__/test_materialize_overlay_weave.py` | End-to-end weave proof through the REAL driver stack (transcript_mapper + decode_egress_ledger + materialize-transcript) with only the TCC-blocked native chat.db decoder faked; renders the pre-echo optimistic weave and the post-echo converged transcript. Includes the exact `feed_mount` split the live def uses (literal descriptor + separately-mounted bound feed) and an optimistic-before-echo isolation test that fails unless the mounted feed genuinely decodes (guards against a false positive where the native echo happens to supply the same body). 10/10. |
| `tests/chat-reader-keyed-materialization.test.mjs` | Focused proof that conversation rows and transcript windows come from one descriptor-owned atom path with opaque pagination cursors. |
| `tests/chat-scanner-retirement.test.mjs` | Boundary proof that the retired scanner script and stored-byte authority are gone after the materializer replacement exists. |
| `tests/chat-owner-action-proof.test.mjs` | Owner-action/proof descriptor conformance for routing writes and proof refs without local domain status copies. |

## Rules

- `chat` publishes the `Chat` placeable surface as a package-entry-backed material surface.
- The `Chat` placeable-surface payload must carry `package_entry: { package_name: "chat", entry_name: "chat" }`. The live `published-records` aggregate can carry an empty source-package column for content-addressed rows, so Screen Arrangement must not need to infer the entry from that column.
- The `published-records` input descriptor uses the shared two-column `address,payload` table shape.
- Object-form package inputs must publish their descriptor at `package::chat::input::<input_name>`. For example, `liveProcessSessionEvents` lives at `package::chat::input::liveProcessSessionEvents`; the runtime does not translate kebab-case aliases when building the live read scope.
- Chat does not consume the retired `agent-tasks` sink. Agent context comes from addressed conversation, inbox, process-session, or generic activity records owned by the relevant packages.
- Chat does not publish or consume the retired load-trigger family. Boot/live refresh uses the current runtime lifecycle and live partition triggers: `runtime_loaded`, `data_state`, and `envelope_changed`.
- Chat logic/backend centers on the generic addressed exchange record/action/proof projection. Product labels, statuses, outcomes, and route choices are package data, not package-specific backend classes.
- Prompt history/window policy is carried by `package::chat::prompt-assembly::default` and interpreted by `materialize-addressed-exchange.ts`.
- A conversation is **sendable** (composer can reply outbound) ONLY when its row carries BOTH `sendCapability` (source-declared routing) AND `sendRef` (decoder-resolved single recipient). Either absent → read-only, fails closed. Chat forwards the capability blindly; consent, exactly-once claiming, and transport live behind the front door in `content-distribution` (SSOT). Adding a new sendable channel is one `send_capability_ref` DATA row on the source + one transport leaf behind `run-publish-intent` — zero edits to chat.
- Chat does not publish the retired fused transcript scanner. Source discovery and decoding are owner-composed through observed-content descriptors, file-glob observer capabilities, JSONL decoder capabilities, and the reader-keyed materializers.
- A transcript window may weave in OPTIMISTIC overlay atoms (e.g. a just-sent outbound message from `content-distribution`'s egress ledger) so the message appears immediately, before the authoritative native echo arrives. Overlays are DATA-named (`decoder_capability_ref`) — chat names no overlay source and does its own dedup nowhere; convergence of the optimistic atom with its later authoritative echo is owned entirely by `transcript_mapper.converge_atoms` (provenance-ranked, content-keyed, greedy 1:1). With no overlays configured the window is byte-identical to the pure single-source render. Native-echo convergence is live-provable only where the native store is readable; for iMessage the native `chat.db` is TCC-blocked to the engine, so that leg's live proof is TCC-gated (the primitive, adapter, and weave are fully offline/unit-proven).
- A viewer may AUTHOR an annotation on any message bubble (incoming AND outbound) — reaction, pin, star, bookmark — through one path: the surface reads the DATA-driven palette (`package::chat::message-annotation-palette::default`), emits a self-describing `MessageIntent` from the tapped row, renders it OPTIMISTICALLY at integer provenance 0, and dispatches `submitMessageIntentFromChat`. Adding a new reaction glyph or a new durable annotation kind is ONE palette DATA row and ZERO code (L090/enum-dissolution); pin/star/bookmark are emergent configurations of the same intent, not separate features. The annotation is the viewer's OWN durable record; convergence from optimistic to durable is owned by `decode_viewer_reactions.py` on reload.
- Reaction egress FAILS CLOSED: an authored reaction dispatches real outbound egress ONLY when the session row declares a `reactCapability` (DATA, mirrors `sendCapability`). Absent → the durable annotation is the whole effect and nothing is sent (iMessage cannot send tapbacks, so its `reactCapability` is absent by design). On durable-write FAILURE the optimistic entry is DROPPED — an unproven annotation never persists as delivered.
- The live `read-chat-session-transcript-page` def carries the overlay path as pure DATA (zero engine change): (1) an input-descriptor at `package::chat::input::content-distribution-content-media-evidence` projects the CD scoped feed (col0 role, col1 record json, col2 source_package) at `value_address_label:"content-distribution-content-media-evidence"`; (2) two read steps precede `materialize` — `egress_overlay_feed` (`{from:"content-distribution-content-media-evidence"}`) and `egress_decoder_script` (`{from:"package::content-distribution::stored-bytes::decode-egress-ledger-script"}`); (3) `overlays.json` is appended as the 7th positional argv; (4) three inputs mount the pieces — `decode_egress_ledger.py` (blob bound to `egress_decoder_script`), `egress-feed.json` (inline, bound to `egress_overlay_feed`), and `overlays.json` (inline raw-base64 literal descriptor naming `feed_mount:"egress-feed.json"`). Chat reuses the CD decoder by ADDRESS and never imports its crate or names its vocabulary; `transcript_mapper.py` is co-mounted in the same process-scripts dir so the decoder's `import transcript_mapper` resolves.

## Placeable Surface Catalog

Chat reads the full maintained `placeable-surfaces` list so it can reason over every placeable surface without an `all-surfaces` or registry feed.
