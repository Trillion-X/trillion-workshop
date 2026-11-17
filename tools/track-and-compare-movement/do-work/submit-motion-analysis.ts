import {
  createContentMediaWorkId,
  submitWorkflowAction,
  type ContentMediaSourceRef,
} from '../../content-media-evidence/do-work/content-media-work-loop';
import { inlineProcessSourceFromText } from '@bitfield/runtime-kit/protocol';

const MOTION_ANALYSIS_ACTION_ID = 'action:submit-motion-analysis-request';
const DEFAULT_TIMEOUT_MS = 300_000;

/** A perception tracker, supplied as DATA by the deployment (NOT owned by this
 *  generic package). It names the orchestrator + model + run parameters of a real
 *  vision pipeline (pose/angle/phase, or a future ball/court/line tracker). The
 *  binary/args/model are deployment DATA — adding a new tracker is a new
 *  TrackerDescriptor record, zero engine change (enum dissolution / L089: the env
 *  is data, not a code branch). When absent, the request falls back to the legacy
 *  metadata descriptor (to be removed once a real tracker is deployed — L101). */
export type TrackerDescriptor = {
  trackerId: string;
  /** Absolute path to the perception orchestrator the descriptor runs. DATA. */
  orchestratorPath: string;
  /** Absolute path to the model checkpoint the orchestrator loads. DATA. */
  checkpointPath?: string;
  /** Frame cap (0 = all). Carried into the descriptor env. */
  maxFrames?: number;
  timeoutMs?: number;
  /** Extra process env the orchestrator needs, supplied as DATA by the deployment
   *  (e.g. PYTHONPATH to the bundled engine, JOINTBDOE_VENDOR to a vendored model
   *  tree). The generic package names NO path — every location is a DATA value here
   *  (L089: env is data, not a code branch). Merged into the descriptor env. */
  env?: Record<string, string>;
};

export type SubmitMotionAnalysisRequest = {
  requestId?: string;
  sources: ContentMediaSourceRef[];
  lanes?: Record<string, boolean>;
  requestedAt?: string;
  /** Perception tracker (DATA). When present, the motion_command descriptor runs
   *  the real vision pipeline instead of the legacy metadata descriptor. */
  tracker?: TrackerDescriptor;
};

export type MotionAnalysisWorkflowInput = {
  request_id: string;
  sources: ContentMediaSourceRef[];
  lanes: Record<string, boolean>;
  options: Record<string, unknown>;
  requested_at: string;
};

