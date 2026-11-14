// package://packages/person-list/do-work/owner-action-descriptors.ts
//
// Descriptor-driven owner action dispatch. The package code sends the declared
// target and payload; action ids and owner routing are package data.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export interface OwnerActionDescriptor {
  key: string;
  target: string;
  operation: string;
  definitionId: string;
  includeSteps?: boolean;
  includeOutput?: boolean;
  inputTemplate?: Record<string, unknown>;
}

export type ActionInput = Record<string, unknown>;

export function decodeOwnerActionDescriptors(raw: unknown): OwnerActionDescriptor[] {
  const source = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { actions?: unknown[] }).actions)
      ? (raw as { actions: unknown[] }).actions
      : [];
  return source
    .filter((item): item is Record<string, unknown> => (
      !!item && typeof item === 'object' && !Array.isArray(item)
    ))
    .map((item) => ({
      key: typeof item.key === 'string' ? item.key.trim() : '',
      target: typeof item.target === 'string' ? item.target.trim() : '',
      operation: typeof item.operation === 'string' ? item.operation.trim() : '',
      definitionId: typeof item.definition_id === 'string'
        ? item.definition_id.trim()
        : typeof item.definitionId === 'string'
          ? item.definitionId.trim()
          : '',
      includeSteps: typeof item.include_steps === 'boolean'
        ? item.include_steps
        : typeof item.includeSteps === 'boolean'
          ? item.includeSteps
          : undefined,
      includeOutput: typeof item.include_output === 'boolean'
        ? item.include_output
        : typeof item.includeOutput === 'boolean'
          ? item.includeOutput
          : undefined,
      inputTemplate: item.input_template && typeof item.input_template === 'object' && !Array.isArray(item.input_template)
        ? item.input_template as Record<string, unknown>
        : item.inputTemplate && typeof item.inputTemplate === 'object' && !Array.isArray(item.inputTemplate)
          ? item.inputTemplate as Record<string, unknown>
          : undefined,
    }))
    .filter((item) => item.key && item.target && item.operation && item.definitionId);
}

export function requireOwnerActionDescriptor(
  descriptors: readonly OwnerActionDescriptor[],
  key: string,
): OwnerActionDescriptor {
  const descriptor = descriptors.find((item) => item.key === key);
  if (!descriptor) throw new Error(`Missing owner-action descriptor: ${key}`);
  return descriptor;
}

export function buildOwnerActionPayload(
  descriptor: OwnerActionDescriptor,
  input: ActionInput = {},
): Record<string, unknown> {
  return {
    operation: descriptor.operation,
    definition_id: descriptor.definitionId,
    include_steps: descriptor.includeSteps ?? false,
    include_output: descriptor.includeOutput ?? false,
    input: {
      ...(descriptor.inputTemplate ?? {}),
      ...input,
    },
  };
}

export async function dispatchOwnerAction(
  descriptor: OwnerActionDescriptor,
  input: ActionInput = {},
): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: descriptor.target,
    payload: buildOwnerActionPayload(descriptor, input),
  });
}
