import {
  buildOwnerActionTargetRequest,
  invokeOwnerActionDescriptor,
  type OwnerActionDescriptor,
  type OwnerActionInvocation,
  type OwnerActionTargetRequest,
} from './invoke-owner-action-descriptor';

export type AnyRecord = Record<string, unknown>;

export interface CalendarBookerActionDescriptor extends OwnerActionDescriptor {
  descriptor_id?: string;
  action_ref: string;
}

export interface CalendarBookerActionContext {
  intentRef: string;
  input?: AnyRecord;
  descriptors: CalendarBookerActionDescriptor[];
  idempotencyKey?: string;
}

function isActionDescriptor(value: unknown): value is CalendarBookerActionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as AnyRecord;
  return record.kind === 'owner_action_descriptor' && typeof record.action_ref === 'string';
}

export function calendarBookerActionDescriptors(records: unknown[]): CalendarBookerActionDescriptor[] {
  return records.filter(isActionDescriptor);
}

/**
 * Reduce any ref form to its trailing slug: `package::pkg::owner-action::x` ->
 * `x`, `action:pkg.x` -> `x`, `descriptor:pkg:owner-action:x` -> `x`. The single
 * generic identity rule the resolver matches on — no per-action branch (L090).
 */
export function normalizeActionRef(ref: string): string {
  const flattened = ref.replace(/::/g, ':');
  const lastSegment = flattened.split(':').pop() ?? flattened;
  return lastSegment.split('.').pop() ?? lastSegment;
}

/**
 * Every slug a descriptor answers to: its own `descriptor_id`, its workflow
 * `action_ref`, its `source_record_ref`, and any self-describing
 * `product_action_refs` it advertises (the data alias that lets a projection's
 * product-facing action ref — e.g. `publish-availability-policy` — resolve to
 * the descriptor that actually runs it — `generate-availability-slots` — without
 * a hardcoded bridge).
 */
function descriptorActionSlugs(descriptor: CalendarBookerActionDescriptor): Set<string> {
  const slugs = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) slugs.add(normalizeActionRef(value));
  };
  const raw = descriptor as AnyRecord;
  add(descriptor.descriptor_id);
  add(descriptor.action_ref);
  add(raw.source_record_ref);
  const productRefs = raw.product_action_refs;
  if (Array.isArray(productRefs)) for (const ref of productRefs) add(ref);
  return slugs;
}

export function findCalendarBookerActionDescriptor(context: CalendarBookerActionContext): CalendarBookerActionDescriptor {
  // Exact identity wins (descriptor_id or workflow action_ref).
  const exact = context.descriptors.find(
    (item) => item.descriptor_id === context.intentRef || item.action_ref === context.intentRef,
  );
  if (exact) return exact;
  // Otherwise resolve the feed-emitted projection ref to its descriptor by the
  // shared trailing-slug identity — one generic rule, zero per-action code.
  const intentSlug = normalizeActionRef(context.intentRef);
  const bySlug = context.descriptors.find((item) => descriptorActionSlugs(item).has(intentSlug));
  if (bySlug) return bySlug;
  throw new Error(`No owner action descriptor for ${context.intentRef}`);
}

export function buildCalendarBookerOwnerActionRequest(context: CalendarBookerActionContext): OwnerActionTargetRequest {
  const descriptor = findCalendarBookerActionDescriptor(context);
  const invocation: OwnerActionInvocation = {
    descriptor,
    input: context.input ?? {},
    idempotency_key: context.idempotencyKey,
  };
  return buildOwnerActionTargetRequest(invocation);
}

export function invokeCalendarBookerOwnerAction(context: CalendarBookerActionContext): Promise<unknown> {
  // Honor the `Promise`-returning contract UNCONDITIONALLY. Both
  // `findCalendarBookerActionDescriptor` (descriptor-not-found) and
  // `invokeOwnerActionDescriptor` -> `sendRequestToBitfieldTarget`
  // (`BootHooks required` when no live runtime is attached — e.g. a preview, a
  // test render, or a not-yet-booted product window) throw SYNCHRONOUSLY. A
  // caller that does `void invoke(...).catch(...)` would otherwise leak that
  // sync throw past its handler and crash the click. Converting any synchronous
  // failure into a rejected promise fixes the whole category at the source
  // (L063) instead of wrapping every call site in try/catch.
  try {
    const descriptor = findCalendarBookerActionDescriptor(context);
    return invokeOwnerActionDescriptor({
      descriptor,
      input: context.input ?? {},
      idempotency_key: context.idempotencyKey,
    });
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
