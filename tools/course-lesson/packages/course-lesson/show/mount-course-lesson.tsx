import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../../../ui';
import { CourseLessonSurface, type CourseLessonInput } from './CourseLessonSurface';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function CourseLessonMaterial({ props }: { props: Record<string, unknown> }) {
  const input = (props.surfaceInput ?? props.surface_input ?? {}) as CourseLessonInput;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="course lesson material">
        <CourseLessonSurface input={input} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <CourseLessonMaterial props={props} />);
}
