import React from 'react';
import { Button, Card, Container, Text } from '@/packages/ui';
import type {
  DescriptorMutationConflict,
} from '@/packages/visual-database/do-work/descriptor-mutation';

export type DescriptorConflictChoice = 'mine' | 'saved';

export interface DescriptorConflictValue {
  readonly id: string;
  readonly label: string;
  readonly base: unknown;
  readonly mine: unknown;
  readonly saved: unknown;
}

export interface DescriptorConflictRecoveryProps {
  readonly conflicts: readonly DescriptorConflictValue[];
  readonly busyConflictId?: string | null;
  readonly announcement?: string;
  readonly onReviewEach?: () => void;
  readonly uncertain?: {
    readonly message: string;
    readonly busy?: boolean;
    readonly onRetry: () => void | Promise<void>;
  };
  readonly onResolve: (
    conflict: DescriptorConflictValue,
    choice: DescriptorConflictChoice,
  ) => void | Promise<void>;
}

function visibleValue(value: unknown): string {
  if (value === undefined) return 'Not set';
  if (value === null) return 'None';
  if (typeof value === 'string') return value.length > 0 ? value : 'Empty';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const ABSENT_VALUE = Symbol('absent-descriptor-value');

function valueAtPath(root: unknown, path: readonly string[]): unknown | typeof ABSENT_VALUE {
  let current = root;
  for (const segment of path) {
    if (
      current === null
      || typeof current !== 'object'
      || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) return ABSENT_VALUE;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function humanLabel(value: string): string {
  const words = value.replace(/[-_]+/gu, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Item';
}

export function descriptorConflictValuesFromMutation(
  conflicts: readonly DescriptorMutationConflict[],
): readonly DescriptorConflictValue[] {
  return conflicts.map((conflict, index) => {
    const operation = conflict.operation;
    const path = operation.operation === 'set' || operation.operation === 'remove'
      ? operation.path
      : operation.operation === 'move' ? ['order'] : [];
    const base = path.length > 0
      ? valueAtPath(conflict.base?.value, path)
      : conflict.base?.value;
    const saved = path.length > 0
      ? valueAtPath(conflict.current?.value, path)
      : conflict.current?.value;
    const mine = operation.operation === 'set' || operation.operation === 'move'
      ? operation.after
      : operation.operation === 'create'
        ? operation.value
        : ABSENT_VALUE;
    return {
      id: `conflict-${index}`,
      label: humanLabel(path.at(-1) ?? operation.key.family),
      base: base === ABSENT_VALUE ? undefined : base,
      saved: saved === ABSENT_VALUE ? undefined : saved,
      mine: mine === ABSENT_VALUE ? undefined : mine,
    };
  });
}

export function DescriptorConflictRecovery({
  conflicts,
  busyConflictId = null,
  announcement,
  onReviewEach,
  uncertain,
  onResolve,
}: DescriptorConflictRecoveryProps) {
  if (conflicts.length === 0 && !uncertain) return null;

  return (
    <Card
      variant="error"
      padding="md"
      layout="stack"
      role="alert"
      aria-label="Save conflict; draft kept"
      data-testid="descriptor-conflict-recovery"
    >
      <Container layout="vertical" gap="xs">
        <Text variant="heading" color="error">
          {uncertain
            ? 'Save not confirmed; your changes are still here'
            : 'Save conflict; your changes are still here'}
        </Text>
        <Text variant="body" color="secondary">
          {uncertain
            ? uncertain.message
            : `Another saved change touched the same ${conflicts.length === 1 ? 'property' : 'properties'}. Choose the value to keep for each one.`}
        </Text>
        <Text
          as="span"
          variant="caption"
          color={announcement ? 'primary' : 'subtle'}
          role="status"
          aria-live="polite"
          data-testid="descriptor-conflict-announcement"
        >
          {announcement ?? 'Nothing was discarded.'}
        </Text>
      </Container>

      {uncertain ? (
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={uncertain.busy}
          loading={uncertain.busy}
          onClick={() => void uncertain.onRetry()}
        >
          Retry
        </Button>
      ) : null}

      <Container layout="vertical" gap="sm">
        {conflicts.map((conflict) => {
          const busy = busyConflictId === conflict.id;
          return (
            <Card
              key={conflict.id}
              variant="nested"
              padding="sm"
              layout="stack"
              data-testid={`descriptor-conflict-${conflict.id}`}
            >
              <Text variant="heading-xs" color="primary">
                {conflict.label}
              </Text>

              <Container layout="grid" gridColumns={3} gap="sm">
                <Container layout="vertical" gap="xs">
                  <Text variant="overline">Common base</Text>
                  <Text
                    variant="body-xs"
                    color="subtle"
                    mono
                    wrap="preserve"
                    data-testid={`descriptor-conflict-${conflict.id}-base`}
                  >
                    {visibleValue(conflict.base)}
                  </Text>
                </Container>

                <Container layout="vertical" gap="xs">
                  <Text variant="overline">Saved now</Text>
                  <Text
                    variant="body-xs"
                    color="secondary"
                    mono
                    wrap="preserve"
                    data-testid={`descriptor-conflict-${conflict.id}-saved`}
                  >
                    {visibleValue(conflict.saved)}
                  </Text>
                </Container>

                <Container layout="vertical" gap="xs">
                  <Text variant="overline">Mine</Text>
                  <Text
                    variant="body-xs"
                    color="primary"
                    mono
                    wrap="preserve"
                    data-testid={`descriptor-conflict-${conflict.id}-mine`}
                  >
                    {visibleValue(conflict.mine)}
                  </Text>
                </Container>
              </Container>

              <Container layout="horizontal" gap="sm" wrap="wrap">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  loading={busy}
                  onClick={() => void onResolve(conflict, 'mine')}
                  aria-label={`Keep my change for ${conflict.label}`}
                >
                  Keep mine for this property
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void onResolve(conflict, 'saved')}
                  aria-label={`Use saved version for ${conflict.label}`}
                >
                  Use saved version
                </Button>
              </Container>
            </Card>
          );
        })}
      </Container>

      {conflicts.length > 1 && onReviewEach ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onReviewEach}
        >
          Review each conflict
        </Button>
      ) : null}
    </Card>
  );
}
