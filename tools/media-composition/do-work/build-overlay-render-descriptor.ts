// package-set://bitfield-studio/packages/media-composition/do-work/build-overlay-render-descriptor.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// T6 (plan 2026-07-18): the ONE decoder step that turns a rich-text overlay —
// authored in documents at full document richness (W3 correction:
// "Add text" opens documents, never a bespoke input) — into an
// overlay artifact the EDL can reference. This is a PURE compute.process
// descriptor builder: the renderer script (the documents offline
// render harness bundle, committed to the log as stored bytes) is mounted by
// content hash, the document arrives as an opaque JSON payload, and the output
// PNG (alpha) is committed to CAS as the job output. The resulting CAS ref
// becomes the `source` of an overlay/clip EDL row.
//
// NON-NEGOTIABLE INVARIANTS
//
//   1. PURE — no I/O, no Date.now(). Caller supplies the document payload,
//      the renderer script's content hash, and dimensions.
//   2. ZERO cross-package imports — documents is referenced only
//      as DATA (a document payload + a stored-bytes content hash). Deleting
//      that package leaves this builder compiling and failing loudly at run
//      time with a missing-blob error, never a broken import (no-god-package).
//   3. WASM-IS-THE-BRAIN — rendering happens in an OS process spawned by
//      process-engine; no render code in any surface.
//
// =============================================================================

import { inlineProcessSourceFromText } from '@bitfield/runtime-kit/protocol';

export type OverlayRenderRequest = {
  /** Opaque composition document JSON (documents's own format — never interpreted here). */
  documentJson: string;
  /** Content hash (blob_ref) of the renderer script bytes committed to the log. */
  rendererScriptHash: string;
  /** Output raster dimensions. */
  width: number;
  height: number;
  timeoutMs?: number;
};

export type OverlayProcessDescriptor = {
  argv: string[];
  timeout_ms: number;
  env: Record<string, string>;
  inputs: {
    mount_path: string;
    content_type: string;
    source: Record<string, unknown>;
  }[];
  outputs: { mount_path: string; content_type: string; storage: string }[];
};

/**
 * Builds the compute.process descriptor that renders a documents
 * document to a transparent PNG overlay. The renderer contract is positional
 * and generic: `node render-overlay.mjs <doc.json> <out.png> <width> <height>`.
 */
export function buildOverlayRenderDescriptor(req: OverlayRenderRequest): OverlayProcessDescriptor {
  const { documentJson, rendererScriptHash, width, height, timeoutMs = 300_000 } = req;
  if (!documentJson || !rendererScriptHash) {
    throw new Error('[overlay-render] documentJson and rendererScriptHash are required');
  }
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) {
    throw new Error(`[overlay-render] positive width/height required (got ${width}x${height})`);
  }
  return {
    argv: ['node', 'render-overlay.mjs', 'doc.json', 'overlay.png', String(width), String(height)],
    timeout_ms: timeoutMs,
    env: {},
    inputs: [
      {
        mount_path: 'render-overlay.mjs',
        content_type: 'text/javascript',
        source: { kind: 'blob_ref', hash: rendererScriptHash },
      },
      {
        mount_path: 'doc.json',
        content_type: 'application/json',
        source: inlineProcessSourceFromText(documentJson),
      },
    ],
    outputs: [
      { mount_path: 'overlay.png', content_type: 'image/png', storage: 'addressed_chunks' },
    ],
  };
}
