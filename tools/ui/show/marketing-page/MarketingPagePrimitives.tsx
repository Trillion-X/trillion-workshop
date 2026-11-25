import React, { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { Button } from '../button/Button';
import { ScrollViewport } from '../scrollable-surface/ScrollViewport';

// A marketing page's buttons are the one shared Button, named here too for the parts that import their page parts from
// this file.
export { Button };

export const LANDING_SOLID_HIGHLIGHT_COLOR = '#008652';
export const LANDING_PRICING_SECTION_ID = 'pricing';
export const LANDING_FILM_GRAIN_TEXTURE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='280' height='280' viewBox='0 0 280 280'%3E%3Cfilter id='n' x='0' y='0' width='100%25' height='100%25' color-interpolation-filters='sRGB'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.62' numOctaves='2' seed='2' stitchTiles='stitch' result='noise'/%3E%3CfeColorMatrix in='noise' type='saturate' values='0' result='mono'/%3E%3CfeComponentTransfer in='mono' result='contrast'%3E%3CfeFuncR type='linear' slope='3'/%3E%3CfeFuncG type='linear' slope='3'/%3E%3CfeFuncB type='linear' slope='3'/%3E%3C/feComponentTransfer%3E%3CfeColorMatrix in='contrast' type='matrix' values='1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 16 -8'/%3E%3C/filter%3E%3Crect width='280' height='280' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`;
export const LANDING_LAYER_Z_INDEX = { pageTexture: 100 } as const;
export const ENGRAVED_HEADING_FILTER = 'drop-shadow(0 1px 0 rgba(255,255,255,.7)) drop-shadow(0 -1px 0 rgba(15,23,42,.08))';

const CONTAINER_MAX_WIDTH: Record<string, string | number> = {
  none: 'none',
  '2xl': 672,
  '4xl': 896,
  '5xl': 1024,
  '6xl': 1152,
  '7xl': 1280,
};

export const MARKETING_PAGE_LAYOUT_CSS = `
  .bitfield-marketing-page,
  .bitfield-marketing-page *,
  .bitfield-marketing-page *::before,
  .bitfield-marketing-page *::after {
    box-sizing: border-box;
  }
  .bitfield-section-shell {
    margin-left: auto;
    margin-right: auto;
    padding-left: 16px;
    padding-right: 16px;
    width: 100%;
  }
  .bitfield-section-padding-none { padding-bottom: 0; padding-top: 0; }
  .bitfield-section-padding-compact { padding-bottom: 64px; padding-top: 64px; }
  .bitfield-section-padding-default { padding-bottom: 80px; padding-top: 80px; }
  .bitfield-section-padding-hero { padding-bottom: 96px; padding-top: 112px; }
  @media (min-width: 640px) {
    .bitfield-section-shell { padding-left: 24px; padding-right: 24px; }
  }
  @media (min-width: 768px) {
    .bitfield-section-shell { padding-left: 72px; padding-right: 72px; }
    .bitfield-section-padding-compact { padding-bottom: 80px; padding-top: 80px; }
    .bitfield-section-padding-default { padding-bottom: 112px; padding-top: 112px; }
    .bitfield-section-padding-hero { padding-bottom: 112px; padding-top: 128px; }
  }
  /* Every button on a marketing page is the one shared Button (../button), painted by the site's look: this sheet only
     places them. A call to action sits centred with its note below it, and on a phone it spans the column. */
  .bitfield-cta-block { display: grid; gap: 12px; justify-items: center; padding: clamp(30px,4.5vw,58px) 16px; text-align: center; }
  .bitfield-cta-block__note { color: rgba(15,23,42,.6); font-size: .95rem; font-weight: 600; margin: 0; }
  @media (max-width: 640px) {
    .bitfield-cta-block > [data-button-face] { width: min(100%, 420px); }
  }
  .bitfield-site-header-menu-link {
    color: #0f172a !important;
    text-decoration: none !important;
  }
  .bitfield-site-header-menu-link:hover,
  .bitfield-site-header-menu-link:focus-visible {
    text-decoration: underline;
  }
  .bitfield-site-header-menu-toggle { display: none !important; }
  .bitfield-site-header-menu { display: none !important; }
  @media (max-width: 640px) {
    .bitfield-site-header {
      opacity: 1 !important;
      padding: 8px 10px !important;
      transform: translateY(0) !important;
      transition: none !important;
    }
    .bitfield-site-header-direct-links { display: none !important; }
    .bitfield-site-header-actions { gap: 8px !important; }
    .bitfield-site-header-cta { display: none !important; }
    .bitfield-site-header-menu-toggle { display: inline-flex !important; }
    .bitfield-site-header-menu { display: grid !important; right: 0 !important; width: min(320px, calc(100vw - 36px)) !important; }
  }
`;

export function Container({
  alignItems,
  as: Tag = 'div',
  children,
  className = '',
  gap,
  gridCols,
  justifyContent,
  layout,
  maxWidth,
  style,
  width,
  ...props
}: any) {
  const layoutStyle = layout === 'grid'
    ? { display: 'grid', gridTemplateColumns: gridCols ? `repeat(${gridCols}, minmax(0, 1fr))` : undefined }
    : layout === 'horizontal'
      ? { display: 'flex', flexDirection: 'row' as const }
      : layout === 'vertical'
        ? { display: 'flex', flexDirection: 'column' as const }
        : {};
  return (
    <Tag
      className={className}
      style={{
        ...layoutStyle,
        alignItems,
        boxSizing: 'border-box',
        gap: gap === 'xl' ? 32 : gap,
        justifyContent,
        maxWidth: CONTAINER_MAX_WIDTH[maxWidth] ?? maxWidth,
        minWidth: 0,
        width: width === 'full' ? '100%' : width,
        ...style,
      }}
      {...props}
    >
      {children}
    </Tag>
  );
}

export function PageShell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <main
      className={`bitfield-marketing-page ${className}`.trim()}
      style={{ minHeight: '100vh', minWidth: 0, overflowX: 'clip', width: '100%' }}
    >
      <style>{MARKETING_PAGE_LAYOUT_CSS}</style>
      {children}
    </main>
  );
}

