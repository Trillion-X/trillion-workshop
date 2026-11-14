import React from 'react';
import { FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ToastProvider } from '@/packages/ui/show/toast';
import { ServiceConnectionsSurface } from './ServiceConnectionsSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

export default function mount({ el, props = {} }: MountArgs) {
  // A caller may open this catalog focused on one channel (chat's People-rail
  // "+" passes surfaceInput.focusVendor). Seed the search so the catalog opens
  // pre-filtered to that vendor; absent → full catalog.
  const surfaceInput = (props.surfaceInput ?? {}) as Record<string, unknown>;
  const focusVendor = typeof surfaceInput.focusVendor === 'string' ? surfaceInput.focusVendor : undefined;
  const initialCategories = Array.isArray(surfaceInput.initial_categories)
    ? surfaceInput.initial_categories.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const presentation = typeof surfaceInput.presentation === 'string' ? surfaceInput.presentation : undefined;
  const showDiscoveryProgress = surfaceInput.show_discovery_progress === true;
  const providerChoiceActionRef = typeof surfaceInput.provider_choice_action_ref === 'string'
    ? surfaceInput.provider_choice_action_ref
    : undefined;
  return mountReactSurface(
    el,
    React.createElement(
      FloatingMaterialFrame,
      { frame: props.floating_frame },
      React.createElement(
        ToastProvider,
        null,
        React.createElement(ServiceConnectionsSurface, {
          initialQuery: focusVendor,
          initialCategories,
          presentation,
          showDiscoveryProgress,
          providerChoiceActionRef,
        }),
      ),
    ),
  );
}
