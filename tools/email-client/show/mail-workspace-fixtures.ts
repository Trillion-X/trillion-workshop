import { readMailWorkspace, type MailWorkItemFeed, type MailWorkspace } from '../read-data/read-mail-workspace.ts';

export type MailWorkspaceProofState =
  | 'empty-no-accounts'
  | 'empty-connected-account'
  | 'sparse'
  | 'dense'
  | 'loading'
  | 'error'
  | 'permission'
  | 'search'
  | 'compose'
  | 'task-linked'
  | 'archive-undo'
  | 'second-source';

type ProofState = {
  label: string;
  feed: MailWorkItemFeed;
};

const baseActions = [
  {
    id: 'action:refresh',
    role: 'refresh',
    label: 'Refresh',
    target: 'owner:mail-actions',
    operation: 'communication.refresh',
    values: { amount: 24 },
  },
  {
    id: 'action:reply',
    label: 'Reply',
    target: 'owner:mail-actions',
    operation: 'mail.work.perform',
  },
  {
    id: 'action:archive',
    label: 'Archive',
    target: 'owner:mail-actions',
    operation: 'mail.work.perform',
    undoActionId: 'action:undo-archive',
  },
  {
    id: 'action:snooze',
    label: 'Snooze',
    target: 'owner:mail-actions',
    operation: 'mail.work.perform',
    undoActionId: 'action:undo-snooze',
  },
  {
    id: 'action:delete',
    label: 'Delete',
    target: 'owner:mail-actions',
    operation: 'mail.work.perform',
    undoActionId: 'action:undo-delete',
  },
  {
    id: 'action:unsubscribe',
    label: 'Unsubscribe',
    target: 'owner:mail-actions',
    operation: 'mail.work.perform',
  },
  {
    id: 'action:make-task',
    label: 'Make task',
    target: 'owner:tasks',
    operation: 'source.task.create',
  },
  {
    id: 'action:schedule-send',
    label: 'Schedule send',
    target: 'owner:mail-actions',
    operation: 'mail.work.perform',
  },
  {
    id: 'action:account-settings',
    label: 'Account settings',
    target: 'owner:account-repair',
    operation: 'account.repair.open',
  },
  {
    id: 'action:retry',
    label: 'Retry',
    target: 'owner:mail-actions',
    operation: 'mail.work.perform',
  },
];

const accounts = [
  { address: 'account:personal', name: 'Personal', color: '#4f8cff', canRead: true, canSend: true },
  { address: 'account:studio', name: 'Studio', color: '#31b47b', canRead: true, canSend: true },
];

const readonlyAccounts = [
  accounts[0],
  {
    address: 'account:studio',
    name: 'Studio',
    color: '#31b47b',
    canRead: true,
    canSend: false,
    repairActionId: 'action:account-settings',
  },
];

function message(index: number, overrides: Record<string, unknown> = {}) {
  const accountAddress = index % 3 === 0 ? 'account:studio' : 'account:personal';
  const threadAddress = `thread:${index}`;
  const subject = [
    'Reply draft for the launch note',
    'Follow-up from yesterday',
    'Question about the account handoff',
    'Schedule the send window',
    'Attach the notes before publishing',
  ][index % 5];
  return {
    address: `message:${index}`,
    threadAddress,
    accountAddress,
    mailboxAddresses: ['mailbox:all', accountAddress === 'account:studio' ? 'mailbox:studio' : 'mailbox:personal'],
    sender: ['Sam', 'Ari', 'Mina', 'Jordan', 'Lee'][index % 5],
    recipients: ['me@example.test'],
    subject,
    preview: 'The next action is ready to review, reply, schedule, or turn into follow-up work.',
    body: 'Here is the full thread context. Keep the account visible, keep the next action close, and preserve the source message when this becomes follow-up work.',
    sentAt: `Jun ${12 + (index % 12)}`,
    unread: index % 4 === 0,
    attachmentCount: index % 6 === 0 ? 2 : index % 5 === 0 ? 1 : 0,
    actionIds: ['action:reply', 'action:archive', 'action:snooze', 'action:make-task'],
    sourceLink: index % 7 === 0 ? { address: `mail-source:message:${index}`, label: 'Source message' } : undefined,
    ...overrides,
  };
}

