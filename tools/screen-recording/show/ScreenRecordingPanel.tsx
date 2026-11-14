// packages/screen-recording/show/ScreenRecordingPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Screen recording surface: start/stop/pause capture, elapsed time, recorded
// results list (play, rename, remove). Mirrors RecordAudioVideoPanel.tsx
// but for screen capture via getDisplayMedia.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Saved-recording truth comes only from useBitfieldData('screenRecordings').
//    Component state holds only the in-flight capture session and transient
//    playback object URLs.
// 2. Every mutation (save, rename, remove) goes through an owner workflow
//    action; the action republishes the recordings feed.
// 3. All styling through @/packages/ui + screen-look tokens.
// 4. Diagnostics are captured always (console) but rendered only in the
//    error state — internal vocabulary never sits on the default screen.
// 5. Screen capture availability is strictly binary. If getDisplayMedia
//    is missing, the panel renders a capability-gap message, not a fake UI.
//
// =============================================================================

import * as React from 'react';
import { useBitfieldData } from '#workspace-records';

import {
  createScreenRecordingId,
  removeRecording,
  saveRecordedFile,
  saveRecordingError,
  saveRecordingState,
  setRecordingName,
  type ScreenCaptureMode,
} from '../do-work/screen-recording-requests';
import {
  saveRecordedFileArtifact,
} from '../do-work/recorded-file-artifact';
import {
  readRecordedFileBlob,
  storedRecordedFileRef,
  storeRecordingChunk,
  type LocalPlaybackChunkRef,
} from '../do-work/recorded-file-store';
import {
  isScreenCaptureAvailable,
  screenMediaStream,
  type ScreenCaptureConfig,
} from '../do-work/browser-screen-capture';
import {
  Button,
  Container,
  Dropdown,
  Icon,
  MediaFrame,
  Text,
} from '../../ui';
import { AppSidebar } from '../../sidebar/show/AppSidebar';
import type { NavSectionData } from '../../sidebar/show/SidebarContent';

type CaptureState = 'idle' | 'recording' | 'paused' | 'done' | 'error';

type PendingCapture = {
  recordingId: string;
  mode: ScreenCaptureMode;
  stream: MediaStream;
  mediaRecorder: MediaRecorder;
  chunks: Blob[];
  startTime: number;
  pausedDuration: number;
  lastPauseTime?: number;
};

type RecordingRow = {
  id: string;
  label: string;
  mediaType: string;
  byteLength: number;
  durationMs: number;
  recordedAt: string;
  storedFileRef: any;
};

