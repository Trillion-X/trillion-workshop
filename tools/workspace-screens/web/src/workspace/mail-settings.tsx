// src/workspace/mail-settings.tsx
//
// PURPOSE
//   The Email page of Settings (settings-panels.json item `email`, drawn by settings-pages.tsx): the signature added to
//   messages written in Mail (kept in Gmail, on the connected account's primary address) with a Save, and "When do you
//   want to be reminded of an email?" with its Types of email choice (kept as the person's own `mail-preferences`).
//   Mail's rail opens this page; Mail also reads the signature here (`useMailSignature`) to open new messages with it.
//   Words and choices are mail-settings.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The signature is Gmail's: this page shows what Gmail holds as plain lines, says when saving would drop formatting,
//      and saves through the account-bound Gmail tool road. An empty signature clears it.
//   2. The reminder kinds are rows of mail-settings.json; a new kind is a row, not a change here.
//   3. A change is saved as it is made (a kind) or on Save (the signature), and each says whether it was kept.
//   4. Every control is a shared part; this file writes no markup and no appearance.
//   5. A read that is still going, one that failed and "no Google account" are three different pages.

import * as React from 'react';
import { ActionMenu, Button, Container, NamedIcon, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text, Textarea } from '../../parts/ui';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { updateWorkspacePreferenceDurably, useWorkspacePreference } from './records';
import { mailAccountKey, readMailAccounts, runAsAccount, type MailAccount } from './mail-accounts';
import { primaryGmailSendAs, signatureHtml, signatureText, type GmailSendAs } from './gmail-email';
import type { Ran } from './workshop-tool-api';
import settings from './mail-settings.json';

const words = settings.words;
export type MailPreferences = { remind_kinds?: string[] };
/** The kinds of email a reminder covers: the person's choice, else every kind. */
export const useReminderKinds = (): string[] => useWorkspacePreference<MailPreferences>(settings.preference_key)?.remind_kinds ?? settings.default_kinds;

export type SignatureState = { text: string; lossy: boolean } | 'unavailable';
const LIST_SEND_AS = 'tool:google-account-list_send_as';
const UPDATE_SIGNATURE = 'tool:google-account-update_send_as_signature';
const CLEAR_SIGNATURE = 'tool:google-account-clear_primary_signature';
type Requester = (toolId: string, input: Record<string, unknown>) => Promise<Ran<unknown>>;

/** The signature Gmail holds for the account the requester is bound to (null while reading, 'unavailable' when Gmail did not give one) and the way to save it. */
export function useMailSignature(requester: Requester | null): { signature: SignatureState | null; save: (text: string) => Promise<void> } {
  const [signature, setSignature] = React.useState<SignatureState | null>(null);
  const sendAs = React.useRef('');
  const read = React.useCallback(async () => {
    if (!requester) return;
    const run = await requester(LIST_SEND_AS, {});
    const answer = run.result as { sendAs?: GmailSendAs[] } | undefined;
    if (!answer) throw new Error(words.signature_unavailable);
    const primary = primaryGmailSendAs(answer.sendAs);
    sendAs.current = primary.sendAsEmail ?? '';
    setSignature(signatureText(primary.signature ?? ''));
  }, [requester]);
  React.useEffect(() => {
    if (!requester) return;
    let active = true;
    setSignature(null);
    void read().catch(() => { if (active) setSignature('unavailable'); });
    return () => { active = false; };
  }, [read]);
  const save = async (text: string) => {
    if (!requester || !sendAs.current) throw new Error(words.signature_failed);
    if (text.trim()) await requester(UPDATE_SIGNATURE, { send_as_email: sendAs.current, signature: signatureHtml(text) });
    else await requester(CLEAR_SIGNATURE, { send_as_email: sendAs.current });
    await read();
  };
  return { signature, save };
}

