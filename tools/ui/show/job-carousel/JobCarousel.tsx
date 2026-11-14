// parts/ui/show/job-carousel/JobCarousel.tsx
// NO PRIOR: searched trillion parts/ui (media-carousel is a horizontal rail of looping items with dots and arrows, with
//   no one-stage picker and no advance on end; tabs is the Bitfield studio's compound tabs in its purple look;
//   looping-clip loops one clip); 21st.dev for an autoplay video showcase with synchronized progress tabs
//   ("Connected Carousel", "Feature Carousel"), whose anatomy this follows: one stage, a list of choices beside it, the
//   active one expanded with its words and a progress line.
//
// PURPOSE
//   Several short recordings in one place, one at a time: the jobs are listed beside one screen, the chosen job's
//   recording plays, and when it ends the next job starts by itself, so a visitor can stay in one section and still see
//   every job, pick the one they care about, or scroll past it all. A thin line under the chosen job fills as its
//   recording plays.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Domain-blind: the caller hands items (id, title, words, an optional link, the recording's sources and cover);
//      this file never knows what a recording shows.
//   2. Plays only while on screen (one IntersectionObserver for the playing recording) and pauses when it leaves.
//   3. Someone who asked their system for less motion sees the cover and a play button; nothing starts or moves on by
//      itself.
//   4. Picking a job plays it from its start; the last job moves on to the first, or, with `loop` false, tells the
//      caller (`onFinished`) so a larger carousel can move on to its next set.
//   5. Accessible as tabs: the list is a tablist, each job a tab with aria-selected, the screen its tabpanel; the arrow
//      keys move between jobs.
//   6. Depends on React alone, so a site without the workspace's packages can draw it. Appearance is the caller's
//      classes (`job-carousel__*`, documented in README.md) and the look's tokens; a link is drawn by `renderLink` so
//      the caller's own link part is used.
//   7. A job may show a picture instead of a recording (the result a recording leads to, such as the page it
//      published): it stays `pictureMs` while on screen, its line filling the same way, then the next job starts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface JobCarouselRecording {
  sources: readonly { src: string; type: string }[];
  /** The picture shown before it plays, and instead of it when motion is turned down. */
  poster?: string;
  /** What the recording shows, read aloud by a screen reader. */
  alt: string;
  width: number;
  height: number;
}

/** A still picture shown as a job, for `pictureMs` before the next job starts. */
export interface JobCarouselPicture {
  src: string;
  /** What the picture shows, read aloud by a screen reader. */
  alt: string;
  width: number;
  height: number;
}

export interface JobCarouselItem {
  id: string;
  title: string;
  /** The words shown under the chosen job. */
  body?: string;
  link?: { label: string; href: string };
  /** What the job shows: a recording, or a picture. */
  recording?: JobCarouselRecording;
  picture?: JobCarouselPicture;
}

export interface JobCarouselProps {
  items: readonly JobCarouselItem[];
  /** The list's name for a screen reader. */
  label: string;
  /** How fast recordings play: 1 is as recorded, 0.7 is slower. */
  rate?: number;
  /** Draws a job's link with the caller's own link part; a plain link when absent. */
  renderLink?: (link: { label: string; href: string }) => ReactNode;
  /** The play button's words when motion is turned down; the job's title follows for a screen reader. */
  playLabel?: string;
  /** How long a picture stays before the next job, in milliseconds. */
  pictureMs?: number;
  /** After the last job: start the first again (true), or stop and call `onFinished`. */
  loop?: boolean;
  onFinished?: () => void;
  className?: string;
}

function prefersCalm() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

const wrap = (index: number, count: number) => ((index % count) + count) % count;

function Recording({ item, rate, playLabel, onProgress, onEnded }: {
  item: JobCarouselItem; rate: number; playLabel: string; onProgress: (share: number) => void; onEnded: () => void;
}) {
  const clip = useRef<HTMLVideoElement | null>(null);
  const [calm] = useState(prefersCalm);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const element = clip.current;
    if (!element) return;
    element.defaultPlaybackRate = rate;
    element.playbackRate = rate;
    if (calm) return;
    const watcher = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void element.play().catch(() => {});
      else element.pause();
    }, { threshold: 0.25 });
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [calm, rate]);
  const recording = item.recording!;
  return (
    <div className="job-carousel__clip" style={{ position: 'relative', aspectRatio: `${recording.width} / ${recording.height}` }}>
      <video
        ref={clip}
        className="job-carousel__video"
        muted
        playsInline
        preload="metadata"
        poster={recording.poster}
        aria-label={recording.alt}
        style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
        onLoadedMetadata={(event) => { event.currentTarget.playbackRate = rate; }}
        onTimeUpdate={(event) => { const { currentTime, duration } = event.currentTarget; if (duration) onProgress(currentTime / duration); }}
        onEnded={() => { onProgress(1); if (!calm) onEnded(); else setStarted(false); }}
      >
        {recording.sources.map((source) => <source key={source.src} src={source.src} type={source.type} />)}
      </video>
      {calm && !started ? (
        <button
          type="button"
          className="job-carousel__play"
          aria-label={`${playLabel}: ${item.title}`}
          onClick={() => { setStarted(true); void clip.current?.play().catch(() => {}); }}
        >
          {playLabel}
        </button>
      ) : null}
    </div>
  );
}

