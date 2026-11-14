import React from 'react';
import { mountReactSurface } from '@/packages/ui';
import { GroupPageView } from './GroupPageView';
export default function mount({ el, props = {} }: { el: HTMLElement; props?: Record<string, unknown> }) { const input = props.surfaceInput && typeof props.surfaceInput === 'object' ? { ...props, ...(props.surfaceInput as Record<string, unknown>) } : props; return mountReactSurface(el, <GroupPageView props={input} />); }
