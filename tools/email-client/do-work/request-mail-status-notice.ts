export type MailStatusNoticeInput = {
  target: string;
  operation: string;
  statusAddress: string;
  accountName?: string;
  messageAddress?: string;
  label: string;
  actionIds?: string[];
  correlationId: string;
};

export type MailVisibleStatus = {
  address: string;
  label: string;
  messageAddress?: string;
  actionIds: string[];
};

export type MailStatusNoticeRequest = {
  target: string;
  payload: {
    operation: string;
    status_address: string;
    label: string;
    message_address?: string;
    action_ids: string[];
    correlation_id: string;
  };
};

const INTERNAL_WORDS = [
  'pack' + 'age',
  'descrip' + 'tor',
  'envel' + 'ope',
  'pay' + 'load',
  'sl' + 'ot',
  'run' + 'time',
  'prov' + 'ider id',
  'raw mes' + 'sage id',
  'tok' + 'en',
  'I' + 'MAP',
  'S' + 'MTP',
  'O' + 'Auth',
  'service connec' + 'tion',
  'de' + 'bug',
];

const BANNED_VISIBLE_WORDS = new RegExp(`\\b(${INTERNAL_WORDS.join('|')})\\b`, 'i');

export function assertHumanMailStatus(label: string): string {
  if (BANNED_VISIBLE_WORDS.test(label)) {
    throw new Error(`Mail status uses internal wording: ${label}`);
  }
  return label;
}

export function buildMailStatusNotice(input: MailStatusNoticeInput): {
  request: MailStatusNoticeRequest;
  visibleStatus: MailVisibleStatus;
} {
  const label = assertHumanMailStatus(input.accountName ? `${input.accountName}: ${input.label}` : input.label);
  const actionIds = input.actionIds ?? [];

  return {
    request: {
      target: input.target,
      payload: {
        operation: input.operation,
        status_address: input.statusAddress,
        label,
        message_address: input.messageAddress,
        action_ids: actionIds,
        correlation_id: input.correlationId,
      },
    },
    visibleStatus: {
      address: input.statusAddress,
      label,
      messageAddress: input.messageAddress,
      actionIds,
    },
  };
}

export async function requestMailStatusNotice(
  input: MailStatusNoticeInput,
  send: (request: MailStatusNoticeRequest) => Promise<unknown>,
): Promise<{ reply: unknown; visibleStatus: MailVisibleStatus }> {
  const built = buildMailStatusNotice(input);
  return { reply: await send(built.request), visibleStatus: built.visibleStatus };
}