const SECTION_MAX_WIDTH = { narrow: 1024, default: 1152, wide: 1280 } as const;
// `style` is forwarded, and it is LAST so a caller can override a shell value.
// Without it a caller's style was accepted by the type (`any`) and silently
// dropped, which is worse than refusing it: the hero asked for a zero bottom
// padding, got the default, and the page shipped with a field of white in the
// one place it could not afford one — with nothing in the source to explain it.
export function SectionShell({ children, className = '', id, size = 'default', paddingY = 'default', style }: any) {
  const resolvedSize = size in SECTION_MAX_WIDTH ? size as keyof typeof SECTION_MAX_WIDTH : 'default';
  const resolvedPadding = ['none', 'compact', 'default', 'hero'].includes(paddingY) ? paddingY : 'default';
  return (
    <section
      className={`bitfield-section-shell bitfield-section-padding-${resolvedPadding} ${className}`.trim()}
      id={id}
      style={{ maxWidth: SECTION_MAX_WIDTH[resolvedSize], minWidth: 0, ...style }}
    >
      {children}
    </section>
  );
}

export function TextColumn({ children, className = '', align = 'left', style }: any) {
  return <div className={className} style={{ display: 'grid', justifyItems: align === 'center' ? 'center' : 'start', minWidth: 0, textAlign: align, width: '100%', ...style }}>{children}</div>;
}

export function Text({ as: Tag = 'p', children, className = '', color, style, ...props }: any) {
  return <Tag className={className} style={{ color: color === 'muted' ? 'rgba(15,23,42,.62)' : undefined, ...style }} {...props}>{children}</Tag>;
}

// The page's one call to action is the shared Button's strong face going to an address (`href`): the page places it,
// the site's look paints it (its size, corner and the room around it come from --radius-cta and --cta-block-space), its label at the look's call-to-action weight (the Button's `emphasis`). Its arrow is the Button's own trailing mark.
export function CtaBlock({ href, id, label, note }: { href: string; id?: string; label: string; note?: string }) {
  return (
    <Container className="bitfield-cta-block py-[var(--cta-block-space,0px)]" data-cta-block={id ?? 'cta'} data-testid="landing-cta-block" id={id}>
      <Button data-testid="landing-cta-button" href={href} size="cta" radius="cta" variant="primary" emphasis="cta" arrow>{label}</Button>
      {note ? <Text className="bitfield-cta-block__note">{note}</Text> : null}
    </Container>
  );
}

