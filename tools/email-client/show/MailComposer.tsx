import React from 'react';
import { PlaceableSurfaceHost } from '@/packages/ui';
import type { MailAccount, MailAction, MailDraft, MailMessage } from '../read-data/read-mail-workspace.ts';

type MailComposerProps = {
  account?: MailAccount;
  draft?: MailDraft;
  message?: MailMessage;
  sendAction?: MailAction;
  scheduleAction?: MailAction;
  onSend(action: MailAction, draft?: MailDraft, message?: MailMessage): void;
  onSchedule(action: MailAction, draft?: MailDraft, message?: MailMessage): void;
  onClose(): void;
};

export function MailComposer({ account, draft, message, sendAction, scheduleAction, onSend, onSchedule, onClose }: MailComposerProps) {
  // Build surface_input: thread atoms for reply context, send/schedule action addresses, draft ref
  const surfaceInput = React.useMemo(
    () => ({
      thread_atoms: message
        ? [
            {
              role: 'sender',
              sender_address: message.sender,
              subject: message.subject,
              body: message.body || message.preview || '',
              timestamp: message.sentAt || '',
            },
          ]
        : [],
      seed_source: draft?.body
        ? { draft_body: draft.body, to_recipients: draft.to, subject: draft.subject }
        : null,
      on_send_action_address: sendAction?.id || null,
      on_schedule_action_address: scheduleAction?.id || null,
      send_from_account: account?.name || null,
      on_close_callback: null, // Handled by ThreadReader state
    }),
    [message, draft, sendAction, scheduleAction, account],
  );

  return (
    <PlaceableSurfaceHost
      packageName="documents"
      entryName="mail-composer"
      surfaceInput={surfaceInput}
      fill={false}
      interactive={true}
    />
  );
}