function threadForMessage(item: ReturnType<typeof message>) {
  return {
    address: String(item.threadAddress),
    messageAddresses: [String(item.address)],
    actionIds: item.actionIds as string[],
    sourceLink: item.sourceLink,
  };
}

function feed(messages: Array<ReturnType<typeof message>>, overrides: Partial<MailWorkItemFeed> = {}): MailWorkItemFeed {
  return {
    accounts,
    mailboxes: [
      { address: 'mailbox:all', label: 'All inboxes', messageAddresses: messages.map((item) => String(item.address)) },
      {
        address: 'mailbox:personal',
        label: 'Personal inbox',
        accountAddress: 'account:personal',
        messageAddresses: messages.filter((item) => item.accountAddress === 'account:personal').map((item) => String(item.address)),
      },
      {
        address: 'mailbox:studio',
        label: 'Studio inbox',
        accountAddress: 'account:studio',
        messageAddresses: messages.filter((item) => item.accountAddress === 'account:studio').map((item) => String(item.address)),
      },
      { address: 'mailbox:scheduled', label: 'Scheduled', messageAddresses: [] },
      { address: 'mailbox:archive', label: 'Archive', messageAddresses: [] },
    ],
    actions: baseActions,
    messages,
    threads: messages.map(threadForMessage),
    selectedAddress: messages[0]?.address,
    ...overrides,
  };
}

const sparseMessages = [
  message(1, {
    address: 'message:sparse-1',
    threadAddress: 'thread:sparse-1',
    sender: 'Sam',
    subject: 'Launch note',
    preview: 'Can you send the launch note from the Personal account?',
    sourceLink: { address: 'mail-source:sparse-1', label: 'Launch note email' },
  }),
  message(2, {
    address: 'message:sparse-2',
    threadAddress: 'thread:sparse-2',
    sender: 'Ari',
    subject: 'Blocked sender account',
    preview: 'The Studio account can read this thread but cannot send yet.',
    accountAddress: 'account:studio',
    actionIds: ['action:reply-readonly', 'action:archive', 'action:make-task'],
  }),
];

const permissionActions = [
  ...baseActions,
  {
    id: 'action:reply-readonly',
    label: 'Reply',
    target: 'owner:mail-actions',
    operation: 'mail.work.perform',
    disabledReason: 'Studio needs account settings before sending.',
  },
];

const denseMessages = Array.from({ length: 36 }, (_, index) => message(index + 1));

