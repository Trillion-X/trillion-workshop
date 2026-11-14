// parts/ui/show/choice-tiles/OpenChoice.tsx
//
// NO PRIOR: searched bitfield-packages/packages/*/show for "open in", "ask your ai", "choose app" and the 21st.dev MCP
//   for "open with app picker" and "split button app chooser"; nothing opened a remembered choice. Built on the shared
//   ChoiceTiles (the same tiles as the "Pick the AI you use" step) and the coss Button and Popover.
//
// PURPOSE
//   A button that goes to the person's chosen place (their AI app, say) in a new tab, holding words for it. When the
//   person has chosen before, the button names the choice with its logo and one press opens it, and a small button
//   beside it opens the tiles to choose another. When they have not, the button opens the tiles, and the pick is
//   remembered for every later press anywhere (remembered-choice.ts). Each choice says what its press does: open its
//   address, and for an address that takes no words (`paste`), copy the words first so the person can paste them; or
//   `run` it (handing the job to an AI the person already connected, say), the button showing that work in itself,
//   with the choice's own `button` words.
//   Anatomy after 21st.dev Error Empty State (olewandowski1/empty-states-4: icon then label in each action) and the
//   split button of Dropbox Dash's failure screen (mobbin.com/screens/f10e8de9-fc45-47d7-8ada-238f1ea8d062).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The part names no place: the choices, their addresses and every word are the caller's DATA.
//   2. The tiles are ChoiceTiles, the one picker; this part never draws a second one.
//   3. Opening never replaces the page the person is on: a new tab, with no way back into this page (noopener).
//   5. A choice is drawn the same whatever its press does; the part never knows what a `run` does.
//   4. Appearance lives in screen-look/show/choice-tiles.css.

import React from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '../coss/ui/button';
import { Logo } from '../coss/logo';
import { NamedIcon } from '../icon/NamedIcon';
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '../coss/ui/popover';
import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';
import { ChoiceTiles, type ChoiceTile } from './ChoiceTiles';
import { useRememberedChoice } from './remembered-choice';

/** One place to go: a tile and what its press does: open `href` (with `paste` when the address takes no words), or
 *  `run` (its promise is the button's work). `button` is the chosen button's own words, in place of `chosen`. */
export type OpenableChoice = ChoiceTile & { href?: string; paste?: boolean; run?: () => Promise<unknown>; button?: string };

export type OpenChoiceWords = {
  /** The button's words for a chosen place ("Ask {label}"); `{label}` is the choice's name. */
  chosen: string;
  /** The button's words before anything is chosen ("Ask your AI"). */
  unchosen: string;
  /** The tiles' heading and the small button's name ("Choose your AI"). */
  choose: string;
  /** A NamedIcon for the button before anything is chosen. */
  icon?: string;
};

/** Goes to an address: a web address in a new tab, an app on this computer (claude-cli://, codex://, cursor://) by
 *  following it from a link, which hands it to the app and leaves this page where it is. */
function goTo(href: string) {
  if (/^https?:\/\//i.test(href)) { window.open(href, '_blank', 'noopener,noreferrer'); return; }
  const link = document.createElement('a');
  link.href = href;
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Does what one choice's press does: runs it, or opens its address (copying `words` first when it takes none). */
export function openChoice(choice: OpenableChoice, words: string): Promise<unknown> | undefined {
  if (choice.run) return choice.run();
  if (choice.paste && words) void copyTextToClipboard(words);
  if (choice.href) goTo(choice.href);
  return undefined;
}

/** The button. `remember` names what is chosen (the same key everywhere the choice is offered); `words` are the words
 *  carried to a place whose address takes none. */
export function OpenChoice({ choices, remember, labels, words = '', variant = 'outline' }: { choices: OpenableChoice[]; remember: string; labels: OpenChoiceWords; words?: string; variant?: 'outline' | 'default' | 'ghost' }) {
  const [chosenId, choose] = useRememberedChoice(remember);
  const [picking, setPicking] = React.useState(false);
  const chosen = choices.find(choice => choice.id === chosenId) ?? null;
  if (!choices.length) return null;
  const pick = (tile: ChoiceTile) => {
    const choice = choices.find(item => item.id === tile.id);
    if (!choice) return;
    choose(choice.id);
    setPicking(false);
    void openChoice(choice, words);
  };
  const tiles = (
    <PopoverPopup side="bottom" align="center" sideOffset={6} className="open-choice-popup" data-slot="open-choice-tiles">
      <PopoverTitle className="open-choice-title">{labels.choose}</PopoverTitle>
      <ChoiceTiles tiles={choices} chosen={chosen?.id ?? null} onPick={pick} label={labels.choose} />
    </PopoverPopup>
  );
  if (!chosen) {
    return (
      <Popover open={picking} onOpenChange={setPicking}>
        <PopoverTrigger render={<Button type="button" variant={variant} className="open-choice" />}>
          <NamedIcon name={labels.icon ?? 'Sparkles'} aria-hidden className="open-choice-icon" />
          {labels.unchosen}
        </PopoverTrigger>
        {tiles}
      </Popover>
    );
  }
  return (
    <span className="open-choice-split">
      <Button type="button" variant={variant} className="open-choice" onClick={() => openChoice(chosen, words)}>
        <Logo src={chosen.picture} name={chosen.label} className="open-choice-mark" />
        {chosen.button ?? labels.chosen.replace('{label}', chosen.label)}
      </Button>
      <Popover open={picking} onOpenChange={setPicking}>
        <PopoverTrigger render={<Button type="button" variant={variant} size="icon" className="open-choice-more" aria-label={labels.choose} title={labels.choose} />}>
          <ChevronDown aria-hidden />
        </PopoverTrigger>
        {tiles}
      </Popover>
    </span>
  );
}
