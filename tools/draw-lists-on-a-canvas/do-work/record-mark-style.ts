// packages/addressed-marks/do-work/record-mark-style.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Append one mark style record through `slot::workflow`
// `action:record-addressed-mark-style`. Custom colors, widths, opacities, and
// palette entries are DATA — saving a color from the color wheel writes a
// style record that materializes into `addressed-marks.styles` and joins the
// toolbar palette everywhere, persisted in current log state like every other
// record. No code changes per color, ever.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';

export const RECORD_MARK_STYLE_ACTION = 'action:record-addressed-mark-style';

export interface MarkStyleWrite {
  id: string;
  label?: string;
  stroke?: string;
  strokeToken?: string;
  /** Reader screen pixels (non-scaling-stroke contract). */
  strokeWidth?: number;
  strokeOpacity?: number;
  /**
   * Fill decoration: a visual-layer-stack record (same as regions use). The mark
   * renders the stack's capability-driven layers clipped to the mark path shape.
   * Reuse ALL region fill capabilities: solid, gradient, mesh, image, video, grain,
   * tint. Adding a fill type = a registry capability, NOT a mark code edit (L090).
   *
   * Type: VisualLayerStackRecord (from ui; stored as unknown to avoid circular import).
   * Back-compat: solid `fill`/`fillOpacity` fields are converted to a single
   * solid-capability layer at read time (see readMarkStyles in addressed-marks.ts).
   */
  decoration?: unknown;
  /**
   * Legacy: solid color fill. Deprecated in favor of decoration. Present for
   * back-compat; new styles use decoration only.
   */
  fill?: string;
  /**
   * Legacy: fill opacity. Deprecated in favor of decoration. Present for
   * back-compat; new styles use decoration only.
   */
  fillOpacity?: number;
  order?: number;
}

export type MarkStyleSender = typeof sendRequestToBitfieldTarget;

export function buildMarkStyleRequest(style: MarkStyleWrite) {
  const input: Record<string, unknown> = {
    style_id: style.id,
    label: style.label,
    stroke: style.stroke,
    stroke_token: style.strokeToken,
    stroke_width: style.strokeWidth,
    stroke_opacity: style.strokeOpacity,
    fill: style.fill,
    fill_opacity: style.fillOpacity,
    order: style.order,
  };

  if (style.decoration) {
    input.decoration = style.decoration;
  }

  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: RECORD_MARK_STYLE_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  };
}

export function recordMarkStyle(
  style: MarkStyleWrite,
  sender: MarkStyleSender = sendRequestToBitfieldTarget,
): Promise<unknown> {
  return sender(buildMarkStyleRequest(style));
}
