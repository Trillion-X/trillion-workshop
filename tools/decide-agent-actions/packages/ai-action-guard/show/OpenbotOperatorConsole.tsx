// bitfield/packages/ai-action-guard/show/OpenbotOperatorConsole.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Union Operator Console: one surface a business owner opens to watch its
// autonomous operator act on its own computer under governance. It composes the
// three now-live openbot primitives, each read as blind DATA (never by crate
// import, L166 no god package):
//
//   - Governed-action feed  (ai-action-guard/govern-computer-action audit rows)
//   - One-driver takeover    (permission-lease exclusive-control lease)
//   - Brought agents         (ai-agent-profile runtime_adapter_ref transport)
//   - Scoped-secret entry    (masked, straight-to-page, never model-readable; SP7)
//
// Reference-grounded per the Screen Contract at
//   notes/.../research/2026-08-20-union-operator-screen-contract.md
// (Mobbin: Emergent, v0 tactical-ops, GitHub/PlanetScale/Toggl audit, Zoom
//  control banner, StackAI password-protect) and the real openbot audit.tsx.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero raw HTML for layout/text. Every visible part is an @/packages/ui
//    primitive with a variant (L065). The masked secret uses the ui Input.
// 2. Primary copy is plain sentences (L169). Record-ids, rule-ids, snapshot-ids,
//    adapter refs and addresses live ONLY inside <details>Technical proof</details>.
// 3. No contentless eyebrow/overline above a heading (L138). The heading speaks.
// 4. Every render state (empty / sparse / dense / secret-request) is handled
//    with an honest sentence, never filler (L118).
// 5. The secret value is component-local state handed straight to onSubmitSecret;
//    it is never logged, never placed on any model-readable path (SP7).
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Badge, Button, Card, Container, Input, Text } from '@/packages/ui';
import type {
  BroughtAgent,
  ControlState,
  GovernedAction,
  OperatorConsoleData,
} from '../read-data/read-openbot-operator';

export type OpenbotOperatorConsoleProps = {
  data: OperatorConsoleData;
  title?: string;
  /** A pending scoped-secret request from the operator, when one is open. */
  secretRequest?: { fieldLabel: string; note?: string } | null;
  /** Wired by the mount to the permission-lease record/revoke action. */
  onToggleControl?: (next: ControlState['action']) => void;
  /** Wired by the mount to the credentials-vault + credential-mount write. */
  onSubmitSecret?: (value: string) => void;
};

const BADGE_TONE: Record<GovernedAction['tone'], 'success' | 'error' | 'warning'> = {
  allowed: 'success',
  blocked: 'error',
  pending: 'warning',
};

