// parts/ui/show/reactions/ReactionRow.tsx
//
// PURPOSE
//   The reactions on one thing and the way to add one: each reaction given is a small chip (its glyph, how many gave
//   it, pressed when one of them is the reader, who gave it on hover), pressing a chip gives or takes back that
//   reaction, and the smile mark opens the picker: the offered reactions first, then the reader's own, any emoji or
//   an https picture or GIF. Any screen that shows a thing can draw this beside it: a post in a thread, a row, a card.
//   Adapted from 21st.dev "Reaction Chip" #6601 (jatin-yadav05: the small toggled chip with its count) and Basecamp's
//   boost picker as Mobbin shows it (a grid of glyphs over a field for your own).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Names no reaction and no product word: the palette and the reactions come from the caller (src/reactions.json
//      in Trillion); a glyph that is an https address draws as a picture, anything else as text.
//   2. Every press is the button's own work: it shows pending, then done or the failure inside itself (the coss Button
//      reads the promise `onReact` returns), never a toast elsewhere.
//   3. Controls are the licensed coss Button, Popover and Input; appearance lives in screen-look/show/reactions.css.

import * as React from 'react';
import { SmilePlus } from 'lucide-react';
import { Button } from '../coss/ui/button';
import { Input } from '../coss/ui/input';
import { Popover, PopoverPopup, PopoverTrigger } from '../coss/ui/popover';

/** One reaction as the thing carries it: `by` names who gave it, when the caller knows. */
export type Reaction = { symbol: string; glyph: string; label: string; count: number; yours: boolean; by?: readonly string[] };
/** One offered reaction. */
export type OfferedReaction = { symbol: string; glyph: string; label: string };
/** What a press asks for: a symbol from the palette or one already given, or the reader's own glyph; `on` false
 *  takes it back. */
export type ReactionChoice = { symbol?: string; glyph?: string; on: boolean };
export type ReactionWords = { add: string; own: string; ownPlaceholder: string; give: string };

const WORDS: ReactionWords = { add: 'Add a reaction', own: 'Your own', ownPlaceholder: 'An emoji, or a picture or GIF link', give: 'Add' };
const isPicture = (glyph: string) => /^https:\/\//i.test(glyph);

/** A glyph drawn as text, or as its picture when it is a web address. */
export function ReactionGlyph({ glyph, label }: { glyph: string; label: string }) {
  return isPicture(glyph)
    ? <img className="reaction-picture" src={glyph} alt={label} loading="lazy" draggable={false} />
    : <span className="reaction-emoji" aria-hidden="true">{glyph}</span>;
}

export function ReactionRow({ reactions = [], palette, onReact, words: given, compact = false, only }: {
  reactions?: readonly Reaction[]; palette: readonly OfferedReaction[]; onReact: (choice: ReactionChoice) => Promise<unknown>;
  words?: Partial<ReactionWords>; compact?: boolean;
  /** 'given' draws only the chips of reactions given; 'add' only the way to add one (a chat draws the chips on its
   *  bubble and the way to add one with the message's other tools). Both when left out. */
  only?: 'given' | 'add';
}) {
  const words = { ...WORDS, ...given };
  const [open, setOpen] = React.useState(false);
  const [own, setOwn] = React.useState('');
  const yours = new Set(reactions.filter(reaction => reaction.yours).map(reaction => reaction.symbol));
  const choose = async (choice: ReactionChoice) => { await onReact(choice); setOpen(false); setOwn(''); };
  return (
    <span className="reaction-row" data-compact={compact ? '' : undefined}>
      {only === 'add' ? null : reactions.map(reaction => (
        <Button key={reaction.symbol} type="button" size="xs" variant="outline" className="reaction-chip" aria-pressed={reaction.yours}
          data-yours={reaction.yours ? '' : undefined}
          aria-label={`${reaction.label}, ${reaction.count}`}
          title={reaction.by?.length ? `${reaction.label}: ${reaction.by.join(', ')}` : reaction.label}
          onClick={() => onReact({ symbol: reaction.symbol, on: !reaction.yours })}>
          <ReactionGlyph glyph={reaction.glyph} label={reaction.label} />
          <span className="reaction-count">{reaction.count}</span>
        </Button>
      ))}
      {only === 'given' ? null : <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button type="button" size="icon-xs" variant="ghost" className="reaction-add" aria-label={words.add} title={words.add} />}>
          <SmilePlus aria-hidden />
        </PopoverTrigger>
        <PopoverPopup className="coss-ui reaction-picker" side="top" align="start">
          <span className="reaction-palette" role="group" aria-label={words.add}>
            {palette.map(offered => (
              <Button key={offered.symbol} type="button" size="icon-sm" variant="ghost" className="reaction-offered"
                aria-label={offered.label} title={offered.label} aria-pressed={yours.has(offered.symbol)}
                onClick={() => choose({ symbol: offered.symbol, on: !yours.has(offered.symbol) })}>
                <ReactionGlyph glyph={offered.glyph} label={offered.label} />
              </Button>
            ))}
          </span>
          <span className="reaction-own">
            <Input size="sm" aria-label={words.own} placeholder={words.ownPlaceholder} value={own}
              onChange={event => setOwn(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && own.trim()) { event.preventDefault(); void choose({ glyph: own.trim(), on: true }).catch(() => undefined); } }} />
            <Button type="button" size="xs" disabled={!own.trim()} onClick={() => choose({ glyph: own.trim(), on: true })}>{words.give}</Button>
          </span>
        </PopoverPopup>
      </Popover>}
    </span>
  );
}
