// packages/workflow-canvas/show/InjectDataPicker.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Lindy's "Inject data from previous steps" picker, in this engine's truth:
// picking a source adds a REAL binding AST into the payload under a field name
// you choose. The row then renders as a plain sentence ("Uses Result from the
// result of …") through the editor's translation hook.
//
// A generic control primitive consumed by the blind StepFieldRenderer wherever a
// structured field is injectable (control.injectable). It binds prior-step
// outputs and individual trigger input fields; it holds zero step-kind
// vocabulary.
//
// Extracted from NodeInspector.tsx so both the inspector and the generic
// StepFieldRenderer compose ONE definition (SSOT — never duplicated).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState } from 'react';
import { Plus as PlusIcon } from 'lucide-react';
import { Button, Card, Container, Icon, Input, Text } from '../../ui';

export function InjectDataPicker({ priorSteps, inputFields = [], onInject }: {
  priorSteps: readonly { stepId: string; sentence: string }[];
  inputFields?: readonly { key: string; label: string }[];
  onInject: (fieldName: string, binding: Record<string, unknown>) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [fieldName, setFieldName] = useState('');
  // Lindy's picker lists the trigger's individual fields (email.from,
  // email.subject…), not just the whole payload. Our equivalent: one row per
  // known input field, then the whole payload, then prior step results.
  // Picking a FIELD also defaults the destination name to that field — one
  // click, no typing (the name stays editable before picking).
  const sources: { id: string; label: string; defaultName?: string; binding: Record<string, unknown> }[] = [
    ...inputFields.map((field) => ({
      id: `input:${field.key}`,
      label: field.label,
      defaultName: field.key,
      binding: { $kind: 'binding', select: { from: 'input', path: field.key } },
    })),
    {
      id: 'input',
      label: inputFields.length > 0 ? 'Everything sent in' : 'What was sent in',
      binding: { $kind: 'binding', select: { from: 'input' } },
    },
    ...priorSteps.map((prior) => ({
      id: prior.stepId,
      label: prior.sentence,
      binding: {
        $kind: 'binding',
        select: { from: 'steps', key: prior.stepId, path: 'output' },
      },
    })),
  ];
  return (
    <Container layout="vertical" gap="xs" data-workflow-inject-data="true">
      {!open && (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <Container layout="horizontal" gap="sm" alignItems="center">
            <Icon icon={PlusIcon} size="xs" color="secondary" />
            <Text variant="body-xs">Add data from a step</Text>
          </Container>
        </Button>
      )}
      {open && (
        <Card variant="nested" padding="sm">
          <Container layout="vertical" gap="sm">
            <Input
              aria-label="Field name"
              placeholder="Call this field…"
              value={fieldName}
              onChange={(event) => setFieldName(event.target.value)}
            />
            <Container layout="vertical" gap="xs">
              {sources.map((source) => (
                <Button
                  key={source.id}
                  variant="ghost"
                  size="sm"
                  disabled={fieldName.trim().length === 0 && !source.defaultName}
                  onClick={() => {
                    const chosen = fieldName.trim() || source.defaultName || '';
                    onInject(
                      chosen.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
                      source.binding,
                    );
                    setFieldName('');
                    setOpen(false);
                  }}
                >
                  <Container layout="horizontal" gap="sm" alignItems="center" width="full">
                    <Container flex={1} style={{ minWidth: 0, textAlign: 'left' }}>
                      <Text variant="body-xs" truncate>{source.label}</Text>
                    </Container>
                    <Icon icon={PlusIcon} size="xs" color="muted" />
                  </Container>
                </Button>
              ))}
            </Container>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </Container>
        </Card>
      )}
    </Container>
  );
}
