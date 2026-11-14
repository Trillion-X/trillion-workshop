import React from 'react';
import { Button, Card, Container, Input, Text } from '@/packages/ui';
import type { ScoreExpr } from '@/packages/choose-per-observer/read-data/decider-schema';

export interface DeciderBuilderOp {
  id: string;
  label: string;
}

export interface DeciderBuilderProps {
  ops: readonly DeciderBuilderOp[];
  factPaths: readonly string[][];
  value: ScoreExpr | null | undefined;
  onChange: (value: ScoreExpr | null) => void;
}

type ConditionNode = {
  op: string;
  left: { fact_path: string[] };
  right: { const: string | number | boolean | null };
};

type GroupNode = {
  op: 'and' | 'or';
  operands: ScoreExpr[];
};

function isGroup(value: ScoreExpr | null | undefined): value is GroupNode {
  return Boolean(value && 'op' in value && (value.op === 'and' || value.op === 'or') && Array.isArray(value.operands));
}

function isCondition(value: ScoreExpr | null | undefined): value is ConditionNode {
  return Boolean(
    value &&
      'op' in value &&
      'left' in value &&
      'right' in value &&
      typeof value.op === 'string' &&
      typeof value.left === 'object' &&
      value.left != null &&
      'fact_path' in value.left &&
      Array.isArray(value.left.fact_path) &&
      typeof value.right === 'object' &&
      value.right != null &&
      'const' in value.right,
  );
}

function pathKey(path: readonly string[]): string {
  return path.join('.');
}

function parseConst(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  return value;
}

function constText(value: string | number | boolean | null): string {
  return value == null ? 'null' : String(value);
}

function firstConditionOp(ops: readonly DeciderBuilderOp[]): string {
  return ops.find((op) => op.id !== 'and' && op.id !== 'or')?.id ?? ops[0]?.id ?? 'eq';
}

function firstFactPath(factPaths: readonly string[][]): string[] {
  return [...(factPaths[0] ?? [])];
}

function makeCondition(ops: readonly DeciderBuilderOp[], factPaths: readonly string[][]): ConditionNode {
  return {
    op: firstConditionOp(ops),
    left: { fact_path: firstFactPath(factPaths) },
    right: { const: '' },
  };
}

function makeGroup(ops: readonly DeciderBuilderOp[], factPaths: readonly string[][]): GroupNode {
  return { op: 'and', operands: [makeCondition(ops, factPaths)] };
}

function replaceOperand(group: GroupNode, index: number, next: ScoreExpr | null): GroupNode {
  if (next == null) {
    return { ...group, operands: group.operands.filter((_, operandIndex) => operandIndex !== index) };
  }
  return { ...group, operands: group.operands.map((operand, operandIndex) => (operandIndex === index ? next : operand)) };
}

function valueError(node: ConditionNode): string | null {
  if (node.left.fact_path.length === 0) return 'Choose who sees this.';
  if (constText(node.right.const).trim() === '') return 'Enter a value.';
  return null;
}

function ConditionRow({
  node,
  ops,
  factPaths,
  onChange,
}: {
  node: ConditionNode;
  ops: readonly DeciderBuilderOp[];
  factPaths: readonly string[][];
  onChange: (value: ScoreExpr | null) => void;
}) {
  const selectedPath = pathKey(node.left.fact_path);
  const error = valueError(node);

  return (
    <Card variant="nested" padding="sm" layout="column">
      <Container layout="horizontal" gap="sm" alignItems="center" wrap padding="none">
        <Text variant="caption" color="faint">
          who sees this
        </Text>
        <Container layout="horizontal" gap="xs" alignItems="center" wrap padding="none">
          {factPaths.map((path) => {
            const key = pathKey(path);
            return (
              <Button
                key={key}
                type="button"
                variant={selectedPath === key ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => onChange({ ...node, left: { fact_path: [...path] } })}
              >
                {key}
              </Button>
            );
          })}
        </Container>
        <Container layout="horizontal" gap="xs" alignItems="center" wrap padding="none">
          {ops.map((op) => (
            <Button
              key={op.id}
              type="button"
              variant={node.op === op.id ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => onChange({ ...node, op: op.id })}
            >
              {op.label}
            </Button>
          ))}
        </Container>
        <Input
          aria-label="value"
          value={constText(node.right.const)}
          onChange={(event) => onChange({ ...node, right: { const: parseConst(event.currentTarget.value) } })}
        />
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          remove
        </Button>
      </Container>
      {error && (
        <Text variant="caption" color="danger">
          {error}
        </Text>
      )}
    </Card>
  );
}

