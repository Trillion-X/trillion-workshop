import {
  ActionContext,
  ActionDescriptor,
  TargetInvocation,
  buildRecordWorkActionInvocation,
} from './invoke-record-work-action';

export function invokeCustomerSupportAction(
  descriptor: ActionDescriptor,
  context: Omit<ActionContext, 'actionId'>,
): TargetInvocation {
  return buildRecordWorkActionInvocation(descriptor, {
    ...context,
    actionId: descriptor.id,
  });
}

