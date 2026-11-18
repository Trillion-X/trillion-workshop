import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { endNativeSystemAudioTrack, excludedApps, listenToNativeSystemAudio, nativeStartMessage } from 'trillion-workshop/tools/record-voice-and-meetings/show/native-system-audio-session.mjs';
import { importSource } from 'trillion-workshop/test-helpers/import-source-for-tests.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const readOwner = specifier => readFileSync(fileURLToPath(import.meta.resolve(specifier)), 'utf8');
const captureSources = JSON.parse(readOwner('trillion-workshop/tools/record-audio/read-data/capture-sources.json'));
const recordingChoices = JSON.parse(readOwner('trillion-workshop/tools/workspace-screens/web/src/workspace/recording.json')).sources;
const recorder = readOwner('trillion-workshop/tools/record-audio/show/record-in-the-browser.ts');

test('meeting audio is a Mac-only DATA source and appears in Record choices', () => {
  const source = captureSources.sources.find(row => row.id === 'meeting-audio');
  assert.deepEqual(
    { ask: source?.ask, device: source?.device, preview: source?.preview, check_quiet: source?.check_quiet },
    { ask: 'native-system-audio', device: 'system audio and microphone', preview: 'waveform', check_quiet: true },
  );
  assert.equal(recordingChoices.some(row => row.id === 'meeting-audio'), true);
  assert.match(captureSources.problems['system-audio-permission'], /System Settings/);
  assert.match(captureSources.problems['system-audio-in-use'], /another Trillion window/);
  assert.match(captureSources.problems['system-audio-ended'], /What was recorded is kept/);
});

test('native events are session-scoped and detached listeners cannot receive late chunks', () => {
  const target = new EventTarget();
  const received = [];
  const stop = listenToNativeSystemAudio(target, 'session-b', {
    audio: chunk => received.push(`audio:${chunk.pcm16}`),
    started: () => received.push('started'),
    failure: error => received.push(`failure:${error.kind}`),
  });
  const send = detail => {
    const event = new Event('trillion-native-system-audio');
    event.detail = detail;
    target.dispatchEvent(event);
  };

  send({ session_id: 'session-a', event: 'audio', pcm16: 'stale' });
  send({ session_id: 'session-b', event: 'started' });
  send({ session_id: 'session-b', event: 'audio', pcm16: 'current' });
  send({ session_id: 'session-b', event: 'error', kind: 'system-audio-ended' });
  stop();
  send({ session_id: 'session-b', event: 'audio', pcm16: 'late' });

  assert.deepEqual(received, ['started', 'audio:current', 'failure:system-audio-ended']);
});

