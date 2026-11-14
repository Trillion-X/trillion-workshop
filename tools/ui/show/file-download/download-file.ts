// packages/ui/show/file-download/download-file.ts
//
// =============================================================================
// PURPOSE — the universal "save these bytes to a file" capability.
// =============================================================================
//
// "Download bytes the user produced" is a browser-universal capability, not a
// vision-board concept (L088 — it settles at the shared UI bedrock, so every
// surface that produces an artifact — an exported board SVG, a generated image,
// a report — reuses ONE implementation instead of hand-rolling the
// create-anchor-click-revoke dance per package).
//
// BLIND: it knows nothing about WHAT the bytes are — it takes a filename, a MIME
// type, and either a string or a Blob. The producer owns meaning.
// =============================================================================

/** Trigger a browser download of an in-memory Blob under `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click has been dispatched (a microtask is enough; the
  // browser has already captured the URL by the time this runs).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Download a text payload (svg/json/csv/txt) as `filename` with `mimeType`. */
export function downloadTextFile(text: string, filename: string, mimeType: string): void {
  downloadBlob(new Blob([text], { type: mimeType }), filename);
}

/** Read the file at `url` once and save it as `filename`. The returned promise settles when the bytes are saved or
 *  the read failed, so a Button whose press returns it says Downloading, Done or Try again in itself and takes no
 *  second press while the first runs: one press, one copy, however slow the file is to arrive. */
export async function downloadAddress(url: string, filename: string): Promise<void> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`The file could not be read (${response.status}).`);
  downloadBlob(await response.blob(), filename);
}
