// parts/screen-look/show/ScreenLookFullSurface.tsx
//
// PURPOSE
//   The Screen look page an app places as a whole screen: its heading and the card grid chooser (ChooseScreenLook),
//   in a scrolling pane. Words come from the host's `surfaceInput`, with plain defaults.

import React from 'react';
import { ChooseScreenLook } from './ChooseScreenLook';
import { Text } from '../../ui';

export type ScreenLookFullSurfaceProps = {
  subtitle?: string;
  surfaceInput?: {
    title?: string;
    subtitle?: string;
  };
  title?: string;
};

export function ScreenLookFullSurface({
  subtitle,
  surfaceInput,
  title,
}: ScreenLookFullSurfaceProps) {
  const heading = title ?? surfaceInput?.title ?? 'Choose how this workspace looks.';
  const body = subtitle ?? surfaceInput?.subtitle ?? 'Pick the theme that matches the way you want the whole workspace to feel.';

  return (
    <div
      data-screen-look-full-surface
      className="h-full min-h-0 w-full overflow-y-auto bg-transparent px-6 py-6 text-[var(--text-primary)]"
    >
      <div className="flex w-full min-w-0 flex-col gap-4">
        <div className="min-w-0">
          <Text as="h1" variant="heading-lg" className="page-title m-0">
            {heading}
          </Text>
          <Text as="p" variant="label" color="secondary" leading="relaxed" className="mb-0 mt-1">
            {body}
          </Text>
        </div>
        <div className="min-w-0">
          <ChooseScreenLook />
        </div>
      </div>
    </div>
  );
}
