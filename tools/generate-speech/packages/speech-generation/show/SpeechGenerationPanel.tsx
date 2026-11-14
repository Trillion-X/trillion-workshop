import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';

import {
  evidenceBlockerText,
  evidencePayloads,
  readEvidenceProjection,
} from '@/packages/content-media-evidence/read-data/content-media-evidence';
import {
  submitSpeechGenerationRequest,
  type SpeechVoiceProfileRecord,
} from '@/packages/speech-generation/do-work/submit-speech-generation';
import {
  OneStepAtATimeSurface,
  type OneStepAtATimeItem,
} from '@/packages/ui/show/one-step-at-a-time-surface';
import { TextWorkAction } from '@/packages/ui/show/text-work-action';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';

type SpeechRequest = {
  request_id?: string;
  text?: string;
  voice_profile_ref?: string;
  requested_at?: string;
};

type SpeechResult = {
  request_id?: string;
  voice_profile_ref?: string;
  language?: string;
  format?: string;
  duration_ms?: number;
  output_artifact_refs?: Array<{ role?: string; multihash?: string; cas_address?: string }>;
  completed_at?: string;
};

type SpeechError = {
  request_id?: string;
  code?: string;
  message?: string;
  observed_at?: string;
};

type PackageRow = { payload?: unknown };

export type SpeechGenerationPanelProps = {
  requests?: SpeechRequest[];
  results?: SpeechResult[];
  errors?: SpeechError[];
  voiceProfiles?: SpeechVoiceProfileRecord[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readVoiceProfiles(raw: unknown): SpeechVoiceProfileRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row: PackageRow) => row.payload)
    .filter((payload): payload is SpeechVoiceProfileRecord => (
      isRecord(payload)
      && payload.kind === 'speech-generation.voice-profile'
      && typeof payload.profile_ref === 'string'
      && typeof payload.approval_evidence_ref === 'string'
    ));
}

