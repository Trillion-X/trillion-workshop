// src/workspace/pdf-reader-served.ts
//
// PURPOSE
//   Says where the signed-in workspace serves the PDF page reader (scripts/build-workspace.mjs copies pdf.js to
//   /workspace/pdf/), once for the page. Imported for its effect by every screen that draws a PDF: a tile's cover
//   (made-previews.ts) and a PDF shown as its pages (file-screen.tsx), whichever loads first.
import { servePdfReader } from '../../parts/ui/show/media-preview/pdf-reader';

servePdfReader({ module: '/workspace/pdf/pdf.min.mjs', worker: '/workspace/pdf/pdf.worker.min.mjs' });
