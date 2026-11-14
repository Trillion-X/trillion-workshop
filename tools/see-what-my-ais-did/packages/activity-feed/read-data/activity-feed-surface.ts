// package-set://bitfield-studio/packages/activity-feed/read-data/activity-feed-surface.ts

export const activityFeedSurface = {
  title: 'Recent activity',
  status: 'Waiting for updates',
  summary: 'Updates from connected services and automated work appear here.',
  emptyMessage: 'No recent activity yet.',
  activitySources: [
    ['Service connected', 'A new outside service was connected.'],
    ['Workflow ran', 'Automated work used a connected service.'],
    ['Attention needed', 'A connection needs a new key, approval, or retry.'],
  ],
} as const;
