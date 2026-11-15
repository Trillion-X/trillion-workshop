const METHODS = new Set(['write_file_start', 'write_file_piece', 'write_file_finish', 'write_file_cancel']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);

export function isRecorderOffscreenSender(sender, extensionId, recorderUrl) {
  return record(sender) && typeof extensionId === 'string' && extensionId.length > 0
    && typeof recorderUrl === 'string' && recorderUrl.length > 0
    && sender.id === extensionId && sender.url === recorderUrl;
}

function sameContext(state, context) {
  return record(state) && ['recording', 'keeping'].includes(state.state)
    && record(context) && typeof context.account === 'string' && context.account.length > 0
    && typeof context.session_id === 'string' && context.session_id.length > 0
    && state.account === context.account && state.session_id === context.session_id;
}

/** Relay one offscreen upload operation through the worker that owns account storage. */
export function recorderUploadOperation({ readRecording, run, extensionId, recorderUrl }) {
  if (typeof readRecording !== 'function' || typeof run !== 'function' || !extensionId || !recorderUrl) throw new TypeError('Recorder upload needs its state, sender and operation owners.');
  return async ({ method, input, request_key, auth_context }, sender) => {
    if (!isRecorderOffscreenSender(sender, extensionId, recorderUrl)) throw new Error('Only the recording page can upload its file.');
    if (!METHODS.has(method) || !record(input) || typeof request_key !== 'string' || !request_key
        || !sameContext(await readRecording(), auth_context)) throw new Error('The recording sign-in changed; this upload stopped.');
    const result = await run('@namespace', method, input, {
      requestKey: request_key, expectedAccount: auth_context.account, expectedSessionId: auth_context.session_id, replayTransportOnce: true,
    });
    if (!sameContext(await readRecording(), auth_context)) throw new Error('The recording sign-in changed; this upload stopped.');
    return result;
  };
}

