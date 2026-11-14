import React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { MailPlus, Search, Send } from 'lucide-react';
import { Button, Container, Text, emitPlaceableSurfaceIntent, readPlaceableSurfacePayloadFromUnknown } from '@/packages/ui';
import { requestMailAction } from '../do-work/request-mail-action.ts';
import { readMailWorkspace, type MailAction, type MailDraft, type MailMessage, type MailStatus, type MailWorkItemFeed } from '../read-data/read-mail-workspace.ts';
import { MailboxRail } from './MailboxRail.tsx';
import { MailSearchOverlay } from './MailSearchOverlay.tsx';
import { MailStatusBanner } from './MailStatusBanner.tsx';
import { MessageList } from './MessageList.tsx';
import { ThreadReader } from './ThreadReader.tsx';

type MailWorkspaceProps = {
  feed: MailWorkItemFeed;
};

type MailActionSource = {
  workItemAddress: string;
  accountAddress?: string;
  threadAddress?: string;
  labelSubject?: string;
};

function sourceFromMessage(message: MailMessage): MailActionSource {
  return {
    workItemAddress: message.address,
    accountAddress: message.accountAddress,
    threadAddress: message.threadAddress,
    labelSubject: message.subject,
  };
}

function sourceFromDraft(draft?: MailDraft, message?: MailMessage): MailActionSource | null {
  if (!draft && !message) return null;
  return {
    workItemAddress: draft?.address ?? message?.address ?? '',
    accountAddress: draft?.accountAddress ?? message?.accountAddress,
    threadAddress: draft?.threadAddress ?? message?.threadAddress,
    labelSubject: draft?.subject || message?.subject,
  };
}

function sourceFromStatus(status: MailStatus): MailActionSource {
  return {
    workItemAddress: status.address,
    accountAddress: status.accountAddress,
    labelSubject: status.label,
  };
}

