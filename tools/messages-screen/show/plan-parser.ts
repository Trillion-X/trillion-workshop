// PORTED FROM: bitfield-packages/packages/chat/show/plan-parser.ts @ e99ac5976
// frontends/web/src/packages/chat/read-data/plan-parser.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure functions for extracting plan steps from agent chat messages and
// detecting plan mode. Plan steps are extracted from:
// - assistant text messages
// - ExitPlanMode tool payload (`toolUse.params.plan`)
//
// Plan mode is detected by "plan mode" text or ExitPlanMode tool invocations.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All functions are pure — no side effects, no I/O
// 2. parsePlanSteps deduplicates by id
// 3. Checkbox items are assigned sequential numeric ids if not from numbered lists
// 4. Plan extraction supports assistant text + ExitPlanMode payload
// 5. Status inference is deterministic based on message order
//
// =============================================================================

import type { AgentMessage } from '../read-data/chat-message-types';

/**
 * Represents a single step in an agent's plan.
 *
 * status: pending = not yet started, in_progress = currently executing,
 * completed = finished
 */
export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
  description?: string;
}

/**
 * Final plan payload extracted from ExitPlanMode.
 *
 * `planContent` is the markdown plan body from tool input.
 * `planPreamble` is optional assistant text emitted alongside ExitPlanMode.
 */
export interface ExitPlanPayload {
  planContent: string | null;
  planPreamble: string | null;
}

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

/**
 * Extracts numbered + checkbox plan steps from a markdown-like content string.
 */
function collectPlanStepsFromContent(content: string, stepsMap: Map<string, PlanStep>): void {
  // Extract numbered list items: "1. Title" or "1.  Title" (with optional bold)
  const numberedMatches = content.matchAll(/^(\d+)\.\s+(.+)$/gm);
  for (const match of numberedMatches) {
    const id = match[1];
    const titleRaw = match[2];
    const title = titleRaw.replace(/\*\*/g, '').trim();

    if (!stepsMap.has(id)) {
      stepsMap.set(id, {
        id,
        title,
        status: 'pending',
      });
    }
  }

  // Extract checkbox items: "- [x] Done" or "- [ ] Pending"
  const checkboxMatches = content.matchAll(/^-\s+\[([ xX])\]\s+(.+)$/gm);
  for (const match of checkboxMatches) {
    const isChecked = match[1] !== ' ';
    const titleRaw = match[2];
    const title = titleRaw.replace(/\*\*/g, '').trim();

    const id = String(stepsMap.size + 1);
    if (!stepsMap.has(id)) {
      stepsMap.set(id, {
        id,
        title,
        status: isChecked ? 'completed' : 'pending',
      });
    }
  }
}

/**
 * Best-effort extraction of plan markdown from ExitPlanMode params.
 * Different adapters may nest plan under slightly different shapes.
 */
function extractPlanMarkdownFromParams(params: Record<string, unknown>): string | null {
  const directPlan = params.plan;
  if (typeof directPlan === 'string' && directPlan.trim().length > 0) return directPlan;

  const output = params.output;
  if (
    output
    && typeof output === 'object'
    && typeof (output as { plan?: unknown }).plan === 'string'
    && (output as { plan: string }).plan.trim().length > 0
  ) {
    return (output as { plan: string }).plan;
  }

  return null;
}

/**
 * Extract the most recent ExitPlanMode plan payload from messages.
 */
export function extractExitPlanPayload(messages: AgentMessage[]): ExitPlanPayload {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type !== 'tool_use' || msg.toolUse?.tool !== 'ExitPlanMode') continue;

    const planContent = extractPlanMarkdownFromParams(msg.toolUse.params ?? {});
    if (!planContent) continue;

    const trimmedContent = msg.content.trim();
    const isGenericToolText = /^using tool:\s*exitplanmode$/i.test(trimmedContent);
    const planPreamble = trimmedContent && !isGenericToolText ? msg.content : null;

    return { planContent, planPreamble };
  }

  return { planContent: null, planPreamble: null };
}

/**
 * Extracts plan steps from agent text messages.
 *
 * Recognizes two formats:
 * - Numbered lists: "1. Step title" → PlanStep with id='1', status='pending'
 * - Checkbox items: "- [x] Done step" / "- [ ] Pending" → sequential ids, status inferred from checkbox
 *
 * Deduplicates by id (numbered lists take precedence over checkbox items).
 * Only processes messages where role='assistant' and type='text'.
 *
 * @param messages Array of chat messages
 * @returns Array of unique plan steps in order of appearance
 */
export function parsePlanSteps(messages: AgentMessage[]): PlanStep[] {
  const stepsMap = new Map<string, PlanStep>();

  for (const msg of messages) {
    // Only process assistant text messages
    if (msg.type !== 'text' || msg.role !== 'assistant') {
      continue;
    }

    collectPlanStepsFromContent(msg.content, stepsMap);
  }

  // If Claude exited plan mode, the canonical final plan may live in the
  // ExitPlanMode payload instead of a plain assistant text message.
  const { planContent } = extractExitPlanPayload(messages);
  if (planContent) {
    collectPlanStepsFromContent(planContent, stepsMap);
  }

  // Return steps in order of insertion
  return Array.from(stepsMap.values());
}

/**
 * Detects whether the chat is in plan mode.
 *
 * Plan mode is detected by:
 * 1. Any message containing "plan mode" (case-insensitive)
 * 2. Any tool_use message with tool='ExitPlanMode'
 *
 * @param messages Array of chat messages
 * @returns true if plan mode is detected, false otherwise
 */
export function detectPlanMode(messages: AgentMessage[]): boolean {
  return messages.some((m) => {
    // Check for "plan mode" text in assistant messages (whole words only)
    if (m.type === 'text' && /\bplan\s+mode\b/i.test(m.content)) {
      return true;
    }

    // Check for ExitPlanMode tool invocation
    if (m.type === 'tool_use' && m.toolUse?.tool === 'ExitPlanMode') {
      return true;
    }

    return false;
  });
}
