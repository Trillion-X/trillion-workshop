// packages/group/show/BoardCommentsLayer.tsx
//
// The product surface for the anchored-thread primitive (read-data/board-comments): a comment PIN on
// every item that has an open thread, and a thread POPOVER (entries + an input to reply + Resolve) for
// the selected pin. Generic + DATA-driven — it renders whatever pins/thread it is handed and never
// names a specific item; the mounting surface resolves each anchor to a screen rect and owns the
// selection + draft state (same contract as WalkthroughOverlay). L065: ui components only; the pin is a
// positioned Container because its coordinate is dynamic (like the walkthrough spotlight ring).

import { Button, Card, Container, Input, Text } from '../../ui/index.ts';
import type { CommentThread, ThreadSummary } from '../read-data/board-comments.ts';
import { controlShown, useShowChange } from '../../ui/show/show-rules/show-of';

export interface CommentAnchorRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One pin to draw: an anchor's screen rect + its thread summary (count drives the badge). */
export interface CommentPin {
  readonly anchorId: string;
  readonly rect: CommentAnchorRect;
  readonly summary: ThreadSummary;
}

export interface BoardCommentsLayerProps {
  /** Pins to render (one per OPEN thread). */
  readonly pins: readonly CommentPin[];
  /** The anchor whose thread popover is open (null = none). */
  readonly selectedAnchorId?: string | null;
  /** The selected anchor's screen rect (where the popover mounts). */
  readonly selectedRect?: CommentAnchorRect | null;
  /** The full thread for the open popover (all entries, resolved flag). */
  readonly selectedThread?: CommentThread | null;
  /** The in-progress reply text (owned by the mount). */
  readonly draft: string;
  readonly onSelectPin: (anchorId: string | null) => void;
  readonly onDraftChange: (value: string) => void;
  /** Commit the draft as a new comment on the selected anchor. */
  readonly onAddComment: () => void;
  /** Resolve (or reopen) the selected thread. */
  readonly onToggleResolved: (resolved: boolean) => void;
  /** Format an entry timestamp for display (default: locale time). */
  readonly formatTime?: (at: number) => string;
}

function defaultTime(at: number): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function BoardCommentsLayer({
  pins,
  selectedAnchorId,
  selectedRect,
  selectedThread,
  draft,
  onSelectPin,
  onDraftChange,
  onAddComment,
  onToggleResolved,
  formatTime = defaultTime,
}: BoardCommentsLayerProps): JSX.Element | null {
  useShowChange();
  if (!controlShown('comments')) return null;
  return (
    <>
      {/* One pin per open thread — a small count badge at the anchor's top-right corner. */}
      {pins.map((pin) => (
        <Container
          key={pin.anchorId}
          position="absolute"
          style={{ left: pin.rect.x + pin.rect.w - 10, top: pin.rect.y - 10, zIndex: 56 }}
        >
          <Button
            variant={pin.anchorId === selectedAnchorId ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => onSelectPin(pin.anchorId === selectedAnchorId ? null : pin.anchorId)}
            aria-label={`Comments on ${pin.anchorId} (${pin.summary.count})`}
          >
            {`\u{1F4AC} ${pin.summary.count}`}
          </Button>
        </Container>
      ))}

      {/* The thread popover for the selected pin. */}
      {selectedAnchorId && selectedRect && selectedThread ? (
        <Container
          position="absolute"
          style={{ left: selectedRect.x + selectedRect.w + 12, top: selectedRect.y, maxWidth: 300, zIndex: 60 }}
        >
          <Card variant="popover" padding="md">
            <Container layout="vertical" gap="sm">
              <Container layout="horizontal" gap="sm" alignItems="center">
                <Text variant="body-md" weight="semibold">Comments</Text>
                <Text variant="body-sm" tone="muted">{`${selectedThread.entries.length}`}</Text>
              </Container>

              {selectedThread.entries.length === 0 ? (
                <Text variant="body-sm" tone="muted">No comments yet. Start the thread.</Text>
              ) : (
                selectedThread.entries.map((e) => (
                  <Container key={e.id} layout="vertical" gap="xs">
                    <Container layout="horizontal" gap="sm" alignItems="center">
                      <Text variant="body-sm" weight="semibold">{e.author}</Text>
                      <Text variant="caption" tone="muted">{formatTime(e.at)}</Text>
                    </Container>
                    <Text variant="body-sm">{e.text}</Text>
                  </Container>
                ))
              )}

              <Input
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                placeholder="Write a comment"
                aria-label="Write a comment"
              />
              <Container layout="horizontal" gap="sm" alignItems="center">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={onAddComment}
                  disabled={draft.trim() === ''}
                  aria-label="Add comment"
                >
                  Comment
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onToggleResolved(!selectedThread.resolved)}
                  aria-label={selectedThread.resolved ? 'Reopen thread' : 'Resolve thread'}
                >
                  {selectedThread.resolved ? 'Reopen' : 'Resolve'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onSelectPin(null)} aria-label="Close comments">
                  Close
                </Button>
              </Container>
            </Container>
          </Card>
        </Container>
      ) : null}
    </>
  );
}
