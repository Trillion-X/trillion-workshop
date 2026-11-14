import * as React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  Badge,
  Button,
  Card,
  Container,
  IconTile,
  PathRail,
  ProtocolSession,
  Text,
} from '@/packages/ui';
import type { PathNodeView, PathStatusOverrides } from '@/packages/ui/show/path-rail';
import { resolveNamedIcon } from '@/packages/ui/show/icon/NamedIcon';
import type { SessionSummary } from '@/packages/ui/show/protocol-session/protocol-session-machine';
import type { ProtocolSessionStep } from '@/packages/ui/show/protocol-session/ProtocolSession';
import {
  buildActionsIndex,
  deriveSections,
  mergeActionValues,
  mergeMeasuredFields,
  readAdvanceCondition,
  readText,
  rowFieldValue,
  type ApeakAction,
  type ApeakField,
  type ApeakRow,
  type ApeakSection,
  type ApeakSurfaceSource,
} from './apeak-surface-model';

const TONE_TO_ICON = { positive: 'success', caution: 'warning', critical: 'error', neutral: 'neutral' } as const;
const TONE_TO_BADGE = { positive: 'success', caution: 'warning', critical: 'error', neutral: 'neutral' } as const;
const TONE_TO_TEXT = { positive: 'success', caution: 'warning', critical: 'error', neutral: 'accent' } as const;

export function ApeakSurface({ source }: { source: ApeakSurfaceSource }): React.ReactElement {
  const sections = React.useMemo(() => deriveSections(source), [source]);
  const onAction = React.useCallback(async (action: ApeakAction, values?: { request_id?: string; fields?: Record<string, unknown> }) => {
    const request = mergeActionValues(action, values);
    await sendRequestToBitfieldTarget(request);
  }, []);

  return (
    <Container
      layout="vertical"
      gap="lg"
      padding="lg"
      width="full"
      alignItems={source.view.look?.width ? 'center' : 'stretch'}
      data-surface="apeak-surface"
    >
      <Container layout="vertical" gap="lg" width="full" maxWidth={source.view.look?.width === 'reading' ? '4xl' : source.view.look?.width === 'hero' ? '2xl' : 'none'}>
        <Container layout="vertical" gap="sm" alignItems={source.view.look?.width ? 'center' : 'stretch'}>
          <Text variant={source.view.look?.width ? 'heading-xl' : 'heading-lg'} align={source.view.look?.width ? 'center' : 'left'}>
            {source.view.label}
          </Text>
        </Container>
        <Container layout="vertical" gap="lg">
          {sections.map((section) => renderSection(section, source, onAction))}
        </Container>
      </Container>
    </Container>
  );
}

function renderSection(
  section: ApeakSection,
  source: ApeakSurfaceSource,
  onAction: (action: ApeakAction, values?: { request_id?: string; fields?: Record<string, unknown> }) => void,
): React.ReactElement {
  switch (section.field.role) {
    case 'guidance-cue':
      return <React.Fragment key={section.field.id}>{renderGuidanceCue(section, source, onAction)}</React.Fragment>;
    case 'recommendation-list':
      return <React.Fragment key={section.field.id}>{renderRecommendationList(section, source, onAction)}</React.Fragment>;
    case 'path-rail':
      return <React.Fragment key={section.field.id}>{renderPathRail(section, source)}</React.Fragment>;
    case 'protocol-session':
      return <React.Fragment key={section.field.id}>{renderProtocolSession(section, source, onAction)}</React.Fragment>;
    default:
      return <React.Fragment key={section.field.id} />;
  }
}

function fieldHandle(source: ApeakSurfaceSource, sectionField: ApeakField, handle: string): ApeakField | undefined {
  const target = sectionField.roleConfig?.[handle];
  return typeof target === 'string' ? source.view.fields.find((field) => field.id === target) : undefined;
}

