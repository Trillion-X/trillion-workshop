/**
 * file: parts/record-video/do-work/recording-session-from-presentation-plan.mjs
 *
 * PURPOSE: The conversion build-recording-session-from-presentation-plan.mjs runs, as a function a screen can call:
 * one already-compiled video presentation plan becomes the recording-session DATA this package's capture surface reads
 * (read-data/recording-session.ts). The command-line script reads its files and calls this; Trillion's Record video
 * screen calls it with the plan it makes from a format's script.
 *
 * BOUNDARIES (unchanged from the script):
 * - This never opens a device and never treats plan existence as consent.
 * - It can stage an unauthorized session for review with auto_start = false.
 * - auto_start = true additionally requires a matching readiness result whose
 *   state is ready_to_authorize and a separate unexpired authorization grant.
 * - A format that gathers unpredictable answers cannot be flattened into a
 *   prewritten teleprompter session; it must fail explicitly.
 * - Every refusal throws an Error whose message says what is wrong with the plan.
 */

export function recordingSessionFromPlan({ plan, readiness = null, authorization = null, nowMs = Date.now() }) {
  if (!Number.isFinite(nowMs)) fail("now-ms must be a finite epoch millisecond value");
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("presentation plan must be an object");
  if (typeof plan.id !== "string" || !plan.id.trim()) fail("presentation plan needs an id");
  if (typeof plan.title !== "string" || !plan.title.trim()) fail("presentation plan needs a title");
  if (plan.medium !== "video") fail("only a video presentation plan can become a video recording session");
  if (plan.execution?.adapter !== "capture.video") {
    fail("presentation plan execution.adapter must be capture.video");
  }
  if (Array.isArray(plan.acquisitions) && plan.acquisitions.length > 0) {
    fail("a plan with open acquisitions must use its gathering format, not a prewritten teleprompter");
  }
  if (!Array.isArray(plan.beats) || plan.beats.length === 0) fail("presentation plan needs beats");
  if (plan.beats.some((beat) => beat?.delivery !== "speak")) {
    fail("every beat in a prewritten recording session must have delivery set to speak");
  }
  const sentences = plan.beats.map((beat) => {
    if (typeof beat?.text !== "string" || !beat.text.trim()) fail("every speak beat needs text");
    return beat.text.trim();
  });
  if (sentences.length === 0) fail("presentation plan has no speak beats");

  const countdownSeconds = nonNegativeNumber(plan.execution.countdown_seconds, "execution.countdown_seconds");
  const autoStopSeconds = nonNegativeNumber(
    plan.execution.auto_stop_seconds ?? 0,
    "execution.auto_stop_seconds",
  );
  const silenceStopSeconds = nonNegativeNumber(
    plan.execution.silence_stop_seconds ?? 0,
    "execution.silence_stop_seconds",
  );
  const silenceThresholdRms = positiveNumber(
    plan.execution.silence_threshold_rms ?? 0.02,
    "execution.silence_threshold_rms",
  );
  const minimumSpeechMs = nonNegativeNumber(
    plan.execution.minimum_speech_ms ?? 750,
    "execution.minimum_speech_ms",
  );
  const completionGraceMs = nonNegativeNumber(
    plan.execution.completion_grace_ms ?? 500,
    "execution.completion_grace_ms",
  );
  const readyToAuthorize = readiness !== null
    && readiness.plan_id === plan.id
    && readiness.state === "ready_to_authorize"
    && Array.isArray(readiness.problems)
    && readiness.problems.length === 0
    && Array.isArray(readiness.requirements)
    && readiness.requirements.every((requirement) => requirement?.satisfied === true);
  const authorizationClaimsCapture = authorization !== null && authorizationIsClaimed(authorization);
  const authorized = authorizationClaimsCapture && validAuthorization(authorization, plan.id, nowMs);
  if (authorizationClaimsCapture && (!readyToAuthorize || !authorized)) {
    fail("authorization is invalid unless fresh readiness is complete and the grant matches this plan and current time");
  }

  return {
    kind: "record-video.recording-session",
    session_id: `presentation-plan:${plan.id}`,
    title: plan.title,
    // A plan may say what it is about; otherwise the session names the format it came from, as the script did.
    subtitle: typeof plan.subtitle === "string" && plan.subtitle.trim() ? plan.subtitle.trim() : `Presentation format ${plan.format_id}`,
    capture_mode: "video",
    auto_start: authorized,
    countdown_seconds: countdownSeconds,
    auto_stop_seconds: autoStopSeconds,
    silence_stop_seconds: silenceStopSeconds,
    silence_threshold_rms: silenceThresholdRms,
    minimum_speech_ms: minimumSpeechMs,
    completion_reason_refs: plan.execution.completion_reason_refs,
    stop_on_final_word: plan.execution.stop_on_final_word === true,
    completion_grace_ms: completionGraceMs,
    completion_slack_words: nonNegativeNumber(plan.execution.completion_slack_words ?? 0, "execution.completion_slack_words"),
    script_end_quiet_seconds: nonNegativeNumber(plan.execution.script_end_quiet_seconds ?? 0, "execution.script_end_quiet_seconds"),
    stop_phrases: Array.isArray(plan.execution.stop_phrases) ? plan.execution.stop_phrases.filter((phrase) => typeof phrase === "string" && phrase.trim()) : [],
    mirror_script: plan.execution.mirror_script === true,
    speech_language: typeof plan.execution.speech_language === "string"
      ? plan.execution.speech_language
      : "en-US",
    follow_speech: plan.execution.follow_speech !== false,
    allow_manual_nudge: plan.execution.allow_manual_nudge !== false,
    status_label: authorized ? "Authorized speech follower" : "Waiting for setup and authorization",
    completion_label: typeof plan.execution.completion_label === "string"
      ? plan.execution.completion_label
      : "Recording saved",
    sentences,
    source_plan: {
      id: plan.id,
      material_id: plan.material_id ?? null,
      material_revision: plan.material_revision ?? null,
      format_id: plan.format_id ?? null,
      format_revision: plan.format_revision ?? null,
      revision: plan.revision ?? null,
    },
    requirements: Array.isArray(plan.requirements) ? plan.requirements : [],
    plan_capabilities: Array.isArray(plan.capabilities) ? plan.capabilities : [],
    readiness_state: readyToAuthorize ? "ready_to_authorize" : "awaiting_setup",
    authorization_state: authorized ? "authorized" : "not_authorized",
  };
}

