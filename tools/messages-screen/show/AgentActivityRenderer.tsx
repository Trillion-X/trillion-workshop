// PORTED FROM: bitfield-packages/packages/chat/show/AgentActivityRenderer.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/AgentActivityRenderer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// L069 primitive: renders any AgentMessage with rich structured formatting.
// Dispatches by message type — text renders as markdown, tool_use renders as
// collapsible ToolUseBlock, thinking renders as collapsible ThinkingBlock,
// error renders as ErrorBlock, status renders as status indicator.
//
// This is the SINGLE component that knows how to render agent output across
// ALL views: live chat, session history, agent detail panels. Configure via
// the `mode` prop for streaming (live) vs read-only (history) behavior.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ONE component renders ALL AgentMessage types — no per-view dispatch logic
// 2. ALL styling through ui/ component props only — zero raw HTML, zero className
// 3. Import ONLY from @/packages/ui barrel — never relative ../../ui paths
// 4. Human messages must NEVER be passed here — ChatMessage handles human
// 5. ToolUseBlock handles tool_use + tool_result — do not duplicate that logic
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { memo, useCallback, useState } from 'react';
import { lazyPart } from '../../ui/show/load-later/later';
import { AlertCircle, Copy, Check } from 'lucide-react';
import type {
  AgentMessage,
  ReactionPaletteEntry,
  MessageActionDescriptor,
  MessageIntent,
  MessagePerformHandler,
} from '../read-data/chat-message-types';
import { Card, Badge, Button, Icon, Text, Container, StatusDot, KeptFiles } from '../../ui';
import type { PlaceableSurfacePayload } from '../../ui/show/placeable-surface-intent';
import { ToolUseBlock } from './ToolUseBlock';
import { MessageAnnotations } from './MessageAnnotations';
import MarkdownContent from './MarkdownContent';
// A screen an answer carries is fetched the first time an answer carries one, never with every chat.
const ChatInlinePlaceableSurface = lazyPart(() => import('./ChatInlinePlaceableSurface'), module => module.ChatInlinePlaceableSurface);
import { formatTimestamp } from './chat-logic';
import { isCompactionSummaryContent } from '../read-data/compaction-detection';
import { splitChatPlaceableSurfaceSegments } from '../read-data/read-chat-placeable-surface-segments';
import { plainChatError } from './ChatErrorBanner';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/** Controls rendering mode for context-specific behavior. */
export type ActivityRenderMode =
  /** Live streaming — show streaming indicator on last item */
  | 'streaming'
  /** Full session — all items complete, no streaming indicator */
  | 'readonly';

export interface AgentActivityRendererProps {
  /** Single agent message to render */
  message: AgentMessage;
  /** Whether this is the last message in a streaming session */
  isLastStreaming?: boolean;
  /** Rendering mode (default: readonly) */
  mode?: ActivityRenderMode;
  /**
   * DATA-driven reaction symbols the viewer may author on this message. Threaded
   * through to the shared MessageAnnotations stack so the OTHER person's incoming
   * bubble (rendered here, not by ChatMessage) carries the same tapback bar.
   * Absent/empty -> no reaction affordance (fail-closed).
   */
  reactionPalette?: ReactionPaletteEntry[];
  /** DATA-driven non-reaction annotations (pin/star/...) on the SAME intent path. */
  messageActions?: MessageActionDescriptor[];
  /**
   * Viewer-intent sink. The action bar self-suppresses unless BOTH this and the
   * message's atomRef are present, so agent/tool/thinking rows (no atomRef) never
   * show an affordance — only real conversation subjects do.
   */
  onMessageIntent?: (intent: MessageIntent) => void;
  /** Owner-verified work-control sink supplied by the containing chat view. */
  onMessagePerform?: MessagePerformHandler;
  /** Studio-owned catalog passed through the transcript row context. */
  placeableSurfaceCatalog?: readonly PlaceableSurfacePayload[];
  /** Opaque active presentation owner supplied by the containing workspace. */
  surfaceIntentDestinationRef?: string | null;
}

// ---------------------------------------------------------------------------
// PRIVATE WORK EVENTS
// ---------------------------------------------------------------------------

// Thinking and context-management records remain private at their source. They
// are deliberately omitted from product Chat rather than renamed or summarized.

// ---------------------------------------------------------------------------
// ERROR BLOCK
// ---------------------------------------------------------------------------

/**
 * Error message with red-tinted treatment and AlertCircle icon.
 * Always fully visible (no collapse) so errors are never hidden.
 */
