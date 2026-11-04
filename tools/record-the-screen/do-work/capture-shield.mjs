// tools/record-the-screen/do-work/capture-shield.mjs
//
// Purpose
//   Brackets a screen capture Trillion takes of the screen with the two Darwin notifications the Mac app listens for
//   (macos/App/CaptureShield.swift), so the app's own windows are left out of that picture. The names are DATA
//   (read-data/capture-session.json `capture_shield`); the end is posted whether the capture worked or not.
//
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const shieldNames = () => JSON.parse(readFileSync(fileURLToPath(new URL('../read-data/capture-session.json', import.meta.url)), 'utf8')).capture_shield;
const post = name => new Promise(done => execFile('/usr/bin/notifyutil', ['-p', name], () => done()));

/** Runs `capture()` between the begin and end notifications; the end is posted even when the capture throws. */
export async function withShield(capture, { names = shieldNames(), send = post } = {}) {
  await send(names.begin);
  try { return await capture(); } finally { await send(names.end); }
}