export function ShowcaseStrip({ ariaLabel, items = [] }: { ariaLabel?: string; items?: readonly any[] }) {
  return <ScrollViewport aria-label={ariaLabel} axis="horizontal" style={{ maxWidth: '100%', padding: '2px 1px 8px' }}>{items.map((item, index) => <article key={item.id} style={{ background: '#fff', border: '1px solid rgba(15,23,42,.1)', borderRadius: 12, flex: '0 0 150px', marginInlineEnd: index < items.length - 1 ? 10 : 0, overflow: 'hidden' }}>{item.src ? (item.kind === 'video' ? <video muted playsInline src={item.src} style={{ aspectRatio: '16/10', objectFit: 'cover', width: '100%' }} /> : <img alt="" src={item.src} style={{ aspectRatio: '16/10', objectFit: 'cover', width: '100%' }} />) : null}<div style={{ padding: 10 }}><small>{item.eyebrow}</small><strong style={{ display: 'block', fontSize: 13 }}>{item.label}</strong>{item.detail ? <span style={{ display: 'block', fontSize: 12, opacity: .68 }}>{item.detail}</span> : null}</div></article>)}</ScrollViewport>;
}

export type StatementTone = 'blue' | 'green' | 'orange' | 'purple' | 'red' | 'rainbow';
const HIGHLIGHT_INK: Record<StatementTone, string> = { blue: '#005cff', green: '#008652', orange: '#d85f00', purple: '#5b2dff', red: '#d20f32', rainbow: '#5b2dff' };
export function highlightInkColor(tone: StatementTone) { return HIGHLIGHT_INK[tone]; }
export function StatementHighlight({ children, tone = 'green' }: { children: React.ReactNode; tone?: StatementTone }) { return <span style={{ color: HIGHLIGHT_INK[tone], filter: ENGRAVED_HEADING_FILTER }}>{children}</span>; }

export function StatementText({ align = 'left', className = '', lines, size = 'section', solidColor = LANDING_SOLID_HIGHLIGHT_COLOR, style }: any) {
  // `page` is a page's own headings (the hero, a section's heading): the size, tightness and family the program's pages always had.
  const page = size === 'page';
  const fontSize = page ? 'clamp(2.1rem,5vw,4rem)' : size === 'footer' ? 'clamp(2rem,5vw,4.4rem)' : 'clamp(2.35rem,6vw,5.65rem)';
  return <div className={className} style={{ color: '#0f172a', fontFamily: page ? 'inherit' : 'var(--font-display, Georgia, serif)', fontSize, fontWeight: 700, letterSpacing: page ? '-.02em' : '-.045em', lineHeight: page ? 1.05 : .98, textAlign: align, textWrap: 'var(--statement-text-wrap, balance)', ...style }}>{lines.map((line: any[], lineIndex: number) => <div key={lineIndex}>{line.map((segment: any, index: number) => segment.solid ? <span key={index} style={{ color: solidColor }}>{segment.text}</span> : segment.tone ? <StatementHighlight key={index} tone={segment.tone}>{segment.text}</StatementHighlight> : <React.Fragment key={index}>{segment.text}</React.Fragment>)}</div>)}</div>;
}

export function SectionDivider() { return <div aria-hidden="true" style={{ background: 'linear-gradient(90deg,transparent,rgba(15,23,42,.16),transparent)', height: 1, margin: '0 auto', maxWidth: 1120 }} />; }

export function EngravedTextDefs() { return null; }

export function LandingQuotesSection({ quotes = [] }: { quotes: readonly any[] }) {
  return <SectionShell size="wide"><div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>{quotes.map((item, index) => <figure key={`${item.name}-${index}`} style={{ background: 'rgba(255,255,255,.78)', border: '1px solid rgba(15,23,42,.1)', borderRadius: 18, margin: 0, padding: 24 }}><blockquote style={{ fontSize: 18, lineHeight: 1.5, margin: 0 }}>{item.quote}</blockquote><figcaption style={{ fontWeight: 750, marginTop: 14 }}>{item.name}{item.role ? ` · ${item.role}` : ''}</figcaption></figure>)}</div></SectionShell>;
}

export function FaqSection({ intro, items = [] }: { intro?: string; items: readonly any[] }) {
  return <SectionShell size="narrow"><TextColumn align="center"><h2 style={{ fontFamily: 'var(--font-display, Georgia, serif)', fontSize: 'clamp(2rem,5vw,4rem)', margin: 0 }}>Questions</h2>{intro ? <p style={{ color: 'rgba(15,23,42,.68)', fontSize: 18, lineHeight: 1.6 }}>{intro}</p> : null}</TextColumn><div style={{ display: 'grid', gap: 10, marginTop: 32 }}>{items.map((item, index) => <details key={index} style={{ background: 'rgba(255,255,255,.75)', border: '1px solid rgba(15,23,42,.1)', borderRadius: 14, padding: '16px 18px' }}><summary style={{ cursor: 'pointer', fontWeight: 760 }}>{item.q}</summary><p style={{ lineHeight: 1.6, marginBottom: 0 }}>{item.answer}</p></details>)}</div></SectionShell>;
}

