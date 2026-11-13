// src/workspace/always-recording-screen.tsx
//
// PURPOSE
//   Always recording (entry `always-recording`): every camera and microphone this device sees, each with its live
//   picture or its sound, switched on or off, and one Start. From then on nobody presses record: each input switched on
//   records without end through parts/record-audio/do-work/always-recording.ts, cut on the clock into pieces that line
//   up across inputs and devices, kept on this device first and sent into the person's Files while they are recorded
//   (always-recording.json says where and how long each piece runs). A camera plugged in over USB (a camera body streaming
//   over USB-C), a phone used as this computer's camera, the computer's own camera and microphone are all inputs the
//   same way; a phone or another computer that opens this screen records into the same day's folder at the same
//   instants. An input that stops is opened again by itself; an input can be paused for a while or at some hours from
//   its own menu (a show rule on always-recording.json's `show_subject`); the session keeps running when this screen is
//   closed and shows again when it is opened. Each piece that arrives is transcribed and handed to the person's AIs by
//   their own rules, like every recording.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Inputs are whatever this device's browser lists; nothing here names a camera, a phone or a brand.
//   2. Which inputs are on and what each is called are kept on this device (they name this device's own inputs), for the
//      signed-in account only (accountKey): another account on this browser never reads them, and nothing is kept with
//      no account signed in.
//   3. The recording outlives this screen: it is held by this module, and a reopened screen shows the same session.
//   4. A recording this device was sending when its page closed is sent by itself the next time this screen opens.
//   5. Every control is a shared part (parts/ui): MediaFrame for a picture, LiveWaveform for a sound, Switch, Button,
//      Badge, ShowRuleMenu for the pause rule, CopyButton for the address; this file writes no markup of its own.

import * as React from 'react';
import { Badge, Button, Card, Container, InlineEditText, LiveWaveform, Switch, Text } from '../../parts/ui';
import { MediaFrame } from '../../parts/ui/show/media-frame/MediaFrame';
import { CopyButton } from '../../parts/ui/show/copy-button/CopyButton';
import { ShowRuleMenu } from '../../parts/ui/show/show-rules/ShowRuleMenu';
import { showOf, useShowChange } from '../../parts/ui/show/show-rules/show-of';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { startAlwaysRecording, sendLeftOver, type AlwaysRecording, type FeedInput, type FeedStatus } from '../../parts/record-audio/do-work/always-recording';
import { inputName } from '../../parts/record-audio/do-work/rolling-segments.mjs';
import { captureSource, openSource, type CaptureSource } from '../../parts/record-audio/show/record-in-the-browser';
import { accountKey } from '../../parts/ui/show/page-storage/page-storage';
import { deviceAccount } from './api';
import { growingFiles, keepText } from './upload';
import settings from './always-recording.json';
import { DeviceSwitches } from './device-switch';
import { refusal } from './failure';
import { reportDeviceFacts } from './device-facts';
import { NetworkLiveInputs } from './network-live-inputs';

const KEPT = 'trillion.always-recording';
type Kept = { running: boolean; inputs: Record<string, { on: boolean; name: string }> };
// What is kept here is the signed-in account's (which inputs are on, what they are called, whether the session was running):
// another account on this browser never reads it, and nothing is kept with no account signed in. The fixed key an older
// page kept it under cannot be attributed to an account, so it is removed where it is found.
const keptKey = (): string | null => {
  try { localStorage.removeItem(KEPT); } catch { /* nothing to remove */ }
  return accountKey(KEPT);
};
export const readKept = (): Kept => {
  const key = keptKey();
  try { return { running: false, inputs: {}, ...JSON.parse((key && localStorage.getItem(key)) || '{}') }; }
  catch { return { running: false, inputs: {} }; }
};
export const keep = (change: (kept: Kept) => Kept) => { const key = keptKey(); if (key) localStorage.setItem(key, JSON.stringify(change(readKept()))); };

const CAMERA = captureSource(settings.sources.camera) as CaptureSource;
// The picture shown before Start is small: it only says what each camera sees.
const PREVIEW_QUALITY = { width: { ideal: 640 } };
const SKIP = settings.skip_inputs.map(pattern => new RegExp(pattern, 'i'));
const skipped = (label: string) => SKIP.some(pattern => pattern.test(label));
// The browser's own entries that stand for another input (its default and communications choices).
const SAME_AS_ANOTHER = ['default', 'communications'];
// The device an input belongs to, read from its label: a phone used as a camera lists "<phone> Camera" and
// "<phone> Microphone" in different device groups, so its sound is found by the shared name too.
const deviceOf = (label: string) => label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').replace(/\s+(camera|microphone|mic)$/i, '').trim().toLowerCase();
const thingOf = (input: FeedInput) => ({ id: input.id, input: input.name, kind: input.kind });

