// src/workspace/sharing-sheet.tsx
//
// PURPOSE
//   The one sharing sheet for every screen; a screen that adds its own sharing sheet repeats it. It shows who can open
//   one of the person's things, opened from every ⋯ menu (menu-rows `sharing`), a list's Share
//   (shareAction) or a space's Share: the one sharing sheet (parts/ui/show/sharing-sheet) in a work panel beside the
//   page. For a record, a list (with its rows), one piece of text or several things at once it is drawn from
//   tool:share-anything's own answer (share-anything.ts): invite a person or an AI by name (each gets a link of its own,
//   shown once), who has access with a way to stop it, who else can open it (only the people added, or anyone with the
//   link), and More choices (until when). For a space (`space:<id>`) it is drawn from the space's own members,
//   member types and invites (/work/api/spaces): invite with a member type, each member's type, take someone out,
//   stop an invite, copy an invite link.
//
//   A recording's note also draws its Share row and Share via panel from here (NoteShareRow, openShareVia; the destinations
//   and words are note-share.json), and copyPublicLink / publicLinkFor are the one public-link maker for the sheet, the
//   row and the Notes list.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every label and preview comes from the tool's answer or the caller; nothing here names a kind of record.
//   2. A link is shown and copied once, when it is made: the tool keeps only its digest, so this sheet never lists a
//      link's address again. An invite, a stop and who else can open it act at once.
//   3. Roles are DATA: a person shared with can view; a space's roles are its member types. Nothing here names one.

import React, { useEffect, useState } from 'react';
import { Button, Container, Dropdown, Input, NamedIcon, Text, Textarea } from '../../parts/ui';
import { SharingSheet, type SharingPreview } from '../../parts/ui/show/sharing-sheet/SharingSheet';
import { notify } from '../../parts/ui/show/coss/notifications';
import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';
import type { BulkAction } from '../../parts/ui/show/record-views/record-views';
import { mountSharedContent } from '../../parts/ui/show/coss/shared-content';
import { openWorkPanel } from '../../parts/screen-arrangement/show/mount-floating-panel';
import { ScreenState } from '../../parts/ui/show/screen-state';
import { postJson, readJson } from './api';
import { failedState } from './failure';
import { runAsAccount } from './mail-accounts';
import { gmailRawMessage } from './gmail-email';
import { deliveryBody, deliveryOutcome, filterDestinations, formProblem, mailParts, readyPlace, sentWords, startingValues } from './note-share-plan.mjs';
import noteShare from './note-share.json' with { type: 'json' };
// The toast words of a copied public link are the Notes list's (note-list-menu.json), so both menus say it the same way.
import noteList from './note-list-menu.json' with { type: 'json' };
import { readAccess, shareThing, stopSharing, thingOf, typeOf, type Access, type ShareEntry, type ShareThing } from './share-anything';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { isOpenToEveryone, openChoices, openedRules } from '../space-open.mjs';

const WORDS = {
  preview: 'What they will see', places: 'Places',
  failed: 'Sharing could not be saved. Try again.', access: 'Who has access', general: 'Who else can open it', more: 'More choices', fewer: 'Fewer choices',
};
const SPACE_WORDS = { preview: 'What they will join', places: 'Places', failed: 'That could not be done. Try again.', access: 'Who is in it', general: 'Who else can open it', more: 'More choices', fewer: 'Fewer choices' };
// Who else can open a thing: one choice, changed at once.
const GENERAL = [
  { id: 'people', label: 'Only people you add', detail: 'Only the people and AIs above can open it, each with the link made for them.', icon: 'Lock' },
  { id: 'link', label: 'Anyone with the link', detail: 'Anyone who has the link can open it. No account needed.', icon: 'Link' },
];
const ROLES = [{ id: 'view', label: 'Can view' }];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9][\d ()-]{7,20}$/;
const MAX_SHARED_TEXT_CHARACTERS = 20_000;
const PREVIEW_TITLES = 5;
const dayText = (at: string) => new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });
const dateInput = (at: string | null | undefined) => (at ? new Date(at).toISOString().slice(0, 10) : null);
const endOfDay = (day: string) => new Date(`${day}T23:59:59`).toISOString();
const copyLink = async (url: string, said: string) => {
  const copied = await copyTextToClipboard(url);
  notify(copied ? said : 'Could not copy the link', { kind: copied ? 'done' : 'error' });
};

