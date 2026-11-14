// parts/ui/show/examples-strip/ExamplesStrip.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A strip at the top of a screen showing ideas for what to do there: a one-line
// header ("Ideas for Files · 3 ideas") that opens into rows. Each row is the
// shared listing card read whole (parts/ui/show/listing-card, form row): its
// title, one quiet line of detail and its buttons: the primary "Do this for me",
// which hands the request behind it to the person's own AIs, and read more when
// it has an address. Nothing else: no placeholder icon and no badge saying it is
// an example (the owner 2026-09-29: the sparkle and the example chip were extra UI
// taking space); an idea that names its own icon shows it. Anatomy from Gemini
// Notebook's suggestion rows and the listing card's own sources (see README).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Blind to content: every word arrives as data (heading, count, words, each
//    example's title/detail/mark); the strip never names a screen or product.
// 2. The strip never decides what "doing" an example means: onDo is the
//    caller's, and its returned sentence is what the person is told.
// 3. The request goes to the person's AIs through onDo; there is no separate
//    copy button. Only when onDo answers with `copy` (nothing can wait for the
//    person's AIs, such as on the free plan) is the request copied, through the
//    shared copyTextToClipboard, which says true only when the clipboard took it.
// 4. Shared parts only: the listing grid for the cards; Button, Container, Text
//    and Icon for the header. Every card on every screen is the same card.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../button';
import { Container } from '../container';
import { Text } from '../text';
import { Icon } from '../icon';
import { ListingGrid, type Listing } from '../listing-card';
import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';
import { notify } from '../coss/notifications';
import { claimNode, releaseNode } from '../one-owner-per-node';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
export type ExampleItem = {
  id: string;
  title: string;
  detail?: string;
  /** The request behind the example, handed to the person's AI. */
  do_this: string;
  /** Where it comes from ('written' or 'story'); kept with the idea, never drawn as a mark. */
  from: string;
  /** An address to read more, when the example has one. */
  href?: string;
  /** A named icon (NamedIcon); none is drawn when left out. */
  icon?: string;
};

export type ExamplesStripWords = {
  do: string; not_copied: string; read_story?: string;
  [mark: string]: string | undefined;
};

export type ExamplesStripProps = {
  heading: string;
  countWords: string;
  words: ExamplesStripWords;
  examples: readonly ExampleItem[];
  /** Hands the example over; resolves to the sentence the person is told. */
  onDo: (example: ExampleItem) => Promise<{ said: string; copy?: string }>
  defaultOpen?: boolean;
};

// What each card's buttons do, by the button's id.
const DO = 'do';
const READ = 'read';

function ExampleCards({ examples, words, onDo }: { examples: readonly ExampleItem[]; words: ExamplesStripWords; onDo: ExamplesStripProps['onDo'] }) {
  const pressing = React.useRef(new Set<string>());
  const listings: Listing[] = examples.map(example => {
    return {
      id: example.id,
      form: 'row',
      whole: true,
      title: example.title,
      ...(example.detail ? { text: example.detail } : {}),
      ...(example.icon ? { icon: example.icon } : {}),
      actions: [
        { id: DO, label: words.do, primary: true },
        ...(example.href && words.read_story ? [{ id: READ, label: words.read_story, icon: 'ExternalLink' }] : []),
      ],
    };
  });
  const act = async (id: string, action: string) => {
    const example = examples.find(one => one.id === id);
    if (!example) return;
    if (action === READ && example.href) { window.open(example.href, '_blank', 'noopener'); return; }
    if (action !== DO || pressing.current.has(id)) return;
    pressing.current.add(id);
    try {
      const result = await onDo(example);
      if (result.copy && !await copyTextToClipboard(result.copy)) {
        notify(words.not_copied, { kind: 'error' });
      } else {
        notify(result.said, { kind: 'done' });
      }
    } catch (error) { notify(errorWords(error), { kind: 'error' }); } finally { pressing.current.delete(id); }
  };
  return <ListingGrid label={words.do} listings={listings} onAction={(id, action) => void act(id, action)} />;
}

export function ExamplesStrip({ heading, countWords, words, examples, onDo, defaultOpen = false }: ExamplesStripProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  if (!examples.length) return null;
  return (
    <Container layout="vertical" gap="sm" padding="sm" data-examples-strip={open ? 'open' : 'closed'}>
      <Button variant="ghost" size="md" aria-expanded={open} onClick={() => setOpen(value => !value)} className="self-start">
        <Text variant="body-xs" weight="semibold">{heading}</Text>
        <Text variant="caption">{countWords}</Text>
        <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
      </Button>
      {open ? (
        <ExampleCards examples={examples} words={words} onDo={onDo} />
      ) : null}
    </Container>
  );
}

/** Draws the strip into `host`; returns the unmount. */
export function mountExamplesStrip(host: HTMLElement, props: ExamplesStripProps): () => void {
  const root = createRoot(host);
  const release = () => { root.unmount(); };
  claimNode(host, release);
  root.render(<ExamplesStrip {...props} />);
  return () => releaseNode(host);
}
