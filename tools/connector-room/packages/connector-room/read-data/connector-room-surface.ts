// package-set://bitfield-studio/packages/connector-room/read-data/connector-room-surface.ts

export const connectorRoomSurface = {
  title: 'Connected workflows',
  status: 'Connection context',
  summary: 'See which services, people, permissions, and updates belong to the same connected workflow.',
  zones: [
    ['People', 'Who can use this connected workflow.'],
    ['Services', 'Which outside services are involved.'],
    ['Permissions', 'What the workflow is allowed to do.'],
    ['Activity', 'Recent updates from the workflow.'],
  ],
  emptyMessage: 'No connected workflow is selected yet.',
  nextSteps: ['Connect a service', 'Start an automated workflow', 'Open a workflow from recent activity'],
} as const;
