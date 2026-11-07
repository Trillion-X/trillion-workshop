// parts/receive-a-camera-stream/do-work/take-a-stream.mjs
//
// Purpose: the listener every destination capability shares: FFmpeg waits on this computer for one camera's RTMP
// stream on a port, and writes it out the way the capability says (pieces into a folder, or on to another address).
// When the stream ends it waits again, until the capability stops it.
//
// Non-Negotiable Invariants:
//   1. Only the camera's own key is taken. FFmpeg's listener records a stream sent with any key and only logs
//      "Unexpected stream", so that line ends the run at once and `onRefused` removes what it wrote.
//   2. The key is in the listening address FFmpeg is given, never in a log line this program writes.
//   3. A listener that stops on its own is started again after `again_seconds`; stop() ends it for good.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** The program `name` in the first folder of `searchPath` that has it, then in the computer's own PATH, or null. The folders a
 *  settings row names come first (an app started by its host may have a short PATH); a computer that keeps the program
 *  anywhere else on its PATH still has it. */
export const programIn = (searchPath, name, env = process.env) => [...searchPath, ...String(env.PATH ?? '').split(path.delimiter).filter(Boolean)]
  .map(folder => path.join(folder, name)).find(file => existsSync(file)) ?? null;

/** The address FFmpeg listens on for a camera: every network of this computer, the camera's port, app and key. */
export const listeningAddress = ({ port, app, key }) => `rtmp://0.0.0.0:${port}/${app}/${key}`;

/**
 * Keep a listener for one camera. `output` is the FFmpeg arguments after the input; `onLine(line)` gets each line
 * FFmpeg prints on standard output (a segment list), `onStarted()` once a camera is sending, `onEnded({ refused })`
 * after each run, `onRefused()` when a stream with another key was cut off. Returns { stop() }.
 */
export function takeAStream({ ffmpeg, port, app, key, output, onLine = () => {}, onStarted = () => {}, onEnded = () => {}, onRefused = async () => {}, say = () => {}, againSeconds = 1, spawnImpl = spawn }) {
  let child = null, stopped = false, timer = null;
  const run = () => {
    if (stopped) return;
    let refused = false, started = false, pending = '', problems = '';
    child = spawnImpl(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-listen', '1', '-timeout', '-1', '-i', listeningAddress({ port, app, key }), ...output], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { pending += chunk; const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) if (line.trim()) onLine(line.trim()); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      problems = (problems + chunk).slice(-2000);
      if (!refused && /Unexpected stream/.test(chunk)) { refused = true; child.kill('SIGKILL'); return; }
      if (!started && /Input #0, (flv|live_flv)/.test(chunk)) { started = true; onStarted(); }
    });
    child.on('error', error => say(`FFmpeg could not start: ${error.message}`));
    child.on('close', async code => {
      if (pending.trim()) onLine(pending.trim());
      if (refused) await onRefused();
      else if (code && !stopped && started) say(`the stream on port ${port} ended: ${problems.split('\n').filter(Boolean).slice(-2).join(' | ').replaceAll(key, '<key>')}`);
      await onEnded({ refused, started });
      child = null;
      if (!stopped) timer = setTimeout(run, againSeconds * 1000);
    });
  };
  run();
  return {
    stop() { stopped = true; clearTimeout(timer); child?.kill('SIGINT'); },
    get running() { return Boolean(child); },
  };
}
