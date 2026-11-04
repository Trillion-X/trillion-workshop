// harness/wake-handlers/keep-every-message.mjs
//
// Purpose
//   Keeps every message of every AI chat on this computer in the person's Trillion within minutes, whether or not the
//   chat's own turn has ended or its hook ran. A chat's turn-end hook reads its transcript only when that turn ends,
//   so a message typed while a turn ran for hours reached Trillion hours late, and a hook that never ran (the computer
//   slept, the hook was cut off) left it out until that chat's next turn. Beside the wake-sessions helper (a KeepAlive
//   LaunchAgent), this runs record-every-message.mjs --sweep at start and every `sweep.every_seconds`, which reads each
//   chat that holds rows past its cursor.
//
// Non-negotiable invariants
//   1. It takes no events (wants is always false); it only runs the recorder's own sweep, so which rows are the
//      person's words stays in record-every-message.json and nowhere here.
//   2. The sweep runs as its own process, one at a time: a slow pass never holds the helper's connection, and a pass
//      still running when the next one is due is left to finish (the next starts after it). Across processes the recorder's
//      own `sweep.lock` keeps it to one sweep on the computer, whoever started it.
//   3. The recorder reads each chat under its drain lock and Trillion keeps a resent message once, so a sweep that
//      meets a turn-end hook or another sweep on the same chat keeps nothing twice.
//
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'record-every-message.mjs');
const everySeconds = () => JSON.parse(readFileSync(join(dirname(RECORDER), 'record-every-message.json'), 'utf8')).sweep?.every_seconds ?? 180;

/** Runs one sweep now unless one is still running; resolves when it ends. */
export function sweeper({ spawnChild = spawn, recorder = RECORDER, log = () => {} } = {}) {
  let running = null;
  return () => {
    if (running) return running;
    running = new Promise(done => {
      let child;
      try { child = spawnChild(process.execPath, [recorder, '--sweep'], { stdio: 'ignore' }); }
      catch (error) { log(`keep-every-message: the sweep did not start: ${error.message}`); done(false); return; }
      child.once('error', error => { log(`keep-every-message: the sweep did not start: ${error.message}`); done(false); });
      child.once('exit', code => done(code === 0));
    }).finally(() => { running = null; });
    return running;
  };
}

export const wants = () => false;
export const handle = () => null;
export const start = ({ log = () => {} } = {}) => {
  const sweep = sweeper({ log });
  sweep();
  return setInterval(sweep, everySeconds() * 1000);
};
