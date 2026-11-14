// packages/projects/read-data/read-current-project.ts
//
// Pure package-feed decoder for the currently selected project.

import { readJsonPayload, readStringPayload } from '@/packages/projects/read-data/read-json-payload';

export interface CurrentProjectFeed {
  activeProject: string | null;
}

export function decodeCurrentProjectFeed(raw: unknown): CurrentProjectFeed {
  const payload = readJsonPayload(raw);
  const rows = Array.isArray(payload) ? payload : [];
  const activeProjectRow = rows.find(
    (entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry),
  ) as Record<string, unknown> | undefined;
  return {
    activeProject: readStringPayload(activeProjectRow?.activeProject),
  };
}
