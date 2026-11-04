//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decode the optional founder-video teleprompter session input into a stable,
// package-local shape. The session is pure DATA: script text, auto-start/stop,
// countdown, and speech-follower preferences. The panel consumes this decoded
// shape; no runtime caller needs to know the standalone HTML tool's internals.
//
// =============================================================================
// NON-NEGOTIABLE INVARANTS
// =============================================================================
//
// 1. INPUT IS OPTIONAL: absent or malformed data yields `null`, so the package
//    falls back to the ordinary manual recorder instead of guessing.
// 2. SESSION SHAPE IS DATA-FIRST: auto-start/stop, countdown, language, and
//    script text all live in the decoded value, never hidden in component code.
// 3. TOKENIZATION IS SHARED: sentence and word boundaries used for rendering,
//    progress, and speech-follow alignment come from one decoder only.
// 4. ALIGNMENT NEVER JUMPS BACKWARD: heard words may advance the cursor but
//    never rewind it.
// 5. EVERY WAY A TAKE ENDS IS DATA: the final word (within `completion_slack_words`
//    of it, since a recognizer can miss the last word), then quiet for
//    `script_end_quiet_seconds` so the speaker's own words after the script are
//    kept; a stop phrase heard that the script itself does not say; silence; a
//    duration limit; or the person's own Stop. Each has its completion reason.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { CaptureDescriptorValue } from '../do-work/record-video-requests';

export const RECORDING_SESSION_INPUT = 'recording-session';
export const RECORDING_SESSION_VALUE_ADDRESS_LABEL = 'record-video-recording-session';
export const RECORDING_COMPLETION_REASON_REFS_INPUT = 'recordVideoCompletionReasonRefs';
export const RECORDING_CAPTURE_POLICY_INPUT = 'recordVideoCapturePolicy';

export type RecordingCapturePolicy = {
  maximumSampleGapMs: number;
  journalLeaseMs: number;
  journalHeartbeatMs: number;
};

export function decodeRecordingCapturePolicy(value: unknown): RecordingCapturePolicy {
  const record = isPlainRecord(value) ? value : {};
  const journalLeaseMs = readPositiveNumber(record, ['journal_lease_ms', 'journalLeaseMs'], 5_000);
  const requestedHeartbeatMs = readPositiveNumber(record, ['journal_heartbeat_ms', 'journalHeartbeatMs'], 1_000);
  return {
    maximumSampleGapMs: readPositiveNumber(record, ['maximum_sample_gap_ms', 'maximumSampleGapMs'], 500),
    journalLeaseMs,
    journalHeartbeatMs: Math.min(requestedHeartbeatMs, Math.max(1, Math.floor(journalLeaseMs / 2))),
  };
}

export type RecordingCompletionReasonRefs = RecordingTeleprompterSession['completionReasonRefs'];

export function decodeCompletionReasonRefs(value: unknown): RecordingCompletionReasonRefs {
  const reasonRefs = isPlainRecord(value) ? value : {};
  return {
    manual: readText(reasonRefs, ['manual'], 'capture-completion:operator-stop'),
    speech: readText(reasonRefs, ['speech'], 'capture-completion:confirmed-script-complete'),
    silence: readText(reasonRefs, ['silence'], 'capture-completion:measured-silence-after-speech'),
    duration: readText(reasonRefs, ['duration'], 'capture-completion:active-duration-limit'),
    providerEnd: readText(reasonRefs, ['provider_end', 'providerEnd'], 'capture-completion:provider-ended'),
    providerError: readText(reasonRefs, ['provider_error', 'providerError'], 'capture-completion:provider-error'),
    cancel: readText(reasonRefs, ['cancel'], 'capture-completion:operator-cancel'),
    phrase: readText(reasonRefs, ['phrase'], 'capture-completion:stop-phrase-heard'),
  };
}

export type RecordingSessionWord = {
  index: number;
  text: string;
  normalized: string;
  sentenceIndex: number;
};

export type RecordingSessionSentence = {
  id: string;
  text: string;
  wordStart: number;
  wordEnd: number;
};

