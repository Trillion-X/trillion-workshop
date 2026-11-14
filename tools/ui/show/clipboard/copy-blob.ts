// packages/ui/show/clipboard/copy-blob.ts
//
// =============================================================================
// PURPOSE — the universal "copy these image bytes to the system clipboard".
// =============================================================================
//
// "Put a produced image on the clipboard so the user can paste it into Slack /
// a doc / an email" is a browser-universal capability, not a board concept
// (L088 — shared UI bedrock, sibling of `downloadBlob`). Any surface that
// produces an image Blob (an exported board, a generated picture, a chart)
// copies it through ONE implementation.
//
// BLIND: it knows nothing about WHAT the image is. The producer owns meaning.
// HONEST DEGRADATION (L090): the async Clipboard API requires a secure context +
// a user gesture + permission. When it is missing or rejects, this returns
// `false` rather than throwing — the caller decides how to surface that.
// =============================================================================

/**
 * Copy an image Blob to the system clipboard. Returns true on success, false if
 * the Clipboard API (or `ClipboardItem`) is unavailable or the write is rejected.
 */
export async function copyImageBlobToClipboard(blob: Blob): Promise<boolean> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clipboard || typeof clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') {
    return false;
  }
  try {
    await clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    return true;
  } catch {
    return false;
  }
}
