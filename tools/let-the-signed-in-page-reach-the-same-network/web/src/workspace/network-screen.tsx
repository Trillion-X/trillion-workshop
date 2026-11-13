// src/workspace/network-screen.tsx
//
// PURPOSE
//   The Network: the people in it as profile cards, the places they offer to stay, and the Marketplace of everything
//   people made, behind one switch. AIs have cards of their own too: every AI a person chose to show, with its maker's
//   logo, whose AI it is and whether it takes requests, opening its person's profile to ask it for help. A person's
//   card shows only what that person chose to show: their connected AIs with each
//   AI's own logo, how many decisions, pursuits and finished jobs they have, and a way to ask to connect. Opening a
//   profile shows it beside the page with their pursuits and a way to ask one of their AIs for help. Your own profile,
//   and whether people may ask your AIs, are edited in a panel instead of sitting under everything else.
//
// REFERENCES (anatomy only; no code copied)
//   Mobbin, GetYourGuide "Featured contributors" (https://mobbin.com/screens/21670908-2287-40f4-9661-5934f6c91cd0):
//     a face beside the name, one line under it, chips, two clamped lines about them, "View profile" at the foot.
//   Mobbin, Basecamp "Everyone on the account" (https://mobbin.com/screens/1c4bcf79-c416-4094-8a88-f5a2a2f86091):
//     the same people as one searchable list.
//   21st.dev Profile-Card (component 2593): name, face, @handle and one call to action; 21st.dev Team Member Cards
//     (component 28619): a grid that fills its width, a row of small logos per person.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only what each person switched on is shown: AIs, counts and pursuits come from /work/api/network/person, which
//      leaves out whatever they did not turn on. Opening a profile reads it again from its owner.
//   2. Every control is shared: record views, listing cards, the work panel, screen states; this file writes no markup.
//   3. How a stay is priced, and the words for each way, are DATA (src/network-settings.json stays.price_kinds).

import * as React from 'react';
import { DatePicker } from '../../parts/ui/show/date-picker/DatePicker';
import { Button, Container, Input, PersonTag, ProviderMark, SegmentedControl, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, Text, Textarea, providerIconRegistry } from '../../parts/ui';
import { ListingGrid, type Listing, type ListingFact } from '../../parts/ui/show/listing-card';
import { RecordViews, type FieldDescriptor, type RecordView } from '../../parts/ui/show/record-views/record-views';
import { CollectionHeader } from '../../parts/ui/show/collection-header';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { mountSharedContent } from '../../parts/ui/show/coss/shared-content';
import { openWorkPanel } from '../../parts/screen-arrangement/show/mount-floating-panel';
import providerNames from './activity-providers.json';
import networkRules from '../network-settings.json';
import { postJson, readJson } from './api';
import { reasonOf, refusal } from './failure';
import { recordFilter } from './record-filter';
import { openAddress } from './open-screen';

type Profile = { findable: boolean; name: string; given_name?: string; family_name?: string; handle: string; about: string; offering: string; seeking: string; contact: string; links: string[]; open_to_messages: boolean; show_ais: boolean; show_counts: boolean; show_pursuits: boolean; share_service_names: boolean };
type Person = { relay: string; name: string; handle: string | null; about: string; offering: string; seeking: string; links: string[]; open_to_messages: boolean };
type AI = { agent_id: string; name: string; app: string | null; model?: string | null; takes_work?: boolean; pingable?: boolean };
type Counts = Record<string, number>;
type PersonDetails = Person & { yours: boolean; ais?: AI[]; counts?: Counts; pursuits?: { title: string; after: string }[] };
type Incoming = { request_id: string; why: string; from: string; consent: string | null; invites_to?: { membership_id: string; label: string; title: string } };
type Outgoing = { request_id: string; to: string; status: string };
type Proposed = { request_id: string; to: string; name: string; offering: string | null; why: string };
type Network = { you: Profile & { relay: string }; proposed: Proposed[]; incoming: Incoming[]; outgoing: Outgoing[] };
type Cursor = { updated_at: string; relay: string };
type PeoplePage = { people: Person[]; next_before: Cursor | null };
type Pings = { audience: string; agent_ids: string[] };
// People and open spaces on the same pursuits as you, by meaning (GET /network/on-your-path, src/person-store.mjs onYourPath).
type OnPathPerson = { relay: string; name: string; handle: string | null; about: string; open_to_messages: boolean; yours: string; theirs: string; similarity: number };
type OnPathSpace = { community_id: string; title: string; about: string | null; members: number; yours: string; similarity: number };
type OnPath = { pursuits: number; people: OnPathPerson[]; spaces: OnPathSpace[] };
type Price = { kind: string; amount_cents?: number | null; currency?: string | null };
type Stay = { stay_id: string; host_relay: string; title: string; where: string; about: string; when: string; price: Price; active?: boolean };
type First = [Network, PeoplePage, { agents: AI[] }, Pings];

