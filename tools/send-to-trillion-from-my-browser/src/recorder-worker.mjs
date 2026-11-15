// extension/src/recorder-worker.mjs
//
// PURPOSE
//   The background worker's side of a recording made in this browser, for each row of extension/page-tools.json
//   `recordings`: the person's voice (the microphone) or a tab with its sound. The popup (or the microphone page)
//   hands over what the person granted (a tab's stream id; the microphone needs none once allowed); this opens the
//   offscreen page (recorder.html) that records it, keeps what state the recording is in where every view can read it
//   (session storage `recording`), shows REC on the toolbar button while it runs (src/badge.mjs mark `recording`), owns the
//   account-fenced upload operations for the offscreen page, and puts the kept file in the tray when it is saved.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One recording at a time; a second start while one runs is refused in plain words (DATA).
//   2. The offscreen page never holds a token: it asks this worker to run each addressed Namespace operation.
//   3. The recording is reported as saved only after the person's files answered with its identity.
//   4. The offscreen page is closed when the recording is saved or has failed, so nothing keeps a capture open.
//   5. What is captured is the row's DATA (`capture`, getUserMedia's own constraints with { "from": "stream_id" } where
//      the granted stream goes); nothing here names a source.

import pageTools from '../page-tools.json' with { type: 'json' };
import { fillInput } from './page-tools.mjs';
import { runResourceOperation, signedInContext } from './trillion.mjs';
import { recorderUploadOperation } from './recorder-upload.mjs';
import { addToTrayOwned } from './tray.mjs';
import { keepAwake } from './keep-awake.mjs';
import { setMark } from './badge.mjs';

const OFFSCREEN = 'recorder.html';
const settings = pageTools.recording;
const rowOf = id => pageTools.recordings.find(row => row.id === id) ?? null;
const setState = value => chrome.storage.session.set({ recording: value });
const readState = async () => (await chrome.storage.session.get('recording')).recording ?? null;
let awake = null;
const runRecorderUpload = recorderUploadOperation({
  readRecording: readState, run: runResourceOperation, extensionId: chrome.runtime.id, recorderUrl: chrome.runtime.getURL(OFFSCREEN),
});

async function finish() {
  awake?.(); awake = null;
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  await setMark('recording', null);
}

const handlers = {
  async start({ row_id: rowId, stream_id: streamId = null, tab = null }) {
    const row = rowOf(rowId);
    if (!row) throw new Error(`No recording is called ${rowId}.`);
    const current = await readState();
    if (current?.state === 'recording' || current?.state === 'keeping') throw new Error(settings.busy);
    const auth_context = await signedInContext();
    if (!auth_context) throw new Error('Sign in to Trillion to save this recording.');
    await setState({ state: 'recording', row_id: row.id, tab_id: tab?.id ?? null, started_at: Date.now(), account: auth_context.account, session_id: auth_context.session_id });
    if (!(await chrome.offscreen.hasDocument())) {
      try { await chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ['USER_MEDIA'], justification: 'Records what the person chose to record.' }); }
      catch (error) { await finish(); await chrome.storage.session.remove('recording'); throw error; }
    }
    let answer;
    try {
      answer = await chrome.runtime.sendMessage({ recorder_offscreen: { start: {
        capture: fillInput(row.capture, { stream_id: streamId }), plays_back: row.plays_back, formats: row.media_types, slice_ms: settings.slice_ms,
        title: row.about_page ? (tab?.title ?? tab?.url ?? null) : row.file_title, url: row.about_page ? (tab?.url ?? null) : null, auth_context,
      } } });
    } catch (error) {
      await finish(); await chrome.storage.session.remove('recording'); throw error;
    }
    if (answer?.error) { await finish(); await chrome.storage.session.remove('recording'); throw new Error(answer.error); }
    awake = keepAwake();
    await setMark('recording', settings.badge);
    return { started: true };
  },
  stop: () => chrome.runtime.sendMessage({ recorder_offscreen: { stop: true } }),
  resource_operation: runRecorderUpload,
  async keeping() {
    await setState({ ...(await readState()), state: 'keeping' });
    return {};
  },
  async kept({ file, name, url, title, size }) {
    const current = await readState();
    const row = rowOf(current?.row_id) ?? pageTools.recordings[0];
    await addToTrayOwned({ kind: row.kind, file, name, url, title, size, made_by: row.id, account: current?.account ?? null });
    await setState({ state: 'kept', row_id: row.id });
    await finish();
    return {};
  },
  async failed({ problem, plan = null }) {
    const current = await readState();
    // A plan that does not include files is said by the plan cards, not as a failed recording.
    if (plan) { await chrome.storage.session.set({ plan_needed: { feature: plan.feature ?? null, at: Date.now() } }); await chrome.storage.session.remove('recording'); }
    else await setState({ state: 'failed', row_id: current?.row_id ?? null, problem });
    await finish();
    return {};
  },
};

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const said = message?.recording;
  if (!said || typeof said !== 'object') return false;
  const [verb] = Object.keys(said).filter(key => key in handlers);
  if (!verb) return false;
  handlers[verb](said[verb], sender).then(answer => reply(answer ?? {}), error => reply({ error: String(error?.message ?? error) }));
  return true;
});
