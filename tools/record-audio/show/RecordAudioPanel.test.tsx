import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordAudioPanel } from './RecordAudioPanel';
import { currentLiveRecording, releaseLiveRecording } from './live-recording';
import { mediaStreamForMode } from './browser-media-capture';
import { createMeetingJoinRecordingInvocation } from '../do-work/meeting-join-recording';

const meetingContext = { source: 'calendar:source-a', sourceId: 'account:a/calendar:main', eventId: 'event:a', title: 'Planning', startsAt: '2026-10-14T10:00:00.000Z', endsAt: '2026-10-14T11:00:00.000Z', url: 'https://meet.example/a' };

const mocks = vi.hoisted(() => ({
  completeRecordedEvidence: vi.fn(async () => undefined),
  saveRecordedFile: vi.fn(async (_input?: Record<string, unknown>) => undefined),
  saveRecordingError: vi.fn(async () => undefined),
  saveRecordingState: vi.fn(async () => undefined),
  saveRecordedFileArtifact: vi.fn(async () => ({ sourceRef: 'source:recorded-file:test' })),
  writeCaptureJournal: vi.fn(async (_input?: Record<string, unknown>) => undefined),
  deleteCaptureJournal: vi.fn(async () => undefined),
  storeRecordingChunkWithRetry: vi.fn(async ({ sequence }: { sequence: number }) => ({
    key: `recording:test:chunk:${sequence}`,
    byte_length: 5,
  })),
  claimMeetingJoinRecordingInvocation: vi.fn(async () => true),
}));

vi.mock('../do-work/evidence-completion', () => ({
  completeRecordedEvidence: mocks.completeRecordedEvidence,
}));

vi.mock('#workspace-records', () => ({
  bitfieldGeneratedPackageEntryScopeBinding: {},
  bitfieldGeneratedLiveReadScopeDescriptor: { partitionLabel: 'test' },
  useBitfieldData: (name: string) => {
    if (name === 'recordAudioCapturePolicy') return { journal_lease_ms: 5_000, journal_heartbeat_ms: 1_000 };
    if (name === 'recordAudioCompletionReasonRefs') {
      return {
        manual: 'capture-completion:operator-stop',
        provider_end: 'capture-completion:provider-ended',
        provider_error: 'capture-completion:provider-error',
        cancel: 'capture-completion:operator-cancel',
      };
    }
    return [];
  },
}));

vi.mock('../do-work/record-audio-requests', () => ({
  createRecordAudioId: (kind: string) => `${kind}:test`,
  saveRecordedFile: mocks.saveRecordedFile,
  saveRecordingError: mocks.saveRecordingError,
  saveRecordingState: mocks.saveRecordingState,
}));

vi.mock('../do-work/recorded-file-artifact', () => ({
  saveRecordedFileArtifact: mocks.saveRecordedFileArtifact,
}));

vi.mock('../do-work/recorded-file-store', async importOriginal => ({
  ...(await importOriginal<typeof import('../do-work/recorded-file-store')>()),
  captureJournalRecoveryState: () => 'recover',
  claimMeetingJoinRecordingInvocation: mocks.claimMeetingJoinRecordingInvocation,
  deleteCaptureJournal: mocks.deleteCaptureJournal,
  listCaptureJournals: vi.fn(async () => []),
  readRecordedFileBlob: vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })),
  storedRecordedFileRef: ({ recordingId, recordedFileId, recordedAt, mediaType, chunkRefs }: Record<string, any>) => ({
    kind: 'local-playback.indexeddb-chunks',
    database: 'record-audio',
    store: 'recorded-chunks',
    recording_id: recordingId,
    recorded_file_id: recordedFileId,
    recorded_at: recordedAt,
    media_type: mediaType,
    chunk_refs: chunkRefs,
    byte_length: chunkRefs.reduce((total: number, ref: { byte_length: number }) => total + ref.byte_length, 0),
  }),
  storeRecordingChunk: vi.fn(async () => ({ key: 'recording:test:chunk:0', byte_length: 10 })),
  storeRecordingChunkWithRetry: mocks.storeRecordingChunkWithRetry,
  writeCaptureJournal: mocks.writeCaptureJournal,
}));

vi.mock('./browser-media-capture', () => ({
  mediaCaptureAvailability: () => 'mediaDevices=yes',
  mediaStreamForMode: vi.fn(async () => testStream),
  recordAudioCapabilityPermission: {},
}));

// The actual shared bar is exercised here; waveform painting is qualified in the browser.
vi.mock('../../ui/show/live-waveform', () => ({ LiveWaveform: () => <div>Live waveform</div> }));

