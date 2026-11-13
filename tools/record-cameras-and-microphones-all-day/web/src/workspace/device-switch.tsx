// src/workspace/device-switch.tsx
//
// PURPOSE
//   The switches for what the device this page runs in can do by itself (the Trillion iPhone app sending new videos
//   from Photos, and whatever it adds next), on the page each belongs to. Which switches exist is what the device says
//   (window.__trillionSwitches); their words are DATA (device-switches.json); their state is what the device tells
//   (the trillion-native-switch event, ios/App/DeviceSwitch.swift). In a browser or on a device without them, nothing
//   shows.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A switch shows on only once the device says it is on; the page never assumes.
//   2. No switch is named in code: a new one is a DATA row here and one object on the device.
//   3. Every control is a shared part (parts/ui Card, Container, Switch, Text); this file writes no markup of its own.
//   4. Each switch's state is reported as the device's fact `<switch id>.on` (on or off, src/workspace/device-facts.ts),
//      so a step waiting on the person to turn it on ticks itself.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { Card, Container, Switch, Text } from '../../parts/ui';
import words from './device-switches.json';
import { reportDeviceFacts } from './device-facts';

type Said = { off: string; sending: string; waiting: string; on: string };
type Row = { id: string; place: string; title: string; said: Said };
type State = { id: string; on: boolean; waiting?: number; sent?: number; sending?: boolean; problem?: string | null };
type Bridge = { postMessage: (message: { id: string; command: 'on' | 'off' | 'state' }) => void };
type Host = Window & { __trillionSwitches?: Record<string, string>; webkit?: { messageHandlers?: { trillionSwitch?: Bridge } } };

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));

/** The line under a switch's title: its problem, else the first of off, sending, waiting, on that holds. */
export function saidOf(row: Row, device: string, state: State | null): string {
  const values = { device, waiting: state?.waiting ?? 0, sent: state?.sent ?? 0 };
  if (state?.problem) return state.problem;
  if (!state?.on) return fill(row.said.off, values);
  if (state.sending) return fill(row.said.sending, values);
  if (state.waiting) return fill(row.said.waiting, values);
  return fill(row.said.on, values);
}

function DeviceSwitchRow({ row, device, bridge }: { row: Row; device: string; bridge: Bridge }) {
  const [state, setState] = React.useState<State | null>(null);
  React.useEffect(() => {
    const take = (event: Event) => {
      const detail = (event as CustomEvent<State>).detail;
      if (detail?.id !== row.id) return;
      setState(detail);
      // What waits on the person and asks for this switch ticks itself once the device says it is on.
      reportDeviceFacts({ [`${row.id}.on`]: detail.on ? 'on' : 'off' }, 'device-switches');
    };
    window.addEventListener('trillion-native-switch', take);
    bridge.postMessage({ id: row.id, command: 'state' });
    return () => window.removeEventListener('trillion-native-switch', take);
  }, [row.id, bridge]);
  const title = fill(row.title, { device });
  return (
    <Card variant="nested" padding="md" aria-label={title} data-device-switch={row.id}>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Container layout="vertical" gap="xs" flex={1} minWidth="0">
          <Text as="p" variant="body">{title}</Text>
          <Text as="p" variant="caption" color={state?.problem ? 'error' : 'muted'}>{saidOf(row, device, state)}</Text>
        </Container>
        <Switch checked={state?.on === true} label={title} onCheckedChange={on => bridge.postMessage({ id: row.id, command: on ? 'on' : 'off' })} />
      </Container>
    </Card>
  );
}

/** Every switch the device has for `place`, in the order of the DATA. */
export function DeviceSwitches({ place }: { place: string }) {
  const host = typeof window === 'undefined' ? null : (window as Host);
  const bridge = host?.webkit?.messageHandlers?.trillionSwitch;
  const has = host?.__trillionSwitches ?? {};
  if (!bridge) return null;
  const rows = (words.switches as Row[]).filter(row => row.place === place && has[row.id]);
  return <>{rows.map(row => <DeviceSwitchRow key={row.id} row={row} device={has[row.id]} bridge={bridge} />)}</>;
}
