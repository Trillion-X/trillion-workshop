import * as React from 'react';
import {sendRequestToBitfieldTarget} from '#workspace-records';
import {addressedCellInputsFromPublishedRecords, cellRefKey, foldAddressedCellExpressions} from '../do-work/cell-expression';
import {projectAddressedCellReadRecords} from '../do-work/addressed-cell-read-projection';
import type {AuthoringEvaluationDispatch, DeriveDispatch} from '../do-work/resolve-derived-fields';
import {decodeVisualDatabaseEvaluatorDescriptors, recordIdentityKey} from '../read-data/visual-database';
import type {VisualDatabaseEvaluatorDescriptor, VisualDatabaseModel} from '../read-data/visual-database';
import {ExpressionOwnerSessionFactory} from '../do-work/expression-owner-session';
import {expressionEvaluationProvenanceLabels, readDurableExpressionSource} from '../do-work/expression-owner-protocol';
import {buildExpressionReferenceCatalog, mapExpressionEvaluationReads} from './reference-catalog';

export interface DerivedReadField {
  id: string;
  defaultExpression?: unknown;
  read?: (record: any) => unknown;
}

export interface DerivedReadProjection {
  /** Re-evaluates the current addressed source graph for these visible owner rows. */
  project: (records: readonly any[], fields: readonly DerivedReadField[]) => Promise<{records: readonly any[]; incomplete?: true}>;
  pending?: (records: readonly any[], fields: readonly DerivedReadField[]) => readonly any[];
}

export interface AddressedCellExpressionOwnerOutput {
  cellExpressionInputs: ReturnType<typeof addressedCellInputsFromPublishedRecords>;
  evaluatorDescriptors: readonly VisualDatabaseEvaluatorDescriptor[];
  dispatchDerived: DeriveDispatch;
  derivedReadProjection: DerivedReadProjection;
}

const dispatchDerived: DeriveDispatch = async (target, request) => {
  const reply = await sendRequestToBitfieldTarget({target, payload: request});
  const bytes = (reply as {payload?: Uint8Array})?.payload;
  if (!bytes?.length) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
};

/** Adapts published cell-expression and evaluator feeds to the shared
 * Visual Database resolver and its authored-expression owner. */
export function useAddressedCellExpressionOwner(
  cellExpressionRecords: unknown,
  evaluatorDescriptorRecords: unknown,
  model?: VisualDatabaseModel,
): AddressedCellExpressionOwnerOutput {
  const cellExpressionInputs = React.useMemo(
    () => addressedCellInputsFromPublishedRecords(cellExpressionRecords),
    [cellExpressionRecords],
  );
  const evaluatorDescriptors = React.useMemo(
    () => decodeVisualDatabaseEvaluatorDescriptors(evaluatorDescriptorRecords),
    [evaluatorDescriptorRecords],
  );
  const expressionOwnerSessionFactory = React.useMemo(
    () => new ExpressionOwnerSessionFactory(dispatchDerived),
    [],
  );
  const evaluateAuthored = React.useCallback<AuthoringEvaluationDispatch>(async ({cell, evaluator, context}) => {
    const authoring = evaluator.authoring;
    if (!authoring || !cell.expression.derive) throw new Error('The addressed expression has no authoring contract.');
    if (!model) throw new Error('The current record model is unavailable for authored expression evaluation.');
    const source = readDurableExpressionSource(authoring, cell.expression.derive.request);
    if (source === null) throw new Error('The addressed expression has no durable human source.');
    const catalog = buildExpressionReferenceCatalog(model, {currentRecordRef: cell.cellRef.recordRef});
    const ownerSession = expressionOwnerSessionFactory.create({
      target: evaluator.target,
      descriptor: authoring,
      sourceRevision: cell.revision ?? `default:${JSON.stringify([cell.cellRef.recordRef, cell.cellRef.fieldRef])}`,
      catalogRevision: catalog.revision,
    });
    try {
      const reply = await ownerSession.evaluate({source, cursor_offset_utf16: source.length, variables: context});
      if (Array.isArray(reply.values.diagnostics) && reply.values.diagnostics.some((diagnostic) => (
        !!diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic)
        && (diagnostic as {severity?: unknown}).severity === 'error'
      ))) throw new Error('The expression owner rejected the durable source during recomputation.');
      const mapped = mapExpressionEvaluationReads(reply.values.evaluation_readset, catalog);
      if (mapped.issues.length) throw new Error(`The expression owner returned ${mapped.issues.length} unresolved read reference${mapped.issues.length === 1 ? '' : 's'}.`);
      const labels = expressionEvaluationProvenanceLabels(evaluator);
      return {
        value: reply.values.evaluation_result,
        projection: {
          evaluatorRef: evaluator.ref,
          evaluatorTarget: evaluator.target,
          evaluatorRevision: evaluator.revision ?? authoring.revision,
          policyRevision: reply.policyRevision,
          provenanceRefFamily: labels.family,
          provenanceDisplayLabel: labels.displayLabel,
          reads: mapped.reads,
        },
      };
    } finally {
      ownerSession.close();
    }
  }, [expressionOwnerSessionFactory, model]);
  const derivedReadProjection = React.useMemo<DerivedReadProjection>(() => ({
    pending: (records, fields) => {
      const folded = foldAddressedCellExpressions(fields as Parameters<typeof foldAddressedCellExpressions>[0], cellExpressionInputs);
      const explicit = new Set(folded.filter(cell => cell.source === 'cell' || cell.explicitSourceInvalid).map(cell => cellRefKey(cell.cellRef)));
      return records.map(record => {
        const values = new Map(record?.fieldValues instanceof Map ? record.fieldValues : []);
        for (const field of fields) {
          if (field.defaultExpression !== undefined || explicit.has(cellRefKey({recordRef: recordIdentityKey(record), fieldRef: field.id}))) values.set(field.id, undefined);
        }
        return values.size ? {...record, fieldValues: values} : record;
      });
    },
    project: async (records, fields) => {
      return projectAddressedCellReadRecords({
        records,
        fields: fields as unknown as Parameters<typeof projectAddressedCellReadRecords>[0]['fields'],
        cellExpressionInputs,
        evaluatorDescriptors,
        dispatchDerived,
        evaluateAuthored,
        recordRef: (record) => recordIdentityKey(record),
        readField: (record, field) => {
          const matchingField = fields.find(candidate => candidate.id === field.id);
          if (matchingField?.read) return matchingField.read(record);
          return record?.fieldValues instanceof Map ? record.fieldValues.get(field.id) : record?.[field.id];
        },
      });
    },
  }), [cellExpressionInputs, evaluatorDescriptors, evaluateAuthored]);
  return React.useMemo(() => ({cellExpressionInputs, evaluatorDescriptors, dispatchDerived, derivedReadProjection}), [cellExpressionInputs, evaluatorDescriptors, derivedReadProjection]);
}
