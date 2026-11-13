// src/workspace/record-video-screen.tsx
//
// PURPOSE
//   Record video (entry `record-video`): Alex's record-video package screen (parts/record-video RecordVideoPanel, with
//   its own list of recordings, its camera picture, countdown, silence stop and speech-following teleprompter) as a
//   Trillion screen. Opened from Formats with a format and a thought, the format's script becomes the panel's
//   recording session through the part's own conversion (a presentation plan through
//   parts/record-video/do-work/recording-session-from-presentation-plan.mjs), so the script scrolls with the voice
//   while recording; beside the title, the way to read the script (in full, as its structure or as its ideas:
//   recording.json script_views, kept by script-view.ts) and Have my AI write it, which hands the script to the person's AIs;
//   the work it started is drawn live above the panel (write-with-my-ai.tsx). Where a recording is
//   kept and who it is handed to is recordings.ts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The panel is the package's, changed only as scripts/port-sources.json lists; this file writes no markup of its
//      own beyond the shared parts it composes.
//   2. The session the panel reads is this tab's: opened with a script, the script's session; opened without, none.
//   3. A script never starts the camera by itself: the session is ready (a person's own script needs no setup check) but
//      not authorized, so recording starts only when the person presses Start recording.
//   4. The script comes from the account's formats (GET /work/api/content-formats), read through the shared
//      screen-state part; nothing here names a format or a way of reading one. The voice is followed only in a way of
//      reading whose row says it can be (follows_voice); in the others the teleprompter is moved by hand.
//   5. A run of takes (opened on a list's saved view: takes_list, takes_view) reads one take after another, each a row
//      of that view with a script (recording.mjs takeScript). One press of Start takes is the person's authorization for
//      the run (recording.json takes.authorized_minutes): each take then counts down and starts by itself, ends as
//      recording.json takes.execution says (the last word then quiet, a stop phrase, silence, a time limit, or Stop),
//      is kept and handed on as that row's take, and the next take comes up. Nothing here names a list or a field.

import * as React from 'react';
import { Button, Container, ErrorBoundary, SegmentedControl, Text } from '../../parts/ui';
import { useFocusContainerWhile } from '../../parts/screen-arrangement/show/use-focus-container-while';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { RecordVideoPanel } from '../../parts/record-video/show/RecordVideoPanel';
import { currentLiveRecording, subscribeToLiveRecording } from '../../parts/record-video/show/live-recording';
import { recordingSessionFromPlan } from '../../parts/record-video/do-work/recording-session-from-presentation-plan.mjs';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import { openScreenOn } from './open-screen';
import { writeInputValue } from './records';
import { recordFrom } from './recordings';
import { mirroredView, scriptFor, scriptFromWords, takeScript, viewSegments } from './recording.mjs';
import recordingSettings from './recording.json';
import { useScriptView, type ScriptView } from './script-view';
import { useWriteWithMyAI } from './write-with-my-ai';
import { readStarterLayouts } from '../../../../arrange-screens-in-panes/read-data/starter-layouts.ts';
import { previewStore } from './made-previews';
import { openSharing } from './sharing-sheet';
import surfaces from './screens.mjs';
import pageScreens from './record-page-screens.json';
import type { Unmount } from './lazy-screen';

// A recording's page: the screens it opens on (record-page-screens.json `recording`) and the app's own ⋯ rows.
const [RECORDING_PAGE] = readStarterLayouts([pageScreens.recording]);
const RECORDING_MENU = [{
  id: 'share', label: 'Share', icon: 'Share2',
  run: (recording: { label: string; fileRef: string | null }) => { if (recording.fileRef) openSharing(recording.fileRef, { title: recording.label, anchor: document.activeElement }); },
}];

type Format = { id: string; label: string; slots: { id: string; label: string; hint?: string }[]; input?: string; process?: string[]; output?: string; from: string };
type Script = ReturnType<typeof scriptFor>;
type SourceReference = { kind: string; label: string; id: string; title: string };
type Input = { format_id?: unknown; about?: unknown; material?: unknown; source?: unknown; takes_list?: unknown; takes_view?: unknown; script?: unknown; title?: unknown };
type ListRow = { id: string; title: string | null; values: Record<string, unknown> };
/** One press of Start takes: when it was pressed, and until when the run may start each take by itself. */
type Run = { authorizedAtMs: number; grantUntilMs: number };

const SESSION_INPUT = 'recording-session';
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const postShape = (source: { kind: string; id: string }) => postJson<{ source: SourceReference | null; material: string }>('/work/api/content-formats/shape', { source });

/** Reads the format this tab was opened with and drops the thought (and the person's own material) into it; no format
 * means no script. */