function GroupEditor({
  node,
  ops,
  factPaths,
  onChange,
}: {
  node: GroupNode;
  ops: readonly DeciderBuilderOp[];
  factPaths: readonly string[][];
  onChange: (value: ScoreExpr | null) => void;
}) {
  return (
    <Card variant="surface" padding="md" layout="column">
      <Container layout="vertical" gap="sm" padding="none">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap padding="none">
          <Text variant="heading-sm">rule</Text>
          <Container layout="horizontal" gap="xs" alignItems="center" padding="none">
            <Button
              type="button"
              variant={node.op === 'and' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => onChange({ ...node, op: 'and' })}
            >
              AND
            </Button>
            <Button
              type="button"
              variant={node.op === 'or' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => onChange({ ...node, op: 'or' })}
            >
              OR
            </Button>
          </Container>
        </Container>

        {node.operands.length === 0 ? (
          <Text variant="body-sm" color="faint">
            matches everyone
          </Text>
        ) : (
          node.operands.map((operand, index) => (
            <DeciderNode
              key={index}
              node={operand}
              ops={ops}
              factPaths={factPaths}
              onChange={(next) => onChange(replaceOperand(node, index, next))}
            />
          ))
        )}

        <Container layout="horizontal" gap="sm" alignItems="center" wrap padding="none">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onChange({ ...node, operands: [...node.operands, makeCondition(ops, factPaths)] })}
          >
            add condition
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onChange({ ...node, operands: [...node.operands, makeGroup(ops, factPaths)] })}
          >
            add group
          </Button>
        </Container>
      </Container>
    </Card>
  );
}

function DeciderNode({
  node,
  ops,
  factPaths,
  onChange,
}: {
  node: ScoreExpr;
  ops: readonly DeciderBuilderOp[];
  factPaths: readonly string[][];
  onChange: (value: ScoreExpr | null) => void;
}) {
  if (isGroup(node)) {
    return <GroupEditor node={node} ops={ops} factPaths={factPaths} onChange={onChange} />;
  }
  if (isCondition(node)) {
    return <ConditionRow node={node} ops={ops} factPaths={factPaths} onChange={onChange} />;
  }
  return (
    <Card variant="nested" padding="sm" layout="column">
      <Text variant="caption" color="danger">
        Enter a value.
      </Text>
      <Button type="button" variant="secondary" size="sm" onClick={() => onChange(makeCondition(ops, factPaths))}>
        add condition
      </Button>
    </Card>
  );
}

export function DeciderBuilder({ ops, factPaths, value, onChange }: DeciderBuilderProps) {
  return (
    <Card variant="surface" padding="lg" layout="column">
      <Container layout="vertical" gap="md" padding="none">
        <Text variant="heading-md">rule</Text>
        {value == null ? (
          <Container layout="vertical" gap="sm" padding="none">
            <Text variant="body-sm" color="faint">
              matches everyone
            </Text>
            <Container layout="horizontal" gap="sm" alignItems="center" wrap padding="none">
              <Button type="button" variant="secondary" size="sm" onClick={() => onChange(makeCondition(ops, factPaths))}>
                add condition
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => onChange(makeGroup(ops, factPaths))}>
                add group
              </Button>
            </Container>
          </Container>
        ) : (
          <DeciderNode node={value} ops={ops} factPaths={factPaths} onChange={onChange} />
        )}
      </Container>
    </Card>
  );
}
