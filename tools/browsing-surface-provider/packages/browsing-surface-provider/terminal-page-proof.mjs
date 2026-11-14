// packages/browsing-surface-provider/terminal-page-proof.mjs
//
// Pure terminal-proof decoder for a page hosted by a lifecycle-capable external
// browser provider. It performs no I/O and launches nothing. Its only job is to
// prevent a start acknowledgement, a foreign session, a truncated/invalid output
// blob, or evidence from the wrong origin from becoming browser completion.

export const TERMINAL_PAGE_PROOF_SCHEMA = 'browsing-surface-provider.terminal-page-proof';
export const SPATIAL_SOURCE_CAPTURE_RESPONSE_SCHEMA = 'browsing-surface-provider.spatial-source-capture.response';

export const TERMINAL_PAGE_PROOF_POLICY = Object.freeze({
  maximumSessionIdBytes: 1_024,
  maximumTerminalOutputBytes: 1_048_576,
  maximumPageEvidenceBytes: 16_777_216,
  maximumScreenshotBytes: 8_388_608,
});

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value) {
  return UTF8_ENCODER.encode(value).byteLength;
}

function invalid(reason) {
  return Object.freeze({ valid: false, reason });
}

function requireExpectedSessionId(value, policy) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || byteLength(value) > policy.maximumSessionIdBytes
  ) {
    return 'expected_session_id_invalid';
  }
  return null;
}

function requireAllowedOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username
    || parsed.password
    || parsed.origin !== value
  ) {
    return null;
  }
  return parsed;
}

function decodeTerminalOutput(value, policy) {
  if (value === undefined) return { text: null };
  if (!(value instanceof Uint8Array)) return { reason: 'terminal_output_not_bytes' };
  if (value.byteLength > policy.maximumTerminalOutputBytes) {
    return { reason: 'terminal_output_too_large' };
  }
  try {
    return { text: UTF8_DECODER.decode(value) };
  } catch {
    return { reason: 'terminal_output_not_utf8' };
  }
}

function base64ByteLength(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!BASE64_PATTERN.test(value)) return null;
  const unpadded = value.replace(/=+$/u, '');
  return Math.floor(unpadded.length * 3 / 4);
}

function validatePageEvidence(value, expectedSessionId, allowedOrigin, policy) {
  if (value === undefined) return { present: false };
  if (!isRecord(value)) return { reason: 'page_evidence_not_object' };
  if (value.schema !== TERMINAL_PAGE_PROOF_SCHEMA) return { reason: 'page_evidence_schema_mismatch' };
  if (value.session_id !== expectedSessionId) return { reason: 'page_evidence_session_mismatch' };

  const capture = value.capture;
  if (!isRecord(capture)) return { reason: 'page_capture_missing' };
  if (capture.schema !== SPATIAL_SOURCE_CAPTURE_RESPONSE_SCHEMA) {
    return { reason: 'page_capture_schema_mismatch' };
  }
  if (typeof capture.captured_at !== 'string' || capture.captured_at.length === 0) {
    return { reason: 'page_capture_timestamp_missing' };
  }

  const source = capture.source;
  if (!isRecord(source)) return { reason: 'page_source_missing' };
  if (typeof source.target_id !== 'string' || source.target_id.length === 0) {
    return { reason: 'page_target_identity_missing' };
  }
  if (typeof source.url !== 'string' || source.url.length === 0) {
    return { reason: 'page_url_missing' };
  }
  let sourceUrl;
  try {
    sourceUrl = new URL(source.url);
  } catch {
    return { reason: 'page_url_invalid' };
  }
  if (sourceUrl.username || sourceUrl.password || sourceUrl.origin !== allowedOrigin.origin) {
    return { reason: 'page_origin_mismatch' };
  }

  const screenshot = capture.screenshot;
  if (!isRecord(screenshot)) return { reason: 'page_screenshot_missing' };
  if (screenshot.format !== 'png') return { reason: 'page_screenshot_format_invalid' };
  if (screenshot.redaction !== 'sensitive-elements-masked-before-capture') {
    return { reason: 'page_screenshot_redaction_contract_invalid' };
  }
  const screenshotBytes = base64ByteLength(screenshot.data_base64);
  if (screenshotBytes === null || screenshotBytes <= 0 || screenshotBytes > policy.maximumScreenshotBytes) {
    return { reason: 'page_screenshot_invalid_or_too_large' };
  }

  let encoded;
  try {
    encoded = UTF8_ENCODER.encode(JSON.stringify(value));
  } catch {
    return { reason: 'page_evidence_not_serializable' };
  }
  if (encoded.byteLength === 0 || encoded.byteLength > policy.maximumPageEvidenceBytes) {
    return { reason: 'page_evidence_too_large' };
  }

  return {
    present: true,
    summary: Object.freeze({
      sessionId: expectedSessionId,
      origin: sourceUrl.origin,
      targetId: source.target_id,
      capturedAt: capture.captured_at,
    }),
  };
}

