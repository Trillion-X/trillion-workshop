// packages/group/do-work/download-text.ts
//
// Generic "save this text as a file" browser action — the download glue for the export registry (a Copy
// button hands text to the clipboard; Download hands it to the OS as a real file, which is the ONLY way an
// .ics is useful: you open the FILE in Calendar). A tiny, format-agnostic leaf (like open-external's
// window.open) — it takes text + a filename + a MIME type and triggers a same-page download via a transient
// object URL. Fails closed (a no-op) when the browser download APIs are absent (SSR / a test without a DOM).

/** Trigger a browser download of `text` as `filename` with the given MIME type. No-op without a DOM. */
export function downloadText(text: string, filename: string, mime: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
