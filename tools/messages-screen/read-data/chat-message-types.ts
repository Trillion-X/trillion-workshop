// PORTED FROM: bitfield-packages/packages/chat/read-data/chat-message-types.ts @ e99ac5976
// packages/chat/read-data/chat-message-types.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The canonical normalized message shape for the chat surface.
//
// This is the package's OWN vocabulary (Physics) — the single target type that
// EVERY participant's raw output is normalized INTO, regardless of how that
// participant formats its stream. A CLI agent, a cloud model, a human, a
// service, an animal, or a device all produce raw events in their own wire
// format; the generic stream interpreter (see do-work/run-live-chat-turn.ts)
// reads a data-supplied parse spec and emits exactly these AgentMessage values.
//
// Nothing here names any specific agent, provider, or wire format. The wire
// format is data carried on the participant's way-to-reach record; this file is
// only the destination shape.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This is the ONLY normalized message type. Producers (live stream parser,
//    transcript decoder, addressed-exchange ledger decoder) all emit AgentMessage[].
//    The third one was listed as the "bitfield-studio ledger decoder" until
//    2026-09-03. No such producer exists: the ledger owners are
//    `do-work/write-addressed-exchange-ledger.ts` and its siblings, and naming an
//    app here contradicted invariant 4 below, which forbids naming a platform.
// 2. `type` is a closed set of presentation kinds the surface can render. It is
//    Physics (how the surface displays), NOT Society (which agent produced it).
// 3. `role` is optional — some transcript lines have no resolvable role.
// 4. No field names a provider, model, CLI, or platform.
//
// =============================================================================

/**
 * The presentation kind of a normalized message. This is a closed set because it
 * is the surface's own rendering vocabulary — adding a new participant kind never
 * requires a new value here; it only requires parse-spec data that maps the
 * participant's raw events onto these existing kinds.
 */
export type AgentMessageType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'status'
  | 'error';

/** A tool invocation and (optionally) its result, paired by `id` when present. */
export interface AgentMessageToolUse {
  /** Correlation id used to pair a tool_use with its later tool_result. */
  id?: string;
  /** Display name of the tool. */
  tool: string;
  /** Opaque tool arguments. */
  params: Record<string, unknown>;
  /** Tool output text, filled in when the result arrives. */
  result?: string;
  /**
   * Trusted current-action projection of one durable result into the generic
   * placeable-surface rail. This is deliberately separate from `params`:
   * request arguments are producer/model controlled and never grant a mount.
   */
  placeableResult?: {
    /** Workflow-owned durable source identity, when completion was receipted. */
    sourceRef?: string;
    /** Validated selector from the current action descriptor. */
    selector: string;
    /** Selector-resolved preview; current eligible catalog still gates use. */
    surface: unknown;
  };
}

/** Token-usage accounting carried on a message when the source reports it. */
export interface AgentMessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

/** Derived teammate attribution parsed from message content (color + summary). */
export interface AgentMessageTeammate {
  id: string;
  color: string;
  summary: string;
}

/**
 * One self-describing lifecycle event on a message's monotonic state stream
 * (sent, delivered, read, failed, edited, retracted, ...). `key` is an OPAQUE
 * string the producing decoder emitted — it is NOT a closed enum here. The
 * surface maps `key` -> {label, tone, glyph} through a DATA override map, so a
 * new lifecycle kind is one data row, zero code (L090 / enum-dissolution).
 * `provenance` ranks certainty (0 optimistic .. 10 authoritative); the surface
 * shows delivered/read ONLY from authoritative events (fail-closed egress).
 */
export interface MessageStateEvent {
  /** Opaque lifecycle key emitted by the source decoder (e.g. "delivered"). */
  key: string;
  /** ISO-8601 time the event occurred, when the source reports it. */
  at?: string | null;
  /** Certainty rank: 0 optimistic .. 10 authoritative. */
  provenance?: number;
  /** Source-native provenance tag for debugging (e.g. "is_read=1"). */
  raw?: string;
}

/**
 * One current reaction on a message (a tapback / emoji reaction). `symbol` is an
 * OPAQUE key the source decoder emitted (e.g. "love", "emphasis") — NOT a closed
 * enum; the surface maps `symbol` -> glyph through a DATA override map. Already
 * reduced to the CURRENT set by the materializer (added-then-removed cancels).
 */
export interface MessageReaction {
  /** Stable id of the reaction subject atom, when present. */
  atomRef?: string;
  /** Opaque reaction symbol key emitted by the source decoder. */
  symbol?: string;
  /** "added" | "removed" from the source; the materializer only emits current. */
  reactionKind?: string;
  /** Who reacted (role/handle), when resolvable. */
  speaker?: string;
  /** ISO-8601 time of the reaction. */
  at?: string | null;
}

/**
 * One selectable reaction symbol in the DATA-driven reaction picker. The picker
 * enumerates NOTHING in code — the surface renders exactly the palette rows the
 * DATA supplies, so adding or retiring a reaction symbol is one data row and zero
 * code (L090 / enum-dissolution).
 */