/** This device's inputs: every camera (with its own sound when a microphone shares its device group) and every
 *  microphone that is not a camera's own. */
async function listInputs(): Promise<FeedInput[]> {
  const devices = (await navigator.mediaDevices.enumerateDevices())
    .filter(device => device.deviceId && !SAME_AS_ANOTHER.includes(device.deviceId) && !skipped(device.label));
  const cameras = devices.filter(device => device.kind === 'videoinput');
  // The cameras this computer sees, by the names they give, so a step waiting on a camera being plugged in ticks itself.
  reportDeviceFacts({ cameras: cameras.map(camera => camera.label).filter(Boolean).join(', ') }, 'always-recording');
  const microphones = devices.filter(device => device.kind === 'audioinput');
  const kept = readKept().inputs;
  const owned = new Set<string>();
  const inputs: FeedInput[] = cameras.map((camera, index) => {
    const own = microphones.find(microphone => (microphone.groupId && microphone.groupId === camera.groupId) || deviceOf(microphone.label) === deviceOf(camera.label));
    if (own) owned.add(own.deviceId);
    const id = `camera:${camera.deviceId}`;
    return { id, kind: 'camera', device: camera.deviceId, sound: own?.deviceId ?? null, name: kept[id]?.name || inputName(camera.label, `Camera ${index + 1}`) };
  });
  microphones.filter(microphone => !owned.has(microphone.deviceId)).forEach((microphone, index) => {
    const id = `microphone:${microphone.deviceId}`;
    inputs.push({ id, kind: 'microphone', device: microphone.deviceId, sound: null, name: kept[id]?.name || inputName(microphone.label, `Microphone ${index + 1}`) });
  });
  return inputs;
}

// The one session on this page, kept here so it outlives the screen.
let session: AlwaysRecording | null = null;
let ending: Promise<void> | null = null;
let saveProblem = '';
let recovering: Promise<number> | null = null;
function recover() {
  if (!recovering) recovering = sendLeftOver(deviceAccount(), growingFiles, keepText)
    .catch(error => { saveProblem = errorWords(error); tellSession(); return 0; })
    .finally(() => { recovering = null; });
  return recovering;
}
const sessionListeners = new Set<() => void>();
const tellSession = () => { for (const listener of [...sessionListeners]) listener(); };