/**
 * The presentation-readiness evaluator. It decides each plan requirement from the observations the setup pass made
 * (keyed by requirement key) and checks the plan's capabilities against the runtime capabilities the setup proved.
 * Its result has the shape recordingSessionFromPlan reads as `readiness`.
 * A requirement is satisfied when its observation is true, its method is one the requirement allows (when it names
 * any), it was observed no later than nowMs, and, when max_age_seconds > 0, it is no older than that.
 */
export function presentationReadinessFromObservations({ plan, observations = {}, capabilities = [], nowMs = Date.now() }) {
  if (!Number.isFinite(nowMs)) fail("now-ms must be a finite epoch millisecond value");
  if (!plan || typeof plan !== "object" || typeof plan.id !== "string" || !plan.id.trim()) {
    fail("presentation plan needs an id");
  }
  const requirements = (Array.isArray(plan.requirements) ? plan.requirements : []).map((requirement) => ({
    id: String(requirement?.id ?? ""),
    key: String(requirement?.key ?? ""),
    satisfied: requirementSatisfied(requirement, observations?.[requirement?.key], nowMs),
  }));
  const problems = [
    ...requirements
      .filter((requirement) => !requirement.satisfied)
      .map((requirement) => ({ kind: "requirement", id: requirement.id, key: requirement.key })),
    ...(Array.isArray(plan.capabilities) ? plan.capabilities : [])
      .filter((capability) => !capabilities.includes(capability))
      .map((capability) => ({ kind: "capability", id: String(capability) })),
  ];
  return {
    plan_id: plan.id,
    state: problems.length === 0 ? "ready_to_authorize" : "awaiting_setup",
    problems,
    requirements,
  };
}

function requirementSatisfied(requirement, observation, nowMs) {
  if (observation?.value !== true) return false;
  const methods = Array.isArray(requirement?.methods) ? requirement.methods : [];
  if (methods.length > 0 && !methods.includes(observation.method)) return false;
  const observedAtMs = Number(observation.observed_at_ms);
  if (!Number.isFinite(observedAtMs) || observedAtMs > nowMs) return false;
  const maxAgeSeconds = Number(requirement?.max_age_seconds ?? 0);
  return !(maxAgeSeconds > 0 && nowMs - observedAtMs > maxAgeSeconds * 1000);
}

function nonNegativeNumber(value, label) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${label} must be a non-negative finite number`);
  return parsed;
}

function positiveNumber(value, label) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${label} must be a positive finite number`);
  return parsed;
}

function validAuthorization(value, planId, currentMs) {
  return value?.plan_id === planId
    && value.authorized === true
    && Number.isFinite(Number(value.authorized_at_ms))
    && Number(value.authorized_at_ms) <= currentMs
    && Number.isFinite(Number(value.grant_until_ms))
    && currentMs < Number(value.grant_until_ms);
}

function authorizationIsClaimed(value) {
  return value?.authorized === true
    || Number.isFinite(Number(value?.authorized_at_ms))
    || Number.isFinite(Number(value?.grant_until_ms));
}

function fail(message) {
  throw new Error(message);
}