function formatDate(value?: string): string {
  if (!value) return 'time not saved';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function durationText(ms?: number): string {
  if (typeof ms !== 'number') return 'length not saved';
  return `${Math.round(ms / 1000)}s`;
}

function speechOutputText(result?: SpeechResult): string {
  return result?.output_artifact_refs?.length ? 'Voice audio saved.' : 'Saved audio location not shown.';
}

function requestItems(
  requests: readonly SpeechRequest[],
  results: readonly SpeechResult[],
): OneStepAtATimeItem[] {
  const resultIds = new Set(results.map((result) => result.request_id).filter(Boolean));
  return requests.slice(0, 4).map((request, index) => ({
    key: request.request_id ?? String(index),
    title: request.text?.slice(0, 90) || `Speech job ${index + 1}`,
    detail: `Voice selected · ${formatDate(request.requested_at)}`,
    badge: request.request_id && resultIds.has(request.request_id) ? 'Ready' : 'Working',
    tone: request.request_id && resultIds.has(request.request_id) ? 'success' : 'info',
  }));
}

function Details({
  results,
  errors,
  blockers,
}: {
  results: readonly SpeechResult[];
  errors: readonly SpeechError[];
  blockers: string[];
}) {
  return (
    <Container layout="vertical" gap="sm">
      {blockers.map((blocker, index) => (
        <Text key={`blocker-${index}`} variant="body-xs" color="warning">
          {blocker}
        </Text>
      ))}
      <Text variant="body-xs" color="faint">
        Finished speech: {results.length}. Needs attention: {errors.length}.
      </Text>
      {results.slice(0, 4).map((result, index) => (
        <Text key={`${result.request_id ?? 'result'}-${index}`} variant="body-xs" color="faint">
          Speech {index + 1}: {speechOutputText(result)}
        </Text>
      ))}
      {errors.slice(0, 4).map((error, index) => (
        <Text key={`${error.request_id ?? error.code ?? 'error'}-${index}`} variant="body-xs" color="error">
          Speech job {index + 1}: {error.message ?? error.code ?? 'needs attention'}
        </Text>
      ))}
    </Container>
  );
}

export function SpeechGenerationPanel({
  requests: requestProps,
  results: resultProps,
  errors: errorProps,
  voiceProfiles: voiceProfileProps,
}: SpeechGenerationPanelProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [submittedText, setSubmittedText] = React.useState<string | null>(null);
  const publishedRecords = useBitfieldData('published-records');
  const evidenceRows = useBitfieldData('contentMediaEvidence');
  const evidence = React.useMemo(
    () => readEvidenceProjection(evidenceRows, 'speech-generation'),
    [evidenceRows],
  );
  const liveRequests = evidencePayloads<SpeechRequest>(evidence, 'requests');
  const liveResults = evidencePayloads<SpeechResult>(evidence, 'results');
  const liveErrors = evidencePayloads<SpeechError>(evidence, 'errors');

  const requests = requestProps ?? liveRequests;
  const results = resultProps ?? liveResults;
  const errors = errorProps ?? liveErrors;
  const liveVoiceProfiles = React.useMemo(() => readVoiceProfiles(publishedRecords), [publishedRecords]);
  const voiceProfiles = voiceProfileProps ?? liveVoiceProfiles;
  const voiceProfile = voiceProfiles[0] ?? null;
  const latestResult = results[0];
  const blockers = evidence.blockers.map(evidenceBlockerText);
  const hasProblem = errors.length > 0 || blockers.length > 0;
  const hasVoice = Boolean(voiceProfile);
  const status = hasProblem ? 'Needs attention' : latestResult ? 'Ready' : requests.length ? 'Working' : hasVoice ? 'Ready to start' : 'Needs voice';
  const primaryValue = latestResult ? 'Ready' : requests.length ? 'Working' : hasVoice ? 'Type text' : 'Save voice';
  const primaryLabel = latestResult
    ? `${latestResult.format ?? 'Audio'} voice file is ready.`
    : isSubmitting
      ? 'Starting speech.'
      : requests.length
      ? 'Speech is being made.'
      : hasVoice
        ? 'Type what to say.'
        : 'Save a voice first.';

  const submitText = React.useCallback(async (text: string) => {
    if (!voiceProfile) {
      setLocalError('Save a voice first.');
      return;
    }
    setIsSubmitting(true);
    setLocalError(null);
    setSubmittedText(null);
    try {
      await submitSpeechGenerationRequest({ text, voiceProfile });
      setSubmittedText(text.slice(0, 80));
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error); console.error('[speech-generation] failed:', raw); setLocalError('Voice audio could not be started.');
    } finally {
      setIsSubmitting(false);
    }
  }, [voiceProfile]);

  const action = (
    <TextWorkAction
      busy={isSubmitting}
      disabled={!voiceProfile}
      disabledMessage={!voiceProfile ? 'Save a voice first.' : undefined}
      emptyTitle="Say this"
      emptyDetail={voiceProfile?.display_name ? `Using ${voiceProfile.display_name}.` : 'Type the words. Press one button.'}
      placeholder="Type what the voice should say."
      startLabel="Make voice audio"
      rejectMessage="Type the words first."
      successMessage={submittedText ? `Sent "${submittedText}".` : undefined}
      errorMessage={localError ?? undefined}
      onStart={submitText}
    />
  );

  return (
    <OneStepAtATimeSurface
      eyebrow="Voice audio"
      title="Make voice audio"
      status={status}
      statusTone={hasProblem ? 'warning' : latestResult ? 'success' : requests.length ? 'info' : hasVoice ? 'muted' : 'warning'}
      primaryValue={primaryValue}
      primaryLabel={primaryLabel}
      primaryDetail={latestResult ? `${durationText(latestResult.duration_ms)} · ${latestResult.language ?? 'language not saved'} · ${formatDate(latestResult.completed_at)}` : undefined}
      action={action}
      nextStep={latestResult ? 'Use the voice audio in a video, caption render, or publish run.' : requests.length ? 'Wait for the voice audio.' : hasVoice ? undefined : 'Save a voice profile, then type the words.'}
      itemsTitle="Speech jobs"
      items={requestItems(requests, results)}
      emptyTitle="Type words"
      emptyDetail="The newest voice job appears after Start."
      detailsTitle="More"
      details={<Details results={results} errors={errors} blockers={blockers} />}
    />
  );
}
