// package-set://bitfield-studio/packages/customer-support/show/action-composer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A DATA-driven action composer. An action descriptor declares its copy rules;
// any rule whose source is `answers.<key>` means "the user must supply <key>
// before this action can run". This component reads those rules and renders one
// text field per answer key — so the support reply gets its body field, a triage
// note gets its note field, ANY future action gets its fields, all with ZERO
// code change here (the Generic / Data-Driven Gate, L063/L090).
//
// The composer is PURE: it never dispatches. It collects the user's answers and
// calls back `onSubmit(action, answers)`. The mount entry turns that into a live
// invocation (so this renderer stays blind and iOS-JSCore-safe — no browser
// globals, no transport).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Required inputs are DERIVED from copy DATA — never a hardcoded "reply has a
//    body" or any field name in code.
// 2. Field labels humanize the raw answer key (L098) — no raw ref leaks.
// 3. Composes shared `ui` only — no raw HTML, no className (L065/L066).
//
// =============================================================================

import React from 'react';
import { ActionControl, Card, Container, Textarea } from '@/packages/ui';
import type { WorkDescriptor } from '../read-data/record-work-graph';
import { humanizeToken } from './humanize';

const ANSWER_PREFIX = 'answers.';

/** The answer keys an action needs from the user, derived from its copy rules. */
export function answerKeysForAction(action: WorkDescriptor): string[] {
  const keys = (action.copy ?? [])
    .map((rule) => rule.from)
    .filter((from): from is string => !!from && from.startsWith(ANSWER_PREFIX))
    .map((from) => from.slice(ANSWER_PREFIX.length))
    .filter(Boolean);
  return Array.from(new Set(keys));
}

export type ActionAnswers = Record<string, string>;

export interface ActionComposerProps {
  action: WorkDescriptor;
  onSubmit: (action: WorkDescriptor, answers: ActionAnswers) => void;
  onCancel: () => void;
}

/** Collect the answers an action requires, then hand them back to be dispatched. */
export function ActionComposer({ action, onSubmit, onCancel }: ActionComposerProps): React.ReactElement {
  const keys = React.useMemo(() => answerKeysForAction(action), [action]);
  const [answers, setAnswers] = React.useState<ActionAnswers>({});
  const ready = keys.every((key) => (answers[key] ?? '').trim().length > 0);

  const setAnswer = (key: string, value: string) =>
    setAnswers((prev) => ({ ...prev, [key]: value }));

  return (
    <Card variant="nested" padding="md" layout="stack">
      {keys.map((key) => (
        <Textarea
          key={key}
          label={humanizeToken(key)}
          rows={4}
          value={answers[key] ?? ''}
          onChange={(event) => setAnswer(key, event.target.value)}
        />
      ))}
      <Container layout="horizontal" gap="sm" justifyContent="end" alignItems="center">
        <ActionControl variant="ghost" size="sm" onClick={onCancel}>Cancel</ActionControl>
        <ActionControl
          variant="primary"
          size="sm"
          disabled={!ready}
          onClick={() => onSubmit(action, answers)}
        >
          {action.label}
        </ActionControl>
      </Container>
    </Card>
  );
}

export default ActionComposer;
