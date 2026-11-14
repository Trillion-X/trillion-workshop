// packages/sync-status/show/SyncStatus.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// React component displaying OTA sync status and managed projects.
// Shows last sync time, count of updated files, and list of projects being
// synced from descriptor-bound `sync-status` data.
//
// Design: Glassmorphism card with relative time display, badge for
// file count, and managed project list.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All styling via ui/ component props (Button, Card, Badge, Text)
// 2. No inline className or raw HTML elements
// 3. Relative time display: "2 minutes ago", "5 hours ago"
// 4. File count badge: shows number of updated files in last sync
// 5. Error list shows any sync failures
// 6. Project list shows all managed projects
//
// =============================================================================
// KEY CONCEPTS
// =============================================================================
//
// - SyncStatus: { lastSync, filesUpdated, errors }
// - ManagedProject: { path }
// - Relative time: computed from lastSync timestamp
//
// =============================================================================
// SECURITY CONSIDERATIONS
// =============================================================================
//
// - No sensitive data displayed (paths are user's own projects)
// - Error messages are from backend (sanitized by sync-engine)
// - No local storage of credentials or tokens
// - No fake manual trigger protocol is allowed in UI code
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useMemo } from 'react';
import { Card, Badge, Text, Container } from '@/packages/ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  decodeSyncStatusFeed,
} from '@/packages/sync-status/read-data/read-sync-status';

/**
 * Compute relative time: "2 minutes ago", "5 hours ago", etc.
 */
function getRelativeTime(timestamp: string): string {
  const now = new Date();
  const then = new Date(timestamp);
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);

  if (seconds < 60) {
    return 'just now';
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(seconds / 86400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * SyncStatus component: displays last sync info and managed project list.
 */
export function SyncStatus() {
  const statusEntry = useBitfieldData('sync-status');
  const projectsEntry = useBitfieldData('managed-projects');
  const syncData = useMemo(
    () => decodeSyncStatusFeed(statusEntry, projectsEntry),
    [statusEntry, projectsEntry],
  );
  const syncStatus = syncData.status;
  const projects = syncData.projects;

  return (
    <Card variant="surface" padding="md">
      <Container layout="vertical" gap="md">
        {/* Header: Last sync time */}
        <Container layout="horizontal">
          <Text variant="body" weight="semibold">
            System Updates
          </Text>
          {syncStatus.lastSync && (
            <Badge variant="info" size="sm">
              {getRelativeTime(syncStatus.lastSync)}
            </Badge>
          )}
        </Container>

        {/* File count and errors */}
        <Container layout="horizontal" gap="md">
          {syncStatus.filesUpdated > 0 && (
            <Badge variant="success" size="md">
              {syncStatus.filesUpdated} file{syncStatus.filesUpdated === 1 ? '' : 's'} updated
            </Badge>
          )}
          {syncStatus.errors.length > 0 && (
            <Badge variant="error" size="md">
              {syncStatus.errors.length} error{syncStatus.errors.length === 1 ? '' : 's'}
            </Badge>
          )}
        </Container>

        {/* Error messages */}
        {syncStatus.errors.length > 0 && (
          <Container layout="vertical" gap="xs">
            {syncStatus.errors.map((err, idx) => (
              <Text key={idx} variant="body-xs" color="error">
                {err}
              </Text>
            ))}
          </Container>
        )}

        {/* Project list */}
        {projects.length > 0 && (
          <Container layout="vertical" gap="xs">
            <Text variant="body-xs" color="muted">
              Managed projects ({projects.length})
            </Text>
            {projects.map((proj) => (
              <Text key={proj.path} variant="body-xs" color="muted">
                {proj.path}
              </Text>
            ))}
          </Container>
        )}
      </Container>
    </Card>
  );
}
