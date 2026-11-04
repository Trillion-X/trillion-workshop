// PORTED FROM: bitfield-packages/packages/chat/show/ChatPanel.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/ChatPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Main chat panel that composes ChatMessage and ChatInput into a complete
// chat interface. Renders a virtualized message list with auto-scroll behavior,
// empty state, and the input area at the bottom.
//
// Uses @tanstack/react-virtual for O(visible) DOM nodes instead of O(total).
// Only ~20 messages are in the DOM at any time regardless of conversation length.
//
// Adapted from a coaching app's message-list.tsx + chat-layout.tsx +
// conversation-welcome.tsx patterns.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Auto-scroll to bottom on new messages — UNLESS user scrolled up
// 2. Empty state rendered when no messages
// 3. Glassmorphism tokens from global.css — no gray-* colors
// 4. Message list uses shouldAutoScroll from chat-logic.ts for scroll detection
// 5. Human messages rendered with isHuman=true, agent messages with isHuman=false
// 6. Virtual rows positioned with translateY — absolute inside relative container
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useLayoutEffect, useRef, useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, ChevronDown, Wrench } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {AnimatePresence, useReducedMotion} from 'framer-motion';
import { motion } from '../../ui/motion/lazy-motion';
import { ChatMessage } from './ChatMessage';
import { AgentActivityRenderer } from './AgentActivityRenderer';
import { ToolUseBlock } from './ToolUseBlock';
import { ChatComposer } from './input';
import type { InputMode } from './IdeaModePill';
import { Badge, Card, Icon, Text, Container, Button } from '../../ui';
import type { PlaceableSurfacePayload } from '../../ui/show/placeable-surface-intent';
import { shouldAutoScroll } from './chat-logic';
import type {
  AgentMessage,
  ReactionPaletteEntry,
  MessageActionDescriptor,
  MessageIntent,
  MessagePerformHandler,
} from '../read-data/chat-message-types';
import {
  collapseVariants,
  collapseVariantsReduced,
  springFast,
} from '../../ui/motion/animation';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ChatPanelProps {
  /** Told on each edit in the composer (see ChatComposer onTyping). */
  onTyping?: () => void;
  /** Active session identity — used to reset scroll state on session switch */
  sessionId?: string | null;
  /** An addressed message opens at its own end, without restoring a previous visit's scroll position. */
  restoreScroll?: boolean;
  /** Messages to render in the chat */
  messages: AgentMessage[];
  /** Callback when the user sends a message */
  onSend: (content: string) => boolean | void | Promise<boolean | void>;
  /** Whether a response is currently streaming */
  isStreaming?: boolean;
  /** Whether the input should be disabled */
  inputDisabled?: boolean;
  /** Optional footer injected into ChatInput (below textarea) */
  inputFooter?: React.ReactNode;
  draftScope?: string;
  /** Optional history controls kept above the scroll viewport, reachable while the selected message is visible. */
  beforeMessages?: React.ReactNode;
  /** Optional content rendered below the entire input area */
  belowInput?: React.ReactNode;
  /** External value to prefill into the chat input */
  prefillValue?: string;
  /** Called after prefill has been consumed */
  onPrefillConsumed?: () => void;
  /** Active preset that will augment the message */
  activePreset?: { label: string; prompt: string; description?: string } | null;
  /** Called when the user dismisses the active preset */
  onPresetDismiss?: () => void;
  /** Read-only chip for context attached to the next message (selected text). */
  selectedContext?: { label: string; excerpt?: string } | null;
  /** Called when the user clicks stop during streaming */
  onStop?: () => void;
  /** Input mode owned by the parent chat view */
  inputMode?: InputMode;
  /**
   * DATA-driven reaction symbol palette. When empty/absent, no reaction picker
   * renders (fail-closed — the affordance appears only when DATA supplies it).
   */
  reactionPalette?: ReactionPaletteEntry[];
  /**
   * DATA-driven message action menu (react/pin/star/bookmark). Every action
   * rides the SAME onMessageIntent path; a new annotation kind is one DATA row.
   */
  messageActions?: MessageActionDescriptor[];
  /**
   * Viewer authored an intent on a message subject atom. The parent view writes
   * it to the durable intent ledger (optimistic at provenance 0) and forwards
   * real egress only when the source declares a reactCapability (DATA).
   */
  onMessageIntent?: (intent: MessageIntent) => void;
  /** Executes one owner-verified per-message work control. */
  onMessagePerform?: MessagePerformHandler;
  /**
   * Current eligible Studio surface catalog. Tool parameters are untrusted: a
   * generic tool result mounts a surface only when its normalized payload
   * exactly matches one row in this presentation catalog. Buyer authorization
   * remains outside Chat.
   */
  placeableSurfaceCatalog?: readonly PlaceableSurfacePayload[];
  /** Opaque active presentation owner supplied by the containing workspace. */
  surfaceIntentDestinationRef?: string | null;
}

