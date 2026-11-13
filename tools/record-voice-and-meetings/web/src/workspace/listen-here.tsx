// src/workspace/listen-here.tsx
//
// PURPOSE
//   The switch for listening on the device this page runs in, when that device can listen by itself (the Trillion
//   iPhone app says so with window.__trillionListenHere and its trillionListen bridge). On, the device keeps listening
//   with the app in the background and the screen off, and every piece it hears goes to the person's Mac to hear, as
//   its speaker's words (ios/App/Recording/PhoneListening.swift, computer/listen.mjs tool:hear-for-a-device). Anywhere
//   else (a browser, the Mac, which has its own listening) it shows nothing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. What it shows is what the device says (the trillion-native-listen event), never what the page assumes: the
//      switch turns on only once the device says it is on.
//   2. Every control is a shared part (parts/ui Switch, Card, Text); this file writes no markup of its own.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { Card, Container, Switch, Text } from '../../parts/ui';

type Heard = { on: boolean; recording: boolean; waiting: number; sent: number; problem: string | null };
type Bridge = { postMessage: (message: { command: 'on' | 'off' | 'state' }) => void };
type Host = Window & { __trillionListenHere?: string; webkit?: { messageHandlers?: { trillionListen?: Bridge } } };

export const deviceHere = (): { device: string; bridge: Bridge } | null => {
  if (typeof window === 'undefined') return null;
  const host = window as Host;
  const bridge = host.webkit?.messageHandlers?.trillionListen;
  return bridge && host.__trillionListenHere ? { device: host.__trillionListenHere, bridge } : null;
};

// The line under the switch's title (Brink's Auto-Transcribe row on Mobbin: a title, one muted line, the switch).
const said = (heard: Heard | null): string => {
  if (heard?.problem) return heard.problem;
  if (!heard?.on) return 'Also when Trillion is in the background or the screen is off. What each person says is kept as theirs.';
  if (!heard.recording) return 'On, and waiting while something else uses the microphone.';
  return heard.waiting ? `Listening. ${heard.waiting} to send when you are back online.` : 'Listening. What each person says goes to your Mac to hear, as theirs.';
};

export function ListenHere() {
  const here = React.useMemo(deviceHere, []);
  const [heard, setHeard] = React.useState<Heard | null>(null);
  React.useEffect(() => {
    if (!here) return undefined;
    const take = (event: Event) => setHeard((event as CustomEvent<Heard>).detail);
    window.addEventListener('trillion-native-listen', take);
    here.bridge.postMessage({ command: 'state' });
    return () => window.removeEventListener('trillion-native-listen', take);
  }, [here]);
  if (!here) return null;
  return (
    <Card variant="nested" padding="md" aria-label={`Listening on this ${here.device}`} data-listen-here="">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Container layout="vertical" gap="xs" flex={1} minWidth="0">
          <Text as="p" variant="body">Listen on this {here.device}</Text>
          <Text as="p" variant="caption" color={heard?.problem ? 'error' : 'muted'}>{said(heard)}</Text>
        </Container>
        <Switch
          checked={heard?.on === true}
          label={`Listen on this ${here.device}`}
          onCheckedChange={on => here.bridge.postMessage({ command: on ? 'on' : 'off' })}
        />
      </Container>
    </Card>
  );
}
