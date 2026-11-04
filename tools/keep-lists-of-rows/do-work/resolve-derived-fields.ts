//
// Addressed-cell evaluation physics.  The board owns expression identity and
// dependency dirtiness; evaluators remain opaque Envelope targets.  There is
// deliberately no evaluator-kind branch and no field-wide execution path.

import {
  cellRefKey,
  expressionSourceShape,
  materializeAddressedDependencies,
  type FoldedCellExpression,
  type MaterializedCellExpression,
} from './cell-expression';
import type {
  VisualDatabaseCellCache,
  VisualDatabaseCellProvenance,
} from './cell-expression';
import type {
  VisualDatabaseCellRef,
  VisualDatabaseEvaluatorDescriptor,
  VisualDatabaseValueExpression,
} from '../read-data/visual-database';

export type DeriveDispatch = (target: string, request: Record<string, unknown>) => Promise<unknown>;

export interface AddressedCellInput {
  cellRef: VisualDatabaseCellRef;
  expression: VisualDatabaseValueExpression;
  revision?: string;
  cachedValue?: VisualDatabaseCellCache;
}

export interface ResolvedCell {
  cellRef: VisualDatabaseCellRef;
  value?: unknown;
  cachedValue?: VisualDatabaseCellCache;
  error?: {
    code: 'cycle' | 'missing-dependency' | 'evaluator';
    message: string;
    /** Complete addressed path in traversal order. UI may translate each
     * identity to a human label, but must not truncate or reorder it. */
    dependencyPath?: readonly string[];
  };
  evaluated: boolean;
  evaluatorTarget?: string;
  evaluationProjection?: {
    evaluatorRef: string;
    evaluatorTarget: string;
    evaluatorRevision: string;
    policyRevision: string;
    provenanceRefFamily: string;
    provenanceDisplayLabel: string;
    reads: NonNullable<VisualDatabaseCellProvenance['reads']>;
  };
}

export interface AddressedResolution {
  cells: ReadonlyMap<string, ResolvedCell>;
  dirtyRefs: readonly VisualDatabaseCellRef[];
  events: readonly Record<string, unknown>[];
}

export type AuthoringEvaluationDispatch = (input: {
  cell: AddressedCellInput;
  evaluator: VisualDatabaseEvaluatorDescriptor;
  context: Readonly<Record<string, unknown>>;
}) => Promise<{
  value: unknown;
  projection: NonNullable<ResolvedCell['evaluationProjection']>;
}>;

/**
 * Selects the only cells allowed into the evaluator graph. Explicit source
 * corruption occupies its addressed identity, so a field default cannot
 * silently replace it. Cache/provenance defects remain projection concerns and
 * do not suppress a genuinely absent source's default.
 */
export function resolutionInputsForFoldedCells(
  folded: readonly FoldedCellExpression[],
  defaults: readonly AddressedCellInput[],
): readonly AddressedCellInput[] {
  const blocked = new Set(
    folded.filter((cell) => cell.explicitSourceInvalid).map((cell) => cellRefKey(cell.cellRef)),
  );
  const explicit = folded.flatMap((cell) => (
    !cell.explicitSourceInvalid && cell.expression
      ? [{
        cellRef: cell.cellRef,
        expression: materializeAddressedDependencies(cell.expression, cell.cellRef.recordRef),
        cachedValue: cell.cachedValue,
      }]
      : []
  ));
  const occupied = new Set([...blocked, ...explicit.map((cell) => cellRefKey(cell.cellRef))]);
  return [
    ...explicit,
    ...defaults
      .filter((cell) => !occupied.has(cellRefKey(cell.cellRef)))
      .map((cell) => ({
        ...cell,
        expression: materializeAddressedDependencies(cell.expression, cell.cellRef.recordRef),
      })),
  ];
}

function readReplyPath(reply: unknown, path: readonly string[] | undefined): unknown {
  let current = reply;
  for (const segment of path ?? []) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const PATH_PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]));
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Insert evaluator context through a validated generic object path without
 * mutating owner request DATA. Existing non-equal leaf bytes fail closed. */
export function composeDerivedRequest(
  request: Readonly<Record<string, unknown>> | undefined,
  contextPath: readonly string[] | undefined,
  context: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const path = contextPath ?? ['context'];
  if (path.length === 0 || path.length > 64 || path.some((segment) => (
    !segment || segment.trim() !== segment || PATH_PROTOTYPE_KEYS.has(segment)
  ))) throw new Error('Evaluator context path is invalid.');
  const output = cloneJsonValue(request ?? {}) as Record<string, unknown>;
  let current = output;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const existing = current[segment];
    if (existing === undefined) current[segment] = {};
    else if (!isRecord(existing)) throw new Error(`Evaluator context path cannot traverse ${segment}.`);
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = path[path.length - 1]!;
  if (current[leaf] !== undefined && !jsonEqual(current[leaf], context)) {
    throw new Error(`Evaluator context path ${JSON.stringify(path)} already contains a different value.`);
  }
  current[leaf] = cloneJsonValue(context);
  return output;
}

