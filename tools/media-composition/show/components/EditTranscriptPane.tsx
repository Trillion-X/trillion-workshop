// packages/media-composition/show/components/EditTranscriptPane.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Descript-class transcript editor pane. Renders the frame-addressed word
// stream (DATA, from read-transcript-words) as a document of selectable word
// chips. Selecting a word — or click-then-shift-click a range — and hitting
// "Remove" authors a `remove-span` over the `[start,end]` of the selected words:
// editing the video by editing its text. The one-click cleanups (Remove filler
// words / Shorten gaps) are rendered from `edit-ruleset` DATA labels.
//
// NON-NEGOTIABLE INVARIANTS
//   1. WORDS ARE DATA. The pane renders whatever `words` it is handed and never
//      fabricates any (L117). Absent transcript ⇒ honest empty state that points
//      to the other modalities.
//   2. RULESET ACTIONS ARE DATA. One button per ruleset descriptor; the label
//      comes from the row. Adding a ruleset row ⇒ a new cleanup button, zero
//      code change here.
//   3. NO PACKAGE VOCABULARY. The user sees words, times, and human labels —
//      never `remove-span` / `span` / `edit-decision`.
//   4. UI VIA SHARED PRIMITIVES ONLY (Container / Card / Text / Button).
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import type { TranscriptWord } from '../../read-data/read-transcript-words';
import type { EditRulesetDescriptor } from '../../read-data/edit-capabilities';
import { Button } from '../../../ui/show/button';
import { Card } from '../../../ui/show/card';
import { Container } from '../../../ui/show/container';
import { Text } from '../../../ui/show/text';

export type EditTranscriptPaneProps = {
  words: readonly TranscriptWord[];
  rulesets: readonly EditRulesetDescriptor[];
  currentTime: number;
  disabled?: boolean;
  /** Seek preview + timeline to this word's start. */
  onSeekWord: (word: TranscriptWord) => void;
  /** Cut the inclusive word range's [start,end] out of the timeline. */
  onRemoveRange: (startSeconds: number, endSeconds: number) => void;
  /** Run a whole-transcript cleanup ruleset by name. */
  onRunRuleset: (rulesetName: string) => void;
};

/** Inclusive [a,b] selection over word indices, order-normalized. */
type WordSelection = { anchor: number; head: number } | null;

function normalized(sel: WordSelection): { lo: number; hi: number } | null {
  if (!sel) return null;
  return sel.anchor <= sel.head
    ? { lo: sel.anchor, hi: sel.head }
    : { lo: sel.head, hi: sel.anchor };
}

/** A word chip currently covered by the playhead reads as "playing". */
function isUnderPlayhead(word: TranscriptWord, currentTime: number): boolean {
  return currentTime >= word.start && currentTime < word.end;
}

export function EditTranscriptPane({
  words,
  rulesets,
  currentTime,
  disabled,
  onSeekWord,
  onRemoveRange,
  onRunRuleset,
}: EditTranscriptPaneProps) {
  const [selection, setSelection] = React.useState<WordSelection>(null);
  const range = normalized(selection);

  const clickWord = React.useCallback((word: TranscriptWord, extend: boolean) => {
    onSeekWord(word);
    setSelection((current) =>
      extend && current ? { anchor: current.anchor, head: word.index } : { anchor: word.index, head: word.index },
    );
  }, [onSeekWord]);

  const removeSelected = React.useCallback(() => {
    if (!range) return;
    const first = words[range.lo];
    const last = words[range.hi];
    if (!first || !last) return;
    onRemoveRange(first.start, last.end);
    setSelection(null);
  }, [onRemoveRange, range, words]);

  // ── Cleanup actions (DATA-driven) — always available when they can apply ────
  const cleanupBar = rulesets.length > 0 ? (
    <Container layout="horizontal" gap="sm" wrap alignItems="center">
      {rulesets.map((ruleset) => (
        <Button
          key={ruleset.name}
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onRunRuleset(ruleset.name)}
        >
          {ruleset.label}
        </Button>
      ))}
    </Container>
  ) : null;

  // ── Empty state (honest — points at the other modalities) ───────────────────
  if (words.length === 0) {
    return (
      <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center">
        <Text variant="heading">No transcript yet.</Text>
        <Text variant="body" color="faint">
          Once this clip is transcribed you can edit the video by editing its words. Meanwhile, trim on the timeline or assemble from search.
        </Text>
      </Container>
    );
  }

  return (
    <Container layout="vertical" gap="md">
      {/* Action row: cleanups + remove-selection */}
      <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" wrap>
        {cleanupBar}
        {range && (
          <Button variant="secondary" size="sm" disabled={disabled} onClick={removeSelected}>
            Remove selection
          </Button>
        )}
      </Container>

      {/* The transcript document — selectable word chips */}
      <Card variant="nested" padding="sm" layout="stack">
        <Container layout="horizontal" gap="xs" wrap alignItems="center">
          {words.map((word) => {
            const selected = !!range && word.index >= range.lo && word.index <= range.hi;
            const playing = isUnderPlayhead(word, currentTime);
            return (
              <Button
                key={`${word.index}:${word.start}`}
                variant={selected ? 'secondary' : playing ? 'outline' : 'ghost'}
                size="xs"
                disabled={disabled}
                onClick={(event) => clickWord(word, event.shiftKey)}
              >
                {word.text || '·'}
              </Button>
            );
          })}
        </Container>
      </Card>

      <Text variant="caption" color="faint">
        Click a word to jump there. Shift-click to select a range, then Remove.
      </Text>
    </Container>
  );
}
