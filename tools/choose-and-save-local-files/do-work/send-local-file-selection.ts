import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export interface LocalFileSelectionTarget {
  target: string;
  definition_id: string;
  input_field?: string;
}

function readInputField(target: LocalFileSelectionTarget): string {
  return typeof target.input_field === 'string' && target.input_field.length > 0
    ? target.input_field
    : 'path';
}

export async function sendLocalFileSelection(
  target: LocalFileSelectionTarget,
  path: string,
): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: target.target,
    payload: {
      operation: 'execute_definition',
      definition_id: target.definition_id,
      include_steps: false,
      include_output: false,
      input: {
        [readInputField(target)]: path,
      },
    },
  });
}
