// bitfield/packages/ui/show/media-carousel/MediaCarousel.tsx
//
// Canonical horizontal media carousel. The component owns the scroll rail,
// keyboard behavior, arrows, pagination dots, opacity edge fade, and the
// shadow-safe padding around each item. Media and optional labels are DATA.

'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export type MediaCarouselItem = {
  id?: string;
  src: string;
  alt: string;
  kind?: 'image' | 'video';
  label?: string;
  detail?: string;
};

export interface MediaCarouselProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  items?: readonly MediaCarouselItem[];
  renderEmpty?: React.ReactNode;
  renderItem?: (item: MediaCarouselItem, index: number) => React.ReactNode;
  // Draws one item's media inside the carousel's own frame and label (a file preview, a player) in place of the plain
  // image or video; mediaClassName sizes the box it sits in.
  renderMedia?: (item: MediaCarouselItem, index: number) => React.ReactNode;
  ariaLabel?: string;
  showLabels?: boolean;
  showControls?: boolean;
  showEdgeFade?: boolean;
  itemClassName?: string;
  mediaClassName?: string;
}

function mergeClassNames(...values: Array<string | undefined | false>) {
  return values.filter(Boolean).join(' ');
}

function NativeMedia({ item, className }: { item: MediaCarouselItem; className?: string }) {
  if (item.kind === 'video') {
    return (
      <video
        aria-label={item.alt}
        autoPlay
        className={mergeClassNames('bf-media-carousel__media', className)}
        loop
        muted
        playsInline
        preload="metadata"
        src={item.src}
      />
    );
  }
  return <img alt={item.alt} className={mergeClassNames('bf-media-carousel__media', className)} decoding="async" loading="lazy" src={item.src} />;
}