vi.mock('../../permission-lease/show/CapabilityPermissionPrompt', () => ({
  CapabilityPermissionPrompt: () => <div data-testid="permission-card" />,
}));
vi.mock('./RecordingLibrary', () => ({
  RecordingLibrary: () => <div>Recording library ready</div>,
}));
vi.mock('../../screen-arrangement/show/ArrangedContents', () => ({
  ArrangedContents: ({ pieces }: { pieces: { id: string; content: React.ReactNode }[] }) => <>{pieces.map(piece => <React.Fragment key={piece.id}>{piece.content}</React.Fragment>)}</>,
}));
vi.mock('../../ui', async () => ({
  Button: (await vi.importActual<typeof import('../../ui/show/button/Button')>('../../ui/show/button/Button')).Button,
  Container: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <div>{children}</div>,
  ErrorBoundary: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <>{children}</>,
  Icon: () => null,
  RecordingBar: (await vi.importActual<typeof import('../../ui/show/recording-bar/RecordingBar')>('../../ui/show/recording-bar/RecordingBar')).RecordingBar,
  LiveWaveform: () => <div>Live waveform</div>,
  Text: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <div>{children}</div>,
  ToastProvider: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => <>{children}</>,
  sanitizeErrorText: (message: string, fallback: string) => message || fallback,
}));

class TestTrack {
  kind = 'audio';
  readyState = 'live';
  label = 'Test microphone';
  stopped = false;
  private ended: (() => void) | null = null;

  addEventListener(name: string, listener: () => void) {
    if (name === 'ended') this.ended = listener;
  }

  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }

  endFromProvider() {
    this.readyState = 'ended';
    this.ended?.();
  }
}

let testTrack = new TestTrack();
let testStream = { getTracks: () => [testTrack] };

class TestMediaRecorder {
  static isTypeSupported() { return true; }
  state = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
  }

  start() {
    this.state = 'recording';
    queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['audio']) }));
  }

  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }

  stop() {
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
  }
}

async function startRecording() {
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
  await screen.findByRole('button', { name: 'Stop' });
  await waitFor(() => expect(mocks.storeRecordingChunkWithRetry).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  testTrack = new TestTrack();
  testStream = { getTracks: () => [testTrack] };
  vi.stubGlobal('MediaRecorder', TestMediaRecorder);
});

afterEach(() => {
  const activeId = currentLiveRecording()?.session.recordingId;
  if (activeId) releaseLiveRecording(activeId);
  cleanup();
  vi.unstubAllGlobals();
});

