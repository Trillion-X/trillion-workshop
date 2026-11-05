// packages/group/do-work/request-board-output.ts
//
// Send an exported board artifact to a DATA-selected output target (the R19 egress
// seam). The panel renders bytes (SVG text, deck HTML, PNG blob) exactly as before;
// THIS module owns getting them OFF the surface when the browser anchor-download is
// dead (the macOS WKWebView presenter). It speaks two engine grammars, both proven
// by other packages and both PACKAGE-BLIND (no other package's source is imported —
// only the address contract is replicated, payloads stay opaque):
//
//   1. the process file-save protocol — mount the artifact bytes inline, run the
//      POSIX copy loop that resolves the user's download folder (or a caller-given
//      absolute folder) and writes with collision-safe names, echo the final paths
//      (the structured-file-output engine contract);
//   2. the workflow execute_definition envelope — for a DATA row whose route names
//      a workflow owner (the sales-contract-builder output-delivery contract).
//
// Which grammar fires is decided by the ROW (route.definitionId present → workflow),
// never by an enum here (L090). The dispatch returns the written paths (process) or
// the workflow reply — the caller shows the honest notice only after a confirmed
// reply, never optimistically.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  capturedProcessFdText,
  decodeProcessResultWireShape,
  processExitedCode,
} from '../../../src/workspace/process-result';
import type { BoardOutputRoute } from '../read-data/board-output-targets.ts';
import { decodeWorkflowRunReply } from '#workspace-records';
import { saveLocalFileCopy } from '../../local-files/do-work/save-local-file-copy';
import { invokeLocalFilesTarget } from '../../local-files/read-data/invoke-local-files-target';

/** One rendered export artifact: named bytes with a MIME type. Exactly one of
 *  `text`/`bytes` carries the content — the producer owns meaning. */
export interface BoardOutputArtifact {
  readonly fileName: string;
  readonly mimeType: string;
  readonly text?: string;
  readonly bytes?: Uint8Array;
}

export type BoardOutputSender = (
  request: { target: string; payload: Record<string, unknown> },
) => Promise<unknown>;

const PROCESS_TIMEOUT_MS = 300_000;
const MOUNT_PREFIX = 'board-output-file-';

// The engine-side file write: mounted sources arrive as (mount, name) argument
// pairs after `dest_dir` is set by the preamble. Collision-safe ("name (1).ext"),
// echoes each final absolute path — the caller's proof the write happened.
const SAVE_LOOP = [
  'mkdir -p "$dest_dir"',
  'while [ "$#" -gt 0 ]; do',
  '  src="$1"',
  '  name="$2"',
  '  shift 2',
  '  base="${name%.*}"',
  '  ext="${name##*.}"',
  '  if [ "$base" = "$name" ]; then ext=""; fi',
  '  dest="$dest_dir/$name"',
  '  n=1',
  '  while [ -e "$dest" ]; do',
  '    if [ -n "$ext" ]; then dest="$dest_dir/$base ($n).$ext"; else dest="$dest_dir/$name ($n)"; fi',
  '    n=$((n + 1))',
  '  done',
  '  cp "$src" "$dest"',
  '  printf "%s\\n" "$dest"',
  'done',
].join('\n');
const DOWNLOAD_FOLDER_SCRIPT = [
  'set -eu',
  'download_dir="${XDG_DOWNLOAD_DIR:-}"',
  'if [ -z "$download_dir" ] && command -v xdg-user-dir >/dev/null 2>&1; then download_dir="$(xdg-user-dir DOWNLOAD 2>/dev/null || true)"; fi',
  'if [ -z "$download_dir" ] || [ "$download_dir" = "$HOME" ]; then download_dir="$HOME/Downloads"; fi',
  'dest_dir="$download_dir"',
  SAVE_LOOP,
].join('\n');
// The caller-supplied folder arrives as the FIRST positional argument — never
// interpolated into the script text, so no quoting/injection surface.
const SAVE_TO_DIR_SCRIPT = [
  'set -eu',
  'dest_dir="$1"',
  'shift',
  SAVE_LOOP,
].join('\n');

