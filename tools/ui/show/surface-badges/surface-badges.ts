// packages/ui/show/surface-badges/surface-badges.ts
//
// PURPOSE
// Live badges by channel. An owner publishes a short value on a named channel
// (the notification center publishes its unread count on
// `notifications:unread`); any navigation row whose surface DATA names that
// channel in `badge_source` shows it. The sidebar never knows what a channel
// means, and the owner never knows which rows show it.
//
// NON-NEGOTIABLE INVARIANTS
// 1. One channel table per document (globalThis), so separately bundled
//    scripts on one page read and write the same values.
// 2. Publishing an unchanged badge (same text and kind) notifies nobody.
// 3. `null` or an empty text clears the channel; a cleared channel shows no badge.
// 4. A badge says what KIND of thing it counts (`kind`, the publisher's own word:
//    `count` for things that are new, `notification` for unread notifications).
//    A reader looks the kind up in its own DATA to choose how to show it (the
//    sidebar's badge marks); nothing here names a kind.
// 5. A badge may carry a `tone` (a plain tone word: good, attention, bad, info, quiet) for a reader that draws a
//    coloured mark; with none, the reader's own colour stands.

import React from 'react';

type Listener = () => void;
/** One channel's value: the words to show and what kind of thing they count. */
export interface SurfaceBadge {readonly text: string; readonly kind: string; readonly tone?: string}
interface BadgeChannels {values: Map<string, SurfaceBadge>; listeners: Set<Listener>}

const KEY = '__bitfieldSurfaceBadges';

function channels(): BadgeChannels {
  const scope = globalThis as unknown as Record<string, BadgeChannels | undefined>;
  return scope[KEY] ??= {values: new Map(), listeners: new Set()};
}

export function publishSurfaceBadge(channel: string, badge: SurfaceBadge | null): void {
  const table = channels();
  const next = badge?.text ? {text: badge.text, kind: badge.kind, ...(badge.tone ? {tone: badge.tone} : {})} : null;
  const current = table.values.get(channel) ?? null;
  if (current === next || (current && next && current.text === next.text && current.kind === next.kind && current.tone === next.tone)) return;
  if (next === null) table.values.delete(channel);
  else table.values.set(channel, next);
  for (const listener of [...table.listeners]) listener();
}

export function readSurfaceBadge(channel: string): SurfaceBadge | undefined {
  return channels().values.get(channel);
}

export function subscribeSurfaceBadges(listener: Listener): () => void {
  const table = channels();
  table.listeners.add(listener);
  return () => { table.listeners.delete(listener); };
}

/** The current value on `channel`, or undefined when no channel is named or it is clear. */
export function useSurfaceBadge(channel: string | undefined): SurfaceBadge | undefined {
  return React.useSyncExternalStore(
    subscribeSurfaceBadges,
    () => (channel ? readSurfaceBadge(channel) : undefined),
    () => undefined,
  );
}