function motionScript(): string {
  return `#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_json(path: str, value: dict[str, Any]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))


def duration_seconds(path: str) -> float | None:
    binary = shutil.which("ffprobe")
    if not binary:
        return None
    completed = subprocess.run(
        [binary, "-v", "quiet", "-print_format", "json", "-show_format", path],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != 0:
        return None
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return None
    value = data.get("format", {}).get("duration")
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: inspect-motion.py <media-path> <request-id> <output-json>")
    media_path = sys.argv[1]
    request_id = sys.argv[2]
    output_path = sys.argv[3]
    duration = duration_seconds(media_path)
    end = duration if duration and duration > 0 else 0.0
    track_id = f"{request_id}:track:0"
    phase_id = f"{request_id}:phase:0"
    write_json(output_path, {
        "tracks": [{
            "track_id": track_id,
            "source_index": 0,
            "subject_ref": {},
            "keypoint_schema": {"kind": "motion.source-observation"},
            "time_range": {"start": 0, "end": end},
            "sample_rate": None,
            "model": {"name": "source-metadata"},
            "evidence": {"file_size": Path(media_path).stat().st_size},
            "created_at": now(),
        }],
        "phases": [{
            "phase_id": phase_id,
            "source_index": 0,
            "track_ref": {"track_id": track_id},
            "label": "Movement clip",
            "time_range": {"start": 0, "end": end},
            "phase_taxonomy_ref": {"kind": "generic-motion-phase"},
            "evidence": {"source": "file metadata"},
            "created_at": now(),
        }],
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
}

/** Build the motion_command descriptor. With a tracker (DATA), it runs the REAL
 *  perception pipeline; without one, it falls back to the legacy metadata
 *  descriptor (temporary — removed once a real tracker is deployed, L101). */
function buildMotionCommandDescriptor(
  source: ContentMediaSourceRef,
  requestId: string,
  tracker?: TrackerDescriptor,
): Record<string, unknown> {
  return tracker
    ? buildRealPerceptionDescriptor(source, requestId, tracker)
    : buildLegacyMetadataDescriptor(source, requestId);
}

/** A descriptor that runs a real vision pipeline (the tracker's orchestrator) on
 *  the mounted clip and emits the canonical {tracks,phases,alignments,comparisons}
 *  command-output.json the record-maker consumes. The orchestrator path + model
 *  come from the tracker DATA — this generic package names no tool and no machine
 *  location (L089). The motion-analysis workflow runs the record-maker on the
 *  output, so the orchestrator skips its own normalize (SKIP_NORMALIZE=1). */
function buildRealPerceptionDescriptor(
  source: ContentMediaSourceRef,
  requestId: string,
  tracker: TrackerDescriptor,
): Record<string, unknown> {
  const artifactRef = source.artifact_ref;
  return {
    argv: [
      'bash',
      tracker.orchestratorPath,
      'media/source',
      '.',
      'player',
      requestId,
      ...(tracker.checkpointPath ? [tracker.checkpointPath] : []),
    ],
    cwd: null,
    timeout_ms: tracker.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    termination_grace_ms: 1_000,
    expected_termination: null,
    env: {
      SKIP_NORMALIZE: '1',
      MOTION_MAX_FRAMES: String(tracker.maxFrames ?? 0),
      ...(tracker.env ?? {}),
    },
    inputs: [
      {
        mount_path: 'media/source',
        content_type: source.media_type,
        source: {
          kind: 'blob_ref',
          hash: artifactRef.cas_address ?? artifactRef.multihash,
        },
      },
    ],
    outputs: [
      {
        mount_path: 'command-output.json',
        storage: 'inline',
        content_type: 'application/json',
      },
    ],
    input_trees: [],
    containment: {
      kind: 'descendant_effect_contained',
      pipe_eof_timeout_ms: 1_000,
      publications: [],
    },
    capture_fds: [1, 2],
    collected_files: [],
  };
}

function buildLegacyMetadataDescriptor(source: ContentMediaSourceRef, requestId: string): Record<string, unknown> {
  const artifactRef = source.artifact_ref;
  return {
    argv: [
      'python3',
      'packages/motion-analysis/do-work/inspect-motion.py',
      'media/source',
      requestId,
      'command-output.json',
    ],
    cwd: null,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    termination_grace_ms: 1_000,
    expected_termination: null,
    env: {},
    inputs: [
      {
        mount_path: 'packages/motion-analysis/do-work/inspect-motion.py',
        content_type: 'text/x-python',
        source: inlineProcessSourceFromText(motionScript()),
        executable: true,
      },
      {
        mount_path: 'media/source',
        content_type: source.media_type,
        source: {
          kind: 'blob_ref',
          hash: artifactRef.cas_address ?? artifactRef.multihash,
        },
      },
    ],
    outputs: [
      {
        mount_path: 'command-output.json',
        storage: 'inline',
        content_type: 'application/json',
      },
    ],
    input_trees: [],
    containment: {
      kind: 'descendant_effect_contained',
      pipe_eof_timeout_ms: 1_000,
      publications: [],
    },
    capture_fds: [1, 2],
    collected_files: [],
  };
}

export function buildMotionAnalysisInput(request: SubmitMotionAnalysisRequest): MotionAnalysisWorkflowInput {
  const requestId = request.requestId ?? createContentMediaWorkId('motion-analysis');
  const lanes = request.lanes ?? {
    tracks: true,
    phases: true,
    alignments: true,
    comparisons: true,
  };
  const primarySource = request.sources[0];
  if (!primarySource) throw new Error('Choose a video before checking movement.');
  return {
    request_id: requestId,
    sources: request.sources,
    lanes,
    options: {
      motion_command: {
        process_descriptor: buildMotionCommandDescriptor(primarySource, requestId, request.tracker),
        process_profile: {
          provider: request.tracker ? request.tracker.trackerId : 'local-motion-metadata',
          runtime: 'compute.process',
          lanes,
        },
      },
    },
    requested_at: request.requestedAt ?? new Date().toISOString(),
  };
}

export async function submitMotionAnalysisRequest(
  request: SubmitMotionAnalysisRequest,
): Promise<MotionAnalysisWorkflowInput> {
  const input = buildMotionAnalysisInput(request);
  await submitWorkflowAction({
    definitionId: MOTION_ANALYSIS_ACTION_ID,
    input,
    includeSteps: true,
    includeOutput: true,
  });
  return input;
}
