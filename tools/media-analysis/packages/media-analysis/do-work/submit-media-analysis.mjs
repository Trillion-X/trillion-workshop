// tools/media-analysis/packages/media-analysis/do-work/submit-media-analysis.mjs
//
// Purpose: builds the request that asks the local media-metadata process to read one media file, and hands it to a sender the
// caller gives. The script that reads the file is embedded here as text, so the process runs it with no other tool.
//
// Port note: the old file (tools/media-analysis/from-bitfield-packages/media-analysis/do-work/submit-media-analysis.ts at
// Workshop commit 352331c28) sent its request to the retired Bitfield runtime. This port keeps the request builder and
// takes the sender as a required input, so nothing sends by default. The send is a live action and is held: no caller
// in this repository passes a sender yet.
//
// Non-Negotiable Invariants:
//   1. submitMediaAnalysisRequest refuses to run without a send function, so a request never leaves by accident.
//   2. The request names no provider, account or service: the process is local, and the lanes are the caller's.
//   3. The inline script's source shape is the one the process engine accepts for inline text; it is not confirmed by a run
//      here, so the request is held until one proves it.
const MEDIA_ANALYSIS_ACTION_ID = 'action:submit-media-analysis-request';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_LANES = { metadata: true, chapters: true, thumbnails: true, embeddings: true };

const ANALYSIS_SCRIPT = `#!/usr/bin/env python3
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


def claim(request_id: str, key: str, value: Any, evidence: dict[str, Any], confidence: float = 1.0) -> dict[str, Any]:
    token = key.replace(" ", "-")
    return {
        "claim_id": f"{request_id}:claim:{token}",
        "claim_type": "media.metadata",
        "claim_key": key,
        "confidence": confidence,
        "value": value,
        "evidence": evidence,
        "created_at": now(),
    }


def ffprobe(path: str) -> dict[str, Any] | None:
    binary = shutil.which("ffprobe")
    if not binary:
        return None
    completed = subprocess.run(
        [binary, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != 0:
        return {"ffprobe_error": completed.stderr[-2000:]}
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {"ffprobe_error": "ffprobe returned invalid JSON"}


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: analyze-media.py <media-path> <request-id> <output-json>")
    media_path = sys.argv[1]
    request_id = sys.argv[2]
    output_path = sys.argv[3]
    stat = Path(media_path).stat()
    probe = ffprobe(media_path)
    claims: list[dict[str, Any]] = [
        claim(request_id, "File size", stat.st_size, {"unit": "bytes"}),
    ]
    if probe and not probe.get("ffprobe_error"):
        streams = probe.get("streams") if isinstance(probe.get("streams"), list) else []
        fmt = probe.get("format") if isinstance(probe.get("format"), dict) else {}
        duration = fmt.get("duration")
        if duration is not None:
            claims.append(claim(request_id, "Duration", duration, {"unit": "seconds", "source": "ffprobe"}))
        video_streams = [item for item in streams if isinstance(item, dict) and item.get("codec_type") == "video"]
        audio_streams = [item for item in streams if isinstance(item, dict) and item.get("codec_type") == "audio"]
        claims.append(claim(request_id, "Video streams", len(video_streams), {"source": "ffprobe"}))
        claims.append(claim(request_id, "Audio streams", len(audio_streams), {"source": "ffprobe"}))
        if video_streams:
            first_video = video_streams[0]
            claims.append(claim(request_id, "Frame size", {"width": first_video.get("width"), "height": first_video.get("height")}, {"source": "ffprobe"}))
    elif probe and probe.get("ffprobe_error"):
        claims.append(claim(request_id, "Probe status", "Needs attention", {"message": probe.get("ffprobe_error")}, 0.6))
    else:
        claims.append(claim(request_id, "Probe status", "ffprobe not installed", {"next": "Install ffmpeg for richer media facts."}, 0.6))
    write_json(output_path, {"claims": claims})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

// The inline text source the process engine reads; a caller that knows the engine's current shape can change it here.
const inlineSource = text => ({ kind: 'inline_text', text });

function createMediaAnalysisRequestId() {
  return `media-analysis:${crypto.randomUUID()}`;
}

function buildMediaAnalysisCommandDescriptor(source, requestId) {
  const artifactRef = source.artifact_ref;
  return {
    argv: ['python3', 'packages/media-analysis/do-work/analyze-media.py', 'media/source', requestId, 'command-output.json'],
    cwd: null,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    termination_grace_ms: 1_000,
    expected_termination: null,
    env: {},
    inputs: [
      {
        mount_path: 'packages/media-analysis/do-work/analyze-media.py',
        content_type: 'text/x-python',
        source: inlineSource(ANALYSIS_SCRIPT),
        executable: true,
      },
      {
        mount_path: 'media/source',
        content_type: source.media_type,
        source: { kind: 'blob_ref', hash: artifactRef.cas_address ?? artifactRef.multihash },
      },
    ],
    outputs: [{ mount_path: 'command-output.json', storage: 'inline', content_type: 'application/json' }],
    input_trees: [],
    containment: { kind: 'descendant_effect_contained', pipe_eof_timeout_ms: 1_000, publications: [] },
    capture_fds: [1, 2],
    collected_files: [],
  };
}

export function buildMediaAnalysisInput(request) {
  const requestId = request.requestId ?? createMediaAnalysisRequestId();
  const lanes = request.lanes ?? DEFAULT_LANES;
  return {
    request_id: requestId,
    source: request.source,
    lanes,
    options: {
      analysis_command: {
        process_descriptor: buildMediaAnalysisCommandDescriptor(request.source, requestId),
        process_profile: { provider: 'local-media-metadata', runtime: 'compute.process', lanes },
      },
    },
    requested_at: request.requestedAt ?? new Date().toISOString(),
  };
}

// Sends the request through `send` (the caller's sender, required). Answers the input it sent.
export async function submitMediaAnalysisRequest(request, { send } = {}) {
  if (typeof send !== 'function') throw Object.assign(new Error('No sender was given, so no media analysis request was sent.'), { code: 'no_sender' });
  const input = buildMediaAnalysisInput(request);
  await send({ operation: 'execute_definition', definition_id: MEDIA_ANALYSIS_ACTION_ID, include_steps: true, include_output: true, input });
  return input;
}