const TEXT_ENCODER = new TextEncoder();

export function artifactBytes(artifact: BoardOutputArtifact): Uint8Array {
  return artifact.bytes ?? TEXT_ENCODER.encode(artifact.text ?? '');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function processResultPayload(reply: unknown): Uint8Array {
  if (!reply || typeof reply !== 'object') throw new Error('compute.process returned no envelope.');
  const payload = (reply as { payload?: unknown }).payload;
  if (!ArrayBuffer.isView(payload) || payload.constructor.name !== 'Uint8Array') {
    throw new Error('compute.process returned no byte payload.');
  }
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

/** The process file-save envelope for `artifacts` (the structured-file-output engine
 *  contract): each artifact mounted inline, the copy loop as the script, the optional
 *  absolute destination folder as the first positional argument. */
export function buildBoardOutputProcessRequest(
  route: BoardOutputRoute,
  artifacts: readonly BoardOutputArtifact[],
) {
  if (route.destinationDir && !route.destinationDir.startsWith('/')) {
    throw new Error('The folder to save into must be a full path starting with /');
  }
  return {
    target: route.target,
    payload: {
      argv: [
        'sh',
        '-lc',
        route.destinationDir ? SAVE_TO_DIR_SCRIPT : DOWNLOAD_FOLDER_SCRIPT,
        '--',
        ...(route.destinationDir ? [route.destinationDir] : []),
        ...artifacts.flatMap((artifact, index) => [`${MOUNT_PREFIX}${index}`, artifact.fileName]),
      ],
      cwd: null,
      timeout_ms: PROCESS_TIMEOUT_MS,
      termination_grace_ms: 1_000,
      expected_termination: null,
      env: {},
      inputs: artifacts.map((artifact, index) => ({
        mount_path: `${MOUNT_PREFIX}${index}`,
        source: {
          kind: 'inline',
          bytes: bytesToBase64(artifactBytes(artifact)),
        },
        content_type: artifact.mimeType,
      })),
      input_trees: [],
      outputs: [],
      containment: {
        kind: 'descendant_effect_contained',
        pipe_eof_timeout_ms: 1_000,
        publications: [],
      },
      capture_fds: [1, 2],
      collected_files: [],
    },
  };
}

/** The workflow delivery envelope for a route that names a workflow owner: the same
 *  execute_definition grammar every workflow caller speaks, with the artifact carried
 *  as an opaque {file_name, mime_type, bytes:base64} value the owner interprets. */
export function buildBoardOutputWorkflowRequest(
  route: BoardOutputRoute,
  artifacts: readonly BoardOutputArtifact[],
  requestedAtMs: number,
) {
  return {
    target: route.target,
    payload: {
      operation: 'execute_definition',
      definition_id: route.definitionId ?? '',
      include_steps: false,
      include_output: true,
      input: {
        artifacts: artifacts.map((artifact) => ({
          file_name: artifact.fileName,
          mime_type: artifact.mimeType,
          bytes: bytesToBase64(artifactBytes(artifact)),
        })),
        requested_at: new Date(requestedAtMs).toISOString(),
      },
    },
  };
}

/** The result of a confirmed file delivery: which grammar ran and the
 * absolute paths returned by the terminal file-save owner result. */
export interface BoardOutputDeliveryResult {
  readonly method: 'file-save' | 'workflow';
  readonly paths: string[];
}

/** A later save must not erase knowledge of files already verified on disk.
 * Unconfirmed files are deliberately excluded: callers must not retry the whole
 * batch and create duplicate copies of the successful prefix. */
export class BoardOutputPartialFailure extends Error {
  readonly confirmedPaths: readonly string[];
  readonly failedArtifactIndex: number;
  readonly cause: unknown;

  constructor(paths: readonly string[], failedArtifactIndex: number, cause: unknown) {
    super(`${paths.length} file${paths.length === 1 ? '' : 's'} saved. The remaining files were not confirmed.`);
    this.name = 'BoardOutputPartialFailure';
    this.confirmedPaths = Object.freeze([...paths]);
    this.failedArtifactIndex = failedArtifactIndex;
    this.cause = cause;
  }
}

function confirmedFilePaths(stdout: string, artifactCount: number): string[] {
  const paths = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (paths.length !== artifactCount || new Set(paths).size !== artifactCount
    || paths.some((path) => !path.startsWith('/'))) {
    throw new Error('File delivery has not been confirmed.');
  }
  return paths;
}

/** Send `artifacts` to the destination named by `route` and resolve only on a
 *  CONFIRMED delivery (non-zero exit or a dead engine rejects — the caller decides
 *  the fallback; this module never lies about egress). */
export async function requestBoardOutputDelivery(
  route: BoardOutputRoute,
  artifacts: readonly BoardOutputArtifact[],
  requestedAtMs: number,
  sender: BoardOutputSender = sendRequestToBitfieldTarget as BoardOutputSender,
): Promise<BoardOutputDeliveryResult> {
  if (artifacts.length === 0) return { method: 'file-save', paths: [] };
  if (route.fileOperation) {
    if (route.fileOperation !== 'write_new_file' || route.target !== 'local.files' || route.definitionId) {
      throw new Error('This file destination is not supported.');
    }
    const paths: string[] = [];
    for (const artifact of artifacts) {
      try {
        paths.push(await saveLocalFileCopy({
          fileName: artifact.fileName, bytes: artifactBytes(artifact),
          directory: route.destinationDir, copyId: crypto.randomUUID(),
        }, (request) => invokeLocalFilesTarget(request, sender)));
      } catch (error) {
        if (paths.length) throw new BoardOutputPartialFailure(paths, paths.length, error);
        throw error;
      }
    }
    return { method: 'file-save', paths };
  }
  if (route.definitionId) {
    const reply = await sender(buildBoardOutputWorkflowRequest(route, artifacts, requestedAtMs));
    const result = decodeWorkflowRunReply(route.definitionId, reply);
    const output = result.output && typeof result.output === 'object'
      ? result.output as Record<string, unknown> : null;
    // A completed workflow may carry an owner refusal or an accepted-only result.
    // Neither is a completed delivery.
    const incompleteOutput = output && (
      output.accepted === false || output.ok === false || output.success === false
      || Boolean(output.error)
      || ['accepted', 'pending', 'queued', 'running', 'failed', 'error', 'denied', 'rejected', 'cancelled', 'canceled'].includes(String(output.status))
    );
    if (result.status !== 'completed' || result.error || incompleteOutput) {
      throw new Error('File delivery has not been confirmed.');
    }
    // Reuse the file-save owner's terminal result rather than treating a
    // workflow acknowledgement or an echoed request as evidence of delivery.
    // Other destination protocols require their own verified owner result join.
    const saved = decodeProcessResultWireShape(TEXT_ENCODER.encode(JSON.stringify(result.output)));
    if (processExitedCode(saved) !== 0) throw new Error('Could not save the file.');
    const paths = confirmedFilePaths(capturedProcessFdText(saved, 1), artifacts.length);
    return { method: 'workflow', paths };
  }
  const reply = await sender(buildBoardOutputProcessRequest(route, artifacts));
  const result = decodeProcessResultWireShape(processResultPayload(reply));
  if (processExitedCode(result) !== 0) {
    const stderr = capturedProcessFdText(result, 2).trim();
    throw new Error(stderr.length > 0 ? stderr : 'Could not save the file.');
  }
  const paths = confirmedFilePaths(capturedProcessFdText(result, 1), artifacts.length);
  return { method: 'file-save', paths };
}
