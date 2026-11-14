export type MailAddress = string;

export type MailAction = {
  id: string;
  label: string;
  target: string;
  definitionId?: string;
  operation: string;
  role?: string;
  disabledReason?: string;
  undoActionId?: string;
  values?: Record<string, unknown>;
};

export type MailAccount = {
  address: MailAddress;
  name: string;
  color?: string;
  canRead: boolean;
  canSend: boolean;
  repairActionId?: string;
};

export type Mailbox = {
  address: MailAddress;
  label: string;
  accountAddress?: MailAddress;
  messageAddresses: MailAddress[];
};

export type MailMessage = {
  address: MailAddress;
  threadAddress: MailAddress;
  accountAddress: MailAddress;
  mailboxAddresses: MailAddress[];
  sender: string;
  recipients: string[];
  subject: string;
  preview: string;
  body?: string;
  bodyUnavailableReason?: string;
  sentAt?: string;
  unread: boolean;
  attachmentCount: number;
  actionIds: string[];
  sourceLink?: MailSourceLink;
};

export type MailThread = {
  address: MailAddress;
  messageAddresses: MailAddress[];
  actionIds: string[];
  sourceLink?: MailSourceLink;
};

export type MailDraft = {
  address: MailAddress;
  accountAddress: MailAddress;
  threadAddress?: MailAddress;
  to: string[];
  subject: string;
  body: string;
  actionIds: string[];
  status?: MailStatus;
};

export type MailSourceLink = {
  address: MailAddress;
  label: string;
};

export type MailStatus = {
  address: MailAddress;
  accountAddress?: MailAddress;
  messageAddress?: MailAddress;
  label: string;
  actionIds: string[];
};

export type MailWorkItemFeed = {
  accounts?: unknown[];
  mailboxes?: unknown[];
  messages?: unknown[];
  threads?: unknown[];
  drafts?: unknown[];
  actions?: unknown[];
  statuses?: unknown[];
  selectedAddress?: unknown;
  selectedMailboxAddress?: unknown;
  loading?: unknown;
};