export type SiteHeaderLink = { readonly detail?: string; readonly href: string; readonly label: string };
export function SiteHeader({ brand, brandHref = '/', brandLabel, brandLogoAlt, brandLogoSrc, ctaHref, ctaText, menuLinks = [], navLinks = [] }: any) {
  const distinctNavLinks = navLinks.filter((link: SiteHeaderLink) => link.href !== brandHref);
  const distinctMenuLinks = menuLinks.filter((link: SiteHeaderLink) => link.href !== brandHref);
  const lastY = useRef(0);
  const [visible, setVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const brandContent = brand ?? (
    <a aria-label={brandLabel} href={brandHref} style={{ alignItems: 'center', background: '#fff', border: 0, borderRadius: 12, display: 'inline-flex', flex: '0 0 auto', height: 56, justifyContent: 'center', padding: 0, textDecoration: 'none', width: 56 }}>
      {brandLogoSrc ? (
        <img alt={brandLogoAlt ?? brandLabel ?? ''} src={brandLogoSrc} style={{ display: 'block', height: 44, objectFit: 'contain', width: 44 }} />
      ) : (
        <span style={{ color: '#0f172a', fontSize: 12, fontWeight: 800, textAlign: 'center' }}>{brandLabel}</span>
      )}
    </a>
  );
  useEffect(() => { const onScroll = () => { const y = window.scrollY; setVisible(y < 72 || y < lastY.current); lastY.current = y; }; window.addEventListener('scroll', onScroll, { passive: true }); return () => window.removeEventListener('scroll', onScroll); }, []);
  return (
    <nav className="bitfield-site-header" style={{ boxSizing: 'border-box', left: 0, maxWidth: '100vw', opacity: visible ? 1 : .98, padding: '12px 16px', position: 'fixed', right: 0, top: 0, transform: visible ? 'translateY(0)' : 'translateY(-120%)', transition: 'transform 260ms cubic-bezier(.22,1,.36,1)', width: '100%', zIndex: 50 }}>
      <div style={{ alignItems: 'center', backdropFilter: 'blur(18px)', background: 'rgba(255,255,255,.82)', border: '1px solid rgba(15,23,42,.1)', borderRadius: 18, display: 'flex', justifyContent: 'space-between', margin: '0 auto', maxWidth: 1152, minWidth: 0, padding: '10px 14px', position: 'relative', width: '100%' }}>
        {brandContent}
        <div className="bitfield-site-header-actions" style={{ alignItems: 'center', display: 'flex', gap: 16, minWidth: 0 }}>
          <span className="bitfield-site-header-direct-links" style={{ alignItems: 'center', display: 'flex', gap: 16 }}>
            {distinctNavLinks.map((link: SiteHeaderLink) => <Button className="bitfield-site-header-link" href={link.href} key={link.href} size="lg" variant="quiet">{link.label}</Button>)}
          </span>
          {ctaHref && ctaText ? <Button className="bitfield-site-header-cta" href={ctaHref} size="lg" variant="primary">{ctaText}</Button> : null}
          <Button className="bitfield-site-header-menu-toggle" aria-expanded={menuOpen} aria-label={menuOpen ? 'Close menu' : 'Open menu'} onClick={() => setMenuOpen(!menuOpen)} size="icon" type="button" variant="ghost">
            {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </Button>
        </div>
        {menuOpen ? <div className="bitfield-site-header-menu" style={{ background: '#fff', border: '1px solid rgba(15,23,42,.1)', borderRadius: 14, boxShadow: '0 18px 48px -28px rgba(15,23,42,.55)', display: 'grid', gap: 4, maxWidth: 'calc(100vw - 44px)', padding: 8, position: 'absolute', right: 0, top: 'calc(100% + 10px)', width: 300 }}>{distinctMenuLinks.map((link: SiteHeaderLink) => <a className="bitfield-site-header-menu-link" href={link.href} key={link.href} onClick={() => setMenuOpen(false)} style={{ color: '#0f172a', padding: 12, textDecoration: 'none' }}><strong>{link.label}</strong>{link.detail ? <small style={{ display: 'block', marginTop: 3, opacity: .65 }}>{link.detail}</small> : null}</a>)}</div> : null}
      </div>
    </nav>
  );
}