/** The Email page of Settings: pick the Google account (when there are several), then its signature and the reminder kinds. */
export function EmailSettingsPage() {
  const [accounts, setAccounts] = React.useState<MailAccount[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [key, setKey] = React.useState('');
  React.useEffect(() => {
    let live = true;
    setFailed(false);
    readMailAccounts().then(rows => { if (live) { setAccounts(rows); setKey(current => rows.some(row => mailAccountKey(row) === current) ? current : rows[0] ? mailAccountKey(rows[0]) : ''); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt]);
  const account = accounts?.find(row => mailAccountKey(row) === key) ?? null;
  const requester = React.useCallback((toolId: string, input: Record<string, unknown>) => runAsAccount(account!, toolId, input), [account?.connection_id, account?.connected_at]);
  const { signature, save } = useMailSignature(account ? requester : null);
  return <Container layout="vertical" gap="lg" padding="lg" data-settings-page="email">
    <Text as="h1" variant="heading-lg" className="page-title m-0">{words.title}</Text>
    <ReminderSettings />
    {failed ? <Container layout="vertical" gap="sm" role="alert"><Text variant="body" color="secondary">{words.failed}</Text><Container layout="horizontal"><Button variant="ghost" onClick={() => setAttempt(count => count + 1)}>{words.retry}</Button></Container></Container>
      : accounts === null ? <Text variant="body" color="secondary">{words.loading}</Text>
      : !account ? <Text variant="body" color="secondary">{words.no_account}</Text>
      : <>
        {accounts.length > 1 ? <Select value={key} onValueChange={value => { if (typeof value === 'string') setKey(value); }}><SelectTrigger aria-label={words.account}><SelectValue>{account.account_label}</SelectValue></SelectTrigger><SelectPopup>{accounts.map(row => <SelectItem key={mailAccountKey(row)} value={mailAccountKey(row)}>{row.account_label}</SelectItem>)}</SelectPopup></Select> : null}
        <SignatureSettings signature={signature} onSave={save} />
      </>}
  </Container>;
}

function SignatureSettings({ signature, onSave }: { signature: SignatureState | null; onSave: (text: string) => Promise<void> }) {
  const first = signature === null || signature === 'unavailable' ? '' : signature.text;
  const [text, setText] = React.useState(first);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => { setText(first); }, [first]);
  const tooLong = text.length > settings.most_signature_chars;
  const save = async () => {
    if (saving || tooLong) return;
    setSaving(true);
    try { await onSave(text); notify(text.trim() ? words.signature_saved : words.signature_cleared, { kind: 'success' }); }
    catch (cause) { notify(errorWords(cause, words.signature_failed), { kind: 'error' }); }
    finally { setSaving(false); }
  };
  return <Container layout="vertical" gap="sm" data-mail-signature="">
    <Text variant="heading-xs">{words.signature_title}</Text>
    <Text variant="body-sm" color="muted">{words.signature_help}</Text>
    {signature === null ? <Text variant="body-sm" color="muted">{words.loading}</Text> : signature === 'unavailable' ? <Text variant="body-sm" color="error">{words.signature_unavailable}</Text> : <>
      <Textarea aria-label={words.signature_label} rows={6} value={text} onChange={event => setText(event.target.value)} disabled={saving} />
      {signature.lossy ? <Text variant="caption" color="muted">{words.signature_lossy}</Text> : null}
      {tooLong ? <Text variant="caption" color="error" role="alert">{words.signature_too_long.replace('{most}', String(settings.most_signature_chars))}</Text> : null}
      <Container layout="horizontal" gap="sm" alignItems="center"><Button size="sm" variant="primary" disabled={saving || tooLong || text === first} onClick={() => save()}>{saving ? words.saving : words.signature_save}</Button></Container>
    </>}
  </Container>;
}

function ReminderSettings() {
  const kinds = useReminderKinds();
  const chooseKind = (id: string) => {
    const next = kinds.includes(id) ? kinds.filter(kind => kind !== id) : [...kinds, id];
    void updateWorkspacePreferenceDurably<MailPreferences>(settings.preference_key, current => ({ ...(current as MailPreferences | undefined), remind_kinds: settings.kinds.map(row => row.id).filter(kind => next.includes(kind)) }))
      .then(() => notify(words.reminder_saved, { kind: 'success' }))
      .catch(cause => notify(errorWords(cause, words.reminder_failed), { kind: 'error' }));
  };
  const chosen = settings.kinds.filter(row => kinds.includes(row.id)).map(row => row.label).join(', ') || words.reminder_none;
  return <Container layout="vertical" gap="sm" data-mail-reminders="">
    <Text variant="heading-xs">{words.reminder_title}</Text>
    <Text variant="body-sm" color="muted">{words.reminder_help}</Text>
    <Text variant="label" color="muted">{words.reminder_kinds}</Text>
    <ActionMenu label={words.reminder_kinds} iconTrigger={false} triggerContent={<>{chosen}<NamedIcon name="ChevronDown" size="xs" /></>}
      items={settings.kinds.map(row => ({ id: row.id, label: row.label, icon: 'Check', checked: kinds.includes(row.id), keepOpen: true }))} onAction={chooseKind} />
  </Container>;
}
