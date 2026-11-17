// extension/src/recording-row.tsx
//
// PURPOSE
//   What a running recording looks like wherever it shows (the popup's Add to it section, the microphone page): its
//   words, the time it has run, Stop and keep, and, for a row that shows a waveform (the person's voice), the shared
//   live waveform (tools/ui LiveWaveform, the bars that fade out at both ends) drawn from the microphone while this
//   view is open. The recording itself runs in the offscreen page (src/recorder-offscreen.mjs); this only shows it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Built from the shared parts (tools/ui); words from extension/page-tools.json.
//   2. The waveform's own microphone stream is this view's, released when the view closes or the recording stops;
//      it never records anything.

import React from 'react';
import { Button } from 'trillion-workshop/tools/ui/show/button/index.ts';
import { Container } from 'trillion-workshop/tools/ui/show/container/index.ts';
import { formatElapsed } from 'trillion-workshop/tools/ui/show/capture-control/CaptureControl.tsx';
import { LiveWaveform } from 'trillion-workshop/tools/ui/show/live-waveform/index.ts';
import { NamedIcon } from 'trillion-workshop/tools/ui/show/icon/index.ts';
import { Text } from 'trillion-workshop/tools/ui/show/text/index.ts';
import pageTools from '../page-tools.json' with { type: 'json' };

export type Recording = { state: 'recording' | 'keeping' | 'kept' | 'failed'; row_id?: string; started_at?: number; problem?: string; tab_id?: number };
export type RecordingRowData = (typeof pageTools.recordings)[number];

const words = pageTools.recording;

/** The microphone as a stream while `on`, for drawing only; null until the browser hands it over. */
function useMicrophone(on: boolean) {
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  React.useEffect(() => {
    if (!on) return undefined;
    let current: MediaStream | null = null;
    let closed = false;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(opened => {
      if (closed) { for (const track of opened.getTracks()) track.stop(); return; }
      current = opened; setStream(opened);
    }).catch(() => {});
    return () => { closed = true; for (const track of current?.getTracks() ?? []) track.stop(); setStream(null); };
  }, [on]);
  return stream;
}

export function RecordingRow({ recording, row }: { recording: Recording; row: RecordingRowData }) {
  const [now, setNow] = React.useState(Date.now());
  const running = recording.state === 'recording';
  React.useEffect(() => {
    if (!running) return undefined;
    const ticking = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(ticking);
  }, [running]);
  const stream = useMicrophone(running && row.shows_waveform);
  const stop = () => chrome.runtime.sendMessage({ recording: { stop: true } });
  return (
    <Container layout="vertical" gap="xs" padding="sm" rounded="lg" border="all" width="full">
      <Container layout="horizontal" gap="sm" alignItems="center" width="full">
        <NamedIcon name={running ? 'CircleDot' : 'Loader'} size="sm" color={running ? 'error' : undefined} aria-hidden="true" />
        <Container layout="vertical" gap="none" className="min-w-0 flex-1">
          <Text variant="body-xs" weight="medium">{running ? row.recording : words.keeping}</Text>
          {running ? <Text variant="caption" color="muted">{formatElapsed(now - (recording.started_at ?? now))}</Text> : null}
        </Container>
        <Button variant="primary" size="sm" loading={!running} disabled={!running} onClick={stop}>{words.stop}</Button>
      </Container>
      {row.shows_waveform ? <LiveWaveform stream={stream} active={running} processing={!running} frame="flat" edgeFade aria-label={row.recording} className="h-14 min-h-14" /> : null}
    </Container>
  );
}
