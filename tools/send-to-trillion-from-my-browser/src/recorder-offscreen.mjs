// extension/src/recorder-offscreen.mjs
//
// PURPOSE
//   The offscreen page (recorder.html) that records: it opens the capture the background worker describes (getUserMedia
//   constraints from a page-tools.json `recordings` row: the microphone, or a tab from the stream id the popup was
//   granted), plays the sound on when the row says so (a captured tab goes quiet for the person otherwise; a
//   microphone is never played back), records with the browser's MediaRecorder in the first format this browser makes
//   from the row's list, and when the person stops (or the capture ends) keeps the file in their files through
//   addressed Namespace operations, the same way the popup keeps a picture of the page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This page holds no token. Each generic Namespace operation is executed by the background account owner.
//   2. Every piece the recorder hands over is kept until the file is sent; nothing is written anywhere else first.
//   3. The capture is always released (every track stopped, the sound closed), whether the save works or not.
//
// This page only has chrome.runtime (offscreen pages get no other extension API), so it talks to the worker by message.

import { fileKeeper, sentFileName } from './trillion.mjs';
import { recordingFormat } from './page-tools.mjs';

const tell = message => chrome.runtime.sendMessage({ recording: message });
const keep = fileKeeper({ operation: async (method, input, { context, requestKey }) => {
  const answer = await tell({ resource_operation: { method, input, request_key: requestKey, auth_context: context } });
  if (answer?.error) throw new Error(answer.error);
  if (!answer || typeof answer !== 'object' || !answer.result || typeof answer.result !== 'object') throw new Error('The account did not confirm this file upload.');
  return answer.result;
} });

let recorder = null;

async function start({ capture, plays_back: playsBack, formats, slice_ms: sliceMs, title, url, auth_context: authContext }) {
  if (!authContext || typeof authContext.account !== 'string' || !authContext.account
      || typeof authContext.session_id !== 'string' || !authContext.session_id) throw new Error('Sign in to Trillion to save this recording.');
  const format = recordingFormat(formats, type => MediaRecorder.isTypeSupported(type));
  if (!format) throw new Error('This browser cannot make this kind of recording.');
  const stream = await navigator.mediaDevices.getUserMedia(capture);
  const sound = playsBack ? new AudioContext() : null;
  sound?.createMediaStreamSource(stream).connect(sound.destination);
  const pieces = [];
  recorder = new MediaRecorder(stream, { mimeType: format.media_type });
  recorder.ondataavailable = event => { if (event.data.size) pieces.push(event.data); };
  recorder.onstop = async () => {
    recorder = null;
    for (const track of stream.getTracks()) track.stop();
    await sound?.close();
    await tell({ keeping: true });
    try {
      const mediaType = format.media_type.split(';')[0];
      const name = sentFileName(title ?? url, format.extension);
      const blob = new Blob(pieces, { type: mediaType });
      const file = await keep({ blob, name, mediaType, context: authContext });
      await tell({ kept: { file, name, url, title, size: blob.size } });
    } catch (error) {
      await tell({ failed: { problem: String(error?.message ?? error), plan: error?.name === 'PlanNeeded' ? { feature: error.feature ?? null } : null } });
    }
  };
  // Closing or leaving a captured tab, or unplugging the microphone, ends the capture; what was recorded is kept.
  for (const track of stream.getTracks()) track.addEventListener('ended', () => recorder?.state === 'recording' && recorder.stop());
  recorder.start(sliceMs);
  return { started: true };
}

function stop() {
  if (recorder?.state === 'recording') recorder.stop();
  return { stopping: true };
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  const said = message?.recorder_offscreen;
  if (!said) return false;
  Promise.resolve(said.start ? start(said.start) : stop()).then(reply, error => reply({ error: String(error?.message ?? error) }));
  return true;
});
