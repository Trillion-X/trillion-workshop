import {
  createContentMediaWorkId,
  submitWorkflowAction,
  type ContentMediaSourceRef,
} from '../../content-media-evidence/do-work/content-media-work-loop';
import { inlineProcessSourceFromText } from '@bitfield/runtime-kit/protocol';

const MEDIA_IDENTITY_ACTION_ID = 'action:submit-media-identity-request';
const DEFAULT_TIMEOUT_MS = 300_000;

export type SubmitMediaIdentityRequest = {
  requestId?: string;
  source: ContentMediaSourceRef;
  identityProfileRef?: Record<string, unknown>;
  lanes?: Record<string, boolean>;
  requestedAt?: string;
  options?: Record<string, unknown>;
};

export type MediaIdentityWorkflowInput = {
  request_id: string;
  source: ContentMediaSourceRef;
  identity_profile_ref: Record<string, unknown>;
  lanes: Record<string, boolean>;
  options: Record<string, unknown>;
  requested_at: string;
};

function providerMissingScript(): string {
  return `#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PUBLISHED_PATH = ["current-item", "published-record"]


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def address_token(value: Any) -> str:
    raw = str(value) if value not in (None, "") else "media-identity"
    return "".join(ch if ch.isalnum() or ch in "._:-" else "_" for ch in raw)


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: missing-identity-provider.py <request-json> <output-json>")
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        request = json.load(handle)
    request_id = request.get("request_id") or "media-identity"
    source = request.get("source") if isinstance(request.get("source"), dict) else {}
    output = {
        "records": [
            {
                "address": f"package::media-identity::error::{address_token(request_id)}",
                "path": PUBLISHED_PATH,
                "payload": {
                    "kind": "media-identity.error",
                    "request_id": request_id,
                    "source_artifact_ref": source.get("artifact_ref") if isinstance(source, dict) else {},
                    "code": "media_identity_provider_missing",
                    "message": "Connect an identity provider before matching people or voices.",
                    "observed_at": request.get("requested_at") or now(),
                },
            }
        ]
    }
    Path(sys.argv[2]).parent.mkdir(parents=True, exist_ok=True)
    with open(sys.argv[2], "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
}

function providerMissingDescriptor(input: MediaIdentityWorkflowInput): Record<string, unknown> {
  return {
    argv: [
      'python3',
      'packages/media-identity/do-work/missing-identity-provider.py',
      'request.json',
      'command-output.json',
    ],
    cwd: null,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    termination_grace_ms: 1_000,
    expected_termination: null,
    env: {},
    inputs: [
      {
        mount_path: 'packages/media-identity/do-work/missing-identity-provider.py',
        content_type: 'text/x-python',
        source: inlineProcessSourceFromText(providerMissingScript()),
        executable: true,
      },
      {
        mount_path: 'request.json',
        content_type: 'application/json',
        source: inlineProcessSourceFromText(JSON.stringify(input)),
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

function configuredIdentityCommand(options?: Record<string, unknown>): Record<string, unknown> | null {
  const command = options?.identity_command;
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  const record = command as Record<string, unknown>;
  const descriptor = record.process_descriptor;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return null;
  return {
    process_descriptor: descriptor as Record<string, unknown>,
    process_profile: record.process_profile && typeof record.process_profile === 'object' && !Array.isArray(record.process_profile)
      ? record.process_profile
      : {},
  };
}

export function buildMediaIdentityInput(request: SubmitMediaIdentityRequest): MediaIdentityWorkflowInput {
  const requestId = request.requestId ?? createContentMediaWorkId('media-identity');
  const lanes = request.lanes ?? {
    signatures: true,
    clusters: true,
    matches: true,
  };
  const baseInput: MediaIdentityWorkflowInput = {
    request_id: requestId,
    source: request.source,
    identity_profile_ref: request.identityProfileRef ?? {
      kind: 'media-identity.profile-ref',
      profile_id: 'unassigned',
    },
    lanes,
    options: {},
    requested_at: request.requestedAt ?? new Date().toISOString(),
  };
  const identityCommand = configuredIdentityCommand(request.options) ?? {
    process_descriptor: providerMissingDescriptor(baseInput),
    process_profile: {
      provider: 'missing-identity-provider',
      runtime: 'compute.process',
      lanes,
    },
  };

  return {
    ...baseInput,
    options: {
      ...request.options,
      identity_command: identityCommand,
    },
  };
}

export async function submitMediaIdentityRequest(
  request: SubmitMediaIdentityRequest,
): Promise<MediaIdentityWorkflowInput> {
  const input = buildMediaIdentityInput(request);
  await submitWorkflowAction({
    definitionId: MEDIA_IDENTITY_ACTION_ID,
    input,
    includeSteps: true,
    includeOutput: true,
  });
  return input;
}