/** What one thing is shared with: people and AIs, each with a link made once, and the link anyone may open. */
function ThingSharing({ thing, title, preview = { title } }: { thing: ShareThing; title: string; preview?: SharingPreview }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  // The link just made, kept in memory only so Copy link can copy it again while this sheet is open (invariant 2).
  const [made, setMade] = useState<string | null>(null);
  // Until when the links made from now on open.
  const [until, setUntil] = useState<string | null>(null);
  const read = () => readAccess(thing).then(setAccess);
  useEffect(() => {
    setFailed(null);
    readAccess(thing).then(setAccess, error => setFailed(errorWords(error)));
  }, [asked]);
  if (failed) return <ScreenState state={failedState(failed, () => setAsked(asked + 1), 'This could not be opened')} />;
  if (!access) return <ScreenState state={{ status: 'loading', label: 'Loading who sees it', layout: 'rows' }} />;
  const open = access.link?.open === true;
  const label = access.label;
  const invite = async (value: string) => {
    const who = value.trim();
    const shared = await shareThing(thing, { people: [who], until });
    const url = shared.people.find(person => person.principal === who)?.url;
    if (url) { setMade(url); await copyLink(url, `Link for ${who} copied. It opens only for them.`); }
    await read();
  };
  return (
    <SharingSheet
      preview={preview}
      places={[]}
      words={WORDS}
      invite={{ label: 'Invite', placeholder: 'Name of a person or an AI', roles: ROLES, role: 'view', invite: (value) => invite(value) }}
      access={[
        { id: 'you', label: 'You', icon: 'UserRound', role: { value: 'owner', choices: [{ id: 'owner', label: 'Owner' }] } },
        ...access.people.map(person => ({
          id: person.principal, label: person.principal, icon: 'UserRound',
          ...(person.added_at ? { detail: `Added ${dayText(person.added_at)}` } : {}),
          role: { value: 'view', choices: ROLES },
          remove: { label: 'Stop their access', run: async () => { if (label) await stopSharing(label, { principal: person.principal }); await read(); } },
        })),
      ]}
      general={{ value: open ? 'link' : 'people', choices: GENERAL, change: async id => {
        if (id === 'people') {
          if (label) await stopSharing(label, { link: true });
          setMade(null);
        } else {
          const shared = await shareThing(thing, { link: true, until });
          if (shared.link) { setMade(shared.link.url); await copyLink(shared.link.url, 'Link copied'); }
        }
        await read();
      } }}
      options={[
        { id: 'until', label: 'Open until', detail: 'After this day the links made from now on stop opening', kind: 'date',
          value: dateInput(until ?? access.link?.expires_at),
          change: async value => setUntil(typeof value === 'string' && value ? endOfDay(value) : null) },
      ]}
      actions={made ? [{ id: 'copy-link', label: 'Copy link', icon: 'Link', primary: true, run: () => copyLink(made, 'Link copied') }] : []}
    />
  );
}

type SpaceMember = { member_id: string; name: string; role: string | null; you?: boolean };
type SpaceView = { space_id: string; title: string; description?: string | null; members: SpaceMember[]; member_types: { id: string; label: string }[]; joins_as?: string | null; may: Record<string, boolean> };
type SpaceInvite = { invite_id: string; made_at: string; expires_at: string; state: string; member_type?: string | null };
const spaceAt = (id: string, rest = '') => `/work/api/spaces/${encodeURIComponent(id)}${rest}`;
type SpaceRules = { rules: { id: string }[]; may_change: boolean };

