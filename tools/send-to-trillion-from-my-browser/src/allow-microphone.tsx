// extension/src/allow-microphone.tsx
//
// PURPOSE
//   The page the popup opens the first time the person presses a recording that needs the microphone. A popup cannot
//   show the browser's microphone question, so this page (the extension's own, in a tab) asks; once allowed, the
//   extension keeps that answer, the recording starts at once (the person already pressed Record), and this page shows
//   it running with the live waveform and Stop and keep (src/recording-row.tsx). The recording itself runs in the
//   offscreen page, so closing this tab does not stop it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Built from the shared parts; words from extension/words.json (capture) and page-tools.json.
//   2. The question is asked only here; the microphone stream this page opens to ask is released at once.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from 'trillion-workshop/tools/ui/show/button/index.ts';
import { Container } from 'trillion-workshop/tools/ui/show/container/index.ts';
import { NamedIcon } from 'trillion-workshop/tools/ui/show/icon/index.ts';
import { Text } from 'trillion-workshop/tools/ui/show/text/index.ts';
import { RecordingRow, type Recording } from './recording-row.tsx';
import { paintWithWornLook } from './worn-look-page';
import pageTools from '../page-tools.json' with { type: 'json' };
import words from '../words.json' with { type: 'json' };

const asked = new URLSearchParams(location.search);
const row = pageTools.recordings.find(item => item.id === asked.get('row')) ?? null;
const tab = { id: Number(asked.get('tab')) || null, title: asked.get('title') || null, url: asked.get('url') || null };
const said = words.capture;

function AllowMicrophone() {
  const [phase, setPhase] = React.useState<'asking' | 'denied' | 'running' | 'saved'>('asking');
  const [problem, setProblem] = React.useState<string | null>(null);
  const [recording, setRecording] = React.useState<Recording | null>(null);

  const ask = React.useCallback(async () => {
    setPhase('asking'); setProblem(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      setPhase('denied');
      return;
    }
    const answer = await chrome.runtime.sendMessage({ recording: { start: { row_id: row?.id, tab } } });
    if (answer?.error) { setProblem(`${pageTools.could_not} ${answer.error}`); setPhase('denied'); return; }
    setPhase('running');
  }, []);
  React.useEffect(() => { ask(); }, [ask]);
  React.useEffect(() => {
    const show = (value: Recording | undefined) => {
      setRecording(value ?? null);
      if (value?.state === 'kept') setPhase('saved');
      if (value?.state === 'failed') { setProblem(`${pageTools.recording.failed} ${value.problem ?? ''}`.trim()); setPhase('denied'); }
    };
    chrome.storage.session.get('recording').then(stored => show(stored.recording));
    const heard = (changes: Record<string, chrome.storage.StorageChange>) => { if ('recording' in changes) show(changes.recording.newValue); };
    chrome.storage.session.onChanged.addListener(heard);
    return () => chrome.storage.session.onChanged.removeListener(heard);
  }, []);

  const running = recording && (recording.state === 'recording' || recording.state === 'keeping') ? recording : null;
  return (
    <Container layout="vertical" gap="md" padding="xl" alignItems="center" width="full" maxWidth="md">
      <NamedIcon name={phase === 'saved' ? 'CircleCheck' : phase === 'denied' ? 'MicOff' : 'Mic'} size="lg" aria-hidden="true" />
      <Text variant="title" align="center">{row?.label ?? said.microphone_heading}</Text>
      {running && row ? <RecordingRow recording={running} row={row} /> : null}
      <Text variant="body" color={phase === 'denied' ? 'error' : 'muted'} align="center">
        {problem ?? (phase === 'asking' ? said.microphone_asking : phase === 'denied' ? said.microphone_denied : phase === 'saved' ? said.microphone_saved : said.microphone_recording)}
      </Text>
      {phase === 'denied' ? <Button variant="primary" size="md" onClick={ask}>{said.microphone_try_again}</Button> : null}
      {phase === 'saved' ? <Button variant="secondary" size="md" onClick={() => window.close()}>{said.microphone_close}</Button> : null}
    </Container>
  );
}

paintWithWornLook();
document.body.classList.add('coss-ui');
const host = document.body.appendChild(document.createElement('main'));
createRoot(host).render(<AllowMicrophone />);
