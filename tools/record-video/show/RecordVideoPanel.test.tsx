import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordVideoPanel } from './RecordVideoPanel';
import { currentLiveRecording, releaseLiveRecording } from './live-recording';

const mocks = vi.hoisted(() => ({
  saveRecordedFile: vi.fn(async () => undefined),
  saveRecordingError: vi.fn(async () => undefined),
  saveRecordingState: vi.fn(async () => undefined),
  saveRecordedFileArtifact: vi.fn(async () => ({ sourceRef: { role: 'recording', address: 'source:test' } })),
  writeCaptureJournal: vi.fn(async () => undefined),
  deleteCaptureJournal: vi.fn(async () => undefined),
  storeRecordingChunkWithRetry: vi.fn(async ({ sequence }: { sequence: number }) => ({
    key: `recording:test:chunk:${sequence}`,
    byte_length: 5,
  })),
  deviceChangeListener: null as (() => void) | null,
  recordingSession: null as Record<string, unknown> | null,
}));

vi.mock('#workspace-records', () => ({ sendRequestToBitfieldTarget: vi.fn() }));
vi.mock('#workspace-records', () => ({
  useBitfieldData: (input: string | { input?: string }) => {
    if (input === 'recording-session') return mocks.recordingSession;
    if (input === 'recordVideoCapturePolicy') {
      return { maximum_sample_gap_ms: 500, journal_lease_ms: 5_000, journal_heartbeat_ms: 1_000 };
    }
    if (input === 'recordVideoCompletionReasonRefs') {
      return {
        manual: 'capture-completion:operator-stop',
        speech: 'capture-completion:confirmed-script-complete',
        silence: 'capture-completion:measured-silence-after-speech',
        duration: 'capture-completion:active-duration-limit',
        provider_end: 'capture-completion:provider-ended',
        provider_error: 'capture-completion:provider-error',
        cancel: 'capture-completion:operator-cancel',
      };
    }
    return input && typeof input === 'object' ? [] : [];
  },
}));

vi.mock('../do-work/record-video-requests', () => ({
  createRecordVideoId: (kind: string) => `${kind}:test`,
  removeRecording: vi.fn(async () => undefined),
  saveRecordedFile: mocks.saveRecordedFile,
  saveRecordingError: mocks.saveRecordingError,
  saveRecordingState: mocks.saveRecordingState,
  setRecordingName: vi.fn(async () => undefined),
  setRecordingSubtitle: vi.fn(async () => undefined),
}));
vi.mock('../do-work/recorded-file-artifact', () => ({
  saveRecordedFileArtifact: mocks.saveRecordedFileArtifact,
}));
vi.mock('../do-work/recorded-file-store', () => ({
  captureJournalRecoveryState: () => 'recover',
  deleteCaptureJournal: mocks.deleteCaptureJournal,
  listCaptureJournals: vi.fn(async () => []),
  readRecordedFileBlob: vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })),
  storedRecordedFileRef: ({ recordingId, recordedFileId, recordedAt, mediaType, chunkRefs }: Record<string, any>) => ({
    kind: 'local-playback.indexeddb-chunks', database: 'record-video', store: 'recorded-chunks',
    recording_id: recordingId, recorded_file_id: recordedFileId, recorded_at: recordedAt,
    media_type: mediaType, chunk_refs: chunkRefs,
    byte_length: chunkRefs.reduce((total: number, ref: { byte_length: number }) => total + ref.byte_length, 0),
  }),
  storeRecordingChunk: vi.fn(),
  storeRecordingChunkWithRetry: mocks.storeRecordingChunkWithRetry,
  writeCaptureJournal: mocks.writeCaptureJournal,
}));
vi.mock('../read-data/recording-enrichment', () => ({
  decodeEnrichmentsByRecording: () => new Map(),
}));
vi.mock('./RecordingEnrichmentPanel', () => ({ RecordingEnrichmentPanel: () => null }));
vi.mock('../../local-files/do-work/choose-local-files', () => ({ chooseLocalFiles: vi.fn(async () => []) }));
vi.mock('./browser-media-capture', () => ({
  capturePermissionState: vi.fn(async () => 'granted'),
  isPermissionError: () => false,
  mediaCaptureAvailability: () => 'mediaDevices=yes',
  mediaStreamForMode: vi.fn(async () => testStream),
  recordVideoCapabilityPermissionForMode: () => null,
}));
vi.mock('./setup-observer', () => ({
  observeBrowserMediaSetup: vi.fn(),
  observeMediaDeviceChanges: vi.fn((listener: () => void) => {
    mocks.deviceChangeListener = listener;
    return () => { mocks.deviceChangeListener = null; };
  }),
  readinessObservationsFromSetup: vi.fn(() => ({})),
}));
vi.mock('../../permission-lease/show/CapabilityPermissionPrompt', () => ({ CapabilityPermissionPrompt: () => null }));
vi.mock('../../sidebar/show/AppSidebar', () => ({ AppSidebar: () => <aside>No recordings yet</aside> }));
vi.mock('../../ui/show/placeable-surface-intent/placeable-surface-subject', () => ({
  admitPlaceableSurfaceSubject: () => ({ ref: { address: 'subject:test' } }),
}));
vi.mock('../../screen-arrangement/show/EmbeddedScreenArrangement', () => ({
  EmbeddedScreenArrangementView: () => null,
}));
vi.mock('../../ui', () => ({
  AudioClipPlayer: () => null,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  CaptionScroll: ({ segments }: { segments: string[] }) => <div data-testid="caption-scroll">{segments.join(' ')}</div>,
  Container: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <div>{children}</div>,
  DEFAULT_COLLECTION_SIDEBAR_PANEL_STATE: {},
  Dropdown: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <div>{children}</div>,
  HoverRevealGroup: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <>{children}</>,
  HoverRevealItem: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <>{children}</>,
  Icon: () => null,
  InlineEditText: ({ value }: { value: string }) => <span>{value}</span>,
  LiveWaveform: () => <div>Live waveform</div>,
  MediaFrame: ({ label, stream }: { label: string; stream: unknown }) => (
    <div data-testid="media-frame" data-has-stream={stream ? 'yes' : 'no'}>{label}</div>
  ),
  Text: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <div>{children}</div>,
  Tooltip: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <>{children}</>,
  emitPlaceableSurfaceIntent: vi.fn(),
  findPlaceableSurfaces: () => [],
  readPublishedRecords: () => [],
}));

