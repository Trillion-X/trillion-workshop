// packages/ask-questions-sort-answers-follow-up/show/FillSurface.tsx
//
// The CAPTURE surface: a thin React consumer of the pure capture-stage model.
// It owns only local answer state + the "reveal errors on submit" flag; ALL
// resolution/validation is `buildFillScreenModel` and ALL input rendering is
// `resolveInputComponent`. Composes ui only — zero inline styling, zero raw
// div/span (L065/L066). Full render-state matrix: loading / error / submitted /
// empty / questions.

import React, { useState } from 'react';
import { ClipboardList, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card } from '@/packages/ui/show/card/Card';
import { Container } from '@/packages/ui/show/container/container';
import { Text } from '@/packages/ui/show/text/Text';
import { Button } from '@/packages/ui/show/button/Button';
import { Badge } from '@/packages/ui/show/badge/Badge';
import { WorkStartState, WorkSkeletonRows } from '@/packages/ui/show/work-start-state/WorkStartState';

import {
  buildFillScreenModel,
  type FillScreenModel,
} from '@/packages/ask-questions-sort-answers-follow-up/read-data/fill-screen-model';
import { resolveInputComponent } from '@/packages/ask-questions-sort-answers-follow-up/show/inputs';
import { coerceAnswer } from '@/packages/ask-questions-sort-answers-follow-up/read-data/validate-answer';
import type {
  QuestionSequence,
  QuestionTypeCapability,
} from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-descriptor';

/** The respondent's own computed outcome, shown back to them after they submit —
 *  so a guided exercise ENDS in insight ("here is where your answers point"),
 *  not a generic "we'll be in touch". `segmentId` is the DATA-driven verdict key
 *  (no closed enum); humanised for display. */
export interface FillResult {
  segmentId: string | null;
  score: number;
  title?: string;
  meaning?: string;
  nextStep?: string;
}

export interface FillSurfaceProps {
  requestQuestionValue?: (questionId: string) => unknown | Promise<unknown>;
  sequence: QuestionSequence | null;
  registry: Map<string, QuestionTypeCapability> | Readonly<Record<string, QuestionTypeCapability>>;
  loading?: boolean;
  errorMessage?: string | null;
  submitted?: boolean;
  /** The respondent's verdict, shown in the submitted state. Omitted → the plain
   *  saved-confirmation (forms with no score/segment rules). */
  result?: FillResult | null;
  /** Current named suggestion-feed rows (input_name → value), resolved by the
   *  entry view through the existing bitfield-input-descriptor path. Absent or
   *  empty feeds render NO chips — never fallback constants. */
  suggestionFeeds?: Readonly<Record<string, unknown>>;
  /** Receives the coerced answers keyed by questionId when the form is valid. */
  onSubmit?: (answers: Record<string, unknown>) => void;
}

/** kebab/snake verdict key → human sentence-case ("promising-domain-found" →
 *  "Promising Domain Found"). Presentational only; the key stays the DATA SSOT. */
function humanizeSegment(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function coerceAll(model: FillScreenModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of model.rows) {
    out[row.descriptor.questionId] = coerceAnswer(row.value, row.coerce).value;
  }
  return out;
}

