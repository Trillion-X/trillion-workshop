// The mail screen uses Gmail's declared read tools through the same Workshop route as AI callers. This screen owns
// only its temporary search and selection state; Gmail remains the source of truth for every message.
import * as React from 'react';
import { AnchoredOverlay, Button, Container, Input, Textarea, Text, InboxThreePane, NamedIcon, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../../parts/ui';
import { EmailThread, EmailView, type EmailThreadEntry } from '../../parts/ui/show/email-view';
import { SearchField } from '../../parts/ui/show/search-field/SearchField';
import { DisplayMark } from '../../parts/ui/show/display-mark';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { ArrangedContents } from '../../parts/screen-arrangement/show/ArrangedContents';
import emailScreenData from './email-screen.json';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import type { Ran } from './workshop-tool-api';
import { gmailHeader, gmailDraftNeedsOriginal, gmailMessageUrl, gmailRawMessage, gmailAttachments, gmailForwardBody, gmailLinks, gmailParticipants, gmailRecipients, gmailThreadView, plainTextBody, replyAllRecipients, splitEmailAddresses, type GmailMessage, type GmailPayload, type GmailThreadView } from './gmail-email';
import { fill, MailActionBar, MailCardActions, type MailBarProps, type MailPanel, type MailPlan } from './mail-action-bar';
import { useMailSignature } from './mail-settings';
import { mailAccountKey, readMailAccounts, runAsAccount, type MailAccount } from './mail-accounts';
import { openScreenOn } from './open-screen';
import { useMailKeyOf, useMailKeys } from './mail-keys';
import { changeMailTask, completeMailTask, duplicateMailTask, ensureMailTask, findMailTask, mailSourceId, readTaskLists, scheduleMailTask, unscheduleMailTask, type MailTask } from './mail-task';
import type { CommandTable } from '../../parts/ui/show/command-table/command-table';
import commandData from './mail-commands.json';
import actionData from './mail-actions.json';

type DraftSummary = { id: string; message?: { id?: string; threadId?: string; snippet?: string; payload?: GmailPayload } };
type SearchResponse = { messages?: { id: string; threadId?: string }[]; drafts?: DraftSummary[]; nextPageToken?: string; resultSizeEstimate?: number };
type MailboxResponse = { emailAddress?: string };
type HeaderResponse = GmailMessage;
type FullResponse = GmailMessage & { draftId?: string };
type SearchRow = { id: string; draftId?: string; threadId?: string; header?: GmailPayload; labels?: string[]; snippet?: string; loading?: boolean; failed?: boolean };
type GmailFolder = { id: string; label: string; query: string; icon: string };

const FOLDERS: GmailFolder[] = [
  { id: 'inbox', label: 'Inbox', query: 'in:inbox', icon: 'Inbox' },
  { id: 'starred', label: 'Starred', query: 'is:starred', icon: 'Star' },
  { id: 'sent', label: 'Sent', query: 'in:sent', icon: 'Send' },
  { id: 'drafts', label: 'Drafts', query: 'in:drafts', icon: 'FileEdit' },
  { id: 'trash', label: 'Trash', query: 'in:trash', icon: 'Trash2' },
  { id: 'all', label: 'All mail', query: 'in:anywhere -in:spam -in:trash', icon: 'MailOpen' },
];
const SEARCH = 'tool:google-account-search_mail';
const MAILBOX = 'tool:google-account-find_my_mailbox';
const HEADERS = 'tool:google-account-read_mail_headers';
const READ = 'tool:google-account-read_a_mail';
const MODIFY = 'tool:google-account-modify_mail';
const TRASH = 'tool:google-account-trash_mail';
const RESTORE = 'tool:google-account-restore_mail';
const THREAD = 'tool:google-account-read_mail_thread';
const MODIFY_THREAD = 'tool:google-account-modify_mail_thread';
const TRASH_THREAD = 'tool:google-account-trash_mail_thread';
const RESTORE_THREAD = 'tool:google-account-restore_mail_thread';
const CREATE_DRAFT = 'tool:google-account-create_draft';
const UPDATE_DRAFT = 'tool:google-account-update_draft';
const SEND_DRAFT = 'tool:google-account-send_draft';
const LIST_DRAFTS = 'tool:google-account-list_drafts';
const READ_DRAFT = 'tool:google-account-read_draft';
const DELETE_DRAFT = 'tool:google-account-delete_draft';
const GOOGLE_CONNECT = '/work/connect/google-account';
const GOOGLE_CONNECTIONS = '/connections';
const CONNECT_TASK = '/work/api/calendar/tasks';
const BATCH_SIZE = 12;
const mailCommands = commandData as CommandTable;
const mailWords = actionData.words;
const threadMost = actionData.thread.most_messages;
const mailComposition = emailScreenData.composition;

const when = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
};
const toIso = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const headerOf = (row: SearchRow, name: string) => gmailHeader(row.header, name);
const mailState = (run: Ran<unknown>) => run.error ? errorWords(new Error(run.error)) : 'Gmail did not return this message.';
/** The conversation a message is in; Gmail names it on every message it reads. */
const threadIdOf = (message: GmailMessage): string => {
  if (!message.threadId) throw new Error(mailWords.thread_missing);
  return message.threadId;
};
const addressOnly = (value: string) => /<([^>]+)>\s*$/.exec(value)?.[1]?.trim() ?? value.trim();


/** What a loaded inbox message says about itself, for turning mail into todos (calendar-task-messages.mjs reads these facts). */
export type MailMessageFacts = { id: string; subject: string; from: string; labels: string[]; list_unsubscribe: boolean; has_invite: boolean; url: string };
type EmailSurfaceProps = { presentation?: 'full' | 'calendar'; enabled?: boolean; composeRequest?: number; onDetailChange?: (open: boolean) => void; onCountChange?: (count: { count: number; more: boolean }) => void; onInboxMessages?: (messages: MailMessageFacts[], account: { connection_id: string }) => void };

const NO_ACCOUNT = 'Connect a Google account to open your mail.';

/** The first read of the accounts goes through the shared screen-state lifecycle: loading rows, then the failed state
 *  with Try again, then the mail. A later re-check (Try again beside the mail) keeps the mail drawn. Mail that is not
 *  enabled reads nothing. */
function EmailScreen(props: EmailSurfaceProps) {
  return props.enabled === false ? <Mail {...props} first={null} /> : <MailWithAccounts {...props} />;
}

function MailWithAccounts(props: EmailSurfaceProps) {
  const loaded = useScreenLoad<MailAccount[]>('mail-accounts', { loading: { label: 'Opening your mail', layout: 'rows' }, read: readMailAccounts, failed: refusal('Your Google accounts could not be read') });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <Mail {...props} first={loaded.value} />;
}