class TestTrack {
  readyState = 'live';
  label: string;
  stopped = false;
  private ended: (() => void) | null = null;

  constructor(public kind: 'audio' | 'video') { this.label = `Test ${kind}`; }
  addEventListener(name: string, listener: () => void) { if (name === 'ended') this.ended = listener; }
  stop() { this.stopped = true; this.readyState = 'ended'; }
  endFromProvider() { this.readyState = 'ended'; this.ended?.(); }
}

let testTracks = [new TestTrack('video'), new TestTrack('audio')];
let testStream = { getTracks: () => testTracks, getAudioTracks: () => testTracks.filter((track) => track.kind === 'audio') };

class TestMediaRecorder {
  static isTypeSupported() { return true; }
  state = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: unknown, options?: { mimeType?: string }) { this.mimeType = options?.mimeType ?? 'video/webm'; }
  start() { this.state = 'recording'; queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['video']) })); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
}

async function startRecording() {
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
  await screen.findByRole('button', { name: 'Stop' });
  await waitFor(() => expect(mocks.storeRecordingChunkWithRetry).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordingSession = null;
  mocks.deviceChangeListener = null;
  testTracks = [new TestTrack('video'), new TestTrack('audio')];
  testStream = { getTracks: () => testTracks, getAudioTracks: () => testTracks.filter((track) => track.kind === 'audio') };
  vi.stubGlobal('MediaRecorder', TestMediaRecorder);
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
});

afterEach(() => {
  const activeId = currentLiveRecording()?.session.recordingId;
  if (activeId) releaseLiveRecording(activeId);
  cleanup();
  vi.unstubAllGlobals();
});

describe('RecordVideoPanel capture surface', () => {
  it('requires a fresh setup check after the camera or microphone changes', async () => {
    render(<RecordVideoPanel now={() => new Date('2026-09-10T12:00:00.000Z')} />);
    expect(mocks.deviceChangeListener).toBeTypeOf('function');

    act(() => mocks.deviceChangeListener?.());

    expect(await screen.findByText('Camera or microphone changed. Check setup again.')).toBeTruthy();
  });

  it('keeps the recording status when device enumeration changes but captured tracks remain live', async () => {
    render(<RecordVideoPanel now={() => new Date('2026-09-10T12:00:00.000Z')} />);
    await startRecording();
    act(() => mocks.deviceChangeListener?.());
    expect(screen.queryByText('Camera or microphone changed. Check setup again.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });

  it('paints the selected camera stream and preserves capture ownership across a remount', async () => {
    const first = render(<RecordVideoPanel now={() => new Date('2026-09-10T12:00:00.000Z')} />);
    expect(screen.getByText('Record video')).toBeTruthy();
    await startRecording();
    expect(screen.getByTestId('media-frame').textContent).toBe('Camera preview');
    expect(screen.getByTestId('media-frame').getAttribute('data-has-stream')).toBe('yes');

    first.unmount();
    render(<RecordVideoPanel now={() => new Date('2026-09-10T12:00:00.000Z')} />);
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.getByTestId('media-frame').getAttribute('data-has-stream')).toBe('yes');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(mocks.saveRecordedFile).toHaveBeenCalledWith(expect.objectContaining({
      completionReasonRef: 'capture-completion:operator-stop',
      artifactDisposition: 'saved',
    })));
    expect(testTracks.every((track) => track.stopped)).toBe(true);
    expect(currentLiveRecording()).toBeNull();
  });

  it('shows a teleprompter only while its recording session is capturing', async () => {
    mocks.recordingSession = { session_id: 'session:test', title: 'Read this', script_text: 'A short recording script.', auto_start: false };

    render(<RecordVideoPanel now={() => new Date('2026-09-10T12:00:00.000Z')} />);
    expect(screen.queryByTestId('caption-scroll')).toBeNull();

    await startRecording();

    expect(screen.getByTestId('caption-scroll').textContent).toBe('A short recording script.');
  });
});
