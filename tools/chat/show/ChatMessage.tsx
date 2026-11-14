// PORTED FROM: bitfield-packages/packages/chat/show/ChatMessage.tsx @ e99ac5976
// bitfield-studio/packages/chat/show/ChatMessage.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders a single chat message — human or agent. Human messages are right-
// aligned rounded pills (reference contract: ChatGPT user pill, radius 24px,
// subtle accent tint, no sender chrome). Agent messages are left-aligned
// full-width flat rows and support markdown rendering, code blocks, and
// streaming indicators.
//
// Reference-Grounded Screen Contract:
// .claude/ai-orchestra/projects/packages-and-package-sets/chat/
//   reference-grounded-screen-contract.md
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Human messages: right-aligned pill (Card variant="bubble" — solid neutral
//    fill, no border), capped width, NO "You"/"Agent" header label — alignment
//    and fill carry authorship (ChatGPT/Claude/Cursor references all do this;
//    none of them outline the user bubble).
// 2. Agent messages: left-aligned full-width flat row, no bubble.
// 3. Markdown rendered via MarkdownContent component with Shiki highlighting.
// 4. Streaming messages show animated typing indicator.
// 5. Glassmorphism tokens only — no gray-* colors.
// 6. Timestamp + copy are hover-revealed via the ui HoverReveal primitives
//    (12px tertiary, below the message) — never permanent chrome.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { memo, useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { formatTimestamp } from './chat-logic';
import { sourceBaseOf } from '../../ui/show/clipboard/answer-copy.mjs';
import { copyAnswerToClipboard } from '../../ui/show/clipboard/copy-answer';
import MarkdownContent from './MarkdownContent';
import { MessageAnnotations } from './MessageAnnotations';
import { MessageLinks } from './MessageLinks';
import type {
  AgentMessage,
  ReactionPaletteEntry,
  MessageActionDescriptor,
  MessageIntent,
  MessagePerformHandler,
} from '../read-data/chat-message-types';
import {
  Button,
  Card,
  Container,
  HoverRevealGroup,
  HoverRevealItem,
  Icon,
  StatusDot,
  Text,
  KeptFiles,
} from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ChatMessageProps {
  /** The message to render */
  message: AgentMessage;
  /** Whether this message is from the human user */
  isHuman: boolean;
  /** Whether this message is currently streaming */
  isStreaming?: boolean;
  /**
   * DATA-driven reaction symbols the viewer may author on this message. The bar
   * renders exactly these rows — the surface enumerates no symbol in code, so a
   * new reaction is one data row (L090). Absent/empty -> no reaction affordance.
   */
  reactionPalette?: ReactionPaletteEntry[];
  /**
   * DATA-driven non-reaction annotations (pin, star, bookmark, ...) that ride the
   * SAME onMessageIntent path. Each is one data row; the surface names none.
   */
  messageActions?: MessageActionDescriptor[];
  /**
   * Handed a viewer-authored intent when the viewer taps a reaction/action. The
   * surface writes it to the durable intent ledger optimistically. Absent -> the
   * message is read-only (no affordance shown) — fail-closed.
   */
  onMessageIntent?: (intent: MessageIntent) => void;
  /** Owner-verified work-control sink supplied by the containing chat view. */
  onMessagePerform?: MessagePerformHandler;
}

// ---------------------------------------------------------------------------
// TYPING INDICATOR
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <Container layout="horizontal" alignItems="center" gap="xs" padding="xs">
      <StatusDot status="idle" pulse />
      <StatusDot status="idle" pulse />
      <StatusDot status="idle" pulse />
    </Container>
  );
}

// ---------------------------------------------------------------------------
// HOVER META ROW (timestamp + copy)
// ---------------------------------------------------------------------------

function MessageMetaRow({
  alignEnd,
  timestamp,
  copied,
  onCopy,
}: {
  alignEnd: boolean;
  timestamp: AgentMessage['timestamp'];
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <HoverRevealItem>
      <Container
        layout="horizontal"
        alignItems="center"
        justifyContent={alignEnd ? 'end' : 'start'}
        gap="xs"
        padding="none"
      >
        <Text variant="caption" color="ghost">
          {formatTimestamp(timestamp)}
        </Text>
        <Button
          variant="ghost"
          size="icon"
          onClick={onCopy}
          title="Copy message"
          aria-label="Copy message"
        >
          <Icon icon={copied ? Check : Copy} size="xs" color={copied ? 'success' : 'faint'} />
        </Button>
      </Container>
    </HoverRevealItem>
  );
}

