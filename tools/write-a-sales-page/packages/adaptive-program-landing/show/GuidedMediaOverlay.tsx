'use client';

import React from 'react';
import { Gauge, Headphones, Target } from 'lucide-react';
import styles from '@/packages/screen-look/show/adaptive-program-landing/GuidedMediaOverlay.module.css';

type GuidanceRole = 'guide' | 'metric';

export type GuidedMediaLine = {
  readonly id: string;
  readonly role: GuidanceRole;
  readonly text: string;
};

export type GuidedMediaOverlayProps = {
  readonly videoSrc: string;
  readonly poster: string;
  readonly videoLabel: string;
  readonly guideName: string;
  readonly successRate: number;
  readonly targetBand: readonly [number, number];
  readonly bottleneck: { readonly label: string; readonly detail: string };
  readonly lines: readonly GuidedMediaLine[];
  readonly surfaceAriaLabel: string;
  readonly liveLabel: string;
  readonly successRateLabel: string;
  readonly learningZoneTemplate: string;
  readonly watchingLabel: string;
  readonly messagesAriaLabel: string;
  readonly typingTemplate: string;
};

// Timing (ms) for the streaming cadence. All gated on play + in-view.
const TYPING_MS = 720;
const HOLD_MS = 1700;
const LOOP_PAUSE_MS = 2400;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

/**
 * Streams the coaching lines one at a time. `active` gates advancement so the
 * conversation only progresses while the clip is playing and on screen. When
 * the transcript ends it loops back to the start with the looping clip.
 */
function useGuidanceStream(lines: readonly GuidedMediaLine[], active: boolean, reduced: boolean) {
  const [revealed, setRevealed] = React.useState(0);
  const [typing, setTyping] = React.useState(true);

  React.useEffect(() => {
    if (reduced) {
      setRevealed(lines.length);
      setTyping(false);
      return;
    }
    if (!active) return;
    if (revealed >= lines.length) {
      const loop = window.setTimeout(() => { setRevealed(0); setTyping(true); }, LOOP_PAUSE_MS);
      return () => window.clearTimeout(loop);
    }
    if (typing) {
      const reveal = window.setTimeout(() => setTyping(false), TYPING_MS);
      return () => window.clearTimeout(reveal);
    }
    const advance = window.setTimeout(() => { setRevealed((value) => value + 1); setTyping(true); }, HOLD_MS);
    return () => window.clearTimeout(advance);
  }, [active, reduced, revealed, typing, lines.length]);

  return { revealed, typing };
}

export function GuidedMediaOverlay({
  videoSrc, poster, videoLabel, guideName, successRate, targetBand, bottleneck, lines,
  surfaceAriaLabel, liveLabel, successRateLabel, learningZoneTemplate,
  watchingLabel, messagesAriaLabel, typingTemplate,
}: GuidedMediaOverlayProps) {
  const reduced = usePrefersReducedMotion();
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = React.useState(true);
  const [inView, setInView] = React.useState(true);

  // Only stream while the clip is playing AND on screen, the "synced to play" feel.
  React.useEffect(() => {
    const node = surfaceRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.25 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { revealed, typing } = useGuidanceStream(lines, playing && inView, reduced);

  // Keep the newest bubble in view.
  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }, [revealed, typing, reduced]);

  const [low, high] = targetBand;
  const clampedRate = Math.max(0, Math.min(100, successRate));
  const showTyping = !reduced && revealed < lines.length && typing;

  return (
    <div ref={surfaceRef} className={styles.surface} data-testid="program-guided-media-overlay" aria-label={surfaceAriaLabel}>
      <div className={styles.frame}>
        <div className={styles.mediaStage}>
          <video
            className={styles.video}
            src={videoSrc}
            poster={poster}
            aria-label={videoLabel}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
          <div className={styles.scrim} aria-hidden="true" />

          {/* top-left LIVE HUD + success meter (the difficulty the coach is holding you at) */}
          <div className={styles.hud}>
            <span className={styles.livePill}><span className={styles.liveDot} aria-hidden="true" />{liveLabel}</span>
            <div className={styles.meter}>
              <div className={styles.meterTop}>
                <span className={styles.meterLabel}>{successRateLabel}</span>
                <span className={styles.meterValue}>{clampedRate}%</span>
              </div>
              <div className={styles.meterTrack}>
                <span className={styles.meterBand} style={{ left: `${low}%`, width: `${Math.max(0, high - low)}%` }} aria-hidden="true" />
                <span className={styles.meterFill} style={{ width: `${clampedRate}%` }} aria-hidden="true" />
              </div>
              <div className={styles.meterCaption}>{learningZoneTemplate.replace('{low}', String(low)).replace('{high}', String(high))}</div>
            </div>
          </div>
        </div>

        {/* floating glass chat panel */}
        <div className={styles.chat} data-testid="program-guided-media-chat">
          <div className={styles.chatHead}>
            <span className={styles.avatar}><Headphones size={17} aria-hidden="true" /></span>
            <span>
              <span className={styles.headName}>{guideName}</span>
              <span className={styles.headStatus}><i aria-hidden="true" />{watchingLabel}</span>
            </span>
          </div>

          <div className={styles.pinned}>
            <span className={styles.pinnedIcon}><Target size={13} aria-hidden="true" /></span>
            <span>
              <span className={styles.pinnedLabel}>{bottleneck.label}</span>
              <span className={styles.pinnedText}>{bottleneck.detail}</span>
            </span>
          </div>

          <div className={styles.messages} ref={listRef} aria-live="polite" aria-label={messagesAriaLabel}>
            {lines.slice(0, revealed).map((line) => (
              <div key={line.id} className={`${styles.bubble} ${line.role === 'metric' ? styles.stat : styles.coach}`}>
                {line.role === 'metric' ? <Gauge className={styles.statIcon} size={14} aria-hidden="true" /> : null}
                {line.text}
              </div>
            ))}
            {showTyping ? (
              <div className={styles.typing} aria-label={typingTemplate.replace('{name}', guideName)}>
                <i /><i /><i />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
