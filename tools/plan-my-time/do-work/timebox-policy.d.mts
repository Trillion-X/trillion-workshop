import type { SchedulePlanTask } from './schedule-planner.mjs';
export interface TimeboxPolicy { id: string; label: string; writes: boolean }
export interface TimeboxEvent { title: string; start: string; end: string; transparency: string; visibility: string }
export const timeboxPolicies: TimeboxPolicy[];
export function timeboxEvent(policyId: string | null | undefined, task: SchedulePlanTask, proposal: { starts_at: string; ends_at: string; late?: boolean }, todoPrivacy?: string | null): TimeboxEvent | null;
