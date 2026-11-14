// src/workspace/preview-store.ts
//
// PURPOSE
//   Where a file's small pictures (a still, a strip of frames, a waveform) are kept once the browser has made them:
//   beside the file in the person's namespace, as the result of kind `preview`. Reading and keeping them needs none of
//   the code that makes them (made-previews.ts, which a screen drawing previews imports), so a file card on the first
//   screen reads a kept poster without the page loading the preview makers.
import type { MadePreviewStore } from '../../parts/ui/show/media-preview';
import { fileResults } from './api';
type PendingPreviewRead = { resolve: (value: any) => void; reject: (reason: unknown) => void };

// The result owner allows four open reads per caller. A gallery can ask for
// dozens of posters in one React commit, so one GET per tile turns a stored
// result into a 429 and makes the generic preview maker decode the original.
// Coalesce the same-turn reads into the owner’s existing many route instead.
const pendingPreviewReads = new Map<string, PendingPreviewRead[]>();
let previewReadFlushQueued = false;
let previewReadFlushRunning = false;

function schedulePreviewReadFlush() {
  if (previewReadFlushQueued || previewReadFlushRunning) return;
  previewReadFlushQueued = true;
  queueMicrotask(() => {
    previewReadFlushQueued = false;
    void flushPreviewReads();
  });
}

async function flushPreviewReads() {
  if (previewReadFlushRunning) return;
  previewReadFlushRunning = true;
  try {
    while (pendingPreviewReads.size) {
      const batch = [...pendingPreviewReads.entries()].slice(0, 1000);
      for (const [identity] of batch) pendingPreviewReads.delete(identity);
      try {
        const answer = await fileResults.many<{ results: Record<string, any> }>('preview', batch.map(([identity]) => identity));
        for (const [identity, waiters] of batch) {
          const value = answer.results?.[identity] ?? null;
          for (const waiter of waiters) waiter.resolve(value);
        }
      } catch (error) {
        // Preserve the refusal. `null` means the result is genuinely absent;
        // a transient 429/5xx must not trigger a browser decode of the source.
        for (const [, waiters] of batch) for (const waiter of waiters) waiter.reject(error);
      }
    }
  } finally {
    previewReadFlushRunning = false;
    if (pendingPreviewReads.size) schedulePreviewReadFlush();
  }
}

function readPreview(identity: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const waiters = pendingPreviewReads.get(identity) ?? [];
    waiters.push({ resolve, reject });
    pendingPreviewReads.set(identity, waiters);
    schedulePreviewReadFlush();
  });
}

export const previewStore: MadePreviewStore = {
  read: readPreview,
  keep: (identity, made) => fileResults.record([{ identity, kind: 'preview', value: made, produced_by: 'trillion files' }]).then(() => undefined),
};
