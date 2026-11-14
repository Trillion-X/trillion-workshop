import React from 'react';
import { PanelLeftClose, PanelRightClose, Play, X } from 'lucide-react';
import { ExpandableTabs } from '../../ui/show/expandable-tabs';
import { Spinner } from '../../ui/show/spinner';
import { VirtualList } from '../../ui/show/virtual-list';
import { InlineTextAction } from '../../ui/show/inline-text-action';
import { PlaybackCompletion as PlaybackCompletionOverlay } from '../../ui/show/playback-completion';
import { Dropdown } from '../../ui/show/dropdown';
import { widestTextWidth } from '../../ui/read-data/widest-text';
import { captionReaderLook, captionShellClass, captionToolbarClass, timedPassageClass, timedWordClass, type TimedWordLook } from '../../screen-look/show/timed-text-style';
import { timedTextSegmentLookup } from '../read-data/timed-text-index';
import { transcriptSegmentsForSpeaker, transcriptSpeakers } from '../../transcript-reader/read-data/read-transcript-records';
import { readOrMakePreview, type MadePreviewStore } from '../../ui/show/media-preview';
import { MediaFrame } from './MediaFrame';
import { controlShown } from '../../ui/show/show-rules/show-of';

// The browser's own picture in picture for a playing video or an embedded player is the same control a pane floating
// over the screen is (parts/screen-arrangement/controls.json): a show rule hiding it turns both off.
const PICTURE_IN_PICTURE_CONTROL = 'open.picture-in-picture';
const EMBED_ALLOWS = ['accelerometer', 'autoplay', 'clipboard-write', 'encrypted-media', 'fullscreen', 'gyroscope', 'picture-in-picture', 'web-share'];
const embedAllows = () => EMBED_ALLOWS.filter(allow => allow !== 'picture-in-picture' || controlShown(PICTURE_IN_PICTURE_CONTROL)).join('; ');
import { PlaybackControls } from './PlaybackControls';
import { hostWithin } from 'trillion-workshop/tools/http-client/do-work/same-origin.mjs';
import type { MediaEmbedControl, MediaSourceRecord } from '../read-data/read-media-playback';
import { privateObjectControl, privateObjectView } from '../read-data/private-object-request';
import type { PrivateObjectCopy, PrivateObjectReply } from '../read-data/private-object-request';

/** The one play mark every player in Trillion draws over a still or a paused picture: a frosted dark disc with a white
 *  glyph (the icon's own box is the disc), drawn the same for a browser video, an embedded one and a paused one. */
function PlayDisc() {
  return <Play aria-hidden="true" className="pointer-events-none size-16 rounded-full [corner-shape:round] border border-white/20 bg-black/45 py-[18px] pl-[21px] pr-[15px] text-white shadow-[0_8px_30px_rgba(0,0,0,0.35)] backdrop-blur-md" fill="currentColor" />;
}

export type MediaPlaybackSurfaceProps = {
  /** Native video captions reserve space below the whole picture by default. */
  captionPlacement?: CaptionPlacement;
  playbackRanges?: readonly {start:number;end:number}[];
  allowEmbeddedDocument?: boolean;
  media?: MediaSourceRecord;
  onTimeChange?: (currentTime: number, duration: number) => void | Promise<void>;
  onPause?: () => void | Promise<void>;
  onPlay?: () => void | Promise<void>;
  onSelectTranscript?: (visible?: boolean) => void | Promise<void>;
  onTranscriptVisibleChange?: (visible: boolean) => void | Promise<void>;
  completionActions?: readonly MediaPlaybackCompletionAction[];
  /**
   * Preview cap (seconds). When set, the player pauses itself the instant
   * playback reaches this point and calls onPreviewLimit — the host then reveals
   * a paywall. Generic: any caller (sales preview, trial, sample clip) gets the
   * same behavior; the cap value and what happens next are the caller's data.
   */
  previewLimitSeconds?: number;
  onPreviewLimit?: () => void;
  /**
   * For a PRIVATE object (paid book/audiobook/any gated asset) with no playable
   * URL yet: the latest reply from the configured delivery target. `undefined`/`null`
   * = request in flight (the host fetches it), `'error'` = the request failed. The
   * surface renders ONE user-language state from this; when the reply is a grant the
   * host swaps in a playable URL and the player takes over.
   */
  privateDelivery?: PrivateObjectReply | null | 'error';
  /** DATA copy override for the gated states (jargon-free defaults otherwise). */
  privateDeliveryCopy?: Partial<PrivateObjectCopy>;
  /** Host wires the single forward action a gated state offers (sign in / get access / retry). */
  onPrivateDeliveryAction?: (action: 'sign-in' | 'upgrade' | 'retry') => void;
  seekRequest?: MediaPlaybackSeekRequest | null;
  showFrameChrome?: boolean;
  statusLabel?: string;
  timedTextSegments?: readonly TimedTextSegment[];
  transcriptVisible?: boolean;
  /** Where the host shows the transcript. `beside-media` means the host renders its own
   * transcript reader next to the player, so the in-player panel appears only in fullscreen. */
  transcriptPlacement?: TranscriptPlacement;
  /** Start playing silently as soon as it can, the way a preview plays under
   * the pointer; the player's own controls unmute it. */
  autoPlay?: boolean;
  /** How eagerly the browser may read this media before playback. */
  preload?: 'none' | 'metadata' | 'auto';
  /** Release an unplayed source when preload becomes none, cancelling speculative reads. */
  releaseUnplayedSourceWhenIdle?: boolean;
};

export type TranscriptPlacement = 'over-media' | 'beside-media';

export type MediaPlaybackSeekRequest = {
  requestId: number;
  seconds: number;
};

export type MediaPlaybackCompletionAction = {
  detail?: string;
  disabled?: boolean;
  id: string;
  label: string;
  onSelect: () => void | Promise<void>;
};

export type TimedTextWord = {
  confidence?: number;
  end: number;
  loudness?: number;
  start: number;
  word: string;
};

export type TimedTextSegment = {
  end_ms?: number;
  id: string;
  speaker?: string;
  start_ms?: number;
  text: string;
  words?: readonly TimedTextWord[];
};

type BrowserMediaElement = HTMLAudioElement | HTMLVideoElement;

const BROWSER_MIN_PLAYBACK_SPEED = 0.1;
const BROWSER_MAX_PLAYBACK_SPEED = 4;
const EMBEDDED_MIN_PLAYBACK_SPEED = 0.25;
const EMBEDDED_MAX_PLAYBACK_SPEED = 2;
const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube.com';

type YouTubePlayerHandle = {
  destroy: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState?: () => number;
  mute: () => void;
  pauseVideo: () => void;
  playVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  setPlaybackRate: (speed: number) => void;
  setVolume: (volume: number) => void;
  unMute: () => void;
  // Native-caption control. The player renders its OWN caption reader, so YouTube's
  // built-in caption track is redundant and must be forced off (a viewer's YouTube
  // account "always show captions" preference otherwise overlays them on our UI).
  unloadModule?: (module: string) => void;
  setOption?: (module: string, option: string, value: unknown) => void;
};

type YouTubePlayerEvent = {
  data?: number;
  target?: YouTubePlayerHandle;
};

type YouTubePlayerOptions = {
  events?: {
    onReady?: (event: YouTubePlayerEvent) => void;
    onStateChange?: (event: YouTubePlayerEvent) => void;
  };
  height?: string;
  host?: string;
  playerVars?: Record<string, number | string>;
  videoId: string;
  width?: string;
};

type YouTubeIframeApi = {
  Player: new (element: HTMLElement, options: YouTubePlayerOptions) => YouTubePlayerHandle;
  PlayerState?: {
    ENDED: number;
    PAUSED: number;
    PLAYING: number;
  };
};

declare global {
  interface Window {
    YT?: YouTubeIframeApi;
    __bitfieldYouTubeIframeApiCallbacks?: Array<() => void>;
    __bitfieldYouTubeIframeApiLoading?: boolean;
    onYouTubeIframeAPIReady?: () => void;
  }
}

function isYouTubePlayerHandle(value: unknown): value is YouTubePlayerHandle {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof YouTubePlayerHandle, unknown>>;
  return typeof candidate.getCurrentTime === 'function'
    && typeof candidate.getDuration === 'function'
    && typeof candidate.playVideo === 'function'
    && typeof candidate.pauseVideo === 'function'
    && typeof candidate.seekTo === 'function';
}

function stopMediaEvent(event: React.SyntheticEvent) {
  event.stopPropagation();
}

