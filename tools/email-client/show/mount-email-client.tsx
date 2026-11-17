import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { type MailWorkItemFeed } from '../read-data/read-mail-workspace.ts';
import { MailWorkspace } from './MailWorkspace.tsx';
import {
  isMailWorkspaceProofState,
  readMailWorkspaceProofFeed,
} from './mail-workspace-fixtures.ts';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// The workflow engine's write step for publish-mail-accounts can only encode
// a "cell_table" (rows of columns), so account rows arrive as a bare array of
// row objects via `communication-work-items`. Static, non-row UI chrome (the
// setup action) can't live inside that row shape, so it is sourced from its
// own generated-values address instead — a DATA record this package's
// compiled source never names, mirroring how account rows already flow in
// rather than being a literal here.
function readFeed(
  value: unknown,
  setupActions: unknown,
  props: Record<string, unknown>,
): MailWorkItemFeed {
  const propState = props.proof_state ?? props.proofState;
  if (isMailWorkspaceProofState(propState)) return readMailWorkspaceProofFeed(propState);

  const actions = Array.isArray(setupActions) ? setupActions : [];

  if (Array.isArray(value)) {
    return { accounts: value, actions, statuses: [] };
  }

  const record = asRecord(value);
  const valueState = record.proof_state ?? record.proofState;
  if (isMailWorkspaceProofState(valueState)) return readMailWorkspaceProofFeed(valueState);

  const nested = asRecord(record.mail_work_items ?? record.mailWorkItems);
  const feed = Object.keys(nested).length > 0 ? nested : record;
  return feed.actions ? feed : { ...feed, actions };
}

function EmailClientPanel({ props }: { props: Record<string, unknown> }) {
  const liveValue = useBitfieldData('communication-work-items');
  const setupActions = useBitfieldData('email-client-setup-actions');
  const feed = React.useMemo(
    () => readFeed(liveValue, setupActions, props),
    [liveValue, setupActions, props],
  );

  return <MailWorkspace feed={feed} />;
}

function EmailClientMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="email-client material">
        <EmailClientPanel props={props} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <EmailClientMaterial props={props} />);
}
