// extension/src/add-to-it.tsx
//
// PURPOSE
//   "Add to it" in the Send to Trillion popup: small capture buttons, one per row of extension/page-tools.json, made
//   in this browser (`recordings`: the person's voice, this tab with its sound) or on Trillion's compute (`tools`: the
//   whole page's text and links, a video of the page), and files from this computer (`files`, chosen in their own
//   window, extension/src/attach.tsx). Pressing one starts it; what it makes shows in the popup's
//   Sending list (a working row, then the kept file with its size) and goes with the next Send.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Built from the shared parts (parts/ui): the tiles are the shared Add to it grid Your tray also shows; no control
//      is hand-made here.
//   2. The rows and their words are DATA; nothing here names a tool, a site or a source. What a recording needs from
//      the person before it can start is its row's `grant`, and each grant is one entry of `grants` below.
//   3. Recordings and page tools run in the background worker (src/recorder-worker.mjs, src/page-tool-runs.mjs), so
//      closing the popup never stops them; this view only starts them and shows their state.

import React from 'react';
import { AddToIt as AddWays } from 'trillion-workshop/tools/ui/show/add-to-it/index.ts';
import { Container } from 'trillion-workshop/tools/ui/show/container/index.ts';
import { RecordingRow, type Recording } from './recording-row.tsx';
import { reloadIfUpdated } from './loaded-current.mjs';
import pageTools from '../page-tools.json' with { type: 'json' };
import words from '../words.json' with { type: 'json' };

type Page = { url: string; title?: string | null };
type Tab = { id: number; title: string | null; url: string };

// What each kind of recording needs from the person before it starts: the fields it adds to the start message, or null
// when it opened a page to ask and that page starts the recording once allowed.
const grants: Record<string, (tab: Tab, rowId: string) => Promise<Record<string, unknown> | null>> = {
  async tab(tab) {
    if (!chrome.tabCapture) {
      if (await reloadIfUpdated()) throw new Error(words.capture.tab_unavailable);
      return null;
    }
    return { stream_id: await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }) };
  },
  // A popup cannot show the browser's microphone question, so the first time it opens the extension's own page to ask.
  async microphone(tab, rowId) {
    const state = await navigator.permissions.query({ name: 'microphone' as PermissionName }).then(answer => answer.state, () => 'prompt');
    if (state === 'granted') return {};
    const at = new URL(chrome.runtime.getURL(pageTools.recording.microphone_page));
    for (const [key, value] of Object.entries({ row: rowId, tab: String(tab.id), title: tab.title ?? '', url: tab.url })) at.searchParams.set(key, value);
    await chrome.tabs.create({ url: at.href });
    return null;
  },
};

export function AddToIt({ tab, page, recording, working, onProblem }: {
  tab: Tab | null; page: Page | null; recording: Recording | null; working: string[];
  onProblem: (words: string | null) => void;
}) {
  const [starting, setStarting] = React.useState<string | null>(null);
  const running = recording && (recording.state === 'recording' || recording.state === 'keeping') ? recording : null;
  const runningRow = running ? pageTools.recordings.find(row => row.id === running.row_id) ?? null : null;

  async function record(rowId: string, grant: string) {
    if (!tab) return;
    onProblem(null); setStarting(rowId);
    try {
      const granted = await grants[grant](tab, rowId);
      if (!granted) return;
      const answer = await chrome.runtime.sendMessage({ recording: { start: { row_id: rowId, ...granted, tab } } });
      if (answer?.error) throw new Error(answer.error);
    } catch (error) {
      onProblem(`${pageTools.could_not} ${(error as Error).message}`);
    } finally {
      setStarting(null);
    }
  }

  async function runTool(rowId: string) {
    if (!page) return;
    onProblem(null);
    const answer = await chrome.runtime.sendMessage({ page_run: { start: { row_id: rowId, page: { url: page.url, title: page.title ?? null } } } });
    if (answer?.error) onProblem(`${pageTools.could_not} ${answer.error}`);
  }

  // Files from this computer are chosen in their own window: a browser closes the popup when its file chooser opens.
  async function attachFiles() {
    const row = pageTools.files;
    await chrome.windows.create({ url: chrome.runtime.getURL(row.page), type: 'popup', width: row.width, height: row.height });
  }

  return (
    <Container layout="vertical" gap="sm" width="full">
      {running && runningRow ? <RecordingRow recording={running} row={runningRow} /> : null}
      {/* The shared Add to it grid (parts/ui/show/add-to-it), the same one Your tray shows. */}
      <AddWays
        label={words.sections.add_to_it}
        ways={[
          ...pageTools.recordings.map(row => ({ id: row.id, label: row.label, icon: row.icon, detail: row.detail, busy: starting === row.id, disabled: !tab || Boolean(running) || starting !== null })),
          ...pageTools.tools.map(row => ({ id: row.id, label: row.label, icon: row.icon, detail: row.detail, busy: working.includes(row.id), disabled: !page || working.includes(row.id) })),
          { id: pageTools.files.id, label: pageTools.files.label, icon: pageTools.files.icon, detail: pageTools.files.detail },
        ]}
        onPress={id => {
          if (id === pageTools.files.id) { void attachFiles(); return; }
          const recording = pageTools.recordings.find(row => row.id === id);
          if (recording) void record(recording.id, recording.grant); else void runTool(id);
        }}
      />
    </Container>
  );
}
