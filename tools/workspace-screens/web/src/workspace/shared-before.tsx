// src/workspace/shared-before.tsx
//
// PURPOSE
//   Shared before, on the Sharing screen: everything the person shared into Trillion from any device (Chrome, Android,
//   iPhone, the web, any AI), newest first, from the one share list (GET /work/api/shares, the same answer the
//   shares_sent tool gives every AI). Each share shows every thing in it, each as its kind's look in
//   shared-item-looks.json says (a link as its own preview, selected words quoted, a post's words and pictures, a kept
//   picture as itself; a kind without a row shows what it carries), where it
//   came from, when, their own words and where it went; Open, Send again (places, what the AI does, a note and which
//   AI takes it, the same choices every share offers) and Hand to my AI (one of their actions, straight to their own
//   Trillion) act on it where it is listed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every share is sent again through the one delivery road (POST /work/api/share-destinations/deliver,
//      deliver_share), never a second road; the places, actions and AIs offered are the person's current ones.
//   2. Every control is a shared part (parts/ui); this file writes no markup and no appearance, and never branches on
//      an item's kind: a new kind is a row in shared-item-looks.json.
//   3. Nothing is hidden behind a device: a share a device kept without sending it through Trillion shows as kept in their Files, with Send again.

import * as React from 'react';
import { Button, Card, Container, Dropdown, ImageBlock, NamedIcon, Text, Textarea } from '../../parts/ui';
import { LinkPreview } from '../../parts/ui/show/link-preview';
import looks from './shared-item-looks.json';
import { ChoiceList } from '../../parts/ui/show/choice-list';
import { relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import { ScreenState } from '../../parts/ui/show/screen-state';
import { mountSharedContent } from '../../parts/ui/show/coss/shared-content';
import { openWorkPanel } from '../../parts/screen-arrangement/show/mount-floating-panel';
import { notify } from '../../parts/ui/show/coss/notifications';
import { postJson, readJson } from './api';
import type { DeliverAnswer } from './share-outbox';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
// One thing shared, as deliver_share took it: its kind and whatever fields that kind carries.
type Item = { kind?: string; url?: string; page_url?: string } & Record<string, unknown>;
type Place = { id: string; label: string };
export type Share = {
  share_id: string; at: string; from: string | null; items: Item[]; own_words: string | null; actions: Place[]; sent_to: Place[];
  preview: { title?: string | null; site?: string | null; host?: string | null; description?: string | null; image?: string | null } | null;
  status?: string | null; inbox_state?: 'waiting' | 'refused'; reason?: string | null; reason_code?: string;
  presentation?: { state: 'unavailable' | 'withdrawn'; code: string; fields: Record<string, string> };
};
type Page = { shares: Share[]; next_before: string | null };
type Choices = { destinations: (Place & { description?: string | null; to: { private?: true; tool_id?: string }; on_by_default: boolean })[]; actions: (Place & { words: string })[] };
type Agent = { agent_id: string; name: string; ready_now: boolean };

const WORDS = {
  heading: 'Shared before', loading: 'Loading what you shared', failed: 'What you shared could not load',
  empty: 'Nothing shared yet. Share from Chrome, your phone or any app, and it shows up here.',
  more: 'Show more', open: 'Open', again: 'Send again', hand: 'Hand to my AI', kept: 'Kept in your Files', sent_to: 'Sent to',
  your_words: 'Your words', send_to: 'Send to', then: 'What your AI does', note: 'Note for your AI', note_hint: 'What to look for, or what to make from it',
  who: 'Which AI takes it', any_ai: 'Whichever is free', free_now: 'Free now', when_connected: 'Gets it when it next connects', send: 'Send', sending: 'Sending', pick_place: 'Pick at least one place.',
  sent: (places: string) => `Sent to ${places}`, handed: (action: string) => `Handed to your AI: ${action}`,
  stopped: (error: string, places: string) => `${error}${places ? ` It was sent to ${places}.` : ''}`,
};
// Where a share is sent again from, as the person's list names it.
const FROM_HERE = 'Web';
const listed = (labels: string[]) => new Intl.ListFormat('en', { type: 'conjunction' }).format(labels);
const addressOf = (item: Item) => item.url ?? item.page_url ?? null;
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

async function deliver(share: Share, body: { to: string[]; action?: string | string[]; own_words?: string; to_agent?: string[] }): Promise<{ places: string; answer: DeliverAnswer }> {
  const answer = await postJson<DeliverAnswer>('/work/api/share-destinations/deliver', { items: share.items, request_key: crypto.randomUUID(), from: FROM_HERE, from_agent: 'trillion-web', ...body });
  const places = listed((answer.delivered ?? []).map(place => place.label));
  if (answer.stopped_at) throw new Error(WORDS.stopped(answer.stopped_at.error, places));
  return { places, answer };
}

// How each kind of thing shared is shown is DATA (shared-item-looks.json): a label and the parts drawn, each reading
// the fields it names. A kind without a row is drawn with `other`.
type Part = { part: string; from?: string[]; address?: string[]; title?: string[]; description?: string[]; picture?: string[]; quoted?: boolean; kept?: boolean };
type Look = { label?: string; parts: Part[] };
const LOOKS = looks as { kinds: Record<string, Look>; other: Look };
const lookOf = (item: Item) => (item.kind && Object.hasOwn(LOOKS.kinds, item.kind) ? LOOKS.kinds[item.kind] : LOOKS.other);
const present = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
/** The first text among an item's named fields. */
const first = (item: Item, fields: string[] = []) => fields.map(field => item[field]).find(present) ?? null;
/** Every text among an item's named fields, each value of a list field counted. */
const every = (item: Item, fields: string[] = []) => [...new Set(fields.flatMap(field => [item[field]].flat()).filter(present))];
// A file kept in the person's Files, by its identity.
const keptBytes = (identity: string) => `/work/api/namespace/bytes/${encodeURIComponent(identity)}`;

// How each part a look names is drawn from one item; the share's read preview belongs to its first link.
const PARTS: Record<string, (part: Part, item: Item, share: Share, label: string) => React.ReactNode> = {
  'link-card': (part, item, share) => {
    const url = first(item, part.address);
    if (!url) return null;
    const preview = share.items.map(addressOf).find(Boolean) === url ? share.preview : null;
    return (
      <LinkPreview url={url} title={preview?.title || first(item, part.title) || url} site={preview?.site || preview?.host || hostOf(url)}
        picture={preview?.image || first(item, part.picture)} description={preview?.description || first(item, part.description)} />
    );
  },
  words: (part, item) => {
    const words = first(item, part.from);
    if (!words) return null;
    const shown = <Text variant="body" wrap="preserve">{words}</Text>;
    return part.quoted ? <Container border="quote">{shown}</Container> : shown;
  },
  pictures: (part, item, _share, label) => {
    const pictures = every(item, part.from);
    return pictures.length ? (
      <Container layout="horizontal" gap="sm" wrap>
        {pictures.map(picture => <ImageBlock key={picture} src={part.kept ? keptBytes(picture) : picture} alt={label} maxHeight="13rem" objectFit="cover" rounded="md" />)}
      </Container>
    ) : null;
  },
  caption: (part, item) => {
    const said = first(item, part.from);
    return said ? <Text variant="caption" color="muted" truncate>{said}</Text> : null;
  },
};

/** One thing shared, as its look draws it: a labelled card, or its parts standing on their own. */
function SharedItem({ item, share }: { item: Item; share: Share }) {
  const look = lookOf(item);
  const label = look.label ?? '';
  const parts = look.parts.map((part, index) => <React.Fragment key={index}>{PARTS[part.part]?.(part, item, share, label) ?? null}</React.Fragment>);
  if (!look.label) return <Container layout="vertical" gap="xs">{parts}</Container>;
  return (
    <Card variant="surface" padding="md">
      <Container layout="vertical" gap="xs">
        <Text variant="label" color="muted">{look.label}</Text>
        {parts}
      </Container>
    </Card>
  );
}

/** What one share was: every thing in it, in the order it was sent. */
function WhatWasShared({ share }: { share: Share }) {
  return (
    <Container layout="vertical" gap="sm">
      {share.items.map((item, index) => <SharedItem key={index} item={item} share={share} />)}
    </Container>
  );
}

/** Send again: the places, actions, note and AIs, as every share offers them, over the person's current choices; any
 *  number of each, every one ticked in the same list. */
function SendAgain({ share, done }: { share: Share; done: (said: string) => void }) {
  const [choices, setChoices] = React.useState<(Choices & { agents: Agent[] }) | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [places, setPlaces] = React.useState<string[]>([]);
  const [chosenActions, setActions] = React.useState<string[]>([]);
  const [note, setNote] = React.useState(share.own_words ?? '');
  const [agents, setAgents] = React.useState<string[]>([]);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]);
  const [sending, setSending] = React.useState(false);
  React.useEffect(() => {
    Promise.all([readJson<Choices>('/work/api/share-destinations'), readJson<{ agents: Agent[] }>('/work/api/share-agents')]).then(([read, found]) => {
      setChoices({ ...read, agents: found.agents });
      setPlaces(read.destinations.filter(place => place.on_by_default).map(place => place.id));
      const before = share.actions.map(row => row.id).filter(id => read.actions.some(row => row.id === id));
      setActions(before.length ? before : read.actions.slice(0, 1).map(row => row.id));
    }, error => setFailed(errorWords(error)));
  }, [share]);
  if (failed) return <ScreenState state={{ status: 'failed', icon: 'CircleAlert', title: WORDS.failed, description: failed }} />;
  if (!choices) return <ScreenState state={{ status: 'loading', label: WORDS.loading, layout: 'rows' }} />;
  const toPrivate = places.some(id => choices.destinations.find(place => place.id === id)?.to.private);
  const send = async () => {
    if (!places.length) return notify(WORDS.pick_place, { kind: 'error' });
    setSending(true);
    try {
      const own = note.trim();
      const delivered = await deliver(share, { to: places, ...(chosenActions.length ? { action: chosenActions } : {}), ...(own ? { own_words: own } : {}), ...(toPrivate && agents.length ? { to_agent: agents } : {}) });
      done(delivered.answer.queued ? delivered.answer.words ?? '' : WORDS.sent(delivered.places));
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    } finally {
      setSending(false);
    }
  };
  return (
    <Container layout="vertical" gap="lg" padding="md">
      <WhatWasShared share={share} />
      <Container layout="vertical" gap="sm">
        <Text variant="heading-xs">{WORDS.send_to}</Text>
        <ChoiceList label={WORDS.send_to} chosen={places} items={choices.destinations.map(place => ({ id: place.id, label: place.label, detail: place.description, icon: place.to.private ? 'Sparkles' : place.to.tool_id ? 'MessageSquareHeart' : 'Users' }))}
          onToggle={id => setPlaces(toggle(places, id))} />
      </Container>
      {choices.actions.length ? (
        <Container layout="vertical" gap="sm">
          <Text variant="heading-xs">{WORDS.then}</Text>
          <ChoiceList label={WORDS.then} chosen={chosenActions} items={choices.actions.map(row => ({ id: row.id, label: row.label, detail: row.words }))} onToggle={id => setActions(toggle(chosenActions, id))} />
        </Container>
      ) : null}
      <Textarea label={WORDS.note} placeholder={WORDS.note_hint} value={note} rows={3} autoGrow maxHeight={200} maxLength={8000} onChange={event => setNote(event.target.value)} />
      {toPrivate && choices.agents.length ? (
        <Container layout="vertical" gap="sm">
          <Text variant="heading-xs">{WORDS.who}</Text>
          {/* Nothing ticked is whichever AI is free; ticking it clears the rest. */}
          <ChoiceList label={WORDS.who} chosen={agents.length ? agents : ['']}
            items={[{ id: '', label: WORDS.any_ai }, ...choices.agents.map(row => ({ id: row.agent_id, label: row.name, detail: row.ready_now ? WORDS.free_now : WORDS.when_connected }))]}
            onToggle={id => setAgents(id ? toggle(agents, id) : [])} />
        </Container>
      ) : null}
      <Button variant="primary" disabled={sending || !places.length} onClick={send}>{sending ? WORDS.sending : WORDS.send}</Button>
    </Container>
  );
}

