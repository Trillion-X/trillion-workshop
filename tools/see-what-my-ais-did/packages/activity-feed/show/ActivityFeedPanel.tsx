// packages/activity-feed/show/ActivityFeedPanel.tsx
//
// REAL ActivityFeedPanel: Reads from scoped record_from_matching_records feed (NOT 34.7MB aggregate).
// Each activity-fact record: { actor_id, actor_type, package_id, action_type, timestamp, confidence }
// Renders live actor activity badges with fade-out after 60s window.

import React, { useMemo } from 'react';
import { Container, Icon, ScrollableSurface, Text } from '@/packages/ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Activity } from 'lucide-react';

interface ActivityFactRecord {
  actor_id: string;
  actor_type: 'ai-agent' | 'human' | 'batch-write' | 'external';
  package_id: string;
  record_kind: string;
  timestamp: number;
  // action_type is an open, producer-authored key (write/retract/publish/generate/…) —
  // never a closed union (any package's trigger can introduce a new one). It is NOT rendered
  // raw; producers author a human action_label + object_label as DATA (L090/L098).
  action_type: string;
  action_label?: string;
  object_label?: string;
  correlation_id: string;
  payload_size?: number;
  confidence?: number;
}

const ACTOR_TYPE_STYLES: Record<string, { color: string; icon: string; label: string }> = {
  'ai-agent': { color: 'hsl(200,100%,45%)', icon: 'sparkles', label: 'AI Agent' },
  human: { color: 'hsl(30,100%,50%)', icon: 'user', label: 'Human' },
  'batch-write': { color: 'hsl(120,70%,40%)', icon: 'database', label: 'Batch Write' },
  external: { color: 'hsl(270,70%,50%)', icon: 'link', label: 'External' },
};

export function ActivityFeedPanel() {
  const feedData = useBitfieldData() as ActivityFactRecord[] | undefined;

  // Filter + sort: most recent first, exclude stale (> 60s)
  const visibleActivity = useMemo(() => {
    if (!feedData || !Array.isArray(feedData)) return [];

    const now = Date.now();
    return feedData
      .filter((a) => now - a.timestamp <= 60000)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10);
  }, [feedData]);

  const empty = visibleActivity.length === 0;

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="lg" padding="md">
        <Container layout="horizontal" justifyContent="between" alignItems="start">
          <Container layout="vertical" gap="xs">
            <Text variant="heading-lg">Activity Feed</Text>
            <Text variant="body-xs" color="muted">
              {empty ? 'Waiting for actor updates...' : `${visibleActivity.length} recent actions`}
            </Text>
          </Container>
          <Icon name="activity" size="lg" style={{ color: 'hsl(200,100%,45%)' }} />
        </Container>

        {empty ? (
          <Container
            layout="vertical"
            gap="sm"
            padding="md"
            style={{ border: '1px solid hsl(0,0%,80%)', borderRadius: '8px' }}
          >
            <Text variant="body-sm" color="muted" style={{ textAlign: 'center' }}>
              No activity in the last 60 seconds. Activity from any actor (AI, human, batch-write, external)
              will appear here as records are created.
            </Text>
          </Container>
        ) : (
          <Container layout="vertical" gap="sm">
            {visibleActivity.map((activity) => {
              const style = ACTOR_TYPE_STYLES[activity.actor_type];
              const ageSec = Math.round((Date.now() - activity.timestamp) / 1000);
              const opacity = Math.max(0.3, 1 - ageSec / 60); // fade over 60s
              const actorLabel = activity.actor_id.split(':').pop() || activity.actor_id;

              return (
                <Container
                  key={`${activity.actor_id}:${activity.timestamp}`}
                  layout="horizontal"
                  gap="sm"
                  alignItems="center"
                  padding="sm"
                  style={{
                    border: `1px solid ${style?.color || 'hsl(0,0%,80%)'}`,
                    borderRadius: '6px',
                    backgroundColor: `${style?.color || 'hsl(0,0%,90%)'}11`,
                    opacity,
                    transition: 'opacity 0.3s',
                  }}
                >
                  <Icon
                    name={style?.icon || 'circle'}
                    size="sm"
                    style={{ color: style?.color || 'hsl(0,0%,50%)' }}
                  />
                  <Container layout="vertical" gap="xs" style={{ flex: 1 }}>
                    <Text variant="body-sm" weight="medium">
                      {style?.label || 'Activity'}
                    </Text>
                    <Text variant="caption" color="muted">
                      {actorLabel} {activity.action_label || 'made an update'}
                      {activity.object_label ? ` ${activity.object_label}` : ''} ({ageSec}s ago)
                    </Text>
                  </Container>
                  {activity.confidence !== undefined && (
                    <Text variant="micro" color="muted">
                      {Math.round(activity.confidence * 100)}%
                    </Text>
                  )}
                </Container>
              );
            })}
          </Container>
        )}
      </Container>
    </ScrollableSurface>
  );
}