/** Who is in a space and who may join it: the same sheet, from the space's own members, types and invites. */
function SpaceSharing({ spaceId }: { spaceId: string }) {
  const [view, setView] = useState<SpaceView | null>(null);
  const [invites, setInvites] = useState<SpaceInvite[]>([]);
  const [rules, setRules] = useState<SpaceRules | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const read = () => Promise.all([readJson<SpaceView>(spaceAt(spaceId)), readJson<{ invites: SpaceInvite[] }>(spaceAt(spaceId, '/invites')).catch(() => ({ invites: [] })), readJson<SpaceRules>(spaceAt(spaceId, '/rules')).catch(() => null)])
    .then(([space, made, kept]) => { setView(space); setInvites(made.invites ?? []); setRules(kept); });
  useEffect(() => { setFailed(null); read().catch(error => setFailed(errorWords(error))); }, [spaceId, asked]);
  if (failed) return <ScreenState state={failedState(failed, () => setAsked(asked + 1), 'This could not be opened')} />;
  if (!view) return <ScreenState state={{ status: 'loading', label: 'Loading who is in it', layout: 'rows' }} />;
  const types = view.member_types ?? [];
  const typeOf = (id: string | null | undefined) => types.find(type => type.id === id)?.label ?? 'Member';
  const mayType = view.may?.set_member_type === true && types.length > 1;
  const after = async () => { await read(); };
  const invite = async (value: string, role: string | null) => {
    const typed = value.trim();
    const to = EMAIL.test(typed) ? { email: typed } : PHONE.test(typed) ? { phone: typed.replace(/[ ()-]/g, '') } : null;
    if (!to) throw new Error('Type their email address, or their phone number starting with + and the country code.');
    const sent = await postJson<{ email?: { sent: boolean; said: string }; text_message?: { sent: boolean; said: string } }>(spaceAt(spaceId, '/invite-person'), { ...to, ...(days ? { days } : {}), ...(role && mayType ? { member_type: role } : {}) });
    notify((sent.email?.sent ? sent.email.said : sent.text_message?.said) ?? `Invited ${typed}`, { kind: 'done' });
    await after();
  };
  const open = invites.filter(item => item.state === 'open');
  return (
    <SharingSheet
      preview={{ title: view.title, fields: [{ id: 'people', label: 'People', value: String(view.members.length) }, ...(view.description ? [{ id: 'about', label: 'About', value: view.description }] : [])] }}
      places={[]}
      words={SPACE_WORDS}
      {...(view.may?.make_invite ? { invite: { label: 'Invite', placeholder: 'Email or phone number', roles: mayType ? types : undefined, role: view.joins_as ?? types.at(-1)?.id, invite } } : {})}
      access={[
        ...view.members.map(member => ({
          id: member.member_id, label: member.you ? `${member.name} (you)` : member.name, icon: 'UserRound',
          role: { value: member.role ?? types[0]?.id ?? 'member', choices: types.length ? types : [{ id: 'member', label: 'Member' }],
            ...(mayType ? { change: async (role: string) => { await postJson(spaceAt(spaceId, '/members/type'), { member_id: member.member_id, member_type: role }); await after(); } } : {}) },
          ...(!member.you && view.may?.remove_member ? { remove: { label: 'Take out of this pursuit', run: async () => { await postJson(spaceAt(spaceId, '/members/remove'), { member_id: member.member_id }); await after(); } } } : {}),
        })),
        ...open.map(item => ({
          id: item.invite_id, label: 'Invite not used yet', icon: 'MailQuestion', badge: 'Waiting',
          detail: `Made ${dayText(item.made_at)} · works until ${dayText(item.expires_at)}`,
          role: { value: item.member_type ?? view.joins_as ?? types.at(-1)?.id ?? 'member', choices: types.length ? types : [{ id: 'member', label: 'Member' }] },
          remove: { label: 'Stop this invite', run: async () => { await postJson(spaceAt(spaceId, '/invites/revoke'), { invite_id: item.invite_id }); await after(); } },
        })),
      ]}
      {...(rules?.may_change ? { general: { value: isOpenToEveryone(rules.rules) ? 'open' : 'members', choices: openChoices, change: async (id: string) => {
        await postJson(spaceAt(spaceId, '/rules'), { rules: openedRules(rules.rules, id === 'open') });
        await after();
      } } } : {})}
      options={view.may?.make_invite ? [{ id: 'days', label: 'Invites work for', detail: 'Days before an invite stops working', kind: 'number', placeholder: '7 days', value: days, change: async value => setDays(typeof value === 'number' && value > 0 ? value : null) }] : []}
      actions={view.may?.make_invite ? [{ id: 'copy-invite', label: 'Copy invite link', icon: 'Link', primary: true, run: async () => {
        const made = await postJson<{ url: string }>(spaceAt(spaceId, '/invites'), { ...(days ? { days } : {}) });
        const copied = await copyTextToClipboard(made.url);
        notify(copied ? `Invite link copied. One person can join ${view.title} with it.` : 'Could not copy the link', { kind: copied ? 'done' : 'error' });
        await after();
      } }] : []}
    />
  );
}