test('aborting while the post-start policy read is pending promptly closes the native opener', { timeout: 5000 }, async () => {
  const entry = fileURLToPath(import.meta.resolve('trillion-workshop/tools/record-audio/show/record-in-the-browser.ts'));
  const bundled = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    logLevel: 'silent',
    plugins: [{ name: 'fake-microphone-only', setup(builder) {
      builder.onResolve({ filter: /^\.\/browser-media-capture$/ }, args => {
        if (!args.importer.endsWith('/tools/record-audio/show/record-in-the-browser.ts')) return;
        return { path: 'browser-media-capture-fixture', namespace: 'meeting-audio-test' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'meeting-audio-test' }, () => ({
        contents: 'export async function mediaStreamForMode() { return globalThis.__nativeMeetingAudioFixture.microphone; }',
        loader: 'js',
      }));
    } }],
  });
  const { openSource, captureSource, RecordingProblem } = await importSource(bundled.outputFiles[0].text);
  const names = ['window', 'navigator', 'MediaRecorder', 'AudioContext', '__nativeMeetingAudioFixture'];
  const originalDescriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const controller = new AbortController();
  const originalSignalAdd = Object.getOwnPropertyDescriptor(controller.signal, 'addEventListener');
  const originalSignalRemove = Object.getOwnPropertyDescriptor(controller.signal, 'removeEventListener');
  let signalListeners = 0;
  let resolveLatePolicy;
  let nativeStarted = false;
  let microphoneStops = 0;
  let destinationStops = 0;
  let contextCloses = 0;
  let nativeStarts = 0;
  let nativeStops = 0;
  const abortHandlers = new Set();
  const windowListeners = new Map();
  const activeTimers = new Set();

  const microphoneTrack = new EventTarget();
  microphoneTrack.kind = 'audio';
  microphoneTrack.readyState = 'live';
  microphoneTrack.stop = () => { microphoneStops += 1; microphoneTrack.readyState = 'ended'; };
  const microphone = { getTracks: () => [microphoneTrack], getAudioTracks: () => [microphoneTrack] };
  const destinationTrack = new EventTarget();
  destinationTrack.kind = 'audio';
  destinationTrack.readyState = 'live';
  destinationTrack.stop = () => { destinationStops += 1; destinationTrack.readyState = 'ended'; };
  const destinationStream = { getAudioTracks: () => [destinationTrack], getTracks: () => [destinationTrack] };
  const contexts = [];
  class FakeAudioContext {
    constructor() { this.currentTime = 0; contexts.push(this); }
    createMediaStreamDestination() { return { stream: destinationStream }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    close() { contextCloses += 1; return Promise.resolve(); }
  }
  class FakeWindow extends EventTarget {
    constructor() { super(); this.webkit = { messageHandlers: { trillionSystemAudio: {
      postMessage: message => {
        if (message.command === 'system-audio-start') {
          nativeStarts += 1;
          const sessionId = message.session_id;
          queueMicrotask(() => {
            const event = new Event('trillion-native-system-audio');
            Object.defineProperty(event, 'detail', { value: { session_id: sessionId, event: 'started' } });
            nativeStarted = true;
            this.dispatchEvent(event);
          });
        }
        if (message.command === 'system-audio-stop' || message.command === 'system-audio-cancel') nativeStops += 1;
      },
    } } }; }
    addEventListener(type, listener, options) {
      if (type === 'trillion-native-system-audio') {
        const listeners = windowListeners.get(type) ?? new Set();
        listeners.add(listener); windowListeners.set(type, listeners);
      }
      return super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
      if (type === 'trillion-native-system-audio') windowListeners.get(type)?.delete(listener);
      return super.removeEventListener(type, listener, options);
    }
    setTimeout(callback, delay, ...args) {
      let timer;
      timer = realSetTimeout(() => { activeTimers.delete(timer); callback(...args); }, delay);
      activeTimers.add(timer);
      return timer;
    }
    clearTimeout(timer) { activeTimers.delete(timer); realClearTimeout(timer); }
  }
  const fakeWindow = new FakeWindow();
  Object.defineProperty(globalThis, '__nativeMeetingAudioFixture', { configurable: true, writable: true, value: { microphone } });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { mediaDevices: { getUserMedia: async () => microphone } } });
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, writable: true, value: class FakeMediaRecorder {} });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: FakeAudioContext });
  Object.defineProperty(controller.signal, 'addEventListener', { configurable: true, value: function(type, listener, options) {
    if (type === 'abort') { abortHandlers.add(listener); signalListeners = abortHandlers.size; }
    return EventTarget.prototype.addEventListener.call(this, type, listener, options);
  } });
  Object.defineProperty(controller.signal, 'removeEventListener', { configurable: true, value: function(type, listener, options) {
    if (type === 'abort') { abortHandlers.delete(listener); signalListeners = abortHandlers.size; }
    return EventTarget.prototype.removeEventListener.call(this, type, listener, options);
  } });

  try {
    let pendingReached;
    const pendingPolicyRead = new Promise(resolve => { pendingReached = resolve; });
    const current = () => {
      if (nativeStarted && !resolveLatePolicy) {
        pendingReached();
        return new Promise(resolve => { resolveLatePolicy = resolve; });
      }
      return true;
    };
    const opening = openSource(captureSource('meeting-audio'), undefined, current, controller.signal);
    const outcome = opening.then(value => ({ state: 'resolved', value }), error => ({ state: 'rejected', error }));
    await pendingPolicyRead;
    assert.equal(nativeStarts, 1, 'the native opener reached its started event before the pending policy read');
    assert.equal(typeof resolveLatePolicy, 'function', 'the fresh policy read is still pending');
    assert.equal(signalListeners, 2, 'the in-progress opener and pending owner read each listen for abort');

    controller.abort();
    let promptTimer;
    const result = await Promise.race([
      outcome,
      new Promise(resolve => { promptTimer = realSetTimeout(() => resolve({ state: 'timeout' }), 250); }),
    ]);
    if (promptTimer) realClearTimeout(promptTimer);
    assert.equal(result.state, 'rejected', 'abort rejects the openSource operation without awaiting the policy owner');
    assert.ok(result.error instanceof RecordingProblem);
    assert.equal(result.error.kind, 'AbortError');
    assert.equal(nativeStops, 1, 'the native session is stopped promptly');
    assert.equal(microphoneStops, 1, 'the selected microphone is released');
    assert.equal(destinationStops, 1, 'the mixed destination track is released');
    assert.equal(contextCloses, 1, 'the mixing context is closed');
    assert.equal(contexts.length, 1);
    assert.equal(windowListeners.get('trillion-native-system-audio')?.size ?? 0, 0, 'the native event listener is removed');
    assert.equal(signalListeners, 0, 'the abort listener is removed');
    assert.equal(activeTimers.size, 0, 'the native start timeout is cleared');

    resolveLatePolicy(true);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(nativeStarts, 1, 'the late policy result does not restart native capture');
    assert.equal(nativeStops, 1, 'the late policy result does not create another native session');
    assert.equal(signalListeners, 0, 'the late policy completion leaves no abort listeners behind');
    assert.equal(activeTimers.size, 0, 'late policy completion leaves no native timeout behind');
  } finally {
    controller.abort();
    if (resolveLatePolicy) resolveLatePolicy(true);
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    if (originalSignalAdd) Object.defineProperty(controller.signal, 'addEventListener', originalSignalAdd);
    else delete controller.signal.addEventListener;
    if (originalSignalRemove) Object.defineProperty(controller.signal, 'removeEventListener', originalSignalRemove);
    else delete controller.signal.removeEventListener;
    for (const timer of activeTimers) realClearTimeout(timer);
    activeTimers.clear();
  }
});

