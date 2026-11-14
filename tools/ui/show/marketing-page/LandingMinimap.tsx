'use client';

import React from 'react';

export type LandingMinimapItem = {
  readonly id: string;
  readonly label: string;
};

const COLLAPSE_STORAGE_KEY = 'bf-minimap-collapsed';

/** Shared marketing-page section navigation, matching the live Bitfield/Trillion behavior. */
export function LandingMinimap({ items }: { items: readonly LandingMinimapItem[] }) {
  const [activeId, setActiveId] = React.useState(items[0]?.id ?? '');
  const [open, setOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  // Only sections the page actually rendered are listed. A page assembled
  // from DATA can drop sections, and a link to a section that is not there
  // does nothing when clicked. Two entries are the top and one other place,
  // which the header already reaches, so a map needs three.
  const [present, setPresent] = React.useState<readonly LandingMinimapItem[]>(items);
  React.useEffect(() => {
    setPresent(items.filter((item) => document.getElementById(item.id)));
  }, [items]);

  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1');
    } catch {
      // Storage is optional; the menu remains expanded when unavailable.
    }
  }, []);

  React.useEffect(() => {
    const sections = items
      .map((item) => document.getElementById(item.id))
      .filter((section): section is HTMLElement => Boolean(section));
    if (sections.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visible?.target.id) setActiveId(visible.target.id);
    }, { rootMargin: '-24% 0px -58% 0px', threshold: [0.05, 0.2, 0.45] });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [items]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  function rememberCollapsed(next: boolean) {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // The visible state still works when persistence is unavailable.
    }
  }

  function goToSection(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    setActiveId(id);
    setOpen(false);
    window.history.replaceState(null, '', `#${id}`);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  if (present.length < 3) return null;
  return (
    <>
      <style>{`
        .landing-minimap { position: fixed; right: 18px; top: 50%; z-index: 60; isolation: isolate; display: grid; gap: 7px; width: 210px; padding: 12px; border: 1px solid rgba(15,23,42,0.09); border-radius: 18px; background: rgba(255,255,255,0.84); box-shadow: 0 18px 46px -34px rgba(15,23,42,0.48); backdrop-filter: blur(16px); transform: translateY(-50%); transition: transform 300ms cubic-bezier(0.22,1,0.36,1), opacity 220ms ease; }
        .landing-minimap a { display: grid; grid-template-columns: 8px minmax(0,1fr); gap: 8px; align-items: center; min-height: 30px; padding-block: 3px; color: rgba(15,23,42,0.5); font-size: 0.68rem; font-weight: 650; line-height: 1.25; text-decoration: none; transition: color 160ms ease; }
        .landing-minimap a::before { content: ''; width: 6px; height: 6px; border-radius: 999px; background: rgba(15,23,42,0.16); transition: background 160ms ease, transform 160ms ease; }
        .landing-minimap a[aria-current='location'] { color: #0f172a; }
        .landing-minimap a[aria-current='location']::before { background: #008652; transform: scale(1.35); }
        .landing-minimap a:focus-visible { border-radius: 6px; outline: 2px solid #008652; outline-offset: 3px; }
        .landing-minimap__close, .landing-minimap-toggle, .landing-minimap__backdrop, .landing-minimap-desktop-toggle { display: none; }
        @media (min-width: 1181px) {
          .landing-minimap { padding-top: 30px; }
          .landing-minimap.is-collapsed { transform: translateY(-50%) translateX(132%); opacity: 0; pointer-events: none; }
          .landing-minimap__collapse { display: inline-flex; align-items: center; justify-content: center; position: absolute; top: 7px; right: 8px; width: 26px; height: 26px; padding: 0; border: none; border-radius: 8px; background: rgba(15,23,42,0.05); color: #0f172a; cursor: pointer; }
          .landing-minimap-desktop-toggle.is-visible { display: inline-flex; align-items: center; justify-content: center; position: fixed; right: 18px; top: 50%; transform: translateY(-50%); z-index: 60; width: 42px; height: 42px; padding: 0; border: 1px solid rgba(15,23,42,0.10); border-radius: 14px; background: rgba(255,255,255,0.86); box-shadow: 0 14px 40px -26px rgba(15,23,42,0.5); backdrop-filter: blur(16px); color: #0f172a; cursor: pointer; }
        }
        @media (max-width: 1180px) {
          .landing-minimap__collapse, .landing-minimap-desktop-toggle { display: none !important; }
          .landing-minimap-toggle { display: inline-flex; align-items: center; justify-content: center; position: fixed; right: 14px; bottom: max(16px, env(safe-area-inset-bottom)); z-index: 62; width: 46px; height: 46px; padding: 0; border: 1px solid rgba(15,23,42,0.10); border-radius: 14px; background: rgba(255,255,255,0.94); box-shadow: 0 12px 34px -18px rgba(15,23,42,0.55); backdrop-filter: blur(14px); cursor: pointer; color: #0f172a; }
          .landing-minimap-toggle:focus-visible { outline: 2px solid #008652; outline-offset: 3px; }
          .landing-minimap__backdrop { display: block; position: fixed; inset: 0; z-index: 61; background: rgba(15,23,42,0.18); opacity: 0; pointer-events: none; transition: opacity 220ms ease; }
          .landing-minimap__backdrop.is-open { opacity: 1; pointer-events: auto; }
          .landing-minimap { right: 12px; left: auto; top: 50%; width: min(230px, 68vw); max-height: 76vh; overflow-y: auto; padding-top: 40px; transform: translateY(-50%) translateX(126%); transition: transform 260ms cubic-bezier(0.22,1,0.36,1); z-index: 62; }
          .landing-minimap.is-open { transform: translateY(-50%) translateX(0); }
          .landing-minimap a { min-height: 34px; }
          .landing-minimap__close { display: inline-flex; align-items: center; justify-content: center; position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; padding: 0; border: none; border-radius: 8px; background: rgba(15,23,42,0.05); color: #0f172a; cursor: pointer; }
        }
        @media (prefers-reduced-motion: reduce) { .landing-minimap, .landing-minimap a, .landing-minimap a::before, .landing-minimap__backdrop { transition: none; } }
      `}</style>
      <button className="landing-minimap-toggle" type="button" aria-label={open ? 'Close section menu' : 'Open section menu'} aria-expanded={open} aria-controls="landing-minimap-nav" onClick={() => setOpen((value) => !value)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      <button className={`landing-minimap-desktop-toggle${collapsed ? ' is-visible' : ''}`} type="button" aria-label="Show section menu" aria-expanded={!collapsed} aria-controls="landing-minimap-nav" onClick={() => rememberCollapsed(false)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      <div className={`landing-minimap__backdrop${open ? ' is-open' : ''}`} aria-hidden="true" onClick={() => setOpen(false)} />
      <nav id="landing-minimap-nav" className={`landing-minimap${open ? ' is-open' : ''}${collapsed ? ' is-collapsed' : ''}`} aria-label="Page sections" aria-hidden={collapsed ? true : undefined}>
        <button className="landing-minimap__collapse" type="button" aria-label="Hide section menu" onClick={() => rememberCollapsed(true)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
        <button className="landing-minimap__close" type="button" aria-label="Close section menu" onClick={() => setOpen(false)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        {present.map((item) => <a aria-current={activeId === item.id ? 'location' : undefined} href={`#${item.id}`} key={item.id} onClick={(event) => goToSection(event, item.id)}><span>{item.label}</span></a>)}
      </nav>
    </>
  );
}
