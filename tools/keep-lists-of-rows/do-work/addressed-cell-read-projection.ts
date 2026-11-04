import {cellRefKey, foldAddressedCellExpressions, type AddressedCellExpressionInputs} from './cell-expression';
import {resolveAddressedCells, resolutionInputsForFoldedCells, type AuthoringEvaluationDispatch, type DeriveDispatch} from './resolve-derived-fields';
import type {VisualDatabaseEvaluatorDescriptor, VisualDatabaseFieldDescriptor} from '../read-data/visual-database';

export interface AddressedCellReadRecord {
  fieldValues?: Map<string, unknown>;
  [key: string]: unknown;
}

export interface AddressedCellReadProjectionResult<T> {
  records: readonly T[];
  incomplete?: true;
}

/** Resolve the same addressed sources, defaults, caches and evaluator graph as
 * Visual Database, then project expression-backed values into owner rows. */
export async function projectAddressedCellReadRecords<T extends AddressedCellReadRecord>(input: {
  records: readonly T[];
  fields: readonly VisualDatabaseFieldDescriptor[];
  cellExpressionInputs: AddressedCellExpressionInputs;
  evaluatorDescriptors: readonly VisualDatabaseEvaluatorDescriptor[];
  dispatchDerived: DeriveDispatch;
  evaluateAuthored?: AuthoringEvaluationDispatch;
  recordRef: (record: T) => string;
  readField: (record: T, field: VisualDatabaseFieldDescriptor) => unknown;
}): Promise<AddressedCellReadProjectionResult<T>> {
  const {records, fields, cellExpressionInputs, evaluatorDescriptors, dispatchDerived, evaluateAuthored, recordRef, readField} = input;
  const folded = foldAddressedCellExpressions(fields, cellExpressionInputs);
  const defaults = records.flatMap((record) => fields.map((field) => ({
    cellRef: {recordRef: recordRef(record), fieldRef: field.id},
    expression: field.defaultExpression ?? {literal: readField(record, field)},
  })));
  const inputs = resolutionInputsForFoldedCells(folded, defaults).map((cell) => {
    const source = cellExpressionInputs.sources.find((candidate) => {
      const ref = (candidate.payload as {cell_ref?: {record_ref?: unknown; field_ref?: unknown}}).cell_ref;
      return ref?.record_ref === cell.cellRef.recordRef && ref?.field_ref === cell.cellRef.fieldRef;
    });
    return {...cell, revision: source?.revision};
  });
  const resolution = await resolveAddressedCells(inputs, dispatchDerived, undefined, evaluatorDescriptors, evaluateAuthored);
  const foldedByKey = new Map(folded.map((cell) => [cellRefKey(cell.cellRef), cell]));
  const inputByKey = new Map(inputs.map((cell) => [cellRefKey(cell.cellRef), cell]));
  let incomplete = false;
  const projected = records.map((record) => {
    const values = new Map<string, unknown>();
    for (const field of fields) {
      const key = cellRefKey({recordRef: recordRef(record), fieldRef: field.id});
      const cell = resolution.cells.get(key);
      const source = foldedByKey.get(key);
      const expressionInput = inputByKey.get(key);
      if (source?.explicitSourceInvalid) {
        incomplete = true;
        values.set(field.id, undefined);
      } else if (cell && expressionInput && (
        source?.source === 'cell' || field.defaultExpression !== undefined
      )) {
        if (cell.error) incomplete = true;
        values.set(field.id, cell.error ? undefined : cell.value);
      }
    }
    if (!values.size) return record;
    const prior = record.fieldValues instanceof Map ? record.fieldValues : new Map<string, unknown>();
    return {...record, fieldValues: new Map([...prior, ...values])};
  });
  return {records: projected, ...(incomplete ? {incomplete: true as const} : {})};
}
