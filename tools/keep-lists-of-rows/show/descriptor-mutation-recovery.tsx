import React from 'react';
import { Button, Card, Container, SchemaValueView, Text } from '../../ui';
import type {
  DescriptorMutationConflict,
} from 'trillion-workshop/tools/keep-lists-of-rows/do-work/descriptor-mutation.ts';

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

/** One side of a conflict in words: a missing or empty value says so, anything else goes through the shared value view. */
function ConflictSide({ value, testId }: { value: unknown; testId: string }) {
  const empty = value === undefined ? 'Not set' : value === null ? 'None' : value === '' ? 'Empty' : null;
  return <Container layout="vertical" data-testid={testId}>
    {empty ? <Text variant="body-xs" color="subtle">{empty}</Text> : <SchemaValueView value={value} designed={false} />}
  </Container>;
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
          onClick={() => uncertain.onRetry()}
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
                  <Text variant="label">Common base</Text>
                  <ConflictSide value={conflict.base} testId={`descriptor-conflict-${conflict.id}-base`} />
                </Container>

                <Container layout="vertical" gap="xs">
                  <Text variant="label">Saved now</Text>
                  <ConflictSide value={conflict.saved} testId={`descriptor-conflict-${conflict.id}-saved`} />
                </Container>

                <Container layout="vertical" gap="xs">
                  <Text variant="label">Mine</Text>
                  <ConflictSide value={conflict.mine} testId={`descriptor-conflict-${conflict.id}-mine`} />
                </Container>
              </Container>

              <Container layout="horizontal" gap="sm" wrap="wrap">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  loading={busy}
                  onClick={() => onResolve(conflict, 'mine')}
                  aria-label={`Keep my change for ${conflict.label}`}
                >
                  Keep mine for this property
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => onResolve(conflict, 'saved')}
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
