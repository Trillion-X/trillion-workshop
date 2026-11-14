import { readCalendarSelector, type CalendarSelector } from '../read-data/read-calendar-time-blocks';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export type CalendarOwnerActionDescriptor = {
  id: string;
  target: string;
  definition_id: string;
  input?: Record<string, CalendarSelector | unknown>;
  include_output?: boolean;
};

export type CalendarOwnerActionResult = {
  status: 'accepted' | 'rejected';
  descriptorId: string;
  target: string;
  reply: Record<string, unknown>;
  message: string;
};

export type CalendarOwnerActionSender = (request: {
  target: string;
  payload: Record<string, unknown>;
}) => Promise<unknown>;

const ACCEPTED_STATUSES = new Set(['ok', 'success', 'completed', 'accepted']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeReply(reply: unknown): Record<string, unknown> {
  if (!isRecord(reply)) return {};
  const payload = reply.payload;
  if (payload instanceof Uint8Array) {
    try {
      const decoded = JSON.parse(new TextDecoder().decode(payload)) as unknown;
      return isRecord(decoded) ? decoded : {};
    } catch {
      return {};
    }
  }
  return isRecord(payload) ? payload : reply;
}

function describeDescriptorError(descriptor: Partial<CalendarOwnerActionDescriptor>): string | null {
  if (!descriptor.id) return 'Action is missing its id.';
  if (!descriptor.target) return 'Action is missing its owner target.';
  if (!descriptor.definition_id) return 'Action is missing its owner definition.';
  return null;
}

function bindInput(
  input: Record<string, CalendarSelector | unknown> | undefined,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    bound[key] = isRecord(value) && ('path' in value || 'column' in value || 'fallback' in value)
      ? readCalendarSelector(source, value as CalendarSelector)
      : Array.isArray(value) || typeof value === 'string'
        ? readCalendarSelector(source, value as CalendarSelector) ?? value
        : value;
  }
  return bound;
}

async function defaultSender(request: {
  target: string;
  payload: Record<string, unknown>;
}): Promise<unknown> {
  return sendRequestToBitfieldTarget(request);
}

export async function runCalendarOwnerAction(
  descriptor: CalendarOwnerActionDescriptor,
  source: Record<string, unknown> = {},
  sender: CalendarOwnerActionSender = defaultSender,
): Promise<CalendarOwnerActionResult> {
  const descriptorError = describeDescriptorError(descriptor);
  if (descriptorError) {
    return {
      status: 'rejected',
      descriptorId: descriptor.id ?? '',
      target: descriptor.target ?? '',
      reply: {},
      message: descriptorError,
    };
  }

  const boundInput = bindInput(descriptor.input, source);
  const correlationId = typeof boundInput.correlation_id === 'string'
    ? boundInput.correlation_id
    : `calendar-action:${descriptor.id}:${Date.now()}`;

  const reply = decodeReply(await sender({
    target: descriptor.target,
    payload: {
      operation: 'execute_definition',
      definition_id: descriptor.definition_id,
      include_steps: false,
      include_output: descriptor.include_output ?? false,
      input: {
        ...boundInput,
        action_id: descriptor.id,
        correlation_id: correlationId,
      },
    },
  }));

  if ('error' in reply) {
    return {
      status: 'rejected',
      descriptorId: descriptor.id,
      target: descriptor.target,
      reply,
      message: String(reply.error),
    };
  }

  const status = String(reply.status ?? 'accepted');
  const accepted = ACCEPTED_STATUSES.has(status);
  return {
    status: accepted ? 'accepted' : 'rejected',
    descriptorId: descriptor.id,
    target: descriptor.target,
    reply,
    message: accepted ? 'Action accepted.' : `Action returned ${status}.`,
  };
}