let wake: { release: () => Promise<void> } | null = null;
async function stayAwake() {
  if (!session || ending || document.visibilityState !== 'visible') return;
  try { wake = await (navigator as Navigator & { wakeLock?: { request: (kind: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null; }
  catch { wake = null; }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { void stayAwake(); });

function begin(inputs: FeedInput[]) {
  if (session || ending) return;
  saveProblem = '';
  session = startAlwaysRecording({
    settings, inputs, client: growingFiles, keepList: keepText, account: deviceAccount(),
    device: navigator.userAgent.includes('iPhone') ? 'iPhone' : navigator.userAgent.includes('Android') ? 'Android phone' : 'Computer',
    paused: input => showOf(settings.show_subject, thingOf(input)).hidden,
  });
  keep(kept => ({ ...kept, running: true }));
  void stayAwake();
  tellSession();
}

function end(): Promise<void> {
  if (ending) return ending;
  const running = session;
  if (!running) return Promise.resolve();
  keep(kept => ({ ...kept, running: false }));
  void wake?.release().catch(() => undefined);
  wake = null;
  saveProblem = '';
  ending = running.stop().catch(error => { saveProblem = errorWords(error); }).finally(() => {
    if (session === running) session = null;
    ending = null;
    tellSession();
  });
  tellSession();
  return ending;
}

function useSession(): FeedStatus[] | null {
  const [, redraw] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => {
    sessionListeners.add(redraw);
    const unhear = session?.onChange(redraw);
    return () => { sessionListeners.delete(redraw); unhear?.(); };
  }, [session]);
  return session ? session.statuses() : null;
}

function since(ms: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const two = (value: number) => String(value).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;
}

const STATE_WORDS: Record<FeedStatus['state'], { label: string; tone: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  starting: { label: 'Starting', tone: 'secondary' },
  recording: { label: 'Recording', tone: 'destructive' },
  paused: { label: 'Paused', tone: 'outline' },
  reconnecting: { label: 'Opening again', tone: 'secondary' },
};

/** One input: its picture or its sound, its name, whether it is on, and while recording how much is kept. */
function InputTile({ input, status, on, onToggle, onRename, preview }: { input: FeedInput; status: FeedStatus | null; on: boolean; onToggle: (on: boolean) => void; onRename: ((name: string) => void) | null; preview: MediaStream | null }) {
  const stream = status?.stream ?? preview;
  const words = status ? STATE_WORDS[status.state] : null;
  return (
    <Card variant="nested" padding="none" overflow="hidden" data-always-input={input.kind}>
      <Container position="relative" style={{ aspectRatio: '16 / 9' }} background="overlay">
        {input.kind === 'camera' && stream ? (
          <MediaFrame stream={stream} mediaType="video/webm" label={input.name} muted autoPlay playsInline fill />
        ) : (
          <Container layout="vertical" justifyContent="center" height="full" padding="md">
            <LiveWaveform stream={stream} active={Boolean(stream)} frame="flat" />
          </Container>
        )}
        {words ? (
          <Container position="absolute" className="start-2 top-2">
            <Badge variant={words.tone}>{words.label}</Badge>
          </Container>
        ) : null}
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" padding="sm">
        <Container layout="vertical" gap="xs" flex={1} style={{ minWidth: 0 }}>
          {/* Its name names its files; it can be changed before Start (a piece keeps the name it started with). */}
          {onRename
            ? <InlineEditText variant="body" aria-label={`Name of ${input.name}`} value={input.name} onCommit={onRename} />
            : <Text variant="body" truncate>{input.name}</Text>}
          <Text variant="caption" color="muted" truncate>
            {status?.problem || (status
              ? `${status.kept} kept${status.waiting ? ', waiting for the connection' : ''}`
              : input.kind === 'camera' ? (input.sound ? 'Picture and its own sound' : 'Picture only') : 'Sound')}
          </Text>
        </Container>
        <ShowRuleMenu subject={settings.show_subject} thing={thingOf(input)} label={`Pause ${input.name}`} />
        {status ? null : <Switch checked={on} onCheckedChange={onToggle} label={`Record ${input.name}`} size="sm" />}
      </Container>
    </Card>
  );
}

/** Before Start: each camera's picture, so the person sees what each one sees. */
function usePreviews(inputs: FeedInput[], on: (input: FeedInput) => boolean, wanted: boolean): Record<string, MediaStream> {
  const [streams, setStreams] = React.useState<Record<string, MediaStream>>({});
  const key = inputs.filter(input => input.kind === 'camera' && on(input)).map(input => input.id).join('|');
  React.useEffect(() => {
    if (!wanted) return undefined;
    let gone = false;
    const opened: MediaStream[] = [];
    void (async () => {
      for (const input of inputs.filter(item => item.kind === 'camera' && on(item))) {
        try {
          const stream = await openSource(CAMERA, { video: input.device, audio: false, video_quality: PREVIEW_QUALITY });
          if (gone) { for (const track of stream.getTracks()) track.stop(); return; }
          opened.push(stream);
          setStreams(current => ({ ...current, [input.id]: stream }));
        } catch { /* a camera that will not open shows its name only; Start says why */ }
      }
    })();
    return () => { gone = true; for (const stream of opened) for (const track of stream.getTracks()) track.stop(); setStreams({}); };
    // Opened again only when the cameras switched on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wanted]);
  return streams;
}

/** The browser is asked once so it names its inputs, and let go at once; then the inputs it lists. */
async function lookForInputs(): Promise<FeedInput[]> {
  const asked = await openSource(CAMERA).catch(() => null);
  for (const track of asked?.getTracks() ?? []) track.stop();
  return listInputs();
}

function AlwaysRecordingScreen() {
  useShowChange();
  const statuses = useSession();
  // The inputs this device's browser lists are this screen's read, through the shared screen-state lifecycle: loading
  // rows while the browser is asked, the empty state when nothing is connected, the failed state with Try again.
  const listed = useScreenLoad<FeedInput[]>('always-recording-inputs', {
    loading: { label: 'Looking for cameras and microphones', layout: 'rows' },
    read: lookForInputs,
    empty: found => found.length ? null : { status: 'empty', icon: 'Video', title: 'No camera or microphone is connected', description: 'Plug one in, or allow this site to use your camera, and it shows here.' },
    failed: refusal('Cameras and microphones could not be listed'),
  });
  // A name given here shows at once; the kept name is what the next listing reads.
  const [given, setGiven] = React.useState<Record<string, string>>({});
  const inputs = listed.state ? null : listed.value.map(input => (given[input.id] ? { ...input, name: given[input.id] } : input));
  const [problem, setProblem] = React.useState('');
  const [onOff, setOnOff] = React.useState(() => readKept().inputs);
  const [, tick] = React.useReducer((count: number) => count + 1, 0);
  const [starting, setStarting] = React.useState(false);
  const relist = listed.reload;

  React.useEffect(() => {
    const look = () => { void relist(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', look);
    const timer = window.setInterval(tick, 1000);
    void recover();
    return () => { navigator.mediaDevices?.removeEventListener?.('devicechange', look); window.clearInterval(timer); };
  }, [relist]);

  const on = (input: FeedInput) => onOff[input.id]?.on ?? !skipped(input.name);
  const chosen = (inputs ?? []).filter(on);

  // A session that was running when this device last left the page starts again by itself.
  React.useEffect(() => {
    if (!session && inputs?.length && readKept().running && chosen.length) begin(chosen);
    // Once, when the inputs are first known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs === null]);

  const previews = usePreviews(inputs ?? [], on, !statuses);
  const toggle = (input: FeedInput) => (next: boolean) => {
    keep(kept => ({ ...kept, inputs: { ...kept.inputs, [input.id]: { on: next, name: input.name } } }));
    setOnOff(readKept().inputs);
  };
  const rename = (input: FeedInput) => (name: string) => {
    const given = inputName(name, input.name);
    keep(kept => ({ ...kept, inputs: { ...kept.inputs, [input.id]: { on: on(input), name: given } } }));
    setOnOff(readKept().inputs);
    setGiven(current => ({ ...current, [input.id]: given }));
  };
  const start = () => {
    setStarting(true);
    try { begin(chosen); setProblem(''); } catch (error) { setProblem(errorWords(error)); } finally { setStarting(false); }
  };

  const shown = statuses ? statuses.map(status => status.input) : inputs ?? [];
  const startedMs = session?.startedMs ?? null;
  const address = `${location.origin}/always-recording`;

  return (
    <Container layout="vertical" height="full" gap="md" padding="lg" minHeight="0" overflow="y-auto" data-always-recording="">
      <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between" wrap="wrap">
        <Container layout="vertical" gap="xs" flex={1} style={{ minWidth: 0 }}>
          <Text variant="title">Always recording</Text>
          <Text variant="body" color="muted">
            {ending ? 'Recording stopped. Saving the remaining pieces and session details…' : startedMs
              ? `Recording for ${since(startedMs)}. Every ${Math.round(settings.segment_seconds / 60)} minutes each camera's piece goes to Files under ${settings.folder}.`
              : 'Switch on the cameras and microphones to record, then press Start once. They keep recording until you stop them.'}
          </Text>
        </Container>
        {statuses ? (
          <Button variant="outline" disabled={Boolean(ending)} onClick={() => { return end(); }}>{ending ? 'Saving…' : 'Stop'}</Button>
        ) : (
          <Button variant="primary" disabled={!chosen.length || starting} onClick={start}>{starting ? 'Starting…' : 'Start'}</Button>
        )}
      </Container>

      {saveProblem ? <Text as="p" variant="body" color="error" role="alert">{saveProblem}</Text> : null}
      {problem ? <Text as="p" variant="body" color="error" role="alert">{problem}</Text> : null}
      {/* What stops an input (a refusal, a camera taken by another app) reads in full here, once however many it stops. */}
      {[...new Set((statuses ?? []).map(status => status.problem).filter(Boolean))].map(said => (
        <Text key={said} as="p" variant="body" color="error" role="alert">{said}</Text>
      ))}
      {!statuses && listed.state ? <ScreenState state={listed.state} /> : null}

      <Container layout="grid" gridCols="auto-fill-xs" gap="md">
        {shown.map(input => (
          <InputTile
            key={input.id}
            input={input}
            status={statuses?.find(status => status.input.id === input.id) ?? null}
            on={on(input)}
            onToggle={toggle(input)}
            onRename={statuses ? null : rename(input)}
            preview={previews[input.id] ?? null}
          />
        ))}
      </Container>

      <NetworkLiveInputs />

      <DeviceSwitches place="always-recording" />

      <Card variant="nested" padding="md">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap="wrap">
          <Text variant="body" color="muted" style={{ minWidth: 0 }}>Add a phone as another camera: open this on it and press Start.</Text>
          <CopyButton text={address} label="Copy the address" copiedLabel="Copied" />
        </Container>
      </Card>
    </Container>
  );
}

export function mountAlwaysRecordingScreen(element: HTMLElement): () => void {
  return mountReactSurface(element, <AlwaysRecordingScreen />);
}
