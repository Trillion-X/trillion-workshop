import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Badge, Button, Card, Container, Text, Textarea } from '@/packages/ui';
import { PlaceableSurfaceHost } from '@/packages/ui/show/placeable-surface-host';
import { runProtocolAction } from '../do-work/run-protocol-action';
import {
  projectProtocolValues,
  readAcceptedProgressionDecision,
  readLearningMasteryProtocolDescriptor,
  readLearningMasteryProtocolState,
  transitionIsAllowed,
} from '../read-data/read-learning-mastery';
import type { LearningMasteryProtocolDescriptor } from '../read-data/learning-mastery-types';

export type LearningMasteryProtocolPanelProps = {
  descriptorRaw?: unknown;
  stateRaw?: unknown;
  acceptedDecisionRaw?: unknown;
  descriptorAddressLabel?: string | null;
  stateAddressLabel?: string | null;
  acceptedDecisionAddressLabel?: string | null;
};

export function LearningMasteryProtocolPanel({
  descriptorRaw,
  stateRaw,
  acceptedDecisionRaw,
  descriptorAddressLabel,
  stateAddressLabel,
  acceptedDecisionAddressLabel,
}: LearningMasteryProtocolPanelProps) {
  const liveDescriptor = useBitfieldData({
    input: 'protocol-descriptor-by-address-label',
    params: { addressLabel: descriptorAddressLabel ?? null },
  });
  const liveState = useBitfieldData({
    input: 'protocol-state-by-address-label',
    params: { addressLabel: stateAddressLabel ?? null },
  });
  const liveDecision = useBitfieldData({
    input: 'accepted-decision-by-address-label',
    params: { addressLabel: acceptedDecisionAddressLabel ?? null },
  });
  const descriptor = React.useMemo(
    () => readLearningMasteryProtocolDescriptor(descriptorRaw ?? liveDescriptor),
    [descriptorRaw, liveDescriptor],
  );
  const state = React.useMemo(
    () => readLearningMasteryProtocolState(stateRaw ?? liveState),
    [stateRaw, liveState],
  );
  const decision = React.useMemo(
    () => readAcceptedProgressionDecision(acceptedDecisionRaw ?? liveDecision),
    [acceptedDecisionRaw, liveDecision],
  );
  const [message, setMessage] = React.useState<string | null>(null);
  // Local draft edits for this phase's fields, keyed by field.key. Empty until
  // the person types; the input shows the saved value until then.
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  if (!descriptor) {
    console.error('[learning-mastery] descriptor unavailable');
    return (
      <Card variant="surface" padding="lg">
        <Text variant="heading">This learning protocol is not available yet</Text>
        <Text variant="body" color="muted">Choose a configured protocol to continue.</Text>
      </Card>
    );
  }

  const phaseId = state?.phase ?? descriptor.lifecycle.initial;
  const phase = descriptor.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) {
    return <Text variant="body" color="muted">The current protocol phase is unavailable.</Text>;
  }
  const values = projectProtocolValues(state, decision);
  const transitions = descriptor.transitions.filter((transition) => transition.from === phase.id);
  const decisionPresentation = decision ? descriptor.presentation[decision.decision_key] : undefined;
  console.info(`[learning-mastery] descriptor selected ref=${descriptor.id}`);

  // The person's answers so far: saved state values overlaid with any unsaved
  // drafts typed this session. Passed on every write so save persists them and
  // advance carries them forward (the owner never wipes them).
  function mergedValues(): Record<string, unknown> {
    return { ...values, ...drafts };
  }

  // Shared write context for the generic write-state owner (phase + values +
  // monotonic revision). `next_revision` is generic concurrency metadata (no
  // domain vocabulary) so the owner needs no arithmetic in its binding layer.
  function writeContext(targetPhase: string) {
    return {
      protocol_ref: descriptor!.id,
      state_ref: state?.state_ref,
      expected_state_revision: state?.revision ?? 0,
      next_revision: (state?.revision ?? 0) + 1,
      phase: targetPhase,
      values: mergedValues(),
    };
  }

  async function saveReflections() {
    if (!descriptor!.actions.save) return;
    setSaving(true);
    try {
      await runProtocolAction(descriptor!, 'save', writeContext(phase!.id));
      setMessage('Saved.');
      setDrafts({});
    } catch {
      setMessage('Could not save right now.');
    } finally {
      setSaving(false);
    }
  }

  async function invoke(transition: LearningMasteryProtocolDescriptor['transitions'][number]) {
    if (!transitionIsAllowed(descriptor!, phase!.id, transition.to)) {
      console.warn(`[learning-mastery] transition denied from=${phase!.id} to=${transition.to}`);
      setMessage('That step is not available from here.');
      return;
    }
    try {
      await runProtocolAction(descriptor!, transition.actionKey, {
        ...writeContext(transition.to),
        transition_id: transition.id,
        from: transition.from,
        to: transition.to,
      });
      setMessage(transition.label);
      setDrafts({});
    } catch {
      setMessage('That action could not be completed.');
    }
  }

  return (
    <Container layout="vertical" gap="md">
      <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm" wrap>
        <Container layout="vertical" gap="xs">
          <Text variant="heading">{phase.label}</Text>
          {phase.detail ? <Text variant="body" color="muted">{phase.detail}</Text> : null}
        </Container>
        {decisionPresentation ? <Badge variant="info">{decisionPresentation.label}</Badge> : null}
      </Container>
      {message ? <Text variant="body-xs" color="muted">{message}</Text> : null}
      <Container layout="grid" gridCols={2} gap="sm">
        {phase.fields.map((field) => (
          <Card
            key={field.key}
            variant="nested"
            padding="md"
            data-testid={`answer-textarea-${field.key}`}
          >
            <Textarea
              label={field.label}
              rows={3}
              value={drafts[field.key] ?? stringValue(values[field.key])}
              placeholder="Write your answer"
              onChange={(event) =>
                setDrafts((current) => ({ ...current, [field.key]: event.target.value }))
              }
            />
          </Card>
        ))}
      </Container>
      {descriptor.actions.save && phase.fields.length > 0 ? (
        <Container layout="horizontal" gap="sm">
          <Button
            type="button"
            variant="secondary"
            disabled={saving}
            onClick={() => void saveReflections()}
            data-testid="save-answers-button"
          >
            {saving ? 'Saving…' : 'Save answers'}
          </Button>
        </Container>
      ) : null}
      {(phase.embeddedSurfaces ?? []).map((surface, index) => (
        <PlaceableSurfaceHost
          key={`${surface.package_entry.package_name}:${surface.package_entry.entry_name}:${index}`}
          packageName={surface.package_entry.package_name}
          entryName={surface.package_entry.entry_name}
          materialTarget={surface.material_target}
          target={surface.target}
          surfaceInput={surface.surface_input}
          fill
          interactive
        />
      ))}
      <Container layout="horizontal" gap="sm" wrap>
        {transitions.map((transition) => (
          <Button
            key={transition.id}
            type="button"
            variant="primary"
            onClick={() => void invoke(transition)}
            data-testid={`continue-button-${transition.id}`}
          >
            {transition.label}
          </Button>
        ))}
      </Container>
    </Container>
  );
}

// Editable-field rendering: empty stays empty so the placeholder shows (no
// 'Not recorded' filler leaking into a text input the person is about to type in).
function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => stringValue(entry)).filter(Boolean).join(', ');
  return '';
}

function humanValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(humanValue).join(', ');
  return 'Recorded';
}