function stopAndPreventMediaEvent(event: React.SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function clampPlaybackSpeed(speed: number, minSpeed: number, maxSpeed: number) {
  if (!Number.isFinite(speed)) return 1;
  return Math.max(minSpeed, Math.min(maxSpeed, speed));
}

function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function playableUrl(media: MediaSourceRecord) {
  return media.playback_url ?? media.delivery_url ?? media.source_url;
}

function mediaElementKind(media: MediaSourceRecord): 'audio' | 'video' | null {
  const mime = media.mime_type ?? '';
  const sourceKind = media.source_kind ?? '';
  if (mime.startsWith('audio/') || sourceKind.includes('audio')) return 'audio';
  if (mime.startsWith('video/') || sourceKind.includes('video')) return 'video';
  return null;
}

function isPrivateObject(media: MediaSourceRecord) {
  return Boolean(media.object_store_ref && media.object_key);
}

function browserOrigin() {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function valueFromToken(valueFrom?: string) {
  if (valueFrom === 'browser_origin') return browserOrigin();
  return undefined;
}

function isYouTubeOrigin(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return hostWithin(url, 'youtu.be') || hostWithin(url, 'youtube-nocookie.com') || hostWithin(url, 'youtube.com');
  } catch {
    return false;
  }
}

function youtubeEmbedOrigin(sourceUrl: string, control?: MediaEmbedControl) {
  if (youtubeVideoId(sourceUrl) || isYouTubeOrigin(control?.target_origin)) return YOUTUBE_EMBED_ORIGIN;
  return YOUTUBE_EMBED_ORIGIN;
}

function youtubeEmbeddableUrl(sourceUrl: string, control?: MediaEmbedControl): string | null {
  const videoId = youtubeVideoId(sourceUrl);
  if (!videoId) return null;
  const url = new URL(`/embed/${encodeURIComponent(videoId)}`, youtubeEmbedOrigin(sourceUrl, control));
  return url.toString();
}

const SPOTIFY_EMBED_ORIGIN = 'https://open.spotify.com';
const SPOTIFY_EMBED_KINDS = ['track', 'album', 'playlist', 'episode', 'show', 'artist'] as const;

function spotifyEmbedTarget(sourceUrl: string): { id: string; kind: string } | null {
  // Spotify URI form: spotify:track:ID (no host to parse — matched directly).
  const uriMatch = /^spotify:(track|album|playlist|episode|show|artist):([A-Za-z0-9]+)$/.exec(sourceUrl.trim());
  if (uriMatch) return { id: uriMatch[2], kind: uriMatch[1] };
  try {
    const url = new URL(sourceUrl, browserOrigin() || 'http://localhost');
    if (url.hostname.replace(/^www\./, '') !== 'open.spotify.com') return null;
    // Handles /track/ID, /embed/track/ID, and locale-prefixed /intl-xx/track/ID —
    // the kind segment is found by name rather than a fixed index.
    const segments = url.pathname.split('/').filter(Boolean);
    const kindIndex = segments.findIndex((segment) => (SPOTIFY_EMBED_KINDS as readonly string[]).includes(segment));
    const id = kindIndex === -1 ? undefined : segments[kindIndex + 1];
    return kindIndex === -1 || !id ? null : { id, kind: segments[kindIndex] };
  } catch {
    return null;
  }
}

/**
 * Mirrors youtubeEmbeddableUrl: parses a Spotify share link/URI and builds the
 * canonical open.spotify.com/embed/{kind}/{id} iframe source. NOTE: full-track
 * playback inside the embed requires a logged-in Spotify Premium session —
 * this wires the real embed surface, it is a separate concern from account
 * entitlement (external dependency, not a code gap).
 */
export function spotifyEmbedUrl(sourceUrl: string): string | null {
  const target = spotifyEmbedTarget(sourceUrl);
  if (!target) return null;
  return new URL(`/embed/${target.kind}/${encodeURIComponent(target.id)}`, SPOTIFY_EMBED_ORIGIN).toString();
}

const APPLE_MUSIC_EMBED_ORIGIN = 'https://embed.music.apple.com';
const APPLE_MUSIC_EMBED_KINDS = ['album', 'playlist', 'song', 'artist', 'station'] as const;

function appleMusicEmbedTarget(sourceUrl: string): { country: string; id: string; kind: string; name: string; songId?: string } | null {
  try {
    const url = new URL(sourceUrl, browserOrigin() || 'http://localhost');
    const host = url.hostname.replace(/^www\./, '');
    if (host !== 'music.apple.com' && host !== 'embed.music.apple.com') return null;
    // music.apple.com/{country}/{kind}/{name}/{id}?i={songId} — the kind
    // segment is found by name so a locale/host variant still resolves.
    const segments = url.pathname.split('/').filter(Boolean);
    const kindIndex = segments.findIndex((segment) => (APPLE_MUSIC_EMBED_KINDS as readonly string[]).includes(segment));
    if (kindIndex === -1 || segments.length < kindIndex + 3) return null;
    return {
      country: segments[kindIndex - 1] ?? 'us',
      id: segments[kindIndex + 2],
      kind: segments[kindIndex],
      name: segments[kindIndex + 1],
      songId: url.searchParams.get('i') ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Mirrors youtubeEmbeddableUrl: parses a music.apple.com share link and builds
 * the canonical embed.music.apple.com/{country}/{kind}/{name}/{id}?i={songId}
 * iframe source. NOTE: full-track playback inside the embed requires an
 * active Apple Music subscription session — this wires the real embed
 * surface, it is a separate concern from account entitlement (external
 * dependency, not a code gap).
 */
export function appleMusicEmbedUrl(sourceUrl: string): string | null {
  const target = appleMusicEmbedTarget(sourceUrl);
  if (!target) return null;
  const url = new URL(
    `/${target.country}/${target.kind}/${encodeURIComponent(target.name)}/${encodeURIComponent(target.id)}`,
    APPLE_MUSIC_EMBED_ORIGIN,
  );
  if (target.songId) url.searchParams.set('i', target.songId);
  return url.toString();
}

/**
 * The single source_kind -> embed-URL-builder table. This is the ONLY place
 * that maps a source to its embed-URL construction. Adding a new embeddable
 * source (e.g. SoundCloud) is ONE map entry + ONE builder function here —
 * never a growing if/else chain (L090 / enum-dissolution). Each builder also
 * runs as a structural fallback (tried in table order) so a bare share URL
 * still resolves even when the caller didn't set source_kind.
 */
const EMBED_URL_BUILDERS: Record<string, (sourceUrl: string, control?: MediaEmbedControl) => string | null> = {
  'apple-music': appleMusicEmbedUrl,
  spotify: spotifyEmbedUrl,
  youtube: youtubeEmbeddableUrl,
};

function hasEmbedUrlBuilder(sourceUrl: string | undefined, sourceKind: string | undefined) {
  if (!sourceUrl) return false;
  const preferredBuilder = sourceKind ? EMBED_URL_BUILDERS[sourceKind] : undefined;
  if (preferredBuilder?.(sourceUrl)) return true;
  return Object.values(EMBED_URL_BUILDERS).some((builder) => Boolean(builder(sourceUrl)));
}

function embeddableSourceUrl(sourceUrl: string, control?: MediaEmbedControl, sourceKind?: string) {
  const preferredBuilder = sourceKind ? EMBED_URL_BUILDERS[sourceKind] : undefined;
  const preferredUrl = preferredBuilder?.(sourceUrl, control);
  if (preferredUrl) return preferredUrl;
  for (const builder of Object.values(EMBED_URL_BUILDERS)) {
    const built = builder(sourceUrl, control);
    if (built) return built;
  }
  return sourceUrl;
}

function embedUrlWithControlParams(sourceUrl: string, control?: MediaEmbedControl, sourceKind?: string) {
  const embeddableUrl = embeddableSourceUrl(sourceUrl, control, sourceKind);
  if (!control?.query_params?.length) return embeddableUrl;
  try {
    const url = new URL(embeddableUrl, browserOrigin() || 'http://localhost');
    for (const param of control.query_params) {
      const value = param.value ?? valueFromToken(param.value_from);
      if (typeof value === 'string') url.searchParams.set(param.key, value);
    }
    return url.toString();
  } catch {
    return embeddableUrl;
  }
}

function youtubePlayerVarValue(value: string) {
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

export function youtubePlayerVars(control: MediaEmbedControl | undefined, videoId: string) {
  const vars: Record<string, number | string> = {
    // cc_load_policy:0 = do NOT auto-show YouTube's native captions. The surface
    // renders its own caption reader, so the built-in track is redundant. This is
    // only the default request — a viewer's account preference can still force
    // captions on, so onReady also unloads the captions module (belt + braces).
    cc_load_policy: 0,
    controls: 0,
    disablekb: 1,
    enablejsapi: 1,
    fs: 1,
    iv_load_policy: 3,
    modestbranding: 1,
    origin: browserOrigin(),
    playsinline: 1,
    rel: 0,
  };

  for (const param of control?.query_params ?? []) {
    const value = param.value ?? valueFromToken(param.value_from);
    if (typeof value === 'string') vars[param.key] = youtubePlayerVarValue(value);
  }

  // DATA may configure other embed options, but the YouTube transport controls
  // stay hidden because PlaybackControls owns this player surface.
  vars.controls = 0;
  vars.cc_load_policy = 0;
  if (vars.loop === 1 || vars.loop === '1') vars.playlist ??= videoId;
  return vars;
}

function loadYouTubeIframeApi(onReady: () => void) {
  if (typeof window === 'undefined') return () => {};
  if (window.YT?.Player) {
    onReady();
    return () => {};
  }

  let active = true;
  const callback = () => {
    if (active) onReady();
  };
  window.__bitfieldYouTubeIframeApiCallbacks ??= [];
  window.__bitfieldYouTubeIframeApiCallbacks.push(callback);

  if (!window.__bitfieldYouTubeIframeApiLoading) {
    window.__bitfieldYouTubeIframeApiLoading = true;
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      const callbacks = window.__bitfieldYouTubeIframeApiCallbacks ?? [];
      window.__bitfieldYouTubeIframeApiCallbacks = [];
      window.__bitfieldYouTubeIframeApiLoading = false;
      callbacks.forEach((readyCallback) => readyCallback());
    };

    if (!document.querySelector('script[data-bitfield-youtube-iframe-api="true"]')) {
      const script = document.createElement('script');
      script.async = true;
      script.dataset.bitfieldYoutubeIframeApi = 'true';
      script.src = 'https://www.youtube.com/iframe_api';
      document.body.appendChild(script);
    }
  }

  return () => {
    active = false;
    window.__bitfieldYouTubeIframeApiCallbacks = (window.__bitfieldYouTubeIframeApiCallbacks ?? [])
      .filter((readyCallback) => readyCallback !== callback);
  };
}

function youtubeVideoId(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl, browserOrigin() || 'http://localhost');
    if (hostWithin(url, 'youtu.be')) return url.pathname.split('/').filter(Boolean)[0] ?? null;
    if (!hostWithin(url, 'youtube.com') && !hostWithin(url, 'youtube-nocookie.com')) return null;
    if (url.pathname.startsWith('/embed/')) return url.pathname.split('/').filter(Boolean)[1] ?? null;
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/').filter(Boolean)[1] ?? null;
    return url.searchParams.get('v');
  } catch {
    return null;
  }
}

function embedPosterUrl(sourceUrl: string) {
  const videoId = youtubeVideoId(sourceUrl);
  return videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : null;
}

function resolveCommandTemplate(value: unknown, input: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveCommandTemplate(item, input));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.from === 'input' && typeof record.key === 'string') {
    return input[record.key];
  }
  if (record.from === 'browser' && record.key === 'origin') {
    return browserOrigin();
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, resolveCommandTemplate(item, input)]));
}

function commandPayload(control: MediaEmbedControl | undefined, command: string, input: Record<string, unknown> = {}) {
  const template = control?.commands?.[command];
  if (!template) return undefined;
  return resolveCommandTemplate(template, input);
}

function embedCommandTargetOrigin(control: MediaEmbedControl | undefined) {
  const targetOrigin = control?.target_origin;
  if (isYouTubeOrigin(targetOrigin)) return YOUTUBE_EMBED_ORIGIN;
  return targetOrigin ?? '*';
}

function postEmbedCommand(
  frame: HTMLIFrameElement | null,
  control: MediaEmbedControl | undefined,
  command: string,
  input?: Record<string, unknown>,
) {
  const payload = commandPayload(control, command, input);
  if (!frame?.contentWindow || !payload) return false;
  const targetOrigin = embedCommandTargetOrigin(control);
  frame.contentWindow.postMessage(control?.serialize === 'json' ? JSON.stringify(payload) : payload, targetOrigin);
  return true;
}

function embedSourceOrigin(sourceUrl: string, control?: MediaEmbedControl, sourceKind?: string) {
  try {
    return new URL(embeddableSourceUrl(sourceUrl, control, sourceKind), browserOrigin() || 'http://localhost').origin;
  } catch {
    return undefined;
  }
}

function activeTimedTextSegmentIndex(segments: readonly TimedTextSegment[] | undefined, currentTime: number) {
  return timedTextSegmentLookup(segments)(currentTime);
}

function activeTimedTextWordIndex(words: readonly TimedTextWord[] | undefined, currentTime: number, isActiveSegment: boolean) {
  if (!words?.length || !isActiveSegment || !Number.isFinite(currentTime)) return -1;
  const exactIndex = words.findIndex((word) => currentTime >= word.start && currentTime < word.end);
  if (exactIndex >= 0) return exactIndex;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (currentTime >= words[index].end) return index;
  }
  return -1;
}