/** One thing to share in a collection: a record of the person's, or words (a link or a piece of text) with a title. */
export type ShareItem = { record?: string; code?: string; url?: string; text?: string; title: string };

const entryOf = (item: ShareItem): ShareEntry => {
  if (item.record) return { type: typeOf(item.record), id: item.record };
  const text = item.code ? `${window.location.origin}/share/${encodeURIComponent(item.code)}` : item.url ?? item.text ?? '';
  return { text, title: item.title };
};

/** What a collection's link holds, as the sheet's preview: how many items and the first titles. */
const collectionPreview = (title: string, items: ShareItem[]): SharingPreview => ({
  title,
  fields: [
    { id: 'count', label: 'In this link', value: `${items.length} ${items.length === 1 ? 'item' : 'items'}` },
    { id: 'titles', label: 'Includes', value: `${items.slice(0, PREVIEW_TITLES).map(item => item.title).join(', ')}${items.length > PREVIEW_TITLES ? ', …' : ''}` },
  ],
});

/** Opens the one sharing sheet beside the page for one record (a record id, `file:<identity>`, `tool:<id>`), a list
 *  (`list:<id>`, with its rows), a whole space (`space:<id>`), or several records and words at once (one link). `type`
 *  names the record's kind when its id does not. */
const SPACE_PREFIX = 'space:';
export function openSharing(record: string, { title, anchor, records, titles, items, type }: { title?: string | null; anchor?: Element | null; records?: string[]; titles?: string[]; items?: ShareItem[]; type?: string } = {}) {
  const collection = items ?? (records && records.length > 1 ? records.map((one, index) => ({ record: one, title: titles?.[index] ?? one })) : null);
  const overlong = collection?.find(item => !item.record && !item.code && !item.url && item.text !== undefined && item.text.length > MAX_SHARED_TEXT_CHARACTERS);
  if (overlong) { notify(`${overlong.title || 'Selected words'} has more than 20,000 characters. Shorten it before sharing.`, { kind: 'error' }); return; }
  const panel = openWorkPanel(title ? `Share ${title}` : 'Share', { anchor, kind: 'sharing' });
  const body = panel.querySelector<HTMLElement>('[data-panel-body]');
  if (!body) return;
  const spaceId = record.startsWith(SPACE_PREFIX) ? record.slice(SPACE_PREFIX.length) : null;
  const heading = title ?? record;
  mountSharedContent(body, collection
    ? <ThingSharing thing={{ items: collection.map(entryOf), title: heading }} title={heading} preview={collectionPreview(heading, collection)} />
    : spaceId ? <SpaceSharing spaceId={spaceId} /> : <ThingSharing thing={thingOf(record, type)} title={heading} />);
}

