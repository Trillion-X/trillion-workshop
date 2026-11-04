// Generic, demand-bound server previews for files already in a person's namespace.
//
// The namespace owns the content identity and the existing `preview` result. This
// helper only coordinates a visible batch: it reuses a kept MadePreview, starts
// one deterministic Workshop cover-frame run for a stored video with no drawable
// result, and turns the finished JPEG into the same MadePreview shape the browser
// maker stores. It never scans a person's files and never sends the original file
// to the browser.
import filePreviewSettings from './workspace/file-previews.json' with { type: 'json' };

export const CONTENT_IDENTITY = /^(1f|12):[0-9a-f]{64}$/;
export const MAX_VISIBLE_PREVIEWS = 8;
export const scoredCoverRequestKey = (identity, attempt = 0) =>
  `namespace-preview:scored-cover:${identity}${attempt > 0 ? `:retry:${attempt}` : ''}`;
export function scoredCoverAttempt(identity, requestKey) {
  if (!CONTENT_IDENTITY.test(identity ?? '')) return null;
  const base = scoredCoverRequestKey(identity);
  if (requestKey === base) return 0;
  if (typeof requestKey !== 'string' || !requestKey.startsWith(base)) return null;
  const match = /^:retry:([1-9][0-9]*)$/.exec(requestKey.slice(base.length));
  const attempt = Number(match?.[1]);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : null;
}
// A cover run keeps its JPEG as a Workshop file so the preview saver can read
// it. Once the poster is saved under the video, remove only that internal
// output name; the picture's bytes and task result remain reachable by ID.
export function unnameMadeCover(namespace, picture) {
  if (!CONTENT_IDENTITY.test(picture?.identity ?? '') || typeof picture?.name !== 'string'
    || !picture.name.startsWith('/Made by tools/')) return false;
  const named = namespace.entry(picture.name);
  if (named?.folder || named?.identity !== picture.identity) return false;
  namespace.putNames([{ name: picture.name, remove: true }]);
  return true;
}
// The stored result is limited to 1.5 MB, and base64 expands JPEG bytes by a third.
const IMAGE_BYTES_LIMIT = 1_100_000;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const drawable = value => object(value) && (typeof value.poster === 'string' && value.poster.length > 0
  || object(value.frames) && typeof value.frames.source === 'string' && value.frames.source.length > 0
  || Array.isArray(value.peaks) && value.peaks.length > 0
  || typeof value.lines === 'string' && value.lines.length > 0);
const canonicalType = value => String(value ?? '').split(';', 1)[0].trim().toLowerCase();
const videoFile = row => {
  const type = canonicalType(row.media_type);
  if (type.startsWith('video/')) return true;
  if (type && type !== 'application/octet-stream') return false;
  return (row.names ?? []).some(name => {
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    return filePreviewSettings.families_by_extension[extension] === 'video';
  });
};

function base64(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

async function posterFromPicture(picture, open) {
  if (!object(picture) || !CONTENT_IDENTITY.test(picture.identity ?? '')) return null;
  const file = await open(picture.identity);
  if (!file?.stream || typeof file.stream !== 'function') return null;
  const pieces = [];
  let size = 0;
  for await (const piece of file.stream()) {
    const bytes = piece instanceof Uint8Array ? piece : new Uint8Array(piece);
    if (!bytes.byteLength || size + bytes.byteLength > IMAGE_BYTES_LIMIT) return null;
    pieces.push(bytes);
    size += bytes.byteLength;
  }
  if (!size) return null;
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const piece of pieces) { bytes.set(piece, at); at += piece.byteLength; }
  if (canonicalType(picture.media_type) !== 'image/jpeg' || canonicalType(file.media_type) !== 'image/jpeg'
    || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  return { poster: `data:image/jpeg;base64,${base64(bytes)}`, video_poster_version: 1 };
}

/**
 * Ensure previews for one visible batch.
 *
 * Callers provide the existing namespace/result/Workshop owners so this module
 * stays independent of Durable Objects and HTTP. `readResult` and `locate` may
 * return a value directly or a promise. `run` receives the canonical content
 * identity and must use a deterministic request key. A completed task is
 * persisted through `writeResult`. A storage or result failure surfaces so
 * the visible caller can retry without treating missing work as terminal.
 */
export async function ensureNamespacePreviews({ identities, locate, readResult, run, open, writeResult }) {
  const asked = [...new Set(Array.isArray(identities) ? identities.filter(identity => CONTENT_IDENTITY.test(identity)) : [])].slice(0, MAX_VISIBLE_PREVIEWS);
  const previews = {};
  const queued = [];
  const canonicalAnswers = new Map();
  const canonicalStates = new Map();

  for (const requested of asked) {
    const row = await locate(requested);
    const canonical = row?.identity && CONTENT_IDENTITY.test(row.identity) ? row.identity : requested;
    if (canonicalStates.has(canonical)) {
      const answer = canonicalAnswers.get(canonical);
      if (answer !== undefined) previews[requested] = answer;
      if (canonicalStates.get(canonical) === 'queued') queued.push(requested);
      continue;
    }

    // A result alone is not proof that this account still holds the file.
    if (!row || row.growing) {
      canonicalAnswers.set(canonical, null);
      canonicalStates.set(canonical, 'terminal');
      previews[requested] = null;
      continue;
    }

    const video = videoFile(row);
    const kept = await readResult(requested);
    // Earlier browser captures could keep a black poster. The current video
    // maker marks frames it actually presented before saving the still.
    if (drawable(kept) && (!video || kept.video_poster_version === 1 && kept.duration !== 0)) {
      canonicalAnswers.set(canonical, kept);
      canonicalStates.set(canonical, 'ready');
      previews[requested] = kept;
      continue;
    }

    // A non-video without a saved preview is terminal for this request. A
    // later visible visit may ask again if a new result exists.
    if (!video) {
      canonicalAnswers.set(canonical, null);
      canonicalStates.set(canonical, 'terminal');
      previews[requested] = null;
      continue;
    }

    // A share may already have made a browser rendition and a separate kept
    // JPEG. Reuse that account-owned still for Files and Media before asking
    // Workshop to decode the original video again.
    const rendition = await readResult(requested, 'web-preview');
    if (CONTENT_IDENTITY.test(rendition?.poster_identity ?? '')) {
      const made = await posterFromPicture({ identity: rendition.poster_identity, media_type: rendition.poster_media_type }, open);
      if (made) {
        await writeResult(canonical, made);
        canonicalAnswers.set(canonical, made);
        canonicalStates.set(canonical, 'ready');
        previews[requested] = made;
        continue;
      }
    }

    // Old zero-duration browser stills can be black. A distinct key keeps a
    // previously failed first-frame Workshop run from masking the scored one.
    const task = await run(canonical, { request_key: scoredCoverRequestKey(canonical) });

    if (task?.state === 'completed') {
      const made = await posterFromPicture(task?.output?.files?.picture, open);
      if (!made) {
        canonicalAnswers.set(canonical, null);
        canonicalStates.set(canonical, 'terminal');
        previews[requested] = null;
        continue;
      }
      await writeResult(canonical, made, task.output.files.picture);
      canonicalAnswers.set(canonical, made);
      canonicalStates.set(canonical, 'ready');
      previews[requested] = made;
      continue;
    }

    if (task?.state === 'working' || task?.state === 'scheduled') {
      canonicalStates.set(canonical, 'queued');
      queued.push(requested);
    } else {
      canonicalAnswers.set(canonical, null);
      canonicalStates.set(canonical, 'terminal');
      previews[requested] = null;
    }
  }
  return { previews, queued };
}

export { drawable as isDrawablePreview };
