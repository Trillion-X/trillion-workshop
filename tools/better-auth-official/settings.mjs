// The settings every part of this tool reads: settings.json, or the file BETTER_AUTH_SETTINGS names.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readSettings() {
  const path = resolve(process.env.BETTER_AUTH_SETTINGS ?? new URL('./settings.json', import.meta.url).pathname);
  return { settings: JSON.parse(readFileSync(path, 'utf8')) };
}