function ErrorBlock({ content, timestamp }: { content: string; timestamp: string }) {
  return (
    <Card variant="error" padding="sm" layout="row">
      <Icon icon={AlertCircle} size="sm" color="error" />
      <Container layout="vertical" gap="xs" flex={1}>
        <Text variant="body-xs" color="error" wrap="preserve">
          {plainChatError(content)}
        </Text>
        <Text variant="caption" color="faint">
          {formatTimestamp(timestamp)}
        </Text>
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// STATUS BLOCK
// ---------------------------------------------------------------------------

/**
 * Status indicator (e.g., "idle", "processing"). Rendered as a muted pill
 * centred in the message stream — informational only, not expandable.
 */
function StatusBlock({ content }: { content: string }) {
  const normalized = content.trim().toLowerCase();
  const visible = normalized === 'done' || normalized === 'complete' || normalized === 'completed'
    ? 'Done'
    : normalized === 'failed' || normalized === 'error'
      ? 'Something went wrong'
      : 'Your assistant is working';
  return (
    <Container layout="horizontal" justifyContent="center" padding="xs">
      <Badge variant="muted" size="sm">
        {visible}
      </Badge>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// STREAMING INDICATOR
// ---------------------------------------------------------------------------

/**
 * Three-dot animated streaming indicator shown while the session is actively
 * producing output. Uses three pulsing StatusDot components in a row.
 */
function StreamingIndicator() {
  return (
    <Container layout="horizontal" gap="xs" alignItems="center" padding="xs">
      <StatusDot status="idle" size="sm" pulse />
      <StatusDot status="idle" size="sm" pulse />
      <StatusDot status="idle" size="sm" pulse />
    </Container>
  );
}

function AgentTextContent({ content, mentions }: { content: string; mentions?: AgentMessage['mentions'] }) {
  const segments = React.useMemo(() => splitChatPlaceableSurfaceSegments(content), [content]);
  if (segments.length === 1 && segments[0]?.kind === 'text') {
    return <MarkdownContent content={segments[0].content} mentions={mentions} />;
  }

  return (
    <Container layout="vertical" gap="sm" padding="none" className="min-w-0 max-w-full">
      {segments.map((segment, index) => (
        segment.kind === 'text'
          ? <MarkdownContent key={`text:${index}`} content={segment.content} mentions={mentions} />
          : <React.Suspense key={`surface:${index}:${segment.payload.id ?? segment.payload.materialTarget ?? 'surface'}`} fallback={null}><ChatInlinePlaceableSurface payload={segment.payload} /></React.Suspense>
      ))}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// MAIN COMPONENT
// ---------------------------------------------------------------------------

/**
 * AgentActivityRenderer — the L069 primitive for rendering agent output.
 *
 * Dispatches a single AgentMessage to the correct renderer based on type:
 * - `text`        → MarkdownContent (full markdown + Shiki highlighting)
 * - `tool_use`    → ToolUseBlock (collapsible, icon + name + params + result)
 * - `tool_result` → ToolUseBlock (result view, collapsed by default)
 * - `thinking`    → ThinkingBlock (collapsible, Brain icon + preview)
 * - `error`       → ErrorBlock (red-tinted, always visible)
 * - `status`      → StatusBlock (muted pill, informational)
 *
 * Use this component everywhere agent output is displayed. The `mode` prop
 * controls streaming-specific behaviour (streaming indicator on last item).
 */
export const AgentActivityRenderer = memo(function AgentActivityRenderer({
  message,
  isLastStreaming = false,
  mode = 'readonly',
  reactionPalette,
  messageActions,
  onMessageIntent,
  onMessagePerform,
  placeableSurfaceCatalog,
  surfaceIntentDestinationRef,
}: AgentActivityRendererProps) {
  const isStreaming = mode === 'streaming' && isLastStreaming;
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard || !message.content) return;
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {
      // Clipboard unavailable.
    });
  }, [message.content]);

  switch (message.type) {
    case 'text': {
      if (isCompactionSummaryContent(message.content)) {
        return null;
      }

      const isEmpty = !message.content.trim();
      return (
        <Container layout="vertical" gap="xs" className="min-w-0 max-w-full">
          {/* Who said it, above the words, when it is someone other than the viewer or this conversation's own AI
              (a teammate heard nearby, an email's sender, another member of a space), as group chats name a sender. */}
          {message.author ? <Text variant="caption" color="muted">{message.author}</Text> : null}
          {!isEmpty && (
            <Container layout="horizontal" gap="xs" alignItems="start" padding="none" className="min-w-0 max-w-full">
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopy}
                title="Copy message"
                aria-label="Copy message"
              >
                <Icon icon={copied ? Check : Copy} size="xs" color={copied ? 'success' : 'ghost'} />
              </Button>
              <Container flex={1} minHeight="0" padding="none" className="min-w-0 max-w-full">
                <AgentTextContent content={message.content} mentions={message.mentions} />
              </Container>
            </Container>
          )}
          {message.files?.length ? <KeptFiles files={message.files} openLabel="Open file" onOpen={file => window.open(file.url, '_blank', 'noopener,noreferrer')} /> : null}
          {/* The SAME annotation stack ChatMessage renders — folded reactions, the
              hover-revealed tapback bar, and the fail-closed lifecycle caption.
              The bar self-suppresses unless the message has an atomRef (a durable
              conversation subject), so streaming AI text and teammate output show
              NO affordance while the other person's incoming iMessage bubble —
              the PRIMARY react target — finally does. Left-aligned (incoming). */}
          <MessageAnnotations
            message={message}
            alignEnd={false}
            reactionPalette={reactionPalette}
            messageActions={messageActions}
            onMessageIntent={onMessageIntent}
            onMessagePerform={onMessagePerform}
          />
          {isStreaming && <StreamingIndicator />}
        </Container>
      );
    }

    case 'tool_use':
    case 'tool_result': {
      if (!message.toolUse) {
        return null;
      }
      // tool_use without a result is in-progress — show streaming/collapsed state
      const toolIsStreaming = message.type === 'tool_use' && !message.toolUse.result && isStreaming;
      return (
        <ToolUseBlock
          toolUse={message.toolUse}
          defaultOpen={false}
          durationMs={message.durationMs}
          usage={message.usage}
          isStreaming={toolIsStreaming}
          placeableSurfaceCatalog={placeableSurfaceCatalog}
          surfaceIntentDestinationRef={surfaceIntentDestinationRef}
        />
      );
    }

    case 'thinking': {
      return null;
    }

    case 'error': {
      return <ErrorBlock content={message.content} timestamp={message.timestamp} />;
    }

    case 'status': {
      return <StatusBlock content={message.content} />;
    }

    default: {
      return null;
    }
  }
});