export type RecordingTeleprompterSession = {
  sessionId: string;
  title: string;
  subtitle: string;
  captureMode: CaptureDescriptorValue;
  autoStart: boolean;
  countdownSeconds: number;
  autoStopSeconds: number;
  silenceStopSeconds: number;
  silenceThresholdRms: number;
  minimumSpeechMs: number;
  completionReasonRefs: {
    manual: string;
    speech: string;
    silence: string;
    duration: string;
    providerEnd: string;
    providerError: string;
    cancel: string;
    phrase: string;
  };
  stopOnFinalWord: boolean;
  completionGraceMs: number;
  /** Words short of the last one that still count as the script read to its end. */
  completionSlackWords: number;
  /** After the script is read: how long without a new word heard before the take stops (0: stop after the grace). */
  scriptEndQuietMs: number;
  /** Words that stop the take when heard ("I'm done"), unless the script itself says them. */
  stopPhrases: string[];
  /** Whether the script is drawn mirrored, for a teleprompter's glass. */
  mirrorScript: boolean;
  speechLanguage: string;
  followSpeech: boolean;
  allowManualNudge: boolean;
  completionLabel: string;
  statusLabel: string;
  readinessState: string;
  authorizationState: string;
  sourcePlanId: string | null;
  requirements: RecordingSessionRequirement[];
  planCapabilities: string[];
  sentences: RecordingSessionSentence[];
  words: RecordingSessionWord[];
};

export type RecordingSessionRequirement = {
  id: string;
  key: string;
  instruction: string;
  methods: string[];
  maxAgeSeconds: number;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readText(record: Record<string, unknown>, keys: readonly string[], fallback = ''): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

function readBoolean(record: Record<string, unknown>, keys: readonly string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
  }
  return fallback;
}

function readPositiveNumber(record: Record<string, unknown>, keys: readonly string[], fallback: number): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return fallback;
}

function readNonNegativeNumber(record: Record<string, unknown>, keys: readonly string[], fallback: number): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return fallback;
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]/g, '');
}

function levenshteinDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let previous = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const old = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        previous + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      previous = old;
    }
  }
  return row[right.length];
}

function similarToken(left: string, right: string): boolean {
  const normalizedLeft = normalizeToken(left);
  const normalizedRight = normalizeToken(right);
  return (
    normalizedLeft === normalizedRight
    || (
      Math.max(normalizedLeft.length, normalizedRight.length) >= 5
      && levenshteinDistance(normalizedLeft, normalizedRight) <= 1
    )
  );
}

function decodeSentenceTexts(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/\n+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((sentence, index) => {
      if (typeof sentence === 'string') return sentence.trim();
      if (!isPlainRecord(sentence)) return '';
      return readText(sentence, ['text', 'sentence_text', 'caption'], '').trim() || `Sentence ${index + 1}`;
    })
    .filter(Boolean);
}

function tokenizeSentences(sentenceTexts: readonly string[]): {
  sentences: RecordingSessionSentence[];
  words: RecordingSessionWord[];
} {
  const sentences: RecordingSessionSentence[] = [];
  const words: RecordingSessionWord[] = [];
  let globalWordIndex = 0;

  sentenceTexts.forEach((text, sentenceIndex) => {
    const tokens = text.split(/\s+/).map((token) => token.trim()).filter(Boolean);
    const wordStart = globalWordIndex;
    tokens.forEach((token) => {
      words.push({
        index: globalWordIndex,
        text: token,
        normalized: normalizeToken(token),
        sentenceIndex,
      });
      globalWordIndex += 1;
    });
    sentences.push({
      id: `sentence-${sentenceIndex + 1}`,
      text,
      wordStart,
      wordEnd: globalWordIndex,
    });
  });

  return { sentences, words };
}

