// parts/ui/show/site-nav/SiteNav.tsx
//
// The site's top navigation for a page drawn in React. It reads the nav DATA through the same
// `siteNavEntries` the server-sent pages use (`../document-page/document-page-html.mjs`), writes the
// same classes and `data-nav-item` marks, and wears the same `SITE_NAV_CSS`, so a landing page and an
// article page show one navbar. Only the brand and the look of the call to action are the caller's.
//
// Behaviour matches the server-sent pages: a menu opens on mouse hover (after a short wait, so a pointer passing
// over does not open it; it closes after a short wait, and stays while the pointer heads for the card along a
// safe path: `siteNavHover` in site-nav-look.mjs, the one copy both renderers run) or keyboard focus, a click
// keeps a softly opened menu open and a second click closes it, a tap opens it, Escape closes it and
// returns focus to its button, a press outside closes everything. Under 1400px the whole nav folds
// behind one Menu button and Features opens in place under its button.
//
// A link to a section of a page (`/#pricing`) glides there: pressed on that page, the page scrolls to the section
// smoothly and the address names it; opened from another page, the page glides to it once it is drawn and keeps it
// in place while pictures and later sections still settle, until the reader scrolls themself (`useSectionLinks`).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SITE_NAV_CSS, siteNavEntries, siteNavHover } from './site-nav-look.mjs';

// A shape row as JSON gives it ([element, attributes]); IconShapes draws only rows that really have that form.
type IconNode = readonly (string | Readonly<Record<string, string>>)[];
type ShapeRow = readonly [string, Readonly<Record<string, string>>];
const isShapeRow = (node: IconNode): node is ShapeRow => node.length === 2 && typeof node[0] === 'string' && typeof node[1] === 'object';

export interface SiteNavProps {
  /** The nav DATA: { label, items: [{label, href} | {label, menu}], actions: [{label, href, primary}] }. */
  readonly nav: unknown;
  /** Icon shape rows by icon name (the Lucide icon-node form), the same map server-sent pages get. */
  readonly icons: Readonly<Record<string, readonly IconNode[]>>;
  /** The brand mark, linking home. */
  readonly brand: ReactNode;
  /** Draws the primary action in the page's own look; the plain filled link when left out. */
  readonly renderPrimary?: (action: { label: string; href: string }) => ReactNode;
  readonly toggleLabel?: string;
}

const ICON_SHAPES = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const CHEVRON: readonly IconNode[] = [['path', { d: 'm6 9 6 6 6-6' }]];

function IconShapes({ nodes, className }: { nodes: readonly IconNode[] | undefined; className: string }) {
  const shapes = (nodes ?? []).filter(isShapeRow).filter(([shape]) => ICON_SHAPES.has(shape));
  if (!shapes.length) return null;
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {shapes.map(([Shape, attributes], index) => {
        const { key: _key, ...rest } = attributes;
        return <Shape key={index} {...rest} />;
      })}
    </svg>
  );
}

interface MenuEntry {
  id: string;
  label: string;
  menu: {
    heading: string | null;
    items: { id: string; name: string; line: string; icon: string | null; href: string; preview: { src: string; alt: string; width: number; height: number } | null }[];
    footer: { label: string; line: string; href: string } | null;
  };
}