const API = '/work/api/network';
const blank: Profile = { findable: true, name: '', given_name: '', family_name: '', handle: '', about: '', offering: '', seeking: '', contact: '', links: [], open_to_messages: true, show_ais: false, show_counts: false, show_pursuits: false, share_service_names: false };
const PRICE_KINDS: Record<string, { choice: string; says: string; amount?: boolean }> = networkRules.stays.price_kinds;
const DEFAULT_CURRENCY = networkRules.stays.default_currency;
/** How each count a person shows reads on their card: its icon and the words for one and for many. */
const COUNT_WORDS: { key: string; icon: string; one: string; many: string }[] = [
  { key: 'decisions', icon: 'Scale', one: 'decision', many: 'decisions' },
  { key: 'pursuits', icon: 'Target', one: 'pursuit', many: 'pursuits' },
  { key: 'work_finished', icon: 'CircleCheck', one: 'job finished', many: 'jobs finished' },
];
const TABS = [{ id: 'people', label: 'People' }, { id: 'ais', label: 'AIs' }, { id: 'stays', label: 'Stays' }, { id: 'marketplace', label: 'Marketplace' }];
const PEOPLE_FIELDS = [
  { id: 'name', label: 'Name', icon: 'User', ruleKind: 'text', filterable: true, sortable: true, width: 220, read: (person: Person) => person.name || 'Member' },
  { id: 'handle', label: 'Handle', icon: 'AtSign', ruleKind: 'text', filterable: true, sortable: true, width: 160, read: (person: Person) => (person.handle ? `@${person.handle}` : '') },
  { id: 'about', label: 'About', icon: 'Text', ruleKind: 'text', filterable: true, width: 320 },
  { id: 'offering', label: 'Offers', icon: 'Gift', ruleKind: 'text', filterable: true, width: 240 },
  { id: 'seeking', label: 'Looking for', icon: 'Search', ruleKind: 'text', filterable: true, width: 240 },
] as FieldDescriptor[];

