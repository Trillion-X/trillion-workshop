// packages/ask-questions-sort-answers-follow-up/show/BuilderSurface.tsx
//
// The builder surface: a DATA editor over a draft question-sequence. Every edit
// goes through the pure builder-model ops; Save persists the SAME record the
// fill side reads (L097). A live preview reuses the FillSurface so the operator
// sees exactly what respondents will. Composes ui only — zero inline styling,
// zero raw div/span. Render-state matrix: empty draft / questions / saving /
// saved / error.

import React from 'react';
import { ListChecks } from 'lucide-react';
import { ExpandableTabs } from '@/packages/ui/show/expandable-tabs';
import { Card } from '@/packages/ui/show/card/Card';
import { Container } from '@/packages/ui/show/container/container';
import { Text } from '@/packages/ui/show/text/Text';
import { Button } from '@/packages/ui/show/button/Button';
import { Input } from '@/packages/ui/show/input/Input';
import { SegmentedControl } from '@/packages/ui/show/segmented-control/SegmentedControl';
import { WorkStartState } from '@/packages/ui/show/work-start-state/WorkStartState';
import { FillSurface } from '@/packages/ask-questions-sort-answers-follow-up/show/FillSurface';
import {
  newQuestion,
  newQuestionSequence,
  addQuestion,
  removeQuestion,
  updateQuestion,
  moveQuestion,
  setTitle,
} from '@/packages/ask-questions-sort-answers-follow-up/read-data/builder-model';
import { saveQuestionSequence } from '@/packages/ask-questions-sort-answers-follow-up/do-work/save-question-sequence';
import type {
  QuestionSequence,
  QuestionTypeCapability,
} from '@/packages/ask-questions-sort-answers-follow-up/read-data/question-descriptor';

type Registry =
  | Map<string, QuestionTypeCapability>
  | Readonly<Record<string, QuestionTypeCapability>>;

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `q-${Date.now().toString(36)}`;
}

function registryItems(registry: Registry): { id: string; label: string }[] {
  const caps = registry instanceof Map ? [...registry.values()] : Object.values(registry);
  return caps.map((c) => ({ id: c.questionTypeId, label: c.label ?? c.questionTypeId }));
}

export interface BuilderSurfaceProps {
  registry: Registry;
  initialSequence?: QuestionSequence;
  onSaved?: (seq: QuestionSequence) => void;
}

export function BuilderSurface({ registry, initialSequence, onSaved }: BuilderSurfaceProps) {
  const typeItems = registryItems(registry);
  const [draft, setDraft] = React.useState<QuestionSequence>(
    () => initialSequence ?? newQuestionSequence(newId(), 'Untitled form'),
  );
  const [newType, setNewType] = React.useState(typeItems[0]?.id ?? 'text');
  const [newLabel, setNewLabel] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const touch = () => {
    setSaved(false);
    setError(null);
  };

  const handleAdd = () => {
    const label = newLabel.trim();
    if (!label) return;
    setDraft((d) => addQuestion(d, newQuestion(newId(), newType, label)));
    setNewLabel('');
    touch();
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveQuestionSequence(draft);
      setSaved(true);
      onSaved?.(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the form');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container layout="vertical" gap="lg" alignItems="stretch">
      <Card padding="lg">
        <Container layout="vertical" gap="md" alignItems="stretch">
          <Input
            label="Form title"
            value={draft.title}
            onChange={(e) => {
              setDraft((d) => setTitle(d, e.target.value));
              touch();
            }}
          />

          <Container layout="vertical" gap="sm" alignItems="stretch">
            <Text variant="label">Add a question</Text>
            <SegmentedControl
              ariaLabel="Question type"
              value={newType}
              items={typeItems}
              onValueChange={setNewType}
            />
            <Container layout="horizontal" gap="sm" alignItems="end" justifyContent="between">
              <Input
                label="Question label"
                value={newLabel}
                placeholder="e.g. What's your experience level?"
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <Button variant="primary" onClick={handleAdd} disabled={newLabel.trim() === ''}>
                Add
              </Button>
            </Container>
          </Container>

          {draft.questions.length === 0 ? (
            <WorkStartState
              icon={ListChecks}
              title="Add your first question"
              description="Pick a type, name the question, and press Add — it appears in the preview below."
            />
          ) : (
            <Container layout="vertical" gap="sm" alignItems="stretch">
              {draft.questions.map((q, i) => (
                <Card key={q.questionId} variant="ghost" padding="sm">
                  <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
                    <Input
                      aria-label={`Question ${i + 1} label`}
                      value={q.label}
                      onChange={(e) => {
                        setDraft((d) => updateQuestion(d, q.questionId, { label: e.target.value }));
                        touch();
                      }}
                    />
                    <ExpandableTabs
                      mode="action"
                      size="sm"
                      ariaLabel="Question"
                      items={[
                        { id: 'up', label: 'Move up', icon: 'ChevronUp', disabled: i === 0 },
                        { id: 'down', label: 'Move down', icon: 'ChevronDown', disabled: i === draft.questions.length - 1 },
                        { id: 'remove', label: 'Remove question', icon: 'Trash2' },
                      ]}
                      onSelect={(id) => {
                        setDraft((d) => (id === 'remove' ? removeQuestion(d, q.questionId) : moveQuestion(d, q.questionId, id === 'up' ? i - 1 : i + 1)));
                        touch();
                      }}
                    />
                  </Container>
                </Card>
              ))}
            </Container>
          )}

          <Button
            variant="primary"
            size="lg"
            onClick={handleSave}
            disabled={saving || draft.questions.length === 0}
          >
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save form'}
          </Button>
          {error ? (
            <Text variant="caption" color="error">
              {error}
            </Text>
          ) : null}
        </Container>
      </Card>

      <Card padding="lg">
        <Container layout="vertical" gap="sm" alignItems="stretch">
          <Text variant="heading-xs">Live preview</Text>
          <FillSurface sequence={draft} registry={registry} />
        </Container>
      </Card>
    </Container>
  );
}
