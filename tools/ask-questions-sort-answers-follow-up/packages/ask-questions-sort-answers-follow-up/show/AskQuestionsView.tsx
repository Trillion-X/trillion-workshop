// packages/ask-questions-sort-answers-follow-up/show/AskQuestionsView.tsx
//
// Entry View: reads the live `published-records` aggregate, decodes the
// question-type-capability registry + the question sequence this surface is
// DATA-bound to, and renders the FillSurface. Persists answers as EEAF facts on
// submit. All decoding is the pure read-data layer; all rendering/validation is
// the tested capture pipeline. This file is thin glue — it owns only the
// live-data read + submit wiring.
//
// Form binding (L069/L090): a surface names WHICH form it fills via `sequenceId`
// (fed from the placeable-surface config). When omitted, it falls back to the
// first sequence — the single-form case — so this stays backward-compatible.

import React from 'react';
import { useBitfieldData } from '@/packages/ask-questions-sort-answers-follow-up/.bitfield-entry-scope/ask-questions-sort-answers-follow-up/runtime-kit-react';
import { FillSurface, type FillResult } from '@/packages/ask-questions-sort-answers-follow-up/show/FillSurface';
import {
  readCapabilityRegistry,
  readFirstQuestionSequence,
  readQuestionSequenceById,
} from '@/packages/ask-questions-sort-answers-follow-up/read-data/read-forms-data';
import { readDecideConfig } from '@/packages/ask-questions-sort-answers-follow-up/read-data/read-decide-config';
import { processSubmission } from '@/packages/ask-questions-sort-answers-follow-up/do-work/process-submission';
import { runAfterSavedActions } from '@/packages/ask-questions-sort-answers-follow-up/do-work/run-after-saved-actions';
import { resolveRespondentIdNow, freshRespondentId } from '@/packages/ask-questions-sort-answers-follow-up/read-data/current-respondent';
import type { DraftCorrelation, RequestEvidenceReference } from '../../../read-data/evidence-reference';
import type { ProcessSubmissionOutcome } from '@/packages/ask-questions-sort-answers-follow-up/do-work/process-submission';
import type { QuestionSequence } from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-descriptor';

export interface AskQuestionsViewProps {
  /** The form this surface fills, by `formId`. Omitted → first sequence. */
  sequenceId?: string;
  /** Explicit respondent identity, DATA-bound from the surface config. Omitted →
   *  the signed-in student is resolved, else a stable per-device id — so a
   *  student's repeated sessions group under ONE respondent (per-student
   *  progress can then fold). See `read-data/current-respondent.ts`. */
  respondentId?: string;
  /** Optional active run identity used to resolve DATA-authored post-save refs. */
  runId?: string;
  /** The containing owner chooses the source; correlation does not grant access. */
  onRequestEvidenceReference?: RequestEvidenceReference;
}

type SavedSubmission = {
  answers: Readonly<Record<string, unknown>>;
  outcome: ProcessSubmissionOutcome;
  respondentId: string;
};

/** The distinct feed input names a sequence DATA-binds (suggestions/options),
 *  in a stable order — the ONLY thing this package knows about feed sources. */
function readSuggestionInputNames(sequence: QuestionSequence | null): string[] {
  if (!sequence) return [];
  const names = new Set<string>();
  for (const question of sequence.questions) {
    const bindings = [question.suggestion_source, question.options_source];
    for (const binding of bindings) {
      if (binding && typeof binding.input_name === 'string' && binding.input_name.length > 0) {
        names.add(binding.input_name);
      }
    }
  }
  return [...names].sort();
}

/** One mounted reader per DATA-bound input name: resolves the feed through the
 *  EXISTING bitfield-input-descriptor path and reports the current value up.
 *  Keyed by input name so each child owns exactly one stable hook call. */
function SuggestionFeedReader({
  inputName,
  onValue,
}: {
  inputName: string;
  onValue: (inputName: string, value: unknown) => void;
}) {
  const value = useBitfieldData(inputName);
  React.useEffect(() => {
    onValue(inputName, value);
  }, [inputName, value, onValue]);
  return null;
}