export function MailWorkspace({ feed }: MailWorkspaceProps) {
  let initial;
  try {
    initial = readMailWorkspace(feed);
  } catch (error) {
    console.error('[email-client] readMailWorkspace failed:', error);
    initial = {
      accounts: [],
      mailboxes: [],
      messageRows: [],
      selectedAddress: null,
      selectedMailboxAddress: null,
      selectedThread: null,
      drafts: [],
      actionsById: {},
      statuses: [],
      emptyReason: 'error',
      loading: false
    };
  }
  const [selectedAddress, setSelectedAddress] = React.useState<string | null>(initial.selectedAddress);
  const [selectedMailboxAddress, setSelectedMailboxAddress] = React.useState<string | null>(initial.selectedMailboxAddress);
  const [runningActionId, setRunningActionId] = React.useState<string | null>(null);
  const [composerOpen, setComposerOpen] = React.useState(Boolean(initial.drafts.length));
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [undoLabel, setUndoLabel] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSelectedAddress(initial.selectedAddress);
    setSelectedMailboxAddress(initial.selectedMailboxAddress);
    setComposerOpen(Boolean(initial.drafts.length));
    setUndoLabel(null);
  }, [feed]);

  const workspace = React.useMemo(() => readMailWorkspace({
    ...feed,
    selectedAddress: selectedAddress ?? feed.selectedAddress,
    selectedMailboxAddress: selectedMailboxAddress ?? feed.selectedMailboxAddress,
  }), [feed, selectedAddress, selectedMailboxAddress]);

  const accountsByAddress = React.useMemo(
    () => Object.fromEntries(workspace.accounts.map((account) => [account.address, account])),
    [workspace.accounts],
  );
  const dispatchAction = React.useCallback(async (action: MailAction, source: MailActionSource | null) => {
    if (action.disabledReason) return;
    // An action whose `values` resolve to a placeable-surface reference (materialTarget /
    // target / packageEntry) means "open a surface," not "dispatch a backend request" — the
    // shape of the data decides the dispatch mode, not a hardcoded operation/role string.
    const surfacePayload = readPlaceableSurfacePayloadFromUnknown(action.values ?? null);
    if (surfacePayload && (surfacePayload.materialTarget || surfacePayload.target || surfacePayload.packageEntry)) {
      if (!emitPlaceableSurfaceIntent(surfacePayload)) {
        setUndoLabel(`${action.label} is not available right now.`);
      }
      return;
    }
    if (!source?.workItemAddress) {
      setUndoLabel(`${action.label} needs a selected mail item.`);
      return;
    }
    try {
      setRunningActionId(action.id);
      await requestMailAction({
        action,
        workItemAddress: source.workItemAddress,
        accountAddress: source.accountAddress,
        threadAddress: source.threadAddress,
        correlationId: `mail-action:${action.id}:${Date.now()}`,
        values: action.values,
      }, (request) => sendRequestToBitfieldTarget(request));

      const subject = source.labelSubject ? `: ${source.labelSubject}` : '';
      setUndoLabel(`${action.label} sent${subject}`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[email-client] action dispatch failed:', raw);
      setUndoLabel(`${action.label} could not be completed. Please try again.`);
    } finally {
      setRunningActionId(null);
    }
  }, []);

  const handleAction = React.useCallback((action: MailAction, message?: MailMessage) => {
    if (action.disabledReason) return;
    if (action.label === 'Reply' && message) {
      setComposerOpen(true);
      return;
    }
    void dispatchAction(action, message ? sourceFromMessage(message) : null);
  }, [dispatchAction]);

  const handleDraftAction = React.useCallback((action: MailAction, draft?: MailDraft, message?: MailMessage) => {
    void dispatchAction(action, sourceFromDraft(draft, message));
  }, [dispatchAction]);

  const handleStatusAction = React.useCallback((action: MailAction, status: MailStatus) => {
    void dispatchAction(action, sourceFromStatus(status));
  }, [dispatchAction]);

  const emptyNoAccounts = workspace.emptyReason === 'no-accounts';
  const emptyError = workspace.emptyReason === 'error';
  const firstAccountAddress = workspace.accounts[0]?.address;
  const refreshAction = Object.values(workspace.actionsById).find((action) => action.role === 'refresh' || action.operation === 'communication.refresh');
  const setupAction = Object.values(workspace.actionsById).find((action) => action.role === 'setup' || action.role === 'repair');

  const openConnectionsSurface = React.useCallback(() => {
    if (!setupAction) {
      setUndoLabel('Account connections are not available yet.');
      return;
    }
    void dispatchAction(setupAction, null);
  }, [setupAction, dispatchAction]);

  // Render error state if data loading failed
  if (emptyError) {
    return (
      <Container layout="vertical" height="full" minHeight="0" padding="lg" gap="md" overflow="hidden">
        <Container layout="vertical" gap="xs" minWidth="0">
          <Text variant="heading-xl">Email</Text>
          <Text variant="body-xs" color="muted">Read, reply, schedule, search, and make follow-up work across connected accounts.</Text>
        </Container>
        <Container layout="vertical" gap="lg" alignItems="center" justifyContent="center" flex="1" padding="lg" data-reach-role="error-state">
          <Text variant="heading-lg">Unable to load email workspace</Text>
          <Text variant="body-xs" color="muted" align="center">There was an error loading your email configuration. Please try refreshing the page.</Text>
        </Container>
      </Container>
    );
  }

  return (
    <Container layout="vertical" height="full" minHeight="0" padding="lg" gap="md" overflow="hidden" className="relative bg-[var(--surface-primary)]">
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="md" wrap="wrap">
        <Container layout="vertical" gap="xs" minWidth="0">
          <Text variant="heading-xl">Email</Text>
          <Text variant="body-xs" color="muted">Read, reply, schedule, search, and make follow-up work across connected accounts.</Text>
        </Container>
        <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap">
          <Button variant="secondary" size="sm" onClick={() => setSearchOpen(true)} disabled={workspace.messageRows.length === 0} title={workspace.messageRows.length === 0 ? 'No messages to search yet.' : undefined}>
            <Search className="h-4 w-4" aria-hidden="true" />
            Search
          </Button>
          <Button variant="primary" size="sm" onClick={() => setComposerOpen(true)} disabled={emptyNoAccounts} data-reach-action="compose" title={emptyNoAccounts ? 'Add an account first.' : undefined}>
            <Send className="h-4 w-4" aria-hidden="true" />
            Compose
          </Button>
        </Container>
      </Container>

      <MailStatusBanner
        accountsByAddress={accountsByAddress}
        actionsById={workspace.actionsById}
        statuses={undoLabel ? [
          ...workspace.statuses,
          { address: 'status:local-undo', label: undoLabel, actionIds: [] },
        ] : workspace.statuses}
        loading={workspace.loading}
        onAction={handleStatusAction}
      />

      {emptyNoAccounts ? (
        <Container layout="vertical" gap="lg" alignItems="center" justifyContent="center" flex="1" padding="lg" className="rounded-md border border-dashed border-[var(--border-primary)] bg-[var(--surface-secondary)]" data-reach-role="empty-state">
          <MailPlus className="h-10 w-10 text-[var(--text-secondary)]" aria-hidden="true" />
          <Container layout="vertical" gap="xs" alignItems="center">
            <Text variant="heading-lg">Add an email account</Text>
            <Text variant="body-xs" color="muted" align="center">Start with one account. The workspace keeps the sending account visible before every reply.</Text>
          </Container>
          <Button
            variant="primary"
            disabled={!setupAction}
            onClick={openConnectionsSurface} data-reach-action="connect-account"
          >
            Add account
          </Button>
        </Container>
      ) : (
        <Container layout="grid" gridColumns={12} gap="md" overflow="hidden" flex="1" minHeight="0">
          <Container gridColumnSpan={2} minHeight="0" data-reach-role="account-rail">
            <MailboxRail
              accounts={workspace.accounts}
              mailboxes={workspace.mailboxes}
              selectedMailboxAddress={workspace.selectedMailboxAddress}
              onOpenConnections={openConnectionsSurface}
              onSelectMailbox={(address) => {
                setSelectedMailboxAddress(address);
                setSelectedAddress(null);
              }}
            />
          </Container>
          <Container gridColumnSpan={4} minHeight="0" data-reach-role="message-list">
            <MessageList
              accountsByAddress={accountsByAddress}
              actionsById={workspace.actionsById}
              messages={workspace.messageRows}
              selectedAddress={workspace.selectedAddress}
              refreshAction={refreshAction}
              refreshing={runningActionId === refreshAction?.id}
              onSelect={setSelectedAddress}
              onAction={handleAction}
              onRefresh={(action) => void dispatchAction(action, {
                workItemAddress: workspace.selectedAddress ?? workspace.messageRows[0]?.address ?? 'email-client:workspace',
                accountAddress: workspace.messageRows[0]?.accountAddress ?? firstAccountAddress,
                threadAddress: workspace.selectedThread?.thread.address,
                labelSubject: action.label,
              })}
            />
          </Container>
          <Container gridColumnSpan={6} minHeight="0">
            <ThreadReader
              accountsByAddress={accountsByAddress}
              workspace={workspace}
              composerOpen={composerOpen}
              onOpenComposer={() => setComposerOpen(true)}
              onCloseComposer={() => setComposerOpen(false)}
              onAction={handleAction}
              onDraftAction={handleDraftAction}
            />
          </Container>
        </Container>
      )}

      <MailSearchOverlay
        accountsByAddress={accountsByAddress}
        messages={workspace.messageRows}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={setSelectedAddress}
      />
    </Container>
  );
}
