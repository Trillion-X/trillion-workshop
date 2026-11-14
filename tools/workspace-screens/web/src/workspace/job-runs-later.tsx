// src/workspace/job-runs-later.tsx
//
// PURPOSE
//   The work a box's sends started (job-run.tsx JobRuns, or one JobRun), fetched the first time there is one to draw.
//   Home, a file's "Say about this" box, the composer and Write with my AI show it only after Send, so opening them
//   never carries the run view, the AI's board or the activity trace.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The same component and props as job-run.tsx JobRuns; with no runs it draws nothing and loads nothing.

import React from 'react';
import { later } from '../../parts/ui/show/load-later/later';
import type { RunRef } from 'trillion-workshop/tools/hand-work-to-ais/web/src/workspace/job-run.tsx';

const Loaded = later(() => import('trillion-workshop/tools/hand-work-to-ais/web/src/workspace/job-run.tsx'), module => module.JobRuns);
/** One job, the same component and props as job-run.tsx JobRun, fetched the first time it is drawn. */
export const JobRun = later(() => import('trillion-workshop/tools/hand-work-to-ais/web/src/workspace/job-run.tsx'), module => module.JobRun);

export function JobRuns({ runs }: { runs: RunRef[] }) {
  return runs.length ? <Loaded runs={runs} /> : null;
}
