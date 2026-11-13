// src/workspace/new-post.tsx
//
// PURPOSE
//   Writing a post and choosing where it goes, shared by Posts (posts-screen.tsx) and the posting calendar
//   (calendar-screen.tsx). A person writes the words and, if they like, a time, and the post is kept as a draft in their
//   own store through the same draft the AI's draft_post makes (/work/api/posts/draft, src/work-posts.mjs). A draft may
//   go nowhere yet: someone with no place connected still writes, sees the ready check say where it can go, and puts it
//   on the calendar. Where it goes is picked from the accounts they connected; with none, Connect a place opens
//   Connections.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every element is a shared part (Container, Text, Button, Input, Textarea, Switch); this file writes no markup.
//   2. Every word is DATA (post-looks.json `write`, `places`); the places are the person's own, read from their store
//      by name only (/work/api/posts/destinations), so reading them never makes a connect link.
//   3. The store answers whether a draft is kept; its refusal is shown in its own words.

import * as React from 'react';
import { Button, Container, Switch, Text, Textarea } from '../../parts/ui';
import { DateTimePicker } from '../../parts/ui/show/date-picker/DateTimePicker';
import { notify } from '../../parts/ui/show/coss/notifications';
import { postJson, readJson } from './api';
import { openScreen } from './open-screen';
import looks from './post-looks.json';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
export type PostAccount = { account_id: string; platform?: string | null; label?: string | null; name?: string | null; ready?: boolean; said?: string };
export type PostPlaces = { destinations: PostAccount[]; not_connected: { platform: string; label: string }[] };

const DRAFT = '/work/api/posts/draft';
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const accountName = (account: PostAccount) => [account.label ?? account.platform ?? account.account_id, account.name].filter(Boolean).join(' · ');

/** The accounts a post can go to and the places not connected yet, by name only. */
export const readPostPlaces = () => readJson<PostPlaces>('/work/api/posts/destinations');

/** Opens Connections, where a place to post is connected. */
export const connectAPlace = () => openScreen(looks.places.connect_screen);

/** Said only while nothing is connected: drafts are kept, and Connect a place opens Connections. */
export function ConnectNotice({ places }: { places: PostPlaces | null }) {
  if (!places || places.destinations.length) return null;
  return (
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" padding="sm" border="all" rounded="lg" data-post-connect="">
      <Text variant="caption">{looks.places.none_connected}</Text>
      <Button size="sm" variant="outline" onClick={connectAPlace}>{looks.places.connect}</Button>
    </Container>
  );
}

/** A switch for each connected account; with none, nothing, since the screen holding it already shows the connect notice.
 *  An account that cannot take posts now (ready false, such as a connection that never said its account id) cannot be
 *  switched on and says why in its own words, unless the post already goes there, so it can still be switched off. */
export function PickPlaces({ places, chosen, onChange }: { places: PostPlaces | null; chosen: string[]; onChange: (next: string[]) => void }) {
  if (!places || !places.destinations.length) return null;
  return (
    <Container layout="vertical" gap="xs" data-post-places="">
      <Text variant="caption">{looks.places.heading}</Text>
      {places.destinations.map(account => {
        const on = chosen.includes(account.account_id);
        const blocked = account.ready === false && !on;
        return (
          <Container key={account.account_id} layout="horizontal" gap="sm" alignItems="center" minWidth="0" data-post-place-blocked={blocked ? '' : undefined}>
            <Switch size="sm" label={accountName(account)} checked={on} disabled={blocked}
              onCheckedChange={next => onChange(next ? [...chosen, account.account_id] : chosen.filter(id => id !== account.account_id))} />
            <Container layout="vertical" gap="none" minWidth="0">
              <Text variant="body-xs" truncate>{accountName(account)}</Text>
              {account.ready === false && account.said ? <Text variant="caption" truncate>{account.said}</Text> : null}
            </Container>
          </Container>
        );
      })}
    </Container>
  );
}

/** Where an existing post goes, changed and kept by the person. */
export function PostPlacesEditor({ postId, places, current, onSaved }: { postId: string; places: PostPlaces | null; current: string[]; onSaved: () => void }) {
  const [chosen, setChosen] = React.useState(current);
  const changed = chosen.length !== current.length || chosen.some(id => !current.includes(id));
  const save = async () => {
    try {
      await postJson(DRAFT, { post_id: postId, destinations: chosen });
      notify(looks.places.saved, { kind: 'done' });
      onSaved();
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    }
  };
  return (
    <Container layout="vertical" gap="sm">
      <PickPlaces places={places} chosen={chosen} onChange={setChosen} />
      {changed ? <Button size="sm" variant="outline" onClick={() => save()}>{looks.places.save}</Button> : null}
    </Container>
  );
}

/** The new-post panel: words, an optional time, where it goes, and Keep as draft. */
/** A file a post is written with (a recording's card opens Posts with one: records/workshop-publishing-tool-records.json
 *  tool:check-a-post screen.takes_file). */
export type PostFile = { identity: string; name?: string; media_type?: string };

export function NewPost({ places, onKept, onClose, media = null }: { places: PostPlaces | null; onKept: (postId: string) => void; onClose: () => void; media?: PostFile | null }) {
  const [words, setWords] = React.useState('');
  const [when, setWhen] = React.useState('');
  const [whenValid, setWhenValid] = React.useState(true);
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [keeping, setKeeping] = React.useState(false);
  const keep = async () => {
    if (!whenValid) return;
    if (!words.trim()) { notify(looks.write.needs_words, { kind: 'error' }); return; }
    setKeeping(true);
    try {
      const at = when ? new Date(when).toISOString() : null;
      const kept = await postJson<{ post: { post_id: string } }>(DRAFT, { caption: words, scheduled_for: at, time_zone: at ? zone() : null, destinations: chosen, ...(media ? { media: media.identity } : {}) });
      notify(looks.write.kept, { kind: 'done' });
      onKept(kept.post.post_id);
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    } finally {
      setKeeping(false);
    }
  };
  return (
    <Container layout="vertical" gap="md" padding="lg" data-new-post="">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Text variant="heading-xs">{looks.write.heading}</Text>
        <Button size="sm" variant="ghost" onClick={onClose}>{looks.write.close}</Button>
      </Container>
      {media ? <Text variant="caption" truncate>{looks.write.with_file.replace('{name}', (media.name ?? media.identity).split('/').pop() ?? '')}</Text> : null}
      <Textarea label={looks.write.words} placeholder={looks.write.words_hint} rows={5} autoGrow value={words} onChange={event => setWords(event.target.value)} />
      <DateTimePicker label={looks.write.when} value={when} onChange={next => setWhen(next ?? '')} onValidityChange={setWhenValid} />
      <PickPlaces places={places} chosen={chosen} onChange={setChosen} />
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button size="sm" variant="primary" disabled={keeping || !words.trim() || !whenValid} onClick={() => keep()}>{keeping ? looks.write.keeping : looks.write.keep}</Button>
      </Container>
    </Container>
  );
}