export function decodeRecordingSession(value: unknown): RecordingTeleprompterSession | null {
  if (!isPlainRecord(value)) return null;
  const sentenceTexts = decodeSentenceTexts(value.sentences ?? value.script_text ?? value.scriptText ?? value.prompt_text);
  if (sentenceTexts.length === 0) return null;

  const { sentences, words } = tokenizeSentences(sentenceTexts);
  if (words.length === 0) return null;

  const reasonRefs = isPlainRecord(value.completion_reason_refs) ? value.completion_reason_refs : {};
  return {
    sessionId: readText(value, ['session_id', 'sessionId', 'id'], 'recording-session'),
    title: readText(value, ['title', 'label'], 'Recording'),
    subtitle: readText(value, ['subtitle', 'description'], 'Teleprompter session'),
    captureMode: readText(value, ['capture_mode', 'captureMode', 'mode'], 'video'),
    autoStart: readBoolean(value, ['auto_start', 'autoStart'], true),
    countdownSeconds: readPositiveNumber(value, ['countdown_seconds', 'countdownSeconds'], 3),
    autoStopSeconds: readNonNegativeNumber(value, ['auto_stop_seconds', 'autoStopSeconds', 'duration_seconds', 'durationSeconds'], 0),
    silenceStopSeconds: readNonNegativeNumber(value, ['silence_stop_seconds', 'silenceStopSeconds'], 0),
    silenceThresholdRms: readPositiveNumber(value, ['silence_threshold_rms', 'silenceThresholdRms'], 0.02),
    minimumSpeechMs: readNonNegativeNumber(value, ['minimum_speech_ms', 'minimumSpeechMs'], 750),
    completionReasonRefs: decodeCompletionReasonRefs(reasonRefs),
    stopOnFinalWord: readBoolean(value, ['stop_on_final_word', 'stopOnFinalWord'], false),
    completionGraceMs: readPositiveNumber(value, ['completion_grace_ms', 'completionGraceMs'], 500),
    completionSlackWords: readNonNegativeNumber(value, ['completion_slack_words', 'completionSlackWords'], 0),
    scriptEndQuietMs: readNonNegativeNumber(value, ['script_end_quiet_seconds', 'scriptEndQuietSeconds'], 0) * 1000,
    stopPhrases: Array.isArray(value.stop_phrases)
      ? value.stop_phrases.filter((phrase): phrase is string => typeof phrase === 'string' && comparableWords(phrase).length > 0)
      : [],
    mirrorScript: readBoolean(value, ['mirror_script', 'mirrorScript'], false),
    speechLanguage: readText(value, ['speech_language', 'speechLanguage', 'language'], 'en-US'),
    followSpeech: readBoolean(value, ['follow_speech', 'followSpeech'], true),
    allowManualNudge: readBoolean(value, ['allow_manual_nudge', 'allowManualNudge'], true),
    completionLabel: readText(value, ['completion_label', 'completionLabel'], 'Recording saved'),
    statusLabel: readText(value, ['status_label', 'statusLabel'], 'Speech follower'),
    readinessState: readText(value, ['readiness_state', 'readinessState'], 'unknown'),
    authorizationState: readText(value, ['authorization_state', 'authorizationState'], 'unknown'),
    sourcePlanId: isPlainRecord(value.source_plan)
      ? readText(value.source_plan, ['id'], '') || null
      : null,
    requirements: Array.isArray(value.requirements)
      ? value.requirements
        .filter(isPlainRecord)
        .map((requirement) => ({
          id: readText(requirement, ['id'], ''),
          key: readText(requirement, ['key'], ''),
          instruction: readText(requirement, ['instruction'], ''),
          methods: Array.isArray(requirement.methods)
            ? requirement.methods.filter((method): method is string => typeof method === 'string')
            : [],
          maxAgeSeconds: readNonNegativeNumber(requirement, ['max_age_seconds', 'maxAgeSeconds'], 0),
        }))
        .filter((requirement) => requirement.id && requirement.key)
      : [],
    planCapabilities: Array.isArray(value.plan_capabilities)
      ? value.plan_capabilities.filter((capability): capability is string => typeof capability === 'string')
      : [],
    sentences,
    words,
  };
}

export function activeSentenceIndexForCursor(
  session: RecordingTeleprompterSession,
  cursor: number,
): number {
  const safeCursor = Math.max(0, Math.min(session.words.length - 1, cursor));
  return session.sentences.findIndex((sentence) => safeCursor < sentence.wordEnd);
}

export function reachedScriptCompletion(
  session: RecordingTeleprompterSession,
  cursor: number,
): boolean {
  return session.stopOnFinalWord && cursor >= session.words.length - Math.min(session.completionSlackWords, session.words.length - 1);
}

/** Words as they are compared for a stop phrase: lower case letters, digits and apostrophes, punctuation dropped. */
function comparableWords(text: string): string[] {
  return text.toLocaleLowerCase().replace(/[’']/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * The stop phrase the newest words heard end on, or null. Only the last few words are looked at, so a phrase said
 * once earlier and talked past does not stop the take later, and a phrase the script itself says never stops it.
 */
export function heardStopPhrase(session: RecordingTeleprompterSession, heard: string): string | null {
  if (session.stopPhrases.length === 0) return null;
  const words = comparableWords(heard);
  const script = ` ${session.words.map((word) => comparableWords(word.text).join(' ')).join(' ')} `;
  for (const phrase of session.stopPhrases) {
    const wanted = comparableWords(phrase);
    const tail = words.slice(-(wanted.length + 2)).join(' ');
    if (` ${tail} `.includes(` ${wanted.join(' ')} `) && !script.includes(` ${wanted.join(' ')} `)) return phrase;
  }
  return null;
}

export function alignRecognizedWords(
  session: RecordingTeleprompterSession,
  cursor: number,
  recognitionBase: number,
  heardWords: readonly string[],
): number {
  let scan = Math.max(0, recognitionBase);
  for (const heardWord of heardWords) {
    let match = -1;
    for (let index = scan; index < Math.min(session.words.length, scan + 7); index += 1) {
      if (similarToken(heardWord, session.words[index]?.text ?? '')) {
        match = index;
        break;
      }
    }
    if (match >= 0) scan = match + 1;
  }
  return scan > cursor ? scan : cursor;
}
