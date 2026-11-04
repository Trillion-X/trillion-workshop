// parts/screen-look/show/ChooseScreenLook.tsx
//
// PURPOSE
//   Screen look: every look the person can wear as a card drawn in that look's own colours (the anatomy of Trillion
//   Media's Screen look page), the worn one checked. Pressing a card wears it at once and saves the choice. Edit (the
//   person's own version of that look, under its id) and Create a look (a copy under a new id) open the shared token
//   editor in place; Download saves the worn look as a .look.json record; Open a look file takes in a record someone
//   downloaded or published, keeps it and wears it. Two switches: keep the look on this device only (every other
//   device keeps the account's look), and show the small Look button in the corner of every screen.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Looks are records (do-work/screen-look-records.ts); nothing here names a look or a colour.
//   2. Saving keeps only the person's own looks; the app's looks stay the app's DATA.
//   3. What choosing, editing and saving do is use-screen-look-choices.ts's, shared with the Look popover; this file
//      only draws. Every control is a shared part (ui Button and Switch, Kibo dropzone, notifications); painting the
//      page is PaintChosenScreenLook's (ScreenLookSurface.tsx), which follows the same records.

import React, { useCallback, useEffect, useRef } from 'react';
import { Check, Download, Pencil, Plus, Upload } from 'lucide-react';
import { Button, Icon, SegmentedControl, Text, cn } from '../../ui';
import { notify } from '../../ui/show/coss/notifications';
import { downloadTextFile } from '../../ui/show/file-download/download-file';
import { mountFileDropzone } from '../../ui/show/kibo/file-dropzone';
import { applyScreenLookRecord } from '../do-work/screen-look-records';
import { screenLookFile } from '../read-data/screen-look-record';
import type { EditableScreenLookTheme } from '../read-data/read-editable-screen-look-themes';
import { resolveScreenLookPalette } from '../read-data/resolve-screen-look-palette';
import { FOLLOW_SYSTEM, kindOfLook, lookForKind } from '../read-data/look-follow-system';
import { CompactScreenLookThemeEditor } from './CompactScreenLookThemeEditor';
import { ScreenLookSwitch } from './ScreenLookSwitch';
import { useScreenLookChoices } from './use-screen-look-choices';

import { errorWords } from '../../ui/show/safe-error-card/sanitize-error-text';
function LookCard({ theme, chosen, onChoose }: { theme: EditableScreenLookTheme; chosen: boolean; onChoose: () => void }) {
  const palette = resolveScreenLookPalette(theme);
  const accent = palette['--accent-primary'];
  return (
    <Button
      variant="ghost"
      size="option-row"
      className="group flex h-auto w-full min-w-0 flex-col items-stretch gap-2 rounded-none border-0 bg-transparent p-0 text-left shadow-none hover:bg-transparent focus-visible:outline-2 focus-visible:outline-[var(--focus-ring-color)] motion-reduce:transition-none"
      aria-pressed={chosen}
      onClick={onChoose}
    >
      <span
        aria-hidden="true"
        data-theme-preview
        className={cn('flex h-24 w-full shrink-0 flex-col justify-between overflow-hidden rounded-xl border border-[var(--border-primary)] p-3 transition-transform group-hover:scale-[1.01] motion-reduce:transform-none motion-reduce:transition-none', chosen && 'ring-2 ring-[var(--accent-primary)] ring-offset-2 ring-offset-[var(--surface-primary)]')}
        style={{ backgroundColor: palette['--bg-surface'] }}
      >
        <span className="h-2 w-1/3 rounded-full" style={{ backgroundColor: accent }} />
        <span className="flex items-end justify-between gap-2">
          <span className="grid w-2/3 gap-1">
            <span className="h-1.5 rounded-full" style={{ backgroundColor: palette['--text-primary'], opacity: 0.68 }} />
            <span className="h-1 rounded-full" style={{ backgroundColor: palette['--text-primary'], opacity: 0.28 }} />
          </span>
          <span className="h-5 w-8 rounded-md" style={{ backgroundColor: accent }} />
        </span>
      </span>
      <span className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{theme.name}</span>
        {chosen && <Icon icon={Check} size="sm" color="accent" />}
      </span>
    </Button>
  );
}

