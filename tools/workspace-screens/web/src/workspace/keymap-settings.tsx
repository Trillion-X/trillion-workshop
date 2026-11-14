// src/workspace/keymap-settings.tsx
//
// PURPOSE
//   The Shortcuts page of Settings: every row of the one keymap (keymap.json) with its keys, grouped by where each works
//   (from any app, in Trillion). "Click to personalize": choosing a row's keys asks for the new ones, a press saves
//   them, Delete takes the key away, Escape leaves it as it was, and Back to the usual key removes the person's own.
//   Their keys are their account record (keymap-runtime.ts), so the same keys work on every device.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The page is the keymap's own table drawn: a new row in keymap.json appears here with no change here, and every
//      word is DATA (keymap.json `words`).
//   2. A key that may not be given (kept by the computer, held by another row, missing the modifier a key from any app
//      needs) is refused in the table's words and changes nothing.
//   3. While a row waits for its new keys the page claims every key press, so the keys being recorded never run what
//      they are bound to.
//   4. Every control is a shared part (parts/ui); this file writes no markup of its own and no appearance.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { Button, Card, Container, Kbd, Text } from '../../parts/ui';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { claimKeyboardEvent } from '../../parts/ui/show/keyboard-claim/keyboard-claim';
import { chordOfEvent, shownChord } from './keymap.mjs';
import { KEYMAP, currentRows, onMac, resetRows, setRowChord, subscribeKeymap, type EffectiveRow } from './keymap-runtime';

const fill = (words: string, values: Record<string, string>) => words.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
const chordWords = (chord: string | null) => (chord ? shownChord(chord, KEYMAP, onMac()).join(' ') : KEYMAP.words.none);

/** Waits for the next chord pressed anywhere on the page and hands it over: Escape hands over undefined (leave it), Delete null (no key). */
function useRecording(onChord: (chord: string | null | undefined) => void, active: boolean) {
  React.useEffect(() => {
    if (!active) return undefined;
    const press = (event: KeyboardEvent) => {
      if (event.repeat) return;
      claimKeyboardEvent(event);
      if (event.code === 'Escape') { onChord(undefined); return; }
      if (event.code === 'Backspace' || event.code === 'Delete') { onChord(null); return; }
      const chord = chordOfEvent(event, KEYMAP, onMac());
      if (chord) onChord(chord);
    };
    window.addEventListener('keydown', press, true);
    return () => window.removeEventListener('keydown', press, true);
  }, [active, onChord]);
}

export function KeymapSettings(): React.ReactElement {
  const rows = React.useSyncExternalStore(subscribeKeymap, () => JSON.stringify(currentRows()), () => '[]');
  const shown = React.useMemo(() => JSON.parse(rows) as EffectiveRow[], [rows]);
  const [recording, setRecording] = React.useState<string | null>(null);
  const attempt = React.useCallback(async (name: string, chord: string | null | undefined) => {
    setRecording(null);
    if (chord === undefined) return;
    const row = currentRows().find(one => one.name === name);
    try {
      const refused = await setRowChord(name, chord);
      if (refused) { notify(fill(KEYMAP.words[refused.refusal], { chord: chordWords(chord), words: refused.holder ?? row?.words ?? '' }), { kind: 'error' }); return; }
      notify(fill(chord === null ? KEYMAP.words.removed : KEYMAP.words.saved, { chord: chordWords(chord), words: row?.words ?? '' }), { kind: 'info' });
    } catch (error) {
      notify(`${KEYMAP.words.failed} ${errorWords(error)}`.trim(), { kind: 'error' });
    }
  }, []);
  const recordingName = recording;
  useRecording(React.useCallback(chord => { if (recordingName) void attempt(recordingName, chord); }, [recordingName, attempt]), recording !== null);
  const putBack = async (row: EffectiveRow) => {
    try {
      await resetRows(row.name);
      const usual = KEYMAP.rows.find(one => (one.id ?? one.verb) === row.name)?.chord ?? null;
      notify(fill(usual ? KEYMAP.words.restored : KEYMAP.words.restored_none, { chord: chordWords(usual), words: row.words }), { kind: 'info' });
    } catch (error) {
      notify(`${KEYMAP.words.failed} ${errorWords(error)}`.trim(), { kind: 'error' });
    }
  };
  const putAllBack = async () => {
    try { await resetRows(); } catch (error) { notify(`${KEYMAP.words.failed} ${errorWords(error)}`.trim(), { kind: 'error' }); }
  };
  return (
    <Container layout="vertical" gap="md" padding="lg" data-keymap-settings="">
      <Container layout="vertical" gap="xs">
        <Text as="h2" variant="heading-sm">{KEYMAP.words.title}</Text>
        <Text as="p" variant="body-sm" color="muted">{KEYMAP.words.subtitle}</Text>
      </Container>
      {KEYMAP.scopes.map(scope => {
        const group = shown.filter(row => row.scope === scope.id);
        if (!group.length) return null;
        return (
          <Card key={scope.id} variant="nested" padding="md" aria-label={scope.label}>
            <Container layout="vertical" gap="sm">
              <Text as="h3" variant="body" weight="semibold">{scope.label}</Text>
              {scope.kind === 'global' && <Text as="p" variant="caption" color="muted">{KEYMAP.words.global_note}</Text>}
              {group.map(row => (
                <Container key={row.name} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap data-keymap-row={row.name}>
                  <Text variant="body-sm">{row.words}</Text>
                  <Container layout="horizontal" gap="xs" alignItems="center">
                    <Button size="sm" variant="outline" active={recording === row.name} aria-label={`${row.words}: ${chordWords(row.chord)}`}
                      onClick={() => setRecording(recording === row.name ? null : row.name)}>
                      {recording === row.name
                        ? KEYMAP.words.press
                        : row.chord ? shownChord(row.chord, KEYMAP, onMac()).map((key, place) => <Kbd key={`${key}-${place}`} size="sm">{key}</Kbd>) : KEYMAP.words.none}
                    </Button>
                    {row.own && <Button size="sm" variant="ghost" onClick={() => putBack(row)}>{KEYMAP.words.reset}</Button>}
                  </Container>
                </Container>
              ))}
            </Container>
          </Card>
        );
      })}
      {recording !== null && <Text as="p" variant="caption" color="muted">{KEYMAP.words.cancel}</Text>}
      {shown.some(row => row.own) && <Button size="sm" variant="ghost" onClick={() => putAllBack()}>{KEYMAP.words.reset_all}</Button>}
    </Container>
  );
}
