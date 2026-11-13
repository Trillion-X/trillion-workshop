// src/workspace/file-uses.ts
//
// PURPOSE
//   The page's half of the Recent screen: it tells the person's store (POST /work/api/recent-files, src/recent-files.mjs)
//   that one of their files was used, and counts how long a recording really played so "watched" is said only after it
//   played for recent-files.json watched_seconds. The one-file screen (file-screen.tsx) reports each file it opens and
//   plays; the Recent screen (recent-screen.tsx) reads the list back.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The page says only which file and what happened; the store stamps the time and checks the file is the person's.
//   2. What happened is an open set of words (recent-files.json kind_pattern); nothing here lists them.
//   3. Keeping a use never gets in the way of what the person is doing: a refusal is dropped, never shown.
//   4. Only real playing counts (played-time.ts): time moved by seeking, or while paused, is not played time.
//   5. A screen drawn again is not a new use: the same file and word within recent-files.json repeat_minutes of the
//      last one this page sent is not sent again (a kept tab redrawing would otherwise put "opened" over "watched").

import settings from '../recent-files.json';
import { postJson } from './api';
import { afterPlaying } from './played-time';
import { keptAccount } from '../../parts/ui/show/page-storage/page-storage';

// Successfully recorded uses: kept for the tab's life, so a restored tab is not a new use.
const SENT_KEY = 'trillion-file-uses-sent';
const readSent = (): Record<string, number> => { try { return JSON.parse(sessionStorage.getItem(SENT_KEY) ?? '{}'); } catch { return {}; } };
// A use is pending only while this page is asking the store. It becomes a dedupe stamp only after the store accepts it.
// Sharing the promise also keeps two redraws during one request from sending duplicate writes.
const pending = new Map<string, Promise<unknown>>();

/** Keeps that `file` (its identity or path name) was used as `kind`. */
export function keepFileUse(file: string, kind: string, now = Date.now()): Promise<unknown> {
  if (!file) return Promise.resolve(null);
  // These device-local stamps describe one person's reporting, so a later sign-in on the same tab starts fresh.
  const key = `${keptAccount()?.store ?? 'signed-out'} ${kind} ${file}`;
  const sent = readSent();
  if (now - (sent[key] ?? -Infinity) < settings.repeat_minutes * 60_000) return Promise.resolve(null);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = postJson('/work/api/recent-files', { file, kind }).then(value => {
    const span = settings.repeat_minutes * 60_000;
    try { sessionStorage.setItem(SENT_KEY, JSON.stringify(Object.fromEntries([...Object.entries(readSent()).filter(([, at]) => now - at < span), [key, now]]))); } catch { /* storage full or off: send anyway */ }
    return value;
  }).catch(() => null).finally(() => { pending.delete(key); });
  pending.set(key, request);
  return request;
}

/** Calls `watched` once, after any audio or video inside `host` really played for recent-files.json watched_seconds. */
export const whenWatched = (host: EventTarget, watched: () => void): (() => void) => afterPlaying(host, settings.watched_seconds, watched);
