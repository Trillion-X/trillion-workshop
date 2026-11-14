// package-set://bitfield-studio/packages/content-analytics/do-work/content-analytics-actions.ts
//
// Builds owner-action requests from descriptor data. The surface supplies the
// selected model item; workflow owns mutation.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  ContentAnalyticsActionDescriptor,
  ContentAnalyticsModelAction,
  ContentAnalyticsModelItem,
} from '@/packages/content-analytics/read-data/content-analytics-model';

export interface ContentAnalyticsActionContext {
  selected?: ContentAnalyticsModelItem | null;
  answers?: Readonly<Record<string, unknown>>;
}

export interface ContentAnalyticsTargetRequest {
  target: string;
  payload: Record<string, unknown>;
}

export type ContentAnalyticsTargetSender = (request: ContentAnalyticsTargetRequest) => Promise<unknown>;

function readFromContext(context: ContentAnalyticsActionContext, source: string): unknown {
  const parts = source.split('.').filter(Boolean);
  let current: unknown;
  switch (parts.shift()) {
    case 'selected':
      current = context.selected ?? null;
      break;
    case 'answers':
      current = context.answers ?? {};
      break;
    default:
      return undefined;
  }
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function buildContentAnalyticsActionInput(
  action: ContentAnalyticsActionDescriptor | ContentAnalyticsModelAction,
  context: ContentAnalyticsActionContext,
): Record<string, unknown> {
  const copied: Record<string, unknown> = {};
  for (const entry of action.copy ?? []) {
    const value = entry.from ? readFromContext(context, entry.from) : entry.value;
    if (value !== undefined) copied[entry.key] = value;
  }
  return {
    ...(action.input ?? {}),
    ...(context.answers ?? {}),
    ...copied,
    action_id: action.id,
    selected: context.selected
      ? {
          id: context.selected.id,
          title: context.selected.title,
          values: context.selected.values,
        }
      : null,
  };
}

export function buildContentAnalyticsActionRequest(
  action: ContentAnalyticsActionDescriptor | ContentAnalyticsModelAction,
  context: ContentAnalyticsActionContext,
): ContentAnalyticsTargetRequest {
  if ('blocked' in action && action.blocked) {
    throw new Error(action.blockedReason ?? 'This action is blocked.');
  }
  const operation = action.operation ?? 'execute_definition';
  const input = buildContentAnalyticsActionInput(action, context);
  if (operation === 'execute_definition') {
    if (!action.definitionId) throw new Error(`Action ${action.id} has no owner definition.`);
    return {
      target: action.target ?? 'slot::workflow',
      payload: {
        operation,
        definition_id: action.definitionId,
        include_steps: false,
        include_output: false,
        input,
      },
    };
  }
  return {
    target: action.target ?? 'slot::workflow',
    payload: {
      operation,
      action_id: action.id,
      input,
    },
  };
}

export async function invokeContentAnalyticsAction(
  action: ContentAnalyticsDescriptorAction,
  context: ContentAnalyticsActionContext,
  sender: ContentAnalyticsTargetSender = sendRequestToBitfieldTarget as ContentAnalyticsTargetSender,
): Promise<unknown> {
  const request = buildContentAnalyticsActionRequest(action, context);
  return sender(request);
}

type ContentAnalyticsDescriptorAction = ContentAnalyticsActionDescriptor | ContentAnalyticsModelAction;