test('native capture loss reaches the shared recorder ended path and releases the mixed track', () => {
  let stopCount = 0;
  let recorderEndCount = 0;
  const track = new EventTarget();
  track.stop = () => { stopCount += 1; };
  track.addEventListener('ended', () => { recorderEndCount += 1; });

  endNativeSystemAudioTrack(track);

  assert.equal(recorderEndCount, 1, 'the shared recorder gets its normal source-ended signal');
  assert.equal(stopCount, 1, 'the destination audio track is released after notifying the recorder');
});

test('ScreenCaptureKit feeds the shared recorder and serializes per-session conversion', () => {
  assert.match(recorder, /listenToNativeSystemAudio\(window, sessionID/);
  assert.match(recorder, /endNativeSystemAudioTrack/);
  assert.match(recorder, /'native-system-audio': \{ available: \(\) => canAskUser\(\) && nativeSystemAudioBridge\(\) !== null/);
  assert.match(recorder, /feedMicrophone\(context, destination, mic,/);
  assert.match(recorder, /createMediaStreamSource\(opened\)/);
  assert.match(recorder, /createMediaStreamDestination\(\)/);
  assert.match(recorder, /new MediaRecorder\(stream, options\)/);
});

test('the applications left out of meeting audio are editable DATA, empty by default, and reach the native start', () => {
  const source = captureSources.sources.find(row => row.ask === 'native-system-audio');
  assert.deepEqual(source.exclude_apps, []);
  assert.deepEqual(nativeStartMessage('s1', source), { command: 'system-audio-start', session_id: 's1', exclude_apps: [] });
  const edited = { exclude_apps: ['com.1password.1password', 'com.1password.1password', ' padded', '', 7, 'bad\u0000id', 'com.apple.Music'] };
  assert.deepEqual(excludedApps(edited), ['com.1password.1password', 'com.apple.Music']);
  assert.deepEqual(excludedApps(undefined), []);
});
