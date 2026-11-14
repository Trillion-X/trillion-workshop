// Public media in any mixed share uses the same player as Trillion's own media surfaces.
// The server has already checked the current share grant and written only same-share URLs;
// every media and transcript request checks that grant again. A collection mounts players as
// they enter view so ten videos in one link do not all start reading bytes at once.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserMediaPlayer, type TimedTextSegment } from '../../parts/media-playback/show/MediaPlaybackSurface';
import { screenLookScheme } from 'trillion-workshop/tools/screen-look/read-data/look-scheme.ts';
import { drawSharedListViews } from './shared-list-views';
import { drawSealedLinks } from './sealed-link-view';

type Passage = { start?: number; end?: number; text?: string; words?: readonly { word: string; start: number; end: number }[] };
type KeptWords = { segments?: Passage[] };
const transcriptRetryDelaysMs = [1500, 5000];

function transcriptRetryAfterMs(reply: Response): number | undefined {
  const value = reply.headers.get('Retry-After');
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 120_000)) : undefined;
}

// A visible poster never starts video bytes by itself. Chromium can turn even
// metadata preload into a full range request, so only the video the recipient
// hovers, focuses, touches or plays may warm its source.
const metadataWarmers = new Map<HTMLElement, (active: boolean) => void>();
let playingVideo: HTMLElement | null = null;
let intendedVideo: HTMLElement | null = null;
let warmVideo: HTMLElement | null = null;
function applyMetadataWarmth(host: HTMLElement | null) {
  if (warmVideo === host) return;
  warmVideo = host;
  for (const [candidate, setWarm] of metadataWarmers) setWarm(candidate === host);
}
function assignMetadataWarmth() {
  const chosen = intendedVideo && metadataWarmers.has(intendedVideo) ? intendedVideo
    : playingVideo && metadataWarmers.has(playingVideo) ? playingVideo : null;
  applyMetadataWarmth(chosen);
}

function timedSegments(passages: Passage[]): TimedTextSegment[] {
  return passages.flatMap((passage, index) => {
    if (!Number.isFinite(passage.start) || !Number.isFinite(passage.end) || typeof passage.text !== 'string') return [];
    const start = Number(passage.start), end = Number(passage.end);
    if (start < 0 || end <= start) return [];
    return [{ id: `share-words-${index}`, text: passage.text, start_ms: Math.round(start * 1000), end_ms: Math.round(end * 1000),
      words: Array.isArray(passage.words) ? passage.words.filter(word => typeof word.word === 'string' && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start) : undefined }];
  });
}

