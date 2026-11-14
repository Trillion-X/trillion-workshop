//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Export panel for the media composition editor. Materializes the CURRENT
// edit-decision fold into a contract::edl document (the SAME materialization
// the preview consumes — read-data/materialize-edl.ts is the SSOT translation)
// and dispatches `action:video-compose`, the ONE render authority
// (plan 2026-07-18 T2/T4). The compositor runs as a compute.process job and
// commits the mp4 to CAS; the reply's artifacts[] carries the playable ref.
//
// NON-NEGOTIABLE INVARIANTS
//
//   1. ZERO RAW HTML — all layout via ui/ primitives only (L065).
//   2. DECOUPLED — only invokes slot::workflow. No render logic here; the
//      surface is blind to how frames are made (WASM-is-the-brain).
//   3. ONE MATERIALIZATION — preview and export both derive from the same
//      MaterializedComposition; this panel adds zero interpretation.
//   4. SOURCE RESOLUTION IS INJECTED DATA — CAS refs resolve to the engine's
//      /cas/<address> route; the materializer never knows where bytes live.
//
// =============================================================================

import * as React from 'react';

import { sendRequestToBitfieldTarget } from '@/packages/media-composition/.bitfield-entry-scope/media-composition/runtime-kit';
import { Button } from '../../../ui/show/button/Button';
import { Card } from '../../../ui/show/card';
import { Container } from '../../../ui/show/container';
import { Text } from '../../../ui/show/text';
import { sanitizeErrorText } from '../../../ui/show/safe-error-card';

import { materializeExportEdl } from '../../read-data/materialize-edl';

import type { MaterializedComposition } from '../../read-data/compose-timeline';
import type { MediaWorkspaceSource } from '../../read-data/read-media-workspace';

const WORKFLOW_TARGET = 'slot::workflow';
const RENDER_DEFINITION_ID = 'action:video-compose';
const RENDER_TIMEOUT_MS = 3_600_000;

// ── Source resolution (surface-owned knowledge, injected into the materializer) ─

/**
 * Resolves a composition source to a URL ffmpeg can open inside the
 * compute.process job: CAS-committed bytes are served on the engine's
 * /cas/<address> route. Sources without a CAS address are unresolvable here
 * and are surfaced to the user (fail-closed), never silently dropped.
 */
function resolverFor(sources: MediaWorkspaceSource[]): (sourceId: string) => string | null {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (sourceId) => {
    const src = sources.find((s) => s.source_id === sourceId);
    const cas = src?.artifact_ref?.cas_address;
    return cas ? `${origin}/cas/${cas}` : null;
  };
}

// ── Reply reading ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export type PlayableRenderedVideo = {
  cas_address: string;
  multihash: string;
  byte_length: number;
  media_type: 'video/mp4';
};

/**
 * Finds the first complete playable MP4 result anywhere in the reply. A
 * storage address alone is not render success: integrity, a positive byte
 * length and the declared media type must all survive the workflow boundary
 * before the surface can say the video is ready.
 */
export function readExportArtifact(reply: unknown): PlayableRenderedVideo | null {
  if (!isRecord(reply)) return null;
  const artifacts = reply['artifacts'];
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      if (
        isRecord(artifact)
        && typeof artifact['cas_address'] === 'string'
        && artifact['cas_address'].trim().length > 0
        && typeof artifact['multihash'] === 'string'
        && artifact['multihash'].trim().length > 0
        && typeof artifact['byte_length'] === 'number'
        && Number.isSafeInteger(artifact['byte_length'])
        && artifact['byte_length'] > 0
        && artifact['media_type'] === 'video/mp4'
      ) {
        return artifact as PlayableRenderedVideo;
      }
    }
  }
  for (const key of ['output', 'result', 'value']) {
    const nested = readExportArtifact(reply[key]);
    if (nested) return nested;
  }
  const steps = reply['steps'];
  if (Array.isArray(steps)) {
    for (const step of [...steps].reverse()) {
      const nested = readExportArtifact(step);
      if (nested) return nested;
    }
  }
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export type MediaOutputPanelProps = {
  message?: string;
  outputAction?: React.ReactNode;
  composition?: MaterializedComposition;
  sources?: MediaWorkspaceSource[];
};

type ExportState =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'done'; casAddress: string }
  | { kind: 'error'; message: string };

export function MediaOutputPanel({
  message,
  outputAction,
  composition,
  sources,
}: MediaOutputPanelProps) {
  const [exportState, setExportState] = React.useState<ExportState>({ kind: 'idle' });

  const canExport = !!(composition && sources && composition.lanes.some((l) => l.clips.length > 0));

  async function handleExport() {
    if (!composition || !sources) return;
    setExportState({ kind: 'busy', label: 'Preparing your video…' });
    try {
      const { edl, unresolvedSourceIds } = materializeExportEdl(
        composition,
        resolverFor(sources),
        { width: 1920, height: 1080, fps: '30', crf: 20, preset: 'medium' },
      );
      if (unresolvedSourceIds.length > 0) {
        setExportState({ kind: 'error', message: 'Some clips are still uploading. Wait for them to finish, then export again.' });
        return;
      }
      if (edl.spine.segments.length === 0) {
        setExportState({ kind: 'error', message: 'Add clips to the timeline first.' });
        return;
      }
      setExportState({ kind: 'busy', label: 'Rendering…' });
      const reply = await sendRequestToBitfieldTarget({
        target: WORKFLOW_TARGET,
        payload: {
          operation: 'execute_definition',
          definition_id: RENDER_DEFINITION_ID,
          include_steps: true,
          include_output: true,
          input: {
            edl_path: JSON.stringify(edl),
            out: 'composed-video.mp4',
            timeout_ms: RENDER_TIMEOUT_MS,
          },
        },
      });
      const artifact = readExportArtifact(reply);
      if (artifact?.cas_address) {
        setExportState({ kind: 'done', casAddress: artifact.cas_address });
      } else {
        setExportState({ kind: 'error', message: 'The render did not finish. Try again.' });
      }
    } catch (err: unknown) {
      setExportState({
        kind: 'error',
        message: sanitizeErrorText(
          err instanceof Error ? err.message : null,
          'The video could not be exported. Nothing was changed.',
        ),
      });
    }
  }

  const statusText: string | null =
    exportState.kind === 'busy' ? exportState.label
    : exportState.kind === 'done' ? 'Your video is ready.'
    : exportState.kind === 'error' ? exportState.message
    : message ?? null;

  const busy = exportState.kind === 'busy';

  return (
    <Card variant="nested" padding="md">
      <Container layout="vertical" gap="sm">
        <Text variant="heading">Output</Text>
        {statusText ? (
          <Text variant="body-xs" color={exportState.kind === 'error' ? 'danger' : 'accent'}>
            {statusText}
          </Text>
        ) : null}
        {exportState.kind === 'done' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { window.open(`/cas/${exportState.casAddress}?mime=video/mp4`, '_blank'); }}
          >
            Watch video
          </Button>
        ) : null}
        {canExport ? (
          <Button variant="primary" size="md" disabled={busy} onClick={() => { void handleExport(); }}>
            {busy ? exportState.label : 'Export video'}
          </Button>
        ) : (
          <Text variant="body-xs" color="secondary">Add clips to the timeline to export.</Text>
        )}
        {outputAction}
      </Container>
    </Card>
  );
}