const nameOf = (person: { name?: string | null } | null | undefined) => person?.name || 'Member';
const providerOf = (ai: AI) => (ai.app ? (providerNames.names as Record<string, string>)[ai.app] ?? null : null);
const countFacts = (counts?: Counts): ListingFact[] => COUNT_WORDS.filter(row => typeof counts?.[row.key] === 'number').map(row => {
  const value = counts![row.key];
  return { label: row.many, icon: row.icon, value: `${value} ${value === 1 ? row.one : row.many}` };
});
const money = (cents: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
const priceWords = (price: Price) => {
  const kind = PRICE_KINDS[price.kind];
  if (!kind) return '';
  return kind.amount && price.amount_cents && price.currency ? kind.says.replace('{amount}', money(price.amount_cents, price.currency)) : kind.says;
};

/** Opens a panel beside the page and draws `draw` in it; `close` shuts it. */
function openPanel(title: string, kind: string, draw: (close: () => void) => React.ReactNode) {
  const panel = openWorkPanel(title, { anchor: document.activeElement, kind });
  const body = panel.querySelector<HTMLElement>('[data-panel-body]');
  if (body) mountSharedContent(body, draw(() => panel.close()));
}

function AIIcon({ ai }: { ai: AI }) {
  const provider = providerOf(ai);
  return provider ? <ProviderMark providerSlug={provider} providerName={ai.app!} registry={providerIconRegistry} size="sm" decorative /> : <PersonTag name={ai.name} size="sm" />;
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <Container layout="horizontal" alignItems="center" gap="md"><Switch label={label} checked={checked} onCheckedChange={onChange} /><Text variant="body">{label}</Text></Container>;
}

function Said({ error, notice }: { error: string; notice: string }) {
  if (error) return <Text as="p" variant="body" color="error" role="alert">{error}</Text>;
  return notice ? <Text as="p" variant="body" role="status">{notice}</Text> : null;
}

/** Asking someone to connect: why, in a sentence or two. */
function ConnectForm({ person, onSent }: { person: Person; onSent: () => void }) {
  const [why, setWhy] = React.useState('');
  const [error, setError] = React.useState('');
  const send = async () => {
    setError('');
    try { await postJson(`${API}/request`, { to: person.relay, why: why.trim() }); onSent(); }
    catch (cause) { setError(reasonOf(cause)); }
  };
  return <Container layout="vertical" gap="md" padding="md">
    <Text variant="body" color="muted">{`Tell ${nameOf(person)} why you would like to connect. If they say yes, you can message each other in a space you share.`}</Text>
    <Textarea label="Why would you like to connect?" value={why} onChange={event => setWhy(event.target.value)} autoGrow />
    <Said error={error} notice="" />
    <Container layout="horizontal" justifyContent="end"><Button disabled={!why.trim()} onClick={send}>Send</Button></Container>
  </Container>;
}

/** One person's profile beside the page, read again from its owner when it opens. */
function PersonPanel({ relay, known, asked, onConnect, onEdit }: { relay: string; known?: PersonDetails; asked?: string; onConnect: (person: Person) => void; onEdit: () => void }) {
  const [detail, setDetail] = React.useState<PersonDetails | null>(known ?? null);
  const [failed, setFailed] = React.useState('');
  const [asking, setAsking] = React.useState(0);
  const [job, setJob] = React.useState('');
  const [key, setKey] = React.useState('');
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  React.useEffect(() => {
    setFailed('');
    readJson<PersonDetails>(`${API}/person?${new URLSearchParams({ relay })}`).then(setDetail, cause => setFailed(reasonOf(cause)));
  }, [relay, asking]);
  if (failed && !detail) return <ScreenState state={{ status: 'failed', title: 'This profile could not load', description: failed, retry: { label: 'Try again', run: () => setAsking(asking + 1) } }} />;
  if (!detail) return <ScreenState state={{ status: 'loading', label: 'Opening their profile', layout: 'preview' }} />;
  const ping = async (agent: AI) => {
    const request_key = key || crypto.randomUUID();
    setKey(request_key); setError(''); setNotice('');
    try {
      const result = await postJson<{ status: string }>(`${API}/ai-pings`, { to: detail.relay, agent_id: agent.agent_id, job: job.trim(), request_key });
      if (result.status === 'sent') { setNotice(`Your request was sent to ${agent.name}.`); setJob(''); setKey(''); }
      else setNotice('Your request is saved. Send it again if it does not arrive.');
    } catch (cause) { setError(reasonOf(cause)); }
  };
  const facts = countFacts(detail.counts);
  const pingable = detail.yours ? [] : (detail.ais ?? []).filter(ai => ai.pingable);
  return <Container layout="vertical" gap="lg" padding="md">
    <Container layout="horizontal" alignItems="center" gap="md">
      <PersonTag name={nameOf(detail)} size="md" />
      <Container layout="vertical" gap="none" flex="1">
        <Text variant="heading-xs">{nameOf(detail)}</Text>
        {detail.handle ? <Text variant="caption" color="muted">{`@${detail.handle}`}</Text> : null}
      </Container>
      {detail.yours ? <Button variant="outline" size="sm" onClick={onEdit}>Edit your profile</Button>
        : asked ? <Text variant="caption" color="muted">{asked === 'accepted' ? 'Connected' : 'Asked to connect'}</Text>
          : <Button size="sm" onClick={() => onConnect(detail)}>Ask to connect</Button>}
    </Container>
    {detail.about ? <Text variant="body">{detail.about}</Text> : null}
    {detail.offering ? <Container layout="vertical" gap="xs"><Text variant="caption" color="muted">Offers</Text><Text variant="body">{detail.offering}</Text></Container> : null}
    {detail.seeking ? <Container layout="vertical" gap="xs"><Text variant="caption" color="muted">Looking for</Text><Text variant="body">{detail.seeking}</Text></Container> : null}
    {detail.links.length ? <Container layout="horizontal" gap="sm" wrap="wrap">{detail.links.map(link => <Button key={link} variant="plain" size="sm" onClick={() => window.open(link, '_blank', 'noopener,noreferrer')}>{link.replace(/^https?:\/\//, '')}</Button>)}</Container> : null}
    {facts.length ? <Container layout="horizontal" gap="lg" wrap="wrap">{facts.map(fact => <Text key={fact.label} variant="body" color="muted">{fact.value}</Text>)}</Container> : null}
    {detail.pursuits?.length ? <Container layout="vertical" gap="sm">
      <Text variant="heading-xs">Working towards</Text>
      {detail.pursuits.map(item => <Container key={item.title} layout="vertical" gap="none"><Text variant="body">{item.title}</Text>{item.after ? <Text variant="caption" color="muted">{item.after}</Text> : null}</Container>)}
    </Container> : null}
    {detail.ais?.length ? <Container layout="vertical" gap="sm">
      <Text variant="heading-xs">{detail.yours ? 'Your AIs' : 'Their AIs'}</Text>
      {detail.ais.map(ai => <Container key={ai.agent_id} layout="horizontal" alignItems="center" gap="sm"><AIIcon ai={ai} /><Text variant="body">{ai.name}</Text></Container>)}
    </Container> : null}
    {pingable.length ? <Container layout="vertical" gap="sm">
      <Textarea label="Ask one of their AIs for help" placeholder="What would you like their AI to do?" value={job} onChange={event => { setJob(event.target.value); setKey(''); }} autoGrow />
      <Container layout="horizontal" gap="sm" wrap="wrap">{pingable.map(ai => <Button key={ai.agent_id} variant="outline" disabled={!job.trim()} onClick={() => ping(ai)}><AIIcon ai={ai} />{`Ask ${ai.name}`}</Button>)}</Container>
    </Container> : null}
    <Said error={error} notice={notice} />
  </Container>;
}

// A first and last name are asked for when making an account; an account made before that is asked once, here, without
// stopping anything. The same plain labels as the sign-up form (src/pages.mjs authForm); the answers are the profile's
// own given_name and family_name, saved by the same PUT /network/profile as the rest of the profile.
const NAME_LABELS = { given_name: 'First name', family_name: 'Last name' };
const NAMES_NEEDED = 'Enter your first name and last name.';
const NAMES_ASKED = 'trillion-network-names-asked';
const fullName = (profile: Profile) => profile.name?.trim() || [profile.given_name, profile.family_name].map(part => part?.trim()).filter(Boolean).join(' ');

function NamesAsk({ profile, onSaved }: { profile: Profile; onSaved: (profile: Profile) => void }) {
  const [given, setGiven] = React.useState(profile.given_name ?? '');
  const [family, setFamily] = React.useState(profile.family_name ?? '');
  const [later, setLater] = React.useState(() => { try { return localStorage.getItem(NAMES_ASKED) === '1'; } catch { return false; } });
  const [error, setError] = React.useState('');
  if (later || (profile.given_name?.trim() && profile.family_name?.trim())) return null;
  const notNow = () => { try { localStorage.setItem(NAMES_ASKED, '1'); } catch { /* asked again next time */ } setLater(true); };
  const save = async () => {
    setError('');
    if (!given.trim() || !family.trim()) { setError(NAMES_NEEDED); return; }
    try {
      const next = { ...profile, given_name: given.trim(), family_name: family.trim() };
      const saved = { ...blank, ...await readJson<Profile>(`${API}/profile`, { method: 'PUT', body: JSON.stringify({ ...next, name: fullName(next) }) }) };
      onSaved(saved);
    } catch (cause) { setError(reasonOf(cause)); }
  };
  return <Container layout="vertical" gap="sm" padding="md" aria-label="Your name">
    <Text variant="heading-xs">Add your first and last name</Text>
    <Text variant="body" color="muted">People you connect with see it on your profile.</Text>
    <Container layout="horizontal" gap="sm" wrap="wrap">
      <Input label={NAME_LABELS.given_name} autoComplete="given-name" value={given} onChange={event => setGiven(event.target.value)} />
      <Input label={NAME_LABELS.family_name} autoComplete="family-name" value={family} onChange={event => setFamily(event.target.value)} />
    </Container>
    {error ? <Text variant="body" color="error" role="alert">{error}</Text> : null}
    <Container layout="horizontal" gap="sm"><Button onClick={save}>Save name</Button><Button variant="outline" onClick={notNow}>Not now</Button></Container>
  </Container>;
}

/** Your own profile, what it shows, and whether people may ask your AIs for help. */
function ProfileForm({ first, myAIs, firstPings, onSaved }: { first: Profile; myAIs: AI[]; firstPings: Pings; onSaved: (profile: Profile) => void }) {
  const [profile, setProfile] = React.useState(first);
  const [pings, setPings] = React.useState(firstPings);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const field = (name: keyof Profile, value: string | boolean) => setProfile(current => ({ ...current, [name]: value }));
  const save = async () => {
    setError(''); setNotice('');
    try {
      const saved = { ...blank, ...await readJson<Profile>(`${API}/profile`, { method: 'PUT', body: JSON.stringify({ ...profile, name: fullName(profile) }) }) };
      setProfile(saved); onSaved(saved);
      setNotice(saved.findable ? 'Saved. People can find you in the network.' : 'Saved. Your profile is hidden.');
    } catch (cause) { setError(reasonOf(cause)); }
  };
  const savePings = async (next: Pings) => {
    setError(''); setNotice('');
    try { setPings(await readJson<Pings>(`${API}/ai-pings`, { method: 'PUT', body: JSON.stringify(next) })); setNotice('Saved who can ask your AIs.'); }
    catch (cause) { setError(reasonOf(cause)); }
  };
  const working = myAIs.filter(ai => ai.takes_work);
  return <Container layout="vertical" gap="lg" padding="md">
    <SwitchRow label="Let people find me" checked={profile.findable} onChange={checked => field('findable', checked)} />
    <Input label={NAME_LABELS.given_name} autoComplete="given-name" value={profile.given_name ?? ''} onChange={event => field('given_name', event.target.value)} />
    <Input label={NAME_LABELS.family_name} autoComplete="family-name" value={profile.family_name ?? ''} onChange={event => field('family_name', event.target.value)} />
    <Input label="Name" value={profile.name} onChange={event => field('name', event.target.value)} />
    <Input label="Handle" value={profile.handle} onChange={event => field('handle', event.target.value)} />
    <Textarea label="About you" value={profile.about} onChange={event => field('about', event.target.value)} autoGrow />
    <Input label="What you offer" value={profile.offering} onChange={event => field('offering', event.target.value)} />
    <Input label="What you are looking for" value={profile.seeking} onChange={event => field('seeking', event.target.value)} />
    <Input label="Contact, shared only after you connect" value={profile.contact} onChange={event => field('contact', event.target.value)} />
    <Container layout="vertical" gap="sm">
      <Text variant="heading-xs">On your card</Text>
      <SwitchRow label="Open to messages" checked={profile.open_to_messages} onChange={checked => field('open_to_messages', checked)} />
      <SwitchRow label="Show my AIs" checked={profile.show_ais} onChange={checked => field('show_ais', checked)} />
      <SwitchRow label="Show how many decisions, pursuits and jobs I have" checked={profile.show_counts} onChange={checked => field('show_counts', checked)} />
      <SwitchRow label="Show what I am working towards" checked={profile.show_pursuits} onChange={checked => field('show_pursuits', checked)} />
      <SwitchRow label="Share connected service names for recommendations" checked={profile.share_service_names} onChange={checked => field('share_service_names', checked)} />
      <Text variant="caption" color="muted">This is separate from showing your pursuits. Trillion shares only service names with a group of at least five people on similar paths; it never shares account labels or sign-in details.</Text>
    </Container>
    <Container layout="horizontal" justifyContent="end"><Button onClick={save}>Save profile</Button></Container>
    <Container layout="vertical" gap="sm">
      <Text variant="heading-xs">Asking your AIs</Text>
      <SwitchRow label="Let people ask the AIs I choose for help" checked={pings.audience === 'anyone'} onChange={checked => void savePings({ ...pings, audience: checked ? 'anyone' : 'off' })} />
      {working.map(ai => <Container key={ai.agent_id} layout="horizontal" alignItems="center" gap="md">
        <Switch label={`Allow requests to ${ai.name}`} checked={pings.agent_ids.includes(ai.agent_id)} onCheckedChange={checked => void savePings({ ...pings, agent_ids: checked ? [...pings.agent_ids, ai.agent_id] : pings.agent_ids.filter(id => id !== ai.agent_id) })} />
        <AIIcon ai={ai} /><Text variant="body">{ai.name}</Text>
      </Container>)}
      {pings.audience === 'anyone' && !working.length ? <Text variant="caption" color="muted">None of your AIs takes work yet.</Text> : null}
    </Container>
    <Said error={error} notice={notice} />
  </Container>;
}

/** Offering a place to stay, or changing one. Only the city or area is shown. */
function StayForm({ stay, onSaved }: { stay?: Stay; onSaved: () => void }) {
  const kinds = Object.entries(PRICE_KINDS);
  const [draft, setDraft] = React.useState({
    title: stay?.title ?? '', where: stay?.where ?? '', when: stay?.when ?? '', about: stay?.about ?? '', kind: stay?.price.kind ?? kinds[0][0],
    amount: stay?.price.amount_cents ? String(stay.price.amount_cents / 100) : '', currency: stay?.price.currency ?? DEFAULT_CURRENCY, active: stay?.active !== false,
  });
  const [error, setError] = React.useState('');
  const set = (name: keyof typeof draft, value: string | boolean) => setDraft(current => ({ ...current, [name]: value }));
  const needsAmount = PRICE_KINDS[draft.kind]?.amount === true;
  const save = async () => {
    setError('');
    const price: Price = needsAmount ? { kind: draft.kind, amount_cents: Math.round(Number(draft.amount) * 100), currency: draft.currency.trim().toUpperCase() } : { kind: draft.kind };
    try {
      await readJson(`${API}/stays`, { method: 'PUT', body: JSON.stringify({ ...(stay ? { stay_id: stay.stay_id } : {}), title: draft.title, where: draft.where, when: draft.when, about: draft.about, price, active: draft.active }) });
      onSaved();
    } catch (cause) { setError(reasonOf(cause)); }
  };
  return <Container layout="vertical" gap="lg" padding="md">
    <Input label="Name" placeholder="A quiet room near the park" value={draft.title} onChange={event => set('title', event.target.value)} />
    <Input label="City or area" placeholder="Lisbon" value={draft.where} onChange={event => set('where', event.target.value)} />
    <Input label="When it is free" placeholder="Most weekends" value={draft.when} onChange={event => set('when', event.target.value)} />
    <Textarea label="About it" value={draft.about} onChange={event => set('about', event.target.value)} autoGrow />
    <Select value={draft.kind} onValueChange={value => set('kind', typeof value === 'string' ? value : draft.kind)}>
      <SelectTrigger aria-label="Price"><SelectValue>{PRICE_KINDS[draft.kind]?.choice}</SelectValue></SelectTrigger>
      <SelectPopup>{kinds.map(([id, kind]) => <SelectItem key={id} value={id}>{kind.choice}</SelectItem>)}</SelectPopup>
    </Select>
    {needsAmount ? <Container layout="horizontal" gap="md">
      <Input label="Price a night" type="number" min="1" step="0.01" value={draft.amount} onChange={event => set('amount', event.target.value)} />
      <Input label="Currency" value={draft.currency} maxLength={3} onChange={event => set('currency', event.target.value)} />
    </Container> : null}
    <SwitchRow label="Show this stay" checked={draft.active} onChange={checked => set('active', checked)} />
    <Said error={error} notice="" />
    <Container layout="horizontal" justifyContent="end"><Button disabled={!draft.title.trim() || !draft.where.trim()} onClick={save}>{stay ? 'Save stay' : 'Offer this stay'}</Button></Container>
  </Container>;
}

/** Asking a host to stay: the dates and a note. */
function AskStayForm({ stay, host }: { stay: Stay; host: string }) {
  const [start, setStart] = React.useState('');
  const [end, setEnd] = React.useState('');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const send = async () => {
    setError(''); setNotice('');
    try {
      const sent = await postJson<{ already_asked?: boolean }>(`${API}/stays/ask`, { stay_id: stay.stay_id, host_relay: stay.host_relay, start_date: start, end_date: end, note: note.trim() });
      setNotice(sent.already_asked ? `You already asked ${host} for these dates.` : `Your request was sent to ${host}. If they say yes, you can talk it through in a space you share.`);
    } catch (cause) { setError(reasonOf(cause)); }
  };
  return <Container layout="vertical" gap="lg" padding="md">
    <Text variant="body" color="muted">{[stay.where, priceWords(stay.price)].filter(Boolean).join(' · ')}</Text>
    <Container layout="horizontal" gap="md" wrap="wrap">
      <DatePicker label="Arrive" aria-label="Arrive" value={start} onChange={next => setStart(next ?? '')} />
      <DatePicker label="Leave" aria-label="Leave" value={end} onChange={next => setEnd(next ?? '')} />
    </Container>
    <Textarea label={`A note to ${host}`} value={note} onChange={event => setNote(event.target.value)} autoGrow />
    <Said error={error} notice={notice} />
    <Container layout="horizontal" justifyContent="end"><Button disabled={!start || !end || !note.trim()} onClick={send}>Ask to stay</Button></Container>
  </Container>;
}

const stayListing = (stay: Stay, host: Person | null, mine: boolean): Listing => ({
  id: stay.stay_id,
  title: stay.title,
  icon: 'House',
  byline: mine ? undefined : nameOf(host),
  when: stay.when || undefined,
  text: stay.about || undefined,
  facts: [{ label: 'Where', value: stay.where, icon: 'MapPin' }, ...(priceWords(stay.price) ? [{ label: 'Price', value: priceWords(stay.price), icon: 'Tag' }] : [])],
  ...(mine && stay.active === false ? { badge: { label: 'Hidden', tone: 'quiet' } } : {}),
  actions: mine ? [{ id: 'edit', label: 'Edit', icon: 'Pencil' }] : [{ id: 'ask', label: 'Ask to stay', icon: 'CalendarPlus', primary: true }],
});

/** Your stays and the stays of people in the network. */
function StaysTab({ me, people }: { me: string; people: Person[] }) {
  const hosts = people.filter(person => person.relay !== me);
  const loaded = useScreenLoad(`network-stays:${hosts.length}`, {
    loading: { label: 'Loading places to stay', layout: 'gallery' },
    read: () => Promise.all([
      readJson<{ stays: Stay[] }>(`${API}/stays`).then(answer => answer.stays),
      Promise.all(hosts.map(host => readJson<{ stays: Stay[] }>(`${API}/stays?${new URLSearchParams({ host_relay: host.relay })}`).then(answer => answer.stays, () => [] as Stay[]))).then(rows => rows.flat()),
    ]),
    failed: refusal('Places to stay could not load'),
  });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  const [mine, others] = loaded.value;
  const offer = (stay?: Stay) => openPanel(stay ? stay.title : 'Offer a stay', 'network-stay', close => <StayForm stay={stay} onSaved={() => { close(); void loaded.reload(); }} />);
  const hostOf = (stay: Stay) => hosts.find(person => person.relay === stay.host_relay) ?? null;
  const askFor = (id: string) => {
    const stay = others.find(one => one.stay_id === id);
    if (stay) openPanel(`Stay at ${stay.title}`, 'network-ask-stay', () => <AskStayForm stay={stay} host={nameOf(hostOf(stay))} />);
  };
  return <Container layout="vertical" gap="xl">
    <Container layout="vertical" gap="md">
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="md">
        <Text variant="heading-xs">Your stays</Text>
        {mine.length ? <Button variant="outline" size="sm" onClick={() => offer()}>Offer a stay</Button> : null}
      </Container>
      {mine.length ? <ListingGrid label="Your stays" listings={mine.map(stay => stayListing(stay, null, true))} onAction={id => offer(mine.find(one => one.stay_id === id))} />
        : <ScreenState state={{ status: 'empty', icon: 'House', title: 'You are not offering a place to stay', description: 'Offer a room or a couch to people in the network. Only the city or area is shown, never your address.', action: { label: 'Offer a stay', run: () => offer() } }} />}
    </Container>
    <Container layout="vertical" gap="md">
      <Text variant="heading-xs">Places to stay</Text>
      {others.length ? <ListingGrid label="Places to stay" listings={others.map(stay => stayListing(stay, hostOf(stay), false))} onAction={askFor} />
        : <ScreenState state={{ status: 'empty', icon: 'MapPin', title: 'Nobody is offering a place to stay yet', description: 'When someone in the network offers a room, it shows here.' }} />}
    </Container>
  </Container>;
}

/** The Marketplace screen itself, drawn in place. */
function MarketplaceHost() {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let stop: (() => void) | null = null;
    let gone = false;
    void import('../../../../browse-and-publish-what-my-ai-can-use/web/src/workspace/marketplace-screen').then(module => { if (!gone && host.current) stop = module.mountMarketplaceScreen(host.current); });
    return () => { gone = true; stop?.(); };
  }, []);
  return <Container ref={host} layout="vertical" flex="1" minHeight="0" />;
}

/** People and spaces on the same pursuits as you: each card names their pursuit beside yours. Read after the screen opens,
 *  so the rest of the Network never waits for it; nothing shows when nothing is close. */
function OnYourPath({ askedOf, onConnect, onOpenPerson }: { askedOf: (relay: string) => string | undefined; onConnect: (person: Person) => void; onOpenPerson: (relay: string) => void }) {
  const [found, setFound] = React.useState<OnPath | null>(null);
  React.useEffect(() => { readJson<OnPath>(`${API}/on-your-path`).then(setFound, () => setFound(null)); }, []);
  const words = networkRules.on_your_path.words;
  if (!found || (!found.people.length && !found.spaces.length)) return null;
  const people: Listing[] = found.people.map(person => {
    const state = askedOf(person.relay);
    return {
      id: person.relay, title: person.name, byline: person.handle ? `@${person.handle}` : undefined, face: { name: person.name },
      text: words.person_text.replace('{theirs}', person.theirs).replace('{yours}', person.yours),
      ...(state ? { badge: { label: state === 'accepted' ? 'Connected' : 'Asked', tone: state === 'accepted' ? 'good' : 'quiet' } } : {}),
      actions: [...(state ? [] : [{ id: 'connect', label: 'Ask to connect', icon: 'UserPlus', primary: true }]), { id: 'view', label: 'View profile' }],
    };
  });
  const spaces: Listing[] = found.spaces.map(space => ({
    id: space.community_id, title: space.title, icon: 'UsersRound',
    text: words.space_text.replace('{yours}', space.yours),
    facts: [{ label: words.members, value: String(space.members), icon: 'UsersRound' }],
    actions: [{ id: 'open', label: words.open_space, icon: 'ArrowRight', primary: true }],
  }));
  return <Container layout="vertical" gap="md" data-on-your-path="">
    <Text variant="heading-xs">{words.heading}</Text>
    {people.length ? <ListingGrid label={words.heading} listings={people} onAction={(relay, action) => {
      const person = found.people.find(one => one.relay === relay);
      if (action === 'connect' && person) onConnect({ relay: person.relay, name: person.name, handle: person.handle, about: person.about, offering: '', seeking: '', links: [], open_to_messages: person.open_to_messages });
      else onOpenPerson(relay);
    }} /> : null}
    {spaces.length ? <ListingGrid label={words.spaces_heading} listings={spaces} onAction={id => void openAddress(`/spaces/${encodeURIComponent(id)}`)} /> : null}
  </Container>;
}

const readNetwork = () => Promise.all([readJson<Network>(API), readJson<PeoplePage>(`${API}/people`), readJson<{ agents: AI[] }>('/work/api/ai-work'), readJson<Pings>(`${API}/ai-pings`)]) as Promise<First>;

/** The network screen, read through the shared screen-state lifecycle: loading cards, then the screen or why it could not load. */
function NetworkLoad() {
  const loaded = useScreenLoad('network', { loading: { label: 'Loading your network', layout: 'gallery' }, read: readNetwork, failed: refusal('Your network could not load') });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <NetworkScreen first={loaded.value} />;
}

function NetworkScreen({ first }: { first: First }) {
  const [tab, setTab] = React.useState('people');
  const [profile, setProfile] = React.useState<Profile>(blank);
  const [myRelay, setMyRelay] = React.useState('');
  const [people, setPeople] = React.useState<Person[]>([]);
  const [before, setBefore] = React.useState<Cursor | null>(null);
  const [details, setDetails] = React.useState<Record<string, PersonDetails | null>>({});
  const [proposed, setProposed] = React.useState<Proposed[]>([]);
  const [incoming, setIncoming] = React.useState<Incoming[]>([]);
  const [outgoing, setOutgoing] = React.useState<Outgoing[]>([]);
  const [myAIs, setMyAIs] = React.useState<AI[]>([]);
  const [pings, setPings] = React.useState<Pings>({ audience: 'off', agent_ids: [] });
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const read = React.useRef(new Set<string>());
  // What the screen read is put in place as it opens, and again when a later read of it answers differently.
  React.useEffect(() => {
    const [network, page, work, firstPings] = first;
    setProfile({ ...blank, ...network.you }); setMyRelay(network.you.relay); setProposed(network.proposed ?? []); setIncoming(network.incoming ?? []); setOutgoing(network.outgoing ?? []);
    setPeople(page.people); setBefore(page.next_before); setMyAIs(work.agents ?? []); setPings(firstPings);
  }, [first]);
  // Each card shows what its person turned on (their AIs, counts), read once per person from their own profile.
  React.useEffect(() => {
    for (const person of people) {
      if (read.current.has(person.relay)) continue;
      read.current.add(person.relay);
      readJson<PersonDetails>(`${API}/person?${new URLSearchParams({ relay: person.relay })}`)
        .then(found => setDetails(current => ({ ...current, [person.relay]: found })), () => setDetails(current => ({ ...current, [person.relay]: null })));
    }
  }, [people]);

  const askedOf = (relay: string) => outgoing.find(row => row.to === relay)?.status;
  const kept = (saved: Profile) => {
    setProfile(saved);
    setPeople(current => current.map(person => (person.relay === myRelay ? { ...person, name: saved.name, handle: saved.handle || null, about: saved.about, offering: saved.offering, seeking: saved.seeking } : person)));
    read.current.delete(myRelay); setDetails(current => { const next = { ...current }; delete next[myRelay]; return next; });
  };
  const editProfile = () => openPanel('Your profile', 'network-profile', () => <ProfileForm first={profile} myAIs={myAIs} firstPings={pings} onSaved={kept} />);
  const connect = (person: Person) => openPanel(`Ask ${nameOf(person)} to connect`, 'network-connect', close => <ConnectForm person={person} onSent={() => {
    close(); setOutgoing(current => [...current, { request_id: '', to: person.relay, status: 'sent' }]); setNotice(`Your request was sent to ${nameOf(person)}.`);
  }} />);
  const openPerson = (relay: string) => {
    const person = people.find(one => one.relay === relay);
    openPanel(nameOf(person), 'network-person', close => <PersonPanel relay={relay} known={details[relay] ?? undefined} asked={askedOf(relay)} onConnect={found => { close(); connect(found); }} onEdit={() => { close(); editProfile(); }} />);
  };
  const loadMore = async () => {
    if (!before) return;
    setError('');
    try {
      const page = await readJson<PeoplePage>(`${API}/people?${new URLSearchParams({ before: JSON.stringify(before) })}`);
      setPeople(current => [...current, ...page.people.filter(person => !current.some(one => one.relay === person.relay))]); setBefore(page.next_before);
    } catch (cause) { setError(reasonOf(cause)); }
  };
  const answer = async (request_id: string, accept: boolean) => {
    setError(''); setNotice('');
    try {
      await postJson(`${API}/answer`, { request_id, accept, consent: incoming.find(row => row.request_id === request_id)?.consent ?? null });
      setIncoming(current => current.filter(row => row.request_id !== request_id));
      setNotice(accept ? 'You are connected. You can message each other in the pursuit you now share.' : 'Declined.');
    } catch (cause) { setError(reasonOf(cause)); }
  };

  // A person Trillion proposed: sent as a request to meet (charged like any request), or passed.
  const firstWords = networkRules.first_matches.words;
  const answerProposal = async (request_id: string, send: boolean) => {
    const row = proposed.find(one => one.request_id === request_id);
    if (!row) return;
    setError(''); setNotice('');
    try {
      await postJson(`${API}/request`, { proposal_id: request_id, ...(send ? {} : { pass: true }) });
      setProposed(current => current.filter(one => one.request_id !== request_id));
      if (send) setOutgoing(current => [...current, { request_id, to: row.to, status: 'sent' }]);
      setNotice((send ? firstWords.sent : firstWords.passed).replace('{name}', row.name));
    } catch (cause) { setError(reasonOf(cause)); }
  };
  const proposal = (row: Proposed): Listing => ({
    id: row.request_id,
    title: row.name,
    face: { name: row.name },
    text: row.why,
    actions: [{ id: 'send', label: firstWords.send, icon: 'UserPlus', primary: true }, { id: 'pass', label: firstWords.pass }],
  });

  const personListing = (person: Person): Listing => {
    const mine = person.relay === myRelay;
    const detail = details[person.relay];
    const state = mine ? undefined : askedOf(person.relay);
    return {
      id: person.relay,
      title: nameOf(person),
      byline: person.handle ? `@${person.handle}` : undefined,
      face: { name: nameOf(person) },
      text: person.about || person.offering || undefined,
      chips: detail?.ais?.map(ai => ({ label: ai.name })),
      facts: countFacts(detail?.counts),
      ...(mine ? { badge: { label: 'You', tone: 'info' } } : state ? { badge: { label: state === 'accepted' ? 'Connected' : 'Asked', tone: state === 'accepted' ? 'good' : 'quiet' } } : {}),
      actions: mine ? [{ id: 'edit', label: 'Edit your profile', icon: 'Pencil' }, { id: 'view', label: 'View' }]
        : [...(state ? [] : [{ id: 'connect', label: 'Ask to connect', icon: 'UserPlus', primary: true }]), { id: 'view', label: 'View profile' }],
    };
  };
  const onCard = (relay: string, action: string) => {
    const person = people.find(one => one.relay === relay);
    if (action === 'edit') editProfile();
    else if (action === 'connect' && person) connect(person);
    else openPerson(relay);
  };
  const views: RecordView[] = [
    { id: 'cards', label: 'Cards', icon: 'LayoutGrid', render: ({ records }) => <ListingGrid label="People" listings={(records as Person[]).map(personListing)} onAction={onCard} /> },
    { id: 'table', label: 'List', icon: 'List' },
  ];
  const invitation = (row: Incoming): Listing => {
    const from = people.find(person => person.relay === row.from);
    return {
      id: row.request_id,
      title: row.invites_to ? `Invitation to ${row.invites_to.title}` : `${nameOf(from)} asked to connect`,
      face: { name: nameOf(from) },
      text: row.why,
      actions: [{ id: 'accept', label: 'Accept', icon: 'Check', primary: true }, { id: 'decline', label: 'Decline' }],
    };
  };
  const alone = people.every(person => person.relay === myRelay);
  // Every AI the people here chose to show, each as its own card: whose it is, its maker's logo, whether it takes requests.
  const shownAIs = people.flatMap(person => (details[person.relay]?.ais ?? []).map(ai => ({ person, ai })));
  const aiListing = ({ person, ai }: { person: Person; ai: AI }, index: number): Listing => {
    const mine = person.relay === myRelay;
    return {
      id: String(index),
      title: ai.name,
      byline: mine ? 'Your AI' : `${nameOf(person)}'s AI`,
      face: { name: ai.name, provider: providerOf(ai) },
      text: ai.model && ai.model !== 'unknown' ? ai.model : undefined,
      chips: [{ label: nameOf(person) }],
      ...(ai.pingable ? { badge: { label: 'Takes requests', tone: 'good' } } : {}),
      actions: !mine && ai.pingable ? [{ id: 'ask', label: `Ask ${ai.name}`, icon: 'MessageSquarePlus', primary: true }, { id: 'view', label: 'View profile' }]
        : [{ id: mine ? 'edit' : 'view', label: mine ? 'Edit your profile' : 'View profile' }],
    };
  };
  const onAICard = (id: string, action: string) => {
    const shown = shownAIs[Number(id)];
    if (action === 'edit') editProfile();
    else if (shown) openPerson(shown.person.relay);
  };

  return <Container layout="vertical" gap="xl" padding="lg" flex="1" minHeight="0" overflow="y-auto" aria-label="Network">
    <Container layout="vertical" gap="lg" width="full" maxWidth="6xl" marginX="auto">
      <CollectionHeader title="Network" lead="People to meet, the AIs they work with, places to stay, and everything people made." actions={[{ id: 'profile', label: 'Edit your profile', icon: 'UserPen' }]} onAction={() => editProfile()} />
      <SegmentedControl ariaLabel="Show" items={TABS} value={tab} onValueChange={setTab} />
      <Said error={error} notice={notice} />
      {myRelay ? <NamesAsk key={myRelay} profile={profile} onSaved={saved => { kept(saved); setNotice('Saved your name.'); }} /> : null}
      {tab === 'people' ? <Container layout="vertical" gap="xl">
        {proposed.length ? <Container layout="vertical" gap="md">
          <Text variant="heading-xs">{firstWords.heading}</Text>
          <ListingGrid label={firstWords.heading} listings={proposed.map(proposal)} onAction={(id, action) => void answerProposal(id, action === 'send')} />
        </Container> : null}
        {incoming.length ? <Container layout="vertical" gap="md">
          <Text variant="heading-xs">Waiting for your answer</Text>
          <ListingGrid label="Waiting for your answer" listings={incoming.map(invitation)} onAction={(id, action) => void answer(id, action === 'accept')} />
        </Container> : null}
        <OnYourPath askedOf={askedOf} onConnect={connect} onOpenPerson={openPerson} />
        <RecordViews
          label="People"
          fields={PEOPLE_FIELDS}
          records={people}
          identify={(person: Person) => person.relay}
          views={views}
          onOpen={openPerson}
          preferenceKey="trillion-network-people"
          emptyMessage="Nobody matches."
          {...recordFilter}
        />
        {alone ? <ScreenState state={{ status: 'empty', icon: 'UsersRound', title: 'Nobody else is here yet', description: 'When people make their profile findable, they show here. Fill in yours so they can find you.', action: { label: 'Edit your profile', run: editProfile } }} /> : null}
        {before ? <Container layout="horizontal" justifyContent="center"><Button variant="outline" size="sm" onClick={loadMore}>More people</Button></Container> : null}
      </Container> : tab === 'ais' ? (shownAIs.length
        ? <ListingGrid label="AIs" listings={shownAIs.map(aiListing)} onAction={onAICard} />
        : <ScreenState state={{ status: 'empty', icon: 'Bot', title: 'No AIs shown yet', description: 'When people turn on Show my AIs, their AIs show here, and the ones that take requests can be asked for help. Turn it on in your profile to show yours.', action: { label: 'Edit your profile', run: editProfile } }} />)
        : tab === 'stays' ? <StaysTab me={myRelay} people={people} /> : <MarketplaceHost />}
    </Container>
  </Container>;
}

export function mountNetworkScreen(element: HTMLElement): () => void { return mountReactSurface(element, <NetworkLoad />); }
