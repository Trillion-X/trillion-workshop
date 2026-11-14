// parts/ui/show/coss/person-hover.tsx
//
// PURPOSE
//   Who someone is and what they made, without leaving the screen: resting on a person's face or name opens a small
//   card with their face and name and a line saying how many things of theirs are here ("3 posts here"); resting on
//   that line opens the list of those things beside it, and resting on one opens the thing itself beside the list,
//   where the caller draws whatever it allows there (its words, its reactions, a reply box), so a reply is written and
//   sent in place. Each card opens from the one before it, to any depth the caller draws.
//   Grounded on Higgsfield's comment card pinned to a face (an in-place reply box under the words, Mobbin) and 21st.dev
//   "Hover Card" #11873 (jshguo: open and close delay, side placement); nesting is Base UI's popover, which keeps a
//   card open while the pointer is in a card it opened.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Knows no product word: the things, how they are counted in words and how one is drawn are the caller's.
//   2. Every card also opens by press, for touch and keyboard (Base UI's trigger), and closes with Escape.
//   3. Controls are the licensed coss Popover and the shared person mark (DisplayMark); appearance lives in screen-look/show/reactions.css
//      (`.person-hover*`), the face's corner radius from the look's tokens.

import * as React from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover';
import { DisplayMark } from '../display-mark';

/** One thing of the person's, as its row: `title` its words cut short, `when` when they made it. */
export type PersonThing = { id: string; title: string; when?: string };

const OPEN_DELAY = 300;
const CLOSE_DELAY = 220;

/** A card that opens when the pointer rests on its trigger (or the trigger is pressed), beside the card it sits in. */
function HoverLayer({ trigger, triggerClass, side = 'right', label, children }: {
  trigger: React.ReactNode; triggerClass: string; side?: 'right' | 'bottom'; label: string; children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={OPEN_DELAY} closeDelay={CLOSE_DELAY} className={triggerClass} aria-label={label}>{trigger}</PopoverTrigger>
      <PopoverPopup className="coss-ui person-hover" side={side} align="start" sideOffset={8}>{children}</PopoverPopup>
    </Popover>
  );
}

export function PersonHover({ name, picture, things, countWords, drawThing, children }: {
  name: string; picture?: string | null; things: readonly PersonThing[];
  /** How many things, in words: (3) => "3 posts here". */
  countWords: (count: number) => string;
  /** The thing itself, drawn in the last card. */
  drawThing: (id: string) => React.ReactNode;
  /** The face or name the card opens from. */
  children: React.ReactNode;
}) {
  return (
    <HoverLayer side="bottom" label={name} triggerClass="person-hover-trigger" trigger={children}>
      <div className="person-hover-head">
        <DisplayMark key={picture ?? ''} spec={{ name, ...(picture ? { image: picture } : {}) }} size="lg" />
        <p className="person-hover-name">{name}</p>
      </div>
      {things.length ? (
        <HoverLayer label={countWords(things.length)} triggerClass="person-hover-count" trigger={countWords(things.length)}>
          <div className="person-hover-list" role="list">
            {things.map(thing => (
              <HoverLayer key={thing.id} label={thing.title} triggerClass="person-hover-thing" trigger={(
                <>
                  <span className="person-hover-thing-title">{thing.title}</span>
                  {thing.when ? <span className="person-hover-thing-when">{thing.when}</span> : null}
                </>
              )}>
                <div className="person-hover-peek">{drawThing(thing.id)}</div>
              </HoverLayer>
            ))}
          </div>
        </HoverLayer>
      ) : null}
    </HoverLayer>
  );
}
