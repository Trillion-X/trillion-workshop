import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { inlineProcessSourceFromText } from '@bitfield/runtime-kit/protocol';

const SPEECH_GENERATION_ACTION_ID = 'action:submit-speech-generation-request';
const DEFAULT_TIMEOUT_MS = 300_000;

export type SpeechVoiceProfileRecord = {
  kind?: string;
  profile_ref?: string;
  display_name?: string;
  approval_evidence_ref?: string;
  approval_status?: string;
  approval_valid_until?: string;
  consent_evidence_ref?: string;
  consent_status?: string;
  reference_artifact_refs?: Array<Record<string, unknown>>;
  profile_metadata?: Record<string, unknown>;
};

export type SubmitSpeechGenerationRequest = {
  requestId?: string;
  text: string;
  voiceProfile: SpeechVoiceProfileRecord;
  requestedAt?: string;
  options?: Record<string, unknown>;
};

export type SpeechGenerationWorkflowInput = {
  request_id: string;
  text: string;
  voice_profile_ref: string;
  voice_profile_approval_ref: string;
  voice_profile_consent_ref: string;
  reference_artifact_refs: Array<Record<string, unknown>>;
  options: Record<string, unknown>;
  requested_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeToken(value: string): string {
  const token = value.trim().replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return token || 'speech-generation';
}

function createSpeechGenerationRequestId(): string {
  return safeToken(`speech-generation:${globalThis.crypto.randomUUID()}`);
}

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
    raw = str(value) if value not in (None, "") else "speech-generation"
    return "".join(ch if ch.isalnum() or ch in "._:-" else "_" for ch in raw)


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: missing-speech-provider.py <request-json> <output-json>")
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        request = json.load(handle)
    request_id = request.get("request_id") or "speech-generation"
    output = {
        "records": [
            {
                "address": f"package::speech-generation::error::{address_token(request_id)}",
                "path": PUBLISHED_PATH,
                "payload": {
                    "kind": "speech-generation.error",
                    "request_id": request_id,
                    "voice_profile_ref": request.get("voice_profile_ref"),
                    "voice_profile_approval_ref": request.get("voice_profile_approval_ref"),
                    "code": "speech_generation_provider_missing",
                    "message": "Save a voice with a speech provider before making audio.",
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

function commandFromVoiceProfile(profile: SpeechVoiceProfileRecord): Record<string, unknown> | null {
  const metadata = profile.profile_metadata;
  const command = isRecord(metadata) ? metadata.speech_command : null;
  if (!isRecord(command) || !isRecord(command.process_descriptor)) return null;
  return {
    process_descriptor: command.process_descriptor,
    process_profile: isRecord(command.process_profile) ? command.process_profile : {},
  };
}

function providerMissingDescriptor(input: SpeechGenerationWorkflowInput): Record<string, unknown> {
  return {
    argv: [
      'python3',
      'packages/speech-generation/do-work/missing-speech-provider.py',
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
        mount_path: 'packages/speech-generation/do-work/missing-speech-provider.py',
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

export function buildSpeechGenerationInput(
  request: SubmitSpeechGenerationRequest,
): SpeechGenerationWorkflowInput {
  const requestId = request.requestId ?? createSpeechGenerationRequestId();
  const requestedAt = request.requestedAt ?? new Date().toISOString();
  const voiceProfileRef = request.voiceProfile.profile_ref?.trim();
  const approvalRef = request.voiceProfile.approval_evidence_ref?.trim();
  const consentRef = request.voiceProfile.consent_evidence_ref?.trim();
  const approvalValidUntil = request.voiceProfile.approval_valid_until?.trim();

  if (
    !voiceProfileRef
    || !approvalRef
    || request.voiceProfile.approval_status !== 'approved'
    || !approvalValidUntil
    || !consentRef
    || request.voiceProfile.consent_status !== 'consented'
  ) {
    throw new Error("Save a voice with The owner's standing approval and consent evidence before making audio.");
  }
  const requestedAtMs = Date.parse(requestedAt);
  const approvalValidUntilMs = Date.parse(approvalValidUntil);
  if (
    !Number.isFinite(requestedAtMs)
    || !Number.isFinite(approvalValidUntilMs)
    || approvalValidUntilMs <= requestedAtMs
  ) {
    throw new Error('Voice approval is stale; renew approval before making audio.');
  }

  const baseInput: SpeechGenerationWorkflowInput = {
    request_id: requestId,
    text: request.text.trim(),
    voice_profile_ref: voiceProfileRef,
    voice_profile_approval_ref: approvalRef,
    voice_profile_consent_ref: consentRef,
    reference_artifact_refs: request.voiceProfile.reference_artifact_refs ?? [],
    options: {},
    requested_at: requestedAt,
  };
  const profileCommand = commandFromVoiceProfile(request.voiceProfile);
  const speechCommand = profileCommand ?? {
    process_descriptor: providerMissingDescriptor(baseInput),
    process_profile: {
      provider: 'missing-speech-provider',
      runtime: 'compute.process',
    },
  };

  return {
    ...baseInput,
    options: {
      ...request.options,
      language: request.options?.language ?? request.voiceProfile.profile_metadata?.language ?? 'und',
      format: request.options?.format ?? request.voiceProfile.profile_metadata?.format ?? 'audio/unknown',
      speech_command: speechCommand,
      request_token: safeToken(requestId),
    },
  };
}

export async function submitSpeechGenerationRequest(
  request: SubmitSpeechGenerationRequest,
): Promise<SpeechGenerationWorkflowInput> {
  const input = buildSpeechGenerationInput(request);
  await sendRequestToBitfieldTarget(buildSpeechGenerationWorkflowRequest(input));
  return input;
}

export function buildSpeechGenerationWorkflowRequest(input: SpeechGenerationWorkflowInput) {
  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: SPEECH_GENERATION_ACTION_ID,
      input,
      include_steps: true,
      include_output: true,
    },
  };
}
