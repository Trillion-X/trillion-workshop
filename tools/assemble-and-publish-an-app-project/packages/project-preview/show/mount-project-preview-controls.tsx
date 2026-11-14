import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ProjectPreviewsPanel } from '@/packages/project-preview/show/ProjectPreviewsPanel';
import {
  decodeProjectPreviewDescriptorsFeed,
} from '@/packages/project-preview/read-data/read-project-preview-descriptors';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ProjectPreviewControlsMaterial({ props }: { props: Record<string, unknown> }) {
  const previewsEntry = useBitfieldData('project-previews');
  const previews = decodeProjectPreviewDescriptorsFeed(previewsEntry);
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ProjectPreviewsPanel previews={previews} />
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, React.createElement(ProjectPreviewControlsMaterial, { props }));
}