// ---------------------------------------------------------------------------
// MESSAGE-STATE ENVELOPE RENDER
// ---------------------------------------------------------------------------
//
// The reaction cluster, the hover-revealed authoring bar, and the fail-closed
// lifecycle caption are the SAME stack rendered beneath every message leaf. They
// live in ONE shared component — MessageAnnotations — so the OTHER person's
// incoming bubble (rendered by AgentActivityRenderer, not this file) carries the
// identical affordance. See show/MessageAnnotations.tsx for the full envelope
// documentation (L090 blind display, provenance-as-number, fail-closed egress).

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export const ChatMessage = memo(function ChatMessage({
  message,
  isHuman,
  isStreaming = false,
  reactionPalette,
  messageActions,
  onMessageIntent,
  onMessagePerform,
}: ChatMessageProps) {
  const isEmpty = !message.content.trim();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!message.content) return;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    };
    // An answer about a recording or file keeps its sources: each time citation copies as a link that opens the source at that second.
    const base = sourceBaseOf(message);
    if (base) {
      void copyAnswerToClipboard(message.content, { base }).then(copiedOk => { if (copiedOk) done(); });
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(message.content).then(done).catch(() => {
      // Clipboard may be unavailable in sandboxed contexts.
    });
  }, [message]);

  if (isHuman) {
    return (
      <HoverRevealGroup layout="vertical" gap="none" width="full" padding="none">
        <Container
          layout="horizontal"
          justifyContent="end"
          width="full"
          padding="none"
        >
          {/* User pill: 24px radius, solid neutral fill, NO border, capped width —
              authorship by alignment + fill, zero header chrome (reference:
              ChatGPT user pill — solid #303030-class surface, no outline ring;
              Claude/Cursor user rows likewise never outline the bubble). */}
          <Container maxWidth="2xl" padding="none">
            <Card variant="bubble" padding="md">
              <MarkdownContent content={message.content} mentions={message.mentions} />
            </Card>
          </Container>
        </Container>
        {message.files?.length ? <KeptFiles files={message.files} openLabel="Open file" onOpen={file => window.open(file.url, '_blank', 'noopener,noreferrer')} /> : null}
        {message.links?.length ? <MessageLinks links={message.links} /> : null}
        <MessageAnnotations
          message={message}
          alignEnd
          reactionPalette={reactionPalette}
          messageActions={messageActions}
          onMessageIntent={onMessageIntent}
          onMessagePerform={onMessagePerform}
        />
        {!isEmpty && (
          <MessageMetaRow alignEnd timestamp={message.timestamp} copied={copied} onCopy={handleCopy} />
        )}
      </HoverRevealGroup>
    );
  }

  // Agent: full-width flat row, no bubble (contract: assistant flat rows).
  return (
    <HoverRevealGroup layout="vertical" gap="none" width="full" padding="none">
      {isEmpty && isStreaming ? (
        <TypingIndicator />
      ) : (
        <MarkdownContent content={message.content} mentions={message.mentions} />
      )}
      {message.files?.length ? <KeptFiles files={message.files} openLabel="Open file" onOpen={file => window.open(file.url, '_blank', 'noopener,noreferrer')} /> : null}
      {message.links?.length ? <MessageLinks links={message.links} /> : null}
      {isStreaming && !isEmpty && (
        <Container padding="xs">
          <TypingIndicator />
        </Container>
      )}
      <MessageAnnotations
        message={message}
        alignEnd={false}
        reactionPalette={reactionPalette}
        messageActions={messageActions}
        onMessageIntent={onMessageIntent}
        onMessagePerform={onMessagePerform}
      />
      {!isEmpty && (
        <MessageMetaRow alignEnd={false} timestamp={message.timestamp} copied={copied} onCopy={handleCopy} />
      )}
    </HoverRevealGroup>
  );
});