/** The ⋯ menu's Share for any list of the person's own records: `recordOf` names each row's record, or null. */
export function shareAction<T>(rowOf: (id: string) => T | undefined, recordOf: (row: T) => string | null, titleOf: (row: T) => string | null = () => null): BulkAction {
  return {
    id: 'share', label: 'Share', icon: 'Share2',
    appliesTo: (row: T) => Boolean(recordOf(row)),
    run: (ids: string[]) => {
      const selected = ids.flatMap(id => { const row = rowOf(id); const record = row ? recordOf(row) : null; return row && record ? [{ record, title: titleOf(row) ?? record }] : []; });
      const unique = [...new Map(selected.map(item => [item.record, item])).values()];
      if (unique.length) openSharing(unique[0].record, { title: unique.length === 1 ? unique[0].title : `${unique.length} items`, records: unique.map(item => item.record), titles: unique.map(item => item.title), anchor: document.activeElement });
    },
  };
}

/** The address of a new link anyone may open for a record: made now, since the tool keeps only a link's digest. */
export async function publicLinkFor(record: string): Promise<string> {
  const shared = await shareThing(thingOf(record), { link: true });
  if (!shared.link) throw new Error('The link could not be made.');
  return shared.link.url;
}

/** Copies the address of a new link anyone may open for a record, made first. Answers whether it was copied, and says so in the caller's words. */
export async function copyPublicLink(record: string, words: { done: string; detail: string; failed: string; unreadable: string }): Promise<boolean> {
  try {
    const copied = await copyTextToClipboard(await publicLinkFor(record));
    if (copied) notify(words.done, { kind: 'done', detail: words.detail }); else notify(words.failed, { kind: 'error' });
    return copied;
  } catch (error) { notify(words.unreadable, { kind: 'error', detail: errorWords(error) }); return false; }
}

// ---------------------------------------------------------------------------------------------------------------------
// A meeting note's Share row and Share via panel (REA F-0983), the same owner as the sheet above: Share via, a chip for each
// destination row of note-share.json that is ready (Copy link, and each place the person's account can hand a note to),
// then More: the rest, each with its Set up. Share via opens the same destinations as a filterable list with a form for
// the one chosen. Copy link makes a new public link for the note through publicLinkFor above.
//   1. Destinations, forms and every word are DATA (note-share.json); nothing here names a service.
//   2. A service place receives the note only through the one delivery road (POST /share-destinations/deliver); an email
//      goes only through the person's connected Gmail tools. Sent is said only on a confirmed answer.
//   3. A send keeps one request key until it succeeds, so sending again after a stop never sends twice.
//   4. The public link is made only when the person copies it or sends it, never by opening the row or the panel.
// ---------------------------------------------------------------------------------------------------------------------
type Field = { id: string; label: string; kind: string; required?: boolean; placeholder?: string; from?: string };
type Destination = { id: string; label: string; icon: string; kind: string; vendor?: string; match?: string; connect_row?: string; fields?: Field[] };
type NotePlace = { id: string; label: string };
type MailAccount = { connection_id: string; connected_at: string; account_label: string; status: string; can_send?: boolean };
type Where = { places: NotePlace[]; accounts: MailAccount[] };
const noteWords = noteShare.words;
const noteDestinations = noteShare.destinations as Destination[];
const CREATE_DRAFT = 'tool:google-account-create_draft';
const SEND_DRAFT = 'tool:google-account-send_draft';

