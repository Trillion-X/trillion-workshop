// src/workspace/made-previews.ts
//
// PURPOSE
//   Where a file's small pictures (a still, a strip of frames, a waveform) are kept once the browser has made them:
//   beside the file in the person's namespace, as the result of kind `preview`. Files and Media read and keep them
//   through this one store, so a picture made on one screen is never made again on another.
//   A PDF's first page is drawn by the PDF page reader the workspace serves beside itself (scripts/build-workspace.mjs
//   copies it to /workspace/pdf/), named once for the whole page (pdf-reader-served.ts) and loaded only when a PDF is
//   first drawn, as a tile's cover or as its pages in the file preview.
//   A HEIC/HEIF photo (an iPhone's format) is drawn by the browser when it can, else by the HEIF decoder served at
//   /workspace/heif/, loaded only when such a photo's tile is first made; either way it is kept, so it is decoded once.
import { PREVIEW_MAKERS, documentPageMaker, heifPictureMaker, type MadePreview } from '../../parts/ui/show/media-preview';
import { readJson } from './api';
import './pdf-reader-served';
import { previewStore } from './preview-store';

// Reading and keeping a preview is preview-store.ts; screens that make them import it from here as before.
export { previewStore };

PREVIEW_MAKERS['application/pdf'] = documentPageMaker();
for (const type of ['image/heic', 'image/heif']) PREVIEW_MAKERS[type] = heifPictureMaker({ module: '/workspace/heif/libheif-bundle.mjs', largest_bytes: 64 * 1024 * 1024 }, PREVIEW_MAKERS.image);


type EnsuredPreviews = { previews: Record<string, MadePreview | null>; queued: string[] };
const PREVIEW_RESULT_WAITS_MS = [750, 1500, 3000, 5000, 8000, 12000, 15000, 15000];
const waitForPreviewRead = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const hasPreview = (value: MadePreview | null | undefined): value is MadePreview => Boolean(value && (value.poster || value.peaks || value.lines));

/** Add a file owner's remote maker without giving the shared UI an endpoint.
 * Visible videos without saved posters ask this before browser decoding.
 * Same-turn asks are deduplicated and sent in bounded groups. A terminal
 * answer is null, allowing local preview; overload and unfinished work stay
 * refusals, so they cannot trigger an original-video read. */
export function installMissingPreviewRequester(
  send: (identities: string[]) => Promise<EnsuredPreviews>,
  wait: (ms: number) => Promise<void> = waitForPreviewRead,
) {
  const pending = new Map<string, { resolve: (made: MadePreview | null) => void; reject: (error: unknown) => void }>();
  const asking = new Map<string, Promise<MadePreview | null>>();
  const completed = new Map<string, MadePreview>();
  let queued = false;
  let running = false;
  const resolve = (identity: string, waiter: { resolve: (made: MadePreview) => void }, made: MadePreview) => {
    asking.delete(identity);
    completed.set(identity, made);
    waiter.resolve(made);
  };
  const reject = (identity: string, waiter: { reject: (error: unknown) => void }, error: unknown) => {
    asking.delete(identity);
    waiter.reject(error);
  };
  const unavailable = (identity: string, waiter: { resolve: (made: MadePreview | null) => void }) => {
    asking.delete(identity);
    waiter.resolve(null);
  };
  const waitForResults = async (entries: Array<[string, { resolve: (made: MadePreview | null) => void; reject: (error: unknown) => void }]>) => {
    let remaining = entries;
    for (const ms of PREVIEW_RESULT_WAITS_MS) {
      await wait(ms);
      let answer: EnsuredPreviews;
      try {
        answer = await send(remaining.map(([identity]) => identity));
      } catch {
        // A transient refusal does not mean the task or saved result is gone.
        // The next bounded ensure call can still collect its completion.
        continue;
      }
      const queued = new Set(answer.queued ?? []);
      const next = [] as typeof remaining;
      for (const [identity, waiter] of remaining) {
        const made = answer.previews?.[identity];
        if (hasPreview(made)) resolve(identity, waiter, made);
        else if (queued.has(identity)) next.push([identity, waiter]);
        else unavailable(identity, waiter);
      }
      if (!next.length) return;
      remaining = next;
    }
    for (const [identity, waiter] of remaining) reject(identity, waiter, new Error('Preview is still being made'));
  };
  const flush = async () => {
    if (running) return;
    running = true;
    try {
      while (pending.size) {
        const batch = [...pending.entries()].slice(0, 8);
        for (const [identity] of batch) pending.delete(identity);
        try {
          const answer = await send(batch.map(([identity]) => identity));
          const waiting = new Set(answer.queued ?? []);
          const toPoll = [] as typeof batch;
          for (const [identity, waiter] of batch) {
            const made = answer.previews?.[identity];
            if (hasPreview(made)) resolve(identity, waiter, made);
            else if (waiting.has(identity)) toPoll.push([identity, waiter]);
            else unavailable(identity, waiter);
          }
          if (toPoll.length) void waitForResults(toPoll);
        } catch (error) {
          for (const [identity, waiter] of batch) reject(identity, waiter, error);
        }
      }
    } finally {
      running = false;
      if (pending.size) schedule();
    }
  };
  const schedule = () => {
    if (queued || running) return;
    queued = true;
    queueMicrotask(() => { queued = false; void flush(); });
  };
  previewStore.requestMissingPreviews = identities => Promise.all([...new Set(identities)].map(async identity => {
    const known = completed.get(identity);
    if (known) return [identity, known] as const;
    let request = asking.get(identity);
    if (!request) {
      request = new Promise<MadePreview | null>((resolve, reject) => {
        pending.set(identity, { resolve, reject });
        schedule();
      });
      asking.set(identity, request);
    }
    return [identity, await request] as const;
  })).then(entries => Object.fromEntries(entries));
}

installMissingPreviewRequester(identities => readJson<EnsuredPreviews>('/work/api/namespace/previews/ensure', {
  method: 'POST',
  body: JSON.stringify({ identities }),
}));
