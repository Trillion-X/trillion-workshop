// tools/ui/show/media-item/MediaItem.tsx
//
// PURPOSE
//   A video's still and a list row that leads with one: the 16:9 media slot (the still when one is given, else a token
//   wash with a play disc), an optional length pill in its corner, and the row's title, one line under it and a chevron.
//   Adapted from the 21st.dev "Media Item" family (component 29173, ai2/item-media, VideoItem): its media slot and row
//   anatomy, composed from the shared Container, ImageBlock, Text, NamedIcon and Button with the screen look's tokens,
//   so a whole row is one press with a name.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Colours are the look's tokens only; no product word or address is held here.
//   2. A still that fails to load falls back to the wash, so a row never shows a broken picture.
//   3. The still is decorative inside a named control (alt=""); the control's name is the row's title.
//   4. Pure presentation: what a press does is the caller's.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { ImageBlock } from '../image-block/ImageBlock';
import { NamedIcon } from '../icon';
import { Text } from '../text';
import { cn } from '../cn';

export type MediaStillProps = {
  /** The picture of the video: a poster address. Without one, the look's wash with a play disc. */
  src?: string | null;
  /** The length, as words already formatted by the caller (for example "4:12"). */
  length?: string | null;
  /** `row` is a list row's small slot; `hero` fills the width it is given. */
  size?: 'row' | 'hero';
  className?: string;
};

/** The 16:9 media slot: the still, or a wash with a play disc when there is none or it fails. */
export function MediaStill({ src, length, size = 'row', className }: MediaStillProps) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [src]);
  const shown = Boolean(src) && !failed;
  const hero = size === 'hero';
  return (
    <Container
      aria-hidden="true"
      data-media-still={shown ? 'picture' : 'wash'}
      layout="horizontal"
      gap="none"
      position="relative"
      overflow="hidden"
      alignItems="center"
      justifyContent="center"
      className={cn(
        'aspect-video shrink-0 bg-[var(--glass-bg-subtle)] text-[var(--text-secondary)]',
        hero ? 'w-full rounded-[var(--radius-card,0.75rem)]' : 'w-20 rounded-[var(--radius-control)] sm:w-28',
        className,
      )}
    >
      {shown ? (
        <ImageBlock src={src!} alt="" loading="lazy" objectFit="cover" rounded="none" onError={() => setFailed(true)} className="absolute inset-0 size-full" />
      ) : (
        <Container position="absolute" inset="0" pointerEvents="none" className="bg-gradient-to-br from-[color-mix(in_oklab,var(--button-primary-bg)_22%,transparent)] to-[color-mix(in_oklab,var(--text-primary)_8%,transparent)]" />
      )}
      <Container
        layout="horizontal"
        gap="none"
        position="relative"
        alignItems="center"
        justifyContent="center"
        className={cn('rounded-full bg-[color-mix(in_oklab,var(--surface-primary,white)_85%,transparent)] text-[var(--text-primary)] shadow-sm', hero ? 'size-14' : 'size-7')}
      >
        <NamedIcon name="Play" size={hero ? 'xl' : 'xs'} />
      </Container>
      {length ? (
        <Container position="absolute" className="bottom-1 right-1 rounded-sm bg-[color-mix(in_oklab,var(--text-primary)_72%,transparent)] px-1">
          <Text as="span" variant="caption" weight="medium" tabular className="leading-4 text-[var(--surface-primary,white)]">{length}</Text>
        </Container>
      ) : null}
    </Container>
  );
}

export type MediaItemProps = {
  title: string;
  /** One line under the title (for example the lesson's place in its course). */
  description?: string | null;
  still?: string | null;
  length?: string | null;
  onPress: () => void;
  /** The control's name when the title alone does not say what a press does. */
  ariaLabel?: string;
};

/** A row that leads with a video's still: one press, a title, one line under it, and a chevron. */
export function MediaItem({ title, description, still, length, onPress, ariaLabel }: MediaItemProps) {
  return (
    <Button type="button" variant="ghost" size="option-row" fullWidth onClick={onPress} aria-label={ariaLabel ?? title} className="items-center gap-3">
      <MediaStill src={still} length={length} />
      <Container layout="vertical" gap="none" flex={1} className="min-w-0">
        <Text as="span" variant="body" weight="medium" color="strong" truncate>{title}</Text>
        {description ? <Text as="span" variant="label" color="secondary" truncate>{description}</Text> : null}
      </Container>
      <NamedIcon name="ChevronRight" size="sm" aria-hidden="true" />
    </Button>
  );
}
