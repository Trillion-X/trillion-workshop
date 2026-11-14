"use client";

import type {ReactNode} from 'react';

// AICSS ThinkingState, with application-supplied activity instead of a claim
// about the model's reasoning. Appearance lives in screen-look.
export function ActivityLabel({children}: {children:ReactNode}) {
  return <span className="aicss-activity-label">{children}</span>;
}
