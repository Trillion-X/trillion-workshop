//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure browser frame for renderer-mounted material. It interprets caller-
// provided placement numbers as CSS box coordinates and owns no durable state,
// target address, or package meaning.
//
// =============================================================================

import React from 'react';
import { cn } from '../cn';

type FloatingFrameInput = {
  mode?: unknown;
  top_px?: unknown;
  right_px?: unknown;
  bottom_px?: unknown;
  left_px?: unknown;
  width_px?: unknown;
  max_height_px?: unknown;
  z_index?: unknown;
};

type FloatingFrameMode = 'fixed' | 'inline' | 'fill';

export interface FloatingMaterialFrameProps {
  children: React.ReactNode;
  className?: string;
  frame?: unknown;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readFrame(input: unknown): FloatingFrameInput {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as FloatingFrameInput
    : {};
}

function readMode(value: unknown): FloatingFrameMode {
  if (value === 'inline' || value === 'fill') return value;
  return 'fixed';
}

export function FloatingMaterialFrame({
  children,
  className,
  frame,
}: FloatingMaterialFrameProps) {
  const resolved = readFrame(frame);
  const mode = readMode(resolved.mode);
  const style: React.CSSProperties = mode === 'inline'
    ? {
      position: 'relative',
      width: '100%',
      minWidth: 0,
      minHeight: '100%',
      overflow: 'visible',
    }
    : mode === 'fill'
      ? {
        position: 'relative',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }
    : {
      position: 'fixed',
      top: numberOrUndefined(resolved.top_px),
      right: numberOrUndefined(resolved.right_px),
      bottom: numberOrUndefined(resolved.bottom_px),
      left: numberOrUndefined(resolved.left_px),
      width: numberOrUndefined(resolved.width_px),
      maxHeight: numberOrUndefined(resolved.max_height_px),
      zIndex: numberOrUndefined(resolved.z_index),
      overflow: resolved.max_height_px === undefined ? undefined : 'auto',
    };

  return (
    <div
      data-floating-material-frame
      className={cn('pointer-events-auto', className)}
      style={style}
    >
      {children}
    </div>
  );
}
