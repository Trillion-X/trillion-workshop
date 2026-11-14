// package-set://bitfield-studio/packages/request-intake/show/RequestActionBar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders a row of owner actions from screen-model DATA and nothing else. It is
// the ONE place owner actions become buttons, so every workspace gets identical
// behaviour for free (L069): a usable action is a button; a disabled action is a
// button with a plain reason in a tooltip (never silently dead, L114/L118); an
// action that declares fields opens an inline composer that collects the typed
// answers before it leaves.
//
// The bar is blind to domain: it reads `RequestIntakeScreenAction` (label, helper,
// disabled, disabledReason, descriptor) and emits `(action, scope, answers)`. It
// never knows what a "request" is, never dispatches, never touches the runtime.
// Add an action row in DATA and a button appears here with zero change to this
// file (the Generic / Data-Driven Gate).
//
// =============================================================================

import { useState } from 'react';
import {
  ActionControl,
  Card,
  Container,
  Text,
  Textarea,
  Tooltip,
} from '@/packages/ui';
import type { RequestIntakeScreenAction } from '@/packages/request-intake/show/request-intake-screen-model';

// Which record / shape an action runs against. Generic UI terms only — the mount
// translates these ids into the runtime's ref vocabulary.
export interface RequestIntakeActionScope {
  recordId?: string;
  shapeId?: string;
}

// The surface stays blind: it receives the chosen action, the scope it was fired
// in, and any typed answers. Translation to runtime refs happens in the mount.
export type RequestIntakeActionHandler = (
  action: RequestIntakeScreenAction,
  scope: RequestIntakeActionScope,
  answers: Record<string, string>,
) => void;

interface RequestActionBarProps {
  actions: RequestIntakeScreenAction[];
  scope?: RequestIntakeActionScope;
  onAction?: RequestIntakeActionHandler;
  size?: 'sm' | 'md';
  align?: 'start' | 'end' | 'between';
}

// An action collects answers when its descriptor declares input fields. No field
// list -> it runs on click. This is data-driven: the fields come from the
// descriptor, never from a per-action branch here.
function answerFields(action: RequestIntakeScreenAction): Array<{ id: string; label: string }> {
  const fields = action.descriptor?.fields ?? [];
  return fields.map((field) => ({ id: field.id, label: field.label }));
}

function allRequiredAnswered(
  fields: Array<{ id: string; label: string }>,
  answers: Record<string, string>,
): boolean {
  return fields.every((field) => (answers[field.id] ?? '').trim().length > 0);
}

export function RequestActionBar({
  actions,
  scope = {},
  onAction,
  size = 'sm',
  align = 'start',
}: RequestActionBarProps): JSX.Element {
  // Which action's composer is open (only one at a time keeps the bar calm).
  const [composerId, setComposerId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const openComposer = (action: RequestIntakeScreenAction): void => {
    setComposerId(action.id);
    setAnswers({});
  };

  const closeComposer = (): void => {
    setComposerId(null);
    setAnswers({});
  };

  const runAction = (action: RequestIntakeScreenAction, withAnswers: Record<string, string>): void => {
    onAction?.(action, scope, withAnswers);
    closeComposer();
  };

  const handleClick = (action: RequestIntakeScreenAction): void => {
    if (action.disabled) return;
    if (answerFields(action).length > 0) {
      openComposer(action);
      return;
    }
    runAction(action, {});
  };

  const composerAction = composerId
    ? actions.find((action) => action.id === composerId) ?? null
    : null;
  const composerFields = composerAction ? answerFields(composerAction) : [];

  return (
    <Container layout="vertical" gap="sm">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent={align}>
        {actions.map((action) => {
          const control = (
            <ActionControl
              variant={action.disabled ? 'ghost' : 'primary'}
              size={size}
              disabled={action.disabled}
              onClick={() => handleClick(action)}
            >
              {action.label}
            </ActionControl>
          );
          if (action.disabled && action.disabledReason) {
            return (
              <Tooltip key={action.id} label={action.disabledReason} side="top">
                {control}
              </Tooltip>
            );
          }
          return <span key={action.id}>{control}</span>;
        })}
      </Container>

      {composerAction && composerFields.length > 0 ? (
        <Card variant="nested" padding="md" layout="stack">
          <Text variant="caption" color="muted">{composerAction.helper}</Text>
          {composerFields.map((field) => (
            <Textarea
              key={field.id}
              label={field.label}
              rows={4}
              value={answers[field.id] ?? ''}
              onChange={(event) =>
                setAnswers((prev) => ({ ...prev, [field.id]: event.target.value }))
              }
            />
          ))}
          <Container layout="horizontal" gap="sm" justifyContent="end">
            <ActionControl variant="ghost" size="sm" onClick={closeComposer}>
              Cancel
            </ActionControl>
            <ActionControl
              variant="primary"
              size="sm"
              disabled={!allRequiredAnswered(composerFields, answers)}
              onClick={() => runAction(composerAction, answers)}
            >
              {composerAction.label}
            </ActionControl>
          </Container>
        </Card>
      ) : null}
    </Container>
  );
}
