// src/workspace/notification-settings-screen.tsx
//
// PURPOSE
//   Notification settings: every way Trillion can tell the person something (in Trillion, on this computer, by email,
//   through their AIs, through a messaging account they connect), each with its own switch, which of those each
//   kind of news goes through, and When things show: the person's show rules (show-rules-settings.tsx), which silence
//   or hide any notice, tour or layout by when it is, the device or how the page was opened. Everything drawn is the person store's answer (GET /work/api/tell,
//   src/tell-the-person.mjs); the channels and kinds are its DATA rows, so a new one appears here with no change here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A change is saved as it is made (a switch, an address typed in place); the answer replaces what is drawn.
//   2. "On this computer" is this browser's own permission and subscription: switching it on asks the browser, keeps
//      the subscription in the person's store, and switching it off removes this browser only.
//   3. A way that cannot send yet says why in the store's words, and offers Connect when a connection would turn it on.
//   4. Every control is a shared part (parts/ui); this file writes no markup and no appearance.
//
// References (anatomy; original code): Mobbin fal Notification Settings (delivery channels as rows with their state,
// then a per-kind table of channels), Mobbin AirOps Notification Preferences (switch matrix of kinds by channels),
// 21st.dev #22226 Notification Channel Matrix and #26523 Notification Settings Field. The kinds-by-ways table is the
// shared SwitchMatrix (parts/ui/show/switch-matrix): fixed label column, aligned switches, a fade while columns scroll.

import * as React from 'react';
import { Button, Card, Container, InlineEditText, Switch, SwitchMatrix, Text } from '../../parts/ui';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { notify } from '../../parts/ui/show/coss/notifications';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import { ShowRulesSettings } from './show-rules-settings';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type ChannelState = { ready: boolean; need?: string; said?: string; connect_url?: string; setup?: { public_key?: string } };
type Channel = { id: string; label: string; on: boolean; address?: string; state: ChannelState };
type Kind = { id: string; label: string; channels: string[] };
type Settings = { channels: Channel[]; kinds: Kind[]; needs: Record<string, string> };
type SaveOptions = { propagate?: boolean };

const ROUTE = '/work/api/tell';
// Ways that wait on something only elsewhere (a connection, a sender) are not offered per kind until they can send.
const WAITING_ELSEWHERE = new Set(['connection', 'sender', 'setup']);

const bytesOf = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), char => char.charCodeAt(0));
const pushAvailable = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;

