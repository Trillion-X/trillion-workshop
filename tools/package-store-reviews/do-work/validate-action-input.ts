import {
  type ActionDescriptor,
  type ContractIndex,
  type PlainRecord,
  isPlainRecord,
  validateFieldValue,
} from '../read-data/descriptor-contracts.ts';

export interface ActionInputValidation {
  ok: boolean;
  errors: Array<{ code: string; detail: string }>;
  fieldValues: PlainRecord;
}

export function validateActionInput(
  index: ContractIndex,
  descriptor: ActionDescriptor,
  input: unknown,
): ActionInputValidation {
  const errors: ActionInputValidation['errors'] = [];
  if (!isPlainRecord(input)) {
    return { ok: false, errors: [{ code: 'input-not-object', detail: descriptor.id }], fieldValues: {} };
  }

  const fieldValues = isPlainRecord(input.field_values) ? input.field_values : input;
  for (const fieldId of descriptor.field_ids ?? []) {
    const field = index.fields.get(fieldId);
    if (!field) {
      errors.push({ code: 'unknown-field', detail: fieldId });
      continue;
    }
    const error = validateFieldValue(field, fieldValues[fieldId]);
    if (error) errors.push({ code: error, detail: fieldId });
  }

  return { ok: errors.length === 0, errors, fieldValues };
}