function openSendAgain(share: Share, anchor: Element | null, onSent: () => void) {
  const panel = openWorkPanel(WORDS.again, { anchor, kind: 'send-again' });
  const body = panel.querySelector<HTMLElement>('[data-panel-body]');
  if (!body) return;
  mountSharedContent(body, <SendAgain share={share} done={said => { if (said) notify(said); panel.close(); onSent(); }} />);
}

function ShareRow({ share, actions, onSent }: { share: Share; actions: Place[]; onSent: () => void }) {
  const link = share.items.map(addressOf).find(Boolean);
  const where = share.inbox_state ? share.status ?? share.reason ?? null
    : share.sent_to.length ? `${WORDS.sent_to} ${listed(share.sent_to.map(place => place.label))}` : WORDS.kept;
  const hand = async (id: string) => {
    try {
      const delivered = await deliver(share, { to: ['private'], action: id, ...(share.own_words ? { own_words: share.own_words } : {}) });
      if (delivered.answer.queued) { if (delivered.answer.words) notify(delivered.answer.words); }
      else notify(WORDS.handed(actions.find(row => row.id === id)?.label ?? id));
      onSent();
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    }
  };
  return (
    <Container layout="vertical" gap="sm">
      <WhatWasShared share={share} />
      <Text variant="caption" color="muted">{[share.from, relativeWhen(share.at), where].filter(Boolean).join(' · ')}</Text>
      {share.reason && where !== share.reason && !where?.includes(share.reason) ? <Text variant="caption" color="muted">{share.reason}</Text> : null}
      {share.own_words ? (
        <Container layout="vertical" gap="xs">
          <Text variant="label" color="muted">{WORDS.your_words}</Text>
          <Text variant="body">{share.own_words}</Text>
        </Container>
      ) : null}
      <Container layout="horizontal" gap="sm" alignItems="center">
        {link ? (
          <Button size="sm" variant="outline" onClick={() => window.open(link, '_blank', 'noopener')}>
            <NamedIcon name="ExternalLink" size="sm" aria-hidden />
            {WORDS.open}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={event => openSendAgain(share, event.currentTarget, onSent)}>
          <NamedIcon name="Send" size="sm" aria-hidden />
          {WORDS.again}
        </Button>
        {actions.length ? (
          <Dropdown value="" aria-label={WORDS.hand} items={actions.map(row => ({ value: row.id, label: row.label }))} onValueChange={hand}
            customTrigger={(
              <Button size="sm" variant="outline">
                <NamedIcon name="Sparkles" size="sm" aria-hidden />
                {WORDS.hand}
                <NamedIcon name="ChevronDown" size="sm" aria-hidden />
              </Button>
            )} />
        ) : null}
      </Container>
    </Container>
  );
}

/** Where the newest page of shares is read. */
export const SHARES_ROUTE = '/work/api/shares';
export type SharesPage = Page;

/** The Shared before section: `actions` are the person's current actions and `first` the newest page of shares, both
 *  read with the Sharing screen's own read. Trying again after a failure reads the page again here. */
export function SharedBefore({ actions, first }: { actions: Place[]; first: Page }) {
  const [shares, setShares] = React.useState<Share[] | null>(first.shares);
  const [next, setNext] = React.useState<string | null>(first.next_before);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState(0);
  React.useEffect(() => {
    if (!asked) return;
    setFailed(null);
    readJson<Page>(SHARES_ROUTE).then(page => { setShares(page.shares); setNext(page.next_before); }, error => setFailed(errorWords(error)));
  }, [asked]);
  const more = async () => {
    if (!next) return;
    try {
      const page = await readJson<Page>(`/work/api/shares?before=${encodeURIComponent(next)}`);
      setShares(now => [...(now ?? []), ...page.shares]);
      setNext(page.next_before);
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    }
  };
  const again = () => setAsked(value => value + 1);
  return (
    <Container layout="vertical" gap="sm">
      <Text variant="heading-xs">{WORDS.heading}</Text>
      {failed ? <ScreenState state={{ status: 'failed', icon: 'CircleAlert', title: WORDS.failed, description: failed, retry: { label: 'Try again', run: again } }} />
        : !shares ? <ScreenState state={{ status: 'loading', label: WORDS.loading, layout: 'rows' }} />
          : !shares.length ? <Text variant="body" color="muted">{WORDS.empty}</Text>
            : (
              <Container layout="vertical" gap="xl">
                {shares.map(share => <ShareRow key={share.share_id} share={share} actions={actions} onSent={again} />)}
                {next ? <Container layout="horizontal"><Button size="sm" variant="ghost" onClick={more}>{WORDS.more}</Button></Container> : null}
              </Container>
            )}
    </Container>
  );
}
