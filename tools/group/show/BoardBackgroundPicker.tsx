// packages/group/show/BoardBackgroundPicker.tsx
// The board-background header button + its popover: surface swatches, snap-to-grid, board look
// preset, and the board's DEFAULT appearance controls (text size, note density, connector look, …)
// rendered generically from the BOARD_DEFAULT_CONTROLS DATA descriptors via the blind
// BoardDefaultControl primitive — adding a control for another cascade key is one descriptor row.

import React, { useRef } from 'react';
import { AnchoredOverlay, Button, Container, DisclosureSection, Icon, Text, Switch } from '../../ui';
import { SurfaceSwatch } from '../../ui/show/surface-swatch';
import { Image as ImageIcon, Bookmark } from 'lucide-react';
import { BOARD_BACKGROUNDS, type BoardBackground } from 'trillion-workshop/tools/organize-the-sidebar/show/board-backgrounds.ts';
import { BOARD_SETTING_INFO } from 'trillion-workshop/tools/organize-the-sidebar/show/board-setting-info.ts';
import { AppearancePresetControl } from './AppearancePresetControl';
import type { AppearancePreset } from './appearance-presets';
import { BoardDefaultControl } from './BoardDefaultControl';
import { BOARD_DEFAULT_CONTROLS, boardDefaultControlValue, type AppearanceProfile } from './item-appearance';
import type { SettingInfoDescriptor } from './SettingInfoOverlay';

export interface BoardBackgroundPickerProps {
  open: boolean;
  onToggleOpen: () => void;
  onDismiss: () => void;
  currentBackgroundId: string;
  onChooseBackground: (id: string) => void;
  gridSnap: boolean;
  onToggleGridSnap: (on: boolean) => void;
  onApplyAppearancePreset: (profile: Record<string, unknown>) => void;
  /** The board's OWN appearance-override bag (per-key overrides), read by each board-default control
   *  to show its current value ('' when the board hasn't overridden that key → the "Default" state). */
  boardAppearance?: AppearanceProfile;
  /** The ONE generic board-default setter — writes `value` at cascade `key`; `undefined` CLEARS it
   *  (reset → global fallback). Every board-default control (BOARD_DEFAULT_CONTROLS) routes through it. */
  onSetBoardDefault: (key: string, value: unknown) => void;
  /** Capture the board's CURRENT look as a reusable named preset (the SAVE side of the round-trip).
   *  Absent → the "Save this look" action is hidden. */
  onSaveLook?: () => void;
  /** The effective background catalog (built-ins + DATA rows). Absent → built-ins only. */
  backgrounds?: readonly BoardBackground[];
  /** The effective appearance-preset catalog (built-ins + DATA rows). Absent → built-ins only. */
  appearancePresets?: readonly AppearancePreset[];
  /** Optional map of setting-key → info descriptor for (i) affordances. Absent → no help icons. */
  settingInfoDescriptors?: Readonly<Record<string, SettingInfoDescriptor>>;
}

export function BoardBackgroundPicker({
  open,
  onToggleOpen,
  onDismiss,
  currentBackgroundId,
  onChooseBackground,
  gridSnap,
  onToggleGridSnap,
  onApplyAppearancePreset,
  boardAppearance,
  onSetBoardDefault,
  onSaveLook,
  backgrounds = BOARD_BACKGROUNDS,
  appearancePresets,
  settingInfoDescriptors = BOARD_SETTING_INFO,
}: BoardBackgroundPickerProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  // Display-only ordering: the "None" surfaces (no color AND no tile) come FIRST so
  // "no background" is the first, most-visible choice — a board is never forced to
  // pick a pattern (R46). Stable within each group; the catalog array (and thus the
  // resolved default in backgroundById) is untouched. Blind: "none" = the ABSENCE of
  // color+tile, not a hardcoded id.
  const orderedBackgrounds = React.useMemo(() => {
    const none = backgrounds.filter((b) => !b.color && !b.tile);
    const patterned = backgrounds.filter((b) => b.color || b.tile);
    return [...none, ...patterned];
  }, [backgrounds]);
  return (
    <>
      {/* R29 (L083): the trigger SAYS what it opens. A bare image glyph hid every
          board-look control behind an unguessable door — "Look" names the whole
          customization surface (background + presets + defaults + save). */}
      <Button
        ref={anchorRef}
        variant="ghost"
        size="sm"
        aria-label="Board look and background"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggleOpen}
      >
        <Icon icon={ImageIcon} size="sm" /> Look
      </Button>
      <AnchoredOverlay anchorRef={anchorRef} open={open} onDismiss={onDismiss}>
        <Container layout="vertical" gap="sm" padding="sm" aria-label="Board look">
          <Text variant="label">Look</Text>

          {/* BACKGROUND — the "None" surface (no color, no tile) is pulled to the
              FRONT (display-only ordering) so a board is NEVER forced to wear a
              pattern (R46). Catalog order — and thus the resolved default — is
              untouched; this only reorders what the picker SHOWS. */}
          <DisclosureSection title="Background" divider={false}>
            <Container layout="grid" gridCols={4} gap="sm">
              {orderedBackgrounds.map((bg) => (
                <SurfaceSwatch
                  key={bg.id}
                  label={bg.label}
                  color={bg.color}
                  tile={bg.tile}
                  selected={currentBackgroundId === bg.id}
                  onSelect={() => onChooseBackground(bg.id)}
                />
              ))}
            </Container>
          </DisclosureSection>

          {/* STYLE — snap-to-grid (#202: opt-in, off by default so peer-edge smart
              guides stay primary) + the one-click LOOK preset (#225 P1/R2: a named
              bag of appearance keys applied in one commit; catalog is DATA, control
              is blind). The row is labelled "Style preset" and the control's button
              says "Choose…" — one label, not the "Preset Preset" dup (R46). */}
          <DisclosureSection title="Style">
            <Switch
              label="Snap to grid"
              description="Dragged items lock to the grid"
              checked={gridSnap}
              onCheckedChange={onToggleGridSnap}
            />
            <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm">
              <Text variant="body-sm">Style preset</Text>
              <AppearancePresetControl presets={appearancePresets} onApply={(profile) => onApplyAppearancePreset(profile)} />
            </Container>
          </DisclosureSection>

          {/* DEFAULTS — the board-DEFAULT appearance controls (Text size, Note density,
              Connector color/weight, …) rendered from BOARD_DEFAULT_CONTROLS DATA through
              the ONE blind BoardDefaultControl (adding a control = one descriptor row, ZERO
              code here — L069). COLLAPSED by default so they no longer read as an unsectioned
              "wall of Default dropdowns" (R46) — the advanced knobs are one click away, not
              in your face. */}
          <DisclosureSection title="Defaults" collapsible defaultOpen={false}>
            {BOARD_DEFAULT_CONTROLS.map((descriptor) => (
              <BoardDefaultControl
                key={descriptor.key}
                descriptor={descriptor}
                value={boardDefaultControlValue(boardAppearance, descriptor.key)}
                onSet={onSetBoardDefault}
                infoDescriptor={settingInfoDescriptors?.[descriptor.key]}
              />
            ))}
          </DisclosureSection>

          {/* SAVE side of the round-trip: capture this board's current look as a reusable named
              preset (it streams back through published-records into the preset list, zero redeploy). */}
          {onSaveLook ? (
            <Button variant="secondary" size="sm" fullWidth onClick={onSaveLook}>
              <Icon icon={Bookmark} size="sm" />
              Save this look
            </Button>
          ) : null}
        </Container>
      </AnchoredOverlay>
    </>
  );
}
