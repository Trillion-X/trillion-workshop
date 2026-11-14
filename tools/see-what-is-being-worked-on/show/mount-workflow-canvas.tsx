import React from 'react';
import {
  ErrorBoundary,
  FloatingMaterialFrame,
  mountReactSurface,
  type ReactMaterialMountArgs,
} from '../../ui';
import { WorkflowCanvas } from './WorkflowCanvas';

const WORKFLOW_CANVAS_FILL_FRAME = { mode: 'fill' } as const;
const POSITIONED_FRAME_FIELDS = new Set([
  'top_px',
  'right_px',
  'bottom_px',
  'left_px',
  'width_px',
  'max_height_px',
  'z_index',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function workflowCanvasFrame(value: unknown): unknown {
  if (!isRecord(value)) return WORKFLOW_CANVAS_FILL_FRAME;
  if (Object.keys(value).some((key) => POSITIONED_FRAME_FIELDS.has(key))) return value;
  return { ...value, mode: 'fill' };
}

function WorkflowCanvasMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame
      frame={workflowCanvasFrame(props.floating_frame)}
      className="flex h-full min-h-0 w-full overflow-hidden"
    >
      <ErrorBoundary zoneName="workflow canvas material">
        <div
          data-workflow-canvas-material-root="true"
          className="flex h-full min-h-0 w-full overflow-hidden"
        >
          <WorkflowCanvas />
        </div>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactSurface(
    el,
    <WorkflowCanvasMaterial props={props} />,
  );
}