describe('RecordAudioPanel capture surface', () => {
  it('starts the existing audio capture only for an initiated Trillion join when selected', async () => {
    const invocation = createMeetingJoinRecordingInvocation(meetingContext);
    render(<RecordAudioPanel meetingStartMode="through-app" meetingJoinRecording={invocation} />);

    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(mediaStreamForMode).toHaveBeenCalledWith('audio');
    expect(mocks.claimMeetingJoinRecordingInvocation).toHaveBeenCalledWith(
      invocation.invocationId,
      Date.parse(invocation.expiresAt),
    );
    expect(mocks.writeCaptureJournal.mock.calls[0]?.[0]).toMatchObject({
      meeting_join_invocation_id: invocation.invocationId,
      meeting_event_context: meetingContext,
    });
  });

  it('retains the exact meeting context into the saved recording row only for the Join-triggered take', async () => {
    const invocation = createMeetingJoinRecordingInvocation(meetingContext);
    render(<RecordAudioPanel meetingStartMode="through-app" meetingJoinRecording={invocation} />);
    await screen.findByRole('button', { name: 'Stop' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(mocks.saveRecordedFile).toHaveBeenCalled());
    expect(mocks.saveRecordedFile.mock.calls[0]?.[0]).toMatchObject({ meetingEventContext: meetingContext });
  });

  it('does not label an ordinary manual recording with carried event metadata', async () => {
    render(<RecordAudioPanel />);
    await startRecording();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(mocks.saveRecordedFile).toHaveBeenCalled());
    expect(mocks.saveRecordedFile.mock.calls[0]?.[0]).not.toHaveProperty('meetingEventContext');
  });

  it('keeps meeting capture manual by default', async () => {
    render(<RecordAudioPanel meetingJoinRecording={createMeetingJoinRecordingInvocation(meetingContext)} />);

    await waitFor(() => expect(mediaStreamForMode).not.toHaveBeenCalled());
    expect(mocks.claimMeetingJoinRecordingInvocation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeTruthy();
  });

  it('ignores expired Join call invocations', async () => {
    const invocation = createMeetingJoinRecordingInvocation(meetingContext, Date.now() - 3 * 60 * 1000);
    render(<RecordAudioPanel meetingStartMode="through-app" meetingJoinRecording={invocation} />);

    await waitFor(() => expect(mediaStreamForMode).not.toHaveBeenCalled());
    expect(mocks.claimMeetingJoinRecordingInvocation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeTruthy();
  });

  it('attempts a carried Join call invocation only once per panel mount', async () => {
    const invocation = createMeetingJoinRecordingInvocation(meetingContext);
    const view = render(<RecordAudioPanel meetingStartMode="through-app" meetingJoinRecording={invocation} />);
    await screen.findByRole('button', { name: 'Stop' });

    view.rerender(<RecordAudioPanel meetingStartMode="through-app" meetingJoinRecording={invocation} />);
    await waitFor(() => expect(mocks.claimMeetingJoinRecordingInvocation).toHaveBeenCalledTimes(1));
  });

  it('keeps the originating completion target across panel input changes', async () => {
    const original = { target: 'owner:complete', correlation: { answer: 'first' } };
    const view = render(<RecordAudioPanel completionTarget={original} />);
    await startRecording();
    original.correlation.answer = 'mutated';
    view.rerender(<RecordAudioPanel completionTarget={{ target: 'owner:other', correlation: { answer: 'second' } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText('Recording saved.');
    expect(mocks.completeRecordedEvidence).toHaveBeenCalledWith(expect.objectContaining({
      completionTarget: { target: 'owner:complete', correlation: { answer: 'first' } },
      recordedFileId: 'recorded-file:test',
    }));
    expect(mocks.writeCaptureJournal).toHaveBeenCalledWith(expect.objectContaining({
      surface_completion_target: { target: 'owner:complete', correlation: { answer: 'first' } },
    }));
  });
  it('shows live controls, pauses, resumes, manually stops, saves, and releases the device', async () => {
    render(<RecordAudioPanel now={() => new Date('2026-09-10T12:00:00.000Z')} />);
    expect(screen.getByText('Record audio')).toBeTruthy();
    expect(screen.getByText('Recording library ready')).toBeTruthy();

    await startRecording();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(await screen.findByText('Recording saved.')).toBeTruthy();
    expect(mocks.saveRecordedFile).toHaveBeenCalledWith(expect.objectContaining({
      completionReasonRef: 'capture-completion:operator-stop',
      artifactDisposition: 'saved',
    }));
    expect(mocks.deleteCaptureJournal).toHaveBeenCalledWith('recording:test');
    expect(testTrack.stopped).toBe(true);
    expect(currentLiveRecording()).toBeNull();
  });

  it('keeps provider-ended completion distinct from the manual stop control', async () => {
    render(<RecordAudioPanel now={() => new Date('2026-09-10T12:00:00.000Z')} />);
    await startRecording();
    testTrack.endFromProvider();

    expect(await screen.findByText('Recording saved.')).toBeTruthy();
    expect(mocks.saveRecordedFile).toHaveBeenCalledWith(expect.objectContaining({
      completionReasonRef: 'capture-completion:provider-ended',
    }));
  });

  it('keeps audio file import available while microphone access is pending', async () => {
    let grantMicrophone!: (stream: MediaStream) => void;
    vi.mocked(mediaStreamForMode).mockImplementationOnce(() => new Promise((resolve) => {
      grantMicrophone = resolve;
    }));
    render(<RecordAudioPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('Allow access.');
    const picker = screen.getByRole('button', { name: 'Pick an audio file' });
    expect(picker).not.toHaveProperty('disabled', true);

    fireEvent.click(picker);
    const file = new File(['test audio'], 'sample.wav', { type: 'audio/wav' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('test audio').buffer });
    fireEvent.change(screen.getByLabelText('Pick an audio file'), { target: { files: [file] } });
    await waitFor(() => expect(mocks.saveRecordedFile).toHaveBeenCalledWith(expect.objectContaining({ label: 'sample.wav' })));
    await waitFor(() => expect(picker).not.toHaveProperty('disabled', true));
    expect(screen.getByText('Allow access.')).toBeTruthy();

    grantMicrophone(testStream as unknown as MediaStream);
    await screen.findByRole('button', { name: 'Stop' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText('Recording saved.');
  });

  it('lets a person leave a microphone request that has not resolved', async () => {
    // Cancellation must release the controls even if recording-state storage stalls.
    mocks.saveRecordingState.mockImplementationOnce(() => new Promise(() => undefined));
    let grantMicrophone!: (stream: MediaStream) => void;
    vi.mocked(mediaStreamForMode).mockImplementationOnce(() => new Promise((resolve) => {
      grantMicrophone = resolve;
    }));
    render(<RecordAudioPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('Allow access.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(currentLiveRecording()).toBeNull());
    expect(screen.getByRole('button', { name: 'Start recording' })).not.toHaveProperty('disabled', true);
    expect(mocks.saveRecordedFile).not.toHaveBeenCalled();

    grantMicrophone(testStream as unknown as MediaStream);
    await waitFor(() => expect(testTrack.stopped).toBe(true));
  });

  it('places the import control before the permission card', () => {
    vi.mocked(mediaStreamForMode).mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    const panel = render(<RecordAudioPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    return screen.findByTestId('permission-card').then((permissionCard) => {
      const picker = screen.getByRole('button', { name: 'Pick an audio file' });
      expect(picker.compareDocumentPosition(permissionCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
