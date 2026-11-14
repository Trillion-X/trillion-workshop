// packages/group/show/board-output-destinations.ts
//
// Board export destinations — the built-in ways to deliver exported text PLUS every
// DATA-declared output target, all as rows of the ONE generic output-destination
// seam. New destination = one row (published-record or deliver capability); zero
// seam edits (L090).
//
// The engine-backed rows are the load-bearing half: the browser anchor download is
// DEAD inside the macOS WKWebView presenter, so "Downloads" (and any user-declared
// folder/workflow target from `output-target-catalog` published-records) delivers
// through the process file-save / workflow envelopes in do-work/request-board-output.
// The anchor download survives only as a plain-browser fallback row. Fail-closed
// everywhere: a destination resolves true only on a CONFIRMED delivery.

import type { OutputDestination } from '../../ui/show/output-destination';
import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';
import { downloadText } from 'trillion-workshop/tools/organize-the-sidebar/do-work/download-text.ts';
import { readBoardOutputTargets, type BoardOutputTargetDescriptor } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-output-targets.ts';
import { requestBoardOutputDelivery } from '../do-work/request-board-output';

/**
 * "Copy to clipboard" destination — uses the fail-closed copyTextToClipboard
 * from the shared ui helper (handles WKWebView fallback internally).
 * Only works for text payloads; bytes are coerced to text representation.
 */
export const clipboardDestination: OutputDestination = {
  id: 'board-export::clipboard',
  label: 'Copy to clipboard',
  hint: 'Copy the exported text to your system clipboard',
  deliver: async (payload) => {
    const text = payload.text ?? '';
    if (!text) return false;
    return await copyTextToClipboard(text);
  },
};

/**
 * "Download file" destination — uses browser download (blob + anchor element).
 * This is best-effort; it works in most browsers but may fail in constrained
 * environments (some mobile browsers, iframe sandboxes). On failure, the caller
 * should fall back to a selectable-text overlay.
 */
export const downloadDestination: OutputDestination = {
  id: 'board-export::download',
  label: 'Download file',
  hint: 'Save the exported file to your Downloads folder',
  // R43a: the engine-routed "Downloads" target is the real, working egress inside the
  // WKWebView presenter; this browser anchor is DEAD there. Showing both side by side is
  // the "Downloads AND Download file — totally redundant and confusing" report. Marked
  // fallbackOnly so it stays in the auto/first-success chain (catches the plain-browser
  // case where no process runner exists) but is never a visible duplicate choice.
  fallbackOnly: true,
  deliver: async (payload) => {
    const text = payload.text ?? '';
    if (!text) return false;
    try {
      downloadText(text, payload.filename, payload.mimeType);
      return 'requested';
    } catch {
      return false;
    }
  },
};

/**
 * "Show for copy/paste" destination — a fallback that displays the text in
 * a selectable overlay so the user can copy it manually. This is the
 * most reliable fallback when other methods fail. The caller owns the
 * `askText` overlay (passed as a capability to this function).
 */
export function selectableTextDestination(
  askText: (prompt: string, text: string, button: string) => Promise<string | null>,
): OutputDestination {
  return {
    id: 'board-export::selectable-text',
    label: 'Show for copy/paste',
    hint: 'Display the text in a selectable overlay',
    deliver: async (payload) => {
      const text = payload.text ?? '';
      if (!text) return false;
      const result = await askText('Select this text and copy it manually:', text, 'Done');
      return result === null ? 'cancelled' : 'shown';
    },
  };
}

/**
 * Standard board export destinations: clipboard, download, and selectable-text fallback.
 * Destinations are registered in order of preference; callers iterate through them
 * and stop at the first success (fail-closed delivery with fallback chain).
 */
export const BOARD_EXPORT_DESTINATIONS_BUILTIN = [
  clipboardDestination,
  downloadDestination,
];

/**
 * Create the full destination set for board export, including the selectable-text fallback.
 * The fallback requires the askText capability from the board panel.
 */
export function getBoardExportDestinations(
  askText: (prompt: string, text: string, button: string) => Promise<string | null>,
): OutputDestination[] {
  return [
    ...BOARD_EXPORT_DESTINATIONS_BUILTIN,
    selectableTextDestination(askText),
  ];
}

/**
 * One engine-routed destination row from a DATA target descriptor: delivering sends
 * the artifact through the process file-save / workflow envelope and resolves true
 * ONLY on a confirmed reply (echoed paths / accepted definition) — the honest egress
 * for the WKWebView presenter where the anchor download silently no-ops.
 */
export function engineTargetDestination(descriptor: BoardOutputTargetDescriptor): OutputDestination {
  return {
    id: `board-export::target::${descriptor.id}`,
    label: descriptor.label,
    hint: descriptor.route.destinationDir
      ? `Save the file into ${descriptor.route.destinationDir}`
      : descriptor.route.definitionId
        ? `Send the file to ${descriptor.label}`
        : 'Save the file to your Downloads folder',
    deliver: async (payload) => {
      // R43c: forward BYTES too, not just text — an image export (PNG raster) carries
      // `bytes`, and the engine file-save protocol already mounts base64 artifact bytes
      // (see do-work/request-board-output artifactBytes). Text OR bytes must be present.
      const text = payload.text ?? '';
      const bytes = payload.bytes;
      const hasBytes = bytes !== undefined && bytes.length > 0;
      if (!text && !hasBytes) return false;
      try {
        // The surface supplies the instant: a browser's clock is an INPUT the log records,
        // so the do-work module never reads one of its own and stays replayable.
        const result = await requestBoardOutputDelivery(descriptor.route, [
          hasBytes
            ? { fileName: payload.filename, mimeType: payload.mimeType, bytes }
            : { fileName: payload.filename, mimeType: payload.mimeType, text },
        ], Date.now());
        return result.method === 'workflow' || result.paths.length > 0;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The COMPLETE destination set: engine-routed targets first (the builtin Downloads
 * row + every `output-target-catalog` published-record DATA row — the paths that
 * actually work inside the WKWebView presenter), then clipboard, then the browser
 * anchor download, then the always-works selectable-text overlay. A new destination
 * is ONE published record — zero code (L069/L090).
 */
export function getBoardExportDestinationsWithTargets(
  publishedRecords: ReadonlyArray<{ payload?: unknown }>,
  askText: (prompt: string, text: string, button: string) => Promise<string | null>,
): OutputDestination[] {
  return [
    ...readBoardOutputTargets(publishedRecords).map(engineTargetDestination),
    clipboardDestination,
    downloadDestination,
    selectableTextDestination(askText),
  ];
}