function Mail({ presentation = 'full', composeRequest = 0, onDetailChange, onCountChange, onInboxMessages, first }: EmailSurfaceProps & { first: MailAccount[] | null }) {
  const compact = presentation === 'calendar';
  const [accounts, setAccounts] = React.useState<MailAccount[]>(first ?? []);
  const [account, setAccount] = React.useState<MailAccount | null>(first?.length === 1 ? first[0] : null);
  const requester = React.useCallback((toolId: string, input: Record<string, unknown>, requestKey?: string) => {
    if (!account) return Promise.reject(new Error('Choose a connected Google account first.'));
    return runAsAccount(account, toolId, input, requestKey);
  }, [account?.connection_id, account?.connected_at]);
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const optionsAnchor = React.useRef<HTMLButtonElement | null>(null);
  const [width, setWidth] = React.useState(typeof window === 'undefined' ? 1200 : window.innerWidth);
  const [folder, setFolder] = React.useState(FOLDERS[0]);
  const [query, setQuery] = React.useState(FOLDERS[0].query);
  const [rows, setRows] = React.useState<SearchRow[]>([]);
  const [nextPage, setNextPage] = React.useState<string | undefined>();
  const [queuedRows, setQueuedRows] = React.useState<SearchRow[]>([]);
  React.useEffect(() => { onCountChange?.({ count: rows.length, more: Boolean(queuedRows.length || nextPage) }); }, [rows.length, queuedRows.length, nextPage, onCountChange]);
  const [selectedId, setSelectedId] = React.useState('');
  const [selected, setSelected] = React.useState<FullResponse | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  const [error, setError] = React.useState(first && !first.length ? NO_ACCOUNT : '');
  const [taskTitle, setTaskTitle] = React.useState('');
  const [taskState, setTaskState] = React.useState('');
  const [taskBusy, setTaskBusy] = React.useState(false);
  const [connectedError, setConnectedError] = React.useState(Boolean(first && !first.length));
  const [folderSelected, setFolderSelected] = React.useState(true);
  const [mailbox, setMailbox] = React.useState('');
  // The inbox, once its messages have been read, is told to whoever turns mail into todos (the Calendar's Email list).
  React.useEffect(() => {
    if (!onInboxMessages || !account || folder.id !== 'inbox' || !rows.length || rows.some(row => row.loading)) return;
    onInboxMessages(rows.filter(row => row.header && !row.failed && !row.draftId).map(row => ({
      id: `${account.connection_id}:${row.id}`, subject: headerOf(row, 'subject'), from: headerOf(row, 'from'), labels: row.labels ?? [],
      list_unsubscribe: Boolean(headerOf(row, 'list-unsubscribe')), has_invite: /text\/calendar/i.test(headerOf(row, 'content-type')), url: gmailMessageUrl(row.id, mailbox),
    })), { connection_id: account.connection_id });
  }, [rows, folder.id, account?.connection_id, mailbox, onInboxMessages]);
  const [replyOpen, setReplyOpen] = React.useState(false);
  const [draftTo, setDraftTo] = React.useState('');
  const [draftSubject, setDraftSubject] = React.useState('');
  const [draftBody, setDraftBody] = React.useState('');
  const [draftCc, setDraftCc] = React.useState('');
  const [draftThread, setDraftThread] = React.useState<{ threadId?: string; inReplyTo?: string; references?: string }>({});
  const [task, setTask] = React.useState<MailTask | null>(null);
  const [thread, setThread] = React.useState<GmailThreadView | null>(null);
  const [threadFailed, setThreadFailed] = React.useState(false);
  const [taskLists, setTaskLists] = React.useState<{ id: string; title: string }[]>([]);
  const [panel, setPanel] = React.useState<MailPanel>(null);
  const [draftId, setDraftId] = React.useState('');
  React.useEffect(() => { onDetailChange?.(Boolean(selectedId || replyOpen)); }, [selectedId, replyOpen, onDetailChange]);
  const [draftNeedsGmail, setDraftNeedsGmail] = React.useState(false);
  const [mailActionState, setMailActionState] = React.useState('');
  const [mailActionBusy, setMailActionBusy] = React.useState(false);
  const [accountReadFailed, setAccountReadFailed] = React.useState(false);
  const [accountReadBusy, setAccountReadBusy] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const accountReadGeneration = React.useRef(0);
  const currentFolder = React.useRef(folder);
  const draftRequest = React.useRef({ fingerprint: '', key: '' });
  const sendRequest = React.useRef({ draftId: '', key: '' });
  const searchGeneration = React.useRef(0);
  const readGeneration = React.useRef(0);
  const needsGmailToPreserve = gmailDraftNeedsOriginal;

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => setWidth(Math.round(entries[0]?.contentRect.width ?? window.innerWidth)));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const loadSearchRows = React.useCallback(async (ids: SearchRow[], generation: number) => {
    const batch = ids.slice(0, BATCH_SIZE).map(row => ({ ...row, loading: true }));
    if (generation !== searchGeneration.current) return;
    setQueuedRows(ids.slice(BATCH_SIZE));
    setRows(batch);
    let next = 0;
    const workers = Array.from({ length: Math.min(4, batch.length) }, async () => {
      while (next < batch.length && generation === searchGeneration.current) {
        const row = batch[next++];
        try {
          const run = await requester(row.draftId ? READ_DRAFT : HEADERS, row.draftId ? { draft_id: row.draftId } : { message_id: row.id });
          if (!run.result) throw new Error(mailState(run));
          const output = run.result as HeaderResponse | { message: HeaderResponse };
          const message = 'message' in output ? output.message : output;
          if (generation === searchGeneration.current) setRows(current => current.map(item => item.id === row.id ? { ...item, header: message.payload, labels: message.labelIds, snippet: message.snippet ?? item.snippet, loading: false, failed: false } : item));
        } catch {
          if (generation === searchGeneration.current) setRows(current => current.map(item => item.id === row.id ? { ...item, loading: false, failed: true } : item));
        }
      }
    });
    await Promise.all(workers);
  }, [requester]);

  const runSearch = React.useCallback(async (searchText: string, folderRow?: GmailFolder, pageToken?: string) => {
    const q = searchText.trim() || 'in:inbox';
    const generation = pageToken ? searchGeneration.current : ++searchGeneration.current;
    if (!pageToken) {
      readGeneration.current += 1;
      setSearching(true); setRows([]); setQueuedRows([]); setNextPage(undefined); setError(''); setConnectedError(false);
      if (!sendRequest.current.draftId) { setSelectedId(''); setSelected(null); setReplyOpen(false); }
      if (folderRow) { currentFolder.current = folderRow; setFolder(folderRow); setFolderSelected(true); }
    } else setLoadingMore(true);
    try {
      const activeFolder = folderRow ?? currentFolder.current;
      const isDraftFolder = activeFolder.id === 'drafts';
      const run = await requester(isDraftFolder ? LIST_DRAFTS : SEARCH, isDraftFolder
        ? { ...(q !== 'in:drafts' ? { query: q } : {}), ...(pageToken ? { page_token: pageToken } : {}) }
        : { query: q, ...(pageToken ? { page_token: pageToken } : {}) });
      if (generation !== searchGeneration.current) return;
      if (!run.result) {
        const message = mailState(run);
        setError(message);
        setConnectedError(/connect|credential|google-account|authorization/i.test(message));
        return;
      }
      const result = run.result as SearchResponse;
      const ids: SearchRow[] = isDraftFolder
        ? (result.drafts ?? []).filter(draft => draft.id).map(draft => ({ id: draft.message?.id ?? draft.id, draftId: draft.id, threadId: draft.message?.threadId, header: draft.message?.payload, snippet: draft.message?.snippet }))
        : (result.messages ?? []).filter(message => message.id).map(message => ({ id: message.id, threadId: message.threadId }));
      setNextPage(result.nextPageToken);
      if (pageToken) {
        setQueuedRows(current => [...current, ...ids]);
      } else {
        await loadSearchRows(ids, generation);
      }
      if (!ids.length && !pageToken) setRows([]);
    } catch (cause) {
      const message = errorWords(cause, 'Gmail could not search your mail.');
      if (generation === searchGeneration.current) { setError(message); setConnectedError(/connect|credential|google-account|authorization/i.test(message)); }
    } finally { if (generation === searchGeneration.current) { setSearching(false); setLoadingMore(false); } }
  }, [loadSearchRows, requester]);

  const loadAccounts = React.useCallback(async () => {
    const generation = ++accountReadGeneration.current;
    setAccountReadBusy(true);
    setAccountReadFailed(false);
    setError('');
    try {
      const connected = await readMailAccounts();
      if (generation !== accountReadGeneration.current) return;
      setAccounts(connected);
      setAccount(current => connected.length === 1 ? connected[0]
        : connected.find(row => current && mailAccountKey(row) === mailAccountKey(current)) ?? null);
      setConnectedError(!connected.length);
      if (!connected.length) setError(NO_ACCOUNT);
    } catch (cause) {
      if (generation === accountReadGeneration.current) {
        setAccountReadFailed(true);
        setError(errorWords(cause));
      }
    } finally {
      if (generation === accountReadGeneration.current) setAccountReadBusy(false);
    }
  }, []);
  // The first read is the lifecycle's (MailWithAccounts); a re-check that answers after this mail is gone is dropped.
  React.useEffect(() => () => { accountReadGeneration.current += 1; }, []);
  React.useEffect(() => {
    setMailbox('');
    if (account) { setQuery('in:inbox'); void runSearch('in:inbox', FOLDERS[0]); }
  }, [runSearch]);
  React.useEffect(() => {
    let active = true;
    if (!account) return;
    void requester(MAILBOX, {}).then(run => {
      const answer = run.result as MailboxResponse | undefined;
      if (active && answer?.emailAddress) setMailbox(answer.emailAddress);
    }).catch(() => {});
    return () => { active = false; };
  }, [requester]);

  const { signature } = useMailSignature(account ? requester : null);
  /** What a new message opens with: the signature, set apart by the usual two dashes, when there is one. */
  const signatureBlock = () => signature && signature !== 'unavailable' && signature.text ? `\n\n-- \n${signature.text}` : '';

  const hydrateQueued = async () => {
    if (!queuedRows.length || loadingMore) return;
    const generation = searchGeneration.current;
    setLoadingMore(true);
    const batch = queuedRows.slice(0, BATCH_SIZE).map(row => ({ ...row, loading: true }));
    const following = queuedRows.slice(BATCH_SIZE);
    setQueuedRows(following);
    setRows(current => [...current, ...batch]);
    let next = 0;
    const workers = Array.from({ length: Math.min(4, batch.length) }, async () => {
      while (next < batch.length && generation === searchGeneration.current) {
        const row = batch[next++];
        try {
          const run = await requester(row.draftId ? READ_DRAFT : HEADERS, row.draftId ? { draft_id: row.draftId } : { message_id: row.id });
          if (!run.result) throw new Error(mailState(run));
          const output = run.result as HeaderResponse | { message: HeaderResponse };
          const message = 'message' in output ? output.message : output;
          if (generation === searchGeneration.current) setRows(current => current.map(item => item.id === row.id ? { ...item, header: message.payload, snippet: message.snippet ?? item.snippet, loading: false } : item));
        } catch {
          if (generation === searchGeneration.current) setRows(current => current.map(item => item.id === row.id ? { ...item, loading: false, failed: true } : item));
        }
      }
    });
    await Promise.all(workers);
    if (generation === searchGeneration.current) setLoadingMore(false);
  };

  const openMessage = async (id: string, sameThread = false) => {
    if (sendRequest.current.draftId) { setMailActionState('Check the previous send result before opening another draft.'); return; }
    const generation = ++readGeneration.current;
    const row = rows.find(item => item.id === id);
    setSelectedId(id); setSelected(null); setOpening(true); setTaskState(''); setTaskTitle(''); setError(''); setReplyOpen(false); setDraftId(''); setMailActionState(''); setTask(null); setPanel(null); setDraftCc(''); setDraftThread({});
    if (!sameThread) { setThread(null); setThreadFailed(false); }
    try {
      const run = await requester(row?.draftId ? READ_DRAFT : READ, row?.draftId ? { draft_id: row.draftId } : { message_id: id });
      if (!run.result) throw new Error(mailState(run));
      if (generation === readGeneration.current) {
        const result = run.result as FullResponse | { id: string; message: FullResponse };
        const opened = 'message' in result ? { ...result.message, draftId: result.id } : result;
        setSelected(opened);
        setTaskTitle(gmailHeader(opened.payload, 'subject') || '');
        if (opened.draftId) {
          setDraftId(opened.draftId);
          setDraftTo(gmailHeader(opened.payload, 'to'));
          setDraftCc(gmailHeader(opened.payload, 'cc'));
          setDraftSubject(gmailHeader(opened.payload, 'subject'));
          setDraftBody(plainTextBody(opened.payload) ?? '');
          setDraftThread({ threadId: opened.threadId, inReplyTo: gmailHeader(opened.payload, 'in-reply-to') || undefined, references: gmailHeader(opened.payload, 'references') || undefined });
          setDraftNeedsGmail(needsGmailToPreserve(opened.payload) || Boolean(gmailHeader(opened.payload, 'bcc')));
          setReplyOpen(true);
        } else if (account) {
          void findMailTask(mailSourceId(account.connection_id, id)).then(found => { if (generation === readGeneration.current) setTask(found); }).catch(() => {});
        }
      }
    } catch (cause) {
      if (generation === readGeneration.current) {
        setError(errorWords(cause, 'This message could not be opened.'));
        setConnectedError(/connect|credential|google-account|authorization/i.test(errorWords(cause)));
      }
    } finally { if (generation === readGeneration.current) setOpening(false); }
  };

  const actionRun = async <T,>(toolId: string, input: Record<string, unknown>, requestKey?: string): Promise<T> => {
    const run = await requester(toolId, input, requestKey);
    if (!run.result) throw new Error(mailState(run));
    return run.result as T;
  };

  const changeMail = async (action: 'done' | 'read' | 'unread' | 'star' | 'unstar' | 'trash' | 'restore') => {
    if (!selectedId || !selected || mailActionBusy) return;
    setMailActionBusy(true); setMailActionState('');
    try {
      let output: { labelIds?: string[] } = {};
      // Done and Delete are for the whole conversation, so they go to Gmail's conversation tools; read, unread and star are the open message's own.
      if (action === 'trash') await actionRun(TRASH_THREAD, { thread_id: threadIdOf(selected) });
      else if (action === 'restore') await actionRun(RESTORE_THREAD, { thread_id: threadIdOf(selected) });
      else if (action === 'done') await actionRun(MODIFY_THREAD, { thread_id: threadIdOf(selected), remove_label_ids: ['INBOX'] });
      else {
        const add = action === 'read' ? [] : action === 'unread' ? ['UNREAD'] : action === 'star' ? ['STARRED'] : [];
        const remove = action === 'read' ? ['UNREAD'] : action === 'unstar' ? ['STARRED'] : [];
        output = await actionRun(MODIFY, { message_id: selectedId, ...(add.length ? { add_label_ids: add } : {}), ...(remove.length ? { remove_label_ids: remove } : {}) });
      }
      if (Array.isArray(output.labelIds)) {
        const labelIds = output.labelIds;
        setSelected(current => current ? { ...current, labelIds } : current);
        setThread(current => current ? { ...current, messages: current.messages.map(message => message.id === selectedId ? { ...message, labelIds } : message) } : current);
      }
      const completes = action === 'done' && task !== null && task.status !== 'Done';
      if (completes && task) setTask(await completeMailTask(task.id));
      setMailActionState(action === 'done' ? (completes ? mailWords.planned.done_task : mailWords.planned.done) : action === 'trash' ? 'Moved to Gmail Trash.' : action === 'restore' ? 'Restored from Gmail Trash.' : action === 'star' ? 'Starred in Gmail.' : action === 'unstar' ? 'Unstarred in Gmail.' : action === 'read' ? 'Marked as read.' : 'Marked as unread.');
      if (action === 'done' || action === 'trash' || action === 'restore') void runSearch(query);
    } catch (cause) {
      const message = errorWords(cause, 'Gmail could not update this message.');
      setMailActionState(message);
      setConnectedError(/connect|credential|google-account|authorization|403|permission/i.test(message));
    } finally { setMailActionBusy(false); }
  };

  /** Opens the writing form with its fields: one road for a new message, a reply, a reply to all and a forward. */
  const openDraftWith = (fields: { to: string; cc: string; subject: string; body: string; thread: { threadId?: string; inReplyTo?: string; references?: string } }) => {
    if (sendRequest.current.draftId) { setMailActionState('Check the previous send result before opening another draft.'); return; }
    setDraftTo(fields.to); setDraftCc(fields.cc); setDraftSubject(fields.subject); setDraftBody(fields.body); setDraftThread(fields.thread);
    setDraftId(''); setDraftNeedsGmail(false); setReplyOpen(true); setMailActionState(''); setPanel(null);
  };

  const beginReply = (everyone: boolean) => {
    if (!selected?.payload) return;
    const subject = gmailHeader(selected.payload, 'subject');
    const people = replyAllRecipients(selected.payload, mailbox);
    const sender = gmailHeader(selected.payload, 'reply-to') || gmailHeader(selected.payload, 'from');
    openDraftWith({
      to: everyone && people.to.length ? people.to.join(', ') : addressOnly(sender), cc: everyone ? people.cc.join(', ') : '',
      subject: /^re:/i.test(subject) ? subject : `${mailWords.reply_subject_prefix}${subject}`, body: signatureBlock(),
      thread: { threadId: selected.threadId, inReplyTo: gmailHeader(selected.payload, 'message-id') || undefined, references: [gmailHeader(selected.payload, 'references'), gmailHeader(selected.payload, 'message-id')].filter(Boolean).join(' ') || undefined },
    });
  };

  const beginForward = () => {
    if (!selected?.payload) return;
    const subject = gmailHeader(selected.payload, 'subject');
    openDraftWith({
      to: '', cc: '', subject: /^fwd?:/i.test(subject) ? subject : `${mailWords.forward_subject_prefix}${subject}`,
      body: `${signatureBlock()}${gmailForwardBody(selected.payload, { marker: mailWords.forwarded_marker, from: mailWords.forward_from, date: mailWords.forward_date, subject: mailWords.forward_subject, to: mailWords.forward_to })}`,
      thread: {},
    });
  };

  const beginCompose = () => {
    if (sendRequest.current.draftId) { setMailActionState('Check the previous send result before opening another draft.'); return; }
    setSelectedId(''); setSelected(null); setError(''); setConnectedError(false); setTaskState(''); setReplyOpen(true); setDraftId(''); setDraftTo(''); setDraftCc(''); setDraftSubject(''); setDraftBody(signatureBlock()); setDraftThread({}); setDraftNeedsGmail(false); setMailActionState(''); setFolderSelected(true); setPanel(null); setTask(null);
  };

  const openSettings = () => openScreenOn(mailWords.settings_screen, { page: mailWords.settings_page }, mailWords.settings_open);

  const lastComposeRequest = React.useRef(0);
  React.useEffect(() => {
    if (!composeRequest || composeRequest === lastComposeRequest.current) return;
    lastComposeRequest.current = composeRequest;
    beginCompose();
  }, [composeRequest]);

  const saveDraft = async (): Promise<string> => {
    const to = gmailRecipients(draftTo);
    const cc = draftCc.trim() ? gmailRecipients(draftCc) : [];
    if (!to || !cc) throw new Error(mailWords.bad_recipients);
    if (!mailbox) throw new Error('Connect Google account again to see its email address before creating a draft.');
    const raw = gmailRawMessage({ from: mailbox, to: to.join(', '), ...(cc.length ? { cc: cc.join(', ') } : {}), subject: draftSubject, body: draftBody, inReplyTo: draftThread.inReplyTo, references: draftThread.references });
    const fingerprint = JSON.stringify({ raw, thread_id: draftThread.threadId ?? '', draft_id: draftId });
    if (draftRequest.current.fingerprint !== fingerprint) draftRequest.current = { fingerprint, key: `mail-draft:${crypto.randomUUID()}` };
    const thread = draftThread.threadId ? { thread_id: draftThread.threadId } : {};
    const output = draftId
      ? await actionRun<{ id: string }>(UPDATE_DRAFT, { draft_id: draftId, raw, ...thread }, draftRequest.current.key)
      : await actionRun<{ id: string }>(CREATE_DRAFT, { raw, ...thread }, draftRequest.current.key);
    setDraftId(output.id);
    return output.id;
  };

  const saveDraftAction = async () => {
    if (mailActionBusy) return;
    if (sendRequest.current.draftId) { setMailActionState('Check the previous send result before editing this draft.'); return; }
    if (draftNeedsGmail) { setMailActionState('This draft has attachments, formatting or extra recipients. Open it in Gmail to preserve everything when you edit or send.'); return; }
    setMailActionBusy(true); setMailActionState('');
    try { await saveDraft(); setMailActionState('Draft saved in Gmail.'); }
    catch (cause) {
      const message = errorWords(cause, 'The draft was not saved.');
      setMailActionState(message); setConnectedError(/connect|credential|google-account|authorization|403|permission/i.test(message));
    } finally { setMailActionBusy(false); }
  };

  const sendDraft = async () => {
    if (mailActionBusy) return;
    if (draftNeedsGmail) { setMailActionState('This draft has attachments, formatting or extra recipients. Open it in Gmail to preserve everything when you edit or send.'); return; }
    setMailActionBusy(true); setMailActionState('');
    try {
      const id = sendRequest.current.draftId || await saveDraft();
      if (sendRequest.current.draftId !== id) sendRequest.current = { draftId: id, key: `mail-send:${crypto.randomUUID()}` };
      await actionRun(SEND_DRAFT, { draft_id: id }, sendRequest.current.key);
      setMailActionState('Email sent from Gmail.'); setReplyOpen(false); setDraftId(''); sendRequest.current = { draftId: '', key: '' };
    } catch (cause) {
      const message = errorWords(cause, 'Gmail did not confirm that this email was sent. Check Gmail Sent before trying again.');
      setMailActionState(message.includes('Gmail returned') ? `${message} Check Gmail Sent before trying again.` : message);
      setConnectedError(/connect|credential|google-account|authorization|403|permission/i.test(message));
    } finally { setMailActionBusy(false); }
  };

  const deleteDraft = async () => {
    if (!draftId || mailActionBusy) return;
    if (sendRequest.current.draftId) { setMailActionState('Check the previous send result before deleting this draft.'); return; }
    setMailActionBusy(true); setMailActionState('');
    try {
      await requester(DELETE_DRAFT, { draft_id: draftId }, `mail-delete:${draftId}`);
      setMailActionState('Draft deleted from Gmail.');
      setReplyOpen(false); setDraftId(''); setSelectedId(''); setSelected(null);
      if (folder.id === 'drafts') void runSearch('in:drafts', FOLDERS.find(item => item.id === 'drafts'));
    } catch (cause) {
      const message = errorWords(cause, 'Gmail could not delete this draft.');
      setMailActionState(message); setConnectedError(/connect|credential|google-account|authorization|403|permission/i.test(message));
    } finally { setMailActionBusy(false); }
  };

  const createTask = async () => {
    if (!selectedId || !taskTitle.trim() || taskBusy || !account) return;
    setTaskBusy(true); setTaskState('');
    const sourceUrl = gmailMessageUrl(selectedId, mailbox);
    const sourceId = mailSourceId(account.connection_id, selectedId);
    try {
      let made = await ensureMailTask({ sourceId, title: taskTitle.trim(), url: sourceUrl });
      if (made.title !== taskTitle.trim()) made = await changeMailTask(made.id, { title: taskTitle.trim() });
      setTask(made);
      setTaskState(mailWords.task_made);
    } catch (cause) {
      setTaskState(errorWords(cause, mailWords.task_failed));
    } finally { setTaskBusy(false); }
  };

  /** The task that carries this email's plan, made the first time a plan verb needs it. */
  const taskForPlan = async (): Promise<MailTask> => {
    if (task) return task;
    if (!selectedId || !account) throw new Error(mailWords.plan_failed);
    const made = await ensureMailTask({ sourceId: mailSourceId(account.connection_id, selectedId), title: gmailHeader(selected?.payload, 'subject') || taskTitle || '(no subject)', url: gmailMessageUrl(selectedId, mailbox) });
    setTask(made);
    return made;
  };

  const plan = async (change: MailPlan) => {
    if (mailActionBusy) return;
    setMailActionBusy(true); setMailActionState('');
    try {
      const current = await taskForPlan();
      let next: MailTask;
      if (change.verb === 'priority') next = await changeMailTask(current.id, { priority: change.value });
      else if (change.verb === 'schedule') next = change.value ? await scheduleMailTask(current.id, change.value) : await unscheduleMailTask(current.id);
      else if (change.verb === 'deadline') next = await changeMailTask(current.id, { due: change.value });
      else if (change.verb === 'duration') next = await changeMailTask(current.id, { duration_minutes: change.value });
      else if (change.verb === 'repeat') next = await changeMailTask(current.id, { recurrence: change.value });
      else next = await changeMailTask(current.id, { collection_id: change.value });
      setTask(next);
      setMailActionState(change.verb === 'schedule' && !change.value ? mailWords.planned.schedule_cleared : change.verb === 'deadline' && !change.value ? mailWords.planned.deadline_cleared : mailWords.planned[change.verb]);
    } catch (cause) {
      setMailActionState(errorWords(cause, mailWords.plan_failed));
    } finally { setMailActionBusy(false); }
  };

  const duplicateTask = async () => {
    if (mailActionBusy) return;
    setMailActionBusy(true); setMailActionState('');
    try {
      const current = await taskForPlan();
      await duplicateMailTask(current.id, `mail-duplicate:${crypto.randomUUID()}`);
      setMailActionState(mailWords.planned.duplicate);
    } catch (cause) { setMailActionState(errorWords(cause, mailWords.plan_failed)); }
    finally { setMailActionBusy(false); }
  };

  const copyTitle = async () => {
    const title = gmailHeader(selected?.payload, 'subject');
    if (!title) { setMailActionState(mailWords.nothing_to_copy); return; }
    try { await navigator.clipboard.writeText(title); setMailActionState(mailWords.planned.copy_title); }
    catch (cause) { setMailActionState(errorWords(cause, mailWords.plan_failed)); }
  };

  /** One road for every verb of the card, the bar, their menus and the keys. */
  const runVerb = (id: string) => {
    if (!selected || selected.draftId || mailActionBusy) return;
    if (id === 'reply') beginReply(false);
    else if (id === 'reply_all') beginReply(true);
    else if (id === 'forward') beginForward();
    else if (id === 'done') void changeMail('done');
    else if (id === 'unread') void changeMail(selected.labelIds?.includes('UNREAD') ? 'read' : 'unread');
    else if (id === 'read') void changeMail('read');
    else if (id === 'delete') void changeMail(selected.labelIds?.includes('TRASH') ? 'restore' : 'trash');
    else if (id === 'priority' || id === 'schedule' || id === 'deadline') setPanel(current => current === id ? null : id);
    else if (id === 'duplicate') void duplicateTask();
    else if (id === 'copy_title') void copyTitle();
    else if (id === 'attachments') setPanel(current => current === 'attachments' ? null : 'attachments');
  };
  const keysLive = Boolean(selected && !selected.draftId && !replyOpen);
  useMailKeys(command => { if (keysLive) runVerb(command); });
  const keyOf = useMailKeyOf();
  // The rest of the conversation is read once, headers only, when a message of it is open; opening another message of it reads nothing more.
  const openThreadId = selected && !selected.draftId ? selected.threadId : undefined;
  React.useEffect(() => {
    if (!openThreadId || thread?.threadId === openThreadId) return;
    let active = true;
    setThreadFailed(false);
    void actionRun<{ messages?: GmailMessage[] }>(THREAD, { thread_id: openThreadId })
      .then(read => { if (active) setThread(gmailThreadView(openThreadId, read.messages, threadMost)); })
      .catch(() => { if (active) setThreadFailed(true); });
    return () => { active = false; };
  }, [openThreadId, requester]);
  // The task lists the Move to menu offers are read when a message is opened, not for every row drawn.
  React.useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void readTaskLists().then(lists => { if (active) setTaskLists(lists); }).catch(() => {});
    return () => { active = false; };
  }, [selectedId]);

  const gmailUrl = selected?.draftId ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#drafts/${encodeURIComponent(selected.draftId)}` : selectedId ? gmailMessageUrl(selectedId, mailbox) : '';
  const payload = selected?.payload;
  const date = toIso(gmailHeader(payload, 'date'));
  const cc = splitEmailAddresses(gmailHeader(payload, 'cc')).map(to => ({ to, how: 'cc' }));
  const bcc = splitEmailAddresses(gmailHeader(payload, 'bcc')).map(to => ({ to, how: 'bcc' }));
  const body = plainTextBody(payload);
  const attachments = gmailAttachments(payload);
  const links = gmailLinks(payload);
  const conversation = thread && thread.threadId === selected?.threadId ? thread : null;
  const participants = gmailParticipants(conversation ? conversation.messages.map(message => message.id === selectedId ? payload : message.payload) : [payload]);
  const barProps: MailBarProps = { table: mailCommands, keyOf, busy: mailActionBusy, task, taskLists, messageRead: !selected?.labelIds?.includes('UNREAD'), participants, links, attachments, panel, onPanel: setPanel, onRun: runVerb, onPlan: change => void plan(change) };
  const openCard = <Container layout="vertical" gap="none" data-mail-card="">
    <EmailView subject={gmailHeader(payload, 'subject')} from={gmailHeader(payload, 'from') || 'Unknown sender'} to={splitEmailAddresses(gmailHeader(payload, 'to'))} copies={[...cc, ...bcc]} sentAt={date} preheader={selected?.snippet} bodyText={body} noBody="This email has no plain-text copy. Open it in Gmail to view its original formatting." actions={null}
      footer={selected?.draftId ? null : <MailCardActions {...barProps} />} />
  </Container>;
  const threadEntries: EmailThreadEntry[] = conversation && conversation.messages.some(message => message.id === selectedId)
    ? conversation.messages.map(message => message.id === selectedId
      ? { id: message.id, from: gmailHeader(payload, 'from'), content: openCard }
      : { id: message.id, from: gmailHeader(message.payload, 'from') || 'Unknown sender', sentAt: toIso(gmailHeader(message.payload, 'date')), preview: message.snippet, unread: message.labelIds?.includes('UNREAD') })
    : [{ id: selectedId, from: gmailHeader(payload, 'from'), content: openCard }];
  const readerActions = gmailUrl ? <Button size="sm" variant="outline" onClick={() => window.open(gmailUrl, '_blank', 'noopener,noreferrer')}>Open in Gmail</Button> : null;
  const accountSetupHref = accounts.length ? GOOGLE_CONNECTIONS : GOOGLE_CONNECT;
  const accountSetupLabel = accounts.length ? 'Manage connected accounts' : 'Connect Google account';
  const accountSetupControl = accountReadFailed
    ? <Button size="sm" variant="outline" disabled={accountReadBusy} onClick={() => loadAccounts()}>{accountReadBusy ? 'Checking accounts…' : 'Try again'}</Button>
    : <Button size="sm" variant="outline" onClick={() => location.assign(accountSetupHref)}><Text variant="body-sm" truncate>{accountSetupLabel}</Text></Button>;

  const accountPicker = accounts.length > 0 ? <Select value={account ? mailAccountKey(account) : null} onValueChange={value => {
      if (sendRequest.current.draftId) { setMailActionState('Check the previous send result before changing accounts.'); return; }
      setAccount(accounts.find(row => mailAccountKey(row) === value) ?? null); setDraftId(''); setReplyOpen(false);
      draftRequest.current = { fingerprint: '', key: '' };
    }}><SelectTrigger aria-label="Google account"><SelectValue placeholder="Choose an account">{account?.account_label}</SelectValue></SelectTrigger><SelectPopup>{accounts.map(row => <SelectItem key={mailAccountKey(row)} value={mailAccountKey(row)}>{row.account_label}</SelectItem>)}</SelectPopup></Select> : null;
  const rail = <Container layout="vertical" gap="xs" padding="sm" minWidth="0" className="amie-mail-rail" data-mail-rail="">
    <Container layout="horizontal" gap="sm" alignItems="center" padding="sm"><NamedIcon name="mail" size="sm" /><Container layout="vertical" gap="none"><Text variant="heading-xs">Mail</Text>{mailbox ? <Text variant="caption" color="muted" truncate>{mailbox}</Text> : null}</Container></Container>
    {accountPicker}
    <Container padding="sm"><Button size="sm" variant="primary" disabled={!account} onClick={beginCompose}><NamedIcon name="plus" size="xs" />Compose</Button></Container>
    {FOLDERS.map(item => <Button key={item.id} size="nav" variant={folder.id === item.id ? 'secondary' : 'ghost'} active={folder.id === item.id} onClick={() => { setQuery(item.query); setFolderSelected(true); void runSearch(item.query, item); }}>
      <NamedIcon name={item.icon} size="xs" /><Text variant="body-sm">{item.label}</Text>
    </Button>)}
    <Container padding="sm"><Button size="nav" variant="ghost" disabled={!account} onClick={openSettings}><NamedIcon name="Settings" size="xs" /><Text variant="body-sm">{mailWords.settings_open}</Text></Button></Container>
    <Container padding="sm">{accountSetupControl}</Container>
  </Container>;

  const mailSearchControls = <>
    <Container layout="horizontal" gap="sm" alignItems="center">
      {width < 760 && !compact ? <Button size="sm" variant="ghost" onClick={() => setFolderSelected(false)}><NamedIcon name="menu" size="xs" />Folders</Button> : null}
      <SearchField label="Search Gmail" value={query} placeholder="Search mail" onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void runSearch(query); }} />
      <Button size="icon" variant="ghost" aria-label="Search mail" disabled={searching} onClick={() => runSearch(query)}><NamedIcon name="search" size="xs" /></Button>
    </Container>
    <Container layout="horizontal" gap="sm" alignItems="center" padding="xs">
      {compact ? <Select value={folder.id} onValueChange={value => { const next = FOLDERS.find(item => item.id === value); if (next) { setQuery(next.query); void runSearch(next.query, next); } }}><SelectTrigger aria-label="Mail folder"><SelectValue>{folder.label}</SelectValue></SelectTrigger><SelectPopup>{FOLDERS.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectPopup></Select>
        : <Text variant="label" color="muted">{folder.label}</Text>}
      {searching ? <Text variant="caption" color="muted">Searching…</Text> : null}
    </Container>
  </>;

  const list = <Container layout="vertical" gap="sm" padding="sm" minWidth="0" minHeight="0" flex={1} className="amie-mail-list" data-mail-list="">
    {compact ? <Container layout="horizontal" gap="sm" alignItems="center" data-mail-account-controls="">
      {accountPicker}
      <Button size="icon" variant="ghost" aria-label="Compose email" title="Compose email" disabled={!account} onClick={beginCompose}><NamedIcon name="plus" size="xs" /></Button>
      <Button ref={optionsAnchor} size="icon" variant="ghost" aria-label="Mail options" title="Mail options" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(open => !open)}><NamedIcon name="SlidersHorizontal" size="xs" /></Button>
      <AnchoredOverlay open={optionsOpen} anchorRef={optionsAnchor} placement="below" gap={6} onDismiss={() => setOptionsOpen(false)}>
        <Container layout="vertical" gap="sm" padding="sm" className="calendar-mail-options">{mailSearchControls}</Container>
      </AnchoredOverlay>
    </Container> : null}
    {!compact ? mailSearchControls : null}
    {error ? <Container layout="vertical" gap="xs" padding="sm" border="all" role="alert">
      <Text variant="body-sm" color="error">{error}</Text>
      {accountReadFailed ? <Button size="sm" disabled={accountReadBusy} onClick={() => loadAccounts()}>{accountReadBusy ? 'Checking accounts…' : 'Try again'}</Button>
        : connectedError ? <Button size="sm" onClick={() => location.assign(accountSetupHref)}>{accountSetupLabel}</Button> : null}
    </Container> : null}
    {(compact || width < 760) && !selectedId && !replyOpen && mailActionState ? <Container padding="sm" role="status">
      <Text variant="caption" color={/sent from Gmail|deleted from Gmail/.test(mailActionState) ? 'success' : 'error'}>{mailActionState}</Text>
    </Container> : null}
    <Container layout="vertical" gap="xs" minHeight="0" flex={1} overflow="auto">
      {rows.map(row => {
        const sender = headerOf(row, 'from') || (row.loading ? 'Loading sender…' : row.failed ? 'Message details unavailable' : 'Email');
        const subject = headerOf(row, 'subject') || (row.failed ? 'Open in Gmail to read this message' : '(no subject)');
        const dateText = when(headerOf(row, 'date'));
        return <Button key={row.id} variant={row.id === selectedId ? 'secondary' : 'ghost'} size="option-row" className="mail-message-row" active={row.id === selectedId} onClick={() => openMessage(row.id)} aria-label={`${subject}, from ${sender}`}>
          {compact ? <Container layout="horizontal" gap="sm" alignItems="center" minWidth="0" flex={1}>
            <DisplayMark spec={{ name: sender.replace(/\s*<[^>]+>\s*$/, ""), shape: 'person' }} size="sm" className="calendar-mail-avatar" />
            <Text variant="body-sm" weight="semibold" truncate className="calendar-mail-sender">{sender.replace(/\s*<[^>]+>\s*$/, "")}</Text>
            <Text variant="body-sm" truncate className="calendar-mail-subject">{subject}</Text>
          </Container> : <Container layout="vertical" gap="xs" minWidth="0" flex={1}>
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" minWidth="0">
              <Text variant="body-sm" weight="semibold" truncate>{sender}</Text>
              <Text variant="caption" wrap="nowrap">{dateText}</Text>
            </Container>
            <Text variant="body-sm" weight={row.id === selectedId ? 'semibold' : 'medium'} truncate>{subject}</Text>
            <Text variant="caption" color="muted" truncate>{row.snippet || (row.loading ? 'Loading message preview…' : 'Open to read this message.')}</Text>
          </Container>}
        </Button>;
      })}
      {queuedRows.length ? <Button size="sm" variant="outline" disabled={loadingMore} onClick={() => hydrateQueued()}>{loadingMore ? 'Loading messages…' : `Load ${Math.min(BATCH_SIZE, queuedRows.length)} more`}</Button> : null}
      {nextPage ? <Button size="sm" variant="ghost" disabled={searching || loadingMore} onClick={() => runSearch(query, undefined, nextPage)}>Next page</Button> : null}
      {!searching && !rows.length && !error ? <Container padding="lg"><Text variant="body">No mail matches this search.</Text></Container> : null}
    </Container>
  </Container>;

  const detail = <Container layout="vertical" gap="none" minWidth="0" minHeight="0" flex={1} overflow="auto" data-mail-detail="">
    {selectedId ? <Container layout="horizontal" gap="sm" alignItems="center" padding="sm" wrap className="amie-mail-detail-actions">
      {compact || width < 760 ? <Button size="sm" variant="ghost" disabled={Boolean(sendRequest.current.draftId)} onClick={() => { setSelectedId(''); setSelected(null); }}><NamedIcon name="arrow-left" size="xs" />Back to mail</Button> : null}
      <Container flex={1} />
      {selected?.draftId ? <Button size="sm" variant="ghost" disabled={mailActionBusy} onClick={() => deleteDraft()}>Delete draft</Button> : null}
      {readerActions}
    </Container> : null}
    {opening ? <Container padding="xl"><Text variant="body">Opening message…</Text></Container> : null}
    {selected && payload ? <>
      <Container layout="vertical" gap="none" padding="sm">
        <EmailThread label={mailWords.thread_label} entries={threadEntries} onOpen={id => void openMessage(id, true)}
          earlier={conversation?.earlier ? fill(mailWords.thread_earlier, { count: conversation.earlier }) : null}
          note={threadFailed ? mailWords.thread_failed : openThreadId && !conversation ? mailWords.thread_loading : null} />
      </Container>
      {selected.draftId ? null : <Container layout="vertical" gap="none" padding="sm"><MailActionBar {...barProps} /></Container>}
      <Container layout="vertical" gap="sm" padding="md" border="top" data-email-task-origin="">
        <Text variant="heading-xs">Make this a task</Text>
        <Text variant="caption" color="muted">The task will keep a link back to this email.</Text>
        <Input aria-label="Task title" value={taskTitle} onChange={event => setTaskTitle(event.target.value)} placeholder="Task title" />
        <Container layout="horizontal" gap="sm" alignItems="center" wrap>
          <Button size="sm" disabled={taskBusy || !taskTitle.trim()} onClick={() => createTask()}>{taskBusy ? 'Creating task…' : 'Create task'}</Button>
          <Button size="sm" variant="ghost" onClick={() => window.open(gmailUrl, '_blank', 'noopener,noreferrer')}>Open in Gmail</Button>
        </Container>
        {taskState ? <Text variant="caption" color={taskState.startsWith('Task created') ? 'success' : 'error'}>{taskState}</Text> : null}
        <Text variant="caption" color="muted">Done, read status, replies and sending use your connected Gmail account.</Text>
      </Container>
      {mailActionState ? <Container layout="vertical" gap="xs" padding="md" border="top" role="status">
        <Text variant="caption" color={/saved in Gmail|sent from Gmail|Marked|Trash\.|Restored|Starred|Unstarred|Priority set|Scheduled|Removed from|Deadline|Duration set|Repeat saved|Moved to|Duplicated|Copied/.test(mailActionState) ? 'success' : 'error'}>{mailActionState}</Text>
        {connectedError ? <Button size="sm" onClick={() => location.assign(accountSetupHref)}>{accountSetupLabel}</Button> : null}
      </Container> : null}
    </> : null}
    {replyOpen ? <Container layout="vertical" gap="sm" padding="md" border="top" data-email-reply="">
      <Text variant="heading-xs">{selected?.draftId ? 'Edit draft' : selected ? 'Reply' : 'New email'}</Text>
      <Input aria-label="To" disabled={mailActionBusy || Boolean(sendRequest.current.draftId)} value={draftTo} onChange={event => setDraftTo(event.target.value)} placeholder={mailWords.to_placeholder} />
      <Input aria-label={mailWords.cc} disabled={mailActionBusy || Boolean(sendRequest.current.draftId)} value={draftCc} onChange={event => setDraftCc(event.target.value)} placeholder={mailWords.cc_placeholder} />
      <Input aria-label="Subject" disabled={mailActionBusy || Boolean(sendRequest.current.draftId)} value={draftSubject} onChange={event => setDraftSubject(event.target.value)} placeholder="Subject" />
      <Textarea aria-label="Email message" disabled={mailActionBusy || Boolean(sendRequest.current.draftId)} value={draftBody} onChange={event => setDraftBody(event.target.value)} rows={8} placeholder="Write your email" />
      {attachments.length && !draftId && /^fwd?:/i.test(draftSubject) ? <Text variant="caption" color="muted" role="note">{mailWords.forward_attachments_note}</Text> : null}
      {draftNeedsGmail ? <Container layout="vertical" gap="xs" padding="sm" border="all" role="status"><Text variant="body-sm">This draft has attachments, formatting or extra recipients. Open it in Gmail to preserve everything when you edit or send.</Text>{readerActions}</Container> : null}
      <Container layout="horizontal" gap="sm" alignItems="center" wrap>
        <Button size="sm" variant="primary" disabled={mailActionBusy || draftNeedsGmail || !draftTo.trim() || !draftSubject.trim()} onClick={() => sendDraft()}>{mailActionBusy ? 'Working…' : sendRequest.current.draftId ? 'Check send result' : 'Send'}</Button>
        <Button size="sm" variant="outline" disabled={mailActionBusy || draftNeedsGmail || !draftTo.trim() || !draftSubject.trim()} onClick={() => saveDraftAction()}>{draftId ? 'Save changes' : 'Save draft'}</Button>
        <Button size="sm" variant="ghost" disabled={mailActionBusy || Boolean(sendRequest.current.draftId)} onClick={() => setReplyOpen(false)}>Close</Button>
      </Container>
    </Container> : null}
    {mailActionState && !selected ? <Container layout="vertical" gap="xs" padding="md" border="top" role="status"><Text variant="caption" color={/deleted from Gmail/.test(mailActionState) ? 'success' : 'error'}>{mailActionState}</Text></Container> : null}
    {!selectedId && !opening && !replyOpen ? <Container layout="vertical" gap="sm" padding="xl" alignItems="start">
      <NamedIcon name="mail-open" size="lg" />
      <Text variant="heading-sm">Your mail</Text>
      <Text variant="body" color="muted">Choose a message to read it. Search uses Gmail’s own query words.</Text>
      {accountSetupControl}
    </Container> : null}
    {error ? <Container layout="vertical" gap="sm" padding="md" border="top" role="alert">
      <Text variant="body" color="error">{error}</Text>
      {connectedError ? <Button size="sm" onClick={() => location.assign(accountSetupHref)}>{accountSetupLabel}</Button> : null}
      {selectedId ? <Button size="sm" variant="outline" onClick={() => window.open(gmailUrl, '_blank', 'noopener,noreferrer')}>Open in Gmail</Button> : null}
    </Container> : null}
  </Container>;

  return <Container ref={rootRef} layout="vertical" gap="none" minHeight="0" height={compact ? undefined : "full"} data-email-screen={presentation} data-email-message-open={keysLive || undefined} data-email-detail-open={Boolean(selectedId || replyOpen) || undefined}>
    <InboxThreePane width={compact ? Math.min(width, 759) : width} hasSelection={compact || folderSelected} isItemOpen={Boolean(selectedId || replyOpen)} preferredPane={compact ? 'list' : 'rail'} onNavigateBack={() => { if (sendRequest.current.draftId) { setMailActionState('Check the previous send result before closing this draft.'); return; } if (replyOpen) setReplyOpen(false); else if (selectedId) { setSelectedId(''); setSelected(null); } else setFolderSelected(false); }} rail={compact ? null : rail} list={list} detail={detail}
      renderSlots={compact ? undefined : ({ slots, visibleSlots }) => <ArrangedContents
        pieces={mailComposition.pieces.map(piece => ({
          ...piece,
          content: slots[piece.id as 'rail' | 'list' | 'detail'],
          visible: visibleSlots.includes(piece.id as 'rail' | 'list' | 'detail'),
        }))}
        arrangement={mailComposition.arrangement}
        keptAt={mailComposition.kept_at}
        words={mailComposition.words}
        sizing="fill"
      />} />
  </Container>;
}

export function EmailSurface(props: EmailSurfaceProps) {
  return <EmailScreen {...props} />;
}

export function mountEmailScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}): () => void {
  return mountReactSurface(element, <EmailScreen presentation={props.surfaceInput?.presentation === 'calendar' ? 'calendar' : 'full'} composeRequest={props.surfaceInput?.compose === true ? 1 : 0} />);
}