// This browser's own subscription, if it has one.
async function subscriptionHere(): Promise<PushSubscription | null> {
  if (!pushAvailable()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

function NotificationSettings({ first }: { first: Settings }) {
  const [settings, setSettings] = React.useState(first);
  const currentSettings = React.useRef(first);
  const [here, setHere] = React.useState<{ subscribed: boolean; registered: boolean; blocked: boolean; lookupFailed: boolean; offFailed: boolean }>({ subscribed: false, registered: false, blocked: false, lookupFailed: false, offFailed: false });
  const saving = React.useRef(Promise.resolve());
  const computerQueue = React.useRef(Promise.resolve());
  const computerGeneration = React.useRef(0);
  const computerMounted = React.useRef(true);

  const replaceSettings = (next: Settings) => { currentSettings.current = next; setSettings(next); };
  const save = React.useCallback((path: string, body: unknown, done?: 'test' | string, options: SaveOptions = {}) => {
    const task = saving.current.then(async () => {
      if (!computerMounted.current) return;
      try {
        const payload = typeof body === 'function' ? (body as () => unknown)() : body;
        const answer = await postJson<Settings & { said?: string; delivery_accepted?: boolean; recorded?: boolean }>(path, payload);
        if (!computerMounted.current) return answer;
        if (Array.isArray(answer.channels)) replaceSettings(answer);
        else {
          const latest = await readJson<Settings>(ROUTE);
          if (!computerMounted.current) return answer;
          replaceSettings(latest);
        }
        if (done === 'test') {
          const accepted = answer.delivery_accepted === true;
          notify(accepted ? 'A delivery service accepted the test.' : answer.recorded === true ? 'The test was recorded, but delivery is unconfirmed.' : 'Delivery of the test is unconfirmed.', { kind: accepted ? 'success' : 'error' });
        } else if (done) notify(done, { kind: 'success' });
        return answer;
      } catch (error) {
        if (!computerMounted.current) return;
        if (options.propagate) throw error;
        notify(errorWords(error), { kind: 'error' });
      }
    });
    saving.current = task.then(() => undefined, () => undefined);
    return task;
  }, []);

  React.useEffect(() => {
    let live = true;
    computerMounted.current = true;
    const generation = computerGeneration.current;
    void subscriptionHere().then(found => {
      if (!live || generation !== computerGeneration.current) return;
      const subscribed = Boolean(found) && Notification.permission === 'granted';
      const blocked = pushAvailable() && Notification.permission === 'denied';
      // A browser subscription does not prove this account registered it; another signed-in account may use this browser.
      setHere({ subscribed, registered: false, blocked, lookupFailed: false, offFailed: false });
      if (!subscribed || !found) return;
      void postJson<{ found: boolean; registration_matches?: boolean }>(`${ROUTE}/devices/find`, { route: 'web-push', address: found.toJSON() }).then(answer => {
        if (live && generation === computerGeneration.current) setHere({ subscribed: true, registered: answer.registration_matches === true, blocked: false, lookupFailed: false, offFailed: false });
      }).catch(error => {
        if (!live || generation !== computerGeneration.current) return;
        setHere({ subscribed: true, registered: false, blocked: false, lookupFailed: true, offFailed: false });
        notify(errorWords(error), { kind: 'error' });
      });
    }).catch(() => {});
    return () => { live = false; computerMounted.current = false; computerGeneration.current++; };
  }, []);

  // "On this computer": ask the browser, then keep or drop this browser's subscription.
  const setThisComputer = (channel: Channel, on: boolean) => {
    const generation = ++computerGeneration.current;
    const operation = computerQueue.current.then(async () => {
      const current = () => computerMounted.current && generation === computerGeneration.current;
      if (!current()) return;
    try {
      if (!pushAvailable()) throw new Error('This browser cannot show notifications from Trillion.');
      if (!on) {
        const found = await subscriptionHere();
        if (!current()) return;
        if (found) {
          const match = await postJson<{ found: boolean; device_id?: string }>(`${ROUTE}/devices/find`, { route: 'web-push', address: found.toJSON() });
          if (!current()) return;
          if (match.found) {
            if (!match.device_id) throw new Error(settings.needs.lookup);
            await save(`${ROUTE}/devices/remove`, { device_id: match.device_id }, undefined, { propagate: true });
            if (!current()) return;
          }
          setHere({ subscribed: true, registered: false, blocked: false, lookupFailed: false, offFailed: true });
          const unsubscribed = await found.unsubscribe();
          if (!current()) return;
          if (!unsubscribed) throw new Error('This browser could not turn notifications off. Try again.');
        }
        if (current()) setHere({ subscribed: false, registered: false, blocked: false, lookupFailed: false, offFailed: false });
        return;
      }
      const key = channel.state.setup?.public_key;
      if (!key) throw new Error(channel.state.said ?? settings.needs.setup);
      const permission = await Notification.requestPermission();
      if (!current()) return;
      if (permission !== 'granted') { setHere({ subscribed: false, registered: false, blocked: permission === 'denied', lookupFailed: false, offFailed: false }); return; }
      const registration = await navigator.serviceWorker.ready;
      if (!current()) return;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesOf(key) });
      if (!current()) return;
      const label = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '';
      if (!current()) return;
      // Refresh the account's saved keys even when the endpoint is known; browsers can rotate their key pair.
      await save(`${ROUTE}/devices`, { route: 'web-push', address: subscription.toJSON(), label }, undefined, { propagate: true });
      if (!current()) return;
      await save(ROUTE, { channels: { [channel.id]: { on: true } } }, undefined, { propagate: true });
      if (!current()) return;
      setHere({ subscribed: true, registered: true, blocked: false, lookupFailed: false, offFailed: false });
    } catch (error) {
      if (current()) notify(errorWords(error), { kind: 'error' });
    }
    });
    computerQueue.current = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const isThisComputer = (channel: Channel) => Boolean(channel.state.setup && 'public_key' in channel.state.setup);
  const lineFor = (channel: Channel) => {
    if (isThisComputer(channel)) {
      if (here.blocked) return settings.needs.blocked;
      if (here.lookupFailed) return settings.needs.lookup;
      if (here.offFailed) return settings.needs.off;
      if (here.subscribed && !here.registered) return settings.needs.registration;
      if (here.subscribed) return null;
      return channel.state.need === 'setup' ? channel.state.said : settings.needs.permission;
    }
    return channel.state.ready ? null : channel.state.said ?? null;
  };
  const control = (channel: Channel) => {
    if (isThisComputer(channel) && here.offFailed) return <Button size="sm" variant="outline" onClick={() => setThisComputer(channel, false)}>Try turning off again</Button>;
    if (isThisComputer(channel)) return <Switch size="sm" label={channel.label} checked={here.subscribed && here.registered && channel.on} disabled={here.blocked} onCheckedChange={on => setThisComputer(channel, on)} />;
    if (channel.state.need === 'connection' && channel.state.connect_url) {
      const address = channel.state.connect_url;
      return <Button size="sm" variant="outline" onClick={() => location.assign(address)}>Connect</Button>;
    }
    if (channel.state.need && WAITING_ELSEWHERE.has(channel.state.need)) return null;
    return <Switch size="sm" label={channel.label} checked={channel.on} onCheckedChange={on => void save(ROUTE, { channels: { [channel.id]: { on } } })} />;
  };

  const offered = settings.channels.filter(channel => channel.on && !(channel.state.need && WAITING_ELSEWHERE.has(channel.state.need)));
  const setKind = (kind: Kind, channelId: string, on: boolean) => {
    void save(ROUTE, () => {
      const latest = currentSettings.current.kinds.find(item => item.id === kind.id)?.channels ?? kind.channels;
      const next = on ? (latest.includes(channelId) ? latest : [...latest, channelId]) : latest.filter(id => id !== channelId);
      return { kinds: { [kind.id]: next } };
    });
  };

  return (
    <Container layout="vertical" gap="xl" padding="xl" maxWidth="3xl">
      <Container layout="horizontal" gap="md" alignItems="center">
        <Container flex={1}><Text variant="heading-lg">Notifications</Text></Container>
        <Button size="sm" variant="outline" onClick={() => save(`${ROUTE}/test`, {}, 'test')}>Send a test</Button>
      </Container>

      <Container layout="vertical" gap="sm">
        <Text variant="heading-xs">Where Trillion tells you</Text>
        <Card variant="surface" padding="none">
          {settings.channels.map(channel => {
            const line = lineFor(channel);
            return (
              <Container key={channel.id} layout="horizontal" gap="md" alignItems="center" padding="md">
                <Container layout="vertical" gap="xs" flex={1}>
                  <Text variant="body" weight="semibold">{channel.label}</Text>
                  {channel.state.need === 'address' || channel.address !== undefined
                    ? <InlineEditText variant="body" tone="secondary" aria-label="Email address" placeholder="you@example.com" value={channel.address ?? ''} onCommit={address => void save(ROUTE, { channels: { [channel.id]: { address } } })} />
                    : line ? <Text variant="caption" color="muted">{line}</Text> : null}
                </Container>
                {control(channel)}
              </Container>
            );
          })}
        </Card>
      </Container>

      <Container layout="vertical" gap="sm">
        <Text variant="heading-xs">What it tells you about</Text>
        <Card variant="surface" padding="none">
          <SwitchMatrix label="What it tells you about" columns={offered.map(channel => ({ id: channel.id, label: channel.label }))}
            rows={settings.kinds.map(kind => ({ id: kind.id, label: kind.label, on: kind.channels }))}
            onChange={(row, channelId, on) => { const kind = settings.kinds.find(item => item.id === row.id); if (kind) setKind(kind, channelId, on); }} />
        </Card>
      </Container>

      <ShowRulesSettings />
    </Container>
  );
}

export function mountNotificationSettingsScreen(element: HTMLElement): () => void {
  let unmount: (() => void) | null = null;
  const screen = loadScreen(element, {
    loading: { label: 'Loading how Trillion tells you things', layout: 'rows' },
    read: () => readJson<Settings>(ROUTE),
    failed: refusal('Your notification settings could not load'),
    clear: () => { unmount?.(); unmount = null; },
    draw: first => { if (!unmount) unmount = mountReactSurface(element, <NotificationSettings first={first} />); },
  });
  return () => { screen.dispose(); unmount?.(); element.replaceChildren(); };
}