/** Where this account can send a note now: its tool places and the Gmail accounts that may send. */
async function readWhere(): Promise<Where> {
  const [shares, mail] = await Promise.all([
    readJson<{ destinations?: NotePlace[] }>('/work/api/share-destinations'),
    readJson<{ accounts?: MailAccount[] }>(`/work/api/workshop/accounts?vendor=google-account&check=${crypto.randomUUID()}`).catch(() => ({ accounts: [] })),
  ]);
  return { places: (shares.destinations ?? []).slice(0, noteShare.limits.places_read), accounts: mail.accounts ?? [] };
}
function useWhere() {
  const [where, setWhere] = React.useState<Where | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [asked, setAsked] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    setFailed(false);
    readWhere().then(next => { if (live) setWhere(next); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [asked]);
  return { where, failed, again: () => { setWhere(null); setAsked(count => count + 1); } };
}

const setUp = (row: Destination) => window.open(`/connections?show_row=${encodeURIComponent(row.connect_row ?? row.id)}`, '_blank', 'noopener,noreferrer');

const copyNoteLink = (record: string) => copyPublicLink(record, noteList.public_link);

/** One destination's form and Send. A stop keeps the typed values and the request key, so Send again is a retry. */
function ShareForm({ row, record, title, where, onBack }: { row: Destination; record: string; title: string; where: Where; onBack: () => void }) {
  const [values, setValues] = React.useState<Record<string, string>>(() => startingValues(row, { title }));
  const [state, setState] = React.useState<{ busy: boolean; message: string; sent: boolean }>({ busy: false, message: '', sent: false });
  const requestKey = React.useRef('');
  const ready = readyPlace(row, where);
  const send = async () => {
    const problem = formProblem(row, values, noteWords);
    if (problem) { setState({ busy: false, message: problem, sent: false }); return; }
    setState({ busy: true, message: '', sent: false });
    requestKey.current ||= `note-share:${crypto.randomUUID()}`;
    try {
      const link = await publicLinkFor(record);
      if (row.kind === 'mail') {
        const account = ready.account as MailAccount | undefined;
        if (!account || !account.account_label.includes('@')) throw new Error(noteWords.no_address);
        const mail = mailParts(values, { link, limit: noteShare.limits.text });
        const raw = gmailRawMessage({ from: account.account_label, to: mail.to, subject: mail.subject, body: mail.body });
        const draft = await runAsAccount(account, CREATE_DRAFT, { raw }, `${requestKey.current}:draft`);
        const draftId = (draft.result as { id?: string } | undefined)?.id;
        if (!draftId) throw new Error(noteWords.failed);
        await runAsAccount(account, SEND_DRAFT, { draft_id: draftId }, `${requestKey.current}:send`);
        requestKey.current = '';
        setState({ busy: false, message: sentWords(row, noteWords), sent: true });
        notify(sentWords(row, noteWords), { kind: 'done' });
        return;
      }
      const place = ready.place as NotePlace;
      const answer = await postJson<{ delivered?: { id: string }[]; stopped_at?: { error?: string } | null; queued?: boolean }>('/work/api/share-destinations/deliver',
        deliveryBody(row, place, values, { link, title, requestKey: requestKey.current, limit: noteShare.limits.text }));
      const outcome = deliveryOutcome(answer, row, place, noteWords);
      if (outcome.kind === 'sent') { requestKey.current = ''; notify(outcome.words, { kind: 'done' }); }
      setState({ busy: false, message: outcome.words, sent: outcome.kind === 'sent' });
    } catch (error) { setState({ busy: false, message: errorWords(error, noteWords.failed), sent: false }); }
  };
  return <Container layout="vertical" gap="sm" padding="sm" aria-label={row.label}>
    <Container layout="horizontal" gap="sm" alignItems="center">
      <Button variant="ghost" size="sm" onClick={onBack}>{noteWords.back}</Button>
      <Text variant="heading-sm" color="strong">{row.label}</Text>
    </Container>
    {(row.fields ?? []).map(field => field.kind === 'long'
      ? <Textarea key={field.id} label={field.label} rows={4} placeholder={field.placeholder} value={values[field.id] ?? ''} disabled={state.busy || state.sent} onChange={event => setValues(current => ({ ...current, [field.id]: event.target.value }))} />
      : <Input key={field.id} label={field.label} placeholder={field.placeholder} value={values[field.id] ?? ''} disabled={state.busy || state.sent} onChange={event => setValues(current => ({ ...current, [field.id]: event.currentTarget.value }))} />)}
    <Text variant="body-sm" color="subtle">{noteWords.link_added}</Text>
    {state.message ? <Text variant="body" color="subtle" role="status">{state.message}</Text> : null}
    <Container layout="horizontal" gap="sm">
      <Button variant="primary" size="sm" loading={state.busy} disabled={state.busy || state.sent || !ready.ready} onClick={() => send()}>{state.busy ? noteWords.sending : noteWords.send}</Button>
    </Container>
  </Container>;
}

/** The Share via panel: a filter, the destinations, and the chosen one's form. */
function ShareVia({ record, title, first }: { record: string; title: string; first?: string }) {
  const { where, failed, again } = useWhere();
  const [query, setQuery] = React.useState('');
  const [chosen, setChosen] = React.useState<string | null>(first ?? null);
  if (failed) return <Container layout="vertical" gap="sm" padding="sm"><Text variant="body" role="alert">{noteWords.read_failed}</Text><Button variant="outline" size="sm" onClick={again}>{noteWords.retry}</Button></Container>;
  if (!where) return <Container padding="sm"><Text variant="body" color="subtle" role="status">{noteWords.reading}</Text></Container>;
  const row = noteDestinations.find(item => item.id === chosen);
  if (row && row.kind !== 'link') return <ShareForm row={row} record={record} title={title} where={where} onBack={() => setChosen(null)} />;
  const rows = filterDestinations(noteDestinations, query) as Destination[];
  return <Container layout="vertical" gap="sm" padding="sm" aria-label={noteWords.panel_title}>
    <Input label={noteWords.filter} placeholder={noteWords.filter_placeholder} value={query} onChange={event => setQuery(event.currentTarget.value)} />
    {rows.length ? rows.map(item => {
      const ready = readyPlace(item, where).ready;
      return <Container key={item.id} layout="horizontal" gap="sm" alignItems="center">
        <Button variant="ghost" size="sm" disabled={!ready} onClick={() => item.kind === 'link' ? void copyNoteLink(record) : setChosen(item.id)}>
          <NamedIcon name={item.icon} size="sm" aria-hidden="true" />
          {item.label}
        </Button>
        {ready ? null : <Button variant="outline" size="sm" onClick={() => setUp(item)}>{noteWords.connect}</Button>}
      </Container>;
    }) : <Text variant="body" color="subtle" role="status">{noteWords.none}</Text>}
  </Container>;
}

/** Opens Share via beside the page; `first` opens straight on one destination. */
export function openShareVia(record: string, title: string, { anchor, first }: { anchor?: Element | null; first?: string } = {}) {
  const panel = openWorkPanel(`${noteWords.panel_title} ${title}`, { anchor, kind: 'share-via' });
  const body = panel.querySelector<HTMLElement>('[data-panel-body]');
  if (body) mountSharedContent(body, <ShareVia record={record} title={title} first={first} />);
}

/** The note's Share row: Share via first, a chip for each destination that is ready, and More for the rest with their set-up. */
export function NoteShareRow({ record, title }: { record: string; title: string }) {
  const { where } = useWhere();
  const ready = noteDestinations.filter(row => row.kind === 'link' || (where && readyPlace(row, where).ready));
  const rest = noteDestinations.filter(row => !ready.includes(row));
  return <Container layout="horizontal" gap="xs" wrap alignItems="center" padding="sm" aria-label={noteWords.row_label}>
    <Button variant="ghost" size="sm" onClick={event => openShareVia(record, title, { anchor: event.currentTarget })}>{noteWords.via}</Button>
    {ready.map(row => <Button key={row.id} variant="outline" size="sm"
      onClick={event => row.kind === 'link' ? void copyNoteLink(record) : openShareVia(record, title, { anchor: event.currentTarget, first: row.id })}>
      <NamedIcon name={row.icon} size="sm" aria-hidden="true" />
      {row.label}
    </Button>)}
    {where && rest.length ? <Dropdown aria-label={noteWords.more} placeholder={noteWords.more} value="" scrollable
      items={rest.map(row => ({ value: row.id, label: `${noteWords.connect} ${row.label}`, icon: row.icon }))}
      onValueChange={id => { const row = rest.find(item => item.id === id); if (row) setUp(row); }} /> : null}
  </Container>;
}