/**
 * Decode one terminal page-session proof.
 *
 * `valid: true` means the proof is admissible terminal evidence. It is not an
 * action-success claim: inspect `outcome`. Successful observation additionally
 * requires zero exit, same-session bounded capture evidence, and the exact
 * expected origin. A terminal failure is valid proof of failure, but still
 * requires terminal output or correlated page evidence.
 */
export function decodeTerminalPageSessionProof(input, policyOverride) {
  if (policyOverride !== undefined && !isRecord(policyOverride)) {
    return invalid('proof_policy_invalid');
  }
  const policy = { ...TERMINAL_PAGE_PROOF_POLICY, ...policyOverride };
  if (!isRecord(input)) return invalid('proof_input_not_object');

  const expectedSessionIdFailure = requireExpectedSessionId(input.expected_session_id, policy);
  if (expectedSessionIdFailure) return invalid(expectedSessionIdFailure);
  const allowedOrigin = requireAllowedOrigin(input.allowed_origin);
  if (!allowedOrigin) return invalid('allowed_origin_invalid');

  const snapshot = input.session_snapshot;
  if (!isRecord(snapshot)) return invalid('session_snapshot_missing');
  if (snapshot.session_id !== input.expected_session_id) {
    return invalid('session_snapshot_session_mismatch');
  }
  if (snapshot.state !== 'exited' && snapshot.state !== 'failed') {
    return invalid('session_state_not_terminal');
  }
  if (snapshot.state === 'exited' && !Number.isSafeInteger(snapshot.exit_code)) {
    return invalid('session_exit_code_missing');
  }

  const terminalOutput = decodeTerminalOutput(input.terminal_output_bytes, policy);
  if (terminalOutput.reason) return invalid(terminalOutput.reason);
  const pageEvidence = validatePageEvidence(
    input.page_evidence,
    input.expected_session_id,
    allowedOrigin,
    policy,
  );
  if (pageEvidence.reason) return invalid(pageEvidence.reason);
  if (terminalOutput.text === null && !pageEvidence.present) {
    return invalid('terminal_evidence_missing');
  }

  const succeeded = snapshot.state === 'exited' && snapshot.exit_code === 0;
  if (succeeded && !pageEvidence.present) return invalid('page_evidence_missing_for_success');

  const failureReason = typeof snapshot.failure_reason === 'string' && snapshot.failure_reason.length > 0
    ? snapshot.failure_reason
    : null;

  return Object.freeze({
    valid: true,
    outcome: succeeded ? 'succeeded' : 'failed',
    sessionId: input.expected_session_id,
    state: snapshot.state,
    exitCode: snapshot.state === 'exited' ? snapshot.exit_code : null,
    failureReason,
    terminalOutputText: terminalOutput.text,
    pageEvidence: pageEvidence.summary ?? null,
  });
}