// A picture held for `ms` while on screen; its share of that time fills the job's line. Less motion keeps it still.
function Picture({ item, ms, onProgress, onEnded }: { item: JobCarouselItem; ms: number; onProgress: (share: number) => void; onEnded: () => void }) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [calm] = useState(prefersCalm);
  useEffect(() => {
    const element = frame.current;
    if (!element || calm) return;
    let shown = 0;
    let last = 0;
    let visible = false;
    let tick = 0;
    const step = (now: number) => {
      if (visible) shown += last ? now - last : 0;
      last = visible ? now : 0;
      onProgress(Math.min(1, shown / ms));
      if (shown >= ms) { onEnded(); return; }
      tick = requestAnimationFrame(step);
    };
    const watcher = new IntersectionObserver(([entry]) => { visible = Boolean(entry?.isIntersecting); }, { threshold: 0.25 });
    watcher.observe(element);
    tick = requestAnimationFrame(step);
    return () => { watcher.disconnect(); cancelAnimationFrame(tick); };
  }, [calm, ms]);
  const picture = item.picture!;
  return (
    <div ref={frame} className="job-carousel__clip job-carousel__clip--picture" style={{ position: 'relative', aspectRatio: `${picture.width} / ${picture.height}` }}>
      <img className="job-carousel__picture" src={picture.src} alt={picture.alt} width={picture.width} height={picture.height} loading="lazy" decoding="async" style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top left' }} />
    </div>
  );
}

export function JobCarousel({ items, label, rate = 1, renderLink, playLabel = 'Play', pictureMs = 6000, loop = true, onFinished, className }: JobCarouselProps) {
  const base = useId();
  const [chosen, setChosen] = useState(0);
  const [played, setPlayed] = useState(0);
  if (!items.length) return null;
  const active = items[Math.min(chosen, items.length - 1)];
  const choose = (index: number) => { setPlayed(0); setChosen(wrap(index, items.length)); };
  const next = () => { if (!loop && chosen >= items.length - 1) onFinished?.(); else choose(chosen + 1); };
  const tab = (id: string) => `${base}-${id}-tab`;
  const panel = `${base}-screen`;
  return (
    <div className={['job-carousel', className].filter(Boolean).join(' ')}>
      <ol className="job-carousel__jobs" role="tablist" aria-label={label} aria-orientation="vertical">
        {items.map((item, index) => {
          const on = item.id === active.id;
          return (
            <li key={item.id} className="job-carousel__job" data-active={on ? '' : undefined} role="presentation">
              <button
                type="button"
                role="tab"
                id={tab(item.id)}
                aria-selected={on}
                aria-controls={panel}
                tabIndex={on ? 0 : -1}
                className="job-carousel__pick"
                onClick={() => choose(index)}
                onKeyDown={(event) => {
                  const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
                  if (!step) return;
                  event.preventDefault();
                  choose(index + step);
                  document.getElementById(tab(items[wrap(index + step, items.length)].id))?.focus();
                }}
              >
                {item.title}
              </button>
              {on ? (
                <div className="job-carousel__words">
                  <span className="job-carousel__progress" aria-hidden="true">
                    <span className="job-carousel__progress-fill" style={{ display: 'block', height: '100%', transformOrigin: 'left center', transform: `scaleX(${played})` }} />
                  </span>
                  {item.body ? <p className="job-carousel__body">{item.body}</p> : null}
                  {item.link ? (renderLink ? renderLink(item.link) : <a className="job-carousel__link" href={item.link.href}>{item.link.label}</a>) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="job-carousel__screen" id={panel} role="tabpanel" aria-labelledby={tab(active.id)}>
        {active.recording
          ? <Recording key={active.id} item={active} rate={rate} playLabel={playLabel} onProgress={setPlayed} onEnded={next} />
          : active.picture ? <Picture key={active.id} item={active} ms={pictureMs} onProgress={setPlayed} onEnded={next} /> : null}
      </div>
    </div>
  );
}