async function readScript(input: Input, materialOverride?: string): Promise<Script | null> {
  // Finished words handed in directly (an interface of controls, an AI) are the script as they are.
  if (typeof input.script === 'string') return scriptFromWords(input.script, { label: text(input.title) || undefined }) as Script;
  const formatId = text(input.format_id);
  if (!formatId) return null;
  const { formats } = await readJson<{ formats: Format[] }>('/work/api/content-formats');
  const format = formats.find(item => item.id === formatId);
  if (!format) throw new Error('That format is not in your formats any more. Open Formats and choose another.');
  return scriptFor(format, text(input.about), materialOverride ?? text(input.material));
}

async function readSource(input: Input): Promise<{ source: SourceReference; material: string } | null> {
  if (input.source == null) return null;
  if (typeof input.source !== 'object' || Array.isArray(input.source)) throw new Error('That source reference could not be read. Choose it again in Formats.');
  const source = input.source as Partial<SourceReference>;
  if (typeof source.kind !== 'string' || typeof source.id !== 'string' || !source.id) throw new Error('That source is no longer available in this account. Choose it again in Formats.');
  const answer = await postShape({ kind: source.kind, id: source.id });
  if (!answer.source) throw new Error('That source is no longer available in this account. Choose it again in Formats.');
  return { source: answer.source, material: answer.material };
}

/** A script, read the chosen way, as the presentation plan the part turns into its recording session: each part of
 *  the format one beat. */
function sessionOf(script: Script, view: ScriptView, run: Run | null = null) {
  const takes = recordingSettings.takes;
  const plan = {
    id: `${script.format_id}:${script.about}`,
    title: script.format_label,
    subtitle: script.about,
    format_id: script.format_id,
    medium: 'video',
    execution: {
      adapter: 'capture.video', countdown_seconds: 0, follow_speech: view.follows_voice, allow_manual_nudge: true, mirror_script: mirroredView(view),
      // A take of a run counts down, and ends as the run's DATA says.
      ...(run ? { ...takes.execution, countdown_seconds: takes.countdown_seconds } : {}),
    },
    beats: viewSegments(script, view).map(text => ({ delivery: 'speak', text })),
  };
  // A person's own script asks for no setup check, so it is ready. Only a take of a run whose Start takes was pressed is
  // authorized, so it starts by itself; anything else waits for Start recording.
  const authorization = run ? { plan_id: plan.id, authorized: true, authorized_at_ms: run.authorizedAtMs, grant_until_ms: run.grantUntilMs } : null;
  return recordingSessionFromPlan({ plan, readiness: { plan_id: plan.id, state: 'ready_to_authorize', problems: [], requirements: [] }, authorization });
}

type RecordVideoProps = {
  script: Script | null;
  source?: SourceReference | null;
  /** A take of a run: the run it belongs to, what it shows beside the title, and what to do once it is kept. */
  run?: Run | null;
  takeActions?: (capturing: boolean) => React.ReactNode;
  onTakeKept?: () => void;
};

function RecordVideo({ script, source = null, run = null, takeActions, onTakeKept }: RecordVideoProps) {
  const [ready, setReady] = React.useState(false);
  const [captureActive, setCaptureActive] = React.useState(false);
  const screenRef = React.useRef<HTMLDivElement>(null);
  useFocusContainerWhile(captureActive, screenRef, 600);
  const { views, view, choose } = useScriptView();
  React.useEffect(() => {
    recordFrom(script, source);
    void writeInputValue(SESSION_INPUT, script ? sessionOf(script, view, run) : null).finally(() => setReady(true));
    return () => recordFrom(null);
  }, [script, source, view, run]);
  const write = useWriteWithMyAI(script);
  if (!ready) return null;
  const actions = script ? (
    <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap">
      {takeActions?.(false)}
      {views.length > 1 ? <SegmentedControl ariaLabel="How to read the script" items={views.map(({ id, label }) => ({ id, label }))} value={view.id} onValueChange={choose} /> : null}
      {takeActions ? null : write.button}
    </Container>
  ) : undefined;
  return (
    <ErrorBoundary surfaceName="Record video">
      <Container ref={screenRef} layout="vertical" height="full" minHeight="0" gap="none">
        {write.run ? <Container padding="md" className="max-h-[40%] shrink-0 overflow-y-auto">{write.run}</Container> : null}
        {script && !script.ready ? (
          <Container padding="md" className="shrink-0" role="status" data-script-not-ready>
            <Text variant="body-sm" weight="semibold">Not ready to read yet</Text>
            <Text variant="body-sm" color="muted">{script.missing.length ? `${script.missing.join(', ')} still ${script.missing.length === 1 ? 'needs' : 'need'} words.` : 'Write the words first.'}</Text>
          </Container>
        ) : null}
        <Container flex={1} minHeight="0">
          <RecordVideoPanel
            captureActions={actions}
            liveCaptureActions={takeActions?.(true)}
            onCaptureActiveChange={setCaptureActive}
            pageScreens={RECORDING_PAGE ?? null}
            surfaceListAddressLabel={surfaces.address_label}
            previewStore={previewStore}
            recordingMenuRows={RECORDING_MENU}
            onRecordingSaved={onTakeKept}
          />
        </Container>
      </Container>
    </ErrorBoundary>
  );
}

