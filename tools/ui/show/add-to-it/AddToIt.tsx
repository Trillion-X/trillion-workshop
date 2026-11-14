// parts/ui/show/add-to-it/AddToIt.tsx
//
// PURPOSE
//   "Add to it": the ways a person adds something to what they are about to send, as a grid of small tiles, each its
//   icon over its name (Attach files, Record audio, Record video, Record the screen, Draw, Picture of this screen,
//   Add the whole page). The same grid in every place Trillion takes something in: the Send to Trillion popup
//   (extension/src/add-to-it.tsx), Your tray and any box that draws its ways to add out in the open (the shared
//   Composer with `waysShown`). The iPhone sheet draws the same section natively (ios/ShareExtension/ShareSheet.swift).
//
// PROVENANCE
//   Moved here from the popup's own CaptureButton (extension/src/add-to-it.tsx), so the popup and the tray are one
//   part. Anatomy after 21st.dev "Attachment Composer Tray" (component 28500) and Mobbin's Microsoft Copilot composer
//   (mobbin.com/screens/2ff3d94d-adb2-4937-818d-de633b9757c3): every way in is visible and named, never folded behind
//   one icon.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no way to add is named here; every id, word, icon and state is the caller's DATA.
//   2. Each tile is the shared Button; a busy tile shows the one loading mark (Button `loading`), a disabled one is
//      drawn as disabled.
//   3. Two tiles to a row, so a narrow pane and the popup read the same.

import React from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { NamedIcon } from '../icon';
import { Text } from '../text';

/** One way to add: its id (what `onPress` reports), its name, its icon, and the line shown when pointed at. */
export type AddWay = { id: string; label: string; icon: string; detail?: string; busy?: boolean; disabled?: boolean };

export type AddToItProps = {
  ways: readonly AddWay[];
  onPress: (id: string) => void;
  /** What the grid is called for a screen reader ("Add to it"). */
  label: string;
};

export function AddToIt({ ways, onPress, label }: AddToItProps) {
  if (!ways.length) return null;
  return (
    <Container role="group" aria-label={label} layout="grid" gridColumns={2} gap="sm" width="full" data-add-to-it="">
      {ways.map(way => (
        <Button key={way.id} type="button" variant="secondary" size="option-row" radius="lg" title={way.detail ?? way.label} aria-label={way.label}
          loading={way.busy} disabled={way.disabled} onClick={() => onPress(way.id)} data-add-way={way.id}
          className="flex-col items-center justify-center gap-1 text-center">
          <NamedIcon name={way.icon} size="sm" aria-hidden="true" />
          <Text variant="body-xs" weight="medium" className="whitespace-normal leading-tight">{way.label}</Text>
        </Button>
      ))}
    </Container>
  );
}
