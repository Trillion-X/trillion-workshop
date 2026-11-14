// src/workspace/write-with-my-ai.tsx
//
// PURPOSE
//   "Have my AI write it" for a Formats script, the same on every screen that records from one (Record, Record video):
//   the shared queue-job button (queue-job.ts) asks the person's own AIs for the write-in-format job, connecting an AI
//   first when none is, and says it was sent; the work it started is then drawn live with the shared job run (job-run.tsx
//   over parts/ui/show/run-view): who took it, each step, and the script itself as a card when the AI finishes with it.
//   Watch it opens that run on its own screen.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One road: every press goes through queueJobProps / sendQueuedJob, never a hand-written request.
//   2. Pressing never waits on a thought: with none given, the job is about what matters most to the person now
//      (recording.json write_without_thought, filled by recording.mjs writeScriptJob).
//   3. The run is read by the press's own asked_id, the id the store hands the job on with (kept or held), so what is
//      shown is only that job.

import * as React from 'react';
import { Button, Container } from '../../parts/ui';
import { QueueJobButton } from '../../parts/ui/show/queue-job/QueueJobButton';
import { JobRun } from './job-runs-later';
import { openScreenOn } from './open-screen';
import { queueJobProps } from './queue-job';
import { writeScriptJob } from './recording.mjs';

type Script = Parameters<typeof writeScriptJob>[0];

const WATCH = 'Watch it';
const RUN_SCREEN = 'trillion.job-run';

/** The job this script's press started, kept by the screen so its run can be drawn where the screen wants it. */
export function useWriteWithMyAI(script: Script | null) {
  const [asked, setAsked] = React.useState<string | null>(null);
  React.useEffect(() => setAsked(null), [script]);
  const props = React.useMemo(() => {
    if (!script) return null;
    const job = writeScriptJob(script);
    const shared = queueJobProps(job.job_id, job.context);
    if (!shared) return null;
    return {
      ...shared,
      onSent: (answer: unknown) => {
        shared.onSent?.(answer);
        const id = (answer as { asked_id?: unknown } | null)?.asked_id;
        if (typeof id === 'string') setAsked(id);
      },
    };
  }, [script]);
  const button = props ? (
    <Container layout="horizontal" gap="xs" alignItems="center">
      <QueueJobButton {...props} />
      {asked ? <Button variant="ghost" size="sm" onClick={() => openScreenOn(RUN_SCREEN, { message: asked }, props.label)}>{WATCH}</Button> : null}
    </Container>
  ) : null;
  const run = asked ? <JobRun runRef={{ message: asked }} /> : null;
  return { button, run };
}