/**
 * Memoization-safe delivery of the viewer-intent bundle to the virtualized rows.
 * VirtualRow is React.memo, so passing these as row props would be dropped by
 * memoization; instead each row reads this context and the Provider value is
 * useMemo-stable, so rows re-render only when the bundle genuinely changes.
 */
export interface MessageIntentBundle {
  reactionPalette?: ReactionPaletteEntry[];
  messageActions?: MessageActionDescriptor[];
  onMessageIntent?: (intent: MessageIntent) => void;
  onMessagePerform?: MessagePerformHandler;
  /** Memoization-safe delivery of the trusted surface catalog to transcript leaves. */
  placeableSurfaceCatalog: readonly PlaceableSurfacePayload[];
  surfaceIntentDestinationRef: string | null;
}

const MessageIntentContext = React.createContext<MessageIntentBundle>({
  placeableSurfaceCatalog: [],
  surfaceIntentDestinationRef: null,
});

// ---------------------------------------------------------------------------
// EMPTY STATE
// ---------------------------------------------------------------------------

interface EmptyStateProps {
  mode: InputMode;
}

function EmptyState({ mode }: EmptyStateProps) {
  const isIdeaMode = mode === 'idea';
  return (
    <Container layout="vertical" gap="md" padding="lg" alignItems="center" justifyContent="center" flex={1} data-reach-role="empty-state">
      <Icon icon={MessageSquare} size="lg" color="muted" />
      <Text variant="heading" color="muted">
        {isIdeaMode ? "What's on your mind?" : 'No messages yet'}
      </Text>
      <Text variant="body" color="faint">
        {isIdeaMode
        ? 'Write down your idea. Your assistant will organize it.'
        : 'Send a message to start a conversation with your assistant.'}
      </Text>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// VIRTUAL MESSAGE ROW
// ---------------------------------------------------------------------------

// Style constants applied to the absolutely-positioned virtual rows.
// Using style= on ui/Container is L065-compliant — only raw HTML className is banned.
const VIRTUAL_LIST_STYLE: React.CSSProperties = {
  position: 'relative',
  width: '100%',
};

// Preserve per-session scroll position when the chat view unmounts/remounts
// (e.g., switching macro tabs away from and back to chat).
const savedScrollTopBySession = new Map<string, number>();
const savedAutoScrollBySession = new Map<string, boolean>();

export function resetChatPanelScrollState(sessionId: string): void {
  savedScrollTopBySession.delete(sessionId);
  savedAutoScrollBySession.delete(sessionId);
}

export function bottomAlignedScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * Estimate row height from message shape so deep histories open closer to the
 * real tail before on-screen measurement converges.
 */
function estimateMessageHeight(msg: AgentMessage | undefined): number {
  if (!msg) return 48;

  if (msg.type === 'status') return 36;
  if (msg.type === 'tool_use' || msg.type === 'tool_result') return 44;
  if (msg.type === 'thinking') return 72;

  const normalizedLength = msg.content.replace(/\s+/g, ' ').trim().length;

  if (normalizedLength < 120) return msg.role === 'human' ? 52 : 40;
  if (normalizedLength < 400) return msg.role === 'human' ? 72 : 64;
  if (normalizedLength < 1200) return msg.role === 'human' ? 100 : 108;
  return msg.role === 'human' ? 130 : 148;
}

interface ToolGroupEntry {
  message: AgentMessage;
  messageIndex: number;
}

type RenderItem =
  | {
      kind: 'message';
      message: AgentMessage;
      messageIndex: number;
    }
  | {
      kind: 'tool_group';
      entries: ToolGroupEntry[];
      firstMessageIndex: number;
      lastMessageIndex: number;
    };

function isToolMessage(message: AgentMessage): boolean {
  return (message.type === 'tool_use' || message.type === 'tool_result') && !!message.toolUse;
}

function buildRenderItems(messages: AgentMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;

  while (i < messages.length) {
    const current = messages[i];
    if (!isToolMessage(current)) {
      items.push({ kind: 'message', message: current, messageIndex: i });
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < messages.length && isToolMessage(messages[j])) j += 1;
    const span = j - i;
    if (span <= 1) {
      items.push({ kind: 'message', message: current, messageIndex: i });
      i = j;
      continue;
    }

    const entries: ToolGroupEntry[] = [];
    for (let k = i; k < j; k += 1) {
      entries.push({ message: messages[k], messageIndex: k });
    }

    items.push({
      kind: 'tool_group',
      entries,
      firstMessageIndex: i,
      lastMessageIndex: j - 1,
    });
    i = j;
  }

  return items;
}

interface ToolGroupBlockProps {
  entries: ToolGroupEntry[];
  isStreaming: boolean;
  placeableSurfaceCatalog: readonly PlaceableSurfacePayload[];
  surfaceIntentDestinationRef: string | null;
}

function ToolGroupBlock({ entries, isStreaming, placeableSurfaceCatalog, surfaceIntentDestinationRef }: ToolGroupBlockProps) {
  const [isOpen, setIsOpen] = useState(false);
  const headerButtonRef = useRef<HTMLButtonElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const collapseMotion = prefersReducedMotion ? collapseVariantsReduced : collapseVariants;

  const preserveHeaderAnchor = () => {
    const header = headerButtonRef.current;
    if (!header) return;

    const scrollViewport = header.closest('[data-chat-scroll-viewport="true"]') as HTMLElement | null;
    if (!scrollViewport) return;

    const beforeTop = header.getBoundingClientRect().top;
    requestAnimationFrame(() => {
      const afterTop = header.getBoundingClientRect().top;
      const delta = afterTop - beforeTop;
      if (Math.abs(delta) < 0.5) return;
      scrollViewport.scrollTop += delta;
    });
  };

  const handleToggle = () => {
    setIsOpen((prev) => !prev);
    preserveHeaderAnchor();
  };

  return (
    <Card variant="nested" padding="none">
      <Button
        ref={headerButtonRef}
        variant="ghost"
        onClick={handleToggle}
        size="sm"
        radius="inherit"
        className="w-full justify-start"
        aria-expanded={isOpen}
      >
        <Container layout="horizontal" gap="sm" alignItems="center" flex={1} className="min-w-0">
          <Badge variant="muted" size="sm">
            <Icon icon={Wrench} size="xs" />
            {entries.length === 1 ? 'Work update' : `${entries.length} work updates`}
          </Badge>
          <Text variant="label" color="faint" truncate>
            {isStreaming ? 'Your assistant is working' : 'Work complete'}
          </Text>
        </Container>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={prefersReducedMotion ? { duration: 0 } : springFast}
        >
          <Icon icon={ChevronDown} size="sm" color="faint" />
        </motion.div>
      </Button>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="tool-group-body"
            variants={collapseMotion}
            initial="collapsed"
            animate="open"
            exit="collapsed"
            style={{ overflow: 'hidden' }}
          >
            <Container layout="vertical" gap="xs" padding="sm">
              {entries.map((entry, entryIndex) => {
                const toolUse = entry.message.toolUse;
                if (!toolUse) return null;
                const isEntryStreaming =
                  isStreaming
                  && entryIndex === entries.length - 1
                  && entry.message.type === 'tool_use'
                  && !toolUse.result;

                return (
                  <ToolUseBlock
                    key={entry.message.id ?? `tool-${entry.messageIndex}`}
                    toolUse={toolUse}
                    defaultOpen={false}
                    durationMs={entry.message.durationMs}
                    usage={entry.message.usage}
                    isStreaming={isEntryStreaming}
                    placeableSurfaceCatalog={placeableSurfaceCatalog}
                    surfaceIntentDestinationRef={surfaceIntentDestinationRef}
                  />
                );
              })}
            </Container>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

interface VirtualRowProps {
  item: RenderItem;
  rowIndex: number;
  totalRows: number;
  isStreaming: boolean;
  measureRef: (el: Element | null) => void;
  top: number;
}

// ---------------------------------------------------------------------------
// UNIFIED TRANSCRIPT RENDERER (#41 / contract §9.5)
// ---------------------------------------------------------------------------
//
// ONE dispatch surface for every transcript row — people-bubbles, agent-bubbles,
// and grouped tool-use activity lines. The row's kind is a SELF-DESCRIBING DATA
// discriminant derived from the item (transcriptRowKind); the renderer body is a
// capability-map lookup, NOT an if/switch chain. This satisfies the package UI
// reference-lock Generic gate §7 ("no `if (kind===)` / `switch(kind)` in the
// panel") and L090 (self-describing data → generic handler).
//
// Adding a new row kind (e.g. the Plain/Replit "Checkpoint made" / "Priority set"
// system-event line in the contract §2 anatomy) is TWO data edits: emit the kind
// from buildRenderItems, register its leaf here. The dispatch body and the call
// site (VirtualRow → renderRowContent) never change. The leaves stay composed,
// never absorbed — ChatMessage / AgentActivityRenderer / ToolGroupBlock keep
// owning their own rendering (L100 / L107).
type TranscriptRowKind = string;

interface TranscriptRowContext {
  item: RenderItem;
  isLastRow: boolean;
  isStreaming: boolean;
  /** Viewer-intent bundle threaded to the annotation-bearing leaves. */
  intent: MessageIntentBundle;
}

/** Derive the self-describing row discriminant from the item DATA. */
export function transcriptRowKind(item: RenderItem): TranscriptRowKind {
  if (item.kind === 'tool_group') return 'tool_group';
  return item.message.role === 'human' ? 'human' : 'agent';
}

/** kind → leaf renderer. The ONLY place new row kinds bind to a leaf. */
const TRANSCRIPT_ROW_RENDERERS: Record<
  TranscriptRowKind,
  (ctx: TranscriptRowContext) => React.ReactNode
> = {
  tool_group: ({ item, isLastRow, isStreaming, intent }) =>
    item.kind === 'tool_group' ? (
      <ToolGroupBlock
        entries={item.entries}
        isStreaming={isStreaming && isLastRow}
        placeableSurfaceCatalog={intent.placeableSurfaceCatalog}
        surfaceIntentDestinationRef={intent.surfaceIntentDestinationRef}
      />
    ) : null,
  human: ({ item, intent }) =>
    item.kind === 'message' ? (
      <ChatMessage
        message={item.message}
        isHuman
        isStreaming={false}
        reactionPalette={intent.reactionPalette}
        messageActions={intent.messageActions}
        onMessageIntent={intent.onMessageIntent}
        onMessagePerform={intent.onMessagePerform}
        placeableSurfaceCatalog={intent.placeableSurfaceCatalog}
      />
    ) : null,
  agent: ({ item, isLastRow, isStreaming, intent }) =>
    item.kind === 'message' ? (
      <AgentActivityRenderer
        message={item.message}
        isLastStreaming={isStreaming && isLastRow}
        mode={isStreaming && isLastRow ? 'streaming' : 'readonly'}
        reactionPalette={intent.reactionPalette}
        messageActions={intent.messageActions}
        onMessageIntent={intent.onMessageIntent}
        onMessagePerform={intent.onMessagePerform}
        placeableSurfaceCatalog={intent.placeableSurfaceCatalog}
        surfaceIntentDestinationRef={intent.surfaceIntentDestinationRef}
      />
    ) : null,
};

function renderRowContent(
  item: RenderItem,
  isLastRow: boolean,
  isStreaming: boolean,
  intent: MessageIntentBundle,
) {
  const renderer =
    TRANSCRIPT_ROW_RENDERERS[transcriptRowKind(item)] ?? TRANSCRIPT_ROW_RENDERERS.agent;
  return renderer({ item, isLastRow, isStreaming, intent });
}

function itemChatIndex(item: RenderItem): number {
  return item.kind === 'tool_group' ? item.lastMessageIndex : item.messageIndex;
}

function messageMutationSignature(message: AgentMessage): string {
  const toolUse = message.toolUse;
  return [
    message.id ?? '',
    message.type,
    message.role ?? '',
    message.content.length,
    toolUse?.id ?? '',
    toolUse?.tool ?? '',
    Object.keys(toolUse?.params ?? {}).length,
    toolUse?.result?.length ?? 0,
  ].join('\u0000');
}

function renderItemMutationSignature(item: RenderItem | undefined): string {
  if (!item) return '';
  if (item.kind === 'message') return messageMutationSignature(item.message);
  return item.entries.map((entry) => messageMutationSignature(entry.message)).join('\u0001');
}

const VirtualRow = React.memo(function VirtualRow({
  item,
  rowIndex,
  totalRows,
  isStreaming,
  measureRef,
  top,
}: VirtualRowProps) {
  const isLastRow = rowIndex === totalRows - 1;
  // Memoization-safe: VirtualRow is React.memo, so the viewer-intent bundle
  // arrives via context (useMemo-stable Provider value) rather than as a row
  // prop that memoization would drop. A row re-renders only when the bundle
  // genuinely changes.
  const intent = React.useContext(MessageIntentContext);

  const rowStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    transform: `translateY(${top}px)`,
    paddingBottom: isLastRow ? 12 : 8,
  };

  return (
    <Container
      ref={measureRef as React.Ref<HTMLDivElement>}
      style={rowStyle}
      padding="none"
      data-index={rowIndex}
      data-chat-virtual-row="true"
      data-chat-index={itemChatIndex(item)}
    >
      {/* Reading column: thread content capped at ~768px and centered
          (reference contract: ChatGPT/Claude main column max-width). Plain
          variant classes only — no width:100% style override, so the
          virtualizer's measureElement sees a stable box and cannot enter a
          measure → resize → re-measure loop. width="full" is a class (not a
          style override) and is REQUIRED: without it the column shrink-wraps
          to content, which visually centers short human pills in the stream
          instead of right-aligning them. */}
      <Container maxWidth="3xl" marginX="auto" width="full" padding="none">
        {renderRowContent(item, isLastRow, isStreaming, intent)}
      </Container>
    </Container>
  );
});

// ---------------------------------------------------------------------------
// SCROLL-TO-BOTTOM PORTAL
// ---------------------------------------------------------------------------

// Offset from the bottom-right corner of the scroll viewport.
const SCROLL_BTN_INSET = 12;

/**
 * Portaled scroll-to-bottom button. Rendered at <body> level via createPortal
 * so that Card variant="popover" (glass-popover) gets correct backdrop-filter
 * compositing against the full page — not the parent glass surface.
 *
 * Position is computed from the scroll container's bounding rect on each render.
 */
function ScrollToBottomPortal({
  scrollRef,
  onClick,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onClick: () => void;
}) {
  const el = scrollRef.current;
  if (!el) return null;

  const rect = el.getBoundingClientRect();

  return createPortal(
    <Card
      variant="popover"
      padding="none"
      style={{
        position: 'fixed',
        bottom: `${window.innerHeight - rect.bottom + SCROLL_BTN_INSET}px`,
        right: `${window.innerWidth - rect.right + SCROLL_BTN_INSET}px`,
        zIndex: 50,
      }}
    >
      <Button variant="ghost" size="icon" radius="inherit" onClick={onClick} aria-label="Scroll to bottom">
        <Icon icon={ChevronDown} size="sm" />
      </Button>
    </Card>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ChatPanel({
  draftScope,
  onTyping,
  sessionId,
  restoreScroll = true,
  messages,
  onSend,
  isStreaming = false,
  inputDisabled = false,
  inputFooter,
  beforeMessages,
  belowInput,
  prefillValue,
  onPrefillConsumed,
  activePreset,
  onPresetDismiss,
  selectedContext,
  onStop,
  inputMode = 'chat',
  reactionPalette,
  messageActions,
  onMessageIntent,
  onMessagePerform,
  placeableSurfaceCatalog = [],
  surfaceIntentDestinationRef = null,
}: ChatPanelProps) {
  // Memoization-safe viewer-intent bundle: stable identity so the virtualized
  // rows (React.memo) re-render only when the palette/actions/handler change,
  // never on every ChatPanel render.
  const messageIntentBundle = useMemo<MessageIntentBundle>(
    () => ({
      reactionPalette,
      messageActions,
      onMessageIntent,
      onMessagePerform,
      placeableSurfaceCatalog,
      surfaceIntentDestinationRef,
    }),
    [reactionPalette, messageActions, onMessageIntent, onMessagePerform, placeableSurfaceCatalog, surfaceIntentDestinationRef],
  );
  // Scroll container ref — must be the element with overflow-y-auto
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether auto-scroll is enabled (true = user is near bottom)
  const shouldScrollRef = useRef(true);
  // Track whether to show the scroll-to-bottom button
  const [showScrollButton, setShowScrollButton] = useState(false);
  // Prevent duplicate restore work for the same session during a render burst.
  const restoredSessionRef = useRef<string | null>(null);
  const renderItems = useMemo(() => buildRenderItems(messages), [messages]);
  const tailMutationSignature = renderItemMutationSignature(renderItems[renderItems.length - 1]);

  const virtualizer = useVirtualizer({
    count: renderItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = renderItems[index];
      if (!item) return 48;
      if (item.kind === 'tool_group') return 44;
      return estimateMessageHeight(item.message);
    },
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const scrollToLatestMessage = useCallback(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0 || renderItems.length === 0) return;

    const lastRenderIndex = renderItems.length - 1;
    let raf1 = 0;
    let raf2 = 0;
    let cancelled = false;

    const anchor = () => {
      if (cancelled) return;
      virtualizer.scrollToIndex(lastRenderIndex, { align: 'end' });
      raf2 = requestAnimationFrame(() => {
        if (!cancelled) el.scrollTop = bottomAlignedScrollTop(el.scrollHeight, el.clientHeight);
      });
    };

    raf1 = requestAnimationFrame(anchor);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [messages.length, renderItems.length, virtualizer]);

  const rememberScrollState = useCallback(() => {
    if (!sessionId) return;
    const el = scrollRef.current;
    if (!el) return;
    savedScrollTopBySession.set(sessionId, el.scrollTop);
    savedAutoScrollBySession.set(
      sessionId,
      shouldAutoScroll(el.scrollTop, el.scrollHeight, el.clientHeight),
    );
  }, [sessionId]);

  // Reset scroll policy on session switch.
  useEffect(() => {
    const savedAuto = restoreScroll && sessionId ? savedAutoScrollBySession.get(sessionId) : undefined;
    shouldScrollRef.current = savedAuto ?? true;
    setShowScrollButton(savedAuto === false && messages.length > 0);
    restoredSessionRef.current = null;
  }, [sessionId, restoreScroll]);

  // Restore previous scroll position when returning to a session.
  useLayoutEffect(() => {
    if (!restoreScroll || !sessionId || messages.length === 0) return;
    if (restoredSessionRef.current === sessionId) return;

    const savedTop = savedScrollTopBySession.get(sessionId);
    if (savedTop === undefined) {
      restoredSessionRef.current = sessionId;
      return;
    }

    const el = scrollRef.current;
    if (!el) return;

    const restore = () => {
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.min(savedTop, maxScrollTop);
      const atBottom = shouldAutoScroll(el.scrollTop, el.scrollHeight, el.clientHeight);
      shouldScrollRef.current = atBottom;
      setShowScrollButton(!atBottom && messages.length > 0);
    };

    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      restore();
      raf2 = requestAnimationFrame(restore);
    });
    restoredSessionRef.current = sessionId;

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [messages.length, sessionId, totalSize, restoreScroll]);

  // Auto-scroll only when message list identity changes (new message/session).
  // Do not tie this to totalSize changes: expand/collapse interactions also
  // change totalSize and should never force a jump to the chat tail.
  useLayoutEffect(() => {
    if (!shouldScrollRef.current || messages.length === 0) return;
    return scrollToLatestMessage();
  }, [messages.length, renderItems.length, sessionId, scrollToLatestMessage]);

  // Streaming can mutate the final row without changing list length. Keep the
  // tail anchored for that same generic auto-scroll contract.
  useLayoutEffect(() => {
    if (!isStreaming || !shouldScrollRef.current || messages.length === 0) return;
    return scrollToLatestMessage();
  }, [isStreaming, messages.length, scrollToLatestMessage, tailMutationSignature]);

  // Track scroll position to toggle auto-scroll and scroll-to-bottom button
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const atBottom = shouldAutoScroll(scrollTop, scrollHeight, clientHeight);
    shouldScrollRef.current = atBottom;
    setShowScrollButton(!atBottom && messages.length > 0);
    rememberScrollState();
  }, [messages.length, rememberScrollState]);

  // Save position when the component unmounts or session changes.
  useEffect(() => {
    return () => {
      rememberScrollState();
    };
  }, [rememberScrollState]);

  // Scroll-to-bottom button handler — re-enables auto-scroll
  const scrollToBottom = useCallback(() => {
    shouldScrollRef.current = true;
    setShowScrollButton(false);
    const dispose = scrollToLatestMessage();
    // Keep return value explicit for lint clarity even though onClick ignores it.
    void dispose;
  }, [scrollToLatestMessage]);

  const hasMessages = messages.length > 0;

  return (
    <MessageIntentContext.Provider value={messageIntentBundle}>
    <Card variant="nested" padding="none" layout="column" flex={1} minHeight="0" height="full" className="overflow-hidden">
      {hasMessages && beforeMessages ? <Container padding="sm" style={{ flexShrink: 0 }}>{beforeMessages}</Container> : null}
      {/* Message list or empty state */}
      {hasMessages ? (
        <Container position="relative" flex={1} minHeight="0" overflow="hidden">
          {/* Scroll viewport */}
          <Container
            ref={scrollRef}
            onScroll={handleScroll}
            layout="vertical"
            padding="md"
            overflow="y-auto"
            height="full"
            minHeight="0"
            data-chat-scroll-viewport="true"
          >
            {/* Total height spacer — virtualizer positions rows absolutely inside */}
            <Container
              layout="vertical"
              padding="none"
              gap="none"
              style={{ ...VIRTUAL_LIST_STYLE, height: totalSize }}
            >
              {virtualItems.map((virtualRow) => {
                const item = renderItems[virtualRow.index];
                if (!item) return null;

                return (
                  <VirtualRow
                    key={virtualRow.key}
                    item={item}
                    rowIndex={virtualRow.index}
                    totalRows={renderItems.length}
                    isStreaming={isStreaming}
                    measureRef={virtualizer.measureElement}
                    top={virtualRow.start}
                  />
                );
              })}
            </Container>
          </Container>

          {/* Scroll-to-bottom button — portaled to <body> so glass-popover
              backdrop-filter composites against the full page, not the parent
              glass container. Position: fixed relative to scroll viewport. */}
          {showScrollButton && <ScrollToBottomPortal scrollRef={scrollRef} onClick={scrollToBottom} />}
        </Container>
      ) : (
        <EmptyState mode={inputMode} />
      )}

      {/* Input area — composer rides the same centered reading column as the
          thread (contract: ChatGPT sticky composer aligned to 768px column). */}
      <Container layout="vertical" gap="none" padding="md" style={{ paddingTop: 'var(--spacing-sm)' }}>
        <Container maxWidth="3xl" marginX="auto" width="full" padding="none">
          <ChatComposer
            draftScope={draftScope}
            onTyping={onTyping}
            onSend={onSend}
            onStop={onStop}
            disabled={inputDisabled}
            isStreaming={isStreaming}
            footer={inputFooter}
            prefillValue={prefillValue}
            onPrefillConsumed={onPrefillConsumed}
            activePreset={activePreset}
            onPresetDismiss={onPresetDismiss}
            selectedContext={selectedContext}
            inputMode={inputMode}
          />
        </Container>
      </Container>
      {belowInput && (
        <Container padding="md">
          {belowInput}
        </Container>
      )}
    </Card>
    </MessageIntentContext.Provider>
  );
}