function FeatureMenu({ entry, icons, open, soft, onOpen, onClose, onPin }: {
  entry: MenuEntry;
  icons: SiteNavProps['icons'];
  open: boolean;
  soft: boolean;
  onOpen: (soft: boolean) => void;
  onClose: () => void;
  onPin: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLLIElement>(null);
  const hoverRef = useRef<ReturnType<typeof siteNavHover> | null>(null);
  const quietRef = useRef(false);
  // The hover timers read the menu's latest state and callbacks, so they are attached once.
  const latest = useRef({ open, soft, onOpen, onClose });
  latest.current = { open, soft, onOpen, onClose };

  useEffect(() => {
    const item = itemRef.current;
    if (!item) return undefined;
    const hover = siteNavHover(item, {
      isOpen: () => latest.current.open,
      isSoft: () => latest.current.soft,
      show: () => latest.current.onOpen(true),
      hide: () => latest.current.onClose(),
    });
    hoverRef.current = hover;
    return () => { hover.destroy(); hoverRef.current = null; };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const inside = buttonRef.current?.closest('[data-nav-menu]')?.contains(document.activeElement);
      onClose();
      if (inside) {
        quietRef.current = true;
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const { menu } = entry;
  return (
    <li
      ref={itemRef}
      className="site-nav__item site-nav__item--menu"
      data-nav-menu=""
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose(); }}
    >
      <button
        ref={buttonRef}
        className="site-nav__link site-nav__trigger"
        type="button"
        aria-expanded={open}
        aria-controls={entry.id}
        data-nav-item=""
        onClick={() => { hoverRef.current?.cancel(); if (open && soft) onPin(); else if (open) onClose(); else onOpen(false); }}
        onFocus={(event) => {
          if (quietRef.current) { quietRef.current = false; return; }
          if (!open && event.currentTarget.matches(':focus-visible')) onOpen(true);
        }}
      >
        {entry.label}
        <IconShapes nodes={CHEVRON} className="site-nav__chevron" />
      </button>
      <div className="site-nav__menu" id={entry.id}>
        <div className="site-nav__menu-card">
          <div className="site-nav__menu-main">
            {menu.heading ? <p className="site-nav__menu-heading">{menu.heading}</p> : null}
            <ul className="site-nav__features">
              {menu.items.map((row) => (
                <li key={row.id}>
                  <a className="site-nav__feature" href={row.href} data-nav-item={row.href}>
                    <span className="site-nav__feature-icon"><IconShapes nodes={row.icon ? icons[row.icon] : undefined} className="site-nav__feature-svg" /></span>
                    <span className="site-nav__feature-name">{row.name}</span>
                    <span className="site-nav__feature-line">{row.line}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="site-nav__menu-side">
            {menu.items.filter((row) => row.preview).map((row) => (
              <a key={row.id} className="site-nav__preview" href={row.href} tabIndex={-1}>
                <img className="site-nav__preview-img" src={row.preview!.src} alt={row.preview!.alt} width={row.preview!.width} height={row.preview!.height} loading="lazy" />
                <span className="site-nav__preview-name">{row.name}</span>
                <span className="site-nav__preview-line">{row.line}</span>
              </a>
            ))}
            {menu.footer ? (
              <a className="site-nav__menu-footer" href={menu.footer.href} data-nav-item={menu.footer.href}>
                <span className="site-nav__menu-footer-label">{menu.footer.label}</span>
                {menu.footer.line ? <span className="site-nav__menu-footer-line">{menu.footer.line}</span> : null}
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

// How long an arriving page keeps its section in place while its pictures and late sections still change its height.
const SETTLE_MS = 4000;
const motion = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
const sectionOf = (href: string): HTMLElement | null => {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || !url.hash) return null;
  return document.getElementById(decodeURIComponent(url.hash.slice(1)));
};
// The section's top on the page, less any scroll margin it asks for.
const topOf = (section: HTMLElement) => section.getBoundingClientRect().top + window.scrollY - Number.parseFloat(getComputedStyle(section).scrollMarginTop || '0');

function useSectionLinks() {
  useEffect(() => {
    // Pressed on the page that holds the section: glide there and name it in the address.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      const section = link ? sectionOf(link.getAttribute('href') ?? '') : null;
      if (!link || !section) return;
      event.preventDefault();
      window.history.pushState(null, '', `#${section.id}`);
      window.scrollTo({ top: topOf(section), behavior: motion() });
    };
    document.addEventListener('click', onClick);
    // Arrived with a section in the address: glide to it once drawn, and follow it while the page settles.
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return () => document.removeEventListener('click', onClick);
    let stopped = false;
    let aimed = Number.NaN;
    const stop = () => { stopped = true; };
    const reader = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    reader.forEach((type) => window.addEventListener(type, stop, { passive: true, once: true }));
    const until = performance.now() + SETTLE_MS;
    let frame = 0;
    const follow = () => {
      if (stopped || performance.now() > until) return;
      const section = document.getElementById(id);
      if (section) {
        const top = topOf(section);
        // A new aim (first sight, or the page moved the section) glides there; the same aim is left to finish.
        if (!(Math.abs(top - aimed) <= 2)) { aimed = top; window.scrollTo({ top, behavior: motion() }); }
      }
      frame = requestAnimationFrame(follow);
    };
    window.history.scrollRestoration = 'manual';
    frame = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('click', onClick);
      reader.forEach((type) => window.removeEventListener(type, stop));
    };
  }, []);
}

export function SiteNav({ nav, icons, brand, renderPrimary, toggleLabel = 'Menu' }: SiteNavProps) {
  const entries = siteNavEntries(nav) as { label: string; items: ({ label: string; href: string } | MenuEntry)[]; actions: { label: string; href: string; primary: boolean }[] };
  const rootRef = useRef<HTMLElement>(null);
  const [openMenu, setOpenMenu] = useState<{ id: string; soft: boolean } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpenMenu(null);
      setPanelOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  useSectionLinks();

  const hasPanel = entries.items.length > 0 || entries.actions.length > 0;
  return (
    <header className="site-nav" data-site-nav="" data-nav-ready="" ref={rootRef}>
      <style>{SITE_NAV_CSS}</style>
      <div className="site-nav__bar">
        <a className="site-nav__brand" href="/">{brand}</a>
        {hasPanel ? (
          <>
            <button className="site-nav__toggle" type="button" aria-expanded={panelOpen} aria-controls="site-nav-panel" onClick={() => setPanelOpen((value) => !value)}>
              {toggleLabel}
            </button>
            <nav className="site-nav__panel" id="site-nav-panel" aria-label={entries.label}>
              <ul className="site-nav__list">
                {entries.items.map((entry) => ('menu' in entry ? (
                  <FeatureMenu
                    key={entry.id}
                    entry={entry}
                    icons={icons}
                    open={openMenu?.id === entry.id}
                    soft={openMenu?.id === entry.id && openMenu.soft}
                    onOpen={(soft) => setOpenMenu({ id: entry.id, soft })}
                    onClose={() => setOpenMenu((current) => (current?.id === entry.id ? null : current))}
                    onPin={() => setOpenMenu({ id: entry.id, soft: false })}
                  />
                ) : (
                  <li className="site-nav__item" key={entry.href}>
                    <a className="site-nav__link" href={entry.href} data-nav-item={entry.href}>{entry.label}</a>
                  </li>
                )))}
              </ul>
              {entries.actions.length ? (
                <div className="site-nav__actions">
                  {entries.actions.map((action) => (action.primary && renderPrimary ? (
                    <span className="site-nav__action-slot" key={action.href} data-nav-item={action.href}>{renderPrimary(action)}</span>
                  ) : (
                    <a key={action.href} className={`site-nav__action${action.primary ? ' site-nav__action--primary' : ''}`} href={action.href} data-nav-item={action.href}>{action.label}</a>
                  )))}
                </div>
              ) : null}
            </nav>
          </>
        ) : null}
      </div>
    </header>
  );
}
