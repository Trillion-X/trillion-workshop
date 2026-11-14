// packages/ui/show/step-content-renderer/StepContent.tsx
//
// The React mount seam over the blind registry. Specializes the generic
// `StepContentRegistry<R>` to React components and mounts the resolved renderer
// for a step's content descriptor — without ever branching on `content_kind`.
// This mirrors the composition `Component` node seam (`render_scene.js`): one
// generic mounter, infinite content kinds supplied as DATA + registrations.

import { createElement, type ComponentType, type ReactElement } from 'react';
import type { StepContentDescriptor, StepContentRegistry } from './step-content-renderer';

/** Props every content renderer receives. The renderer owns its `payload` shape. */
export interface StepContentProps {
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A React content renderer — what a consumer registers per `content_kind`. */
export type StepContentComponent = ComponentType<StepContentProps>;

/** Mount the renderer registered for `content.content_kind` (or the fallback). */
export function StepContent(props: {
  readonly registry: StepContentRegistry<StepContentComponent>;
  readonly content: StepContentDescriptor;
}): ReactElement {
  const Renderer = props.registry.resolve(props.content.content_kind);
  return createElement(Renderer, { payload: props.content.payload });
}