export function AskQuestionsView({ sequenceId, respondentId, runId, onRequestEvidenceReference }: AskQuestionsViewProps = {}) {
  const published = useBitfieldData('published-records');
  const registry = React.useMemo(() => readCapabilityRegistry(published), [published]);
  const sequence = React.useMemo(
    () => readQuestionSequenceById(published, sequenceId) ?? readFirstQuestionSequence(published),
    [published, sequenceId],
  );
  // Scope the DECIDE rules to THIS form (form-scoped + global rules), so a
  // form's score/segment rules never mis-segment another form (L090).
  const decideConfig = React.useMemo(
    () => readDecideConfig(published, sequence?.formId),
    [published, sequence?.formId],
  );

  const [submitted, setSubmitted] = React.useState(false);
  const [result, setResult] = React.useState<FillResult | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [suggestionFeeds, setSuggestionFeeds] = React.useState<Record<string, unknown>>({});
  const savedSubmissionRef = React.useRef<SavedSubmission | null>(null);
  const draftRef = React.useRef<{ key: string; promise: Promise<DraftCorrelation> } | null>(null);
  const scopeEpoch = React.useRef(0);
  const submittingRef = React.useRef(false);
  const ensureDraft = async (): Promise<DraftCorrelation> => {
    if (!sequence) throw new Error('Form is unavailable');
    const key = JSON.stringify([sequence.formId, respondentId ?? null, runId ?? null]);
    if (draftRef.current?.key !== key) {
      const submissionId = `submission:${freshRespondentId()}`;
      const promise = resolveRespondentIdNow(respondentId).then(resolved => ({
        formId: sequence.formId, respondentId: resolved, draftId: submissionId, submissionId,
      }));
      draftRef.current = { key, promise };
      void promise.catch(() => {
        if (draftRef.current?.promise === promise) draftRef.current = null;
      });
    }
    return draftRef.current.promise;
  };
  React.useEffect(() => {
    scopeEpoch.current += 1;
    submittingRef.current = false;
    savedSubmissionRef.current = null;
    setSubmitted(false);
    setResult(null);
    setErrorMessage(null);
    return () => { scopeEpoch.current += 1; };
  }, [sequence?.formId, respondentId, runId]);
  const feedInputNames = React.useMemo(() => readSuggestionInputNames(sequence), [sequence]);

  const handleFeedValue = React.useCallback((inputName: string, value: unknown) => {
    setSuggestionFeeds((prev) =>
      Object.prototype.hasOwnProperty.call(prev, inputName) && prev[inputName] === value
        ? prev
        : { ...prev, [inputName]: value },
    );
  }, []);

  // Drop stale feed values when the sequence (or its DATA bindings) change:
  // only currently-bound input names may influence the surface.
  const activeFeeds = React.useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const name of feedInputNames) {
      if (Object.prototype.hasOwnProperty.call(suggestionFeeds, name)) {
        out[name] = suggestionFeeds[name];
      }
    }
    return out;
  }, [feedInputNames, suggestionFeeds]);

  const handleSubmit = async (answers: Record<string, unknown>) => {
    if (!sequence || submittingRef.current) return;
    submittingRef.current = true;
    const epoch = scopeEpoch.current;
    try {
      setErrorMessage(null);
      // Resolve the STABLE respondent identity (signed-in student → per-device
      // fallback), so this student's sessions group under one respondent.
      const saved = savedSubmissionRef.current ?? await (async (): Promise<SavedSubmission> => {
        const draft = await ensureDraft();
        const resolvedRespondentId = draft.respondentId;
      // Atomically persist answers + the score/segment decision, then the
      // returned follow-up sequence is handed to the workflow slot to run.
        const outcome = await processSubmission(sequence.formId, resolvedRespondentId, answers, decideConfig, new Date().toISOString(), draft.submissionId);
        return { answers, outcome, respondentId: resolvedRespondentId };
      })();
      if (epoch !== scopeEpoch.current) return;
      savedSubmissionRef.current = saved;
      await runAfterSavedActions({
        answers: saved.answers,
        respondentId: saved.respondentId,
        runId,
        sequence,
      });
      if (epoch !== scopeEpoch.current) return;
      // Show the respondent THEIR OWN verdict — the exercise ends in insight,
      // not a generic receipt. The decision is already computed in the batch; the
      // matched segment-rule carries the DATA-supplied meaning + next step.
      const matched = decideConfig.segmentRules.find((r) => r.segmentId === saved.outcome.decision.segmentId);
      setResult({
        segmentId: saved.outcome.decision.segmentId,
        score: saved.outcome.decision.score,
        title: matched?.title,
        meaning: matched?.meaning,
        nextStep: matched?.nextStep,
      });
      savedSubmissionRef.current = null;
      setSubmitted(true);
    } catch (e) {
      if (epoch === scopeEpoch.current) setErrorMessage(e instanceof Error ? e.message : 'Could not save your answers');
    } finally {
      if (epoch === scopeEpoch.current) submittingRef.current = false;
    }
  };

  return (
    <>
      {feedInputNames.map((inputName) => (
        <SuggestionFeedReader key={inputName} inputName={inputName} onValue={handleFeedValue} />
      ))}
      <FillSurface
        key={JSON.stringify([sequence?.formId, respondentId, runId])}
        sequence={sequence}
        registry={registry}
        submitted={submitted}
        result={result}
        errorMessage={errorMessage}
        suggestionFeeds={activeFeeds}
        requestQuestionValue={onRequestEvidenceReference ? async questionId => {
          const epoch = scopeEpoch.current;
          const draft = await ensureDraft();
          if (epoch !== scopeEpoch.current) return undefined;
          return onRequestEvidenceReference({ ...draft, questionId });
        } : undefined}
        onSubmit={handleSubmit}
      />
    </>
  );
}
