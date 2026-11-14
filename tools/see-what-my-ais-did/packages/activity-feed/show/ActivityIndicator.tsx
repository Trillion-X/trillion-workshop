/**
 * ActivityIndicator.tsx — Generic Live Actor Activity Visualization
 *
 * L069 Generative Primitive: Renders activity-fact records with actor_type field.
 * Renders live actor badges on ANY surface. Self-describing DATA (colors, icons, durations)
 * means ZERO new code per new actor type.
 *
 * L090 Integrity: actor_type is an OPEN string, never a closed union. Styling resolves
 * DATA-first — a caller-supplied `actorStyles` map (read from a DATA record at the mount)
 * wins; BUILTIN_ACTOR_STYLES are maximally-capable defaults (L083); and ANY unknown
 * actor_type still renders via DEFAULT_ACTOR_STYLE (never dropped). Adding an actor type =
 * one DATA/override entry, zero code change here.
 *
 * Usage:
 *   <ActivityIndicator
 *     activity={activity}
 *     maxVisible={3}
 *     position="top-right"
 *   />
 *
 * Data Contract:
 *   - Receives: activity-fact records read by the owning entry at a statically declared input
 *   - Each record: { actor_id, actor_type, package_id, timestamp, action_type, ... }
 *   - Styling: actor_type_styling DATA mapping { color, icon, duration_ms, animation }
 *   - Order: most recent first, fade out after duration_ms
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Container, Icon, Text } from '@/packages/ui';

// The workflow + trigger DATA path is deterministic and has NO wall-clock (verified
// 2026-07-26: no dt_now / ambient time in the workflow engine). A producer therefore
// CANNOT stamp a real timestamp. Recency is established CLIENT-SIDE (the browser is the
// only place with a real clock): we record when each fact is first observed, keyed by its
// unique correlation_id, and derive age from that. No wall-clock time-window drop.
function activityKey(a: { correlation_id?: string; actor_id: string; record_kind: string; package_id: string }): string {
  return a.correlation_id || `${a.actor_id}:${a.record_kind}:${a.package_id}`;
}

export interface ActivityFactRecord {
  actor_id: string;
  actor_type: string; // OPEN — any actor type, resolved to a style DATA-first (never a closed union)
  package_id: string;
  record_kind: string;
  timestamp: number;
  action_type: string; // OPEN — any action verb (write, retract, publish, …)
  correlation_id: string;
  payload_size: number;
  confidence: number;
}

interface ActorTypeStyle {
  color: string; // e.g., "hsl(200,100%,45%)"
  icon: string; // e.g., "sparkles"
  tone: string; // ui tone token (info | warning | neutral | secondary | …)
  duration_ms: number;
  animation: string; // ui animation token (pulse | bounce | slide-in | fade-in | …)
}

// Generic fallback so ANY actor_type renders (never dropped). Unknown types get a neutral badge.
const DEFAULT_ACTOR_STYLE: ActorTypeStyle = {
  color: 'hsl(210,10%,50%)',
  icon: 'circle',
  tone: 'neutral',
  duration_ms: 3000,
  animation: 'fade-in',
};

// Built-in default styles (L083 maximally-capable defaults). Overridable per-mount via the
// `actorStyles` DATA prop — these are NOT a closed set; unknown types fall back to DEFAULT_ACTOR_STYLE.
const BUILTIN_ACTOR_STYLES: Record<string, ActorTypeStyle> = {
  'ai-agent': {
    color: 'hsl(200,100%,45%)',
    icon: 'sparkles',
    tone: 'info',
    duration_ms: 3000,
    animation: 'pulse',
  },
  human: {
    color: 'hsl(30,100%,50%)',
    icon: 'user',
    tone: 'warning',
    duration_ms: 2000,
    animation: 'bounce',
  },
  'batch-write': {
    color: 'hsl(120,70%,40%)',
    icon: 'database',
    tone: 'neutral',
    duration_ms: 4000,
    animation: 'slide-in',
  },
  external: {
    color: 'hsl(270,70%,50%)',
    icon: 'link',
    tone: 'secondary',
    duration_ms: 3000,
    animation: 'fade-in',
  },
};

interface ActivityIndicatorProps {
  activity?: ActivityFactRecord[]; // Entry-owned static read, passed as data rather than a dynamic selector
  packageId?: string; // Filter by package_id (optional)
  maxVisible?: number; // Max badges to show (default 3)
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'; // (default: top-right)
  actorStyles?: Record<string, ActorTypeStyle>; // DATA override (read from a styling record at the mount); wins over BUILTIN_ACTOR_STYLES
  onActivityChange?: (activity: ActivityFactRecord[]) => void;
}

export function ActivityIndicator({
  activity,
  packageId,
  maxVisible = 3,
  position = 'top-right',
  actorStyles,
  onActivityChange,
}: ActivityIndicatorProps) {
  // Client-side first-seen clock (the DATA path has no wall-clock; the browser does).
  const firstSeenRef = useRef<Map<string, number>>(new Map());
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Rank newest-first by first-seen; show last N. NO wall-clock time-window drop.
  const visibleActivity = useMemo(() => {
    if (!activity || !Array.isArray(activity)) return [] as Array<{ a: ActivityFactRecord; seen: number }>;
    const seenNow = Date.now();
    const scoped = packageId ? activity.filter((a) => a.package_id === packageId) : activity;
    for (const a of scoped) {
      const k = activityKey(a);
      if (!firstSeenRef.current.has(k)) firstSeenRef.current.set(k, seenNow);
    }
    return scoped
      .map((a) => ({ a, seen: firstSeenRef.current.get(activityKey(a)) ?? seenNow }))
      .sort((x, y) => y.seen - x.seen)
      .slice(0, maxVisible);
  }, [activity, packageId, maxVisible]);

  React.useEffect(() => {
    onActivityChange?.(visibleActivity.map(({ a }) => a));
  }, [visibleActivity, onActivityChange]);

  if (!visibleActivity.length) return null;

  const positionClasses = {
    'top-right': 'top-2 right-2',
    'top-left': 'top-2 left-2',
    'bottom-right': 'bottom-2 right-2',
    'bottom-left': 'bottom-2 left-2',
  }[position];

  return (
    <Container
      layout="flex"
      flexDirection="column"
      gap="xs"
      className={`fixed ${positionClasses} z-50 pointer-events-none`}
    >
      {visibleActivity.map(({ a: activity, seen }) => {
        // DATA-first resolution; unknown actor types still render via the generic default (never dropped).
        const style = actorStyles?.[activity.actor_type]
          ?? BUILTIN_ACTOR_STYLES[activity.actor_type]
          ?? DEFAULT_ACTOR_STYLE;

        const actorLabel = activity.actor_id.split(':').pop() || activity.actor_id;
        const ageSec = Math.max(0, Math.round((Date.now() - seen) / 1000));

        return (
          <ActivityBadge
            key={activityKey(activity)}
            label={actorLabel}
            icon={style.icon}
            color={style.color}
            tone={style.tone}
            animation={style.animation}
            duration_ms={style.duration_ms}
            action={activity.action_type}
            kind={activity.record_kind}
            age_sec={ageSec}
          />
        );
      })}
    </Container>
  );
}

interface ActivityBadgeProps {
  label: string;
  icon: string;
  color: string;
  tone: string;
  animation: string;
  duration_ms: number;
  action: string;
  kind: string;
  age_sec: number;
}

function ActivityBadge({
  label,
  icon,
  color,
  tone,
  animation,
  duration_ms,
  action,
  kind,
  age_sec,
}: ActivityBadgeProps) {
  const opacity = Math.max(0, 1 - age_sec / (duration_ms / 1000));

  return (
    <Container
      layout="flex"
      alignItems="center"
      gap="xs"
      className={`
        px-3 py-2 rounded-lg
        border border-solid
        bg-opacity-90 backdrop-blur
        transition-opacity duration-300
        animate-${animation}
      `}
      style={{
        borderColor: color,
        backgroundColor: `${color}15`, // 9% opacity base
        opacity,
      }}
    >
      <Icon name={icon} size="sm" style={{ color }} />
      <Text variant="caption" weight="medium">
        {label} {action !== 'write' ? `(${action})` : ''}
      </Text>
      {age_sec > 0 && (
        <Text variant="micro" tone="secondary">
          {age_sec}s ago
        </Text>
      )}
    </Container>
  );
}

export default ActivityIndicator;
