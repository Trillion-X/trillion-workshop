// parts/record-audio/show/RecordingPill.tsx
//
// PURPOSE
//   The small dark pill of a recording in progress, shown while this window is not the one in front (so the person
//   working elsewhere still sees the time, can Stop, and can change the microphone): a red dot, the running time, Pause
//   or Resume, Stop, and the microphone menu. While the window is in front the floating card (recording-notices.ts) is
//   the control, so the two never show at once. In an app that floats a window over other apps for it (Trillion for
//   Mac, macos/App/RecordingWindow.swift), the pill is drawn in that window, so it stays in sight over every app;
//   elsewhere it is drawn at the top of this page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The recording is read from live-recording.ts and changed only through live-recording-controls.ts.
//   2. Words, the rule for when it shows, the window's address, channel and sizes, and the preference the microphone is
//      kept in are DATA (recording-widgets.json `pill` and `window`).
//   3. A microphone chosen while a recording runs is fed into that recording at once with no gap
//      (switchLiveRecordingMicrophone) and kept by the caller (`onMicrophone`) for the next recording; a recording that
//      cannot change microphone keeps it for the next one only, and the menu says which. A device that cannot be listed
//      says so in words, never an empty menu.
//   4. Only shared parts draw it: the shared RecordingBar (compact form on the island ground, the same bar every
//      recording screen draws), Dropdown and Container. The host's window is the web part in a floating panel: the
//      host draws nothing in it, and is told only the window's size (`channel`, { kind: 'size' }).
//   5. The window is opened only where the host offers its channel, carries this page's look (its root's variables and
//      classes, every stylesheet) and is closed the moment the pill stops showing.

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Container, NamedIcon, RecordingBar } from '../../ui';
import { Dropdown } from '../../ui/show/dropdown';
import { LAYER_ORDER } from '../../ui/show/layer-order/layer-order';
import widgets from '../read-data/recording-widgets.json';
import { currentLiveRecording, subscribeToLiveRecording } from './live-recording';
import { liveRecordingMicrophone, pauseLiveRecording, resumeLiveRecording, stopLiveRecording, switchLiveRecordingMicrophone } from './live-recording-controls';
import { activeDurationMs } from './recording-lifecycle';

const pill = widgets.pill;
const place = widgets.window;

export type RecordingPillHost = {
  /** The microphone the next recording opens ('' for the default one). */
  microphone: () => string;
  onMicrophone: (deviceId: string) => void;
  subscribeMicrophone: (listener: () => void) => () => void;
  problem: (error: unknown) => void;
};

// ---------------------------------------------------------------------------------------------------------------------
// The window an app floats over other apps for the pill.

type HostChannel = { postMessage: (message: unknown) => void };
type HostedWindow = Window & { webkit?: { messageHandlers?: Record<string, HostChannel | undefined> } };
const channelOf = (target: Window) => (target as HostedWindow).webkit?.messageHandlers?.[place.channel] ?? null;

/** Whether this page is hosted by an app that floats the pill's window over other apps. */
const windowHosted = () => typeof window !== 'undefined' && channelOf(window) !== null;

/** The window the pill is drawn in: the element to draw in, and its size for the pill alone or with its menu open. */
type PillWindow = { root: HTMLElement; body: HTMLElement; fit: (size: 'pill' | 'menu') => Promise<void>; close: () => void };

/** Carries this page's look into `target`: its root's variables and classes (kept in step) and every stylesheet,
 *  those added later included. Answers the function that stops keeping them in step. */
function carryLook(target: Document): () => void {
  const root = document.documentElement;
  const base = target.createElement('base');
  base.href = document.baseURI;
  target.head.append(base);
  const copyRoot = () => {
    for (const name of root.getAttributeNames()) target.documentElement.setAttribute(name, root.getAttribute(name) ?? '');
    target.documentElement.setAttribute('data-recording-window', '');
  };
  const isSheet = (node: Node): node is HTMLElement => node instanceof HTMLStyleElement || (node instanceof HTMLLinkElement && node.rel === 'stylesheet');
  copyRoot();
  for (const sheet of document.head.querySelectorAll('link[rel="stylesheet"], style')) target.head.append(sheet.cloneNode(true));
  const rootChanges = new MutationObserver(copyRoot);
  rootChanges.observe(root, { attributes: true });
  const newSheets = new MutationObserver(changes => {
    for (const change of changes) for (const node of change.addedNodes) if (isSheet(node)) target.head.append(node.cloneNode(true));
  });
  newSheets.observe(document.head, { childList: true });
  return () => { rootChanges.disconnect(); newSheets.disconnect(); };
}