export function FillSurface({
  sequence,
  registry,
  loading,
  errorMessage,
  submitted,
  result,
  suggestionFeeds,
  requestQuestionValue,
  onSubmit,
}: FillSurfaceProps) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [revealErrors, setRevealErrors] = useState(false);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);

  React.useEffect(() => {
    setAnswers({});
    setRevealErrors(false);
    setCurrentQuestionIndex(0);
  }, [sequence?.formId]);

  if (loading) {
    return (
      <Card padding="lg">
        <WorkSkeletonRows rows={4} />
      </Card>
    );
  }

  if (errorMessage) {
    return (
      <Card padding="lg">
        <WorkStartState
          icon={AlertTriangle}
          title="This form couldn't load"
          description={errorMessage}
        />
      </Card>
    );
  }

  if (submitted) {
    return (
      <Card padding="lg">
        <Container gap="lg" alignItems="stretch">
          <WorkStartState
            icon={CheckCircle2}
            title="Got it"
            description={
              result?.segmentId
                // Nothing gets in touch. The old line promised an email that no
                // part of this product sends, so it read as a dead end to
                // everyone who finished the form and then sat there waiting.
                ? 'Here is where your answers point.'
                : 'Your answers are in the conversation. Keep going there.'
            }
          />
          {result?.segmentId ? (
            <Container gap="md" alignItems="stretch">
              <Container gap="sm" alignItems="stretch">
                <Text variant="label" color="muted">Where this points</Text>
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <Badge variant="accent" size="lg">
                    {result.title ?? humanizeSegment(result.segmentId)}
                  </Badge>
                  <Text variant="body-sm" color="muted">{`Score ${result.score}`}</Text>
                </Container>
              </Container>
              {result.meaning ? (
                <Text variant="body" color="muted">{result.meaning}</Text>
              ) : null}
              {result.nextStep ? (
                <Container gap="xs" alignItems="stretch">
                  <Text variant="label" color="muted">Your next step</Text>
                  <Text variant="body">{result.nextStep}</Text>
                </Container>
              ) : null}
            </Container>
          ) : null}
        </Container>
      </Card>
    );
  }

  if (!sequence || sequence.questions.length === 0) {
    return (
      <Card padding="lg">
        <WorkStartState
          icon={ClipboardList}
          title="No questions yet"
          description="This form doesn't have any questions to answer."
        />
      </Card>
    );
  }

  const onePromptAtATime = sequence.presentation?.mode === 'one-prompt-at-a-time';
  const boundedQuestionIndex = Math.min(currentQuestionIndex, sequence.questions.length - 1);
  const visibleQuestions = onePromptAtATime
    ? [sequence.questions[boundedQuestionIndex]]
    : sequence.questions;
  const model = buildFillScreenModel(visibleQuestions, registry, answers, {
    revealErrors,
    suggestionFeeds,
  });

  const setAnswer = (questionId: string, value: unknown) =>
    setAnswers((prev) => ({ ...prev, [questionId]: value }));

  const handleSubmit = () => {
    setRevealErrors(true);
    const checked = buildFillScreenModel(sequence.questions, registry, answers, {
      revealErrors: true,
    });
    if (checked.allValid && onSubmit) onSubmit(coerceAll(checked));
  };

  const handleNextPrompt = () => {
    setRevealErrors(true);
    const checked = buildFillScreenModel(visibleQuestions, registry, answers, {
      revealErrors: true,
    });
    if (!checked.allValid) return;
    setRevealErrors(false);
    setCurrentQuestionIndex((index) => Math.min(index + 1, sequence.questions.length - 1));
  };

  const isFinalPrompt = boundedQuestionIndex === sequence.questions.length - 1;

  return (
    <Card padding="lg">
      <Container
        as="form"
        gap="lg"
        alignItems="stretch"
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <Text variant="heading-md">{sequence.title}</Text>

        {model.rows.map((row) => {
          const Input = resolveInputComponent(row.inputComponentKey);
          return (
            <Container key={`${sequence.formId}:${row.descriptor.questionId}`} gap="xs" alignItems="stretch">
              {row.suggestions.length > 0 ? (
                <Container layout="horizontal" gap="xs" alignItems="center" wrap="wrap">
                  {row.suggestions.map((suggestion) => (
                    <Button
                      key={suggestion.value}
                      type="button"
                      variant="secondary"
                      size="sm"
                      aria-label={`Suggest: ${suggestion.label}`}
                      onClick={() => setAnswer(row.descriptor.questionId, suggestion.value)}
                    >
                      {suggestion.label}
                    </Button>
                  ))}
                </Container>
              ) : null}
              <Input
                questionId={row.descriptor.questionId}
                label={row.descriptor.label}
                value={row.value}
                options={row.resolvedOptions}
                required={row.descriptor.required}
                placeholder={row.descriptor.placeholder}
                min={row.rules.min}
                max={row.rules.max}
                coerce={row.coerce}
                error={row.error}
                onChange={(v) => setAnswer(row.descriptor.questionId, v)}
                requestValue={requestQuestionValue ? () => requestQuestionValue(row.descriptor.questionId) : undefined}
              />
            </Container>
          );
        })}

        {onePromptAtATime ? (
          <Container layout="horizontal" gap="sm" alignItems="center">
            {boundedQuestionIndex > 0 ? (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={() => {
                  setRevealErrors(false);
                  setCurrentQuestionIndex((index) => Math.max(0, index - 1));
                }}
              >
                {sequence.presentation?.backLabel ?? 'Back'}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="primary"
              size="lg"
              onClick={isFinalPrompt ? handleSubmit : handleNextPrompt}
              disabled={revealErrors && !model.allValid}
            >
              {isFinalPrompt
                ? sequence.presentation?.submitLabel ?? 'Submit'
                : sequence.presentation?.nextLabel ?? 'Next'}
            </Button>
          </Container>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={handleSubmit}
            disabled={revealErrors && !model.allValid}
          >
            Submit
          </Button>
        )}
      </Container>
    </Card>
  );
}
