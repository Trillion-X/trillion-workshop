// A pretend tool host: the functions a host hands this folder by { module, export }. Synthetic data only.
import { appendFileSync } from 'node:fs';

export function driveSync() {
  return { state: 'synced', said: 'Up to date', moving: { count: 0, bytes: 0 } };
}

export function noteWritten(path) {
  appendFileSync(process.env.WORK_ON_DRIVES_NOTES, `${path}\n`);
}
