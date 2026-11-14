// parts/ui/show/document-export/download-file.ts
//
// PURPOSE
//   Hands produced bytes to the person as a downloaded file. The one place a note's exports (PDF, text) are saved.

/** Saves `bytes` as `name`; returns false (never throws) when the browser cannot make the download. */
export function downloadFile(name: string, type: string, bytes: Uint8Array): boolean {
  try {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement('a');
    link.href = url; link.download = name; link.hidden = true;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch { return false; }
}