/** Opens the host's floating window for the pill; null where the host offers none or the window could not open. */
function openPillWindow(): PillWindow | null {
  if (!windowHosted()) return null;
  const opened = window.open(place.address, place.name, `popup,width=${place.width},height=${place.height}`);
  if (!opened) return null;
  const target = opened.document;
  const stopCarrying = carryLook(target);
  const root = target.createElement('div');
  root.className = 'coss-ui';
  target.body.append(root);
  const tell = (width: number, height: number) => channelOf(opened)?.postMessage({ kind: 'size', width: Math.ceil(width), height: Math.ceil(height) });
  // The window is exactly the island while the menu is closed.
  const island = () => root.querySelector('[data-recording-bar]')?.getBoundingClientRect() ?? null;
  let size: 'pill' | 'menu' = 'pill';
  const sizes = new ResizeObserver(() => {
    const box = island();
    if (size === 'pill' && box) tell(box.width, box.height);
  });
  sizes.observe(root);
  return {
    root, body: target.body,
    fit: next => new Promise<void>(done => {
      size = next;
      const box = island();
      if (next === 'menu') tell(place.menu_width, place.menu_height);
      else if (box) tell(box.width, box.height);
      // The menu opens once the window has its room (its own resize), or at most a moment later.
      const settled = () => { opened.removeEventListener('resize', settled); opened.clearTimeout(timer); done(); };
      const timer = opened.setTimeout(settled, 250);
      opened.addEventListener('resize', settled);
    }),
    close: () => { sizes.disconnect(); stopCarrying(); opened.close(); },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The pill.

/** The microphones this device lists, as menu rows after the default one. */
async function listMicrophones(): Promise<{ value: string; label: string }[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const named = devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default');
  return [{ value: '', label: pill.default_microphone }, ...named.map((device, index) => ({ value: device.deviceId, label: device.label || `${pill.label} ${index + 1}` }))];
}

function useMicrophones() {
  const [rows, setRows] = React.useState<{ value: string; label: string }[]>([{ value: '', label: pill.default_microphone }]);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let current = true;
    const read = () => listMicrophones().then(found => { if (current) { setRows(found); setFailed(false); } }, () => { if (current) setFailed(true); });
    void read();
    navigator.mediaDevices?.addEventListener?.('devicechange', read);
    return () => { current = false; navigator.mediaDevices?.removeEventListener?.('devicechange', read); };
  }, []);
  return { rows, failed };
}

const livePhase = () => {
  const live = currentLiveRecording();
  return live && !live.cancelled ? live.phase : null;
};
const windowIsFront = () => document.hasFocus();
/** Whether the pill shows now: a recording runs or is paused, and this window is not the one in front. */
const pillShown = () => { const phase = livePhase(); return (phase === 'recording' || phase === 'paused') && !windowIsFront(); };

function subscribeToFront(listener: () => void) {
  window.addEventListener('focus', listener);
  window.addEventListener('blur', listener);
  return () => { window.removeEventListener('focus', listener); window.removeEventListener('blur', listener); };
}
const subscribeToShown = (listener: () => void) => {
  const stopLive = subscribeToLiveRecording(listener);
  const stopFront = subscribeToFront(listener);
  return () => { stopLive(); stopFront(); };
};

/** The live recording's microphone (changeable now) or null, re-read when it or the recording changes. */
function useLiveMicrophone() {
  const subscribe = React.useCallback((listener: () => void) => {
    let stopSwitch = liveRecordingMicrophone()?.subscribe(listener) ?? (() => {});
    const stopLive = subscribeToLiveRecording(() => { stopSwitch(); stopSwitch = liveRecordingMicrophone()?.subscribe(listener) ?? (() => {}); listener(); });
    return () => { stopLive(); stopSwitch(); };
  }, []);
  const microphone = React.useSyncExternalStore(subscribe, liveRecordingMicrophone);
  const deviceId = React.useSyncExternalStore(subscribe, () => liveRecordingMicrophone()?.deviceId() ?? null);
  return { microphone, deviceId };
}