function SharedMedia({ src, type, label, poster, transcript, host }: { src: string; type: string; label: string; poster?: string; transcript?: string; host: HTMLElement }) {
  const [words, setWords] = React.useState<TimedTextSegment[]>([]);
  const [intent, setIntent] = React.useState(false);
  const [warmMetadata, setWarmMetadata] = React.useState(false);
  React.useEffect(() => {
    if (!type.startsWith('video/')) return undefined;
    metadataWarmers.set(host, setWarmMetadata);
    assignMetadataWarmth();
    return () => {
      metadataWarmers.delete(host);
      assignMetadataWarmth();
    };
  }, [host, type]);
  React.useEffect(() => {
    if (!type.startsWith('video/')) return undefined;
    const onPlay = (event: Event) => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      playingVideo = host;
      if (intendedVideo === host) intendedVideo = null;
      setIntent(true);
      assignMetadataWarmth();
    };
    const onPause = (event: Event) => {
      if (!(event.target instanceof HTMLVideoElement) || playingVideo !== host) return;
      playingVideo = null;
      if (!host.matches(':hover') && !host.contains(document.activeElement)) setIntent(false);
      assignMetadataWarmth();
    };
    host.addEventListener('play', onPlay, true);
    host.addEventListener('pause', onPause, true);
    return () => {
      host.removeEventListener('play', onPlay, true);
      host.removeEventListener('pause', onPause, true);
      if (playingVideo === host) {
        playingVideo = null;
        assignMetadataWarmth();
      }
      if (intendedVideo === host) {
        intendedVideo = null;
        assignMetadataWarmth();
      }
    };
  }, [host, type]);
  React.useEffect(() => {
    if (!transcript) return undefined;
    const control = new AbortController();
    let attempts = 0;
    let pending = false;
    let finished = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let media: HTMLMediaElement | null = null;
    const retry = (reply?: Response) => {
      if (control.signal.aborted || finished || attempts > transcriptRetryDelaysMs.length) return;
      const delay = (reply ? transcriptRetryAfterMs(reply) : undefined) ?? transcriptRetryDelaysMs[attempts - 1];
      retryTimer = setTimeout(() => { retryTimer = undefined; void loadWords(); }, delay);
    };
    // Video and poster bytes have first use of the grant. A transient grant failure
    // must not hide captions for the rest of this visit after the first media frame.
    const loadWords = async () => {
      if (pending || finished || retryTimer !== undefined || control.signal.aborted) return;
      pending = true;
      attempts += 1;
      try {
        const reply = await fetch(transcript, { cache: 'no-store', credentials: 'same-origin', signal: control.signal });
        if (!reply.ok) {
          if (reply.status === 408 || reply.status === 425 || reply.status === 429 || reply.status >= 500) retry(reply);
          else finished = true;
          return;
        }
        const answer = await reply.json() as KeptWords;
        finished = true;
        if (!control.signal.aborted && Array.isArray(answer?.segments)) setWords(timedSegments(answer.segments));
      } catch { retry(); }
      finally { pending = false; }
    };
    const findMedia = () => {
      if (media) return;
      media = host.querySelector('video, audio');
      if (!media) return;
      media.addEventListener('loadeddata', loadWords, { once: true });
      media.addEventListener('error', loadWords, { once: true });
      if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) loadWords();
    };
    const observer = new MutationObserver(findMedia);
    observer.observe(host, { childList: true, subtree: true });
    findMedia();
    return () => {
      observer.disconnect();
      media?.removeEventListener('loadeddata', loadWords);
      media?.removeEventListener('error', loadWords);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      control.abort();
    };
  }, [host, transcript]);
  React.useEffect(() => {
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    const clearHoverTimer = () => {
      if (hoverTimer !== undefined) clearTimeout(hoverTimer);
      hoverTimer = undefined;
    };
    const onPointerEnter = () => {
      clearHoverTimer();
      // Passing over another card must not start downloading its video.
      hoverTimer = setTimeout(() => {
        hoverTimer = undefined;
        if (host.matches(':hover')) {
          setIntent(true);
          if (type.startsWith('video/')) {
            intendedVideo = host;
            assignMetadataWarmth();
          }
        }
      }, 150);
    };
    const onPointerLeave = () => {
      clearHoverTimer();
      if (playingVideo !== host && !host.contains(document.activeElement)) {
        setIntent(false);
        if (intendedVideo === host) { intendedVideo = null; assignMetadataWarmth(); }
      }
    };
    const onPointerDown = () => {
      clearHoverTimer();
      setIntent(true);
      if (type.startsWith('video/')) { intendedVideo = host; assignMetadataWarmth(); }
    };
    const onFocusIn = () => {
      setIntent(true);
      if (type.startsWith('video/')) { intendedVideo = host; assignMetadataWarmth(); }
    };
    const onFocusOut = () => queueMicrotask(() => {
      if (playingVideo !== host && !host.contains(document.activeElement) && !host.matches(':hover')) {
        setIntent(false);
        if (intendedVideo === host) { intendedVideo = null; assignMetadataWarmth(); }
      }
    });
    host.addEventListener('pointerenter', onPointerEnter);
    host.addEventListener('pointerleave', onPointerLeave);
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('focusout', onFocusOut);
    return () => {
      clearHoverTimer();
      host.removeEventListener('pointerenter', onPointerEnter);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
    };
  }, [host]);
  const media = { id: src, label, mime_type: type, source_kind: type.startsWith('audio/') ? 'audio' : 'video', playback_url: src,
    poster_url: poster, transcript_ref: words.length ? transcript : undefined };
  return <div className="w-full min-w-0" data-media-playback-surface={src}>
    <BrowserMediaPlayer
      media={media}
      sourceUrl={src}
      type={type.startsWith('audio/') ? 'audio' : 'video'}
      preload={intent ? 'auto' : warmMetadata ? 'metadata' : 'none'}
      releaseUnplayedSourceWhenIdle={type.startsWith('video/')}
      timedTextSegments={words}
    />
  </div>;
}

const targets = [...document.querySelectorAll<HTMLElement>('[data-media-playback-url]')];
const mounted = new WeakSet<HTMLElement>();
const mount = (host: HTMLElement) => {
  if (mounted.has(host)) return;
  const src = host.dataset.mediaPlaybackUrl;
  const type = host.dataset.mediaPlaybackType;
  if (!src || !type || !/^(audio|video)\//.test(type)) return;
  const mountPoint = host.querySelector<HTMLElement>(':scope > .page-media-mount') ?? host;
  const hasServerPoster = Boolean(host.querySelector(':scope > .page-media-poster'));
  mounted.add(host);
  createRoot(mountPoint).render(<SharedMedia src={src} type={type} label={host.dataset.mediaPlaybackLabel || 'Shared media'}
    poster={hasServerPoster ? undefined : host.dataset.mediaPlaybackPoster} transcript={host.dataset.mediaPlaybackTranscript} host={host} />);
};
if (targets.length && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      mount(entry.target as HTMLElement);
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '240px 0px' });
  for (const target of targets) observer.observe(target);
} else for (const target of targets) mount(target);

// The page wears a look through its :root palette (the worn look arrives as a linked stylesheet), so whether it is a light or a
// dark look is read here from the page's own ground, the same question the app asks, and marked where the shared screens read it.
const pageScheme = screenLookScheme({ '--bg-primary': getComputedStyle(document.documentElement).getPropertyValue('--bg-primary') }, '--bg-primary');
if (pageScheme) document.documentElement.dataset.lookScheme = pageScheme;

// The saved views a list page carries (each host names its view): drawn read-only, when near the screen.
drawSharedListViews();

// A sealed link's record, opened here with the key the link's own fragment carries (src/workspace/sealed-link-view.tsx).
drawSealedLinks();