export function ScreenRecordingPanel() {
  const recordingsData = useBitfieldData('screenRecordings');
  const recordings: RecordingRow[] = recordingsData?.rows ?? [];

  const [captureState, setCaptureState] = React.useState<CaptureState>('idle');
  const [pending, setPending] = React.useState<PendingCapture | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = React.useState<string | null>(null);
  const [selectedMode, setSelectedMode] = React.useState<ScreenCaptureMode>('screen');
  // No local panel geometry. Where this rail sits, how wide it is, whether it
  // floats or hides, is a durable `sidebar-placement` record the person owns.
  const [selectedRecordingId, setSelectedRecordingId] = React.useState<string | null>(null);

  const elapsedTimerRef = React.useRef<NodeJS.Timeout | null>(null);

  // Elapsed time ticker
  React.useEffect(() => {
    if (captureState === 'recording' && pending) {
      elapsedTimerRef.current = setInterval(() => {
        const now = Date.now();
        const totalPaused = pending.pausedDuration + (pending.lastPauseTime ? now - pending.lastPauseTime : 0);
        const elapsed = now - pending.startTime - totalPaused;
        setElapsedMs(elapsed);
      }, 100);
    } else {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
      }
    }
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [captureState, pending]);

  async function startCapture() {
    if (!isScreenCaptureAvailable()) {
      setErrorMessage('Screen recording is not available in this browser.');
      setCaptureState('error');
      await saveRecordingError({
        recordingId: '',
        mode: selectedMode,
        message: 'Screen recording not available',
        observedAt: new Date().toISOString(),
      });
      return;
    }

    const recordingId = createScreenRecordingId();
    setErrorMessage(null);

    try {
      const config: ScreenCaptureConfig = {
        video: true,
        audio: selectedMode === 'screen-with-audio',
      };

      const stream = await screenMediaStream(config);
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorder.onerror = (event) => {
        setErrorMessage(`Recording error: ${event.error}`);
        setCaptureState('error');
        stream.getTracks().forEach((track) => track.stop());
      };

      const newPending: PendingCapture = {
        recordingId,
        mode: selectedMode,
        stream,
        mediaRecorder,
        chunks,
        startTime: Date.now(),
        pausedDuration: 0,
      };

      setPending(newPending);
      mediaRecorder.start();
      setCaptureState('recording');
      setElapsedMs(0);

      await saveRecordingState({
        recordingId,
        mode: selectedMode,
        state: 'started',
        observedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[screen-recording] capture failed:", error); const message = "Recording failed.";
      setErrorMessage(message);
      setCaptureState('error');
      await saveRecordingError({
        recordingId,
        mode: selectedMode,
        message,
        observedAt: new Date().toISOString(),
      });
    }
  }

  async function stopCapture() {
    if (!pending) return;

    const recordingId = pending.recordingId;
    const startTime = pending.startTime;
    const totalPaused = pending.pausedDuration + (pending.lastPauseTime ? Date.now() - pending.lastPauseTime : 0);
    const durationMs = Date.now() - startTime - totalPaused;

    try {
      pending.mediaRecorder.stop();

      await new Promise((resolve) => {
        pending.mediaRecorder.onstop = () => resolve(null);
      });

      pending.stream.getTracks().forEach((track) => track.stop());

      // Store chunks
      const chunkRefs: LocalPlaybackChunkRef[] = [];
      for (let i = 0; i < pending.chunks.length; i++) {
        const chunkRef = await storeRecordingChunk({
          recordingId,
          sequence: i,
          mediaType: 'video/webm',
          chunk: pending.chunks[i],
          observedAt: new Date().toISOString(),
        });
        chunkRefs.push(chunkRef);
      }

      const storedFileRef = storedRecordedFileRef({
        recordingId,
        mediaType: 'video/webm',
        chunkRefs,
      });

      const totalBytes = chunkRefs.reduce((sum, ref) => sum + ref.byte_length, 0);

      // Save artifact and get source ref
      const blob = new Blob(pending.chunks, { type: 'video/webm' });
      const sourceRef = await saveRecordedFileArtifact({
        recordingId,
        blob,
        mediaType: 'video/webm',
      });

      // Save to workflow
      await saveRecordedFile({
        recordingId,
        label: `${new Date().toLocaleString()}`,
        recordedFileId: recordingId,
        mode: pending.mode,
        mediaType: 'video/webm',
        byteLength: totalBytes,
        durationMs,
        recordedAt: new Date().toISOString(),
        storedFileRef,
        sourceRef,
      });

      setCaptureState('done');
      setPending(null);
    } catch (error) {
      console.error("[screen-recording] capture failed:", error); const message = "Recording failed.";
      setErrorMessage(message);
      setCaptureState('error');
      await saveRecordingError({
        recordingId,
        mode: pending.mode,
        message,
        observedAt: new Date().toISOString(),
      });
      pending.stream.getTracks().forEach((track) => track.stop());
      setPending(null);
    }
  }

  async function pauseCapture() {
    if (!pending) return;
    pending.mediaRecorder.pause();
    pending.lastPauseTime = Date.now();
    setCaptureState('paused');
  }

  async function resumeCapture() {
    if (!pending || !pending.lastPauseTime) return;
    pending.pausedDuration += Date.now() - pending.lastPauseTime;
    pending.lastPauseTime = undefined;
    pending.mediaRecorder.resume();
    setCaptureState('recording');
  }

  async function handleRename(recordingId: string, newLabel: string) {
    await setRecordingName({
      recordedFileId: recordingId,
      label: newLabel,
    });
  }

  async function handleRemove(recordingId: string) {
    await removeRecording({
      recordedFileId: recordingId,
    });
  }

  async function playRecording(storedFileRef: any) {
    try {
      const blob = await readRecordedFileBlob(storedFileRef);
      const url = URL.createObjectURL(blob);
      setPlaybackUrl(url);
    } catch (error) {
      console.error("[screen-recording] playback failed:", error); setErrorMessage("Playback failed");
    }
  }

  if (!isScreenCaptureAvailable()) {
    return (
      <Container>
        <Text variant="callout" color="muted">
          Screen recording requires the getDisplayMedia API, which is not available in this browser surface.
        </Text>
      </Container>
    );
  }

  // Recordings stay the source of truth; this only PROJECTS them into the shape
  // the owned sidebar reads. Row actions are DATA, so adding one is a row here.
  const recordingActions = [
    { id: 'play', label: 'Play', icon: 'Play' },
    { id: 'remove', label: 'Remove', icon: 'Trash2', tone: 'destructive' },
  ] as const;
  // One section of the shared sidebar's own rows (the recursive rows every embedded list draws).
  const recordingSections: NavSectionData[] = [{
    id: 'recordings',
    title: 'Recordings',
    items: recordings.map((rec) => ({
      id: rec.id,
      label: rec.label,
      icon: 'Video',
      badge: `${Math.round(rec.durationMs / 1000)}s`,
      actions: [...recordingActions],
    })),
  }];

  return (
    <Container>
      <Container>
        <Dropdown
          label="Mode"
          value={selectedMode}
          onValueChange={(val) => setSelectedMode(val as ScreenCaptureMode)}
          disabled={captureState !== 'idle'}
          items={[
            { value: 'screen', label: 'Screen only' },
            { value: 'screen-with-audio', label: 'Screen + audio' },
          ]}
        />
      </Container>

      <Container>
        {captureState === 'idle' && (
          <Button onClick={startCapture} variant="primary">
            Start
          </Button>
        )}
        {(captureState === 'recording' || captureState === 'paused') && (
          <>
            {captureState === 'recording' && (
              <Button onClick={pauseCapture} variant="secondary">
                Pause
              </Button>
            )}
            {captureState === 'paused' && (
              <Button onClick={resumeCapture} variant="secondary">
                Resume
              </Button>
            )}
            <Button onClick={stopCapture} variant="primary">
              Stop
            </Button>
            <Text variant="body">{Math.floor(elapsedMs / 1000)}s</Text>
          </>
        )}
        {captureState === 'done' && (
          <Button
            onClick={() => {
              setCaptureState('idle');
              setElapsedMs(0);
              setErrorMessage(null);
            }}
            variant="secondary"
          >
            New Recording
          </Button>
        )}
      </Container>

      {errorMessage && (
        <Container>
          <Text variant="caption" color="destructive">
            {errorMessage}
          </Text>
        </Container>
      )}

      {playbackUrl && (
        <Container>
          <MediaFrame url={playbackUrl} mediaType="video/webm" label="Screen recording playback" />
        </Container>
      )}

      <Container>
        <AppSidebar
          instanceId="screen-recording-recordings"
          presentation="embedded"
          sections={recordingSections}
          currentSelectionId={selectedRecordingId ?? ''}
          onNavigate={setSelectedRecordingId}
          emptyContent={<Text variant="body" color="muted">No recordings yet</Text>}
          onItemAction={(item, actionId) => {
            const recordingId = item.viewId ?? item.id;
            const recording = recordings.find((r) => r.id === recordingId);
            if (!recording) return;
            if (actionId === 'play') playRecording(recording.storedFileRef);
            if (actionId === 'remove') handleRemove(recordingId);
          }}
        />
      </Container>
    </Container>
  );
}
