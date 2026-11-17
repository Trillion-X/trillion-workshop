import React from 'react';
import { mountReactSurface } from '../../../../ui';
import { SpacesView } from './SpacesView';
export default function mount({ el, props = {} }: { el: HTMLElement; props?: Record<string, unknown> }) { const input = props.surfaceInput && typeof props.surfaceInput === 'object' ? { ...props, ...(props.surfaceInput as Record<string, unknown>) } : props; return mountReactSurface(el, <SpacesView projection={input.scoped_space_projection} scope={input.admitted_scope} surfaceSpaceId={typeof input.space_id === 'string' ? input.space_id : undefined} />); }