function refsFor(keys: Iterable<string>, cells: ReadonlyMap<string, AddressedCellInput>): VisualDatabaseCellRef[] {
  return [...keys].map((key) => cells.get(key)?.cellRef).filter((ref): ref is VisualDatabaseCellRef => !!ref);
}

/** Returns only the changed roots and their transitive downstream closure.
 * A missing root is still rejected by resolution; it never becomes a dynamic
 * edge.  This flat reverse side-map is the O(changed) performance boundary. */
export function dirtyAddressedCells(
  inputs: readonly AddressedCellInput[],
  changed: readonly VisualDatabaseCellRef[],
): readonly VisualDatabaseCellRef[] {
  const cells = new Map(inputs.map((cell) => [cellRefKey(cell.cellRef), cell]));
  const reverse = new Map<string, Set<string>>();
  for (const cell of inputs) for (const ref of cell.expression.derive?.dependencyRefs ?? []) {
    const key = cellRefKey(ref);
    const users = reverse.get(key) ?? new Set<string>();
    users.add(cellRefKey(cell.cellRef)); reverse.set(key, users);
  }
  const dirty = new Set(changed.map(cellRefKey));
  const queue = [...dirty];
  while (queue.length) for (const dependent of reverse.get(queue.shift()!) ?? []) {
    if (!dirty.has(dependent)) { dirty.add(dependent); queue.push(dependent); }
  }
  return refsFor(dirty, cells);
}

/** Resolves a graph component.  `changed` is omitted only for an initial
 * projection; subsequent calls evaluate the dirty closure alone. */
