import React, { useCallback, useId, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlaybackControls } from '../../../media-playback/show/PlaybackControls';

export type SourceCitationProps = {
  number: string;
  title: string;
  excerpt: string;
  sourceLabel?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  watchHref?: string;
  memberLibraryHref?: string;
  memberLibraryLabel?: string;
  membershipHref?: string;
  membershipLabel?: string;
};

type SourceCitationVideoProps = {
  previewUrl: string;
  title: string;
  thumbnailUrl?: string;
  enhanced?: boolean;
};

function SourceCitationVideo({ previewUrl, title, thumbnailUrl, enhanced = false }: SourceCitationVideoProps) {
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlay = useCallback(() => {
    const video = previewRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setIsPlaying(false));
    else video.pause();
  }, []);

  const seek = useCallback((percent: number) => {
    const video = previewRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = video.duration * Math.min(100, Math.max(0, percent)) / 100;
    setCurrentTime(video.currentTime);
  }, []);

  const toggleMute = useCallback(() => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (previewRef.current) previewRef.current.muted = nextMuted;
  }, [isMuted]);

  const changeVolume = useCallback((percent: number) => {
    const boundedVolume = Math.min(100, Math.max(0, percent));
    setVolume(boundedVolume);
    setIsMuted(boundedVolume === 0);
    if (previewRef.current) {
      previewRef.current.volume = boundedVolume / 100;
      previewRef.current.muted = boundedVolume === 0;
    }
  }, []);

  const changeSpeed = useCallback((speed: number) => {
    setPlaybackSpeed(speed);
    if (previewRef.current) previewRef.current.playbackRate = speed;
  }, []);

  return (
    <span className="source-citation__player">
      <video
        ref={previewRef}
        className="source-citation__preview"
        playsInline
        preload="metadata"
        poster={thumbnailUrl}
        src={previewUrl}
        aria-label={`15-second preview: ${title}`}
        onDurationChange={(event) => {
          const nextDuration = event.currentTarget.duration;
          setDuration(Number.isFinite(nextDuration) ? nextDuration : 0);
        }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />
      {enhanced ? (
        <PlaybackControls
          currentTime={currentTime}
          duration={duration}
          isMuted={isMuted}
          isPlaying={isPlaying}
          onSeek={seek}
          onSpeedChange={changeSpeed}
          onToggleMute={toggleMute}
          onTogglePlay={togglePlay}
          onVolumeChange={changeVolume}
          playbackSpeed={playbackSpeed}
          progress={duration > 0 ? currentTime / duration * 100 : 0}
          showControls
          volume={volume}
          minPlaybackSpeed={1}
          maxPlaybackSpeed={1}
        />
      ) : null}
    </span>
  );
}

const citationRoots = new WeakMap<HTMLElement, Root>();

/** Mount shared playback controls and pointer-dismiss behavior on SSR citations. */
export function mountSourceCitationPreviews(root: ParentNode = document): () => void {
  const mounted: Array<{ host: HTMLElement; reactRoot: Root }> = [];
  root.querySelectorAll<HTMLElement>('[data-source-citation-preview]').forEach((host) => {
    if (citationRoots.has(host)) return;
    const previewUrl = host.dataset.previewUrl;
    const title = host.dataset.previewTitle;
    if (!previewUrl || !title) return;
    const reactRoot = createRoot(host);
    citationRoots.set(host, reactRoot);
    reactRoot.render(React.createElement(SourceCitationVideo, {
      enhanced: true,
      previewUrl,
      title,
      thumbnailUrl: host.dataset.previewThumbnail,
    }));
    mounted.push({ host, reactRoot });
  });

  const citationFrom = (event: Event) => {
    const target = event.target;
    return target instanceof Element ? target.closest<HTMLElement>('.source-citation') : null;
  };
  const handleClick = (event: Event) => {
    const target = event.target;
    const citation = citationFrom(event);
    if (!citation || !(target instanceof Element)) return;
    if (target.closest('.source-citation__close')) {
      citation.dataset.citationDismissed = 'true';
      const toggle = citation.querySelector<HTMLInputElement>('.source-citation__toggle');
      if (toggle) toggle.checked = false;
      if (target instanceof HTMLElement) target.blur();
    }
    else if (target.closest('.source-citation__trigger')) delete citation.dataset.citationDismissed;
  };
  const handleChange = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('.source-citation__toggle') || !target.checked) return;
    const citation = target.closest<HTMLElement>('.source-citation');
    if (citation) delete citation.dataset.citationDismissed;
  };
  root.addEventListener('click', handleClick);
  root.addEventListener('change', handleChange);

  return () => {
    root.removeEventListener('click', handleClick);
    root.removeEventListener('change', handleChange);
    mounted.forEach(({ host, reactRoot }) => {
      citationRoots.delete(host);
      reactRoot.unmount();
    });
  };
}

/** A checkbox disclosure keeps the article readable before its controls bundle loads. */
export function SourceCitation({
  number, title, excerpt, sourceLabel = 'Lesson source', thumbnailUrl, previewUrl,
  watchHref, memberLibraryHref, memberLibraryLabel = 'Open member library',
  membershipHref, membershipLabel = 'See membership',
}: SourceCitationProps) {
  const controlId = useId();
  return (
    <span className="source-citation" data-source-citation="">
      <input className="source-citation__toggle" id={controlId} type="checkbox" aria-label={`Show source ${number}: ${title}`} aria-controls={`${controlId}-panel`} />
      <label className="source-citation__trigger" htmlFor={controlId}>
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" width="14" height="14">
          <path d="M4.5 3.5h8.2l2.8 2.8v10.2h-11zM12.7 3.5v3h2.8M7 10h6M7 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{number}</span>
      </label>
      <span className="source-citation__panel" id={`${controlId}-panel`}>
        <button className="source-citation__close" type="button" aria-label="Close source details">
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" width="18" height="18">
            <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        {previewUrl ? (
          <span className="source-citation__preview-mount" data-source-citation-preview="" data-preview-url={previewUrl} data-preview-title={title} data-preview-thumbnail={thumbnailUrl}>
            <SourceCitationVideo previewUrl={previewUrl} title={title} thumbnailUrl={thumbnailUrl} />
          </span>
        ) : thumbnailUrl ? <img className="source-citation__thumbnail" src={thumbnailUrl} alt="" loading="lazy" /> : null}
        {previewUrl ? <span className="source-citation__preview-note">15-second preview · Membership unlocks the full lesson</span> : null}
        <span className="source-citation__label">{sourceLabel}</span>
        <strong className="source-citation__title">{title}</strong>
        <span className="source-citation__excerpt">{excerpt}</span>
        <span className="source-citation__actions">
          {watchHref ? <a href={watchHref}>Watch lesson</a> : null}
          {memberLibraryHref ? <a href={memberLibraryHref}>{memberLibraryLabel}</a> : null}
          {membershipHref ? <a href={membershipHref}>{membershipLabel}</a> : null}
        </span>
      </span>
    </span>
  );
}
