// parts/ui/show/style-choices/StyleChoices.tsx
//
// PURPOSE
//   One choice among visual presets, each shown as a sample of its own result (caption styles, text looks, themes):
//   a card radio group with roving arrow keys. The caller describes each sample as DATA: `sample` is what the card
//   shows (text, or runs of text each with its own look, such as one word lit up in a caption) and `sampleStyle`
//   the typography and colours the whole sample previews.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Controlled: `value` is the chosen id and `onChange` the only way it changes; nothing is kept here.
//   2. One radio group to assistive technology: each card is a radio, only the chosen (or first) card is tabbable,
//      arrow keys move the choice and the focus together.
//   3. The sample never takes the control's name: the card's accessible name is its label.

import React from 'react';
import { Button } from '../coss/ui/button';

/** A run of sample text with its own look (a colour, a weight), laid out after the run before it. */
export type SampleRun = { text: string; style?: React.CSSProperties };

export type StyleChoice = {
  id: string;
  label: string;
  /** What the card shows: text, or runs of text each with its own look; defaults to "Aa". */
  sample?: string | SampleRun[];
  /** The sample's own typography and colours (a font, a weight, a colour), as the preset would draw them. */
  sampleStyle?: React.CSSProperties;
};

export type StyleChoicesProps = {
  items: StyleChoice[];
  value?: string;
  label: string;
  onChange: (id: string) => void;
};

export function StyleChoices({ items, value, label, onChange }: StyleChoicesProps) {
  const move = (event: React.KeyboardEvent<HTMLElement>, index: number) => {
    const step = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + items.length) % items.length;
    onChange(items[next].id);
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };
  return <div role="radiogroup" aria-label={label} className="coss-style-choices grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2">{items.map((item, index) => {
    const active = item.id === value;
    return <Button key={item.id} type="button" variant="outline" role="radio" aria-checked={active} aria-label={item.label} tabIndex={active || (!value && index === 0) ? 0 : -1} data-pressed={active ? '' : undefined}
      className="h-auto sm:h-auto min-w-0 flex-col items-stretch gap-1.5 whitespace-normal p-1.5 text-left data-pressed:border-primary data-pressed:ring-2 data-pressed:ring-primary/25"
      onClick={() => onChange(item.id)} onKeyDown={event => move(event, index)}>
      <span aria-hidden="true" className="flex min-h-14 items-center justify-center overflow-hidden rounded-md bg-neutral-900 p-2 text-center text-xs leading-tight text-white" style={item.sampleStyle}>{Array.isArray(item.sample) ? <span>{item.sample.map((run, at) => <React.Fragment key={at}>{at ? ' ' : ''}<span style={run.style}>{run.text}</span></React.Fragment>)}</span> : item.sample ?? 'Aa'}</span>
      <span className="truncate px-0.5 text-xs font-medium">{item.label}</span>
    </Button>;
  })}</div>;
}
