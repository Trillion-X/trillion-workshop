import * as React from 'react';

interface FeedbackParticipant {
  message: string;
  sequence: number;
  update: (snapshot: ReorderFeedbackSnapshot) => void;
}

interface FeedbackChannel {
  participants: Map<symbol, FeedbackParticipant>;
  movingLabel: string;
  sequence: number;
}

interface ReorderFeedbackSnapshot {
  isOwner: boolean;
  message: string;
}

interface PublishOptions {
  movingLabel?: string;
}

const EMPTY_SNAPSHOT: ReorderFeedbackSnapshot = {
  isOwner: false,
  message: '',
};

const channels = new WeakMap<Element, FeedbackChannel>();

function surfaceFor(element: HTMLElement): Element {
  return element.closest(
    '[data-reorder-surface], [data-reorder-list], [role="grid"], table, [role="list"]',
  ) ?? element.parentElement ?? element;
}

function channelFor(element: HTMLElement): FeedbackChannel {
  const surface = surfaceFor(element);
  const existing = channels.get(surface);
  if (existing) return existing;
  const channel: FeedbackChannel = {
    participants: new Map(),
    movingLabel: 'item',
    sequence: 0,
  };
  channels.set(surface, channel);
  return channel;
}

function notify(channel: FeedbackChannel) {
  const owner = channel.participants.keys().next().value as symbol | undefined;
  let message = '';
  let sequence = -1;
  for (const participant of channel.participants.values()) {
    if (participant.message && participant.sequence > sequence) {
      message = participant.message;
      sequence = participant.sequence;
    }
  }
  for (const [token, participant] of channel.participants) {
    participant.update({
      isOwner: token === owner,
      message,
    });
  }
}

export function moveTargetMessage(
  movedLabel: string,
  beforeLabel: string | null,
): string {
  return beforeLabel === null
    ? `Move ${movedLabel} to end`
    : `Move ${movedLabel} before ${beforeLabel}`;
}

/**
 * Joins sibling reorder controls and indicators through their rendered surface.
 * One participant owns the live region; every participant can publish to it.
 */
export function useReorderFeedback(
  elementRef: React.RefObject<HTMLElement | null>,
) {
  const token = React.useRef(Symbol('reorder-feedback-participant'));
  const channelRef = React.useRef<FeedbackChannel | null>(null);
  const [snapshot, setSnapshot] = React.useState(EMPTY_SNAPSHOT);

  React.useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    const channel = channelFor(element);
    channelRef.current = channel;
    channel.participants.set(token.current, {
      message: '',
      sequence: 0,
      update: setSnapshot,
    });
    notify(channel);
    return () => {
      channel.participants.delete(token.current);
      channelRef.current = null;
      notify(channel);
    };
  }, [elementRef]);

  const publish = React.useCallback((
    message: string,
    options: PublishOptions = {},
  ) => {
    const channel = channelRef.current;
    if (!channel) return;
    if (options.movingLabel) channel.movingLabel = options.movingLabel;
    const participant = channel.participants.get(token.current);
    if (!participant) return;
    channel.sequence += 1;
    participant.message = message;
    participant.sequence = channel.sequence;
    notify(channel);
  }, []);

  const publishPlacement = React.useCallback((beforeLabel: string | null) => {
    const channel = channelRef.current;
    if (!channel) return;
    publish(moveTargetMessage(channel.movingLabel, beforeLabel));
  }, [publish]);

  return {
    ...snapshot,
    publish,
    publishPlacement,
  };
}
