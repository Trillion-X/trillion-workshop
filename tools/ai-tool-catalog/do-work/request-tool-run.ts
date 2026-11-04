// PORTED FROM: bitfield-packages/packages/ai-tool-catalog/do-work/request-tool-run.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { ValidateFunction } from 'ajv/dist/2020.js';

/** Owner-hydrated binding. None of these values are model-visible invocation input. */
export type TrustedToolBinding = {
  target: string;
  toolRef: string;
  /** Owner-authored JSON Schema for the model-visible input. */
  modelInputSchema: Record<string, unknown>;
  /** Optional owner mapping from model-visible field names to action input names. */
  inputFieldMap?: Record<string, string>;
  fixedInput?: Record<string, unknown>;
  trustedContext?: Record<string, unknown>;
};

// The schema checker is fetched the first time a tool is asked to run, never with the screen that offers it.
let validator: Promise<{ compile: (schema: Record<string, unknown>) => ValidateFunction }> | null = null;
const schemaChecker = () => (validator ??= import('ajv/dist/2020.js').then(module => new module.default({ allErrors: true, strict: true, validateFormats: false })));
const compiledSchemas = new WeakMap<object, ValidateFunction>();

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function binding(value: TrustedToolBinding): TrustedToolBinding {
  if (!value || typeof value.target !== 'string' || !value.target.trim() || typeof value.toolRef !== 'string' || !value.toolRef.trim()) throw new Error('owner binding is invalid');
  if (!record(value.modelInputSchema)) throw new Error('owner model input schema is invalid');
  if (value.inputFieldMap && !record(value.inputFieldMap)) throw new Error('owner input field map is invalid');
  if (value.fixedInput && !record(value.fixedInput)) throw new Error('owner fixed input is invalid');
  if (value.trustedContext && !record(value.trustedContext)) throw new Error('owner trusted context is invalid');
  return value;
}

async function validateModelInput(value: unknown, schema: Record<string, unknown>): Promise<Record<string, unknown>> {
  let validate = compiledSchemas.get(schema);
  if (!validate) {
    try {
      validate = (await schemaChecker()).compile(schema);
    } catch (error) {
      throw new Error(`owner model input schema cannot be compiled: ${error instanceof Error ? error.message : String(error)}`);
    }
    compiledSchemas.set(schema, validate);
  }
  if (!validate(value) || !record(value)) {
    const detail = validate.errors?.map((entry) => `${entry.instancePath || '/'} ${entry.message ?? 'is invalid'}`).join('; ') || 'must be an object';
    throw new Error(`tool input violates owner schema: ${detail}`);
  }
  return value;
}

function mappedInput(input: Record<string, unknown>, trusted: TrustedToolBinding): Record<string, unknown> {
  const mapping = trusted.inputFieldMap ?? {};
  const protectedFields = new Set([...Object.keys(trusted.fixedInput ?? {}), ...Object.keys(trusted.trustedContext ?? {})]);
  const outputEntries: [string, unknown][] = [];
  const outputFields = new Set<string>();
  for (const [modelField, value] of Object.entries(input)) {
    const actionField = Object.prototype.hasOwnProperty.call(mapping, modelField) ? mapping[modelField] : modelField;
    if (typeof actionField !== 'string' || !actionField.trim()) throw new Error(`owner input mapping for ${modelField} is invalid`);
    if (protectedFields.has(actionField)) throw new Error(`owner binding cannot shadow protected field ${actionField}`);
    if (outputFields.has(actionField)) throw new Error(`owner input mapping aliases multiple fields to ${actionField}`);
    outputFields.add(actionField);
    outputEntries.push([actionField, value]);
  }
  for (const field of Object.keys(mapping)) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) throw new Error(`owner input mapping names absent model field ${field}`);
  }
  return Object.fromEntries(outputEntries);
}

export async function requestToolRun(modelInput: unknown, ownerBinding: TrustedToolBinding, signal?: AbortSignal) {
  const trusted = binding(ownerBinding);
  const input = mappedInput(await validateModelInput(modelInput, trusted.modelInputSchema), trusted);
  return sendRequestToBitfieldTarget({
    target: trusted.target,
    payload: {
      operation: 'execute_definition',
      definition_id: trusted.toolRef,
      include_output: true,
      input: { ...(trusted.fixedInput ?? {}), ...(trusted.trustedContext ?? {}), ...input },
    },
  }, signal);
}