export async function resolveAddressedCells(
  inputs: readonly AddressedCellInput[],
  dispatch: DeriveDispatch,
  changed?: readonly VisualDatabaseCellRef[],
  evaluatorDescriptors: readonly VisualDatabaseEvaluatorDescriptor[] = [],
  evaluateAuthored?: AuthoringEvaluationDispatch,
): Promise<AddressedResolution> {
  const cells = new Map(inputs.map((cell) => [cellRefKey(cell.cellRef), cell]));
  const evaluatorByRef = new Map(evaluatorDescriptors.map((descriptor) => [descriptor.ref, descriptor]));
  const dirty = new Set((changed ? dirtyAddressedCells(inputs, changed) : inputs.map((cell) => cell.cellRef)).map(cellRefKey));
  const state = new Map<string, 'visiting' | 'done'>();
  const output = new Map<string, ResolvedCell>();
  const events: Record<string, unknown>[] = [];

  type Frame = { key: string; dependencyIndex: number; context: Record<string, unknown> };
  const finish = (key: string, resolved: ResolvedCell) => { output.set(key, resolved); state.set(key, 'done'); };

  /**
   * Iterative post-order DFS.  This is the same addressed graph walk as the
   * former recursive evaluator, but its call depth is now constant even for a
   * 100,000-cell chain.  `active` replaces the recursive trail solely for
   * exact cycle provenance; dependency values still arrive in declaration
   * order, preserving evaluator context semantics.
   */
  const evaluate = async (root: string): Promise<void> => {
    if (state.get(root) === 'done') return;
    const stack: Frame[] = [];
    const active: string[] = [];
    const activeIndex = new Map<string, number>();
    const enter = (key: string): boolean => {
      const input = cells.get(key);
      if (!input) return false;
      if (state.get(key) === 'done') return false;
      // A clean dependency is read from its independent cached projection.
      if (!dirty.has(key) && input.cachedValue) {
        finish(key, { cellRef: input.cellRef, value: input.cachedValue.value, cachedValue: input.cachedValue, evaluated: false });
        return false;
      }
      const expression = input.expression;
      if (expressionSourceShape(expression) === 'literal') {
        finish(key, { cellRef: input.cellRef, value: expression.literal, cachedValue: input.cachedValue, evaluated: false });
        return false;
      }
      if (!expression.derive) {
        finish(key, { cellRef: input.cellRef, cachedValue: input.cachedValue, evaluated: false, error: { code: 'evaluator', message: 'Cell has no active expression.' } });
        return false;
      }
      state.set(key, 'visiting'); activeIndex.set(key, active.length); active.push(key);
      stack.push({ key, dependencyIndex: 0, context: {} });
      return true;
    };

    enter(root);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (state.get(frame.key) === 'done') {
        stack.pop(); activeIndex.delete(frame.key); active.pop(); continue;
      }
      const input = cells.get(frame.key)!;
      const derive = input.expression.derive!;
      const dependencies = derive.dependencyRefs ?? [];
      if (frame.dependencyIndex < dependencies.length) {
        const dependency = dependencies[frame.dependencyIndex++]!;
        const dependencyKey = cellRefKey(dependency);
        const dependencyInput = cells.get(dependencyKey);
        if (!dependencyInput) {
          finish(frame.key, {
            cellRef: input.cellRef,
            cachedValue: input.cachedValue,
            evaluated: false,
            error: {
              code: 'missing-dependency',
              message: `Missing dependency ${dependencyKey}.`,
              dependencyPath: [frame.key, dependencyKey],
            },
          });
          continue;
        }
        if (state.get(dependencyKey) === 'visiting') {
          const start = activeIndex.get(dependencyKey)!;
          const loop = [...active.slice(start), dependencyKey];
          const message = `Dependency cycle: ${loop.join(' → ')}`;
          for (const member of loop) {
            const memberInput = cells.get(member);
            if (memberInput) {
              finish(member, {
                cellRef: memberInput.cellRef,
                evaluated: false,
                error: { code: 'cycle', message, dependencyPath: loop },
              });
            }
          }
          events.push({ event: 'visual_database.cell_cycle', cycle_refs: loop });
          continue;
        }
        if (state.get(dependencyKey) !== 'done') {
          // Revisit this edge after its post-order child has completed so the
          // declared field key is populated from the resolved dependency.
          frame.dependencyIndex -= 1;
          enter(dependencyKey);
          continue;
        }
        const dependencyCell = output.get(dependencyKey)!;
        if (dependencyCell.error) {
          finish(frame.key, { cellRef: input.cellRef, cachedValue: input.cachedValue, evaluated: false, error: dependencyCell.error });
          continue;
        }
        const contextKey = dependency.contextKey ?? dependency.fieldRef;
        if (Object.prototype.hasOwnProperty.call(frame.context, contextKey)) {
          finish(frame.key, { cellRef: input.cellRef, cachedValue: input.cachedValue, evaluated: false, error: { code: 'evaluator', message: `Dependency context key ${contextKey} is ambiguous.` } });
          continue;
        }
        frame.context[contextKey] = dependencyCell.value;
        continue;
      }
      try {
        const evaluator = derive.evaluatorRef ? evaluatorByRef.get(derive.evaluatorRef) : undefined;
        if (derive.evaluatorRef && !evaluator) {
          throw new Error(`Evaluator descriptor ${derive.evaluatorRef} is unavailable.`);
        }
        if (evaluator && evaluator.target !== derive.target) {
          throw new Error(`Evaluator descriptor ${derive.evaluatorRef} target does not match the cell source.`);
        }
        if (evaluator?.authoring && evaluateAuthored) {
          const evaluated = await evaluateAuthored({ cell: input, evaluator, context: frame.context });
          finish(frame.key, {
            cellRef: input.cellRef,
            value: evaluated.value,
            cachedValue: input.cachedValue,
            evaluated: true,
            evaluatorTarget: derive.target,
            evaluationProjection: evaluated.projection,
          });
        } else {
          const reply = await dispatch(
            derive.target,
            composeDerivedRequest(derive.request, evaluator?.contextPath, frame.context),
          );
          finish(frame.key, { cellRef: input.cellRef, value: readReplyPath(reply, derive.resultPath), cachedValue: input.cachedValue, evaluated: true, evaluatorTarget: derive.target });
        }
        events.push({ event: 'visual_database.cell_evaluated', cell_ref: input.cellRef, evaluator_target: derive.target });
      } catch (failure) {
        finish(frame.key, { cellRef: input.cellRef, cachedValue: input.cachedValue, evaluated: false, error: { code: 'evaluator', message: failure instanceof Error ? failure.message : String(failure) } });
      }
    }
  };
  for (const key of dirty) await evaluate(key);
  events.unshift({ event: 'visual_database.cells_dirtied', source_cell_ref: changed?.[0], dependent_refs: refsFor(dirty, cells) });
  return { cells: output, dirtyRefs: refsFor(dirty, cells), events };
}

/** T6 materialized cells satisfy the resolver input without reassembling facts. */
export function resolverInput(cell: MaterializedCellExpression): AddressedCellInput {
  return { cellRef: cell.cellRef, expression: cell.expression, revision: cell.revision, cachedValue: cell.cachedValue };
}
