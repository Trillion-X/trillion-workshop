// src/workspace/sharing-screen.tsx
//
// PURPOSE
//   Sharing: where a share from the iPhone, Chrome or Android can go and what the person's AI does with it, in the
//   one list every one of those reads live (src/share-destinations.mjs, GET/POST /work/api/share-destinations).
//   The places come in the one order the sidebar shows (their own Trillion, then each pursuit nested under the one it
//   is set under, then tools that take what is shared); the person shows or hides each and picks which start switched
//   on; keeps the things their AI can do in the shared list of them (src/workspace/send-actions-tree.ts: the same tree as the sidebar's "Your AI
//   will", with folders); and says which of those a share from a site starts with. Below, everything
//   they shared before from any device, to open, send again or hand to their AI (src/workspace/shared-before.tsx).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the person's own list: every read and save goes through the one route; nothing is kept here but what is
//      being typed.
//   2. A change is saved as it is made (a switch, a name or words edited in place); what comes back is drawn.
//   3. Their own Trillion can be switched off at the start, never hidden: its Show switch is not offered.
//   4. Every control is a shared part (parts/ui); this file writes no markup and no appearance.
//   5. Reads run through the shared screen-state part, so loading and failing look like every other screen.

import * as React from 'react';
import { Button, Card, Container, Dropdown, HoverRevealGroup, HoverRevealItem, InlineEditText, NamedIcon, Switch, Text } from '../../parts/ui';
import { loadScreen, ScreenState } from '../../parts/ui/show/screen-state';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { notify } from '../../parts/ui/show/coss/notifications';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import { SharedBefore, SHARES_ROUTE, type SharesPage } from './shared-before';
import { listShares, stopSharing, type ShareRow } from './share-anything';
import { ProjectTree } from '../../parts/ui/show/coss/project-tree';
import { actionsTreeOptions, type SendAction, type SendFolder } from './send-actions-tree';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Destination = { id: string; label: string; description?: string | null; depth?: number; to: { private?: true; pursuit_id?: string; space_id?: string; tool_id?: string }; shown: boolean; on_by_default: boolean };
type Site = { host_suffix: string; action_id: string };
type Sharing = { destinations: Omit<Destination, 'shown'>[]; actions: SendAction[]; folders: SendFolder[]; default_action_by_site: Site[]; all_destinations: Destination[] };
type Change = { destinations?: { id: string; shown: boolean; on_by_default: boolean }[]; default_action_by_site?: Site[] };

const ROUTE = '/work/api/share-destinations';
const PRIVATE = 'private';
// Each switch sits in a cell of one width, so Show and On at start line up down the list.
const SWITCH_CELL = '8.5rem';
// A site row being written stays here until it has a site.
type Draft<T> = T & { key: string };
let drafts = 0;
const draftKey = () => `draft-${++drafts}`;

const linkIsOpen = (share: ShareRow) => share.link?.open === true;

/** Everything the person shares stays findable after its sheet closes: who it is shared with and its link, each with
 *  a way to stop it. The share tool supplies the rows. */
