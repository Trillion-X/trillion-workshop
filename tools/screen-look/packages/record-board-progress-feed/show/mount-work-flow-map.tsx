import * as React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@/packages/record-board-progress-feed/.bitfield-entry-scope/work-flow-map/runtime-kit-react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { observedContentFeedRows, observedMessageWorkRefs, projectObservedContentFlow, type MessageWorkReadback } from '../read-data/observed-content-flow';
import { WorkFlowMap } from './WorkFlowMap';

const INPUT_NAME = 'work-flow-observed-content-feed';
const FRESHNESS_MS = 60 * 60 * 1000;

export function LiveWorkFlowMap() {
  const rawFeed = useBitfieldData(INPUT_NAME);
  const feed = React.useMemo(() => observedContentFeedRows(rawFeed), [rawFeed]);
  const messageRefs = React.useMemo(() => observedMessageWorkRefs(feed.ledgersBySource), [feed]);
  const messageRefKey = messageRefs.map(({ recordRef }) => recordRef).join('\n');
  const [workByMessage, setWorkByMessage] = React.useState<Record<string, MessageWorkReadback>>({});
  React.useEffect(() => {
    if (!messageRefs.length) return;
    let current = true;
    void Promise.allSettled(messageRefs.map(async ({ atomRef, recordRef }) => {
      const reply = await sendRequestToBitfieldTarget({
        target: 'slot::workflow',
        payload: {
          operation: 'execute_definition',
          definition_id: 'action:read-source-message-work',
          input: { record_ref: recordRef },
          include_output: true,
          include_steps: false,
        },
      });
      if (!reply?.payload) return null;
      const result = JSON.parse(new TextDecoder().decode(reply.payload));
      const work = result?.output ?? result;
      if (result?.status !== 'completed' || work?.request?.found !== true || work?.task?.found !== true) return null;
      const taskRef = work.request.payload?.task_ref;
      if (typeof taskRef !== 'string' || taskRef !== recordRef) return null;
      const requestAt = work.request.payload?.at;
      const claim = work.claim?.found === true ? work.claim.payload : null;
      return { atomRef, details: {
        taskAddress: taskRef,
        ...(typeof requestAt === 'string' ? { requestAt } : {}),
        ...(typeof claim?.claimed_at === 'string' ? { claimAt: claim.claimed_at } : {}),
        ...(typeof claim?.status === 'string' ? { claimStatus: claim.status } : {}),
      } satisfies MessageWorkReadback };
    })).then((results) => {
      if (!current) return;
      const linked: Record<string, MessageWorkReadback> = {};
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) linked[result.value.atomRef] = result.value.details;
      }
      setWorkByMessage(linked);
    });
    return () => { current = false; };
  }, [messageRefKey]);
  const taskAddressByMessage = React.useMemo(() => Object.fromEntries(
    Object.entries(workByMessage).map(([atomRef, details]) => [atomRef, details.taskAddress]),
  ), [workByMessage]);
  const view = React.useMemo(() => projectObservedContentFlow(
    feed.plan,
    feed.ledgersBySource,
    taskAddressByMessage,
    Date.now(),
    FRESHNESS_MS,
    rawFeed !== null && rawFeed !== undefined && feed.planAvailable,
    workByMessage,
  ), [feed, rawFeed, taskAddressByMessage, workByMessage]);
  return <WorkFlowMap items={view.items} feedState={view.state} />;
}

export default function mount({ el }: { el: HTMLElement }) {
  return mountReactSurface(el, <ErrorBoundary zoneName="work-flow-map"><LiveWorkFlowMap /></ErrorBoundary>);
}