function formatTimedTextOffset(milliseconds?: number) {
  if (typeof milliseconds !== 'number') return '';
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

function timedTextSearchParts(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(${escaped})`, 'ig');
  const normalizedQuery = query.toLowerCase();
  return text.split(pattern).map((part, index) => (
    part.toLowerCase() === normalizedQuery
      ? <mark className="rounded bg-[var(--glass-bg-hover)] px-0.5 text-[var(--text-strong)]" key={`${part}-${index}`}>{part}</mark>
      : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
  ));
}

const TimedWord = React.memo(function TimedWord({
  word, active, past, look, query, onSeek,
}: {
  word: TimedTextWord; active: boolean; past: boolean; look: TimedWordLook;
  query: string; onSeek: (seconds: number) => void;
}) {
  const caption = look === 'white' || look === 'black' || look === 'below-picture';
  return <InlineTextAction
    className={timedWordClass(look, active, past)}
    data-media-caption-active-word={caption ? active ? 'true' : 'false' : undefined}
    data-media-caption-word={caption ? word.word : undefined}
    data-fullscreen-transcript-word-active={!caption ? active ? 'true' : 'false' : undefined}
    onSelect={() => onSeek(word.start)}
  >{timedTextSearchParts(word.word, query)}</InlineTextAction>;
});

const TimedSegmentWords = React.memo(function TimedSegmentWords({
  segment, active, past, wordIndex, look, query = '', onSeek,
}: {
  segment: TimedTextSegment; active: boolean; past: boolean; wordIndex: number;
  look: TimedWordLook; query?: string; onSeek: (seconds: number) => void;
}) {
  if (!segment.words?.length) return <InlineTextAction
    className={timedPassageClass(look)}
    onSelect={() => { if (typeof segment.start_ms === 'number') onSeek(segment.start_ms / 1000); }}
  >{timedTextSearchParts(segment.text, query)}</InlineTextAction>;
  return segment.words.map((word, index) => <React.Fragment key={`${segment.id}:${index}:${word.start}`}>
    <TimedWord word={word} active={active && index === wordIndex} past={active ? index < wordIndex : past} look={look} query={query} onSeek={onSeek} />{' '}
  </React.Fragment>);
});

const CaptionSegment = React.memo(function CaptionSegment({
  segment, active, past, wordIndex, fontSize, textColor, onSeek,
}: {
  segment: TimedTextSegment; active: boolean; past: boolean; wordIndex: number;
  fontSize: number; textColor: 'white' | 'black' | 'below-picture'; onSeek: (seconds: number) => void;
}) {
  return <p
    className={[captionReaderLook.segment, active ? 'opacity-100' : 'opacity-50'].join(' ')}
    data-media-caption-segment={segment.id} data-media-caption-active-segment={active ? 'true' : 'false'} style={{ fontSize }}
  >{segment.speaker ? <strong className="mr-1 font-medium">{segment.speaker}:</strong> : null}<TimedSegmentWords segment={segment} active={active} past={past} wordIndex={wordIndex} look={textColor} onSeek={onSeek} /></p>;
});

function useTimedTextSeek(onSeek: ((seconds: number) => void) | undefined, paused: React.RefObject<boolean>) {
  const latestSeek = React.useRef(onSeek);
  const [followRevision, resumeFollow] = React.useReducer((value: number) => value + 1, 0);
  latestSeek.current = onSeek;
  const seek = React.useCallback((seconds: number) => {
    paused.current = false;
    resumeFollow();
    latestSeek.current?.(seconds);
  }, [paused]);
  return [seek, followRevision] as const;
}

const timedSegmentKey = (segment: TimedTextSegment) => segment.id;
const EMPTY_TIMED_SEGMENTS: readonly TimedTextSegment[] = [];

function captionStorageKey(scope: string, key: string) {
  return `bitfield-caption-reader:${scope}:${key}`;
}

function storedCaptionValue<T>(scope: string, key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(captionStorageKey(scope, key));
    return stored === null ? fallback : JSON.parse(stored) as T;
  } catch {
    return fallback;
  }
}

function setStoredCaptionValue<T>(scope: string, key: string, value: T) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(captionStorageKey(scope, key), JSON.stringify(value));
  } catch {
    // Caption preferences are non-critical UI state.
  }
}

function isCaptionDragBlocked(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('button, input, [data-caption-control], [data-caption-resize-control]'));
}

function hasPointerCapture(element: Element, pointerId: number) {
  return typeof element.hasPointerCapture === 'function' && element.hasPointerCapture(pointerId);
}

function setPointerCaptureIfAvailable(element: Element, pointerId: number) {
  if (typeof element.setPointerCapture === 'function') element.setPointerCapture(pointerId);
}

function releasePointerCaptureIfAvailable(element: Element, pointerId: number) {
  if (hasPointerCapture(element, pointerId) && typeof element.releasePointerCapture === 'function') element.releasePointerCapture(pointerId);
}

export type CaptionPlacement = 'over-picture' | 'below-picture';

export function TimedTextCaptionOverlay({
  placement = 'over-picture',
  controlsVisible,
  currentTime,
  onSeek,
  segments,
  storageScope,
}: {
  placement?: CaptionPlacement;
  controlsVisible: boolean;
  currentTime: number;
  onSeek?: (seconds: number) => void;
  segments?: readonly TimedTextSegment[];
  storageScope: string;
}) {
  const docked = placement === 'below-picture';
  const [mounted, setMounted] = React.useState(false);
  const [widthRatio, setWidthRatio] = React.useState(0.5);
  const [heightRatio, setHeightRatio] = React.useState(0.15);
  const [fontSize, setFontSize] = React.useState(14);
  const [showBackground, setShowBackground] = React.useState(true);
  const [textColor, setTextColor] = React.useState<'white' | 'black'>('white');
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = React.useState({ width: 0, height: 0, controlsInset: 0 });
  const [toolbarHeight, setToolbarHeight] = React.useState(37);
  const toolbarRef = React.useRef<HTMLDivElement | null>(null);
  const [measurementFont, setMeasurementFont] = React.useState('100px sans-serif');
  const [fontsReady, setFontsReady] = React.useState(false);
  const [positionKey, setPositionKey] = React.useState(0);
  const [resizeDirection, setResizeDirection] = React.useState('');
  const constraintsRef = React.useRef<HTMLDivElement | null>(null);
  const dragStart = React.useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const draggingRef = React.useRef(false);
  const dragOffsetRef = React.useRef(offset);
  const resizeStart = React.useRef({ x: 0, y: 0, width: 0, height: 0 });
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const autoFollowPausedRef = React.useRef(false);
  const activeSegmentIndex = activeTimedTextSegmentIndex(segments, currentTime);
  const activeWordIndex = activeTimedTextWordIndex(segments?.[activeSegmentIndex]?.words, currentTime, true);
  const [seekWord, followRevision] = useTimedTextSeek(onSeek, autoFollowPausedRef);
  const shouldShow = Boolean(segments?.length);
  const containerMeasured = containerSize.width > 0 && containerSize.height > 0;
  const widestWord = React.useMemo(() => widestTextWidth((function* () {
    for (const segment of segments ?? EMPTY_TIMED_SEGMENTS) {
      if (segment.words?.length) for (const word of segment.words) yield word.word;
      else for (const word of segment.text.split(/\s+/)) yield word;
    }
  })(), measurementFont) / 100, [segments, measurementFont, fontsReady]);
  const safeInset = captionReaderLook.frameInset;
  const width = docked ? containerSize.width : Math.max(1, Math.min(containerSize.width - safeInset * 2, Math.max(220, containerSize.width * widthRatio)));
  const readerWidth = docked ? Math.min(width, captionReaderLook.maximumReadingWidth) : width;
  const controlsSafeBottom = containerSize.controlsInset;
  const availableHeight = Math.max(1, containerSize.height - safeInset - controlsSafeBottom);
  // A short player cannot donate most of its height to chrome. Keep complete
  // caption lines, measure the actual controls, and cap enlarged type only at
  // the point where even one complete line would no longer fit.
  const fontScale = Math.max(1, containerSize.width / 800);
  const maximumFontSize = Math.max(captionReaderLook.minimumFont, Math.floor(Math.min(
    docked ? captionReaderLook.maximumDockedFont : (availableHeight - toolbarHeight - captionReaderLook.textInset * 2) / captionReaderLook.lineHeight,
    widestWord > 0 ? (readerWidth - captionReaderLook.inlineInset * 2 - captionReaderLook.wordInlineInset) / widestWord : Infinity,
  )));
  const scaledFontSize = Math.max(captionReaderLook.minimumFont, Math.min(maximumFontSize, Math.round(fontSize * fontScale)));
  const readableHeight = Math.ceil(scaledFontSize * captionReaderLook.lineHeight * captionReaderLook.readableLines + captionReaderLook.textInset * 2 + (docked ? captionReaderLook.passageBlockInset * 2 : 0));
  const height = docked ? toolbarHeight + readableHeight : Math.min(availableHeight, Math.max(toolbarHeight + readableHeight, Math.min(containerSize.height * 0.5, containerSize.height * heightRatio)));
  const defaultTopSafeInset = Math.max(safeInset, containerSize.height * 0.1);
  const defaultBottomSafeInset = Math.max(120, containerSize.height * 0.28);
  // Reserve controls until their fade-out actually removes them. Frame and
  // control measurements apply together, without animating through old bounds.
  const baseLeft = (containerSize.width - width) / 2;
  const baseTop = defaultTopSafeInset + (containerSize.height - defaultTopSafeInset - defaultBottomSafeInset - height) / 2;
  const minimumOffsetX = safeInset - baseLeft;
  const maximumOffsetX = containerSize.width - width - safeInset - baseLeft;
  const minimumOffsetY = safeInset - baseTop;
  const maximumOffsetY = Math.max(
    minimumOffsetY,
    containerSize.height - height - controlsSafeBottom - baseTop,
  );
  const visibleOffset = {
    x: clampNumber(offset.x, minimumOffsetX, maximumOffsetX),
    y: clampNumber(offset.y, minimumOffsetY, maximumOffsetY),
  };

  React.useLayoutEffect(() => {
    setWidthRatio(storedCaptionValue(storageScope, 'width-ratio', 0.5));
    setHeightRatio(storedCaptionValue(storageScope, 'height-ratio', 0.15));
    setFontSize(storedCaptionValue(storageScope, 'font-size', 14));
    setShowBackground(storedCaptionValue(storageScope, 'show-background', true));
    setTextColor(storedCaptionValue(storageScope, 'text-color', 'white'));
    setMounted(true);
  }, [storageScope]);

  React.useEffect(() => {
    if (!mounted) return;
    setStoredCaptionValue(storageScope, 'width-ratio', widthRatio);
  }, [mounted, storageScope, widthRatio]);

  React.useEffect(() => {
    if (!mounted) return;
    setStoredCaptionValue(storageScope, 'height-ratio', heightRatio);
  }, [heightRatio, mounted, storageScope]);

  React.useEffect(() => {
    if (!mounted) return;
    setStoredCaptionValue(storageScope, 'font-size', fontSize);
  }, [fontSize, mounted, storageScope]);

  React.useEffect(() => {
    if (!mounted) return;
    setStoredCaptionValue(storageScope, 'show-background', showBackground);
  }, [mounted, showBackground, storageScope]);

  React.useEffect(() => {
    if (!mounted) return;
    setStoredCaptionValue(storageScope, 'text-color', textColor);
  }, [mounted, storageScope, textColor]);

  // Measure the real frame before mounting a positioned reader. Its next
  // layout pass measures the newly attached toolbar before the first paint.
  React.useLayoutEffect(() => {
    const element = constraintsRef.current;
    if (!element) return undefined;
    let observedControls: Element | null = null;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateSize);
    function updateSize() {
      const rect = element.getBoundingClientRect();
      const controls = element.parentElement?.querySelector<HTMLElement>('[data-ui-part="playback-controls"]');
      if (controls !== observedControls) {
        if (observedControls) observer?.unobserve(observedControls);
        observedControls = controls ?? null;
        if (observedControls) observer?.observe(observedControls);
      }
      // The transparent gradient above the controls is decoration, not a hit
      // target; its padding does not consume readable caption space.
      const controlsInset = !docked && controls ? controls.getBoundingClientRect().height - parseFloat(getComputedStyle(controls).paddingTop || '0') + captionReaderLook.controlsGap : 0;
      if (rect.width > 0 && rect.height > 0) setContainerSize(previous => previous.width === rect.width && previous.height === rect.height && previous.controlsInset === controlsInset ? previous : { width: rect.width, height: rect.height, controlsInset });
      const measuredToolbar = toolbarRef.current?.getBoundingClientRect().height;
      if (measuredToolbar && measuredToolbar > 0) setToolbarHeight(Math.ceil(measuredToolbar));
      if (scrollRef.current) {
        const type = getComputedStyle(scrollRef.current);
        setMeasurementFont(`${type.fontStyle} ${type.fontWeight} 100px ${type.fontFamily}`);
      }
    }
    updateSize();
    observer?.observe(element);
    if (toolbarRef.current) observer?.observe(toolbarRef.current);
    const controlsMount = typeof MutationObserver === 'undefined' ? null : new MutationObserver(updateSize);
    if (element.parentElement) controlsMount?.observe(element.parentElement, { childList: true });
    window.addEventListener('resize', updateSize);
    return () => {
      observer?.disconnect();
      controlsMount?.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [containerMeasured, controlsVisible, shouldShow, docked]);

  React.useEffect(() => {
    let current = true;
    document.fonts?.ready.then(() => { if (current) setFontsReady(true); });
    return () => { current = false; };
  }, []);

  if (!shouldShow) return null;

  function resetPosition() {
    setOffset({ x: 0, y: 0 });
    setPositionKey((value) => value + 1);
  }

  function pauseAutoFollow() {
    autoFollowPausedRef.current = true;
  }

  function beginDrag(event: React.PointerEvent<HTMLElement>) {
    const positioner = event.currentTarget.closest('[data-media-caption-positioner]') as HTMLDivElement | null;
    if (!positioner || isCaptionDragBlocked(event.target) && !event.currentTarget.hasAttribute('data-caption-drag-handle')) return;
    event.preventDefault();
    event.stopPropagation();
    dragStart.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    };
    dragOffsetRef.current = offset;
    draggingRef.current = true;
    positioner.dataset.dragging = 'true';
    setPointerCaptureIfAvailable(positioner, event.pointerId);
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (resizeDirection || !draggingRef.current) return;
    if (typeof event.currentTarget.hasPointerCapture === 'function' && !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    const nextOffset = {
      x: clampNumber(dragStart.current.offsetX + event.clientX - dragStart.current.x, minimumOffsetX, maximumOffsetX),
      y: clampNumber(dragStart.current.offsetY + event.clientY - dragStart.current.y, minimumOffsetY, maximumOffsetY),
    };
    dragOffsetRef.current = nextOffset;
    // Pointer movement is a visual-only update. Applying it directly avoids
    // rerendering every timed word in the caption reader for every event.
    event.currentTarget.style.transform = `translate(${Math.round(baseLeft + nextOffset.x)}px, ${Math.round(baseTop + nextOffset.y)}px)`;
  }

  function endPointer(event: React.PointerEvent<HTMLDivElement>) {
    releasePointerCaptureIfAvailable(event.currentTarget, event.pointerId);
    if (draggingRef.current) setOffset(dragOffsetRef.current);
    draggingRef.current = false;
    delete event.currentTarget.dataset.dragging;
    setResizeDirection('');
  }

  function beginResize(event: React.PointerEvent<HTMLDivElement>, direction: string) {
    event.preventDefault();
    event.stopPropagation();
    resizeStart.current = { x: event.clientX, y: event.clientY, width, height };
    setResizeDirection(direction);
    const positioner = event.currentTarget.closest('[data-media-caption-positioner]') as HTMLDivElement | null;
    if (positioner) setPointerCaptureIfAvailable(positioner, event.pointerId);
  }

  function moveResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizeDirection || !containerSize.width || !containerSize.height) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = event.clientX - resizeStart.current.x;
    const deltaY = event.clientY - resizeStart.current.y;
    if (resizeDirection.includes('e')) {
      setWidthRatio(Math.max(0.2, Math.min(0.95, (resizeStart.current.width + deltaX * 2) / containerSize.width)));
    }
    if (resizeDirection.includes('w')) {
      setWidthRatio(Math.max(0.2, Math.min(0.95, (resizeStart.current.width - deltaX * 2) / containerSize.width)));
    }
    if (resizeDirection.includes('s')) {
      setHeightRatio(Math.max(0.1, Math.min(0.5, (resizeStart.current.height + deltaY) / containerSize.height)));
    }
    if (resizeDirection.includes('n')) {
      setHeightRatio(Math.max(0.1, Math.min(0.5, (resizeStart.current.height - deltaY) / containerSize.height)));
    }
  }

  return (
    <div className={docked ? captionReaderLook.dock : captionReaderLook.overlay} style={docked ? { height } : undefined} data-media-caption-placement={placement} data-media-caption-reader={storageScope} ref={constraintsRef}>
      {containerMeasured ? <div
        className={docked ? captionReaderLook.dockPositioner : captionReaderLook.overlayPositioner}
        data-media-caption-controls-visible={controlsVisible ? 'true' : 'false'}
        data-media-caption-overlay={activeSegmentIndex >= 0 ? segments?.[activeSegmentIndex]?.id : 'waiting-for-active-segment'}
        data-media-caption-positioner
        key={positionKey}
        style={{
          transform: docked ? undefined : `translate(${Math.round(baseLeft + visibleOffset.x)}px, ${Math.round(baseTop + visibleOffset.y)}px)`,
          width,
        }}
        onPointerMove={(event) => {
          if (resizeDirection) moveResize(event);
          else moveDrag(event);
        }}
        onPointerUp={endPointer}
      >
        <div className={docked ? captionReaderLook.dockShell : captionShellClass(showBackground, textColor)} style={{ height }} onClick={stopMediaEvent}>
          <div
            className={captionReaderLook.scroll}
            data-media-caption-scroll
            role="region"
            aria-label="Captions"
            tabIndex={0}
            ref={scrollRef}
            style={{
              maskImage: captionReaderLook.fade,
              WebkitMaskImage: captionReaderLook.fade,
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              pauseAutoFollow();
            }}
            onTouchMove={pauseAutoFollow}
            onWheel={pauseAutoFollow}
            onKeyDown={pauseAutoFollow}
            onFocusCapture={pauseAutoFollow}
          >
            <VirtualList
              items={segments ?? EMPTY_TIMED_SEGMENTS}
              itemKey={timedSegmentKey}
              threshold={12}
              scrollParent="nearest"
              overscan={3}
              followIndex={activeSegmentIndex}
              followKey={`${activeWordIndex}:${followRevision}`}
              followTarget='[data-media-caption-active-word="true"]'
              followPausedRef={autoFollowPausedRef}
              measurementKey={`${readerWidth}:${height}:${scaledFontSize}`}
              estimateSize={(segment) => Math.max(1, Math.ceil(segment.text.length * scaledFontSize * 0.55 / Math.max(1, readerWidth - 24))) * scaledFontSize * 1.625 + 8}
              renderItem={(segment, segmentIndex) => <CaptionSegment
                segment={segment} active={segmentIndex === activeSegmentIndex}
                past={activeSegmentIndex >= 0 && segmentIndex < activeSegmentIndex}
                wordIndex={segmentIndex === activeSegmentIndex ? activeWordIndex : -1}
                fontSize={scaledFontSize} textColor={docked ? 'below-picture' : textColor} onSeek={seekWord}
              />}
            />
          </div>
          <div
            className={docked ? captionReaderLook.dockToolbar : captionToolbarClass(showBackground, textColor)}
            ref={toolbarRef}
            data-caption-control
            onClick={stopMediaEvent}
            onPointerDown={stopMediaEvent}
          >
            <ExpandableTabs
              mode="action"
              size={docked ? 'md' : 'sm'}
              frame="none"
              labelDisplay="tooltip"
              ariaLabel="Caption controls"
              items={[
                ...(!docked ? [
                  { id: 'move', label: 'Move captions', icon: 'Move', wrap: (button: React.ReactElement) => <span className="inline-flex cursor-grab active:cursor-grabbing" data-caption-drag-handle onPointerDown={beginDrag}>{button}</span> },
                  { id: 'center', label: 'Center captions', icon: 'AlignCenter' },
                  { id: 'background', label: showBackground ? 'Hide caption background' : 'Show caption background', icon: showBackground ? 'Moon' : 'Sun', pinned: showBackground },
                  { id: 'color', label: 'Switch caption text color', icon: 'Type' },
                ] : []),
                { id: 'smaller', label: 'Decrease caption text size', icon: 'AArrowDown', disabled: scaledFontSize <= captionReaderLook.minimumFont },
                { id: 'larger', label: 'Increase caption text size', icon: 'AArrowUp', disabled: scaledFontSize >= maximumFontSize },
              ]}
              onSelect={(id) => {
                if (id === 'center') resetPosition();
                else if (id === 'background') setShowBackground((value) => !value);
                else if (id === 'color') setTextColor((value) => value === 'white' ? 'black' : 'white');
                else if (id === 'smaller') setFontSize(Math.max(8, scaledFontSize / fontScale - 2));
                else if (id === 'larger') setFontSize(Math.min(maximumFontSize / fontScale, scaledFontSize / fontScale + 2));
              }}
            />
          </div>
          {!docked ? <>
            <div className="absolute inset-y-2 right-0 z-10 w-2 cursor-ew-resize" data-caption-resize-control onPointerDown={(event) => beginResize(event, 'e')} />
            <div className="absolute inset-y-2 left-0 z-10 w-2 cursor-ew-resize" data-caption-resize-control onPointerDown={(event) => beginResize(event, 'w')} />
            <div className="absolute inset-x-2 top-0 z-10 h-2 cursor-ns-resize" data-caption-resize-control onPointerDown={(event) => beginResize(event, 'n')} />
            <div className="absolute inset-x-2 bottom-0 z-10 h-2 cursor-ns-resize" data-caption-resize-control onPointerDown={(event) => beginResize(event, 's')} />
            <div className="absolute left-0 top-0 z-10 h-3 w-3 cursor-nwse-resize" data-caption-resize-control onPointerDown={(event) => beginResize(event, 'nw')} />
            <div className="absolute right-0 top-0 z-10 h-3 w-3 cursor-nesw-resize" data-caption-resize-control onPointerDown={(event) => beginResize(event, 'ne')} />
            <div className="absolute bottom-0 left-0 z-10 h-3 w-3 cursor-nesw-resize" data-caption-resize-control onPointerDown={(event) => beginResize(event, 'sw')} />
            <div className="absolute bottom-0 right-0 z-10 h-3 w-3 cursor-nwse-resize" data-caption-resize-control onPointerDown={(event) => beginResize(event, 'se')} />
          </> : null}
        </div>
      </div> : null}
    </div>
  );
}

const FULLSCREEN_TRANSCRIPT_MIN_WIDTH = 280;

/**
 * Where the one transcript reader sits. `side-panel` lies over the side of a picture (resizable, either side);
 * `under-sound` is laid out under a sound's face on the page's own surface, the words following the sound.
 * Each layout is class names on the same reader, so search, the current word and click-to-seek are shared.
 */
export type TimedTextReaderLayout = 'side-panel' | 'under-sound';
const UNDER_SOUND_SEARCH_FROM_PASSAGES = 6;

const TRANSCRIPT_READER_LOOKS: Record<TimedTextReaderLayout, {
  root: string; panel: string; header: string; title: string; search: string; clear: string; list: string;
  segment: string; segmentOn: string; segmentOff: string; offset: string; empty: string;
}> = {
  'side-panel': {
    root: 'absolute bottom-0 top-0 z-30 flex',
    panel: 'flex flex-1 flex-col overflow-hidden bg-[#11111198] shadow-[0_0_20px_rgba(0,0,0,0.3)] backdrop-blur-md',
    header: 'border-b border-white/10 bg-white/5 px-4 py-3',
    title: 'min-w-0 truncate text-sm font-medium text-white',
    search: 'w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 pr-9 text-sm text-white outline-none transition placeholder:text-white/40 focus:border-white/30 focus:bg-white/10',
    clear: 'absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-white/50 transition hover:bg-white/10 hover:text-white',
    list: 'screen-edge-fade min-h-0 flex-1 overflow-y-auto bg-black/20 p-3',
    segment: 'mb-2 rounded-lg border p-3 text-sm leading-6 transition',
    segmentOn: 'border-[var(--border-strong)] bg-white/10 opacity-100',
    segmentOff: 'border-transparent bg-white/5 opacity-90 hover:border-white/10 hover:opacity-100',
    offset: 'mb-1 flex items-center justify-between gap-2 text-xs text-white/45',
    empty: 'list-none rounded-lg border border-dashed border-white/10 p-3 text-sm text-white/45',
  },
  'under-sound': {
    root: 'relative flex min-h-0 w-full flex-1',
    panel: 'flex min-h-0 flex-1 flex-col overflow-hidden',
    header: 'pb-2',
    title: 'sr-only',
    search: 'w-full rounded-lg border border-input bg-transparent px-3 py-1.5 pr-9 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring',
    clear: 'absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground',
    list: 'screen-edge-fade max-h-[min(24rem,45vh)] min-h-0 flex-1 overflow-y-auto',
    segment: 'rounded-lg px-2 py-1.5 text-[15px] leading-7 transition',
    segmentOn: 'opacity-100',
    segmentOff: 'opacity-80 hover:opacity-100',
    offset: 'mb-0.5 text-xs tabular-nums text-muted-foreground',
    empty: 'list-none p-2 text-sm text-muted-foreground',
  },
};
const FULLSCREEN_TRANSCRIPT_MAX_WIDTH = 500;
const FULLSCREEN_TRANSCRIPT_DEFAULT_WIDTH = 340;

const TranscriptSegment = React.memo(function TranscriptSegment({
  segment, active, past, wordIndex, layout, query, onSeek, index, count,
}: {
  segment: TimedTextSegment; active: boolean; past: boolean; wordIndex: number;
  layout: TimedTextReaderLayout; query: string; onSeek: (seconds: number) => void;
  index: number; count: number;
}) {
  const look = TRANSCRIPT_READER_LOOKS[layout];
  return <div role="listitem" aria-posinset={index + 1} aria-setsize={count}
    className="list-none" data-fullscreen-transcript-segment={segment.id}
    data-fullscreen-transcript-segment-active={active ? 'true' : 'false'}
  ><div className={[look.segment, active ? look.segmentOn : look.segmentOff].join(' ')}>
    <div className={look.offset}><span>{formatTimedTextOffset(segment.start_ms)}</span></div>
    <p>{segment.speaker ? <strong className="mr-1 font-medium">{segment.speaker}:</strong> : null}<TimedSegmentWords segment={segment} active={active} past={past} wordIndex={wordIndex} look={layout} query={query} onSeek={onSeek} /></p>
  </div></div>;
});

type TranscriptRow = { index: number; segment: TimedTextSegment };
const transcriptRowKey = ({ segment }: TranscriptRow) => segment.id;

export function FullscreenTimedTextOverlay({
  currentTime,
  layout = 'side-panel',
  onSeek,
  segments,
  title,
  visible,
}: {
  currentTime: number;
  layout?: TimedTextReaderLayout;
  onSeek: (seconds: number) => void;
  segments?: readonly TimedTextSegment[];
  title: string;
  visible: boolean;
}) {
  const look = TRANSCRIPT_READER_LOOKS[layout];
  const sidePanel = layout === 'side-panel';
  const speakers = React.useMemo(() => transcriptSpeakers(segments ?? []), [segments]);
  const speakerItems = React.useMemo(() => [
    { value: 'all-speakers', label: 'All speakers' },
    ...speakers.map((speaker) => ({ value: `speaker:${speaker}`, label: speaker })),
  ], [speakers]);
  const [speakerSelection, setSpeakerSelection] = React.useState<{ transcriptId?: string; speaker: string | null }>({ speaker: null });
  const selectedSpeaker = speakerSelection.transcriptId === segments?.[0]?.id && speakerSelection.speaker && speakers.includes(speakerSelection.speaker)
    ? speakerSelection.speaker : null;
  // Under a sound, a few passages read at a glance; search appears when it is useful,
  // and the speaker choice appears whenever the transcript has distinct speakers.
  const searchable = sidePanel || (segments?.length ?? 0) > UNDER_SOUND_SEARCH_FROM_PASSAGES || speakers.length > 1;
  const [side, setSide] = React.useState<'left' | 'right'>('right');
  const [width, setWidth] = React.useState(FULLSCREEN_TRANSCRIPT_DEFAULT_WIDTH);
  const [searchQuery, setSearchQuery] = React.useState('');
  const resizeStart = React.useRef({ x: 0, width: FULLSCREEN_TRANSCRIPT_DEFAULT_WIDTH });
  const widthRef = React.useRef(FULLSCREEN_TRANSCRIPT_DEFAULT_WIDTH);
  const activeSegmentIndex = visible ? activeTimedTextSegmentIndex(segments, currentTime) : -1;
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const autoFollowPausedRef = React.useRef(false);
  const [seekWord, followRevision] = useTimedTextSeek(onSeek, autoFollowPausedRef);
  const activeWordIndex = activeTimedTextWordIndex(segments?.[activeSegmentIndex]?.words, currentTime, true);
  const sourceIndexById = React.useMemo(() => new Map((segments ?? []).map((segment, index) => [segment.id, index])), [segments]);
  const visibleSegments = React.useMemo(
    () => visible
      ? transcriptSegmentsForSpeaker(segments ?? [], selectedSpeaker)
        .map(segment => ({ index: sourceIndexById.get(segment.id) ?? -1, segment }))
        .filter(({ segment }) => !searchQuery || segment.text.toLowerCase().includes(searchQuery.toLowerCase()))
      : [],
    [searchQuery, segments, selectedSpeaker, sourceIndexById, visible],
  );
  const activeVisibleIndex = visibleSegments.findIndex(({ index }) => index === activeSegmentIndex);


  if (!visible || !segments?.length) return null;

  function beginResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    widthRef.current = width;
    event.currentTarget.dataset.dragging = 'true';
    resizeStart.current = { x: event.clientX, width };
    setPointerCaptureIfAvailable(event.currentTarget, event.pointerId);
  }

  function moveResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.dataset.dragging !== 'true') return;
    event.preventDefault();
    event.stopPropagation();
    const delta = side === 'right'
      ? resizeStart.current.x - event.clientX
      : event.clientX - resizeStart.current.x;
    widthRef.current = Math.max(FULLSCREEN_TRANSCRIPT_MIN_WIDTH, Math.min(FULLSCREEN_TRANSCRIPT_MAX_WIDTH, resizeStart.current.width + delta));
    const panel = event.currentTarget.parentElement;
    if (panel) panel.style.width = `${widthRef.current}px`;
  }

  function endResize(event: React.PointerEvent<HTMLDivElement>) {
    releasePointerCaptureIfAvailable(event.currentTarget, event.pointerId);
    event.currentTarget.dataset.dragging = 'false';
    setWidth(widthRef.current);
  }

  function pauseAutoFollow() {
    autoFollowPausedRef.current = true;
  }


  return (
    <aside
      className={[
        look.root,
        sidePanel ? (side === 'right' ? 'right-0' : 'left-0') : '',
      ].join(' ')}
      data-media-fullscreen-transcript={title}
      data-transcript-layout={layout}
      style={sidePanel ? { width, bottom: 'var(--media-playback-controls-inset, 0px)' } : undefined}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {sidePanel ? <div
        className={[
          'group absolute top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center',
          side === 'right' ? '-left-1.5' : '-right-1.5',
        ].join(' ')}
        data-fullscreen-transcript-resize
        data-testid="fullscreen-transcript-resize"
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
      >
        <span className="h-16 w-1 rounded-full bg-white/10 transition group-data-[dragging=true]:bg-white/40" />
      </div> : null}
      <div
        className={[
          look.panel,
          sidePanel ? (side === 'right' ? 'ml-2 border-l border-white/10' : 'mr-2 border-r border-white/10') : '',
        ].join(' ')}
      >
        {searchable ? <header className={look.header}>
          <div className={sidePanel ? 'flex flex-wrap items-center justify-between gap-2' : speakers.length > 1 ? 'flex items-center gap-2' : 'sr-only'}>
            <span className={look.title}>{title}</span>
            <div className={sidePanel || speakers.length > 1 ? 'flex items-center gap-2' : 'sr-only'}>
              {speakers.length > 1 ? <Dropdown
                aria-label="Filter transcript by speaker"
                header="Speakers in this recording"
                items={speakerItems}
                onValueChange={value => setSpeakerSelection({ transcriptId: segments?.[0]?.id, speaker: value === 'all-speakers' ? null : value.slice('speaker:'.length) })}
                scrollable
                value={selectedSpeaker ? `speaker:${selectedSpeaker}` : 'all-speakers'}
              /> : null}
              {sidePanel ? <button
              aria-label={`Move transcript to ${side === 'right' ? 'left' : 'right'}`}
              className="rounded-lg border border-transparent p-1.5 text-white/70 transition hover:border-white/10 hover:bg-white/10 hover:text-white"
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setSide((value) => value === 'right' ? 'left' : 'right');
              }}
              onPointerDown={stopMediaEvent}
            >
              {side === 'right' ? <PanelLeftClose className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
              </button> : null}
            </div>
          </div>
          <label className={sidePanel ? 'mt-3 block' : 'block'}>
            <span className="sr-only">Search transcript</span>
            <span className="relative block">
              <input
                className={look.search}
                placeholder="Search transcript..."
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                onClick={stopMediaEvent}
                onPointerDown={stopMediaEvent}
              />
              {searchQuery ? (
                <button
                  aria-label="Clear transcript search"
                  className={look.clear}
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSearchQuery('');
                  }}
                  onPointerDown={stopMediaEvent}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
            </span>
          </label>
        </header> : null}
        <div
          className={look.list}
          data-fullscreen-transcript-scroll
          role="list"
          aria-label="Transcript"
          tabIndex={0}
          ref={scrollRef}
          onPointerDown={(event) => { event.stopPropagation(); pauseAutoFollow(); }}
          onTouchMove={pauseAutoFollow}
          onWheel={pauseAutoFollow}
          onKeyDown={pauseAutoFollow}
          onFocusCapture={pauseAutoFollow}
        >
          <VirtualList
            items={visibleSegments}
            itemKey={transcriptRowKey}
            threshold={12}
            scrollParent="nearest"
            overscan={3}
            followIndex={searchQuery ? -1 : activeVisibleIndex}
            followKey={`${activeWordIndex}:${followRevision}`}
            followTarget='[data-fullscreen-transcript-word-active="true"]'
            followPausedRef={autoFollowPausedRef}
            measurementKey={`${width}:${layout}`}
            estimateSize={({ segment }) => Math.max(1, Math.ceil(segment.text.length * 7.5 / Math.max(1, width - 56))) * (sidePanel ? 24 : 28) + (sidePanel ? 52 : 32)}
            renderItem={({ index, segment }, visibleIndex) => <TranscriptSegment
              segment={segment} active={index === activeSegmentIndex}
              past={activeSegmentIndex >= 0 && index < activeSegmentIndex}
              wordIndex={index === activeSegmentIndex ? activeWordIndex : -1}
              layout={layout} query={searchQuery} onSeek={seekWord}
              index={visibleIndex} count={visibleSegments.length}
            />}
          />
          {visibleSegments.length === 0 ? <div role="listitem" className={look.empty}>No transcript matches.</div> : null}
        </div>
      </div>
    </aside>
  );
}

type WebKitFullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type WebKitFullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type WebKitFullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitDisplayingFullscreen?: boolean; webkitExitFullscreen?: () => void };

function currentFullscreenElement() {
  const doc = document as WebKitFullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

// Enlarges exactly the player whose button was pressed: its own wrapper when
// the page may take element fullscreen, else that player's own video element
// through the platform's native video fullscreen. Escape returns it in place.
async function togglePlayerFullscreen(wrapper: HTMLElement) {
  const doc = document as WebKitFullscreenDocument;
  const video = wrapper.querySelector('video') as WebKitFullscreenVideo | null;
  if (currentFullscreenElement() === wrapper) {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else doc.webkitExitFullscreen?.();
    return;
  }
  if (video?.webkitDisplayingFullscreen) {
    video.webkitExitFullscreen?.();
    return;
  }
  const element = wrapper as WebKitFullscreenElement;
  if (element.requestFullscreen && (doc.fullscreenEnabled ?? true)) {
    try { await element.requestFullscreen(); return; } catch { /* fall through to the video's own fullscreen */ }
  }
  if (element.webkitRequestFullscreen) { element.webkitRequestFullscreen(); return; }
  video?.webkitEnterFullscreen?.();
}

type BrowserMediaPlayerProps = {
  captionPlacement?: CaptionPlacement;
  playbackRanges?: readonly {start:number;end:number}[];
  completionActions?: readonly MediaPlaybackCompletionAction[];
  media: MediaSourceRecord;
  onTimeChange?: (currentTime: number, duration: number) => void | Promise<void>;
  onPause?: () => void | Promise<void>;
  onPlay?: () => void | Promise<void>;
  onSelectTranscript?: (visible?: boolean) => void | Promise<void>;
  onTranscriptVisibleChange?: (visible: boolean) => void | Promise<void>;
  seekRequest?: MediaPlaybackSeekRequest | null;
  sourceUrl: string;
  timedTextSegments?: readonly TimedTextSegment[];
  transcriptVisible?: boolean;
  /** Where the host shows the transcript. `beside-media` means the host renders its own
   * transcript reader next to the player, so the in-player panel appears only in fullscreen. */
  transcriptPlacement?: TranscriptPlacement;
  type: 'audio' | 'video';
  autoPlay?: boolean;
  preload?: 'none' | 'metadata' | 'auto';
  releaseUnplayedSourceWhenIdle?: boolean;
};

// A sound's waveform is the same one Files draws for it (made in the browser by the one preview maker). The player
// asks once per address for the life of the page; what Files keeps beside a file is its own store's business.
const PAGE_ONLY_PREVIEWS: MadePreviewStore = { read: async () => null, keep: async () => undefined };

/** The loudness of a sound from start to end (0..1), made from the sound itself; empty until made or when it cannot be. */
function useSoundPeaks(sourceUrl: string | null, mimeType: string | undefined): readonly number[] {
  const [peaks, setPeaks] = React.useState<readonly number[]>([]);
  React.useEffect(() => {
    setPeaks([]);
    if (!sourceUrl || typeof window === 'undefined') return undefined;
    let live = true;
    let idleHandle: number | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    // A media fragment (#t=12) names a moment, not another sound.
    const address = sourceUrl.split('#')[0]!;
    const makePeaks = () => {
      if (!live) return;
      void readOrMakePreview(`sound:${address}`, address, mimeType || 'audio', PAGE_ONLY_PREVIEWS)
        .then((made) => { if (live && made?.peaks?.length) setPeaks(made.peaks); }, () => undefined);
    };
    // A waveform may read the whole sound. It is secondary to playable bytes and
    // starts only after the audio element has current data (the caller's gate).
    if (typeof window.requestIdleCallback === 'function') idleHandle = window.requestIdleCallback(makePeaks, { timeout: 5000 });
    else timeoutHandle = setTimeout(makePeaks, 50);
    return () => {
      live = false;
      if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    };
  }, [sourceUrl, mimeType]);
  return peaks;
}

export function BrowserMediaPlayer({
  captionPlacement = 'below-picture',
  autoPlay = false,
  preload = 'auto',
  releaseUnplayedSourceWhenIdle = false,
  playbackRanges,
  completionActions,
  media,
  onPause,
  onPlay,
  onSelectTranscript,
  onTranscriptVisibleChange,
  onTimeChange,
  seekRequest,
  sourceUrl,
  timedTextSegments,
  transcriptPlacement,
  transcriptVisible,
  type,
}: BrowserMediaPlayerProps) {
  const mediaRef = React.useRef<BrowserMediaElement | null>(null);
  const [activatedSource, setActivatedSource] = React.useState<string | null>(null);
  const [sourceFailed, setSourceFailed] = React.useState(false);
  const automaticRetry = React.useRef<{ source: string; used: boolean; timer: ReturnType<typeof setTimeout> | null }>({ source: sourceUrl, used: false, timer: null });
  const manualPlay = React.useRef(false);
  const hasPlayed = React.useRef(false);
  const playAttempt = React.useRef(0);
  const seekIntent = React.useRef({ sequence: 0, seconds: 0 });
  const pendingResume = React.useRef<{ element: BrowserMediaElement; source: string; mediaId: string; seconds: number } | null>(null);
  const sourceAttached = !releaseUnplayedSourceWhenIdle || preload !== 'none' || activatedSource === sourceUrl;
  React.useLayoutEffect(() => {
    const retry = automaticRetry.current;
    if (retry.timer) clearTimeout(retry.timer);
    automaticRetry.current = { source: sourceUrl, used: false, timer: null };
    hasPlayed.current = false;
    manualPlay.current = false;
    pendingResume.current = null;
    playAttempt.current += 1;
    setSourceFailed(false);
    return () => {
      const pending = automaticRetry.current.timer;
      if (pending) clearTimeout(pending);
      pendingResume.current = null;
      playAttempt.current += 1;
      manualPlay.current = false;
    };
  }, [sourceUrl, media.id]);
  React.useEffect(() => {
    if (preload !== 'none' || activatedSource === sourceUrl) return;
    const retry = automaticRetry.current;
    if (retry.timer) { clearTimeout(retry.timer); retry.timer = null; }
  }, [preload, activatedSource, sourceUrl]);
  React.useLayoutEffect(() => {
    const element = mediaRef.current;
    if (releaseUnplayedSourceWhenIdle && !sourceAttached && element && element.networkState !== HTMLMediaElement.NETWORK_EMPTY) {
      // Changing preload alone does not stop Chromium from requesting later ranges.
      // The rendered src is gone first; load() now aborts without starting another read.
      element.load();
    }
  }, [releaseUnplayedSourceWhenIdle, sourceAttached, sourceUrl]);
  const rangeIndex=React.useRef(0);
  const ranges=playbackRanges?.length&&playbackRanges.every(range=>Number.isFinite(range.start)&&Number.isFinite(range.end)&&range.start>=0&&range.end>range.start)?playbackRanges:undefined;
  React.useLayoutEffect(()=>{rangeIndex.current=0;const element=mediaRef.current;if(element&&ranges){playAttempt.current++;manualPlay.current=false;seekIntent.current={sequence:seekIntent.current.sequence+1,seconds:ranges[0].start};if(pendingResume.current?.element===element)pendingResume.current.seconds=ranges[0].start;element.pause();element.currentTime=ranges[0].start;}},[playbackRanges]);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [videoRatio, setVideoRatio] = React.useState(16 / 9);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [isMuted, setIsMuted] = React.useState(autoPlay);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [endedMediaId, setEndedMediaId] = React.useState<string | null>(null);
  const [controlPortalContainer, setControlPortalContainer] = React.useState<HTMLDivElement | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = React.useState(1);
  const [progress, setProgress] = React.useState(0);
  const [showCaptions, setShowCaptions] = React.useState(false);
  const [showControls, setShowControls] = React.useState(false);
  // A sound shows its words under it from the start; a video's reader opens when asked.
  const [uncontrolledTranscriptVisible, setUncontrolledTranscriptVisible] = React.useState(type === 'audio');
  const [audioReadySource, setAudioReadySource] = React.useState<string | null>(null);
  const peaks = useSoundPeaks(type === 'audio' && audioReadySource === sourceUrl ? sourceUrl : null, media.mime_type);
  const [volume, setVolume] = React.useState(100);
  const showTranscript = transcriptVisible ?? uncontrolledTranscriptVisible;
  const hasTimedText = Boolean(timedTextSegments?.length);
  const hasEnded = endedMediaId === media.id;
  const controlsVisible = showControls || !isPlaying;

  const setWrapperElement = React.useCallback((element: HTMLDivElement | null) => {
    wrapperRef.current = element;
    setControlPortalContainer(element);
  }, []);

  React.useEffect(() => {
    function updateFullscreenState() {
      setIsFullscreen(currentFullscreenElement() === wrapperRef.current);
    }

    document.addEventListener('fullscreenchange', updateFullscreenState);
    document.addEventListener('webkitfullscreenchange', updateFullscreenState);
    return () => {
      document.removeEventListener('fullscreenchange', updateFullscreenState);
      document.removeEventListener('webkitfullscreenchange', updateFullscreenState);
    };
  }, []);

  React.useEffect(() => {
    const element = mediaRef.current;
    if (!element || !seekRequest) return;
    if(ranges){const index=ranges.findIndex(range=>seekRequest.seconds>=range.start&&seekRequest.seconds<range.end);if(index>=0)rangeIndex.current=index;}
    seekToSeconds(seekRequest.seconds);
  }, [seekRequest?.requestId]);

  React.useLayoutEffect(() => {
    setEndedMediaId(null);
    setCurrentTime(0);
    setDuration(0);
    setProgress(0);
  }, [media.id, sourceUrl]);

  function restoreResume(element: BrowserMediaElement) {
    const pending = pendingResume.current;
    if (!pending) return true;
    if (pending.element !== element || pending.source !== sourceUrl || pending.mediaId !== media.id) {
      pendingResume.current = null; return true;
    }
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) return false;
    try {
      element.currentTime = Number.isFinite(element.duration)
        ? Math.min(pending.seconds, Math.max(0, element.duration)) : pending.seconds;
      pendingResume.current = null;
      return true;
    } catch { return false; }
  }

  function recoveredFrame(element: BrowserMediaElement) {
    if (element !== mediaRef.current || element.error || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    setSourceFailed(false);
  }

  function refreshTiming(element: BrowserMediaElement) {
    // load() emits a temporary zero before metadata. Keep the viewer at the
    // retained position until this same source can seek there again.
    if (!restoreResume(element)) return;
    const range=ranges?.[rangeIndex.current];
    if(range&&!element.paused&&!element.seeking){
      if(element.currentTime>=range.end){const next=ranges?.[rangeIndex.current+1];if(next){rangeIndex.current++;element.currentTime=next.start;}else{element.pause();element.currentTime=range.end;setEndedMediaId(media.id);}}
      else if(element.currentTime<range.start)element.currentTime=range.start;
    }
    const nextDuration = Number.isFinite(element.duration) ? element.duration : 0;
    const nextTime = Number.isFinite(element.currentTime) ? element.currentTime : 0;
    setCurrentTime(nextTime);
    setDuration(nextDuration);
    setProgress(nextDuration > 0 ? (nextTime / nextDuration) * 100 : 0);
    void onTimeChange?.(nextTime, nextDuration);
  }

  function setAudioElement(element: HTMLAudioElement | null) {
    mediaRef.current = element;
  }

  function setVideoElement(element: HTMLVideoElement | null) {
    mediaRef.current = element;
  }

  async function playElement(element: BrowserMediaElement) {
    const retry = automaticRetry.current;
    if (retry.timer) { clearTimeout(retry.timer); retry.timer = null; }
    retry.used = true;
    const attemptId = ++playAttempt.current;
    const seekSequence = seekIntent.current.sequence;
    const resumeSeconds = pendingResume.current?.seconds ?? (Number.isFinite(element.currentTime) ? Math.max(0, element.currentTime) : 0);
    manualPlay.current = true;
    if (!element.getAttribute('src')) element.src = sourceUrl;
    setActivatedSource(sourceUrl);
    // A failed byte request leaves the browser in NETWORK_NO_SOURCE. A viewer's
    // first Play may encounter that failure while it is already in flight.
    // Retry that one failed source selection once; further failures leave the
    // existing Play control available without a background request loop.
    let played = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attemptId !== playAttempt.current || mediaRef.current !== element) return;
      if (element.error) {
        const seconds = pendingResume.current?.seconds ?? (seekIntent.current.sequence !== seekSequence
          ? seekIntent.current.seconds : element.currentTime > 0 ? element.currentTime : resumeSeconds);
        if (seconds > 0) pendingResume.current = { element, source: sourceUrl, mediaId: media.id, seconds };
        element.load();
      }
      try {
        await element.play();
        played = true;
        break;
      } catch {
        if (attempt === 0 && element.error) continue;
        break;
      }
    }
    if (attemptId !== playAttempt.current || mediaRef.current !== element) return;
    manualPlay.current = false;
    if (!played) { setIsPlaying(false); return; }
    hasPlayed.current = true;
    setSourceFailed(false);
    setIsPlaying(true);
    await onPlay?.();
  }

  async function togglePlay() {
    const element = mediaRef.current;
    if (!element) return;
    if (element.paused) {
      setEndedMediaId(null);
      await playElement(element);
      return;
    }
    element.pause();
    setIsPlaying(false);
    await onPause?.();
  }

  function seekToSeconds(seconds: number) {
    const element = mediaRef.current;
    if (!element) return;
    const next = Math.max(0, seconds);
    seekIntent.current = { sequence: seekIntent.current.sequence + 1, seconds: next };
    if (pendingResume.current?.element === element) pendingResume.current.seconds = next;
    element.currentTime = next;
    setEndedMediaId(null);
    refreshTiming(element);
  }

  function seekByProgress(value: number) {
    const element = mediaRef.current;
    if (!element || !Number.isFinite(element.duration)) return;
    const next = (Math.min(Math.max(value, 0), 100) / 100) * element.duration;
    seekIntent.current = { sequence: seekIntent.current.sequence + 1, seconds: next };
    if (pendingResume.current?.element === element) pendingResume.current.seconds = next;
    element.currentTime = next;
    setEndedMediaId(null);
    refreshTiming(element);
  }

  async function restartPlayback() {
    const element = mediaRef.current;
    if (!element) return;
    pendingResume.current = null;
    rangeIndex.current = 0;
    const start = ranges?.[0].start ?? 0;
    seekIntent.current = { sequence: seekIntent.current.sequence + 1, seconds: start };
    element.currentTime = start;
    setEndedMediaId(null);
    refreshTiming(element);
    await playElement(element);
  }

  function changeVolume(value: number) {
    const element = mediaRef.current;
    if (!element) return;
    const nextVolume = Math.min(Math.max(value, 0), 100);
    element.volume = nextVolume / 100;
    element.muted = nextVolume === 0;
    setVolume(nextVolume);
    setIsMuted(element.muted);
  }

  function toggleMute() {
    const element = mediaRef.current;
    if (!element) return;
    element.muted = !element.muted;
    setIsMuted(element.muted);
    if (!element.muted && element.volume === 0) {
      element.volume = 1;
      setVolume(100);
    }
  }

  function changeSpeed(speed: number) {
    const element = mediaRef.current;
    if (!element) return;
    const boundedSpeed = clampPlaybackSpeed(speed, BROWSER_MIN_PLAYBACK_SPEED, BROWSER_MAX_PLAYBACK_SPEED);
    element.playbackRate = boundedSpeed;
    setPlaybackSpeed(boundedSpeed);
  }

  async function toggleFullscreen() {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    await togglePlayerFullscreen(wrapper);
  }

  async function toggleTranscript() {
    const nextVisible = !showTranscript;
    if (transcriptVisible === undefined) setUncontrolledTranscriptVisible(nextVisible);
    await onTranscriptVisibleChange?.(nextVisible);
    await onSelectTranscript?.(nextVisible);
  }

  const mediaProps = {
    className: type === 'audio'
      ? 'hidden'
      : 'absolute inset-0 h-full w-full object-contain bg-black',
    onClick: (event: React.MouseEvent<BrowserMediaElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void togglePlay();
    },
    onLoadedMetadata: (event: React.SyntheticEvent<BrowserMediaElement>) => {const element=event.currentTarget;if(element instanceof HTMLVideoElement&&element.videoWidth&&element.videoHeight)setVideoRatio(element.videoWidth/element.videoHeight);refreshTiming(element);},
    onLoadedData: (event: React.SyntheticEvent<BrowserMediaElement>) => {
      recoveredFrame(event.currentTarget);
      if (event.currentTarget instanceof HTMLAudioElement) setAudioReadySource(sourceUrl);
    },
    onCanPlay: (event: React.SyntheticEvent<BrowserMediaElement>) => recoveredFrame(event.currentTarget),
    onPlaying: (event: React.SyntheticEvent<BrowserMediaElement>) => {
      recoveredFrame(event.currentTarget);
      if (!event.currentTarget.error && !event.currentTarget.paused && event.currentTarget.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        hasPlayed.current = true; setIsPlaying(true);
      }
    },
    onEnded: (event: React.SyntheticEvent<BrowserMediaElement>) => {
      const next=ranges?.[rangeIndex.current+1];if(next){rangeIndex.current++;event.currentTarget.currentTime=next.start;void event.currentTarget.play().catch(()=>setIsPlaying(false));return;}
      setIsPlaying(false);
      setEndedMediaId(media.id);
      refreshTiming(event.currentTarget);
    },
    onPause: () => setIsPlaying(false),
    onError: (event: React.SyntheticEvent<BrowserMediaElement>) => {
      setIsPlaying(false);
      setSourceFailed(true);
      const element = event.currentTarget;
      const retry = automaticRetry.current;
      // Recover one failed metadata warm without a click. A normal Play already
      // has its own bounded retry; a second automatic failure waits for the viewer.
      if (manualPlay.current || hasPlayed.current || retry.source !== sourceUrl || retry.used
        || !element.getAttribute('src') || element.preload === 'none') return;
      retry.used = true;
      retry.timer = setTimeout(() => {
        retry.timer = null;
        if (mediaRef.current !== element || !element.getAttribute('src') || element.preload === 'none') return;
        element.load();
      }, 700);
    },
    onPlay: () => {setActivatedSource(sourceUrl);const element=mediaRef.current;if(element&&ranges){const range=ranges[rangeIndex.current];if(element.currentTime>=range.end){rangeIndex.current=0;element.currentTime=ranges[0].start;}}setIsPlaying(true);},
    onTimeUpdate: (event: React.SyntheticEvent<BrowserMediaElement>) => refreshTiming(event.currentTarget),
    // A streamed recording can learn its length after its first frame; the bar follows it.
    onDurationChange: (event: React.SyntheticEvent<BrowserMediaElement>) => refreshTiming(event.currentTarget),
    preload,
    playsInline: true,
    autoPlay,
    muted: autoPlay,
    src: sourceAttached ? sourceUrl : undefined,
    poster: type === 'video' ? media.poster_url : undefined,
  };

  if (type === 'audio') {
    // A sound's own face: no picture box and nothing to fill a screen with. The same controls drawn for a page
    // surface, the waveform as the seek bar, and the words under it when the sound has them.
    return (
      <div
        aria-label={media.label ?? undefined}
        className="relative flex min-h-0 w-full flex-col gap-4 rounded-2xl border border-input bg-card p-4 text-foreground shadow-xs sm:p-5"
        data-media-playback-browser-source={media.id}
        data-media-playback-kind="audio"
        onClick={(event) => event.stopPropagation()}
        ref={setWrapperElement}
        role="group"
      >
        <audio {...mediaProps} ref={setAudioElement} />
        <PlaybackControls
          currentTime={currentTime}
          duration={duration}
          isMuted={isMuted}
          isPlaying={isPlaying}
          look="sound"
          maxPlaybackSpeed={BROWSER_MAX_PLAYBACK_SPEED}
          minPlaybackSpeed={BROWSER_MIN_PLAYBACK_SPEED}
          onSeek={seekByProgress}
          onSpeedChange={changeSpeed}
          onToggleMute={toggleMute}
          onTogglePlay={() => void togglePlay()}
          onToggleTranscript={hasTimedText && transcriptPlacement !== 'beside-media' ? () => void toggleTranscript() : undefined}
          onVolumeChange={changeVolume}
          peaks={peaks}
          playbackSpeed={playbackSpeed}
          popoverContainer={controlPortalContainer}
          progress={progress}
          showControls
          showTranscript={showTranscript}
          volume={volume}
        />
        <FullscreenTimedTextOverlay
          currentTime={currentTime}
          layout="under-sound"
          onSeek={seekToSeconds}
          segments={timedTextSegments}
          title={media.label ?? 'Transcript'}
          visible={showTranscript && transcriptPlacement !== 'beside-media'}
        />
        <PlaybackCompletionOverlay
          actions={completionActions}
          onRestart={restartPlayback}
          title={`${media.label ?? 'Media'} finished`}
          visible={hasEnded && Boolean(completionActions?.length)}
        />
      </div>
    );
  }

  return (
    <div
      aria-label={media.label ?? undefined}
      className={captionReaderLook.videoPlayer}
      data-media-playback-browser-source={media.id}
      data-media-playback-kind={type}
      style={{'--media-aspect':videoRatio} as React.CSSProperties}
      onFocus={() => setShowControls(true)}
      onClick={(event) => event.stopPropagation()}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
      ref={setWrapperElement}
      role="group"
    >
      <div className={captionReaderLook.picture} style={{ aspectRatio: videoRatio }} data-media-picture>
        {/* The custom controls provide the accessible playback surface. An idle
            video with no src can otherwise be announced as failed media by the
            browser even while its poster and Play action are usable. */}
        <video {...mediaProps} disablePictureInPicture={!controlShown(PICTURE_IN_PICTURE_CONTROL)} aria-hidden="true" ref={setVideoElement} style={sourceFailed ? { visibility: 'hidden' } : undefined} />
        {!isPlaying && !hasEnded ? (
          <button
            aria-label={sourceFailed ? 'Try video again' : 'Play video'}
            title={sourceFailed ? 'Try video again' : undefined}
            className="absolute inset-0 z-30 flex h-full w-full items-center justify-center bg-transparent focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); void togglePlay(); }}
            type="button"
          >
            <PlayDisc />
          </button>
        ) : null}
        {showCaptions && captionPlacement === 'over-picture' ? <TimedTextCaptionOverlay controlsVisible={controlsVisible} currentTime={currentTime} onSeek={seekToSeconds} segments={timedTextSegments} storageScope={media.id} /> : null}
        <PlaybackCompletionOverlay
          actions={completionActions}
          onRestart={restartPlayback}
          title={`${media.label ?? 'Media'} finished`}
          visible={hasEnded}
        />
        <PlaybackControls
          currentTime={currentTime}
          duration={duration}
          isFullscreen={isFullscreen}
          isMuted={isMuted}
          isPlaying={isPlaying}
          onSeek={seekByProgress}
          onSpeedChange={changeSpeed}
          maxPlaybackSpeed={BROWSER_MAX_PLAYBACK_SPEED}
          minPlaybackSpeed={BROWSER_MIN_PLAYBACK_SPEED}
          onToggleCaptions={hasTimedText ? () => setShowCaptions((value) => !value) : undefined}
          onToggleFullscreen={toggleFullscreen}
          onToggleMute={toggleMute}
          onTogglePlay={() => void togglePlay()}
          onToggleTranscript={media.transcript_ref && hasTimedText ? () => void toggleTranscript() : undefined}
          onVolumeChange={changeVolume}
          playbackSpeed={playbackSpeed}
          popoverContainer={controlPortalContainer}
          progress={progress}
          showCaptions={showCaptions}
          showControls={controlsVisible}
          showTranscript={showTranscript}
          volume={volume}
        />
      </div>
      <FullscreenTimedTextOverlay
        currentTime={currentTime}
        onSeek={seekToSeconds}
        segments={timedTextSegments}
        title={media.label ?? 'Transcript'}
        visible={showTranscript && (transcriptPlacement !== 'beside-media' || isFullscreen)}
      />
      {showCaptions && captionPlacement === 'below-picture' ? <TimedTextCaptionOverlay placement="below-picture" controlsVisible={controlsVisible} currentTime={currentTime} onSeek={seekToSeconds} segments={timedTextSegments} storageScope={media.id} /> : null}
    </div>
  );
}

type ControlledEmbedPlayerProps = {
  completionActions?: readonly MediaPlaybackCompletionAction[];
  media: MediaSourceRecord;
  onTimeChange?: (currentTime: number, duration: number) => void | Promise<void>;
  onPause?: () => void | Promise<void>;
  onPlay?: () => void | Promise<void>;
  onSelectTranscript?: (visible?: boolean) => void | Promise<void>;
  onTranscriptVisibleChange?: (visible: boolean) => void | Promise<void>;
  previewLimitSeconds?: number;
  onPreviewLimit?: () => void;
  seekRequest?: MediaPlaybackSeekRequest | null;
  sourceUrl: string;
  timedTextSegments?: readonly TimedTextSegment[];
  transcriptVisible?: boolean;
  /** Where the host shows the transcript. `beside-media` means the host renders its own
   * transcript reader next to the player, so the in-player panel appears only in fullscreen. */
  transcriptPlacement?: TranscriptPlacement;
};

function ControlledEmbedPlayer({
  completionActions,
  media,
  onPause,
  onPlay,
  onSelectTranscript,
  onTranscriptVisibleChange,
  onTimeChange,
  previewLimitSeconds,
  onPreviewLimit,
  seekRequest,
  sourceUrl,
  timedTextSegments,
  transcriptPlacement,
  transcriptVisible,
}: ControlledEmbedPlayerProps) {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const playerHostRef = React.useRef<HTMLDivElement | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const currentTimeRef = React.useRef(0);
  const durationRef = React.useRef(0);
  const isPlayingRef = React.useRef(false);
  const onTimeChangeRef = React.useRef(onTimeChange);
  const pendingYouTubePlayRef = React.useRef(false);
  const youTubePlayerRef = React.useRef<YouTubePlayerHandle | null>(null);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [isMuted, setIsMuted] = React.useState(false);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [endedMediaId, setEndedMediaId] = React.useState<string | null>(null);
  const [controlPortalContainer, setControlPortalContainer] = React.useState<HTMLDivElement | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = React.useState(1);
  const [progress, setProgress] = React.useState(0);
  const [showCaptions, setShowCaptions] = React.useState(false);
  const [showControls, setShowControls] = React.useState(true);
  const [uncontrolledTranscriptVisible, setUncontrolledTranscriptVisible] = React.useState(false);
  const [volume, setVolume] = React.useState(100);
  const [hasStarted, setHasStarted] = React.useState(false);
  const controlledSourceUrl = embedUrlWithControlParams(sourceUrl, media.embed_control, media.source_kind);
  const controlledSourceOrigin = embedSourceOrigin(sourceUrl, media.embed_control, media.source_kind);
  const controlledYouTubeVideoId = youtubeVideoId(controlledSourceUrl);
  const posterUrl = embedPosterUrl(controlledSourceUrl);
  const showTranscript = transcriptVisible ?? uncontrolledTranscriptVisible;
  const hasTimedText = Boolean(timedTextSegments?.length);
  const hasEnded = endedMediaId === media.id;

  const setWrapperElement = React.useCallback((element: HTMLDivElement | null) => {
    wrapperRef.current = element;
    setControlPortalContainer(element);
  }, []);

  React.useEffect(() => {
    onTimeChangeRef.current = onTimeChange;
  }, [onTimeChange]);

  const previewLimitRef = React.useRef(previewLimitSeconds);
  const onPreviewLimitRef = React.useRef(onPreviewLimit);
  const previewReachedRef = React.useRef(false);
  React.useEffect(() => { previewLimitRef.current = previewLimitSeconds; }, [previewLimitSeconds]);
  React.useEffect(() => { onPreviewLimitRef.current = onPreviewLimit; }, [onPreviewLimit]);

  const publishTiming = React.useCallback((nextTime: number, nextDuration: number) => {
    const boundedDuration = Number.isFinite(nextDuration) && nextDuration > 0 ? nextDuration : 0;
    let boundedTime = Number.isFinite(nextTime) && nextTime > 0
      ? boundedDuration > 0 ? Math.min(nextTime, boundedDuration) : nextTime
      : 0;
    // Preview cap: the instant playback reaches the limit, pause and clamp the
    // reported time to the limit so the scrubber never advances past the gate.
    const limit = previewLimitRef.current;
    if (typeof limit === 'number' && limit > 0 && boundedTime >= limit) {
      boundedTime = limit;
      const player = youTubePlayerRef.current;
      if (player) { player.pauseVideo(); }
      if (!previewReachedRef.current) {
        previewReachedRef.current = true;
        onPreviewLimitRef.current?.();
      }
    }
    currentTimeRef.current = boundedTime;
    durationRef.current = boundedDuration;
    setCurrentTime(boundedTime);
    setDuration(boundedDuration);
    setProgress(boundedDuration > 0 ? (boundedTime / boundedDuration) * 100 : 0);
    void onTimeChangeRef.current?.(boundedTime, boundedDuration);
  }, []);

  function setStarted(nextStarted: boolean) {
    setHasStarted(nextStarted);
  }

  function setPlaying(nextPlaying: boolean) {
    isPlayingRef.current = nextPlaying;
    setIsPlaying(nextPlaying);
  }

  function applyEmbedCommand(command: string, input: Record<string, unknown> = {}) {
    const player = youTubePlayerRef.current;
    if (controlledYouTubeVideoId && !player) {
      if (command === 'play') pendingYouTubePlayRef.current = true;
      return false;
    }
    if (controlledYouTubeVideoId && player) {
      if (command === 'play') player.playVideo();
      if (command === 'pause') player.pauseVideo();
      if (command === 'seekTo' && typeof input.seconds === 'number') player.seekTo(input.seconds, true);
      if (command === 'setVolume' && typeof input.volume === 'number') player.setVolume(input.volume);
      if (command === 'mute') player.mute();
      if (command === 'unmute') player.unMute();
      if (command === 'setPlaybackRate' && typeof input.speed === 'number') player.setPlaybackRate(input.speed);
      return true;
    }
    return postEmbedCommand(frameRef.current, media.embed_control, command, input);
  }

  React.useEffect(() => {
    if (!controlledYouTubeVideoId) return undefined;
    let cancelled = false;
    let constructedPlayer: YouTubePlayerHandle | null = null;

    const cancelLoad = loadYouTubeIframeApi(() => {
      const host = playerHostRef.current;
      if (cancelled || !host || youTubePlayerRef.current || !window.YT?.Player) return;

      // YT.Player REPLACES the element it is given. The host div is owned by
      // React, so it must never be handed to the API directly — replacing a
      // React-owned node corrupts the virtual-DOM tree and the next render
      // crashes the whole surface (dead buttons, frozen timing). Hand the API
      // a throwaway child node that React never rendered instead.
      const playerMount = document.createElement('div');
      playerMount.className = 'h-full w-full';
      host.replaceChildren(playerMount);

      const player = new window.YT.Player(playerMount, {
        height: '100%',
        host: YOUTUBE_EMBED_ORIGIN,
        playerVars: youtubePlayerVars(media.embed_control, controlledYouTubeVideoId),
        videoId: controlledYouTubeVideoId,
        width: '100%',
        events: {
          onReady: (event) => {
            if (cancelled) return;
            const readyPlayer = event.target ?? player;
            if (!isYouTubePlayerHandle(readyPlayer)) return;
            youTubePlayerRef.current = readyPlayer;
            // Force YouTube's native captions OFF — the surface has its own caption
            // reader. cc_load_policy:0 only suppresses AUTO-show; a viewer whose
            // YouTube account forces "always show captions" still gets them unless we
            // unload the module here. Both module ids are tried across API versions;
            // the calls are optional-chained so an older player without them no-ops.
            readyPlayer.unloadModule?.('captions');
            readyPlayer.unloadModule?.('cc');
            readyPlayer.setVolume(volume);
            if (isMuted) readyPlayer.mute();
            publishTiming(readyPlayer.getCurrentTime(), readyPlayer.getDuration());
            if (pendingYouTubePlayRef.current || isPlayingRef.current) {
              pendingYouTubePlayRef.current = false;
              readyPlayer.playVideo();
            }
          },
          onStateChange: (event) => {
            if (cancelled) return;
            const activePlayer = event.target ?? youTubePlayerRef.current;
            const state = event.data;
            if (state === window.YT?.PlayerState?.PLAYING || state === 1) {
              setStarted(true);
              setEndedMediaId(null);
              setPlaying(true);
            }
            if (state === window.YT?.PlayerState?.PAUSED || state === 2) setPlaying(false);
            if (state === window.YT?.PlayerState?.ENDED || state === 0) {
              setPlaying(false);
              setEndedMediaId(media.id);
            }
            if (isYouTubePlayerHandle(activePlayer)) {
              publishTiming(activePlayer.getCurrentTime(), activePlayer.getDuration());
            }
          },
        },
      });
      if (isYouTubePlayerHandle(player)) constructedPlayer = player;
    });

    return () => {
      cancelled = true;
      cancelLoad();
      const player = youTubePlayerRef.current ?? constructedPlayer;
      youTubePlayerRef.current = null;
      pendingYouTubePlayRef.current = false;
      if (isYouTubePlayerHandle(player)) player.destroy();
      // Clear the throwaway mount so a re-run of this effect starts clean.
      playerHostRef.current?.replaceChildren();
    };
  }, [controlledYouTubeVideoId, controlledSourceUrl, media.embed_control, media.id, publishTiming]);

  React.useEffect(() => {
    function updateFullscreenState() {
      setIsFullscreen(currentFullscreenElement() === wrapperRef.current);
    }

    document.addEventListener('fullscreenchange', updateFullscreenState);
    document.addEventListener('webkitfullscreenchange', updateFullscreenState);
    return () => {
      document.removeEventListener('fullscreenchange', updateFullscreenState);
      document.removeEventListener('webkitfullscreenchange', updateFullscreenState);
    };
  }, []);

  React.useEffect(() => {
    if (controlledYouTubeVideoId) return undefined;

    function acceptEmbedMessage(event: MessageEvent) {
      const sourceWindow = frameRef.current?.contentWindow ?? null;
      if (event.source && sourceWindow && event.source !== sourceWindow) return;
      if (!event.origin || (
        media.embed_control?.target_origin
        && event.origin !== media.embed_control.target_origin
        && event.origin !== controlledSourceOrigin
      )) return;

      let payload: unknown = event.data;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload) as unknown;
        } catch {
          return;
        }
      }
      if (!payload || typeof payload !== 'object') return;
      const record = payload as Record<string, unknown>;
      if (record.event !== 'infoDelivery' || !record.info || typeof record.info !== 'object') return;
      const info = record.info as Record<string, unknown>;
      const nextTime = typeof info.currentTime === 'number' && Number.isFinite(info.currentTime)
        ? info.currentTime
        : currentTimeRef.current;
      const nextDuration = typeof info.duration === 'number' && Number.isFinite(info.duration)
        ? info.duration
        : durationRef.current;
      if (typeof info.playerState === 'number') {
        const nextPlaying = info.playerState === 1;
        setPlaying(nextPlaying);
        if (info.playerState === 1) {
          setStarted(true);
          setEndedMediaId(null);
        }
        if (info.playerState === 0) setEndedMediaId(media.id);
      }
      publishTiming(nextTime, nextDuration);
    }

    window.addEventListener('message', acceptEmbedMessage);
    return () => window.removeEventListener('message', acceptEmbedMessage);
  }, [controlledSourceOrigin, controlledYouTubeVideoId, media.embed_control?.target_origin, media.id, publishTiming]);

  React.useEffect(() => {
    if (controlledYouTubeVideoId) {
      const interval = window.setInterval(() => {
        const player = youTubePlayerRef.current;
        if (!isYouTubePlayerHandle(player)) return;
        const playerState = player.getPlayerState?.();
        if (typeof playerState === 'number') {
          if (playerState === 1) {
            setStarted(true);
            setEndedMediaId(null);
            setPlaying(true);
          }
          if (playerState === 2) setPlaying(false);
          if (playerState === 0) {
            setPlaying(false);
            setEndedMediaId(media.id);
          }
        }
        publishTiming(player.getCurrentTime(), player.getDuration());
      }, isPlaying ? 100 : 500);
      return () => window.clearInterval(interval);
    }

    const interval = window.setInterval(() => {
      postEmbedCommand(frameRef.current, media.embed_control, 'getCurrentTime');
      postEmbedCommand(frameRef.current, media.embed_control, 'getDuration');
    }, isPlaying ? 100 : 500);
    return () => window.clearInterval(interval);
  }, [controlledYouTubeVideoId, isPlaying, media.embed_control, media.id, publishTiming]);

  React.useEffect(() => {
    if (!seekRequest) return;
    seekToSeconds(seekRequest.seconds);
  }, [seekRequest?.requestId]);

  React.useEffect(() => {
    setEndedMediaId(null);
    publishTiming(0, 0);
  }, [controlledSourceUrl, media.id, publishTiming]);

  function seekToSeconds(nextSeconds: number) {
    const limit = previewLimitRef.current;
    const ceiling = typeof limit === 'number' && limit > 0 ? limit : Infinity;
    const seconds = Math.min(Math.max(0, nextSeconds), ceiling);
    setStarted(true);
    setEndedMediaId(null);
    publishTiming(seconds, durationRef.current);
    applyEmbedCommand('seekTo', { seconds });
  }

  function seekByProgress(value: number) {
    if (duration <= 0) return;
    const boundedValue = Math.min(Math.max(value, 0), 100);
    const seconds = (boundedValue / 100) * duration;
    seekToSeconds(seconds);
  }

  async function togglePlay() {
    if (isPlaying) {
      applyEmbedCommand('pause');
      setPlaying(false);
      await onPause?.();
      return;
    }
    setStarted(true);
    setEndedMediaId(null);
    applyEmbedCommand('play');
    setPlaying(true);
    await onPlay?.();
  }

  function handleSurfaceClick(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePosterClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    void togglePlay();
  }

  async function restartPlayback() {
    seekToSeconds(0);
    setStarted(true);
    setEndedMediaId(null);
    applyEmbedCommand('play');
    setPlaying(true);
    await onPlay?.();
  }

  function changeVolume(value: number) {
    const nextVolume = Math.min(Math.max(value, 0), 100);
    setVolume(nextVolume);
    setIsMuted(nextVolume === 0);
    applyEmbedCommand('setVolume', { volume: nextVolume });
  }

  function toggleMute() {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    applyEmbedCommand(nextMuted ? 'mute' : 'unmute');
  }

  function changeSpeed(speed: number) {
    const boundedSpeed = clampPlaybackSpeed(speed, EMBEDDED_MIN_PLAYBACK_SPEED, EMBEDDED_MAX_PLAYBACK_SPEED);
    setPlaybackSpeed(boundedSpeed);
    applyEmbedCommand('setPlaybackRate', { speed: boundedSpeed });
  }

  async function toggleFullscreen() {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    await togglePlayerFullscreen(wrapper);
  }

  async function toggleTranscript() {
    const nextVisible = !showTranscript;
    if (transcriptVisible === undefined) setUncontrolledTranscriptVisible(nextVisible);
    await onTranscriptVisibleChange?.(nextVisible);
    await onSelectTranscript?.(nextVisible);
  }

  return (
    <div
      className="relative aspect-video overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-black shadow-[0_0_20px_rgba(0,0,0,0.2)]"
      data-material-embed={media.id}
      data-media-embed-controls={media.id}
      data-media-embed-control-ref={media.embed_control_ref ?? ''}
      onFocus={() => setShowControls(true)}
      onClick={handleSurfaceClick}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
      ref={setWrapperElement}
    >
      {controlledYouTubeVideoId ? (
        <div
          aria-label={media.label ?? media.id}
          className={['pointer-events-none h-full w-full bg-black transition-opacity duration-300', posterUrl && !hasStarted ? 'opacity-0' : 'opacity-100'].join(' ')}
          data-media-playback-embed={media.id}
          ref={playerHostRef}
        />
      ) : (
        <iframe
          allow={embedAllows()}
          allowFullScreen
          className={['h-full w-full bg-black transition-opacity duration-300', posterUrl && !hasStarted ? 'opacity-0' : 'opacity-100'].join(' ')}
          data-media-playback-embed={media.id}
          loading="lazy"
          ref={frameRef}
          referrerPolicy="strict-origin-when-cross-origin"
          src={controlledSourceUrl}
          title={media.label ?? media.id}
          onLoad={() => {
            postEmbedCommand(frameRef.current, media.embed_control, 'getDuration');
            postEmbedCommand(frameRef.current, media.embed_control, 'getCurrentTime');
            if (hasStarted) postEmbedCommand(frameRef.current, media.embed_control, 'play');
          }}
        />
      )}
      {posterUrl && !hasStarted ? (
        <button
          aria-label={`Play ${media.label ?? 'media'}`}
          className="absolute inset-0 z-10 h-full w-full cursor-pointer overflow-hidden bg-black text-white"
          data-media-custom-poster={media.id}
          type="button"
          onClick={handlePosterClick}
        >
          <img
            alt=""
            className="h-full w-full object-cover opacity-90"
            draggable={false}
            src={posterUrl}
          />
          <span className="absolute inset-0 bg-black/10" aria-hidden="true" />
          <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
            <PlayDisc />
          </span>
        </button>
      ) : null}
      {hasStarted && !isPlaying && !hasEnded ? (
        <button
          aria-label={`Resume ${media.label ?? 'media'}`}
          className="absolute inset-0 z-10 flex h-full w-full items-center justify-center bg-transparent text-white"
          data-media-paused-overlay={media.id}
          type="button"
          onClick={handlePosterClick}
        >
          <PlayDisc />
        </button>
      ) : null}
      {showCaptions ? <TimedTextCaptionOverlay controlsVisible={showControls} currentTime={currentTime} onSeek={seekToSeconds} segments={timedTextSegments} storageScope={media.id} /> : null}
      <FullscreenTimedTextOverlay
        currentTime={currentTime}
        onSeek={seekToSeconds}
        segments={timedTextSegments}
        title={media.label ?? 'Transcript'}
        visible={showTranscript && (transcriptPlacement !== 'beside-media' || isFullscreen)}
      />
      <PlaybackCompletionOverlay
        actions={completionActions}
        onRestart={restartPlayback}
        title={`${media.label ?? 'Media'} finished`}
        visible={hasEnded}
      />
      <PlaybackControls
        currentTime={currentTime}
        duration={duration}
        isFullscreen={isFullscreen}
        isMuted={isMuted}
        isPlaying={isPlaying}
        onSeek={seekByProgress}
        onSpeedChange={changeSpeed}
        maxPlaybackSpeed={EMBEDDED_MAX_PLAYBACK_SPEED}
        minPlaybackSpeed={EMBEDDED_MIN_PLAYBACK_SPEED}
        onToggleCaptions={hasTimedText ? () => setShowCaptions((value) => !value) : undefined}
        onToggleFullscreen={toggleFullscreen}
        onToggleMute={toggleMute}
        onTogglePlay={() => void togglePlay()}
        onToggleTranscript={media.transcript_ref && hasTimedText ? () => void toggleTranscript() : undefined}
        onVolumeChange={changeVolume}
        playbackSpeed={playbackSpeed}
        popoverContainer={controlPortalContainer}
        progress={progress}
        showCaptions={showCaptions}
        showControls={showControls}
        showTranscript={showTranscript}
        volume={volume}
      />
    </div>
  );
}

function PrivateObjectGate({
  copy,
  delivery,
  media,
  onAction,
}: {
  copy?: Partial<PrivateObjectCopy>;
  delivery?: PrivateObjectReply | null | 'error';
  media: MediaSourceRecord;
  onAction?: (action: 'sign-in' | 'upgrade' | 'retry') => void;
}) {
  // Pure brain decides the ONE state + ONE action; this shell only paints it.
  const view = privateObjectView(delivery ?? null, copy);
  const control = privateObjectControl(view, copy);
  const title = media.label ?? media.file_name ?? null;
  return (
    <div
      className="mt-4 rounded-2xl border border-[var(--border-primary)] bg-black/20 p-5 text-sm text-[var(--text-secondary)]"
      data-material-delivery-request={media.id}
      data-material-delivery-target={media.delivery_target_ref ?? ''}
      data-material-file-name={media.file_name ?? ''}
      data-material-mime-type={media.mime_type ?? ''}
      data-material-object-key={media.object_key ?? ''}
      data-material-object-store={media.object_store_ref ?? ''}
      data-media-playback-private-source={media.id}
      data-media-private-state={control.kind}
    >
      {title ? <p className="font-semibold text-[var(--text-primary)]">{title}</p> : null}
      <div className="mt-2 flex items-center gap-2 leading-6">
        {control.busy ? <Spinner aria-hidden /> : null}
        <span>{control.message}</span>
      </div>
      {onAction && control.actionKind && control.actionLabel ? (
        <button
          className="mt-4 inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-[var(--text-primary)] transition hover:bg-white/15"
          data-media-private-action={control.actionKind}
          type="button"
          onClick={() => onAction(control.actionKind as 'sign-in' | 'upgrade' | 'retry')}
        >
          {control.actionLabel}
        </button>
      ) : null}
    </div>
  );
}

// WS-H input path (was missing — the player read `media` from surface input but
// nothing ever populated it, so it was permanently "Nothing to play yet"). This lets
// the user paste any embeddable link and play it. Detection is DATA-driven off the
// SAME EMBED_URL_BUILDERS registry that builds the embed URL: the first builder that
// yields an embed owns the link, so its key IS the source_kind. There are ZERO platform
// names in this function — adding a source (soundcloud, vimeo, …) is ONE EMBED_URL_BUILDERS
// entry, zero branching here (L090 / enum-dissolution). Anything no builder can embed
// falls back to a generic `video` source (still playable, no crash).
export function mediaFromPastedUrl(raw: string): MediaSourceRecord | null {
  const url = raw.trim();
  if (!url) return null;
  let source_kind = '';
  let embed_url: string | undefined;
  for (const [kind, builder] of Object.entries(EMBED_URL_BUILDERS)) {
    const built = builder(url) ?? undefined;
    if (built) { source_kind = kind; embed_url = built; break; }
  }
  return {
    id: url,
    label: url,
    source_url: url,
    source_kind: source_kind || 'video',
    ...(embed_url ? { embed_url } : {}),
  } as MediaSourceRecord;
}

function AddMediaEmptyState({ onAdd }: { onAdd: (m: MediaSourceRecord) => void }) {
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const submit = () => {
    const media = mediaFromPastedUrl(value);
    if (!media) {
      setError('Paste a link to play.');
      return;
    }
    setError(null);
    onAdd(media);
  };
  return (
    <div className="flex min-h-[200px] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-6 text-center">
      <div className="text-sm text-[var(--text-secondary)]">Paste a Spotify, Apple Music, or YouTube link to play it here.</div>
      <div className="flex w-full max-w-[420px] items-center gap-2">
        <input
          aria-label="Media link"
          className="min-w-0 flex-1 rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="https://open.spotify.com/…"
          value={value}
        />
        <button
          className="shrink-0 rounded-lg border border-[var(--border-primary)] bg-[var(--surface-raised,var(--surface))] px-4 py-2 text-sm text-[var(--text-primary)]"
          onClick={submit}
          type="button"
        >
          Play
        </button>
      </div>
      {error ? <div className="text-xs text-[var(--text-danger,#e5484d)]">{error}</div> : null}
    </div>
  );
}

export function MediaPlaybackSurface({
  captionPlacement,
  autoPlay,
  preload = 'auto',
  releaseUnplayedSourceWhenIdle,
  playbackRanges,
  allowEmbeddedDocument = false,
  completionActions,
  media: mediaProp,
  onTimeChange,
  onPause,
  onPlay,
  onSelectTranscript,
  onTranscriptVisibleChange,
  previewLimitSeconds,
  onPreviewLimit,
  privateDelivery,
  privateDeliveryCopy,
  onPrivateDeliveryAction,
  seekRequest,
  showFrameChrome = true,
  statusLabel,
  timedTextSegments,
  transcriptPlacement,
  transcriptVisible,
}: MediaPlaybackSurfaceProps) {
  // Media may come from surface input (mediaProp) OR from a link the user pastes here.
  const [addedMedia, setAddedMedia] = React.useState<MediaSourceRecord | null>(null);
  const media = mediaProp ?? addedMedia;
  if (!media) {
    return <AddMediaEmptyState onAdd={setAddedMedia} />;
  }
  const sourceUrl = playableUrl(media);
  const elementKind = sourceUrl ? mediaElementKind(media) : null;
  const usesControlledEmbed = Boolean(
    allowEmbeddedDocument
    && media.embed_url
    && (media.embed_control || hasEmbedUrlBuilder(media.embed_url, media.source_kind)),
  );
  const actions = [
    { label: 'Play', onSelect: onPlay },
    { label: 'Pause', onSelect: onPause },
    { label: 'Transcript', onSelect: onSelectTranscript, disabled: !media.transcript_ref },
  ];

  const player = sourceUrl && elementKind ? (
    <BrowserMediaPlayer
      captionPlacement={captionPlacement}
      autoPlay={autoPlay}
      preload={preload}
      releaseUnplayedSourceWhenIdle={releaseUnplayedSourceWhenIdle}
      playbackRanges={playbackRanges}
      completionActions={completionActions}
      media={media}
      onPause={onPause}
      onPlay={onPlay}
      onSelectTranscript={onSelectTranscript}
      onTranscriptVisibleChange={onTranscriptVisibleChange}
      onTimeChange={onTimeChange}
      seekRequest={seekRequest}
      sourceUrl={sourceUrl}
      timedTextSegments={timedTextSegments}
      transcriptPlacement={transcriptPlacement}
      transcriptVisible={transcriptVisible}
      type={elementKind}
    />
  ) : usesControlledEmbed && media.embed_url ? (
    <ControlledEmbedPlayer
      completionActions={completionActions}
      media={media}
      onPause={onPause}
      onPlay={onPlay}
      onSelectTranscript={onSelectTranscript}
      onTranscriptVisibleChange={onTranscriptVisibleChange}
      onTimeChange={onTimeChange}
      previewLimitSeconds={previewLimitSeconds}
      onPreviewLimit={onPreviewLimit}
      seekRequest={seekRequest}
      sourceUrl={media.embed_url}
      timedTextSegments={timedTextSegments}
      transcriptPlacement={transcriptPlacement}
      transcriptVisible={transcriptVisible}
    />
  ) : allowEmbeddedDocument && media.embed_url ? (
    <iframe
      className="mt-4 aspect-video w-full rounded-2xl border border-[var(--border-primary)] bg-black"
      data-material-embed={media.id}
      data-media-playback-embed={media.id}
      loading="lazy"
      referrerPolicy="strict-origin-when-cross-origin"
      src={embedUrlWithControlParams(media.embed_url, media.embed_control, media.source_kind)}
      title={media.label ?? media.id}
    />
  ) : isPrivateObject(media) ? (
    <PrivateObjectGate
      copy={privateDeliveryCopy}
      delivery={privateDelivery}
      media={media}
      onAction={onPrivateDeliveryAction}
    />
  ) : media.body_text ? (
    // Nothing to play, but the source is readable: show the words themselves.
    <article
      className="mt-4 max-h-[70vh] overflow-y-auto whitespace-pre-wrap rounded-2xl border border-[var(--border-primary)] p-5 text-sm leading-relaxed text-[var(--text-primary)]"
      data-media-playback-text={media.id}
    >
      {media.body_text}
    </article>
  ) : (
    <p className="mt-4 rounded-2xl border border-[var(--border-primary)] p-4 text-sm text-[var(--text-secondary)]" data-media-playback-unavailable={media.id}>
      This isn’t ready to play yet.
    </p>
  );

  if (!showFrameChrome) {
    return <div className="w-full min-w-0" data-media-playback-surface={media.id}>{player}</div>;
  }

  return (
    <MediaFrame
      actions={actions}
      metadata={[
        // Duration intentionally omitted: the player's own scrubber shows the real running
        // time (0:00 / 60:37); the media record's duration_label is often a category, not a
        // time. Show only member-meaningful progress here.
        { label: 'Status', value: statusLabel ?? 'not started' },
      ]}
      title={media.label ?? media.id}
    >
      {player}
    </MediaFrame>
  );
}
