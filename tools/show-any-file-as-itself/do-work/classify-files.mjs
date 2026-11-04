// tools/show-any-file-as-itself/do-work/classify-files.mjs
//
// Which way each file is shown, decided from its name and media type alone: the file-content renderer's own fallback
// classification (show/classify-file-content.ts), run for a list of files. Each file comes back with the renderer the
// screen would route it to (code, markdown, diff, image, json or raw), its language, the icon and label it is shown
// under, and the media type it was taken as. No file is opened or read, nothing is drawn, nothing is sent: the signed-in
// classification owner the screen asks first is not called here, so the answer is the deterministic one.
//
// Input:  { files: [{ path, mime_type? }] }   path: the file's name or path (a query or fragment is ignored);
//                                             mime_type: its media type when known (it wins over the extension).
// Answer: { classified: [{ path, renderer, language, icon, label, mime_type? }] }, in the order given.
// Refuses: no files, or a file without a non-empty text path.
import { fallbackFileContentClassification } from '../show/classify-file-content.ts';

export function classifyFiles({ files } = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Give files: a list of { path, mime_type? }, for example [{ "path": "notes/plan.md" }].');
  const classified = files.map((file, index) => {
    const path = file?.path;
    if (typeof path !== 'string' || !path.trim()) throw new Error(`File ${index} needs path: the file's name or path as text, such as "photo.jpg".`);
    if (file.mime_type !== undefined && typeof file.mime_type !== 'string') throw new Error(`File ${index} (${path}) has mime_type that is not text; give a media type such as "image/png" or leave it out.`);
    const { renderer, language, icon, label, mimeType } = fallbackFileContentClassification(path, file.mime_type || undefined);
    return { path, renderer, language, icon, label, ...(mimeType ? { mime_type: mimeType } : {}) };
  });
  return { classified };
}