/** Reads a list's saved view: its rows, each with its title and values. */
async function readTakes(list: string, view: string): Promise<Script[]> {
  const answer = await readJson<{ rows: ListRow[] }>(`/work/api/lists/${encodeURIComponent(list)}${view ? `?view=${encodeURIComponent(view)}` : ''}`);
  return answer.rows.map(row => takeScript(row, { list_id: list })).filter((take): take is Script => take !== null);
}

/** A run of takes over a list's saved view: one take after another, each starting by itself once the run is started. */
function Takes({ takes }: { takes: Script[] }) {
  const [at, setAt] = React.useState(0);
  const [run, setRun] = React.useState<Run | null>(null);
  // Which press of Start takes this is: a new press gives the take a new panel, so it starts by itself; Stop takes
  // keeps the panel, so a take being recorded goes on and is kept, and the next one waits.
  const [presses, setPresses] = React.useState(0);
  const take = takes[at] ?? null;
  const start = () => {
    const now = Date.now();
    setRun({ authorizedAtMs: now, grantUntilMs: now + recordingSettings.takes.authorized_minutes * 60_000 });
    setPresses(count => count + 1);
  };
  const next = React.useCallback(() => setAt(index => index + 1), []);
  if (!take) {
    return <ScreenState state={{ status: 'empty', icon: 'CircleCheck', title: takes.length ? 'Every take is recorded' : 'No takes to record', description: takes.length ? 'Each one went to your AI to make into a post for you to look at.' : 'There are no scripts waiting in this list.' }} />;
  }
  // Skip leaves while nothing is being recorded, so a take is never thrown away by it.
  const actions = (capturing: boolean) => (
    <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap">
      <Text variant="body-sm" weight="semibold">{`Take ${at + 1} of ${takes.length}`}</Text>
      {run ? <Button variant="secondary" size="sm" onClick={() => setRun(null)}>Stop takes</Button> : <Button variant="primary" size="sm" onClick={start}>Start takes</Button>}
      {capturing ? null : <Button variant="ghost" size="sm" onClick={next}>Skip</Button>}
    </Container>
  );
  // A new panel for each take, so each take starts from its own session with nothing of the last one selected.
  return <RecordVideo key={`${take.format_id}:${presses}`} script={take} run={run} takeActions={actions} onTakeKept={next} />;
}

function TakesRoot({ list, view }: { list: string; view: string }) {
  const loaded = useScreenLoad(`${list}\u001f${view}`, {
    loading: { label: 'Loading your takes', layout: 'editor' },
    read: () => readTakes(list, view),
    failed: refusal('Your takes could not load'),
  });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <Takes takes={loaded.value} />;
}

function RecordVideoRoot({ input }: { input: Input }) {
  const [settledInput, setSettledInput] = React.useState(input);
  const latestInput = React.useRef(input);
  latestInput.current = input;
  React.useEffect(() => {
    const settleWhenIdle = () => {
      if (!currentLiveRecording()) setSettledInput(latestInput.current);
    };
    const unsubscribe = subscribeToLiveRecording(settleWhenIdle);
    settleWhenIdle();
    return unsubscribe;
  }, []);
  React.useEffect(() => {
    if (!currentLiveRecording()) setSettledInput(input);
  }, [input]);
  return text(settledInput.takes_list)
    ? <TakesRoot list={text(settledInput.takes_list)} view={text(settledInput.takes_view)} />
    : <ScriptRoot input={settledInput} />;
}

function ScriptRoot({ input }: { input: Input }) {
  const key = `${text(input.format_id)}\u001f${text(input.about)}\u001f${text(input.material)}\u001f${text(input.script)}\u001f${text(input.title)}\u001f${JSON.stringify(input.source ?? null)}`;
  const loaded = useScreenLoad(key, {
    loading: { label: 'Loading your script', layout: 'editor' },
    read: async () => {
      const selected = await readSource(input);
      return { script: await readScript(input, selected?.material), source: selected?.source ?? null };
    },
    failed: refusal('Your script could not load'),
  });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <RecordVideo script={loaded.value.script} source={loaded.value.source} />;
}

/** Opens Record video with a format's script about a thought, filled with the person's own material when there is some:
 * the tab named after the format. */
export const openRecordWith = (formatId: string, label: string, about: string, source: SourceReference | null = null) => openScreenOn('trillion.record-video', { format_id: formatId, about, ...(source ? { source } : {}) }, label);

export function mountRecordVideoScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}): Unmount {
  const surface = mountReactSurface(element, <RecordVideoRoot input={props.surfaceInput ?? {}} />);
  const unmount: Unmount = () => surface();
  unmount.update = next => surface.render?.(<RecordVideoRoot input={next.surfaceInput ?? {}} />);
  return unmount;
}
