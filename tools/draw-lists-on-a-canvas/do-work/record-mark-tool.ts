// packages/addressed-marks/do-work/record-mark-tool.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Append one mark tool record through `slot::workflow`
// `action:record-addressed-mark-tool`. Custom shapes are DATA: a 7-gon tool
// is `mapper:{kind:"polygon", sides:7, closed:true}` in a record. Saving a
// shape from the toolbar writes a tool record that materializes into
// `addressed-marks.tools` and joins the toolbar everywhere — persisted in
// current log state, zero code per shape.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { JsonObject } from '../read-data/addressed-marks';

export const RECORD_MARK_TOOL_ACTION = 'action:record-addressed-mark-tool';

export interface MarkToolWrite {
  id: string;
  label?: string;
  icon?: string;
  order?: number;
  /** Tool behavior data: coordinate_set defaults + mapper (+ mode). */
  body: JsonObject;
}

export type MarkToolSender = typeof sendRequestToBitfieldTarget;

export function buildMarkToolRequest(tool: MarkToolWrite) {
  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: RECORD_MARK_TOOL_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        tool_id: tool.id,
        label: tool.label,
        icon: tool.icon,
        order: tool.order,
        body: tool.body,
      },
    },
  };
}

export function recordMarkTool(
  tool: MarkToolWrite,
  sender: MarkToolSender = sendRequestToBitfieldTarget,
): Promise<unknown> {
  return sender(buildMarkToolRequest(tool));
}
