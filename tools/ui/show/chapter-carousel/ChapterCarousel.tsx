// parts/ui/show/chapter-carousel/ChapterCarousel.tsx
// NO PRIOR: searched trillion parts/ui (job-carousel plays one set of recordings with no sets above it; tabs and
//   selectable-pill-bar are the workspace's own controls, not usable on a plain site; media-carousel is a rail of
//   looping items); 21st.dev "Vertical Thumbnail Autostart Slider" and appica-dev "Carousel" (autoplay with a synced
//   strip of choices), whose anatomy this follows one level up: a scrolling row of sets, the chosen set's own autoplay
//   carousel under it.
//
// PURPOSE
//   Several sets of short recordings and pictures in one section (for example one set per use case): a row of the
//   sets that scrolls sideways, and under it the chosen set's own carousel (JobCarousel). When the chosen set's last
//   step ends, the next set starts by itself; a visitor can pick any set, any step in it, or scroll past the section.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Domain-blind: the caller hands chapters ({ id, title, items }), each item a JobCarousel item; this file never
//      knows what a set or a step shows.
//   2. Picking a set starts it at its first step; after the last set the first starts again.
//   3. Accessible as tabs: the row is a horizontal tablist, each set a tab with aria-selected, the set's carousel its
//      tabpanel; the arrow keys move between sets. The chosen set is scrolled into the row's view without moving the
//      page.
//   4. Less motion is JobCarousel's: nothing moves on by itself.
//   5. React and JobCarousel only, so a plain site can draw it; appearance is the caller's classes (`chapter-carousel__*`).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { JobCarousel, type JobCarouselItem } from '../job-carousel/JobCarousel';

export interface Chapter {
  id: string;
  title: string;
  items: readonly JobCarouselItem[];
}

export interface ChapterCarouselProps {
  chapters: readonly Chapter[];
  /** The row of sets' name for a screen reader. */
  label: string;
  /** Each set's list of steps, named for a screen reader: the set's title is added. */
  stepsLabel?: string;
  rate?: number;
  pictureMs?: number;
  renderLink?: (link: { label: string; href: string }) => ReactNode;
  playLabel?: string;
  className?: string;
}

const wrap = (index: number, count: number) => ((index % count) + count) % count;

export function ChapterCarousel({ chapters, label, stepsLabel = 'Steps', rate, pictureMs, renderLink, playLabel, className }: ChapterCarouselProps) {
  const base = useId();
  const row = useRef<HTMLDivElement | null>(null);
  const [chosen, setChosen] = useState(0);
  const sets = chapters.filter((chapter) => chapter.items.length);
  const active = sets[Math.min(chosen, sets.length - 1)];
  const tab = (id: string) => `${base}-${id}-set`;
  const panel = `${base}-set`;
  useEffect(() => {
    // The chosen set slides into the row's view; only the row scrolls, never the page (invariant 3).
    const strip = row.current;
    const button = active ? (strip?.querySelector(`[data-set="${CSS.escape(active.id)}"]`) as HTMLElement | null) : null;
    if (!strip || !button) return;
    const left = button.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + button.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' });
  }, [active?.id]);
  if (!active) return null;
  const choose = (index: number) => setChosen(wrap(index, sets.length));
  return (
    <div className={['chapter-carousel', className].filter(Boolean).join(' ')}>
      <div ref={row} className="chapter-carousel__sets" role="tablist" aria-label={label} aria-orientation="horizontal" style={{ display: 'flex', overflowX: 'auto', scrollSnapType: 'x proximity' }}>
        {sets.map((chapter, index) => {
          const on = chapter.id === active.id;
          return (
            <button
              key={chapter.id}
              type="button"
              role="tab"
              id={tab(chapter.id)}
              data-set={chapter.id}
              aria-selected={on}
              aria-controls={panel}
              tabIndex={on ? 0 : -1}
              data-active={on ? '' : undefined}
              className="chapter-carousel__set"
              style={{ flex: '0 0 auto', scrollSnapAlign: 'start' }}
              onClick={() => choose(index)}
              onKeyDown={(event) => {
                const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                choose(index + step);
                document.getElementById(tab(sets[wrap(index + step, sets.length)].id))?.focus();
              }}
            >
              {chapter.title}
            </button>
          );
        })}
      </div>
      <div className="chapter-carousel__stage" id={panel} role="tabpanel" aria-labelledby={tab(active.id)}>
        <JobCarousel
          key={active.id}
          items={active.items}
          label={`${stepsLabel}: ${active.title}`}
          rate={rate}
          pictureMs={pictureMs}
          renderLink={renderLink}
          playLabel={playLabel}
          loop={false}
          onFinished={() => choose(chosen + 1)}
        />
      </div>
    </div>
  );
}
