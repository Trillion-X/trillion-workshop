// parts/ui/show/choice-tiles/ChoiceTiles.tsx
//
// PORTED FROM: parts/ui/show/coss/guide.tsx (its TabButton and Tabs, the "Pick the AI you use" tiles), moved here so
//   the same tiles serve every place a choice is picked instead of a second copy.
//
// PURPOSE
//   The one picker of a choice drawn as tiles: equal bordered tiles in a grid that fills its width and wraps into rows
//   of the same size, each with the choice's logo (or icon) before its name, the chosen tile ringed. Picking a tile may
//   also copy that tile's words, and the tile itself then says Copied. What a pick does beyond that is the caller's
//   (`onPick`): show that choice's steps (the guide's tabs), or open that choice (OpenChoice, the Ask your AI button of
//   every failure). Anatomy after Klaviyo's "Who is your reviews provider?" picker
//   (mobbin.com/screens/0c6903c3-5ec3-40bd-befb-4b8d5f68dfe4).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The part names no choice: every word, picture and id is the caller's DATA.
//   2. As tabs (`kind: 'tabs'`) arrow keys move focus; Enter, Space or a click activates and copies the chosen tile.
//      Moving focus never runs the caller's action or opens another app. As buttons each tile says whether chosen.
//   3. Appearance lives in screen-look/show/choice-tiles.css.

import React from 'react';
import { Button } from '../coss/ui/button';
import { Logo } from '../coss/logo';
import { NamedIcon } from '../icon/NamedIcon';
import { COPY_FAILED_WORDS, CopyMark, CopyStatusLine, CopyWords, useCopy } from '../copy-button/CopyButton';

/** One tile: `picture` is a logo's address, `icon` a NamedIcon name for a tile with no logo; `copy` is put on the
 *  clipboard when the tile is picked and the tile says `copied_label` on itself for a moment, or `failed_label` (the
 *  shared copy failure words when absent) when the browser refused the copy. */
export type ChoiceTile = { id: string; label: string; description?: string; picture?: string; icon?: string; copy?: { text: string; copied_label: string; failed_label?: string } };
type ChoiceKind = 'tabs' | 'buttons' | 'radio';

function Tile({ tile, chosen, focusable, kind, disabled, onPick, onFocus, onKeyDown }: { tile: ChoiceTile; chosen: boolean; focusable: boolean; kind: ChoiceKind; disabled?: boolean; onPick: () => void; onFocus?: () => void; onKeyDown?: (event: React.KeyboardEvent) => void }) {
  const { copy, status } = useCopy();
  const descriptionId = React.useId();
  const pick = () => { onPick(); if (tile.copy) void copy(tile.copy.text); };
  const role = kind === 'tabs' ? { role: 'tab', 'aria-selected': chosen, tabIndex: focusable ? 0 : -1 }
    : kind === 'radio' ? { role: 'radio', 'aria-checked': chosen, tabIndex: focusable ? 0 : -1 }
    : { 'aria-pressed': chosen };
  return (
    <Button type="button" size="lg" variant="outline" disabled={disabled} aria-label={tile.label} aria-describedby={tile.description ? descriptionId : undefined} {...role} className="choice-tile" data-selected={chosen ? '' : undefined} data-copy-state={tile.copy ? status : undefined} onClick={pick} onFocus={onFocus} onKeyDown={onKeyDown}>
      {kind === 'radio' ? <span className="choice-tile-radio" aria-hidden />
        : tile.icon && !tile.picture ? <span className="choice-tile-mark" aria-hidden><NamedIcon name={tile.icon} /></span> : <Logo src={tile.picture} name={tile.label} className="choice-tile-mark" />}
      <span className="choice-tile-text">
      {tile.copy ? (
        <span className="choice-tile-label">
          <CopyWords status={status} label={tile.label} copiedLabel={tile.copy.copied_label} failedLabel={tile.copy.failed_label || COPY_FAILED_WORDS} />
          <CopyMark status={status} idle={false} />
          <CopyStatusLine status={status} copiedLabel={tile.copy.copied_label} failedLabel={tile.copy.failed_label || COPY_FAILED_WORDS} />
        </span>
      ) : <span className="choice-tile-label">{tile.label}</span>}
      {tile.description ? <span id={descriptionId} className="choice-tile-description">{tile.description}</span> : null}
      </span>
    </Button>
  );
}

/** The tiles. `chosen` is the ringed tile's id; `onPick` gets the picked tile. */
export function ChoiceTiles({ tiles, chosen, onPick, kind = 'buttons', label, disabled = false }: { tiles: ChoiceTile[]; chosen: string | null; onPick: (tile: ChoiceTile) => void; kind?: ChoiceKind; label?: string; disabled?: boolean }) {
  const [focused, setFocused] = React.useState(chosen);
  React.useEffect(() => { setFocused(chosen); }, [chosen]);
  const focusable = tiles.find(tile => tile.id === focused)?.id ?? chosen ?? tiles[0]?.id;
  const move = (event: React.KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' || (kind === 'radio' && event.key === 'ArrowDown') ? 1
      : event.key === 'ArrowLeft' || (kind === 'radio' && event.key === 'ArrowUp') ? -1 : 0;
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const at = event.key === 'Home' ? 0 : event.key === 'End' ? tiles.length - 1 : (index + step + tiles.length) % tiles.length;
    setFocused(tiles[at].id);
    (event.currentTarget.parentElement?.children[at] as HTMLElement | undefined)?.focus();
    if (kind === 'radio') onPick(tiles[at]);
  };
  return (
    <div className="choice-tiles" data-choice-kind={kind} role={kind === 'tabs' ? 'tablist' : kind === 'radio' ? 'radiogroup' : 'group'} aria-label={label}>
      {tiles.map((tile, index) => <Tile key={tile.id} tile={tile} chosen={tile.id === chosen} focusable={tile.id === focusable} kind={kind} disabled={disabled} onPick={() => onPick(tile)} onFocus={kind !== 'buttons' ? () => setFocused(tile.id) : undefined} onKeyDown={kind !== 'buttons' ? event => move(event, index) : undefined} />)}
    </div>
  );
}