function SharedThings() {
  const [shares, setShares] = React.useState<ShareRow[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);
  const read = React.useCallback(async () => {
    setBusy(true);
    try { setShares(await listShares()); setFailed(null); }
    catch (error) { setFailed(errorWords(error)); }
    finally { setBusy(false); }
  }, []);
  React.useEffect(() => { void read(); }, [read]);
  const stop = async (share: ShareRow, who: { principal: string } | { link: true }) => {
    setBusy(true);
    try {
      await stopSharing(share.label, who);
      notify('link' in who ? 'Link stopped' : `Stopped sharing with ${who.principal}`, { kind: 'done' });
      setShares(await listShares());
    } catch (error) { notify(errorWords(error), { kind: 'error' }); }
    finally { setBusy(false); }
  };
  return <Container layout="vertical" gap="sm">
    <Text variant="heading-xs">What you share</Text>
    {failed ? <ScreenState state={{ status: 'failed', icon: 'CircleAlert', title: 'What you share could not load', description: failed, retry: { label: 'Try again', run: () => void read() } }} />
      : shares === null ? <ScreenState state={{ status: 'loading', label: 'Loading what you share', layout: 'rows' }} />
        : shares.length === 0 ? <Text variant="body" color="muted">Things you share appear here.</Text>
          : <Container layout="vertical" gap="sm">
            {shares.map(share => <Card key={share.label} variant="surface" padding="md">
              <Container layout="vertical" gap="xs">
                <Text variant="body">{share.title || share.label}</Text>
                {share.items ? <Text variant="caption" color="muted">{share.items} {share.items === 1 ? 'item' : 'items'}</Text> : null}
                {share.people.map(person => <Container key={person.principal} layout="horizontal" gap="md" alignItems="center" justifyContent="between" wrap>
                  <Text variant="caption" color="muted">{person.principal}{person.added_at ? ` · Added ${new Date(person.added_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : ''}</Text>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => stop(share, { principal: person.principal })}>Stop their access</Button>
                </Container>)}
                {share.link ? <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between" wrap>
                  <Text variant="caption" color="muted">Anyone with the link · {linkIsOpen(share) ? 'Open' : 'Stopped'}{share.link.created_at ? ` · Made ${new Date(share.link.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : ''}</Text>
                  {linkIsOpen(share) ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => stop(share, { link: true })}>Stop link</Button> : null}
                </Container> : null}
              </Container>
            </Card>)}
          </Container>}
  </Container>;
}

function SharingScreen({ first, shares }: { first: Sharing; shares: SharesPage }) {
  const [sharing, setSharing] = React.useState(first);
  const [sites, setSites] = React.useState<Draft<Site>[]>(() => first.default_action_by_site.map(site => ({ ...site, key: site.host_suffix })));
  const saving = React.useRef(Promise.resolve());

  // One save at a time, in the order they were made; the answer replaces what is drawn, keeping unfinished rows.
  const save = React.useCallback((change: Change) => {
    saving.current = saving.current.then(async () => {
      try {
        const answer = await postJson<Sharing>(ROUTE, change);
        setSharing(answer);
        setSites(now => [...answer.default_action_by_site.map(site => ({ ...site, key: site.host_suffix })), ...now.filter(site => !site.host_suffix.trim())]);
      } catch (error) {
        notify(errorWords(error), { kind: 'error' });
      }
    });
  }, []);

  const places = sharing.all_destinations;
  const placesAs = (list: Destination[]) => list.map(({ id, shown, on_by_default }) => ({ id, shown, on_by_default }));
  const setPlace = (id: string, change: Partial<Destination>) => save({ destinations: placesAs(places.map(place => (place.id === id ? { ...place, ...change } : place))) });

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  // The things their AI can do are the shared list's; a change there redraws the site choices below.
  const actionsTree = React.useMemo(() => actionsTreeOptions(first, list => setSharing(now => ({ ...now, ...list }))), [first]);

  const sitesAs = (list: Draft<Site>[]) => list.filter(site => site.host_suffix.trim()).map(({ host_suffix, action_id }) => ({ host_suffix, action_id }));
  const saveSites = (list: Draft<Site>[]) => { setSites(list); if (!same(sitesAs(list), sharing.default_action_by_site)) save({ default_action_by_site: sitesAs(list) }); };
  const actionChoices = sharing.actions.map(action => ({ value: action.id, label: action.label }));

  const commitSite = (key: string, host_suffix: string) => saveSites(sites.map(site => (site.key === key ? { ...site, host_suffix } : site)));

  return (
    <Container layout="vertical" gap="xl" padding="xl" maxWidth="3xl">
      <Text variant="heading-lg">Sharing</Text>

      <Container layout="vertical" gap="sm">
        <Text variant="heading-xs">Where shares go</Text>
        <Card variant="surface" padding="none">
          {places.map(place => (
            // In a narrow pane the two switches drop under the place's name instead of running past the card.
            <Container key={place.id} layout="horizontal" gap="md" alignItems="center" wrap padding="md" border="bottom">
              <Container flex={1} minWidth="12rem" indent={Math.min(place.depth ?? 0, 4) as 0 | 1 | 2 | 3 | 4} layout="vertical" gap="none">
                <Text variant="body">{place.label}</Text>
                {place.description ? <Text variant="caption" color="muted">{place.description}</Text> : null}
              </Container>
              <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end" minWidth={SWITCH_CELL}>
                {place.id === PRIVATE ? null : (
                  <>
                    <Text variant="label" color="muted">Show</Text>
                    <Switch size="sm" label={`Show ${place.label}`} checked={place.shown} onCheckedChange={shown => setPlace(place.id, { shown })} />
                  </>
                )}
              </Container>
              <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end" minWidth={SWITCH_CELL}>
                <Text variant="label" color="muted">On at start</Text>
                <Switch size="sm" label={`${place.label} on at start`} checked={place.on_by_default} disabled={!place.shown} onCheckedChange={on_by_default => setPlace(place.id, { on_by_default })} />
              </Container>
            </Container>
          ))}
        </Card>
      </Container>

      <Container layout="vertical" gap="sm">
        <Text variant="heading-xs">What your AI does with it</Text>
        <ProjectTree options={actionsTree} onSelected={() => {}} />
      </Container>

      <Container layout="vertical" gap="sm">
        <Text variant="heading-xs">Start with this for a site</Text>
        {sites.length ? (
          <Card variant="surface" padding="none">
            {sites.map(site => (
              <HoverRevealGroup key={site.key} layout="horizontal" gap="md" alignItems="center" padding="md">
                <Container flex={1}>
                  <InlineEditText variant="body" aria-label="Site" placeholder="instagram.com" value={site.host_suffix} onCommit={host => commitSite(site.key, host)} />
                </Container>
                <Dropdown size="sm" items={actionChoices} value={site.action_id} placeholder="Choose" onValueChange={action_id => saveSites(sites.map(item => (item.key === site.key ? { ...item, action_id } : item)))} />
                <HoverRevealItem>
                  <Button size="icon" variant="ghost" aria-label={`Remove ${site.host_suffix || 'this site'}`} title="Remove" onClick={() => saveSites(sites.filter(item => item.key !== site.key))}>
                    <NamedIcon name="Trash2" size="sm" aria-hidden />
                  </Button>
                </HoverRevealItem>
              </HoverRevealGroup>
            ))}
          </Card>
        ) : null}
        <Container layout="horizontal">
          <Button size="sm" variant="outline" disabled={!actionChoices.length} onClick={() => setSites(now => [...now, { key: draftKey(), host_suffix: '', action_id: actionChoices[0].value }])}>
            <NamedIcon name="Plus" size="sm" aria-hidden />
            Add a site
          </Button>
        </Container>
      </Container>

      <SharedThings />
      <SharedBefore actions={sharing.actions} first={shares} />
    </Container>
  );
}

export function mountSharingScreen(element: HTMLElement): () => void {
  let unmount: (() => void) | null = null;
  const screen = loadScreen(element, {
    loading: { label: 'Loading where your shares go', layout: 'rows' },
    // Where shares go and what was shared before are read at the same time, so the screen shows both at once.
    read: () => Promise.all([readJson<Sharing>(ROUTE), readJson<SharesPage>(SHARES_ROUTE)]),
    failed: refusal('Your sharing choices could not load'),
    clear: () => { unmount?.(); unmount = null; },
    draw: ([first, shares]) => { if (!unmount) unmount = mountReactSurface(element, <SharingScreen first={first} shares={shares} />); },
  });
  return () => { screen.dispose(); unmount?.(); element.replaceChildren(); };
}
