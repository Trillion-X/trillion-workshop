// Keep ordered rendered files in the person's namespace and publish them through
// the one sharing primitive (share-anything.ts), through the caller's `makeShare`.
export type RenderedMediaFile = { fileName: string; mediaType: string; content: string | Blob | Uint8Array };
export type KeptMediaFile = { name: string; identity: string; byte_length: number; modified_at_ms: number };
export type MediaPublication = { pageUrl: string; mediaUrls: string[]; files: KeptMediaFile[]; expiresAt: string | null; label: string };
type UploadFiles = (files: File[], folder: string) => Promise<KeptMediaFile[]>;
/** Shares these files by one link anyone may open: the link's address and the share's label (to stop it by). */
type MakeShare = (items: { type: string; id: string }[], expiresAt: string | null) => Promise<{ url: string; label: string }>;

export async function publishMediaFiles(artifacts: readonly RenderedMediaFile[], options: {
  folder: string;
  expiresAt?: string | null;
  uploadFiles: UploadFiles;
  makeShare: MakeShare;
}): Promise<MediaPublication> {
  if (!artifacts.length) throw new Error('Choose at least one media file to publish.');
  if (artifacts.length > 100) throw new Error('A share link can hold at most 100 media files.');
  if (!options.folder.startsWith('/')) throw new Error('The folder must start with /.');
  const files = artifacts.map(artifact => {
    const name = artifact.fileName.split(/[\\/]/).at(-1)?.trim();
    if (!name) throw new Error('Every media file needs a name.');
    return new File([artifact.content as BlobPart], name, { type: artifact.mediaType || 'application/octet-stream', lastModified: Date.now() });
  });
  const kept = await options.uploadFiles(files, options.folder);
  if (kept.length !== files.length || kept.some(file => typeof file.identity !== 'string' || !file.identity)) {
    throw new Error('Trillion did not confirm that every media file was kept.');
  }
  const unique = [...new Set(kept.map(file => file.identity))];
  const expiresAt = options.expiresAt ?? null;
  const created = await options.makeShare(unique.map(identity => ({ type: 'file', id: `file:${identity}` })), expiresAt);
  let page: URL;
  try { page = new URL(created.url); }
  catch { throw new Error('Trillion did not return a public share address.'); }
  if (page.protocol !== 'https:' || !/^\/share\/[A-Za-z0-9_-]+$/.test(page.pathname) || !created.label) {
    throw new Error('Trillion did not return a public share address.');
  }
  // A shared file's bytes are at the link's own address under files/<identity> (the share's answer names them so).
  const mediaUrls = kept.map(file => new URL(`${page.pathname}/files/${file.identity}`, page.origin).toString());
  return { pageUrl: page.toString(), mediaUrls, files: kept, expiresAt, label: created.label };
}
