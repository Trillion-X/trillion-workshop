import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { MarkOperationRecord } from '../read-data/addressed-marks';

export const RECORD_MARK_OPERATION_ACTION = 'action:record-addressed-mark-operation';

export interface MarkOperationWrite {
  id: string;
  target: MarkOperationRecord['target'];
  toolRef?: string;
  styleRef?: string;
  createdAt?: string;
  sequence?: number;
  body: MarkOperationRecord['body']['raw'];
}

export type MarkOperationSender = typeof sendRequestToBitfieldTarget;

export function buildMarkOperationRequest(operation: MarkOperationWrite) {
  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: RECORD_MARK_OPERATION_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        operation_id: operation.id,
        target: operation.target,
        tool_ref: operation.toolRef,
        style_ref: operation.styleRef,
        created_at: operation.createdAt,
        sequence: operation.sequence,
        body: operation.body,
      },
    },
  };
}

export function recordMarkOperation(
  operation: MarkOperationWrite,
  sender: MarkOperationSender = sendRequestToBitfieldTarget,
): Promise<unknown> {
  return sender(buildMarkOperationRequest(operation));
}
