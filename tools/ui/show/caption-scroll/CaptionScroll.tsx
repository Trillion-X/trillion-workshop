// packages/ui/show/caption-scroll/CaptionScroll.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A reusable, speech-following caption rail for teleprompter-like experiences.
// It renders sentence blocks, keeps the active word centered, marks spoken
// words, and optionally shows progress plus manual back/forward nudges.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. RENDER-ONLY PRIMITIVE: this component never owns speech recognition,
//    recording, or session timing. It renders caller-supplied DATA only.
// 2. CENTER THE ACTIVE WORD: when the active word changes, the active token is
//    scrolled toward the center of the rail.
// 3. SPOKEN NEVER EXCEEDS ACTIVE: words before `spokenWordCount` are marked
//    spoken, the active word is highlighted, and later words stay dim.
// 4. CALM DEFAULT CHROME: the primitive ships the scroll body, progress line,
//    and nudges so feature packages do not reinvent the teleprompter surface.
// 5. MIRRORED FOR GLASS: `mirrored` flips the words left to right, so read off a
//    teleprompter's glass (a phone laid under it) they read the right way round.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import { cn } from '../cn';
import { Button } from '../button';
import { Text } from '../text';

export type CaptionScrollProps = {
  segments: readonly string[];
  activeWordIndex: number;
  spokenWordCount?: number;
  progress?: number;
  statusLabel?: string;
  metaLabel?: string;
  showNudges?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  /** Draws the words flipped left to right, for a teleprompter's glass. */
  mirrored?: boolean;
  className?: string;
};

type WordView = {
  key: string;
  text: string;
  index: number;
};

type SegmentView = {
  key: string;
  words: WordView[];
};

function buildSegments(segments: readonly string[]): SegmentView[] {
  let globalWordIndex = 0;
  return segments.map((segment, segmentIndex) => ({
    key: `segment-${segmentIndex + 1}`,
    words: segment
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean)
      .map((word, wordIndex) => {
        const view = {
          key: `segment-${segmentIndex + 1}-word-${wordIndex + 1}`,
          text: word,
          index: globalWordIndex,
        };
        globalWordIndex += 1;
        return view;
      }),
  }));
}

function clampProgress(progress: number | undefined): number {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(1, progress));
}

export function CaptionScroll({
  segments,
  activeWordIndex,
  spokenWordCount,
  progress,
  statusLabel,
  metaLabel,
  showNudges = false,
  onBack,
  onForward,
  mirrored = false,
  className,
}: CaptionScrollProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const wordRefs = React.useRef(new Map<number, HTMLSpanElement>());
  const segmentViews = React.useMemo(() => buildSegments(segments), [segments]);
  const safeActiveIndex = Math.max(
    0,
    Math.min(
      segmentViews.reduce((count, segment) => count + segment.words.length, 0) - 1,
      activeWordIndex,
    ),
  );
  const spokenCount = Math.max(safeActiveIndex, spokenWordCount ?? safeActiveIndex);
  const width = `${clampProgress(progress) * 100}%`;

  React.useEffect(() => {
    const node = wordRefs.current.get(safeActiveIndex);
    const scrollHost = scrollRef.current;
    if (!node || !scrollHost) return;
    const top = node.offsetTop - scrollHost.clientHeight / 2 + node.offsetHeight / 2;
    scrollHost.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [safeActiveIndex]);

  return (
    <div className={cn(
      'flex flex-col gap-3 rounded-[28px] border border-[var(--border-primary)] bg-[rgba(4,6,10,0.72)] px-5 py-4 shadow-[0_16px_50px_rgba(0,0,0,0.45)] backdrop-blur-[18px]',
      className,
    )}>
      {(statusLabel || metaLabel) ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Text variant="label" weight="bold" className="text-[var(--accent-primary)]">
            {statusLabel || 'Teleprompter'}
          </Text>
          {metaLabel ? (
            <Text variant="body-xs" color="secondary" className="text-[#e5e7eb]">
              {metaLabel}
            </Text>
          ) : null}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        data-mirrored={mirrored ? 'true' : undefined}
        className={cn('h-[min(45vh,390px)] overflow-y-auto px-3 py-[25vh] [scrollbar-width:none]', mirrored && '-scale-x-100')}
        style={{
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 17%, black 83%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 17%, black 83%, transparent 100%)',
        }}
      >
        <div className="flex flex-col gap-2">
          {segmentViews.map((segment) => {
            const isCurrentSegment = segment.words.some((word) => word.index === safeActiveIndex);
            return (
              <p
                key={segment.key}
                className={cn(
                  'm-0 p-0 text-center text-[clamp(24px,2.65vw,42px)] font-[740] leading-[1.28] tracking-[-0.025em] transition-opacity duration-150',
                  isCurrentSegment ? 'opacity-100' : 'opacity-80',
                )}
              >
                {segment.words.map((word) => {
                  const spoken = word.index < spokenCount;
                  const active = word.index === safeActiveIndex;
                  return (
                    <React.Fragment key={word.key}>
                      <span
                        ref={(node) => {
                          if (node) wordRefs.current.set(word.index, node);
                          else wordRefs.current.delete(word.index);
                        }}
                        className={cn(
                          'inline rounded-[0.18em] px-[0.06em] transition-[color,background,opacity,text-shadow] duration-100',
                          spoken ? 'text-[#f8fafc] opacity-100' : 'text-[#d4dde7] opacity-90',
                          active && 'bg-[rgba(255,255,255,0.24)] text-white opacity-100 shadow-[0_0_22px_rgba(255,255,255,0.22)]',
                        )}
                      >
                        {word.text}
                      </span>{' '}
                    </React.Fragment>
                  );
                })}
              </p>
            );
          })}
        </div>
      </div>

      <div
        role="progressbar"
        aria-label="Script progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clampProgress(progress) * 100)}
        className="h-[3px] overflow-hidden rounded-full bg-[rgba(42,48,59,0.92)]"
      >
        <i
          aria-hidden="true"
          className="block h-full bg-[linear-gradient(90deg,var(--accent-primary),#fff2a8)] transition-[width] duration-150"
          style={{ width }}
        />
      </div>

      {showNudges ? (
        <div className="flex items-center justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={onBack} disabled={!onBack}>
            Back
          </Button>
          <Button variant="secondary" size="sm" onClick={onForward} disabled={!onForward}>
            Forward
          </Button>
        </div>
      ) : null}
    </div>
  );
}