export const MediaCarousel = forwardRef<HTMLDivElement, MediaCarouselProps>(
  ({
    items = [],
    renderEmpty,
    renderItem,
    renderMedia,
    ariaLabel = 'Media carousel',
    showLabels = false,
    showControls = true,
    showEdgeFade = true,
    itemClassName,
    mediaClassName,
    className,
    ...props
  }, forwardedRef) => {
    const railRef = useRef<HTMLDivElement>(null);
    const hasInteracted = useRef(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const [canMoveBack, setCanMoveBack] = useState(false);
    const [canMoveForward, setCanMoveForward] = useState(items.length > 1);
    const [hasOverflow, setHasOverflow] = useState(false);
    const [edgeSpace, setEdgeSpace] = useState(0);

    useImperativeHandle(forwardedRef, () => railRef.current as HTMLDivElement, []);

    const sync = useCallback(() => {
      const rail = railRef.current;
      if (!rail) return;
      const cards = Array.from(rail.querySelectorAll<HTMLElement>('[data-media-carousel-item]'));
      if (cards.length === 0) return;
      const railStyle = window.getComputedStyle(rail);
      const rightPadding = parseFloat(railStyle.paddingRight) || 0;
      const horizontalPadding = (parseFloat(railStyle.paddingLeft) || 0) + rightPadding;
      const naturalWidth = cards[cards.length - 1].offsetLeft + cards[cards.length - 1].offsetWidth - cards[0].offsetLeft;
      const overflowing = rail.clientWidth === 0
        ? cards.length > 1
        : naturalWidth > rail.clientWidth - horizontalPadding + 2;
      setHasOverflow(overflowing);
      setEdgeSpace(overflowing
        ? Math.max(0, (rail.clientWidth - cards[0].offsetWidth) / 2 - rightPadding)
        : 0);
      const nearest = cards.reduce((best, card, index) => {
        const cardBounds = card.getBoundingClientRect();
        const railBounds = rail.getBoundingClientRect();
        // Both centers must use the same coordinate space. offsetLeft can be
        // relative to an ancestor outside this rail when it sits in another pane.
        const distance = Math.abs(cardBounds.left + cardBounds.width / 2 - railBounds.left - railBounds.width / 2);
        return distance < best.distance ? { distance, index } : best;
      }, { distance: Number.POSITIVE_INFINITY, index: 0 });
      setActiveIndex(nearest.index);
      setCanMoveBack(overflowing && nearest.index > 0);
      setCanMoveForward(overflowing && nearest.index < cards.length - 1);
    }, []);

    useEffect(() => {
      const rail = railRef.current;
      if (!rail) return;
      const observer = new ResizeObserver(sync);
      observer.observe(rail);
      sync();
      return () => observer.disconnect();
    }, [items.length, sync]);

    useEffect(() => { sync(); }, [edgeSpace, sync]);

    if (items.length === 0) return renderEmpty ? <>{renderEmpty}</> : null;

    function scrollToItem(index: number) {
      const rail = railRef.current;
      if (!rail) return;
      const cards = Array.from(rail.querySelectorAll<HTMLElement>('[data-media-carousel-item]'));
      const nextIndex = Math.max(0, Math.min(index, cards.length - 1));
      const card = cards[nextIndex];
      if (!card) return;
      const cardBounds = card.getBoundingClientRect();
      const railBounds = rail.getBoundingClientRect();
      rail.scrollTo({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        left: rail.scrollLeft + cardBounds.left + cardBounds.width / 2 - railBounds.left - railBounds.width / 2,
      });
      setActiveIndex(nextIndex);
    }

    return (
      <div
        className={mergeClassNames('bf-media-carousel', className)}
        data-edge-fade={showEdgeFade ? 'true' : 'false'}
        data-labels-visible={showLabels ? 'true' : 'false'}
        {...props}
        onFocusCapture={event => {
          props.onFocusCapture?.(event);
          if (hasInteracted.current || !(event.target instanceof HTMLIFrameElement)) return;
          const frame = event.target;
          // Some embedded viewers focus their frame while starting and scroll
          // the rail to themselves. Let that startup focus finish, then restore
          // the initial item. Keyboard, pointer, and touch-driven navigation
          // marks the carousel as intentional before it focuses an item.
          requestAnimationFrame(() => {
            if (hasInteracted.current || !frame.isConnected) return;
            requestAnimationFrame(() => {
              if (hasInteracted.current || !frame.isConnected) return;
              const rail = railRef.current;
              const first = rail?.querySelector<HTMLElement>('[data-media-carousel-item]');
              if (!rail || !first) return;
              const cardBounds = first.getBoundingClientRect();
              const railBounds = rail.getBoundingClientRect();
              rail.scrollTo({
                left: rail.scrollLeft + cardBounds.left + cardBounds.width / 2 - railBounds.left - railBounds.width / 2,
                behavior: 'instant',
              });
              sync();
            });
          });
        }}
        onPointerDownCapture={event => { hasInteracted.current = true; props.onPointerDownCapture?.(event); }}
        onWheelCapture={event => { hasInteracted.current = true; props.onWheelCapture?.(event); }}
        onKeyDownCapture={event => { hasInteracted.current = true; props.onKeyDownCapture?.(event); }}
      >
        <style>{`
          .bf-media-carousel { --media-carousel-accent: #315c49; --media-carousel-ink: #0f172a; display: grid; gap: 12px; min-width: 0; }
          .bf-media-carousel__rail { cursor: grab; display: flex; gap: 14px; min-width: 0; overflow-x: auto; overscroll-behavior-inline: contain; padding: 26px clamp(30px,5vw,54px); scroll-padding-inline: clamp(30px,5vw,54px); scroll-snap-type: x mandatory; scrollbar-width: none; touch-action: pan-x pan-y; }
          .bf-media-carousel__rail::before,.bf-media-carousel__rail::after { content: ''; flex: 0 0 var(--media-carousel-edge-space,0px); }
          .bf-media-carousel[data-edge-fade="true"] .bf-media-carousel__rail { -webkit-mask-image: linear-gradient(90deg,transparent 0%,#000 9%,#000 91%,transparent 100%); mask-image: linear-gradient(90deg,transparent 0%,#000 9%,#000 91%,transparent 100%); }
          .bf-media-carousel__rail::-webkit-scrollbar { display: none; }
          .bf-media-carousel__rail:focus-visible { outline: 2px solid var(--media-carousel-accent); outline-offset: -2px; }
          .bf-media-carousel__item { flex: 0 0 clamp(286px,38vw,390px); min-width: 0; scroll-snap-align: center; }
          .bf-media-carousel__frame { background: rgba(255,255,255,.9); border: 1px solid rgba(15,23,42,.1); border-radius: 18px; box-shadow: 0 26px 42px -24px rgba(15,23,42,.58); overflow: hidden; }
          .bf-media-carousel__media { aspect-ratio: 16/9; background: #101714; display: block; object-fit: cover; width: 100%; }
          .bf-media-carousel__label { background: rgba(255,255,255,.94); border-top: 1px solid rgba(15,23,42,.1); display: grid; gap: 3px; padding: 13px 15px 15px; }
          .bf-media-carousel__label strong { color: var(--media-carousel-ink); font-size: .9375rem; line-height: 1.45; }
          .bf-media-carousel__label span { color: #64748b; font-size: .9375rem; line-height: 1.5; }
          .bf-media-carousel__controls { align-items: center; display: grid; gap: 14px; grid-template-columns: 38px auto 38px; justify-content: center; }
          .bf-media-carousel__arrow { align-items: center; background: rgba(255,255,255,.94); border: 1px solid rgba(49,92,73,.25); border-radius: 999px; box-shadow: 0 2px 8px rgba(15,23,42,.05); color: var(--media-carousel-accent); cursor: pointer; display: inline-flex; height: 38px; justify-content: center; padding: 0; transition: background 160ms ease,border-color 160ms ease,box-shadow 160ms ease,opacity 160ms ease,transform 160ms ease; width: 38px; }
          .bf-media-carousel__arrow::before { border-right: 1.8px solid currentColor; border-top: 1.8px solid currentColor; content: ''; display: block; height: 8px; width: 8px; }
          .bf-media-carousel__arrow[data-direction="previous"]::before { transform: translateX(2px) rotate(-135deg); }
          .bf-media-carousel__arrow[data-direction="next"]::before { transform: translateX(-2px) rotate(45deg); }
          .bf-media-carousel__arrow:hover:not(:disabled) { background: rgba(49,92,73,.08); border-color: var(--media-carousel-accent); box-shadow: 0 3px 12px rgba(49,92,73,.12); transform: translateY(-1px); }
          .bf-media-carousel__arrow:disabled { background: transparent; box-shadow: none; cursor: default; opacity: .35; }
          .bf-media-carousel__dots { align-items: center; display: flex; gap: 8px; justify-content: center; }
          .bf-media-carousel__dot { background: rgba(15,23,42,.2); border: 0; border-radius: 999px; cursor: pointer; height: 8px; padding: 0; transition: background 160ms ease,transform 160ms ease,width 160ms ease; width: 8px; }
          .bf-media-carousel__dot[data-active="true"] { background: var(--media-carousel-accent); width: 22px; }
          .bf-media-carousel__arrow:focus-visible,.bf-media-carousel__dot:focus-visible { outline: 2px solid var(--media-carousel-accent); outline-offset: 3px; }
          .bf-media-carousel__sr { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
          @media (max-width:760px) { .bf-media-carousel__rail { padding-inline: 26px; scroll-padding-inline: 26px; } .bf-media-carousel__item { flex-basis: min(82vw,340px); } }
          @media (prefers-reduced-motion:reduce) { .bf-media-carousel__arrow,.bf-media-carousel__dot { transition: none; } }
          @media (forced-colors:active) { .bf-media-carousel__rail { -webkit-mask-image: none!important; mask-image: none!important; } }
        `}</style>
        <div
          aria-label={ariaLabel}
          aria-live="off"
          aria-roledescription="carousel"
          className="bf-media-carousel__rail"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); scrollToItem(activeIndex - 1); }
            if (event.key === 'ArrowRight') { event.preventDefault(); scrollToItem(activeIndex + 1); }
            if (event.key === 'Home') { event.preventDefault(); scrollToItem(0); }
            if (event.key === 'End') { event.preventDefault(); scrollToItem(items.length - 1); }
          }}
          onScroll={sync}
          ref={railRef}
          role="region"
          style={{ '--media-carousel-edge-space': `${edgeSpace}px` } as React.CSSProperties}
          tabIndex={0}
        >
          {items.map((item, index) => (
            <article className={mergeClassNames('bf-media-carousel__item', itemClassName)} data-media-carousel-item={item.id ?? index} key={item.id ?? `${item.src}-${index}`}>
              {renderItem ? renderItem(item, index) : (
                <div className="bf-media-carousel__frame">
                  {renderMedia
                    ? <div className={mergeClassNames('bf-media-carousel__media', mediaClassName)}>{renderMedia(item, index)}</div>
                    : <NativeMedia className={mediaClassName} item={item} />}
                  {showLabels && (item.label || item.detail) ? (
                    <div className="bf-media-carousel__label">
                      {item.label ? <strong>{item.label}</strong> : null}
                      {item.detail ? <span>{item.detail}</span> : null}
                    </div>
                  ) : null}
                </div>
              )}
            </article>
          ))}
        </div>
        {showControls && items.length > 1 && hasOverflow ? (
          <div className="bf-media-carousel__controls">
            <button aria-label="Show previous media item" className="bf-media-carousel__arrow" data-direction="previous" disabled={!canMoveBack} onClick={() => scrollToItem(activeIndex - 1)} type="button" />
            <div aria-label="Choose media item" className="bf-media-carousel__dots" role="group">
              {items.map((item, index) => (
                <button aria-label={`Show ${item.alt}`} aria-pressed={activeIndex === index} className="bf-media-carousel__dot" data-active={activeIndex === index ? 'true' : 'false'} key={item.id ?? index} onClick={() => scrollToItem(index)} type="button" />
              ))}
            </div>
            <button aria-label="Show next media item" className="bf-media-carousel__arrow" data-direction="next" disabled={!canMoveForward} onClick={() => scrollToItem(activeIndex + 1)} type="button" />
          </div>
        ) : null}
        <span aria-live="polite" className="bf-media-carousel__sr">Item {activeIndex + 1} of {items.length}: {items[activeIndex]?.alt}</span>
      </div>
    );
  },
);

MediaCarousel.displayName = 'MediaCarousel';