const proofStates: Record<MailWorkspaceProofState, ProofState> = {
  'empty-no-accounts': {
    label: 'Empty no accounts',
    feed: {},
  },
  'empty-connected-account': {
    label: 'Empty connected account',
    feed: feed([], {
      accounts: [accounts[0]],
      mailboxes: [{ address: 'mailbox:personal', label: 'Personal inbox', accountAddress: 'account:personal', messageAddresses: [] }],
      selectedMailboxAddress: 'mailbox:personal',
    }),
  },
  sparse: {
    label: 'Sparse inbox',
    feed: feed(sparseMessages, { actions: permissionActions, selectedAddress: 'message:sparse-1' }),
  },
  dense: {
    label: 'Dense unified inbox',
    feed: feed(denseMessages, { selectedAddress: 'message:1' }),
  },
  loading: {
    label: 'Loading mail',
    feed: feed([], { accounts: [accounts[0]], loading: true }),
  },
  error: {
    label: 'Sync error',
    feed: feed(sparseMessages, {
      selectedAddress: 'message:sparse-1',
      statuses: [
        {
          address: 'status:sync-error',
          accountAddress: 'account:studio',
          label: 'Studio could not sync. Retry or open Account settings.',
          actionIds: ['action:retry', 'action:account-settings'],
        },
      ],
    }),
  },
  permission: {
    label: 'Read-only sending',
    feed: feed(sparseMessages, {
      accounts: readonlyAccounts,
      actions: permissionActions,
      selectedAddress: 'message:sparse-2',
      statuses: [
        {
          address: 'status:readonly',
          accountAddress: 'account:studio',
          messageAddress: 'message:sparse-2',
          label: 'Studio can read mail. Account settings are needed before sending.',
          actionIds: ['action:account-settings'],
        },
      ],
    }),
  },
  search: {
    label: 'Search results',
    feed: feed(denseMessages.slice(0, 8), { selectedAddress: 'message:3' }),
  },
  compose: {
    label: 'Compose scheduled send',
    feed: feed(sparseMessages, {
      selectedAddress: 'message:sparse-1',
      drafts: [
        {
          address: 'draft:scheduled-send',
          accountAddress: 'account:personal',
          threadAddress: 'thread:sparse-1',
          to: ['sam@example.test'],
          subject: 'Re: Launch note',
          body: 'I can send this tomorrow morning.',
          actionIds: ['action:schedule-send'],
          status: {
            address: 'status:scheduled',
            accountAddress: 'account:personal',
            messageAddress: 'message:sparse-1',
            label: 'Scheduled for tomorrow morning.',
            actionIds: ['action:schedule-send'],
          },
        },
      ],
    }),
  },
  'task-linked': {
    label: 'Task linked message',
    feed: feed([
      message(7, {
        address: 'message:task-linked',
        threadAddress: 'thread:task-linked',
        sender: 'Mina',
        subject: 'Turn this into follow-up',
        sourceLink: { address: 'mail-source:task-linked', label: 'Follow-up task linked' },
      }),
    ], { selectedAddress: 'message:task-linked' }),
  },
  'archive-undo': {
    label: 'Archive with undo',
    feed: feed(sparseMessages, {
      selectedAddress: 'message:sparse-1',
      statuses: [
        {
          address: 'status:archive-undo',
          accountAddress: 'account:personal',
          messageAddress: 'message:sparse-1',
          label: 'Message archived. Undo is available.',
          actionIds: ['action:archive'],
        },
      ],
    }),
  },
  'second-source': {
    label: 'Second source',
    feed: feed([
      message(41, {
        address: 'source-b:message:1',
        threadAddress: 'source-b:thread:1',
        accountAddress: 'source-b:account',
        mailboxAddresses: ['source-b:view:priority'],
        sender: 'Rae',
        subject: 'Second source follow-up',
        preview: 'This source uses the same descriptor shape with different labels.',
        sourceLink: { address: 'source-b:source:1', label: 'Source B item' },
      }),
    ], {
      accounts: [{ address: 'source-b:account', name: 'Source B', canRead: true, canSend: true }],
      mailboxes: [{ address: 'source-b:view:priority', label: 'Source B priority', accountAddress: 'source-b:account', messageAddresses: ['source-b:message:1'] }],
      actions: [
        {
          id: 'source-b:action:update',
          role: 'refresh',
          label: 'Update feed',
          target: 'source-b:owner',
          operation: 'communication.refresh',
          values: { amount: 48 },
        },
        ...baseActions.filter((action) => action.id !== 'action:refresh'),
      ],
      selectedAddress: 'source-b:message:1',
      selectedMailboxAddress: 'source-b:view:priority',
    }),
  },
};

export const mailWorkspaceProofStateNames = Object.keys(proofStates) as MailWorkspaceProofState[];

export function readMailWorkspaceProofState(state: MailWorkspaceProofState): MailWorkspace {
  return readMailWorkspace(proofStates[state].feed);
}

export function readMailWorkspaceProofFeed(state: MailWorkspaceProofState): MailWorkItemFeed {
  return proofStates[state].feed;
}

export function readMailWorkspaceProofLabel(state: MailWorkspaceProofState): string {
  return proofStates[state].label;
}

export function isMailWorkspaceProofState(value: unknown): value is MailWorkspaceProofState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(proofStates, value);
}
