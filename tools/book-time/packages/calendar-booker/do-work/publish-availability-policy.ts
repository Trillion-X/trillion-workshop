import {
  buildCalendarBookerOwnerActionRequest,
  invokeCalendarBookerOwnerAction,
  type AnyRecord,
  type CalendarBookerActionDescriptor,
} from './calendar-booker-actions';

const PUBLISH_INTENT_REF = 'descriptor:calendar-booker:owner-action:generate-availability-slots';

export interface AvailabilityPolicyPublishRequest {
  descriptors: CalendarBookerActionDescriptor[];
  input: AnyRecord;
  idempotencyKey?: string;
}

export function buildAvailabilityPolicyTargetRequest(request: AvailabilityPolicyPublishRequest) {
  return buildCalendarBookerOwnerActionRequest({
    intentRef: PUBLISH_INTENT_REF,
    descriptors: request.descriptors,
    input: request.input,
    idempotencyKey: request.idempotencyKey,
  });
}

export function buildAvailabilityPolicyWorkflowPayload(request: AvailabilityPolicyPublishRequest) {
  return buildAvailabilityPolicyTargetRequest(request).payload;
}

export function publishAvailabilityPolicy(request: AvailabilityPolicyPublishRequest): Promise<unknown> {
  return invokeCalendarBookerOwnerAction({
    intentRef: PUBLISH_INTENT_REF,
    descriptors: request.descriptors,
    input: request.input,
    idempotencyKey: request.idempotencyKey,
  });
}