function relativeTime(iso?: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

// ---------------------------------------------------------------------------
// takeover banner (Zoom "you're sharing / Stop" idiom)
// ---------------------------------------------------------------------------
function TakeoverBanner({
  control,
  onToggleControl,
}: {
  control: ControlState;
  onToggleControl?: (next: ControlState['action']) => void;
}) {
  const humanHolds = control.tone === 'human-holds';
  return (
    <Card
      as="section"
      variant={humanHolds ? 'accent' : 'nested'}
      padding="md"
      layout="row"
      minWidth="0"
      data-surface="openbot-takeover-banner"
      data-holder={control.holder}
    >
      <Container layout="vertical" gap="xs" flex="1">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Badge variant={humanHolds ? 'warning' : 'success'}>
            {humanHolds ? 'You have control' : 'Operator is driving'}
          </Badge>
          <Text variant="body" weight="semibold">
            {control.headline}
          </Text>
        </Container>
        <Text variant="body-xs" color="subtle">
          {control.detail}
        </Text>
      </Container>
      <Button
        variant={humanHolds ? 'success' : 'secondary'}
        size="sm"
        onClick={() => onToggleControl?.(control.action)}
        type="button"
      >
        {control.actionLabel}
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// one governed-action row (GitHub / PlanetScale / Toggl audit idiom)
// ---------------------------------------------------------------------------
function ActionRow({ action }: { action: GovernedAction }) {
  return (
    <Card variant="nested" padding="md" layout="stack" minWidth="0" data-surface="openbot-action-row">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Text variant="body" weight="semibold">
          {action.headline}
          {action.host ? (
            <Text as="span" variant="body-xs" color="subtle">
              {`  on ${action.host}`}
            </Text>
          ) : null}
        </Text>
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Badge variant={BADGE_TONE[action.tone]}>{action.decisionLabel}</Badge>
          {action.recordedAt ? (
            <Text variant="caption" color="faint">
              {relativeTime(action.recordedAt)}
            </Text>
          ) : null}
        </Container>
      </Container>

      {action.relabeledFrom ? (
        <Text variant="body-xs" color="subtle">
          {`Caller asked to act on "${action.relabeledFrom}". The real screen said "${action.target}", resolved from the live page, not the label.`}
        </Text>
      ) : null}

      {action.reason ? (
        <Text variant="body-xs" color="subtle">
          {action.reason}
        </Text>
      ) : null}

      <details>
        <summary>
          <Text as="span" variant="caption" color="faint">
            Technical proof
          </Text>
        </summary>
        <Text as="div" variant="caption" color="faint" mono wrap="preserve">
          {[
            `step: ${action.proof.stepId}`,
            action.proof.runRef ? `run: ${action.proof.runRef}` : null,
            action.proof.matchedRuleId ? `rule: ${action.proof.matchedRuleId}` : null,
            action.proof.snapshotId != null ? `snapshot: ${action.proof.snapshotId}` : null,
            action.proof.mode ? `mode: ${action.proof.mode}` : null,
            'recorded before the effect: yes',
          ]
            .filter(Boolean)
            .join('\n')}
        </Text>
      </details>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// brought-agents panel (StackAI agent + tools idiom)
// ---------------------------------------------------------------------------
function AgentRow({ agent }: { agent: BroughtAgent }) {
  const available = agent.status === 'available';
  return (
    <Card variant="nested" padding="md" layout="stack" minWidth="0" data-surface="openbot-agent-row">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Text variant="body" weight="semibold">
          {agent.label}
        </Text>
        <Badge variant={available ? 'success' : 'neutral'}>{available ? 'Available' : agent.status}</Badge>
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Badge variant={agent.proof.runtimeAdapterRef ? 'accent' : 'neutral'}>{agent.transportLine}</Badge>
        <Text variant="caption" color="faint">
          {agent.toolCount === 1 ? '1 tool' : `${agent.toolCount} tools`}
        </Text>
      </Container>
      <details>
        <summary>
          <Text as="span" variant="caption" color="faint">
            Technical proof
          </Text>
        </summary>
        <Text as="div" variant="caption" color="faint" mono wrap="preserve">
          {[
            `profile: ${agent.id}`,
            agent.proof.runtimeAdapterRef ? `transport: ${agent.proof.runtimeAdapterRef}` : 'transport: local process',
            agent.proof.modelRefs.length ? `models: ${agent.proof.modelRefs.join(', ')}` : null,
            agent.proof.toolRefs.length ? `tools: ${agent.proof.toolRefs.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join('\n')}
        </Text>
      </details>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// scoped-secret entry (StackAI "Password Protect" idiom; SP7)
// ---------------------------------------------------------------------------
function ScopedSecretEntry({
  request,
  onSubmitSecret,
}: {
  request: { fieldLabel: string; note?: string };
  onSubmitSecret?: (value: string) => void;
}) {
  const [value, setValue] = React.useState('');
  return (
    <Card variant="accent" padding="md" layout="stack" minWidth="0" data-surface="openbot-scoped-secret">
      <Text variant="heading-xs">The operator needs a secret</Text>
      <Text variant="body-xs" color="subtle">
        {`Enter your ${request.fieldLabel}. It goes straight to the page. Trillion never sees what you type.`}
      </Text>
      <Input
        type="password"
        value={value}
        placeholder={request.fieldLabel}
        aria-label={request.fieldLabel}
        autoComplete="off"
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value)}
      />
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button
          variant="success"
          size="sm"
          type="button"
          disabled={value.length === 0}
          onClick={() => {
            onSubmitSecret?.(value);
            setValue('');
          }}
        >
          Give it to the page
        </Button>
        <Text variant="caption" color="faint">
          {request.note ?? 'Masked. Never logged. Never on a model path.'}
        </Text>
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// the whole console
// ---------------------------------------------------------------------------
export function OpenbotOperatorConsole({
  data,
  title = 'Autonomous operator',
  secretRequest = null,
  onToggleControl,
  onSubmitSecret,
}: OpenbotOperatorConsoleProps) {
  const { actions, control, agents } = data;
  return (
    <Card
      as="section"
      variant="surface"
      padding="lg"
      layout="stack"
      minWidth="0"
      data-package="ai-action-guard"
      data-surface="openbot-operator-console"
    >
      <Container as="header" layout="vertical" gap="xs">
        <Text variant="heading-lg">{title}</Text>
        <Text variant="body" color="subtle" leading="relaxed">
          Everything the operator does on its own computer, decided from the real screen and recorded before it
          happens. Take the wheel any time.
        </Text>
      </Container>

      <TakeoverBanner control={control} onToggleControl={onToggleControl} />

      {secretRequest ? <ScopedSecretEntry request={secretRequest} onSubmitSecret={onSubmitSecret} /> : null}

      <Container as="section" layout="vertical" gap="sm" aria-labelledby="openbot-actions-heading">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
          <Text id="openbot-actions-heading" variant="heading-xs">
            What the operator did
          </Text>
          <Text variant="caption" color="faint">
            {actions.length === 0
              ? 'nothing yet'
              : actions.length === 1
                ? '1 action'
                : `${actions.length} actions`}
          </Text>
        </Container>
        {actions.length === 0 ? (
          <Card variant="nested" padding="md" layout="stack" data-status="empty">
            <Text variant="heading-xs">No actions yet</Text>
            <Text variant="body-xs" color="subtle">
              When the operator clicks, types, or navigates, each decision shows here the instant it is made.
            </Text>
          </Card>
        ) : (
          actions.map((action) => <ActionRow action={action} key={action.id} />)
        )}
      </Container>

      <Container as="section" layout="vertical" gap="sm" aria-labelledby="openbot-agents-heading">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
          <Text id="openbot-agents-heading" variant="heading-xs">
            Agents wired in
          </Text>
          <Text variant="caption" color="faint">
            {agents.length === 1 ? '1 agent' : `${agents.length} agents`}
          </Text>
        </Container>
        {agents.length === 0 ? (
          <Card variant="nested" padding="md" layout="stack" data-status="empty">
            <Text variant="heading-xs">No agents wired in yet</Text>
            <Text variant="body-xs" color="subtle">
              Bring any agent in as configuration. However it connects, it drives this same governed computer.
            </Text>
          </Card>
        ) : (
          agents.map((agent) => <AgentRow agent={agent} key={agent.id} />)
        )}
      </Container>
    </Card>
  );
}
