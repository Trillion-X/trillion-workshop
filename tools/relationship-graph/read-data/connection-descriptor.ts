import type {
  ConnectionProjectionDescriptor,
  InputRow,
  JsonObject,
  SelectorExpression,
} from './connection-model.ts';

export type SelectorContext = {
  readonly row: InputRow;
  readonly payload: unknown;
};

export type SelectorRegistry = ReadonlyMap<
  string,
  (expression: SelectorExpression, context: SelectorContext) => unknown
>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readPath(source: unknown, path: readonly unknown[]): unknown {
  let current = source;
  for (const segment of path) {
    if (!isObject(current) || typeof segment !== 'string') return undefined;
    current = current[segment];
  }
  return current;
}

function params(expression: SelectorExpression): JsonObject {
  return isObject(expression.params) ? expression.params : {};
}

export function rowPayload(row: InputRow): unknown {
  if (isObject(row.payload)) return row.payload;
  if (isObject(row.record) && 'payload' in row.record) return row.record.payload;
  return row.payload ?? row;
}

export const defaultSelectorRegistry: SelectorRegistry = new Map([
  ['literal', (expression) => params(expression).value],
  ['record-address', (_expression, context) => context.row.address],
  ['json-path', (expression, context) => {
    const path = params(expression).path;
    return Array.isArray(path) ? readPath(context.payload, path) : undefined;
  }],
  ['row-path', (expression, context) => {
    const path = params(expression).path;
    return Array.isArray(path) ? readPath(context.row, path) : undefined;
  }],
  ['include-all', () => true],
  ['exists', (expression, context) => evaluateSelector(params(expression).value as SelectorExpression, context) != null],
  ['equals', (expression, context) => {
    const left = evaluateSelector(params(expression).left as SelectorExpression, context);
    const right = evaluateSelector(params(expression).right as SelectorExpression, context);
    return left === right;
  }],
  ['and', (expression, context) => {
    const values = params(expression).values;
    return Array.isArray(values) && values.every((value) => evaluateSelector(value as SelectorExpression, context) === true);
  }],
  ['json-field-equals', (expression, context) => {
    const expressionParams = params(expression);
    const path = expressionParams.path;
    return Array.isArray(path) && readPath(context.payload, path) === expressionParams.value;
  }],
]);

export function evaluateSelector(
  expression: SelectorExpression | undefined,
  context: SelectorContext,
  registry: SelectorRegistry = defaultSelectorRegistry,
): unknown {
  if (!expression) return true;
  const evaluator = registry.get(expression.method);
  if (!evaluator) return undefined;
  return evaluator(expression, context);
}

export function textValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function objectValue(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

export function validateConnectionProjectionDescriptor(value: unknown): ConnectionProjectionDescriptor {
  if (!isObject(value)) throw new Error('Connection graph setup is missing.');
  if (value.kind !== 'generic-connection-projection-descriptor') {
    throw new Error('Connection graph setup has the wrong kind.');
  }
  if (!textValue(value.id)) throw new Error('Connection graph setup needs an id.');
  if (!Array.isArray(value.record_selectors)) {
    throw new Error('Connection graph setup needs record selectors.');
  }
  return value as ConnectionProjectionDescriptor;
}