export type MailWorkspace = {
  accounts: MailAccount[];
  mailboxes: Mailbox[];
  messageRows: MailMessage[];
  selectedThread: {
    thread: MailThread;
    messages: MailMessage[];
    actions: MailAction[];
    sourceLink?: MailSourceLink;
  } | null;
  drafts: MailDraft[];
  actionsById: Record<string, MailAction>;
  statuses: MailStatus[];
  selectedAddress: string | null;
  selectedMailboxAddress: string | null;
  loading: boolean;
  emptyReason: 'no-accounts' | 'no-messages' | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOr(value: unknown, fallback: string): string {
  const normalized = text(value).trim();
  return normalized || fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sourceLink(value: unknown): MailSourceLink | undefined {
  if (!isRecord(value)) return undefined;
  const address = text(value.address);
  if (!address) return undefined;
  return { address, label: textOr(value.label, 'Source message') };
}

// A connected service is eligible to render as a MailAccount when its scope grant
// pattern-matches a mail capability (any scope containing "mail:read" or "mail:send",
// e.g. "vendor-mail:read", "vendor:mail:send") and its connection status reads as
// connected. This is a substring pattern match, not a provider allow-list, so a new
// mail-capable vendor becomes eligible with zero code change the moment its scope
// facts say so.
const MAIL_SCOPE_PATTERN = /mail:(read|send)/i;
const CONNECTED_STATUS_REF = 'connection-status:connected';

function isMailCapableConnection(item: Record<string, unknown>): boolean {
  const statusRef = item.statusRef;
  if (typeof statusRef === 'string' && statusRef && statusRef !== CONNECTED_STATUS_REF) return false;

  const scopeRefs = item.scopeRefs;
  if (Array.isArray(scopeRefs) && scopeRefs.length > 0) {
    return scopeRefs.some((scope) => typeof scope === 'string' && MAIL_SCOPE_PATTERN.test(scope));
  }

  // No raw eligibility facts present (e.g. a hand-authored seed account) — admit by default.
  return true;
}

export function readMailWorkspace(feed: MailWorkItemFeed = {}): MailWorkspace {
  const accounts = (feed.accounts ?? [])
    .filter(isRecord)
    .filter(isMailCapableConnection)
    .map((item): MailAccount => ({
      address: text(item.address),
      name: textOr(item.name, 'Account'),
      color: text(item.color) || undefined,
      canRead: bool(item.canRead, true),
      canSend: bool(item.canSend, true),
      repairActionId: text(item.repairActionId) || undefined,
    }))
    .filter((account) => account.address)
    .sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address));

  const actions = (feed.actions ?? [])
    .filter(isRecord)
    .map((item): MailAction => ({
      id: text(item.id),
      label: textOr(item.label, 'Action'),
      target: text(item.target),
      definitionId: text(item.definition_id) || text(item.definitionId) || undefined,
      operation: text(item.operation),
      role: text(item.role) || undefined,
      disabledReason: text(item.disabledReason) || undefined,
      undoActionId: text(item.undoActionId) || undefined,
      values: isRecord(item.values) ? item.values : undefined,
    }))
    .filter((action) => action.id && action.target && action.operation)
    ;

  const actionsById = Object.fromEntries(actions
    .map((action) => [action.id, action]));

  const explicitMailboxes = (feed.mailboxes ?? [])
    .filter(isRecord)
    .map((item): Mailbox => ({
      address: text(item.address),
      label: textOr(item.label, 'Mailbox'),
      accountAddress: text(item.accountAddress) || undefined,
      messageAddresses: textList(item.messageAddresses),
    }))
    .filter((mailbox) => mailbox.address);
  const mailboxes = explicitMailboxes.length > 0 || accounts.length === 0
    ? explicitMailboxes
    : accounts.flatMap((account) => [
        {
          address: `${account.address}:mailbox:inbox`,
          label: `${account.name} inbox`,
          accountAddress: account.address,
          messageAddresses: [],
        },
        {
          address: `${account.address}:mailbox:sent`,
          label: `${account.name} sent`,
          accountAddress: account.address,
          messageAddresses: [],
        },
      ]);

  const messages = (feed.messages ?? [])
    .filter(isRecord)
    .map((item): MailMessage => ({
      address: text(item.address),
      threadAddress: text(item.threadAddress),
      accountAddress: text(item.accountAddress),
      mailboxAddresses: textList(item.mailboxAddresses),
      sender: textOr(item.sender, 'Unknown sender'),
      recipients: textList(item.recipients),
      subject: textOr(item.subject, 'No subject'),
      preview: text(item.preview),
      body: text(item.body) || undefined,
      bodyUnavailableReason: text(item.bodyUnavailableReason) || undefined,
      sentAt: text(item.sentAt) || undefined,
      unread: bool(item.unread),
      attachmentCount: typeof item.attachmentCount === 'number' ? item.attachmentCount : 0,
      actionIds: textList(item.actionIds),
      sourceLink: sourceLink(item.sourceLink),
    }))
    .filter((message) => message.address && message.threadAddress && message.accountAddress);

  const messagesByAddress = Object.fromEntries(messages.map((message) => [message.address, message]));

  const threads = (feed.threads ?? [])
    .filter(isRecord)
    .map((item): MailThread => ({
      address: text(item.address),
      messageAddresses: textList(item.messageAddresses),
      actionIds: textList(item.actionIds),
      sourceLink: sourceLink(item.sourceLink),
    }))
    .filter((thread) => thread.address);

  const threadByAddress = Object.fromEntries(threads.map((thread) => [thread.address, thread]));
  const selectedAddress = text(feed.selectedAddress) || null;
  const selectedMailboxAddress = text(feed.selectedMailboxAddress) || null;
  const selectedMessage = selectedAddress ? messagesByAddress[selectedAddress] : undefined;
  const selectedThreadAddress = selectedMessage?.threadAddress ?? selectedAddress;
  const selectedThread = selectedThreadAddress ? threadByAddress[selectedThreadAddress] : undefined;
  const selectedThreadMessages = selectedThread
    ? selectedThread.messageAddresses.map((address) => messagesByAddress[address]).filter(Boolean)
    : [];

  const visibleMessageRows = selectedMailboxAddress
    ? messages.filter((message) => message.mailboxAddresses.includes(selectedMailboxAddress))
    : messages;

  const drafts = (feed.drafts ?? [])
    .filter(isRecord)
    .map((item): MailDraft => ({
      address: text(item.address),
      accountAddress: text(item.accountAddress),
      threadAddress: text(item.threadAddress) || undefined,
      to: textList(item.to),
      subject: text(item.subject),
      body: text(item.body),
      actionIds: textList(item.actionIds),
      status: isRecord(item.status) ? {
        address: text(item.status.address),
        accountAddress: text(item.status.accountAddress) || undefined,
        messageAddress: text(item.status.messageAddress) || undefined,
        label: textOr(item.status.label, 'Draft saved'),
        actionIds: textList(item.status.actionIds),
      } : undefined,
    }))
    .filter((draft) => draft.address && draft.accountAddress);

  const statuses = (feed.statuses ?? [])
    .filter(isRecord)
    .map((item): MailStatus => ({
      address: text(item.address),
      accountAddress: text(item.accountAddress) || undefined,
      messageAddress: text(item.messageAddress) || undefined,
      label: textOr(item.label, 'Needs attention'),
      actionIds: textList(item.actionIds),
    }))
    .filter((status) => status.address)
    .filter((status) => !(accounts.length > 0 && status.address === 'email-client:status:connect-account'));

  return {
    accounts,
    mailboxes,
    messageRows: visibleMessageRows,
    selectedThread: selectedThread ? {
      thread: selectedThread,
      messages: selectedThreadMessages,
      actions: selectedThread.actionIds.map((id) => actionsById[id]).filter(Boolean),
      sourceLink: selectedThread.sourceLink ?? selectedThreadMessages.find((message) => message.sourceLink)?.sourceLink,
    } : null,
    drafts,
    actionsById,
    statuses,
    selectedAddress,
    selectedMailboxAddress,
    loading: bool(feed.loading),
    emptyReason: accounts.length === 0 ? 'no-accounts' : visibleMessageRows.length === 0 ? 'no-messages' : null,
  };
}