export function RecordingPill({ host, frame = null }: { host: RecordingPillHost; frame?: PillWindow | null }) {
  const shown = React.useSyncExternalStore(subscribeToShown, pillShown);
  const phase = React.useSyncExternalStore(subscribeToLiveRecording, livePhase);
  const nextMicrophone = React.useSyncExternalStore(host.subscribeMicrophone, host.microphone);
  const live = useLiveMicrophone();
  const { rows, failed } = useMicrophones();
  const [menuOpen, setMenuOpen] = React.useState(false);
  if (!shown) return null;
  const read = () => {
    const timing = currentLiveRecording()?.session.timing;
    return timing ? activeDurationMs(timing, Date.now()) : 0;
  };
  const paused = phase === 'paused';
  const choose = (deviceId: string) => {
    host.onMicrophone(deviceId);
    switchLiveRecordingMicrophone(deviceId, error => host.problem(Object.assign(new Error(pill.microphone_not_changed), { cause: error })));
  };
  // In the host's window the menu opens once the window has grown to hold it, and the window shrinks back as it closes.
  const openMenu = (open: boolean) => {
    if (!frame) { setMenuOpen(open); return; }
    if (!open) { setMenuOpen(false); void frame.fit('pill'); return; }
    void frame.fit('menu').then(() => setMenuOpen(true));
  };
  const bar = (
    <RecordingBar compact ground="island" stream={null} active={!paused} readElapsedMs={read} aria-label={pill.label}
      actions={[
        paused ? { id: 'resume', label: pill.resume, icon: 'Play', onPress: () => resumeLiveRecording(host.problem) }
          : { id: 'pause', label: pill.pause, icon: 'Pause', onPress: () => pauseLiveRecording(host.problem) },
        { id: 'stop', label: pill.stop, icon: 'Square', main: true,
          onPress: () => { void stopLiveRecording('capture-completion:operator-stop', 'record-audio:pill').then(result => { if (result.journalError) host.problem(result.journalError); }); } },
      ]}
      trailing={<Dropdown items={failed ? [{ value: '', label: pill.microphones_unavailable, disabled: true }] : rows}
        value={live.deviceId ?? nextMicrophone} onValueChange={choose} open={menuOpen} onOpenChange={openMenu} container={frame?.body ?? null}
        header={live.microphone ? pill.microphone_now : pill.microphone_next} aria-label={pill.microphone_menu}
        icon={<NamedIcon name="Mic" size="sm" aria-hidden="true" />} align="end" />} />
  );
  if (frame) return <Container layout="horizontal" justifyContent="center" alignItems="start" width="full" data-recording-pill="">{bar}</Container>;
  return (
    <Container position="fixed" top="8px" left="50%" transform="translateX(-50%)" zIndex={String(LAYER_ORDER.notification)} data-recording-pill="">
      {bar}
    </Container>
  );
}

/** Draws the pill until the returned function is called: in the host's floating window while it shows, where the host
 *  offers one, else at the top of this page. */
export function mountRecordingPill(host: RecordingPillHost): () => void {
  const element = document.createElement('div');
  element.className = 'coss-ui';
  document.body.append(element);
  const pageRoot = createRoot(element);
  if (!windowHosted()) {
    pageRoot.render(<RecordingPill host={host} />);
    return () => { pageRoot.unmount(); element.remove(); };
  }
  let floating: { frame: PillWindow; root: Root } | null = null;
  const follow = () => {
    if (pillShown() && !floating) {
      const frame = openPillWindow();
      if (!frame) { pageRoot.render(<RecordingPill host={host} />); return; }
      const root = createRoot(frame.root);
      root.render(<RecordingPill host={host} frame={frame} />);
      floating = { frame, root };
    } else if (!pillShown() && floating) {
      floating.root.unmount();
      floating.frame.close();
      floating = null;
    }
  };
  const stop = subscribeToShown(follow);
  follow();
  return () => {
    stop();
    if (floating) { floating.root.unmount(); floating.frame.close(); }
    pageRoot.unmount();
    element.remove();
  };
}