function renderGuidanceCue(
  section: ApeakSection,
  source: ApeakSurfaceSource,
  onAction: (action: ApeakAction) => void,
): React.ReactElement {
  const eyebrowField = fieldHandle(source, section.field, 'eyebrow');
  const titleField = fieldHandle(source, section.field, 'title');
  const bodyField = fieldHandle(source, section.field, 'body');
  const iconField = fieldHandle(source, section.field, 'icon');
  const iconImageField = fieldHandle(source, section.field, 'iconImage');
  const chipField = fieldHandle(source, section.field, 'chip');
  const toneField = fieldHandle(source, section.field, 'tone');
  return (
    <Container layout="vertical" gap="md" data-role="guidance-cue">
      {section.rows.map((row) => {
        const eyebrow = eyebrowField ? readText(rowFieldValue(row, eyebrowField)) : undefined;
        const title = titleField ? readText(rowFieldValue(row, titleField)) ?? row.label : row.label;
        const body = bodyField ? readText(rowFieldValue(row, bodyField)) : undefined;
        const iconName = iconField ? readText(rowFieldValue(row, iconField)) : undefined;
        const iconImage = iconImageField ? readText(rowFieldValue(row, iconImageField)) : undefined;
        const chip = chipField ? readText(rowFieldValue(row, chipField)) : undefined;
        const toneRaw = toneField ? readText(rowFieldValue(row, toneField)) : undefined;
        const tone = toneRaw && toneRaw in TONE_TO_ICON ? toneRaw as keyof typeof TONE_TO_ICON : undefined;
        const Icon = resolveNamedIcon(iconName);
        return (
          <Card key={row.id} variant="surface" padding="lg" data-test="apeak-guidance-cue">
            <Container layout="vertical" gap="md">
              {(Icon || iconImage) ? (
                <IconTile
                  icon={Icon ?? undefined}
                  image={iconImage}
                  tone={tone ? TONE_TO_ICON[tone] : 'accent'}
                  size="lg"
                  glow
                  label={eyebrow ?? title}
                />
              ) : null}
              <Container layout="vertical" gap="xs">
                {eyebrow ? <Text variant="overline" color={tone ? TONE_TO_TEXT[tone] : 'accent'}>{eyebrow}</Text> : null}
                <Text variant="heading-xl">{title}</Text>
              </Container>
              {chip ? (
                <Container layout="vertical" alignItems="start">
                  <Badge variant={tone ? TONE_TO_BADGE[tone] : 'accent'}>{chip}</Badge>
                </Container>
              ) : null}
              {body ? <Text variant="body" color="muted">{body}</Text> : null}
              {row.actions.length > 0 ? (
                <Container layout="vertical" gap="xs">
                  {row.actions.map((action, index) => (
                    <Button
                      key={action.id}
                      size="lg"
                      radius="full"
                      fullWidth
                      variant={index === 0 ? 'primary' : 'ghost'}
                      onClick={() => onAction(action)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </Container>
              ) : null}
            </Container>
          </Card>
        );
      })}
    </Container>
  );
}

function renderRecommendationList(
  section: ApeakSection,
  source: ApeakSurfaceSource,
  onAction: (action: ApeakAction) => void,
): React.ReactElement {
  const rankField = fieldHandle(source, section.field, 'rank');
  const statusField = fieldHandle(source, section.field, 'status');
  const reasonField = fieldHandle(source, section.field, 'reason');
  const sorted = [...section.rows].sort((left, right) => {
    const leftValue = rankField ? Number(rowFieldValue(left, rankField)) : Number.POSITIVE_INFINITY;
    const rightValue = rankField ? Number(rowFieldValue(right, rankField)) : Number.POSITIVE_INFINITY;
    return leftValue - rightValue;
  });
  return (
    <Container layout="vertical" gap="md" data-role="recommendation-list">
      {sorted.map((row, index) => {
        const reason = reasonField ? readText(rowFieldValue(row, reasonField)) : undefined;
        const status = statusField ? readText(rowFieldValue(row, statusField)) : undefined;
        const statusView = status ? source.view.statusOverrides?.[status] : undefined;
        const rank = rankField ? Number(rowFieldValue(row, rankField)) : index + 1;
        return (
          <Card key={row.id} variant="nested" padding="lg" data-test="apeak-recommendation">
            <Container layout="vertical" gap="sm">
              <Container layout="horizontal" justify="between" align="center" gap="sm">
                <Container layout="horizontal" align="center" gap="xs">
                  <Badge variant="neutral">#{Number.isFinite(rank) ? rank : index + 1}</Badge>
                  <Text variant="body-sm" weight="medium">{row.label}</Text>
                </Container>
                {statusView?.label ? <Badge variant={statusView.tone ?? 'neutral'}>{statusView.label}</Badge> : null}
              </Container>
              {reason ? <Text variant="caption" color="muted">{reason}</Text> : null}
              {row.actions.length > 0 ? (
                <Container layout="horizontal" gap="xs">
                  {row.actions.map((action) => (
                    <Button key={action.id} size="sm" variant="primary" onClick={() => onAction(action)}>
                      {action.label}
                    </Button>
                  ))}
                </Container>
              ) : null}
            </Container>
          </Card>
        );
      })}
    </Container>
  );
}

function renderPathRail(section: ApeakSection, source: ApeakSurfaceSource): React.ReactElement {
  const labelField = fieldHandle(source, section.field, 'label');
  const statusField = fieldHandle(source, section.field, 'status');
  const overrides = buildPathStatusOverrides(source.view.statusOverrides ?? {});
  const nodes: PathNodeView[] = section.rows.map((row) => {
    const status = statusField ? readText(rowFieldValue(row, statusField)) : undefined;
    const override = status ? overrides[status] : undefined;
    return {
      id: row.id,
      label: labelField ? readText(rowFieldValue(row, labelField)) ?? row.label : row.label,
      caption: labelField ? readText(rowFieldValue(row, labelField)) ?? row.label : row.label,
      toneColor: override?.toneColor ?? 'var(--text-muted)',
      ...(override?.ring ? { ring: true } : {}),
      ...(override?.complete ? { complete: true } : {}),
      ...(override?.dimmed ? { dimmed: true } : {}),
      ...(override?.bubble ? { bubble: override.bubble } : {}),
    };
  });
  return (
    <Container layout="vertical" gap="md" data-role="path-rail">
      <PathRail nodes={nodes} />
    </Container>
  );
}

function buildPathStatusOverrides(raw: NonNullable<ApeakSurfaceSource['view']['statusOverrides']>): PathStatusOverrides {
  const out: PathStatusOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = {
      toneColor: value.toneColor ?? 'var(--text-muted)',
      ...(value.ring ? { ring: true } : {}),
      ...(value.complete ? { complete: true } : {}),
      ...(value.dimmed ? { dimmed: true } : {}),
      ...(value.bubble ? { bubble: value.bubble } : {}),
    };
  }
  return out;
}

function renderProtocolSession(
  section: ApeakSection,
  source: ApeakSurfaceSource,
  onAction: (action: ApeakAction, values?: { request_id?: string; fields?: Record<string, unknown> }) => void,
): React.ReactElement {
  const labelField = fieldHandle(source, section.field, 'label');
  const contentField = fieldHandle(source, section.field, 'content');
  const secondsField = fieldHandle(source, section.field, 'seconds');
  const advanceField = fieldHandle(source, section.field, 'advance');
  const captureField = fieldHandle(source, section.field, 'capture');
  const actionIndex = buildActionsIndex(section.rows);
  const roleConfig = section.field.roleConfig ?? {};
  const steps: ProtocolSessionStep[] = section.rows.map((row) => {
    const seconds = secondsField ? Number(rowFieldValue(row, secondsField)) : undefined;
    const content = contentField ? readText(rowFieldValue(row, contentField)) : undefined;
    const capture = captureField ? readText(rowFieldValue(row, captureField)) : undefined;
    const advance = readAdvanceCondition(row, advanceField);
    return {
      id: row.id,
      ...(Number.isFinite(seconds) ? { plannedSeconds: seconds } : {}),
      ...(content ? { content } : {}),
      ...(capture ? { captureField: capture } : {}),
      ...(advance ? { advance } : {}),
      data: row.fields,
    };
  });
  const completeAction = typeof roleConfig.completeAction === 'string' ? actionIndex[roleConfig.completeAction] : undefined;
  const onLifecycle = (event: 'started' | 'completed' | 'abandoned', summary: SessionSummary) => {
    if (event === 'completed' && completeAction) onAction(completeAction, mergeMeasuredFields(summary));
  };
  return (
    <Container layout="vertical" gap="md" align="center" data-role="protocol-session">
      <ProtocolSession
        steps={steps}
        title={section.field.label !== source.view.label ? section.field.label : undefined}
        intro={typeof roleConfig.intro === 'string' ? roleConfig.intro : undefined}
        startLabel={typeof roleConfig.startLabel === 'string' ? roleConfig.startLabel : 'Start'}
        nextLabel={typeof roleConfig.nextLabel === 'string' ? roleConfig.nextLabel : 'Next'}
        doneLabel={typeof roleConfig.doneLabel === 'string' ? roleConfig.doneLabel : 'Done'}
        autoStart={roleConfig.autoStart === 'true'}
        onLifecycle={onLifecycle}
      />
    </Container>
  );
}