/** The Theme control: Light, Dark or Automatic (the computer's own appearance setting), with the looks each one wears. */
function ThemeMode({ choices }: { choices: ReturnType<typeof useScreenLookChoices> }) {
  const { looks, chosen, follow } = choices;
  const words = FOLLOW_SYSTEM.words;
  const mode = follow?.mode ?? FOLLOW_SYSTEM.modes.find(row => row.follows === kindOfLook(chosen))?.id ?? '';
  const follows = FOLLOW_SYSTEM.modes.find(row => row.id === mode)?.follows;
  const name = (kind: 'light' | 'dark') => lookForKind(looks, follow, kind)?.name ?? '';
  const note = follows === 'system' ? words.automatic_note : follow && follows === 'light' ? words.light_note : follow && follows === 'dark' ? words.dark_note : '';
  return (
    <div className="grid max-w-xl gap-2" data-screen-look-theme-mode>
      <Text as="p" variant="body">{words.theme}</Text>
      <SegmentedControl ariaLabel={words.theme} value={mode} onValueChange={choices.setMode}
        items={FOLLOW_SYSTEM.modes.map(row => ({ id: row.id, label: row.label }))} />
      {note ? <Text as="p" variant="caption" color="muted">{note.replace('{light}', name('light')).replace('{dark}', name('dark'))}</Text> : null}
    </div>
  );
}

export function ChooseScreenLook({ className }: { className?: string }) {
  const choices = useScreenLookChoices();
  const { looks, chosen, onThisDevice, editing } = choices;
  const picker = useRef<HTMLDivElement>(null);
  const opener = useRef<ReturnType<typeof mountFileDropzone> | null>(null);

  // The one file chooser: a hidden shared dropzone that Open a look file opens.
  useEffect(() => {
    if (!picker.current) return undefined;
    opener.current = mountFileDropzone(picker.current, {
      label: 'Open a look file', description: '', multiple: false, accept: { 'application/json': ['.json'] },
      onFiles: async files => {
        try { notify(`Now wearing ${(await applyScreenLookRecord(await files[0].text())).name}.`, { kind: 'done' }); }
        catch (error) { notify(errorWords(error), { kind: 'error' }); }
      },
    });
    return () => { opener.current?.destroy(); opener.current = null; };
  }, []);

  const download = useCallback(() => {
    const file = screenLookFile(chosen);
    downloadTextFile(file.text, file.name, file.type);
  }, [chosen]);

  return (
    <div className={cn('grid min-w-0 gap-4', className)} data-screen-look-choices>
      {editing ? (
        <CompactScreenLookThemeEditor
          draftTheme={editing.draft}
          pending={choices.pending}
          title={editing.title}
          fontFaces={choices.fontFaces}
          onDraftThemeChange={choices.changeDraft}
          onCancel={choices.cancelEditing}
          onSave={() => { void choices.saveEditing(); }}
        />
      ) : (
        <>
          <ThemeMode choices={choices} />
          <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
            {looks.map(theme => <LookCard key={theme.id} theme={theme} chosen={theme.id === chosen.id} onChoose={() => choices.choose(theme)} />)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={choices.editChosen}><Icon icon={Pencil} size="sm" /> Edit {chosen.name}</Button>
            <Button variant="ghost" size="sm" onClick={choices.copyChosen}><Icon icon={Plus} size="sm" /> Create a look</Button>
            <Button variant="ghost" size="sm" onClick={download}><Icon icon={Download} size="sm" /> Download {chosen.name}</Button>
            <Button variant="ghost" size="sm" onClick={() => opener.current?.open()}><Icon icon={Upload} size="sm" /> Open a look file</Button>
          </div>
          <div className="grid max-w-xl gap-3">
            <ScreenLookSwitch
              label="Only on this device"
              description="This device keeps its own look. Your other devices keep the look you chose for your account."
              checked={onThisDevice}
              onCheckedChange={choices.setOnThisDevice}
            />
            <ScreenLookSwitch
              label="Look button in the corner"
              description="A small Look button in the bottom right of every screen, to change the look from anywhere."
              checked={choices.cornerButton}
              onCheckedChange={choices.showCornerButton}
            />
          </div>
        </>
      )}
      <div ref={picker} hidden />
    </div>
  );
}