export interface ReactionPaletteEntry {
  /** Opaque reaction symbol key written to the intent ledger (e.g. "love"). */
  symbol: string;
  /** Glyph shown in the picker and folded reaction cluster. */
  glyph: string;
  /** Human label for accessibility and tooltip. */
  label?: string;
}

/**
 * One selectable action in the message action menu (react, pin, star, bookmark,
 * ...). Every action rides the SAME onMessageIntent path — the action kind is
 * DATA, so a new durable annotation kind is one palette row and zero code.
 */
export interface MessageActionDescriptor {
  /** Opaque intent kind written to the ledger (e.g. "reaction", "pin", "star"). */
  intentKind: string;
  /** Glyph shown in the action menu. */
  glyph: string;
  /** Human label. */
  label: string;
  /**
   * When present, choosing this action opens the reaction symbol picker instead
   * of firing immediately (a reaction needs a symbol; pin and star fire direct).
   */
  opensPalette?: boolean;
  /**
   * When present, the first press asks this question in place (never a modal)
   * with a confirming button and one that keeps things as they are; only the
   * confirming press fires the action (DATA: the host's words).
   */
  confirm?: string;
  /** When present, the action is offered only on messages whose atomRef starts with it. */
  forRefs?: string;
  /** When true, the action's row is shown without a hover (a message that still has to be sent). */
  always?: boolean;
  /** A quiet line shown with an always-shown action row, saying why it is there (DATA: the host's words). */
  note?: string;
}

/**
 * One human-triggered workflow capability attached to a specific message.
 * The exact current owner identity is DATA. The surface never trusts an action
 * id or raw target, and revalidates this address/revision/hash before dispatch.
 */
export interface MessagePerformControl {
  id: string;
  label: string;
  pendingLabel?: string;
  successLabel?: string;
  perform: {
    /** Exact authority named by the owner transition, when the effect is actor-bound. */
    authorityRef?: string;
    capabilityRef: {
      canonicalAddress: string;
      canonicalRevision: string;
      payloadHash: string;
    };
    input: unknown;
    proofRefs?: string[];
  };
}

export interface MessagePerformResult {
  status: 'started' | 'failed' | 'unknown_outcome';
  message: string;
  evidenceRefs: string[];
}

export type MessagePerformHandler = (
  message: AgentMessage,
  control: MessagePerformControl,
) => Promise<MessagePerformResult>;

/**
 * A viewer-authored intent on a message subject atom, handed up to the surface's
 * onMessageIntent callback. The surface writes it to the durable intent ledger
 * (optimistic render at provenance 0) and forwards real egress only when the
 * source declares a reactCapability (DATA). Reaction is one config; pin, star,
 * and bookmark are emergent configs on this SAME path — no per-kind code.
 */
export interface MessageIntent {
  /** The subject atom the intent annotates. */
  targetAtomRef: string;
  /** Opaque intent kind (e.g. "reaction", "pin"). */
  intentKind: string;
  /** Reaction symbol, present only for reaction intents. */
  symbol?: string;
  /** Toggle direction for the annotation. */
  reactionKind?: 'added' | 'removed';
}

/**
 * One normalized message in a conversation. Every producer in this package emits
 * this shape; every renderer consumes it. The raw, participant-specific event is
 * gone by the time it becomes an AgentMessage.
 */
export interface AgentMessage {
  /** Stable id within the rendered list. */
  id: string;
  /** Presentation kind (closed surface vocabulary). */
  type: AgentMessageType;
  /** Display text (already extracted from the raw event). */
  content: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Speaker, when resolvable. */
  role?: 'human' | 'assistant';
  /** Present for tool_use / tool_result messages. */
  toolUse?: AgentMessageToolUse;
  /** Token usage, when the source reports it. */
  usage?: AgentMessageUsage;
  /** Wall-clock duration of the step, when known. */
  durationMs?: number;
  /** Teammate attribution, when the content declares one. */
  teammate?: AgentMessageTeammate;
  /** Stable subject id — the durable identity a reaction/edit anchors to. */
  atomRef?: string;
  /** Source-native subject id (e.g. iMessage guid), for cross-source joins. */
  nativeRef?: string;
  /** Monotonic lifecycle stream (sent/delivered/read/...), newest-last. */
  stateEvents?: MessageStateEvent[];
  /** Current reactions on this message (already reduced to the live set). */
  reactions?: MessageReaction[];
  /** Owner-verified work controls authored on this exact message. */
  performControls?: MessagePerformControl[];
  /** Trillion: what the message names, drawn as live record chips where each `@label` is written. */
  mentions?: { kind: string; value: string; label: string }[];
  /** Who said it, when it is someone other than the viewer or the conversation's own AI (a teammate, a sender). */
  author?: string;
  /** Trillion files attached to this message, rendered through the shared file preview. */
  files?: { key: string; name: string; url: string; contentType: string }[];
  /** Trillion: the links written in this message, each with its card once read (src/link-previews.mjs). */
  links?: { url: string; state: 'pending' | 'ready' | 'failed'; card?: Record<string, string> }[];
}
