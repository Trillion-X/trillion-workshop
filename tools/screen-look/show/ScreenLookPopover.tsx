// parts/screen-look/show/ScreenLookPopover.tsx
//
// PURPOSE
//   The small Look chooser: a Look button that opens a short list of looks (each a two-colour swatch and its name, the
//   worn one checked), Edit and New look at the top, and the Only on this device switch at the bottom. Edit and New
//   look turn the same popover into the look editor. The anatomy is the Mac's Look popover (bitfield screen-look
//   ChooseScreenLook popover mode); the card grid on the Screen look screen is ChooseScreenLook.tsx.
//
// NON-NEGOTIABLE INVARIANTS
//   1. What choosing, editing and saving do is use-screen-look-choices.ts's, the same as the card grid's.
//   2. Floating is the shared AnchoredOverlay's (portalled, flips to stay on screen, height clamped); a closed popover
//      draws nothing. Escape or a press outside closes it.
//   3. Nothing here names a look or a colour.

import React, { useRef, useState } from 'react';
import { lazyPart } from '../../ui/show/load-later/later';
import { Check, Palette, Pencil, Plus } from 'lucide-react';
import { AnchoredOverlay, Button, Icon, Text, cn } from '../../ui';
import { resolveScreenLookPalette } from '../read-data/resolve-screen-look-palette';
// The look editor (its tuning panel and colour fields) is fetched the first time a look is edited.
const CompactScreenLookThemeEditor = lazyPart(() => import('./CompactScreenLookThemeEditor'), module => module.CompactScreenLookThemeEditor);
import { ScreenLookSwitch } from './ScreenLookSwitch';
import { useScreenLookChoices } from './use-screen-look-choices';

export function ScreenLookPopover({ className, iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  const choices = useScreenLookChoices();
  const { looks, chosen, onThisDevice, editing } = choices;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); choices.cancelEditing(); };

  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        size="sm"
        className={className}
        aria-label="Screen look"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon icon={Palette} size="sm" className="flex-shrink-0" />
        {!iconOnly && <span className="truncate">Look</span>}
      </Button>
      <AnchoredOverlay anchorRef={trigger} open={open} placement="above" gap={8} onDismiss={close}>
        <div
          data-screen-look-popover
          className={cn('p-2', editing ? 'max-h-[min(80vh,44rem)] w-[min(640px,calc(100vw-2rem))] overflow-y-auto' : 'w-64')}
          onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); trigger.current?.focus(); } }}
        >
          {editing ? (
            <React.Suspense fallback={null}>
            <CompactScreenLookThemeEditor
              draftTheme={editing.draft}
              pending={choices.pending}
              title={editing.title}
              fontFaces={choices.fontFaces}
              onDraftThemeChange={choices.changeDraft}
              onCancel={choices.cancelEditing}
              onSave={() => { void choices.saveEditing(); }}
            />
            </React.Suspense>
          ) : (
            <div className="grid gap-1">
              <div className="mb-1 grid grid-cols-2 gap-1">
                <Button variant="ghost" size="sm" className="h-auto justify-start gap-2 rounded-xl px-3 py-2 text-left" onClick={choices.editChosen}>
                  <Icon icon={Pencil} size="sm" />
                  <span className="grid min-w-0">
                    <Text variant="label" color="strong" weight="medium">Edit</Text>
                    <Text variant="caption" color="faint" className="truncate">{chosen.name}</Text>
                  </span>
                </Button>
                <Button variant="ghost" size="sm" className="h-auto justify-start gap-2 rounded-xl px-3 py-2 text-left" onClick={choices.copyChosen}>
                  <Icon icon={Plus} size="sm" />
                  <span className="grid min-w-0">
                    <Text variant="label" color="strong" weight="medium">New look</Text>
                    <Text variant="caption" color="faint" className="truncate">A copy</Text>
                  </span>
                </Button>
              </div>
              {looks.map(theme => {
                const palette = resolveScreenLookPalette(theme);
                const worn = theme.id === chosen.id;
                return (
                  <Button
                    key={theme.id}
                    variant="ghost"
                    size="sm"
                    aria-pressed={worn}
                    className={cn('h-auto w-full justify-start gap-2.5 rounded-lg px-3 py-1.5 text-left', worn ? 'bg-[var(--glass-bg-active)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}
                    onClick={() => choices.choose(theme)}
                  >
                    <span aria-hidden="true" className="inline-flex h-4 w-7 flex-shrink-0 overflow-hidden rounded border border-[var(--border-primary)]">
                      <span className="h-full w-1/2" style={{ backgroundColor: palette['--accent-primary'] }} />
                      <span className="h-full w-1/2" style={{ backgroundColor: palette['--bg-surface'] }} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{theme.name}</span>
                    {worn && <Icon icon={Check} size="sm" color="accent" />}
                  </Button>
                );
              })}
              <div className="mt-1 border-t border-[var(--border-primary)] px-1 pt-2">
                <ScreenLookSwitch
                  label="Only on this device"
                  description="Other devices keep your account's look."
                  checked={onThisDevice}
                  onCheckedChange={choices.setOnThisDevice}
                />
              </div>
            </div>
          )}
        </div>
      </AnchoredOverlay>
    </>
  );
}
