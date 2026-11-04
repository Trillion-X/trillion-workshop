// tools/drive-the-screen/read-data/capture-shield.mjs (moved from Trillion-X/trillion computer/capture-shield.mjs)
//
// Purpose
//   Brackets a screen capture Trillion takes of the screen with the two Darwin notifications the Mac app listens for
//   (CaptureShield.swift in the Mac app), so the app's own windows are left out of that picture. The names are DATA
//   (./capture-shield.json); the end is posted whether the capture worked or not.
//
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const shieldNames = () => { const { begin, end } = JSON.parse(readFileSync(fileURLToPath(new URL('./capture-shield.json', import.meta.url)), 'utf8')); return { begin, end }; };
const post = name => new Promise(done => execFile('/usr/bin/notifyutil', ['-p', name], () => done()));

/** Runs `capture()` between the begin and end notifications; the end is posted even when the capture throws. */
export async function withShield(capture, { names = shieldNames(), send = post } = {}) {
  await send(names.begin);
  try { return await capture(); } finally { await send(names.end); }
}
