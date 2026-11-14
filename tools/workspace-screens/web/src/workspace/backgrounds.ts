// src/workspace/backgrounds.ts
//
// PURPOSE
//   A picture set as a background (dropped on the workspace's stage, or chosen for a pane) is kept as one of the
//   person's own files, in their Backgrounds folder, and read back from that file whenever the background is drawn.
//   These are the two targets the shared picture-keeping seam asks for
//   (parts/ui/show/action-affordance/materialize-browser-artifact.ts and parts/ui/show/media-bytes/read-guarded-artifact-blob.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The picture goes through upload.ts, the one path every file into the person's space takes.
//   2. The saved background names only the file's content identity; bytes are read back through the signed-in session.
//   3. Every identity here is the page's BLAKE3 content hash (makeHashCodeHexFromBytes).

import { makeHashCodeHexFromBytes } from './records';

const FOLDER = '/Backgrounds';
const FILE = 'file:';

type Kept = { source?: { bytes?: number[]; media_type?: string; display_name?: string } };

const base64Of = (bytes: Uint8Array) => {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
};

/** Keep the picture in the person's Backgrounds folder; the answer names the kept file. */
export async function keepBackgroundPicture(request: unknown) {
  const source = (request as Kept)?.source;
  if (!Array.isArray(source?.bytes) || !source.media_type || !source.display_name) throw new Error('The picture could not be read.');
  const bytes = Uint8Array.from(source.bytes);
  // The upload and file-reading code is fetched the first time a background is kept or drawn, never with the page.
  const { uploadFiles } = await import('./upload');
  const [kept] = await uploadFiles([new File([bytes], source.display_name, { type: source.media_type, lastModified: Date.now() })], FOLDER);
  if (!kept) throw new Error('The picture is empty.');
  return {
    kind: 'content-media.materialized-relation/v1',
    relation_ref: `${FILE}${kept.identity}`,
    media_type: source.media_type.toLowerCase(),
    display_name: source.display_name,
    byte_length: bytes.byteLength,
    integrity_hash: makeHashCodeHexFromBytes(bytes),
  };
}

/** Read a kept background picture back from its file. */
export async function readBackgroundPicture(request: unknown) {
  const relation = String((request as { relation_ref?: unknown })?.relation_ref ?? '');
  if (!relation.startsWith(FILE)) throw new Error('This background is not one of your files.');
  const { bytesAddress } = await import('./file-picture');
  const answer = await fetch(bytesAddress(relation.slice(FILE.length)));
  if (!answer.ok) throw new Error('The background picture could not be read.');
  const bytes = new Uint8Array(await answer.arrayBuffer());
  return {
    bytes_base64: base64Of(bytes),
    byte_length: bytes.byteLength,
    integrity_hash: makeHashCodeHexFromBytes(bytes),
    media_type: (answer.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase(),
    display_name: 'Background',
    decision_ref: relation,
  };
}
